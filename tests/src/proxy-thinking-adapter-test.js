#!/usr/bin/env node

const assert = require('node:assert/strict');
const anthropicConverter = require('../../src/anthropic-converter');
const {
  PROXY_THINKING_SIGNATURE_PREFIX,
  ProxyThinkingBlockAdapter,
  isProxyThinkingSignature,
  isProxyLocalThinkingBlock,
} = require('../../src/proxy-thinking-adapter');

function parseSsePayload(sse) {
  const line = String(sse).split('\n').find((l) => l.startsWith('data: '));
  assert(line, 'SSE data line exists');
  return JSON.parse(line.slice('data: '.length));
}

const adapter = new ProxyThinkingBlockAdapter({
  source: 'test',
  convKey: 'conv123',
  requestId: 'req123',
  blockIndex: 0,
});
adapter.append('first ');
adapter.append('second');
const signature = adapter.signature();

assert(signature.startsWith(PROXY_THINKING_SIGNATURE_PREFIX), 'signature has proxy-local prefix');
assert(isProxyThinkingSignature(signature), 'signature is recognized');
assert(isProxyLocalThinkingBlock({
  type: 'thinking',
  thinking: 'first second',
  signature,
}), 'thinking block is recognized as proxy-local');
assert(!isProxyLocalThinkingBlock({
  type: 'thinking',
  thinking: 'first second',
  signature: 'real-anthropic-looking-signature',
}), 'non-proxy thinking block is not recognized');

const sigEvent = parseSsePayload(anthropicConverter.buildContentBlockDeltaSignature(3, signature));
assert.equal(sigEvent.type, 'content_block_delta');
assert.equal(sigEvent.index, 3);
assert.deepEqual(sigEvent.delta, { type: 'signature_delta', signature });

const prompt = anthropicConverter.anthropicMessagesToPrompt([
  { role: 'user', content: 'question' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'proxy-local hidden', signature },
      { type: 'text', text: 'visible answer' },
    ],
  },
  { role: 'user', content: 'next' },
]);
assert(!prompt.includes('proxy-local hidden'), 'proxy-local thinking is not rendered into prompt');
assert(prompt.includes('visible answer'), 'assistant text is still rendered');

const realThinkingPrompt = anthropicConverter.anthropicMessagesToPrompt([
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'non proxy thinking', signature: 'non-proxy' },
      { type: 'text', text: 'answer' },
    ],
  },
  { role: 'user', content: 'next' },
]);
assert(realThinkingPrompt.includes('<thinking>\nnon proxy thinking\n</thinking>'), 'non-proxy thinking keeps previous rendering behavior');

console.log('proxy-thinking-adapter-test: OK');
