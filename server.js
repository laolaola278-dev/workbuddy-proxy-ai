'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { URL } = require('node:url');

loadDotEnv(path.join(__dirname, '.env'));

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8964);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 600000);
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 120000);
const UPSTREAM_PROTOCOL = String(process.env.UPSTREAM_PROTOCOL || 'openai').trim().toLowerCase();
const UPSTREAM_BASE_URL = String(process.env.UPSTREAM_BASE_URL || '').trim();
const UPSTREAM_API_KEY = String(process.env.UPSTREAM_API_KEY || '').trim();
const PROXY_API_KEY = String(process.env.PROXY_API_KEY || '').trim();
const ALLOWED_ORIGINS = csv(process.env.ALLOWED_ORIGINS);
const ALLOWED_HOSTS = new Set(csv(process.env.ALLOWED_HOSTS).map((item) => item.toLowerCase()));
const FORWARD_REQUEST_HEADERS = new Set(csv(process.env.FORWARD_REQUEST_HEADERS).map((item) => item.toLowerCase()));
const MODEL_MAP = parseJsonObject(process.env.MODEL_MAP_JSON || '{}');
const MODEL_ROUTES = loadModelRoutes(process.env.MODEL_ROUTES_PATH || '');
const CATALOG_PATH = resolveCatalogPath(process.env.MODEL_CATALOG_PATH || './models.json');
const CATALOG = loadCatalog(CATALOG_PATH);
const CATALOG_BY_ID = new Map(CATALOG.map((model) => [model.id, model]));
const DEFAULT_MODEL = CATALOG.find((model) => model.id === 'auto')?.id || CATALOG[0]?.id || 'auto';
const STRIP_VERBOSITY = parseBooleanEnv(process.env.UPSTREAM_STRIP_VERBOSITY, true);
const STRIP_REASONING_SUMMARY = parseBooleanEnv(process.env.UPSTREAM_STRIP_REASONING_SUMMARY, true);
const STRIP_REASONING_EFFORT = parseBooleanEnv(process.env.UPSTREAM_STRIP_REASONING_EFFORT, false);
const MAX_TOKENS_FIELD = normalizeMaxTokensField(process.env.UPSTREAM_MAX_TOKENS_FIELD || 'passthrough');
const THINKING_FORMAT = normalizeThinkingFormat(process.env.UPSTREAM_THINKING_FORMAT || 'openai');
const EDITIONS = {
  domestic: {
    models: 'hy3,glm-5.3-flash,deepseek-v4.1-flash,hy4-preview',
    configDir: '.workbuddy',
  },
  international: {
    models: 'hy4-preview-f,deepseek-v4.1-flash',
    configDir: '.workbuddy-ai',
  },
};
const WORKBUDDY_EDITION = String(process.env.WORKBUDDY_EDITION || 'international').trim().toLowerCase();
const EDITION = EDITIONS[WORKBUDDY_EDITION] || EDITIONS.international;
const BUILTIN_CLI = String(process.env.WORKBUDDY_CLI_PATH || '').trim();
const BUILTIN_CONFIG_DIR = String(process.env.WORKBUDDY_CONFIG_DIR || path.join(process.env.USERPROFILE || '', EDITION.configDir)).trim();
const BUILTIN_MODELS = new Set(csv(process.env.WORKBUDDY_BUILTIN_MODELS || EDITION.models).map((item) => item.toLowerCase()));
const BUILTIN_HOST_PORT = Number(process.env.WORKBUDDY_HOST_PORT || 60123);
const BUILTIN_TIMEOUT_MS = Number(process.env.WORKBUDDY_BUILTIN_TIMEOUT_MS || 180000);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

const BLOCKED_FORWARD_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding',
]);

function collectForwardedHeaders(sourceHeaders = {}) {
  const headers = {};
  for (const headerName of FORWARD_REQUEST_HEADERS) {
    if (BLOCKED_FORWARD_HEADERS.has(headerName)) continue;
    const value = sourceHeaders[headerName];
    if (typeof value === 'string' && value) headers[headerName] = value;
    else if (Array.isArray(value) && value.length) headers[headerName] = value.join(', ');
  }
  return headers;
}

function loadModelRoutes(value) {
  const filePath = String(value || '').trim();
  if (!filePath) return [];
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(__dirname, filePath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    console.warn(`[workbuddy-proxy] cannot load model routes: ${error.message}`);
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : null;
  if (!entries) {
    console.warn('[workbuddy-proxy] model routes must be an array or {"models": [...]}');
    return [];
  }
  const routes = [];
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const baseUrl = typeof entry?.url === 'string' ? entry.url.trim() : '';
    if (!id || !baseUrl) continue;
    routes.push({
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
      baseUrl,
      apiKey: typeof entry.apiKey === 'string' ? entry.apiKey.trim() : '',
      reasoning: entry.supportsReasoning === true || entry.reasoning === true,
    });
  }
  return routes;
}

function resolveRoute(modelId) {
  const original = String(modelId || '').trim();
  const stripped = stripNamespacePrefix(original);
  const route = MODEL_ROUTES.find((item) => item.id === original || item.id === stripped);
  if (!route) return null;
  return {
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    modelId: route.id,
  };
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveCatalogPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(__dirname, value);
}

function loadCatalog(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')); 
    if (!Array.isArray(parsed)) throw new Error('catalog must be an array');
    return parsed.filter((model) => model && typeof model.id === 'string' && model.id.trim()).map((model) => ({
      id: model.id.trim(),
      name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id.trim(),
      type: typeof model.type === 'string' ? model.type : 'chat',
      reasoning: model.reasoning === true,
    }));
  } catch (error) {
    console.warn(`[workbuddy-proxy] cannot load model catalog: ${error.message}`);
    return [];
  }
}

function requestedModelId(body) {
  const value = body && typeof body.model === 'string' ? body.model.trim() : '';
  return value || DEFAULT_MODEL;
}

function upstreamModelId(modelId) {
  const original = String(modelId || '').trim();
  const stripped = stripNamespacePrefix(original);
  const route = resolveRoute(original);
  if (route) return route.modelId;
  const mapped = MODEL_MAP[original] ?? MODEL_MAP[stripped];
  return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : stripped;
}

function stripNamespacePrefix(modelId) {
  const value = String(modelId || '').trim();
  const customLocal = value.startsWith('custom-local:') ? value.slice('custom-local:'.length) : value;
  const slashIndex = customLocal.lastIndexOf('/');
  const colonIndex = customLocal.lastIndexOf(':');
  const index = Math.max(slashIndex, colonIndex);
  return index >= 0 ? customLocal.slice(index + 1) : customLocal;
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizeMaxTokensField(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['max_tokens', 'max_completion_tokens', 'auto', 'passthrough'].includes(normalized) ? normalized : 'passthrough';
}

function normalizeThinkingFormat(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['openai', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'qwen-chat-template', 'auto'].includes(normalized) ? normalized : 'openai';
}

function inferThinkingFormat(baseValue = UPSTREAM_BASE_URL) {
  try {
    const host = new URL(normalizeBaseUrl(baseValue)).hostname.toLowerCase();
    if (host.includes('deepseek.com')) return 'deepseek';
    if (host.includes('api.z.ai')) return 'zai';
    if (host.includes('together.ai') || host.includes('together.xyz')) return 'together';
    if (host.includes('openrouter.ai')) return 'openrouter';
    if (host.includes('dashscope.aliyuncs.com') || host.includes('qwen')) return 'qwen';
  } catch {
    // Keep the OpenAI-compatible default for malformed or local URLs.
  }
  return 'openai';
}

function resolveThinkingFormat(value = THINKING_FORMAT) {
  return value === 'auto' ? inferThinkingFormat() : value;
}

function resolveMaxTokensField(modelId, value = MAX_TOKENS_FIELD) {
  if (value !== 'auto') return value;
  const model = String(modelId || '').toLowerCase();
  const base = normalizeBaseUrl(UPSTREAM_BASE_URL).toLowerCase();
  if (['o1', 'o3', 'o4', 'gpt-4.1', 'gpt-5'].some((prefix) => model.startsWith(prefix))) return 'max_completion_tokens';
  if (/(moonshot|together|cloudflare|chutes\.ai)/.test(base)) return 'max_tokens';
  return 'max_completion_tokens';
}

function cloneRequest(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function removeReasoningEffort(request) {
  delete request.reasoning_effort;
  if (request.reasoning && typeof request.reasoning === 'object' && !Array.isArray(request.reasoning)) {
    delete request.reasoning.effort;
    if (Object.keys(request.reasoning).length === 0) delete request.reasoning;
  }
}

function applyThinkingFormat(request, format) {
  const effort = typeof request.reasoning_effort === 'string' ? request.reasoning_effort : undefined;
  switch (format) {
    case 'openrouter':
      if (effort !== undefined) {
        if (!request.reasoning || typeof request.reasoning !== 'object' || Array.isArray(request.reasoning)) request.reasoning = {};
        if (request.reasoning.effort === undefined) request.reasoning.effort = effort;
        delete request.reasoning_effort;
      }
      break;
    case 'deepseek':
      if (effort !== undefined) {
        if (!request.thinking || typeof request.thinking !== 'object' || Array.isArray(request.thinking)) request.thinking = {};
        if (request.thinking.type === undefined) request.thinking.type = 'enabled';
      }
      break;
    case 'together':
      if (effort !== undefined) {
        if (!request.reasoning || typeof request.reasoning !== 'object' || Array.isArray(request.reasoning)) request.reasoning = {};
        if (request.reasoning.enabled === undefined) request.reasoning.enabled = true;
      }
      break;
    case 'zai':
    case 'qwen':
      if (effort !== undefined) request.enable_thinking = true;
      delete request.reasoning_effort;
      break;
    case 'qwen-chat-template':
      if (effort !== undefined) {
        if (!request.chat_template_kwargs || typeof request.chat_template_kwargs !== 'object' || Array.isArray(request.chat_template_kwargs)) request.chat_template_kwargs = {};
        request.chat_template_kwargs.enable_thinking = true;
      }
      delete request.reasoning_effort;
      break;
    default:
      break;
  }
}

function applyMaxTokensField(request, field) {
  if (field === 'passthrough') return;
  if (field === 'max_completion_tokens') {
    if (request.max_completion_tokens === undefined && request.max_tokens !== undefined) request.max_completion_tokens = request.max_tokens;
    delete request.max_tokens;
  } else if (field === 'max_tokens') {
    if (request.max_tokens === undefined && request.max_completion_tokens !== undefined) request.max_tokens = request.max_completion_tokens;
    delete request.max_completion_tokens;
  }
}

function prepareOpenAiRequest(body, modelId, options = {}) {
  const request = cloneRequest(body || {});
  const stripVerbosity = options.stripVerbosity ?? STRIP_VERBOSITY;
  const stripReasoningSummary = options.stripReasoningSummary ?? STRIP_REASONING_SUMMARY;
  const stripReasoningEffort = options.stripReasoningEffort ?? STRIP_REASONING_EFFORT;
  const maxTokensField = normalizeMaxTokensField(options.maxTokensField ?? MAX_TOKENS_FIELD);
  const thinkingFormat = normalizeThinkingFormat(options.thinkingFormat ?? THINKING_FORMAT);

  for (const key of ['providerOptions', 'provider_options', 'modelOptions', 'model_options', 'options']) delete request[key];
  if (stripVerbosity) delete request.verbosity;
  if (stripReasoningSummary) delete request.reasoning_summary;
  if (stripReasoningEffort) removeReasoningEffort(request);
  else applyThinkingFormat(request, resolveThinkingFormat(thinkingFormat));
  applyMaxTokensField(request, resolveMaxTokensField(modelId, maxTokensField));
  return request;
}

function prepareOpenAiImageRequest(body, modelId) {
  const request = cloneRequest(body || {});
  request.model = upstreamModelId(modelId);
  for (const key of ['providerOptions', 'provider_options', 'modelOptions', 'model_options', 'options']) delete request[key];
  return request;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildUpstreamUrl(kind, baseValue = UPSTREAM_BASE_URL) {
  const base = normalizeBaseUrl(baseValue);
  if (!base) return null;
  const suffix = kind === 'messages'
    ? '/messages'
    : kind === 'images'
      ? '/images/generations'
      : kind === 'image-edits'
        ? '/images/edits'
        : '/chat/completions';
  const match = base.match(/^([^?#]*)([?#].*)?$/);
  let pathname = (match?.[1] || base).replace(/\/+$/, '');
  const query = match?.[2] || '';
  for (const existingSuffix of ['/chat/completions', '/messages', '/images/generations', '/images/edits', '/images']) {
    while (pathname.endsWith(existingSuffix)) {
      pathname = pathname.slice(0, -existingSuffix.length).replace(/\/+$/, '');
    }
  }
  if (!pathname.endsWith('/v1')) pathname += '/v1';
  return `${pathname}${suffix}${query}`;
}

function isLoopbackHostHeader(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).trim().toLowerCase().split(':')[0];
  if (ALLOWED_HOSTS.has(host)) return true;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
  } catch {
    return false;
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  const allowedHeaders = new Set(['Authorization', 'Content-Type', 'X-API-Key', 'x-api-key']);
  for (const headerName of FORWARD_REQUEST_HEADERS) allowedHeaders.add(headerName);
  res.setHeader('Access-Control-Allow-Headers', [...allowedHeaders].join(', '));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function isAuthorized(req, pathname) {
  if (!PROXY_API_KEY || !pathname.startsWith('/v1/')) return true;
  const bearer = String(req.headers.authorization || '');
  const apiKey = String(req.headers['x-api-key'] || '');
  return bearer === `Bearer ${PROXY_API_KEY}` || apiKey === PROXY_API_KEY;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, statusCode, code, message, details) {
  sendJson(res, statusCode, {
    error: {
      message,
      type: 'invalid_request_error',
      code,
      ...(details ? { details } : {}),
    },
  });
}

async function readRawBody(req, maxBytes = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, 'request_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, maxBytes = 16 * 1024 * 1024) {
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function multipartBoundary(contentType) {
  const match = String(contentType || '').match(/boundary=(?:\"([^\"]+)\"|([^;]+))/i);
  return (match?.[1] || match?.[2] || '').trim();
}

function multipartFieldRange(body, contentType, fieldName) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary}`);
  const separator = Buffer.from('\r\n\r\n');
  const nextMarker = Buffer.from(`\r\n--${boundary}`);
  let cursor = 0;
  while (cursor < body.length) {
    const markerStart = body.indexOf(marker, cursor);
    if (markerStart < 0) break;
    let partStart = markerStart + marker.length;
    if (body.subarray(partStart, partStart + 2).toString('ascii') === '--') break;
    if (body.subarray(partStart, partStart + 2).toString('ascii') === '\r\n') partStart += 2;
    const headerEnd = body.indexOf(separator, partStart);
    if (headerEnd < 0) break;
    const bodyStart = headerEnd + separator.length;
    const bodyEnd = body.indexOf(nextMarker, bodyStart);
    if (bodyEnd < 0) break;
    const headers = body.subarray(partStart, headerEnd).toString('latin1');
    const disposition = headers.match(/Content-Disposition:[^\r\n]*/i)?.[0] || '';
    const fieldPattern = new RegExp(`(?:^|;)\\s*name=\"${String(fieldName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"(?:;|$)`, 'i');
    if (fieldPattern.test(disposition) && !/;\s*filename=/i.test(disposition)) return { start: bodyStart, end: bodyEnd };
    cursor = bodyEnd + nextMarker.length;
  }
  return null;
}

function readMultipartTextField(body, contentType, fieldName) {
  const range = multipartFieldRange(body, contentType, fieldName);
  if (!range) return '';
  return body.subarray(range.start, range.end).toString('utf8').trim();
}

function replaceMultipartTextField(body, contentType, fieldName, value) {
  const range = multipartFieldRange(body, contentType, fieldName);
  if (!range) return body;
  return Buffer.concat([body.subarray(0, range.start), Buffer.from(String(value), 'utf8'), body.subarray(range.end)]);
}

function isBuiltinModel(modelId) {
  const value = stripNamespacePrefix(modelId).toLowerCase();
  return BUILTIN_MODELS.has(value);
}

function flattenOpenAiMessages(messages) {
  return messages.map((message) => {
    const role = typeof message?.role === 'string' ? message.role : 'user';
    const content = typeof message?.content === 'string' ? message.content : flattenContent(message?.content);
    return `${role}: ${content}`.trim();
  }).filter(Boolean).join('\n\n');
}

function hostedRequest(port, sessionToken, connectionId, method, requestPath, body) {
  const data = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(data),
        connection: 'close',
        ...(sessionToken ? { 'acp-session-token': sessionToken } : {}),
        ...(connectionId ? { 'acp-connection-id': connectionId } : {}),
      },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(httpError(504, 'upstream_timeout', 'WorkBuddy built-in model timed out.'));
    });
    req.on('error', (error) => reject(httpError(502, 'upstream_unreachable', `WorkBuddy hosted CLI is not reachable: ${error.message}`)));
    req.end(data);
  });
}

function acpText(payload) {
  return [...String(payload || '').matchAll(/"text":"((?:\\.|[^"\\])*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`))
    .filter(Boolean);
}

function runBuiltinModel(modelId, prompt) {
  const model = stripNamespacePrefix(modelId);
  return (async () => {
    const opened = await hostedRequest(BUILTIN_HOST_PORT, '', '', 'GET', '/api/v1/acp');
    const sessionToken = opened.headers['acp-session-token'];
    if (!sessionToken) throw httpError(503, 'builtin_host_unavailable', 'WorkBuddy hosted CLI is not accepting local sessions.');
    const connected = await hostedRequest(BUILTIN_HOST_PORT, sessionToken, 'proxy', 'POST', '/api/v1/acp/connect', {});
    const connection = JSON.parse(connected.text);
    if (!connection.connectionId || !connection.sessionToken) throw httpError(502, 'upstream_error', 'WorkBuddy hosted CLI did not open a connection.');
    const initialized = await hostedRequest(BUILTIN_HOST_PORT, connection.sessionToken, connection.connectionId, 'POST', '/api/v1/acp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientInfo: { name: 'workbuddy-proxy', version: '1' } },
    });
    if (initialized.status !== 200) throw httpError(502, 'upstream_error', 'WorkBuddy hosted CLI rejected initialization.');
    const created = await hostedRequest(BUILTIN_HOST_PORT, connection.sessionToken, connection.connectionId, 'POST', '/api/v1/acp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: process.cwd(), model, mcpServers: [] },
    });
    const sessionMatch = created.text.match(/"sessionId":"([^"]+)"/);
    if (!sessionMatch) throw httpError(502, 'upstream_error', 'WorkBuddy hosted CLI did not create a session.');
    const prompted = await hostedRequest(BUILTIN_HOST_PORT, connection.sessionToken, connection.connectionId, 'POST', '/api/v1/acp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: sessionMatch[1],
        prompt: [{ type: 'text', text: prompt }],
        model,
        maxTurns: 1,
      },
    });
    if (prompted.text.includes('"error"')) {
      const message = acpText(prompted.text).at(-1) || 'WorkBuddy hosted CLI returned an error.';
      throw httpError(502, 'upstream_error', message);
    }
    const text = acpText(prompted.text).at(-1) || '';
    if (!text) throw httpError(502, 'upstream_error', 'WorkBuddy hosted CLI returned no text.');
    return text;
  })();
}

function servedModels() {
  if (BUILTIN_MODELS.size > 0) {
    return [...BUILTIN_MODELS].map((id) => ({
      id,
      name: id,
      type: 'chat',
      reasoning: true,
    }));
  }
  if (MODEL_ROUTES.length === 0) return CATALOG;
  return MODEL_ROUTES.map((route) => {
    const catalog = CATALOG_BY_ID.get(route.id);
    return {
      id: route.id,
      name: catalog?.name || route.name,
      type: catalog?.type || 'chat',
      reasoning: catalog ? catalog.reasoning : route.reasoning,
    };
  });
}

function modelRecord(model) {
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: 'workbuddy',
    name: model.name,
    capabilities: {
      chat: model.type === 'chat',
      reasoning: model.reasoning,
      media: model.type === 'media',
    },
  };
}

function openAiModelList() {
  return servedModels().map(modelRecord);
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return String(part.text || '');
    if (part?.type === 'image') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

function anthropicSystemToOpenAi(system) {
  return flattenContent(system);
}

function anthropicImageToOpenAi(part) {
  if (!part || part.type !== 'image' || !part.source) return null;
  if (part.source.type === 'base64' && part.source.data) {
    const mediaType = part.source.media_type || 'application/octet-stream';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${part.source.data}` } };
  }
  if (part.source.type === 'url' && part.source.url) {
    return { type: 'image_url', image_url: { url: part.source.url } };
  }
  return null;
}

function anthropicContentToOpenAi(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const textParts = [];
  const imageParts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') textParts.push(String(part.text || ''));
    else {
      const image = anthropicImageToOpenAi(part);
      if (image) imageParts.push(image);
    }
  }
  if (imageParts.length === 0) return textParts.join('\n');
  return [...(textParts.length ? [{ type: 'text', text: textParts.join('\n') }] : []), ...imageParts];
}

function anthropicToolResultToOpenAi(content) {
  const converted = anthropicContentToOpenAi(content);
  const images = Array.isArray(converted)
    ? converted.filter((part) => part?.type === 'image_url')
    : [];
  const text = Array.isArray(content)
    ? content.filter((part) => part?.type === 'text').map((part) => String(part.text || '')).filter(Boolean).join('\n')
    : typeof content === 'string' ? content : '';
  return { text: text || (images.length ? '[image]' : ''), images };
}
function anthropicThinkingToOpenAi(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'thinking' && typeof part.thinking === 'string')
    .map((part) => part.thinking)
    .filter(Boolean)
    .join('\n');
}

function anthropicToOpenAi(body, requestedModel) {
  const messages = [];
  const system = anthropicSystemToOpenAi(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const content = Array.isArray(message.content) ? message.content : [];
    const toolUses = content.filter((part) => part?.type === 'tool_use');
    const toolResults = content.filter((part) => part?.type === 'tool_result');
    if (toolUses.length) {
      const assistantMessage = {
        role: 'assistant',
        content: content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') || null,
        tool_calls: toolUses.map((part) => ({
          id: String(part.id || `toolu_${Date.now()}`),
          type: 'function',
          function: { name: String(part.name || 'tool'), arguments: JSON.stringify(part.input || {}) },
        })),
      };
      const thinking = anthropicThinkingToOpenAi(content);
      if (thinking) assistantMessage.reasoning_content = thinking;
      messages.push(assistantMessage);
    } else if (toolResults.length) {
      for (const result of toolResults) {
        const toolResult = anthropicToolResultToOpenAi(result.content);
        messages.push({
          role: 'tool',
          tool_call_id: String(result.tool_use_id || ''),
          content: toolResult.text,
        });
        if (toolResult.images.length) messages.push({ role: 'user', content: toolResult.images });
      }
      const plainText = content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
      if (plainText) messages.push({ role: 'user', content: plainText });    } else {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const convertedContent = anthropicContentToOpenAi(message.content);
      const openAiMessage = { role, content: convertedContent || (role === 'assistant' ? null : '') };
      const thinking = anthropicThinkingToOpenAi(message.content);
      if (thinking) openAiMessage.reasoning_content = thinking;
      messages.push(openAiMessage);
    }
  }
  const out = {
    model: upstreamModelId(requestedModel),
    messages,
    stream: body.stream === true,
  };
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences !== undefined) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === 'tool') out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    else if (body.tool_choice.type === 'any') out.tool_choice = 'required';
    else if (body.tool_choice.type === 'none') out.tool_choice = 'none';
    else out.tool_choice = 'auto';
  }
  return prepareOpenAiRequest(out, requestedModel);
}

function openAiToAnthropic(payload, requestedModel) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = { raw: call.function?.arguments || '' }; }
    content.push({ type: 'tool_use', id: call.id || `toolu_${Date.now()}`, name: call.function?.name || 'tool', input });
  }
  const finishReason = choice.finish_reason;
  const stopReason = finishReason === 'tool_calls' ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: payload?.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Number(payload?.usage?.prompt_tokens || 0),
      output_tokens: Number(payload?.usage?.completion_tokens || 0),
    },
  };
}

function copyResponseHeaders(upstream, res, contentTypeFallback) {
  const contentType = upstream.headers.get('content-type') || contentTypeFallback;
  if (contentType) res.setHeader('Content-Type', contentType);
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) res.setHeader('X-Request-ID', requestId);
}

function idleTimer(onExpire) {
  let timer = null;
  return {
    arm() {
      clearTimeout(timer);
      if (STREAM_IDLE_TIMEOUT_MS > 0) timer = setTimeout(onExpire, STREAM_IDLE_TIMEOUT_MS);
      return this;
    },
    clear() {
      clearTimeout(timer);
      timer = null;
      return this;
    },
  };
}

function pipeUpstreamStream(response, res) {
  if (!response.body) {
    res.end();
    return;
  }
  const source = Readable.fromWeb(response.body);
  const stop = () => {
    idle.clear();
    source.destroy();
    if (!res.writableEnded) res.end();
  };
  const idle = idleTimer(stop);
  res.on('close', () => {
    idle.clear();
    source.destroy();
  });
  source.on('data', () => idle.arm());
  source.once('error', stop);
  source.once('close', () => idle.clear());
  source.pipe(res);
}

async function readUpstreamText(response) {
  const text = response.text();
  text.catch(() => {});
  if (STREAM_IDLE_TIMEOUT_MS <= 0) return text;
  let timer = null;
  try {
    return await Promise.race([
      text,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          response.body?.cancel?.().catch(() => {});
          reject(httpError(504, 'upstream_timeout', 'Upstream response body timed out.'));
        }, STREAM_IDLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstream(kind, body, incomingHeaders = {}, options = {}) {
  const route = resolveRoute(options.requestedModel);
  const url = buildUpstreamUrl(kind, route?.baseUrl || UPSTREAM_BASE_URL);
  if (!url) throw httpError(503, 'upstream_not_configured', 'No upstream is configured for this model.');
  const apiKey = route ? route.apiKey : UPSTREAM_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const requestBody = options.rawBody !== undefined ? options.rawBody : JSON.stringify(body);
  try {
    const headers = {
      Accept: options.accept || (body?.stream ? 'text/event-stream, application/json' : 'application/json'),
      'Content-Type': options.contentType || 'application/json',
      ...collectForwardedHeaders(incomingHeaders),
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: controller.signal,
      redirect: 'error',
    });
    return { response, controller };
  } catch (error) {
    if (error?.name === 'AbortError') throw httpError(504, 'upstream_timeout', 'Upstream request timed out.');
    throw httpError(502, 'upstream_unreachable', `Upstream request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function forwardUpstreamError(upstream, res) {
  const bytes = Buffer.from(await upstream.arrayBuffer().catch(() => Buffer.from('')));
  const headers = {};
  const contentType = upstream.headers.get('content-type');
  const requestId = upstream.headers.get('x-request-id');
  const retryAfter = upstream.headers.get('retry-after');
  if (contentType) headers['Content-Type'] = contentType;
  if (requestId) headers['X-Request-ID'] = requestId;
  if (retryAfter) headers['Retry-After'] = retryAfter;
  headers['Content-Length'] = bytes.length;
  res.writeHead(upstream.status, headers);
  res.end(bytes);
}

async function handleBuiltinChat(body, res, requestedModel) {
  const prompt = flattenOpenAiMessages(body.messages);
  if (!prompt) throw httpError(400, 'invalid_messages', 'messages must contain text.');
  const text = await runBuiltinModel(requestedModel, prompt);
  const payload = {
    id: `chatcmpl-hy3-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  sendJson(res, 200, payload);
}

async function handleOpenAiChat(body, res, req) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw httpError(400, 'invalid_messages', 'messages must be a non-empty array.');
  const requestedModel = requestedModelId(body);
  if (isBuiltinModel(requestedModel)) return handleBuiltinChat(body, res, requestedModel);
  const upstreamBody = prepareOpenAiRequest({ ...body, model: upstreamModelId(requestedModel) }, requestedModel);
  const { response } = await fetchUpstream('chat', upstreamBody, req?.headers, { requestedModel });
  if (!response.ok) return forwardUpstreamError(response, res);
  copyResponseHeaders(response, res, body.stream ? 'text/event-stream' : 'application/json');
  if (body.stream) {
    res.writeHead(response.status);
    pipeUpstreamStream(response, res);
    return;
  }
  const text = await readUpstreamText(response);
  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload === 'object' && payload.model) payload.model = requestedModel;
    sendJson(res, response.status, payload);
  } catch {
    res.writeHead(response.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  }
}

async function handleOpenAiImages(body, res, req) {
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw httpError(400, 'invalid_prompt', 'prompt must be a non-empty string.');
  }
  const requestedModel = requestedModelId(body);
  const upstreamBody = prepareOpenAiImageRequest(body, requestedModel);
  const { response } = await fetchUpstream('images', upstreamBody, req?.headers, { requestedModel });
  if (!response.ok) return forwardUpstreamError(response, res);
  const text = await readUpstreamText(response);
  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload === 'object' && payload.model) payload.model = requestedModel;
    sendJson(res, response.status, payload);
  } catch {
    res.writeHead(response.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  }
}

async function handleOpenAiImageEdits(req, res) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data\b/i.test(contentType)) throw httpError(400, 'invalid_multipart', 'Image edits require multipart/form-data.');
  const rawBody = await readRawBody(req);
  const requestedModel = readMultipartTextField(rawBody, contentType, 'model');
  if (!requestedModel) throw httpError(400, 'invalid_model', 'Image edits require a model form field.');
  const mappedModel = upstreamModelId(requestedModel);
  const upstreamBody = replaceMultipartTextField(rawBody, contentType, 'model', mappedModel);
  const { response } = await fetchUpstream('image-edits', {}, req?.headers, {
    rawBody: upstreamBody,
    contentType,
    accept: 'application/json',
    requestedModel,
  });
  if (!response.ok) return forwardUpstreamError(response, res);
  const text = await readUpstreamText(response);
  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload === 'object' && payload.model) payload.model = requestedModel;
    sendJson(res, response.status, payload);
  } catch {
    res.writeHead(response.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  }
}

async function handleAnthropicMessages(body, res, req) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw httpError(400, 'invalid_messages', 'messages must be a non-empty array.');
  const requestedModel = requestedModelId(body);
  if (UPSTREAM_PROTOCOL === 'anthropic') {
    const upstreamBody = { ...body, model: upstreamModelId(requestedModel) };
    const { response } = await fetchUpstream('messages', upstreamBody, req?.headers, { requestedModel });
    if (!response.ok) return forwardUpstreamError(response, res);
    copyResponseHeaders(response, res, body.stream ? 'text/event-stream' : 'application/json');
    res.writeHead(response.status);
    if (body.stream) pipeUpstreamStream(response, res);
    else res.end(await readUpstreamText(response));
    return;
  }
  const openAiBody = anthropicToOpenAi(body, requestedModel);
  const { response } = await fetchUpstream('chat', openAiBody, req?.headers, { requestedModel });
  if (!response.ok) return forwardUpstreamError(response, res);
  if (body.stream) {
    res.writeHead(response.status, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    await streamOpenAiAsAnthropic(response, res, requestedModel);
    return;
  }
  const text = await readUpstreamText(response);
  let payload;
  try { payload = JSON.parse(text); } catch { throw httpError(502, 'invalid_upstream_response', 'Upstream did not return JSON.'); }
  sendJson(res, response.status, openAiToAnthropic(payload, requestedModel));
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function anthropicStopReason(finishReason) {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

function writeAnthropicBlockStart(res, state, type, contentBlock) {
  const index = state.nextBlockIndex++;
  writeSse(res, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: contentBlock,
  });
  state.currentBlockIndex = index;
  state.currentBlockType = type;
  return index;
}

function closeAnthropicBlock(res, state) {
  if (state.currentBlockIndex === null) return;
  writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: state.currentBlockIndex });
  state.currentBlockIndex = null;
  state.currentBlockType = null;
  state.currentToolCallIndex = null;
}

function ensureAnthropicBlock(res, state, type, contentBlock) {
  if (state.currentBlockType === type && state.currentBlockIndex !== null) return state.currentBlockIndex;
  closeAnthropicBlock(res, state);
  return writeAnthropicBlockStart(res, state, type, contentBlock);
}

function processOpenAiSseLine(line, state, res, requestedModel) {
  if (!line.startsWith('data:')) return;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return;
  let chunk;
  try { chunk = JSON.parse(data); } catch { return; }

  const usage = chunk?.usage;
  if (Number.isFinite(Number(usage?.prompt_tokens))) {
    state.inputTokens = Number(usage.prompt_tokens);
    state.hasUsage = true;
  }
  if (Number.isFinite(Number(usage?.completion_tokens))) {
    state.outputTokens = Number(usage.completion_tokens);
    state.hasOutputUsage = true;
    state.hasUsage = true;
  }

  const choice = chunk?.choices?.[0];
  const delta = choice?.delta || {};
  const reasoning = typeof delta.reasoning_content === 'string'
    ? delta.reasoning_content
    : typeof delta.reasoning === 'string' ? delta.reasoning : '';
  if (reasoning) {
    const index = ensureAnthropicBlock(res, state, 'thinking', { type: 'thinking', thinking: '' });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: reasoning },
    });
  }

  const text = typeof delta.content === 'string' ? delta.content : '';
  if (text) {
    const index = ensureAnthropicBlock(res, state, 'text', { type: 'text', text: '' });
    if (!state.hasOutputUsage) state.outputTokens += Math.max(1, Math.ceil(text.length / 4));
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    });
  }

  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const callIndex = Number.isInteger(call?.index) ? call.index : 0;
    const currentTool = state.currentBlockType === 'tool_use' && state.currentToolCallIndex === callIndex;
    if (!currentTool) {
      closeAnthropicBlock(res, state);
      state.currentToolCallIndex = callIndex;
      writeAnthropicBlockStart(res, state, 'tool_use', {
        type: 'tool_use',
        id: String(call?.id || 'toolu_' + Date.now() + '_' + callIndex),
        name: String(call?.function?.name || 'tool'),
        input: {},
      });
    }
    const partialJson = call?.function?.arguments;
    if (typeof partialJson === 'string' && partialJson) {
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.currentBlockIndex,
        delta: { type: 'input_json_delta', partial_json: partialJson },
      });
    }
  }

  const finishReason = choice?.finish_reason;
  if (finishReason && !state.finished) state.stopReason = anthropicStopReason(finishReason);
}

function finishAnthropicStream(res, state) {
  if (!state.finished) {
    if (state.currentBlockIndex === null) {
      writeAnthropicBlockStart(res, state, 'text', { type: 'text', text: '' });
    }
    closeAnthropicBlock(res, state);
    state.finished = true;
    writeSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: state.stopReason, stop_sequence: null },
      usage: { output_tokens: state.outputTokens },
    });
  }
  writeSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function streamOpenAiAsAnthropic(upstream, res, requestedModel) {
  const messageId = 'msg_' + Date.now();
  writeSse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const state = {
    inputTokens: 0,
    outputTokens: 0,
    hasUsage: false,
    hasOutputUsage: false,
    finished: false,
    stopReason: 'end_turn',
    nextBlockIndex: 0,
    currentBlockIndex: null,
    currentBlockType: null,
    currentToolCallIndex: null,
  };
  const reader = upstream.body?.getReader();
  if (!reader) {
    finishAnthropicStream(res, state);
    return;
  }

  let buffer = '';
  const decoder = new TextDecoder();
  const idle = idleTimer(() => {
    reader.cancel(new Error('upstream stream idle timeout')).catch(() => {});
  });
  try {
    idle.arm();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      idle.arm();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) processOpenAiSseLine(line, state, res, requestedModel);
    }
    buffer += decoder.decode();
    if (buffer) processOpenAiSseLine(buffer, state, res, requestedModel);
  } catch (error) {
    writeSse(res, 'error', { type: 'error', error: { type: 'api_error', message: error.message } });
  } finally {
    idle.clear();
  }

  finishAnthropicStream(res, state);
}

async function handleRequest(req, res) {
  applyCors(req, res);
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;
  if (!isLoopbackHostHeader(req.headers.host)) return sendError(res, 403, 'host_not_allowed', 'Only loopback Host headers are accepted.');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      service: 'workbuddy-cline-proxy',
      edition: WORKBUDDY_EDITION,
      protocol: UPSTREAM_PROTOCOL,
      upstream_configured: Boolean(UPSTREAM_BASE_URL) || MODEL_ROUTES.length > 0 || BUILTIN_MODELS.size > 0,
      routes: MODEL_ROUTES.length,
      builtin_models: [...BUILTIN_MODELS],
      models: CATALOG.length,
    });
  }
  if (!isAuthorized(req, pathname)) return sendError(res, 401, 'invalid_api_key', 'Missing or invalid proxy API key.');
  if (pathname === '/v1/models' && req.method === 'GET') return sendJson(res, 200, { object: 'list', data: openAiModelList() });
  if (pathname.startsWith('/v1/models/') && req.method === 'GET') {
    const id = decodeURIComponent(pathname.slice('/v1/models/'.length));
    const model = servedModels().find((item) => item.id === id);
    if (!model) return sendError(res, 404, 'model_not_found', `Unknown model: ${id}`);
    return sendJson(res, 200, modelRecord(model));
  }
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    try { return await handleOpenAiChat(await readJson(req), res, req); } catch (error) { return sendError(res, error.statusCode || 500, error.code || 'proxy_error', error.message); }
  }
  if (pathname === '/v1/images/generations' && req.method === 'POST') {
    try { return await handleOpenAiImages(await readJson(req), res, req); } catch (error) { return sendError(res, error.statusCode || 500, error.code || 'proxy_error', error.message); }
  }
  if (pathname === '/v1/images/edits' && req.method === 'POST') {
    try { return await handleOpenAiImageEdits(req, res); } catch (error) { return sendError(res, error.statusCode || 500, error.code || 'proxy_error', error.message); }
  }
  if (pathname === '/v1/messages' && req.method === 'POST') {
    try { return await handleAnthropicMessages(await readJson(req), res, req); } catch (error) { return sendError(res, error.statusCode || 500, error.code || 'proxy_error', error.message); }
  }
  return sendError(res, 404, 'not_found', 'Route not found.');
}

function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => sendError(res, error.statusCode || 500, error.code || 'proxy_error', error.message));
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`[workbuddy-proxy] listening on http://${HOST}:${PORT}`);
    console.log(`[workbuddy-proxy] model catalog: ${CATALOG.length} entries`);
    console.log(`[workbuddy-proxy] upstream: ${UPSTREAM_BASE_URL ? 'configured' : 'not configured'}`);
    console.log(`[workbuddy-proxy] model routes: ${MODEL_ROUTES.length}`);
    console.log(`[workbuddy-proxy] proxy auth: ${PROXY_API_KEY ? 'enabled' : 'not set'}`);
  });
}

module.exports = {
  CATALOG,
  DEFAULT_MODEL,
  anthropicToOpenAi,
  buildUpstreamUrl,
  createServer,
  loadCatalog,
  openAiToAnthropic,
  upstreamModelId,
  loadModelRoutes,
  resolveRoute,
  prepareOpenAiImageRequest,
  prepareOpenAiRequest,
  stripNamespacePrefix,
};


