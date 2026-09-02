import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AtlasError,
  DEFAULT_MODEL,
  buildPayload,
  discoverContract,
  pollPrediction,
  submitOnce,
} from './atlas-generate.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function contract() {
  return {
    submitUrl: 'https://api.example.test/generate',
    predictionUrl: 'https://api.example.test/prediction/{request_id}',
    inputSchema: {
      properties: {
        output_format: { enum: ['jpeg', 'png'] },
        safety_tolerance: { minimum: 0, maximum: 5 },
      },
    },
  };
}

test('discovers endpoints from the live schema shape', async () => {
  const responses = [
    jsonResponse({
      data: [{ model: DEFAULT_MODEL, display_console: true, type: 'Image', schema: 'https://schema.test' }],
    }),
    jsonResponse({
      paths: {
        '/api/v1/model/generateImage': { post: {}, 'x-api-name': 'model_run' },
        '/api/v1/model/prediction/{request_id}': { get: {}, 'x-api-name': 'model_result' },
      },
      components: { schemas: { Input: { properties: {} } } },
    }),
  ];
  const found = await discoverContract(DEFAULT_MODEL, async () => responses.shift());
  assert.match(found.submitUrl, /generateImage$/);
  assert.match(found.predictionUrl, /\{request_id\}$/);
});

test('validates image payload against live schema constraints', () => {
  const payload = buildPayload(contract(), {
    prompt: 'Painterly hero image',
    size: '1280*720',
    outputFormat: 'png',
    safetyTolerance: 2,
    seed: 7,
  });
  assert.equal(payload.output_format, 'png');
  assert.equal(payload.size, '1280*720');
  assert.throws(
    () => buildPayload(contract(), { prompt: 'hero', size: '100*100', outputFormat: 'jpeg', safetyTolerance: 2 }),
    /between 256 and 2048/,
  );
});

test('submits the paid generation request exactly once', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ data: { id: 'request-1' } });
  };
  assert.equal(await submitOnce(contract(), 'secret', { model: DEFAULT_MODEL }, fetchImpl), 'request-1');
  assert.equal(calls, 1);
});

test('does not retry an ambiguous paid submit', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError('socket closed');
  };
  await assert.rejects(
    submitOnce(contract(), 'secret', { model: DEFAULT_MODEL }, fetchImpl),
    /paid POST was not retried/,
  );
  assert.equal(calls, 1);
});

test('retries only transient prediction GET requests within a bound', async () => {
  const responses = [
    new TypeError('temporary network error'),
    jsonResponse({ data: { status: 'processing' } }),
    jsonResponse({ data: { status: 'completed', outputs: ['https://cdn.test/image.jpeg'] } }),
  ];
  let calls = 0;
  const output = await pollPrediction(contract(), 'secret', 'request-1', {
    fetchImpl: async () => {
      calls += 1;
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    maxPolls: 3,
    initialDelayMs: 1,
    maxDelayMs: 1,
    sleep: async () => {},
  });
  assert.equal(output, 'https://cdn.test/image.jpeg');
  assert.equal(calls, 3);
});

test('fails after the configured prediction poll bound', async () => {
  await assert.rejects(
    pollPrediction(contract(), 'secret', 'request-1', {
      fetchImpl: async () => jsonResponse({ data: { status: 'processing' } }),
      maxPolls: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
    }),
    (error) => error instanceof AtlasError && /configured limit/.test(error.message),
  );
});
