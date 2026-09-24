'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { anthropicToOpenAi, buildUpstreamUrl, openAiToAnthropic, CATALOG, DEFAULT_MODEL, loadModelRoutes, prepareOpenAiImageRequest, prepareOpenAiRequest, stripNamespacePrefix, upstreamModelId } = require('../server');

test('loads the WorkBuddy model catalog', () => {
  assert.equal(CATALOG.length, 44);
  assert.ok(CATALOG.some((model) => model.id === 'deepseek-v4-pro'));
  assert.equal(DEFAULT_MODEL, 'auto');
});

test('converts a basic Anthropic request to OpenAI format', () => {
  const result = anthropicToOpenAi({
    system: 'Be concise.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    max_tokens: 32,
    stream: false,
  }, 'glm-5.1');
  assert.equal(result.model, 'glm-5.1');
  assert.deepEqual(result.messages, [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Hello' },
  ]);
  assert.equal(result.max_tokens, 32);
});

test('maps Anthropic thinking blocks to OpenAI reasoning_content', () => {
  const result = anthropicToOpenAi({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Plan the answer first.' },
        { type: 'text', text: 'Here is the answer.' },
      ],
    }],
  }, 'gpt-5');
  assert.deepEqual(result.messages, [{
    role: 'assistant',
    content: 'Here is the answer.',
    reasoning_content: 'Plan the answer first.',
  }]);
});

test('uses null content for thinking-only assistant messages', () => {
  const result = anthropicToOpenAi({
    messages: [{
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'No visible text.' }],
    }],
  }, 'gpt-5');
  assert.deepEqual(result.messages, [{
    role: 'assistant',
    content: null,
    reasoning_content: 'No visible text.',
  }]);
});

test('splits Anthropic tool-result images into a tool message and multimodal user message', () => {
  const result = anthropicToOpenAi({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'inspect', input: {} }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: [
            { type: 'text', text: 'Screenshot attached.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
          ],
        }],
      },
    ],
  }, 'gpt-5');
  assert.equal(result.messages[1].role, 'tool');
  assert.equal(result.messages[1].content, 'Screenshot attached.');
  assert.deepEqual(result.messages[2], {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
  });
});
test('maps Anthropic tool_choice none to OpenAI none', () => {
  const result = anthropicToOpenAi({
    messages: [{ role: 'user', content: 'Use no tools.' }],
    tools: [{
      name: 'lookup',
      description: 'Look something up.',
      input_schema: { type: 'object', properties: {} },
    }],
    tool_choice: { type: 'none' },
  }, 'gpt-5');
  assert.equal(result.tool_choice, 'none');
});
test('maps OpenAI reasoning_content to Anthropic thinking', () => {
  const result = openAiToAnthropic({
    id: 'chatcmpl-reasoning',
    choices: [{
      message: {
        role: 'assistant',
        reasoning_content: 'Think first.',
        content: 'Final answer.',
      },
      finish_reason: 'stop',
    }],
  }, 'gpt-5');
  assert.deepEqual(result.content, [
    { type: 'thinking', thinking: 'Think first.' },
    { type: 'text', text: 'Final answer.' },
  ]);
});
test('converts an OpenAI response to Anthropic format', () => {
  const result = openAiToAnthropic({
    id: 'chatcmpl-test',
    choices: [{
      message: { role: 'assistant', content: 'Hello back.' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 4, completion_tokens: 3 },
  }, 'glm-5.1');
  assert.equal(result.id, 'chatcmpl-test');
  assert.equal(result.model, 'glm-5.1');
  assert.deepEqual(result.content, [{ type: 'text', text: 'Hello back.' }]);
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 3 });
});


test('normalizes OpenAI and Anthropic upstream endpoint suffixes', () => {
  assert.equal(buildUpstreamUrl('chat', 'http://127.0.0.1:8000'), 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(buildUpstreamUrl('chat', 'http://127.0.0.1:8000/v1/chat/completions/chat/completions?x=1'), 'http://127.0.0.1:8000/v1/chat/completions?x=1');
  assert.equal(buildUpstreamUrl('messages', 'https://example.test/v1/messages/'), 'https://example.test/v1/messages');
  assert.equal(buildUpstreamUrl('chat', 'https://example.test/v1/messages'), 'https://example.test/v1/chat/completions');
});

test('supports Cline OpenAI image-generation requests', () => {
  assert.equal(buildUpstreamUrl('images', 'http://127.0.0.1:8000'), 'http://127.0.0.1:8000/v1/images/generations');
  assert.equal(buildUpstreamUrl('images', 'https://example.test/v1/images/generations?x=1'), 'https://example.test/v1/images/generations?x=1');
  assert.equal(buildUpstreamUrl('image-edits', 'https://example.test/v1/images/edits'), 'https://example.test/v1/images/edits');
  assert.deepEqual(prepareOpenAiImageRequest({
    model: 'ignored',
    prompt: 'a red fox',
    size: '1024x1024',
    providerOptions: { openai: { outputFormat: 'png' } },
  }, 'hunyuan-image-v3.0'), {
    model: 'hunyuan-image-v3.0',
    prompt: 'a red fox',
    size: '1024x1024',
  });
});


test('cleans SDK-only fields while preserving custom-model reasoning by default', () => {
  const result = prepareOpenAiRequest({
    model: 'custom-local:gpt-5.6-luna',
    messages: [{ role: 'user', content: 'Hello' }],
    verbosity: 'high',
    reasoning_summary: 'auto',
    reasoning_effort: 'high',
    max_tokens: 64,
  }, 'custom-local:gpt-5.6-luna');
  assert.equal(result.model, 'custom-local:gpt-5.6-luna');
  assert.equal(result.verbosity, undefined);
  assert.equal(result.reasoning_summary, undefined);
  assert.equal(result.reasoning_effort, 'high');
  assert.equal(result.max_tokens, 64);
});

test('supports opt-in token-field conversion and reasoning cleanup', () => {
  const result = prepareOpenAiRequest({
    max_tokens: 64,
    reasoning_effort: 'high',
    reasoning: { effort: 'high', enabled: true },
  }, 'gpt-5', {
    maxTokensField: 'max_completion_tokens',
    stripReasoningEffort: true,
  });
  assert.equal(result.max_tokens, undefined);
  assert.equal(result.max_completion_tokens, 64);
  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.reasoning, { enabled: true });
});

test('loads only complete entries from a WorkBuddy models.json route file', () => {
  const filePath = path.join(os.tmpdir(), `workbuddy-routes-unit-${process.pid}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    models: [
      { id: 'kept', url: 'https://example.invalid/v1/chat/completions', apiKey: 'secret' },
      { id: '  trimmed  ', url: 'https://example.invalid/v1/', apiKey: '  key  ' },
      { id: 'no-url' },
      { url: 'https://example.invalid/v1' },
    ],
  }));
  try {
    const routes = loadModelRoutes(filePath);
    assert.deepEqual(routes, [
      { id: 'kept', name: 'kept', baseUrl: 'https://example.invalid/v1/chat/completions', apiKey: 'secret', reasoning: false },
      { id: 'trimmed', name: 'trimmed', baseUrl: 'https://example.invalid/v1/', apiKey: 'key', reasoning: false },
    ]);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
  assert.deepEqual(loadModelRoutes(''), []);
});

test('strips WorkBuddy routing namespaces before upstream mapping', () => {
  assert.equal(stripNamespacePrefix('custom-local:org/gpt-5'), 'gpt-5');
  assert.equal(upstreamModelId('custom-local:org/gpt-5'), 'gpt-5');
});
