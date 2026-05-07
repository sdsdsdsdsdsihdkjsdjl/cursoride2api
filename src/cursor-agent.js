// ═══════════════════════════════════════════════
//  CursorIDE2API - Cursor Agent Protocol Client
//  Full tool support over a persistent H2 stream
// ═══════════════════════════════════════════════
//
//  Unlike cursor-client.js which resolves once on turnEnded,
//  this client keeps the H2 stream alive across tool calls.
//  The model emits mcpArgs → onMcpCall fires → caller invokes
//  sendToolResult() → mcpResult written back into the same
//  stream. The stream stays open (with heartbeats) until
//  turnEnded or close().

const http2 = require('http2');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const { generateChecksum } = require('./cursor-client');

// ── 5-byte connect+json frame ──
function encodeFrame(obj) {
  const jsonBuf = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = Buffer.alloc(5 + jsonBuf.length);
  frame[0] = 0;
  frame.writeUInt32BE(jsonBuf.length, 1);
  jsonBuf.copy(frame, 5);
  return frame;
}

// ── Build H2 request headers (matches cursor-client.js) ──
function buildHeaders(token) {
  return {
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    'content-type': 'application/connect+json',
    'connect-protocol-version': '1',
    'authorization': `Bearer ${token.accessToken}`,
    'x-cursor-checksum': generateChecksum(token.machineId || '', token.macMachineId || ''),
    'x-cursor-client-version': config.cursor.clientVersion,
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'x-request-id': uuidv4(),
  };
}

// ── Deterministic conversation UUID derived from a key ──
// Format 16 bytes of SHA-256 as a v4-shaped UUID so the same convKey
// always produces the same conversationId. Lets Cursor's server-side
// state survive proxy restarts.
function deterministicConversationId(convKey) {
  const hex = crypto.createHash('sha256')
    .update(`cursor-conv-id:${convKey}`)
    .digest('hex')
    .slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(0x8 | (parseInt(hex[16], 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

// ═══════════════════════════════════════════════
//  Minimal google.protobuf.Value codec
// ═══════════════════════════════════════════════
//
// Wire format reminder:
//   1 (varint)         null_value
//   2 (64-bit/fixed64) number_value (double LE)
//   3 (length-delim)   string_value
//   4 (varint)         bool_value
//   5 (length-delim)   struct_value (Struct = repeated FieldsEntry)
//   6 (length-delim)   list_value   (ListValue.values = repeated Value)
//
// FieldsEntry: { 1: string key, 2: Value value }
// ListValue:   { 1: repeated Value }

// ── Varint encode/decode ──
function encodeVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, next: pos };
    }
    shift += 7n;
    if (shift > 63n) throw new Error('varint overflow');
  }
  throw new Error('varint truncated');
}

// ── Field tag = (field_number << 3) | wire_type ──
function tag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function lenDelim(fieldNumber, payload) {
  return Buffer.concat([tag(fieldNumber, 2), encodeVarint(payload.length), payload]);
}

// ── Encode a JS value as google.protobuf.Value bytes ──
function encodeValue(json) {
  if (json === null || json === undefined) {
    // null_value, NullValue.NULL_VALUE = 0
    return Buffer.concat([tag(1, 0), encodeVarint(0)]);
  }
  if (typeof json === 'boolean') {
    return Buffer.concat([tag(4, 0), encodeVarint(json ? 1 : 0)]);
  }
  if (typeof json === 'number') {
    const dbl = Buffer.alloc(8);
    dbl.writeDoubleLE(json, 0);
    return Buffer.concat([tag(2, 1), dbl]);
  }
  if (typeof json === 'string') {
    const strBuf = Buffer.from(json, 'utf8');
    return lenDelim(3, strBuf);
  }
  if (Array.isArray(json)) {
    // ListValue: repeated Value values = 1
    const inner = Buffer.concat(json.map((v) => lenDelim(1, encodeValue(v))));
    return lenDelim(6, inner);
  }
  if (typeof json === 'object') {
    // Struct: repeated FieldsEntry fields = 1
    // FieldsEntry: { 1: string key, 2: Value value }
    const entries = [];
    for (const k of Object.keys(json)) {
      const keyBuf = lenDelim(1, Buffer.from(k, 'utf8'));
      const valBuf = lenDelim(2, encodeValue(json[k]));
      const fields = Buffer.concat([keyBuf, valBuf]);
      // Each FieldsEntry is itself the message-typed map entry under field 1 of Struct.
      entries.push(lenDelim(1, fields));
    }
    return lenDelim(5, Buffer.concat(entries));
  }
  // Fallback — coerce to string
  return lenDelim(3, Buffer.from(String(json), 'utf8'));
}

// ── Decode google.protobuf.Value bytes to a JS value ──
function decodeValueBytes(buf) {
  let offset = 0;
  let result;
  let resolved = false;

  while (offset < buf.length) {
    const t = decodeVarint(buf, offset);
    const tagVal = Number(t.value);
    offset = t.next;
    const fieldNumber = tagVal >>> 3;
    const wireType = tagVal & 0x7;

    if (fieldNumber === 1 && wireType === 0) {
      // null_value
      const v = decodeVarint(buf, offset);
      offset = v.next;
      result = null;
      resolved = true;
    } else if (fieldNumber === 2 && wireType === 1) {
      // number_value (double, 8 bytes LE)
      result = buf.readDoubleLE(offset);
      offset += 8;
      resolved = true;
    } else if (fieldNumber === 3 && wireType === 2) {
      // string_value
      const len = decodeVarint(buf, offset);
      offset = len.next;
      const n = Number(len.value);
      result = buf.slice(offset, offset + n).toString('utf8');
      offset += n;
      resolved = true;
    } else if (fieldNumber === 4 && wireType === 0) {
      // bool_value
      const v = decodeVarint(buf, offset);
      offset = v.next;
      result = Number(v.value) !== 0;
      resolved = true;
    } else if (fieldNumber === 5 && wireType === 2) {
      // struct_value
      const len = decodeVarint(buf, offset);
      offset = len.next;
      const n = Number(len.value);
      result = decodeStructBytes(buf.slice(offset, offset + n));
      offset += n;
      resolved = true;
    } else if (fieldNumber === 6 && wireType === 2) {
      // list_value
      const len = decodeVarint(buf, offset);
      offset = len.next;
      const n = Number(len.value);
      result = decodeListBytes(buf.slice(offset, offset + n));
      offset += n;
      resolved = true;
    } else {
      // Unknown — skip per wire type
      offset = skipField(buf, offset, wireType);
    }
  }

  if (!resolved) return null;
  return result;
}

function decodeStructBytes(buf) {
  // Struct: repeated FieldsEntry fields = 1
  // FieldsEntry (length-delimited): { 1: string key, 2: Value value }
  const out = {};
  let offset = 0;
  while (offset < buf.length) {
    const t = decodeVarint(buf, offset);
    offset = t.next;
    const fieldNumber = Number(t.value) >>> 3;
    const wireType = Number(t.value) & 0x7;
    if (fieldNumber === 1 && wireType === 2) {
      const len = decodeVarint(buf, offset);
      offset = len.next;
      const n = Number(len.value);
      const entry = buf.slice(offset, offset + n);
      offset += n;
      // Parse FieldsEntry
      let eo = 0;
      let key = '';
      let valBytes = null;
      while (eo < entry.length) {
        const et = decodeVarint(entry, eo);
        eo = et.next;
        const efn = Number(et.value) >>> 3;
        const ewt = Number(et.value) & 0x7;
        if (efn === 1 && ewt === 2) {
          const elen = decodeVarint(entry, eo);
          eo = elen.next;
          const en = Number(elen.value);
          key = entry.slice(eo, eo + en).toString('utf8');
          eo += en;
        } else if (efn === 2 && ewt === 2) {
          const elen = decodeVarint(entry, eo);
          eo = elen.next;
          const en = Number(elen.value);
          valBytes = entry.slice(eo, eo + en);
          eo += en;
        } else {
          eo = skipField(entry, eo, ewt);
        }
      }
      out[key] = valBytes ? decodeValueBytes(valBytes) : null;
    } else {
      offset = skipField(buf, offset, wireType);
    }
  }
  return out;
}

function decodeListBytes(buf) {
  // ListValue: repeated Value values = 1
  const out = [];
  let offset = 0;
  while (offset < buf.length) {
    const t = decodeVarint(buf, offset);
    offset = t.next;
    const fieldNumber = Number(t.value) >>> 3;
    const wireType = Number(t.value) & 0x7;
    if (fieldNumber === 1 && wireType === 2) {
      const len = decodeVarint(buf, offset);
      offset = len.next;
      const n = Number(len.value);
      const valBytes = buf.slice(offset, offset + n);
      offset += n;
      out.push(decodeValueBytes(valBytes));
    } else {
      offset = skipField(buf, offset, wireType);
    }
  }
  return out;
}

function skipField(buf, offset, wireType) {
  if (wireType === 0) {
    return decodeVarint(buf, offset).next;
  }
  if (wireType === 1) return offset + 8;
  if (wireType === 5) return offset + 4;
  if (wireType === 2) {
    const len = decodeVarint(buf, offset);
    return len.next + Number(len.value);
  }
  throw new Error(`unsupported wire type ${wireType}`);
}

// ── Decode an mcp_args.args map into a plain JS object ──
// Wire shape: { key: { value: "<base64 of Value bytes>" } }
function decodeMcpArgs(argsMap) {
  const out = {};
  if (!argsMap || typeof argsMap !== 'object') return out;
  for (const k of Object.keys(argsMap)) {
    const entry = argsMap[k];
    let b64 = null;
    if (typeof entry === 'string') {
      b64 = entry;
    } else if (entry && typeof entry === 'object') {
      b64 = entry.value || entry.bytes || entry.data || null;
    }
    if (!b64) {
      out[k] = null;
      continue;
    }
    try {
      const bytes = Buffer.from(b64, 'base64');
      try {
        out[k] = decodeValueBytes(bytes);
      } catch {
        out[k] = bytes.toString('utf8');
      }
    } catch {
      out[k] = null;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════
//  ExecServerMessage handling
// ═══════════════════════════════════════════════

function handleExecMessage(exec, tools, writeFrame, onMcpCall) {
  const { id = 0, execId = '' } = exec;
  if (process.env.CURSOR_AGENT_DEBUG) {
    const keys = Object.keys(exec).filter(k => !['id', 'execId'].includes(k));
    console.log(`[cursor-agent][debug] exec id=${id} execId=${execId} keys=${keys.join(',')}`);
  }

  if (exec.requestContextArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        requestContextResult: {
          success: {
            requestContext: {
              env: {
                operatingSystem: process.platform === 'win32' ? 'windows' : process.platform,
                defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
              },
              tools: tools || [],
              rules: [],
              repositoryInfo: [],
              gitRepos: [],
              projectLayouts: [],
              mcpInstructions: [],
              fileContents: {},
              customSubagents: [],
            },
          },
        },
      },
    });
    return 'requestContext';
  }

  // ── MCP tool call: bubble up to caller, do NOT respond yet ──
  if (exec.mcpArgs) {
    const m = exec.mcpArgs;
    const args = decodeMcpArgs(m.args || {});
    const toolCallId = m.toolCallId || `tc_${Math.random().toString(36).slice(2)}`;
    const toolName = m.toolName || m.name || '';
    onMcpCall({ id, execId, toolCallId, toolName, args });
    return 'mcp';
  }

  const REJECT_REASON = 'Tool not available; use MCP tools.';

  if (exec.readArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        readResult: {
          rejected: { path: exec.readArgs.path || '', reason: REJECT_REASON },
        },
      },
    });
    return 'read';
  }

  if (exec.lsArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        lsResult: {
          rejected: { path: exec.lsArgs.path || '', reason: REJECT_REASON },
        },
      },
    });
    return 'ls';
  }

  if (exec.writeArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        writeResult: {
          rejected: { path: exec.writeArgs.path || '', reason: REJECT_REASON },
        },
      },
    });
    return 'write';
  }

  if (exec.deleteArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        deleteResult: {
          rejected: { path: exec.deleteArgs.path || '', reason: REJECT_REASON },
        },
      },
    });
    return 'delete';
  }

  if (exec.shellArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        shellResult: {
          rejected: {
            command: exec.shellArgs.command || '',
            workingDirectory: exec.shellArgs.workingDirectory || '',
            reason: REJECT_REASON,
            isReadonly: false,
          },
        },
      },
    });
    return 'shell';
  }

  if (exec.shellStreamArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        // shellStreamArgs response type is `shellStream`, not `shellResult`.
        shellStream: {
          rejected: {
            command: exec.shellStreamArgs.command || '',
            workingDirectory: exec.shellStreamArgs.workingDirectory || '',
            reason: REJECT_REASON,
            isReadonly: false,
          },
        },
      },
    });
    return 'shellStream';
  }

  if (exec.backgroundShellSpawnArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        backgroundShellSpawnResult: {
          rejected: {
            command: exec.backgroundShellSpawnArgs.command || '',
            workingDirectory: exec.backgroundShellSpawnArgs.workingDirectory || '',
            reason: REJECT_REASON,
            isReadonly: false,
          },
        },
      },
    });
    return 'backgroundShell';
  }

  if (exec.grepArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        grepResult: { error: { error: REJECT_REASON } },
      },
    });
    return 'grep';
  }

  if (exec.fetchArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        fetchResult: {
          error: { url: exec.fetchArgs.url || '', error: REJECT_REASON },
        },
      },
    });
    return 'fetch';
  }

  if (exec.writeShellStdinArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        writeShellStdinResult: { error: { error: REJECT_REASON } },
      },
    });
    return 'writeShellStdin';
  }

  if (exec.diagnosticsArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        diagnosticsResult: { diagnostics: [] },
      },
    });
    return 'diagnostics';
  }

  // Unknown exec type — log and ignore. Sending a stray reply with the
  // wrong field would just cause a mismatch error from Cursor.
  console.log(`[cursor-agent] unhandled exec type for execId=${execId}`);
  return 'unknown';
}

// ═══════════════════════════════════════════════
//  startConversation — Bridge object with persistent stream
// ═══════════════════════════════════════════════

function startConversation(token, options = {}) {
  const {
    prompt = '',
    modelId,
    conversationId = uuidv4(),
    conversationState = null,
    tools = [],
    onTextDelta,
    onThinkingDelta,
    onMcpCall,
    onTurnEnded,
    onError,
  } = options;

  // ── Mutable callback slot — caller can swap callbacks across turns ──
  // Each event handler dispatches through `currentCallbacks.<name>?.(...)` so
  // re-binding via setCallbacks() steers later events to a fresh HTTP response.
  const currentCallbacks = {
    onTextDelta: onTextDelta || (() => {}),
    onThinkingDelta: onThinkingDelta || (() => {}),
    onMcpCall: onMcpCall || (() => {}),
    onTurnEnded: onTurnEnded || (() => {}),
    onError: onError || (() => {}),
  };

  function setCallbacks(newCallbacks) {
    if (!newCallbacks || typeof newCallbacks !== 'object') return;
    for (const k of ['onTextDelta', 'onThinkingDelta', 'onMcpCall', 'onTurnEnded', 'onError']) {
      if (typeof newCallbacks[k] === 'function') {
        currentCallbacks[k] = newCallbacks[k];
      }
    }
  }

  console.log(
    `[cursor-agent] new conv id=${conversationId} model=${modelId} ` +
    `hasState=${!!conversationState} tools=${(tools || []).length}`
  );

  let client;
  try {
    client = http2.connect(config.cursor.baseUrl);
  } catch (e) {
    currentCallbacks.onError(`Connection failed: ${e.message}`);
    return makeDeadBridge(conversationId);
  }
  client.on('error', (e) => {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] client error: ${e.message}`);
  });
  client.on('close', () => {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] client closed`);
  });
  client.on('connect', () => {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] client connected`);
  });
  client.on('goaway', () => {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] client goaway`);
  });

  const req = client.request(buildHeaders(token));
  req.setTimeout(config.cursor.requestTimeout);
  if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] req created`);

  let buffer = Buffer.alloc(0);
  let closed = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let capturedState = null;
  // Blob store: Cursor sends setBlobArgs to cache pieces of conversation state
  // on our side (system prompt, user context, etc.) and may getBlobArgs them
  // back later. We just need to play along — keyed by base64 blobId string.
  const blobStore = new Map();

  const writeFrame = (obj) => {
    if (closed) return;
    try { req.write(encodeFrame(obj)); } catch { /* ignore */ }
  };

  // Heartbeat — keep firing even while we're waiting for a tool result.
  // This is the key difference vs cursor-client.js.
  const heartbeat = setInterval(() => {
    writeFrame({ clientHeartbeat: {} });
  }, config.cursor.heartbeatInterval);

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { req.end(); } catch { /* ignore */ }
    setTimeout(() => {
      try { req.close(); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }, 200);
  }

  function fail(msg) {
    if (closed) return;
    currentCallbacks.onError(msg);
    close();
  }

  // ── sendToolResult: write mcpResult into the live stream ──
  function sendToolResult(id, execId, content) {
    if (closed) return;
    let mcpResult;
    if (typeof content === 'string') {
      mcpResult = {
        success: {
          // McpToolResultContentItem.text -> McpTextContent { text }
          content: [{ text: { text: content } }],
          isError: false,
        },
      };
    } else if (content && typeof content === 'object' && content.error) {
      mcpResult = { error: { error: String(content.error) } };
    } else {
      // Coerce anything else to a string success
      const s = content == null ? '' : (typeof content === 'string' ? content : JSON.stringify(content));
      mcpResult = {
        success: {
          content: [{ text: { text: s } }],
          isError: false,
        },
      };
    }
    console.log(`[cursor-agent] sending tool result execId=${execId} ok=${!content?.error}`);
    writeFrame({ execClientMessage: { id, execId, mcpResult } });
  }

  // ── Frame parser: 5-byte header + JSON body ──
  req.on('data', (chunk) => {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] data chunk ${chunk.length}B`);
    buffer = Buffer.concat([buffer, chunk]);
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const len = buffer.readUInt32BE(offset + 1);
      if (offset + 5 + len > buffer.length) break;
      const s = buffer.slice(offset + 5, offset + 5 + len).toString('utf8');
      offset += 5 + len;
      let msg;
      try { msg = JSON.parse(s); } catch { continue; }
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] msg keys: ${Object.keys(msg).join(',')}`);
      handleServerMessage(msg);
    }
    buffer = buffer.slice(offset);
  });

  req.on('response', (headers) => {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] response status=${headers[':status']}`);
  });

  req.on('end', () => {
    if (closed) return;
    // Stream closed without an explicit turnEnded — surface what we have.
    clearInterval(heartbeat);
    if (!closed) {
      closed = true;
      try { client.close(); } catch { /* ignore */ }
    }
  });

  req.on('error', (e) => fail(e.message || 'Stream error'));
  req.on('timeout', () => fail('Request timeout'));

  // ── Top-level server message dispatch ──
  function handleServerMessage(msg) {
    // Connect-level error envelope
    if (msg.error) {
      let detail = '';
      if (msg.error.details && msg.error.details[0] && msg.error.details[0].value) {
        try {
          detail = Buffer.from(msg.error.details[0].value, 'base64').toString('utf8');
        } catch { /* ignore */ }
      }
      fail(detail || msg.error.message || msg.error.code || 'Unknown error');
      return;
    }

    if (msg.execServerMessage) {
      // Dispatch through currentCallbacks so re-binding via setCallbacks() takes effect.
      handleExecMessage(msg.execServerMessage, tools, writeFrame, (info) => currentCallbacks.onMcpCall(info));
      return;
    }

    if (msg.kvServerMessage) {
      const kv = msg.kvServerMessage;
      const kvId = kv.id;

      // setBlobArgs: Cursor is asking us to cache a blob (typically the system
      // prompt / user context / assistant turns). Store and ACK so the model
      // can keep streaming.
      if (kv.setBlobArgs) {
        const { blobId, blobData } = kv.setBlobArgs;
        if (blobId) blobStore.set(blobId, blobData || '');
        if (process.env.CURSOR_AGENT_DEBUG) {
          console.log(`[cursor-agent][debug] kv setBlob id=${kvId} blobId=${(blobId || '').slice(0, 24)}... bytes=${(blobData || '').length}`);
        }
        writeFrame({ kvClientMessage: { id: kvId, setBlobResult: {} } });
        return;
      }

      // getBlobArgs: Cursor is asking us to return a previously-cached blob.
      // If we have it, return it; otherwise empty.
      if (kv.getBlobArgs) {
        const { blobId } = kv.getBlobArgs;
        const blobData = blobStore.get(blobId);
        if (process.env.CURSOR_AGENT_DEBUG) {
          console.log(`[cursor-agent][debug] kv getBlob id=${kvId} blobId=${(blobId || '').slice(0, 24)}... found=${blobData != null}`);
        }
        writeFrame({
          kvClientMessage: {
            id: kvId,
            getBlobResult: blobData ? { blobData } : {},
          },
        });
        return;
      }

      if (process.env.CURSOR_AGENT_DEBUG) {
        const keys = Object.keys(kv).filter(k => !['id', 'execId', 'spanContext'].includes(k));
        console.log(`[cursor-agent][debug] kv id=${kvId} unhandled keys=${keys.join(',')}`);
      }
      return;
    }

    if (msg.interactionUpdate) {
      const iu = msg.interactionUpdate;

      if (iu.heartbeat !== undefined) return;

      if (iu.textDelta) {
        const t = typeof iu.textDelta === 'string'
          ? iu.textDelta
          : (iu.textDelta.text || iu.textDelta.delta || '');
        if (t) currentCallbacks.onTextDelta(t);
        return;
      }

      if (iu.thinkingDelta) {
        const t = typeof iu.thinkingDelta === 'string'
          ? iu.thinkingDelta
          : (iu.thinkingDelta.text || iu.thinkingDelta.delta || '');
        if (t) currentCallbacks.onThinkingDelta(t);
        return;
      }

      if (iu.thinkingCompleted) return;

      if (iu.tokenDelta) {
        const td = iu.tokenDelta;
        if (td.tokens) outputTokens += parseInt(td.tokens, 10) || 0;
        return;
      }

      if (iu.stepCompleted) return;

      if (iu.turnEnded) {
        inputTokens = parseInt(iu.turnEnded.inputTokens || '0', 10) || 0;
        outputTokens = parseInt(iu.turnEnded.outputTokens || String(outputTokens), 10) || outputTokens;
        console.log(
          `[cursor-agent] turn ended in=${inputTokens} out=${outputTokens} ` +
          `state=${capturedState ? capturedState.length + 'B' : 'null'}`
        );
        try {
          currentCallbacks.onTurnEnded({ inputTokens, outputTokens, conversationState: capturedState });
        } catch (e) {
          console.log(`[cursor-agent] onTurnEnded threw: ${e.message}`);
        }
        // NOTE: do not auto-close here. The caller decides whether to keep the
        // bridge alive for a follow-up turn (e.g. tool_use → tool_result) or
        // close it. Closing here would race with sendToolResult for tool_use
        // turns. The caller invokes bridge.close() when no tool calls remain.
        return;
      }

      // Nested-message variants seen on some models
      const m = iu.message;
      if (m) {
        if (m.textDelta) {
          const t = typeof m.textDelta === 'string'
            ? m.textDelta
            : (m.textDelta.text || m.textDelta.delta || '');
          if (t) currentCallbacks.onTextDelta(t);
        }
        if (m.thinkingDelta) {
          const t = m.thinkingDelta.text || m.thinkingDelta.delta || '';
          if (t) currentCallbacks.onThinkingDelta(t);
        }
        if (m.turnEnded) {
          inputTokens = parseInt(m.turnEnded.inputTokens || '0', 10) || 0;
          outputTokens = parseInt(m.turnEnded.outputTokens || String(outputTokens), 10) || outputTokens;
          console.log(
            `[cursor-agent] turn ended (nested) in=${inputTokens} out=${outputTokens} ` +
            `state=${capturedState ? capturedState.length + 'B' : 'null'}`
          );
          try {
            currentCallbacks.onTurnEnded({ inputTokens, outputTokens, conversationState: capturedState });
          } catch (e) {
            console.log(`[cursor-agent] onTurnEnded threw: ${e.message}`);
          }
        }
      }

      return;
    }

    if (msg.conversationCheckpointUpdate) {
      const cp = msg.conversationCheckpointUpdate;
      // Field name varies by server version; try the obvious ones.
      const b64 = cp.state || cp.checkpoint || cp.conversationState ||
        (cp.checkpointState && (cp.checkpointState.state || cp.checkpointState.bytes));
      if (b64 && typeof b64 === 'string') {
        try {
          capturedState = Buffer.from(b64, 'base64');
        } catch { /* ignore */ }
      } else if (b64 && b64.type === 'Buffer' && Array.isArray(b64.data)) {
        capturedState = Buffer.from(b64.data);
      } else {
        // Unknown shape — log key list once for debugging
        const keys = Object.keys(cp).join(',');
        console.log(`[cursor-agent] conversationCheckpointUpdate keys: ${keys}`);
      }
      return;
    }

    if (msg.interactionQuery) return;
  }

  // ── Build and send the initial runRequest ──
  const stateField = conversationState && Buffer.isBuffer(conversationState)
    ? conversationState.toString('base64')
    : (conversationState && typeof conversationState === 'string' ? conversationState : {});

  const runRequestPayload = {
    runRequest: {
      conversationState: stateField,
      action: {
        userMessageAction: {
          userMessage: { text: prompt },
        },
      },
      modelDetails: {
        modelId,
        displayName: modelId,
        displayNameShort: modelId,
      },
      requestedModel: { modelId },
      conversationId,
    },
  };
  // Also expose tools at the runRequest level (mcpTools) — some Cursor models
  // appear to need this in addition to requestContext.tools to actually call them.
  if (Array.isArray(tools) && tools.length > 0) {
    runRequestPayload.runRequest.mcpTools = { mcpTools: tools };
  }
  // Custom system prompt — primes the model and provides tool context.
  if (options.customSystemPrompt) {
    runRequestPayload.runRequest.customSystemPrompt = String(options.customSystemPrompt);
  }
  if (process.env.CURSOR_AGENT_DEBUG) {
    console.log(`[cursor-agent][debug] sending runRequest: ${JSON.stringify(runRequestPayload).slice(0, 500)}`);
  }
  writeFrame(runRequestPayload);
  if (process.env.CURSOR_AGENT_DEBUG) {
    console.log(`[cursor-agent][debug] runRequest sent`);
  }

  return {
    conversationId,
    sendToolResult,
    setCallbacks,
    close,
  };
}

// Returned when initial connect fails so callers don't NPE on .close().
function makeDeadBridge(conversationId) {
  return {
    conversationId,
    sendToolResult: () => {},
    setCallbacks: () => {},
    close: () => {},
  };
}

module.exports = {
  startConversation,
  decodeMcpArgs,
  encodeValue,
  decodeValueBytes,
  deterministicConversationId,
  encodeFrame,
  buildHeaders,
};
