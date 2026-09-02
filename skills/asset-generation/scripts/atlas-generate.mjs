#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATALOG_URL = 'https://api.atlascloud.ai/api/v1/models';
export const API_BASE = 'https://api.atlascloud.ai';
export const DEFAULT_MODEL = 'black-forest-labs/flux-2-pro/text-to-image';

export class AtlasError extends Error {}
export class TransientPredictionError extends AtlasError {}

function unwrap(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

async function requestJson(url, {
  method = 'GET',
  apiKey,
  payload,
  fetchImpl = fetch,
  transientPrediction = false,
} = {}) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'startup-harness-asset-generation/1.0',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (payload) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch (error) {
    if (transientPrediction) {
      throw new TransientPredictionError(`Atlas prediction GET failed: ${error.message}`);
    }
    if (method === 'POST') {
      throw new AtlasError(
        `Atlas submit state is unknown; the paid POST was not retried: ${error.message}`,
      );
    }
    throw new AtlasError(`Atlas request failed: ${error.message}`);
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    if (transientPrediction && (response.status === 408 || response.status === 429 || response.status >= 500)) {
      throw new TransientPredictionError(`Atlas prediction GET returned HTTP ${response.status}`);
    }
    throw new AtlasError(`Atlas returned HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

export async function discoverContract(model = DEFAULT_MODEL, fetchImpl = fetch) {
  const catalog = await requestJson(CATALOG_URL, { fetchImpl });
  const entries = Array.isArray(catalog?.data) ? catalog.data : catalog;
  const selected = entries.find((entry) => entry.model === model);
  if (!selected) throw new AtlasError(`Model is absent from the live Atlas catalog: ${model}`);
  if (selected.display_console !== true || selected.type !== 'Image') {
    throw new AtlasError(`Model is not an enabled image model: ${model}`);
  }
  if (!selected.schema) throw new AtlasError(`Catalog entry has no schema URL: ${model}`);

  const schema = await requestJson(selected.schema, { fetchImpl });
  let submitPath;
  let predictionPath;
  for (const [path, operations] of Object.entries(schema.paths ?? {})) {
    if (operations['x-api-name'] === 'model_run' && operations.post) submitPath = path;
    if (operations['x-api-name'] === 'model_result' && operations.get) predictionPath = path;
  }
  if (!submitPath || !predictionPath) {
    throw new AtlasError('Live schema is missing model_run or model_result endpoints.');
  }

  return {
    submitUrl: API_BASE + submitPath,
    predictionUrl: API_BASE + predictionPath,
    inputSchema: schema.components?.schemas?.Input ?? {},
  };
}

export function buildPayload(contract, {
  model = DEFAULT_MODEL,
  prompt,
  size = '1024*1024',
  outputFormat = 'jpeg',
  safetyTolerance = 2,
  seed = -1,
}) {
  if (!prompt?.trim()) throw new AtlasError('Prompt must not be empty.');

  const properties = contract.inputSchema.properties ?? {};
  const formats = properties.output_format?.enum ?? [];
  if (formats.length && !formats.includes(outputFormat)) {
    throw new AtlasError(`output_format must be one of: ${formats.join(', ')}`);
  }

  const sizeMatch = /^(\d+)\*(\d+)$/.exec(size);
  if (!sizeMatch) throw new AtlasError('size must use WIDTH*HEIGHT format.');
  const dimensions = sizeMatch.slice(1).map(Number);
  if (dimensions.some((value) => value < 256 || value > 2048)) {
    throw new AtlasError('size dimensions must be between 256 and 2048 pixels.');
  }

  const tolerance = properties.safety_tolerance ?? {};
  const minimum = tolerance.minimum ?? 0;
  const maximum = tolerance.maximum ?? 5;
  if (!Number.isInteger(safetyTolerance) || safetyTolerance < minimum || safetyTolerance > maximum) {
    throw new AtlasError(`safety_tolerance must be an integer from ${minimum} to ${maximum}.`);
  }

  return {
    model,
    prompt: prompt.trim(),
    size,
    output_format: outputFormat,
    safety_tolerance: safetyTolerance,
    seed,
  };
}

export async function submitOnce(contract, apiKey, payload, fetchImpl = fetch) {
  const response = await requestJson(contract.submitUrl, {
    method: 'POST',
    apiKey,
    payload,
    fetchImpl,
  });
  const prediction = unwrap(response);
  const requestId = prediction?.id;
  if (!requestId) throw new AtlasError('Atlas submit response did not include a request ID.');
  return requestId;
}

export async function pollPrediction(contract, apiKey, requestId, {
  fetchImpl = fetch,
  maxPolls = 60,
  initialDelayMs = 4_000,
  maxDelayMs = 12_000,
  sleep = (delay) => new Promise((resolveSleep) => setTimeout(resolveSleep, delay)),
} = {}) {
  const url = contract.predictionUrl.replace('{request_id}', encodeURIComponent(requestId));
  let lastTransientError;

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    try {
      const response = await requestJson(url, {
        apiKey,
        fetchImpl,
        transientPrediction: true,
      });
      const prediction = unwrap(response);
      lastTransientError = undefined;
      const status = String(prediction?.status ?? '').toLowerCase();
      if (status === 'completed') {
        const output = prediction.outputs?.[0];
        if (!output) throw new AtlasError('Completed prediction did not include an image URL.');
        return output;
      }
      if (status === 'failed') {
        throw new AtlasError(`Atlas image generation failed: ${prediction.error ?? 'unknown error'}`);
      }
    } catch (error) {
      if (!(error instanceof TransientPredictionError)) throw error;
      lastTransientError = error;
    }

    if (attempt + 1 < maxPolls) {
      const delay = Math.min(initialDelayMs * (2 ** attempt), maxDelayMs);
      await sleep(delay);
    }
  }

  const detail = lastTransientError ? ` Last GET error: ${lastTransientError.message}` : '';
  throw new AtlasError(`Prediction polling reached its configured limit.${detail}`);
}

export async function downloadImage(url, output, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new AtlasError(`Image download failed without retry: ${error.message}`);
  }
  if (!response.ok) throw new AtlasError(`Image download returned HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new AtlasError('Completed image download was empty.');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
}

function parseArgs(argv) {
  const args = {
    model: DEFAULT_MODEL,
    size: '1024*1024',
    outputFormat: 'jpeg',
    safetyTolerance: 2,
    seed: -1,
    output: 'public/images/atlas-flux-placeholder.jpeg',
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--dry-run') args.dryRun = true;
    else if (key === '--prompt') args.prompt = argv[++index];
    else if (key === '--model') args.model = argv[++index];
    else if (key === '--size') args.size = argv[++index];
    else if (key === '--output-format') args.outputFormat = argv[++index];
    else if (key === '--safety-tolerance') args.safetyTolerance = Number(argv[++index]);
    else if (key === '--seed') args.seed = Number(argv[++index]);
    else if (key === '--output') args.output = argv[++index];
    else throw new AtlasError(`Unknown argument: ${key}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const contract = await discoverContract(args.model);
  const payload = buildPayload(contract, args);
  if (args.dryRun) {
    console.log(JSON.stringify({ submitUrl: contract.submitUrl, payload }, null, 2));
    return;
  }

  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) throw new AtlasError('Set ATLASCLOUD_API_KEY before submitting a generation.');
  const requestId = await submitOnce(contract, apiKey, payload);
  const imageUrl = await pollPrediction(contract, apiKey, requestId);
  const output = resolve(args.output);
  await downloadImage(imageUrl, output);
  console.log(JSON.stringify({ requestId, model: args.model, output }));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
