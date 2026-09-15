// ═══════════════════════════════════════════════
//  CursorIDE2API - Cursor API 客户端
//  基于 agent.v1.AgentService/Run BiDi 协议
// ═══════════════════════════════════════════════

const http2 = require('http2');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

// ── Checksum 生成 ──
function generateChecksum(machineId, macMachineId) {
  let k = 165;
  const t = Math.floor(Date.now() / 1e6);
  const b = new Uint8Array([
    (t >> 40) & 255, (t >> 32) & 255, (t >> 24) & 255,
    (t >> 16) & 255, (t >> 8) & 255, t & 255,
  ]);
  for (let i = 0; i < b.length; i++) {
    b[i] = ((b[i] ^ k) + (i % 256)) & 0xFF;
    k = b[i];
  }
  const prefix = Buffer.from(b).toString('base64');
  return macMachineId ? `${prefix}${machineId}/${macMachineId}` : `${prefix}${machineId}`;
}

// ── Envelope 帧编码 ──
function encodeFrame(obj) {
  const jsonBuf = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = Buffer.alloc(5 + jsonBuf.length);
  frame[0] = 0;
  frame.writeUInt32BE(jsonBuf.length, 1);
  jsonBuf.copy(frame, 5);
  return frame;
}

// Cache the timezone string at module load — Intl.DateTimeFormat() does
// non-trivial work and the answer never changes mid-process.
const _cursorTimezone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
})();

// ── 构建请求头 ──
function buildHeaders(token) {
  return {
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    'content-type': 'application/connect+json',
    'connect-protocol-version': '1',
    'authorization': `Bearer ${token.accessToken}`,
    'x-cursor-checksum': generateChecksum(token.machineId || '', token.macMachineId || ''),
    'x-cursor-client-version': config.cursor.clientVersion,
    'x-cursor-timezone': _cursorTimezone,
    'x-request-id': uuidv4(),
  };
}

// ── 处理 ExecServerMessage ──
function handleExecMessage(exec, writeFrame) {
  const { id = 0, execId = '' } = exec;

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
            },
          },
        },
      },
    });
    return 'requestContext';
  }

  if (exec.readArgs) {
    writeFrame({ execClientMessage: { id, execId, readResult: { fileNotFound: {} } } });
    return 'read';
  }

  if (exec.lsArgs) {
    writeFrame({ execClientMessage: { id, execId, lsResult: { error: { path: '', error: 'Headless mode' } } } });
    return 'ls';
  }

  if (exec.shellArgs) {
    writeFrame({ execClientMessage: { id, execId, shellResult: { rejected: { reason: 'Headless mode' } } } });
    return 'shell';
  }

  if (exec.grepArgs) {
    writeFrame({ execClientMessage: { id, execId, grepResult: { error: { error: 'Headless mode' } } } });
    return 'grep';
  }

  if (exec.writeArgs) {
    writeFrame({ execClientMessage: { id, execId, writeResult: {} } });
    return 'write';
  }

  if (exec.deleteArgs) {
    writeFrame({ execClientMessage: { id, execId, deleteResult: { error: { path: '', error: 'Headless mode' } } } });
    return 'delete';
  }

  if (exec.diagnosticsArgs) {
    writeFrame({ execClientMessage: { id, execId, diagnosticsResult: { diagnostics: [] } } });
    return 'diagnostics';
  }

  // Unknown exec type
  writeFrame({ execClientMessage: { id, execId, requestContextResult: { error: { error: 'Unknown exec type' } } } });
  return 'unknown';
}

/**
 * 调用 Cursor AgentService.Run
 * 
 * @param {Object} token - { accessToken, machineId, macMachineId }
 * @param {string} prompt - 用户消息
 * @param {string} modelId - 模型 ID
 * @param {Object} options - { conversationId, stream, onDelta, onThinking, signal }
 * @returns {Promise<{ text, inputTokens, outputTokens, thinkingMs, error }>}
 */
function chat(token, prompt, modelId, options = {}) {
  const {
    conversationId = uuidv4(),
    stream = false,
    onDelta = null,        // (text) => void
    onThinking = null,     // (text) => void
    signal = null,         // AbortSignal
  } = options;

  return new Promise((resolve, reject) => {
    let client;
    try {
      client = http2.connect(config.cursor.baseUrl);
    } catch (e) {
      return reject(new Error(`Connection failed: ${e.message}`));
    }

    client.on('error', (e) => {
      // Suppress unhandled errors after cleanup
    });

    const req = client.request(buildHeaders(token));
    req.setTimeout(config.cursor.requestTimeout);

    let fullText = '';
    let thinkingText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let thinkingMs = 0;
    let buffer = Buffer.alloc(0);
    let done = false;
    let errorMsg = '';

    // 写帧辅助
    const writeFrameFn = (obj) => {
      try { req.write(encodeFrame(obj)); } catch {}
    };

    // 心跳
    const heartbeat = setInterval(() => {
      writeFrameFn({ clientHeartbeat: {} });
    }, config.cursor.heartbeatInterval);

    // 取消信号
    if (signal) {
      signal.addEventListener('abort', () => {
        cleanup();
        reject(new Error('Request aborted'));
      }, { once: true });
    }

    function cleanup() {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      try { req.end(); } catch {}
      setTimeout(() => {
        try { req.close(); } catch {}
        try { client.close(); } catch {}
      }, 200);
    }

    function finish() {
      cleanup();
      if (errorMsg) {
        resolve({ text: fullText, inputTokens, outputTokens, thinkingMs, error: errorMsg });
      } else {
        resolve({ text: fullText, inputTokens, outputTokens, thinkingMs, error: null });
      }
    }

    req.on('data', (chunk) => {
      // Hot path: only concat when there's a leftover partial frame from the
      // previous chunk. Keeps frame parsing O(n) instead of O(n²) on long
      // streams that arrive mostly aligned.
      const work = (buffer.length > 0) ? Buffer.concat([buffer, chunk]) : chunk;

      let offset = 0;
      while (offset + 5 <= work.length) {
        const len = work.readUInt32BE(offset + 1);
        if (offset + 5 + len > work.length) break;
        const s = work.slice(offset + 5, offset + 5 + len).toString('utf8');
        offset += 5 + len;

        try {
          const msg = JSON.parse(s);

          // 错误
          if (msg.error) {
            let detail = '';
            if (msg.error.details?.[0]?.value) {
              try { detail = Buffer.from(msg.error.details[0].value, 'base64').toString('utf8'); } catch {}
            }
            errorMsg = detail || msg.error.message || msg.error.code || 'Unknown error';
            finish();
            return;
          }

          // ExecServerMessage
          if (msg.execServerMessage) {
            handleExecMessage(msg.execServerMessage, writeFrameFn);
            continue;
          }

          // KV (忽略, 不需要处理)
          if (msg.kvServerMessage) continue;

          // InteractionUpdate
          if (msg.interactionUpdate) {
            const iu = msg.interactionUpdate;

            // 心跳
            if (iu.heartbeat !== undefined) continue;

            // 文本增量
            if (iu.textDelta) {
              const t = typeof iu.textDelta === 'string' ? iu.textDelta : (iu.textDelta.text || iu.textDelta.delta || '');
              if (t) {
                fullText += t;
                if (onDelta) onDelta(t);
              }
              continue;
            }

            // 思考增量
            if (iu.thinkingDelta) {
              const t = iu.thinkingDelta.text || iu.thinkingDelta.delta || '';
              if (t && onThinking) {
                thinkingText += t;
                onThinking(t);
              }
              continue;
            }

            // 思考完成
            if (iu.thinkingCompleted) {
              thinkingMs = iu.thinkingCompleted.thinkingDurationMs || 0;
              continue;
            }

            // 回合结束
            if (iu.turnEnded) {
              inputTokens = parseInt(iu.turnEnded.inputTokens || '0');
              outputTokens = parseInt(iu.turnEnded.outputTokens || '0');
              finish();
              return;
            }

            // Token 增量
            if (iu.tokenDelta) continue;
            if (iu.stepCompleted) continue;

            // message 嵌套的情况
            const m = iu.message;
            if (m) {
              if (m.textDelta) {
                const t = typeof m.textDelta === 'string' ? m.textDelta : (m.textDelta.text || m.textDelta.delta || '');
                if (t) { fullText += t; if (onDelta) onDelta(t); }
              }
              if (m.turnEnded) {
                inputTokens = parseInt(m.turnEnded.inputTokens || '0');
                outputTokens = parseInt(m.turnEnded.outputTokens || '0');
                finish();
                return;
              }
              if (m.thinkingCompleted) {
                thinkingMs = m.thinkingCompleted.thinkingDurationMs || 0;
              }
            }

            continue;
          }

          // Checkpoint, InteractionQuery 等忽略
          if (msg.conversationCheckpointUpdate) continue;
          if (msg.interactionQuery) continue;

        } catch {}
      }
      // If we consumed all bytes, drop the carry buffer (zero-copy reset).
      // Otherwise, keep only the trailing partial-frame bytes.
      buffer = (offset < work.length) ? work.slice(offset) : Buffer.alloc(0);
    });

    req.on('end', finish);
    req.on('error', (e) => { errorMsg = e.message; finish(); });
    req.on('timeout', () => { errorMsg = 'Request timeout'; finish(); });

    // ━━━ 发送 runRequest ━━━
    writeFrameFn({
      runRequest: {
        conversationState: {},
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
    });
  });
}

/**
 * 获取可用模型列表
 */
function getModels(token) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(config.cursor.baseUrl);
    client.on('error', () => {});
    const req = client.request({
      ':method': 'POST',
      ':path': '/agent.v1.AgentService/GetUsableModels',
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      'authorization': `Bearer ${token.accessToken}`,
      'x-cursor-checksum': generateChecksum(token.machineId || '', token.macMachineId || ''),
      'x-cursor-client-version': config.cursor.clientVersion,
      'x-request-id': uuidv4(),
    });
    req.setTimeout(15000);
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      client.close();
      try { resolve(JSON.parse(body)); } catch { resolve({ models: [] }); }
    });
    req.on('error', e => { client.close(); reject(e); });
    req.on('timeout', () => { req.close(); client.close(); reject(new Error('Timeout')); });
    req.write(JSON.stringify({}));
    req.end();
  });
}

/**
 * 健康检查 (通过 GetUsableModels)
 */
async function healthCheck(token) {
  try {
    const result = await getModels(token);
    return { ok: true, models: result.models?.length || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { chat, getModels, healthCheck, generateChecksum };
