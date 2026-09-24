'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const PROXY_DIR = path.resolve(__dirname, '..');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBytes = Buffer.concat(chunks);
  const raw = rawBytes.toString('utf8');
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
  return { raw, rawBytes, body };
}

async function startUpstream(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      const request = await readRequest(req);
      await handler(req, res, request);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function stopServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function startProxy(upstreamPort, protocol, options = {}) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROXY_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      UPSTREAM_API_KEY: 'upstream-test-key',
      UPSTREAM_PROTOCOL: protocol,
      PROXY_API_KEY: options.proxyApiKey || '',
      ALLOWED_ORIGINS: options.allowedOrigins || '',
      ALLOWED_HOSTS: options.allowedHosts || '',
      MODEL_MAP_JSON: options.modelMapJson || '{}',
      FORWARD_REQUEST_HEADERS: options.forwardRequestHeaders || '',
      UPSTREAM_STRIP_VERBOSITY: options.stripVerbosity === undefined ? 'true' : String(options.stripVerbosity),
      UPSTREAM_STRIP_REASONING_SUMMARY: options.stripReasoningSummary === undefined ? 'true' : String(options.stripReasoningSummary),
      UPSTREAM_STRIP_REASONING_EFFORT: options.stripReasoningEffort === undefined ? 'false' : String(options.stripReasoningEffort),
      UPSTREAM_MAX_TOKENS_FIELD: options.maxTokensField || 'passthrough',
      UPSTREAM_THINKING_FORMAT: options.thinkingFormat || 'openai',
      MODEL_ROUTES_PATH: options.modelRoutesPath || '',
      REQUEST_TIMEOUT_MS: String(options.timeoutMs ?? 5000),
      STREAM_IDLE_TIMEOUT_MS: String(options.streamIdleTimeoutMs ?? options.timeoutMs ?? 5000),
      MODEL_CATALOG_PATH: './models.json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const healthUrl = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`proxy exited during startup: ${stdout}\n${stderr}`);
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return { child, baseUrl: `http://127.0.0.1:${port}`, stdout, stderr };
    } catch {
      // Retry while the child is binding its port.
    }
    await delay(25);
  }

  child.kill();
  throw new Error(`proxy did not become healthy: ${stdout}\n${stderr}`);
}

async function stopProxy(proxy) {
  if (!proxy?.child || proxy.child.exitCode !== null) return;
  proxy.child.kill();
  await Promise.race([once(proxy.child, 'exit'), delay(1000)]);
  if (proxy.child.exitCode === null) proxy.child.kill();
}

async function postJson(url, requestPayload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestPayload),
  });
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  const payload = /application\/json/i.test(contentType) && text ? JSON.parse(text) : null;
  return { response, text, payload };
}

function parseSse(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/);
    const eventLine = lines.find((line) => line.startsWith('event:')) || '';
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    return {
      event: eventLine.slice('event:'.length).trim(),
      data: JSON.parse(data),
    };
  });
}

function sendJson(res, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(text);
}

test('integrates OpenAI non-streaming chat forwarding', { timeout: 15000 }, async () => {
  let seen;
  const upstream = await startUpstream(async (req, res, request) => {
    seen = { url: req.url, headers: req.headers, body: request.body };
    sendJson(res, {
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      model: request.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from upstream.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    });
  });
  const proxy = await startProxy(upstream.address().port, 'openai');
  try {
    const result = await postJson(`${proxy.baseUrl}/v1/chat/completions`, {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.model, 'deepseek-v4-pro');
    assert.equal(result.payload.choices[0].message.content, 'Hello from upstream.');
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.headers.authorization, 'Bearer upstream-test-key');
    assert.equal(seen.body.model, 'deepseek-v4-pro');
    assert.deepEqual(seen.body.messages, [{ role: 'user', content: 'Hello' }]);
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('returns a timeout error when the upstream is too slow', { timeout: 15000 }, async () => {
  const upstream = await startUpstream(async (_req, res) => {
    await delay(300);
    sendJson(res, { ok: true });
  });
  const proxy = await startProxy(upstream.address().port, 'openai', { timeoutMs: 50 });
  try {
    const result = await postJson(proxy.baseUrl + '/v1/chat/completions', {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(result.response.status, 504);
    assert.equal(result.payload.error.code, 'upstream_timeout');
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('converts OpenAI SSE to Anthropic SSE with final usage', { timeout: 15000 }, async () => {
  let seen;
  const upstream = await startUpstream(async (req, res, request) => {
    seen = { url: req.url, body: request.body };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      `data: ${JSON.stringify({ id: 'chatcmpl-stream', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-stream', choices: [{ delta: { content: 'Hello' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-stream', choices: [{ delta: { content: ' world' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-stream', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-stream', choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}`,
    ];
    res.end(chunks.join(''));
  });
  const proxy = await startProxy(upstream.address().port, 'openai');
  try {
    const result = await postJson(`${proxy.baseUrl}/v1/messages`, {
      model: 'glm-5.1',
      system: 'Be concise.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }],
      max_tokens: 32,
      stream: true,
    });
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('content-type') || '', /text\/event-stream/);
    const events = parseSse(result.text);
    assert.deepEqual(events.map((item) => item.event), [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    assert.deepEqual(events.filter((item) => item.event === 'content_block_delta').map((item) => item.data.delta.text), ['Hello', ' world']);
    const messageDelta = events.find((item) => item.event === 'message_delta');
    assert.equal(messageDelta.data.delta.stop_reason, 'end_turn');
    assert.equal(messageDelta.data.usage.output_tokens, 2);
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.body.model, 'glm-5.1');
    assert.deepEqual(seen.body.messages, [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Say hello.' },
    ]);
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('maps OpenAI reasoning and tool-call deltas to Anthropic blocks', { timeout: 15000 }, async () => {
  let seen;
  const upstream = await startUpstream(async (req, res, request) => {
    seen = { url: req.url, body: request.body };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'Plan' }, finish_reason: null }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: ' complete' }, finish_reason: null }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"query":"hello"' } }] }, finish_reason: null }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: null }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
    ];
    res.end(chunks.join(''));
  });
  const proxy = await startProxy(upstream.address().port, 'openai');
  try {
    const result = await postJson(proxy.baseUrl + '/v1/messages', {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'Look this up.' }],
      tools: [{ name: 'lookup', description: 'Look up a value.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
      stream: true,
    });
    assert.equal(result.response.status, 200);
    const events = parseSse(result.text);
    assert.deepEqual(events.map((item) => item.event), [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    assert.deepEqual(events.filter((item) => item.data.delta?.type === 'thinking_delta').map((item) => item.data.delta.thinking), ['Plan', ' complete']);
    const toolStart = events.find((item) => item.event === 'content_block_start' && item.data.content_block.type === 'tool_use');
    assert.equal(toolStart.data.content_block.id, 'call_1');
    assert.equal(toolStart.data.content_block.name, 'lookup');
    assert.deepEqual(events.filter((item) => item.data.delta?.type === 'input_json_delta').map((item) => item.data.delta.partial_json), ['{"query":"hello"', '}']);
    const messageDelta = events.find((item) => item.event === 'message_delta');
    assert.equal(messageDelta.data.delta.stop_reason, 'tool_use');
    assert.equal(messageDelta.data.usage.output_tokens, 3);
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.body.tools[0].function.name, 'lookup');
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('integrates Anthropic non-streaming message forwarding', { timeout: 15000 }, async () => {
  let seen;
  const upstream = await startUpstream(async (req, res, request) => {
    seen = { url: req.url, headers: req.headers, body: request.body };
    sendJson(res, {
      id: 'msg-upstream',
      type: 'message',
      role: 'assistant',
      model: request.body.model,
      content: [{ type: 'text', text: 'Bonjour.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 6, output_tokens: 2 },
    });
  });
  const proxy = await startProxy(upstream.address().port, 'anthropic');
  try {
    const result = await postJson(`${proxy.baseUrl}/v1/messages`, {
      model: 'kimi-k2.5',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Bonjour' }],
      stream: false,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.id, 'msg-upstream');
    assert.equal(result.payload.content[0].text, 'Bonjour.');
    assert.equal(seen.url, '/v1/messages');
    assert.equal(seen.headers.authorization, 'Bearer upstream-test-key');
    assert.equal(seen.body.model, 'kimi-k2.5');
    assert.deepEqual(seen.body.messages, [{ role: 'user', content: 'Bonjour' }]);
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('integrates Anthropic streaming message forwarding', { timeout: 15000 }, async () => {
  const upstreamText = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-stream","type":"message","role":"assistant"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const upstream = await startUpstream(async (req, res) => {
    assert.equal(req.url, '/v1/messages');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(upstreamText);
  });
  const proxy = await startProxy(upstream.address().port, 'anthropic');
  try {
    const result = await postJson(`${proxy.baseUrl}/v1/messages`, {
      model: 'kimi-k2.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('content-type') || '', /text\/event-stream/);
    assert.equal(result.text, upstreamText);
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});


test('forwards cleaned custom-model requests and strips only the internal model namespace', { timeout: 15000 }, async () => {
  let seen;
  const upstream = await startUpstream(async (req, res, request) => {
    seen = { url: req.url, body: request.body };
    sendJson(res, {
      id: 'chatcmpl-cleanup',
      object: 'chat.completion',
      model: request.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
  });
  const proxy = await startProxy(upstream.address().port, 'openai');
  try {
    const result = await postJson(proxy.baseUrl + '/v1/chat/completions', {
      model: 'custom-local:gpt-5.6-luna',
      messages: [{ role: 'user', content: 'Hello' }],
      verbosity: 'high',
      reasoning_summary: 'auto',
      reasoning_effort: 'high',
      max_tokens: 64,
    });
    assert.equal(result.response.status, 200);
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.body.model, 'gpt-5.6-luna');
    assert.equal(seen.body.verbosity, undefined);
    assert.equal(seen.body.reasoning_summary, undefined);
    assert.equal(seen.body.reasoning_effort, 'high');
    assert.equal(seen.body.max_tokens, 64);
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('forwards only explicitly allowlisted Cline custom headers', { timeout: 15000 }, async () => {
  let seenHeaders;
  const upstream = await startUpstream(async (req, res) => {
    seenHeaders = req.headers;
    sendJson(res, { id: 'chatcmpl-header-forward', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  });
  const proxy = await startProxy(upstream.address().port, 'openai', {
    forwardRequestHeaders: 'X-Cline-Test,X-Title,Cookie,Authorization',
  });
  try {
    const response = await fetch(proxy.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cline-Test': 'cline-header-value',
        'X-Title': 'Cline',
        Authorization: 'Bearer local-proxy-key',
        Cookie: 'session=must-not-forward',
      },
      body: JSON.stringify({
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(seenHeaders['x-cline-test'], 'cline-header-value');
    assert.equal(seenHeaders['x-title'], 'Cline');
    assert.equal(seenHeaders.cookie, undefined);
    assert.equal(seenHeaders.authorization, 'Bearer upstream-test-key');
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('supports configured max-completion token conversion and reasoning removal', { timeout: 15000 }, async () => {
  let seen;
  const upstream = await startUpstream(async (_req, res, request) => {
    seen = request.body;
    sendJson(res, { id: 'chatcmpl-compat', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  });
  const proxy = await startProxy(upstream.address().port, 'openai', {
    maxTokensField: 'max_completion_tokens',
    stripReasoningEffort: true,
  });
  try {
    const result = await postJson(proxy.baseUrl + '/v1/chat/completions', {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 64,
      reasoning_effort: 'high',
      reasoning: { effort: 'high', enabled: true },
    });
    assert.equal(result.response.status, 200);
    assert.equal(seen.max_tokens, undefined);
    assert.equal(seen.max_completion_tokens, 64);
    assert.equal(seen.reasoning_effort, undefined);
    assert.deepEqual(seen.reasoning, { enabled: true });
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('preserves the upstream error body and selected response headers', { timeout: 15000 }, async () => {
  const upstream = await startUpstream(async (_req, res) => {
    const body = 'upstream raw error';
    res.writeHead(418, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Request-ID': 'req-test-error',
      'Retry-After': '3',
    });
    res.end(body);
  });
  const proxy = await startProxy(upstream.address().port, 'openai');
  try {
    const result = await postJson(proxy.baseUrl + '/v1/chat/completions', {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(result.response.status, 418);
    assert.equal(result.text, 'upstream raw error');
    assert.match(result.response.headers.get('content-type') || '', /text\/plain/);
    assert.equal(result.response.headers.get('x-request-id'), 'req-test-error');
    assert.equal(result.response.headers.get('retry-after'), '3');
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('enforces proxy auth and exposes configured loopback CORS', { timeout: 15000 }, async () => {
  const upstream = await startUpstream(async (_req, res) => sendJson(res, { ok: true }));
  const proxy = await startProxy(upstream.address().port, 'openai', {
    proxyApiKey: 'proxy-test-key',
    allowedOrigins: 'http://localhost:3000',
  });
  try {
    const unauthenticated = await fetch(`${proxy.baseUrl}/v1/models`);
    const unauthenticatedPayload = await unauthenticated.json();
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticatedPayload.error.code, 'invalid_api_key');

    const preflight = await fetch(`${proxy.baseUrl}/v1/models`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /GET/);

    const authenticated = await fetch(`${proxy.baseUrl}/v1/models`, {
      headers: {
        Authorization: 'Bearer proxy-test-key',
        Origin: 'http://localhost:3000',
      },
    });
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get('access-control-allow-origin'), 'http://localhost:3000');

    const disallowedOrigin = await fetch(`${proxy.baseUrl}/v1/models`, {
      headers: {
        Authorization: 'Bearer proxy-test-key',
        Origin: 'https://evil.example',
      },
    });
    assert.equal(disallowedOrigin.status, 200);
    assert.equal(disallowedOrigin.headers.get('access-control-allow-origin'), null);
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});
test('returns structured validation errors for malformed JSON and image requests', { timeout: 15000 }, async () => {
  const upstream = await startUpstream(async (_req, res) => sendJson(res, { ok: true }));
  const proxy = await startProxy(upstream.address().port, 'openai');
  try {
    const malformed = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"messages":',
    });
    const malformedPayload = await malformed.json();
    assert.equal(malformed.status, 400);
    assert.equal(malformedPayload.error.code, 'invalid_json');

    const missingPrompt = await postJson(`${proxy.baseUrl}/v1/images/generations`, {
      model: 'hunyuan-image-v3.0',
    });
    assert.equal(missingPrompt.response.status, 400);
    assert.equal(missingPrompt.payload.error.code, 'invalid_prompt');

    const wrongMultipart = await fetch(`${proxy.baseUrl}/v1/images/edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'hunyuan-image-v3.0' }),
    });
    const wrongMultipartPayload = await wrongMultipart.json();
    assert.equal(wrongMultipart.status, 400);
    assert.equal(wrongMultipartPayload.error.code, 'invalid_multipart');
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});
test('serves the Cline model refresh catalog', { timeout: 15000 }, async () => {
  const upstream = await startUpstream(async (_req, res) => {
    sendJson(res, { ok: true });
  });
  const proxy = await startProxy(upstream.address().port, 'openai');
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer cline-test-key' },
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.object, 'list');
    assert.ok(Array.isArray(payload.data));
    assert.ok(payload.data.some((model) => model.id === 'deepseek-v4-pro'));
    const imageModelResponse = await fetch(`${proxy.baseUrl}/v1/models/hunyuan-image-v3.0`);
    const imageModel = await imageModelResponse.json();
    assert.equal(imageModelResponse.status, 200);
    assert.deepEqual(imageModel.capabilities, { chat: false, reasoning: false, media: true });
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('preserves current Cline OpenAI-compatible request controls', { timeout: 15000 }, async () => {
  let seen;
  const upstream = await startUpstream(async (_req, res, request) => {
    seen = request.body;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  const proxy = await startProxy(upstream.address().port, 'openai');
  try {
    const result = await postJson(`${proxy.baseUrl}/v1/chat/completions`, {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 64,
      reasoning: { enabled: true, effort: 'high' },
    });
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('content-type') || '', /text\/event-stream/);
    assert.deepEqual(seen.stream_options, { include_usage: true });
    assert.equal(seen.max_completion_tokens, 64);
    assert.deepEqual(seen.reasoning, { enabled: true, effort: 'high' });
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('forwards Cline OpenAI image-generation requests', { timeout: 15000 }, async () => {
  let seen;
  const upstream = await startUpstream(async (req, res, request) => {
    seen = { url: req.url, body: request.body };
    sendJson(res, {
      created: 1789910000,
      data: [{ b64_json: 'AA==' }],
      model: request.body.model,
    });
  });
  const proxy = await startProxy(upstream.address().port, 'openai');
  try {
    const result = await postJson(`${proxy.baseUrl}/v1/images/generations`, {
      model: 'hunyuan-image-v3.0',
      prompt: 'a red fox in snow',
      n: 1,
      size: '1024x1024',
      providerOptions: { openai: { outputFormat: 'png' } },
    });
    assert.equal(result.response.status, 200);
    assert.equal(seen.url, '/v1/images/generations');
    assert.deepEqual(seen.body, {
      model: 'hunyuan-image-v3.0',
      prompt: 'a red fox in snow',
      n: 1,
      size: '1024x1024',
    });
    assert.equal(result.payload.model, 'hunyuan-image-v3.0');
    assert.deepEqual(result.payload.data, [{ b64_json: 'AA==' }]);
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

test('routes a matched model to its own upstream and key', { timeout: 15000 }, async () => {
  let routedSeen;
  let fallbackSeen;
  const routed = await startUpstream(async (req, res, request) => {
    routedSeen = { url: req.url, authorization: req.headers.authorization, model: request.body.model };
    sendJson(res, {
      id: 'chatcmpl-routed',
      object: 'chat.completion',
      model: request.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'routed' }, finish_reason: 'stop' }],
    });
  });
  const fallback = await startUpstream(async (req, res, request) => {
    fallbackSeen = { url: req.url, authorization: req.headers.authorization, model: request.body.model };
    sendJson(res, {
      id: 'chatcmpl-fallback',
      object: 'chat.completion',
      model: request.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'fallback' }, finish_reason: 'stop' }],
    });
  });
  const routesPath = path.join(os.tmpdir(), `workbuddy-routes-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(routesPath, JSON.stringify([
    { id: 'routed-model', url: `http://127.0.0.1:${routed.address().port}/v1/chat/completions`, apiKey: 'route-key' },
    { id: 'ignored', url: '', apiKey: 'unused' },
  ]));
  const proxy = await startProxy(fallback.address().port, 'openai', {
    modelRoutesPath: routesPath,
    modelMapJson: JSON.stringify({ 'routed-model': 'should-not-apply', 'glm-5.1': 'mapped-fallback' }),
  });
  try {
    const routedResult = await postJson(`${proxy.baseUrl}/v1/chat/completions`, {
      model: 'custom-local:routed-model',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(routedResult.response.status, 200);
    assert.equal(routedResult.payload.choices[0].message.content, 'routed');
    assert.equal(routedSeen.url, '/v1/chat/completions');
    assert.equal(routedSeen.authorization, 'Bearer route-key');
    assert.equal(routedSeen.model, 'routed-model');
    assert.equal(fallbackSeen, undefined);

    const fallbackResult = await postJson(`${proxy.baseUrl}/v1/chat/completions`, {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(fallbackResult.response.status, 200);
    assert.equal(fallbackResult.payload.choices[0].message.content, 'fallback');
    assert.equal(fallbackSeen.authorization, 'Bearer upstream-test-key');
    assert.equal(fallbackSeen.model, 'mapped-fallback');

    const health = await fetch(`${proxy.baseUrl}/health`);
    const healthPayload = await health.json();
    assert.equal(healthPayload.routes, 1);
    assert.equal(healthPayload.upstream_configured, true);

    const models = await fetch(`${proxy.baseUrl}/v1/models`);
    const modelList = await models.json();
    assert.deepEqual(modelList.data.map((model) => model.id), ['routed-model']);
    const hidden = await fetch(`${proxy.baseUrl}/v1/models/deepseek-v4-pro`);
    assert.equal(hidden.status, 404);
  } finally {
    await stopProxy(proxy);
    await stopServer(routed);
    await stopServer(fallback);
    fs.rmSync(routesPath, { force: true });
  }
});

test('aborts a stalled streaming upstream and stays alive', { timeout: 20000 }, async () => {
  let sockets = [];
  const upstream = http.createServer((req, res) => {
    sockets.push(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"id":"x","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxy(upstream.address().port, 'openai', { streamIdleTimeoutMs: 300, timeoutMs: 5000 });
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'Hello' }], stream: true }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert.match(text, /partial/);
    const health = await fetch(`${proxy.baseUrl}/health`);
    assert.equal(health.status, 200, 'proxy must survive a stalled upstream stream');
  } finally {
    await stopProxy(proxy);
    for (const socket of sockets) socket.end();
    await stopServer(upstream);
  }
});

test('returns 504 when a non-streaming upstream body stalls', { timeout: 20000 }, async () => {
  let hold;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"id":"stall"');
    hold = res;
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxy(upstream.address().port, 'openai', { streamIdleTimeoutMs: 250, timeoutMs: 5000 });
  try {
    const result = await postJson(`${proxy.baseUrl}/v1/chat/completions`, {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(result.response.status, 504);
    assert.equal(result.payload.error.code, 'upstream_timeout');
  } finally {
    await stopProxy(proxy);
    hold?.end();
    await stopServer(upstream);
  }
});

test('forwards Cline multipart image edits and rewrites only the model field', { timeout: 15000 }, async () => {
  let seen;
  const upstream = await startUpstream(async (req, res, request) => {
    seen = { url: req.url, contentType: req.headers['content-type'], raw: request.raw, rawBytes: request.rawBytes };
    sendJson(res, {
      created: 1789910001,
      data: [{ b64_json: 'AQ==' }],
      model: 'upstream-image-model',
    });
  });
  const proxy = await startProxy(upstream.address().port, 'openai', {
    modelMapJson: JSON.stringify({ 'workbuddy-image': 'upstream-image-model' }),
  });
  try {
    const form = new FormData();
    form.set('model', 'custom-local:workbuddy-image');
    form.set('prompt', 'edit this image');
    form.set('response_format', 'b64_json');
    form.set('image[]', new Blob([Buffer.from([0x00, 0xff, 0x7f, 0x42])], { type: 'image/png' }), 'input.png');
    const response = await fetch(`${proxy.baseUrl}/v1/images/edits`, { method: 'POST', body: form });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(seen.url, '/v1/images/edits');
    assert.match(seen.contentType || '', /^multipart\/form-data;\s*boundary=/i);
    assert.match(seen.raw, /name="model"/);
    assert.match(seen.raw, /upstream-image-model/);
    assert.doesNotMatch(seen.raw, /custom-local:workbuddy-image/);
    assert.match(seen.raw, /name="prompt"/);
    assert.match(seen.raw, /edit this image/);
    assert.ok(seen.rawBytes.includes(Buffer.from([0x00, 0xff, 0x7f, 0x42])));
    assert.equal(payload.model, 'custom-local:workbuddy-image');
    assert.deepEqual(payload.data, [{ b64_json: 'AQ==' }]);
  } finally {
    await stopProxy(proxy);
    await stopServer(upstream);
  }
});

