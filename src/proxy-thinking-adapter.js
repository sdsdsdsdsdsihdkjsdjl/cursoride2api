const crypto = require('crypto');

const PROXY_THINKING_SIGNATURE_PREFIX = 'proxy-local-thinking-v1.';

function _asString(value) {
  return value == null ? '' : String(value);
}

function makeProxyThinkingSignature(meta = {}) {
  const source = _asString(meta.source || 'cursor');
  const convKey = _asString(meta.convKey);
  const requestId = _asString(meta.requestId);
  const blockIndex = _asString(meta.blockIndex);
  const turnIndex = _asString(meta.turnIndex);
  const textHash = _asString(meta.textHash) || crypto
    .createHash('sha256')
    .update(_asString(meta.text))
    .digest('hex');
  const payloadHash = crypto
    .createHash('sha256')
    .update([source, convKey, requestId, blockIndex, turnIndex, textHash].join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `${PROXY_THINKING_SIGNATURE_PREFIX}${payloadHash}.${textHash.slice(0, 32)}`;
}

function isProxyThinkingSignature(signature) {
  return typeof signature === 'string' && signature.startsWith(PROXY_THINKING_SIGNATURE_PREFIX);
}

function isProxyLocalThinkingBlock(block) {
  return !!(
    block &&
    block.type === 'thinking' &&
    isProxyThinkingSignature(block.signature)
  );
}

class ProxyThinkingBlockAdapter {
  constructor(meta = {}) {
    this.meta = { ...meta };
    this._hash = crypto.createHash('sha256');
    this._digested = null;
    this._bytes = 0;
  }

  append(text) {
    if (!text || this._digested) return;
    const raw = _asString(text);
    this._bytes += Buffer.byteLength(raw, 'utf8');
    this._hash.update(raw);
  }

  signature(extra = {}) {
    if (!this._digested) this._digested = this._hash.digest('hex');
    return makeProxyThinkingSignature({
      ...this.meta,
      ...extra,
      textHash: this._digested,
      byteLength: this._bytes,
    });
  }

  get byteLength() {
    return this._bytes;
  }
}

module.exports = {
  PROXY_THINKING_SIGNATURE_PREFIX,
  ProxyThinkingBlockAdapter,
  makeProxyThinkingSignature,
  isProxyThinkingSignature,
  isProxyLocalThinkingBlock,
};
