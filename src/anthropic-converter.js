// ═══════════════════════════════════════════════
//  CursorIDE2API - Anthropic ↔ Cursor 格式转换
// ═══════════════════════════════════════════════

const { v4: uuidv4 } = require('uuid');

/**
 * Anthropic messages → Cursor 单一 prompt
 * 将 Anthropic 格式的 messages + system 拼接为 Cursor 需要的单一文本.
 *
 * Cursor's `agent.v1.AgentService/Run` accepts a single user-message text
 * field per runRequest, so we have to flatten the entire Anthropic
 * `messages` array into one string. To preserve the conversational
 * structure the model relies on, we wrap each turn with explicit role
 * tags (`<system>`, `<user>`, `<assistant>`) and mark the last user
 * message specifically. Without `latest="true"`, on long sessions
 * (thousands of tool_results accumulated) the model treats the latest
 * "do something different now" instruction as just more history text
 * and continues the prior plan instead of pivoting.
 */
function anthropicMessagesToPrompt(messages, system) {
  if (!messages || messages.length === 0) return '';

  const parts = [];

  // 处理 system prompt
  if (system) {
    let systemText = '';
    if (typeof system === 'string') {
      systemText = system;
    } else if (Array.isArray(system)) {
      systemText = system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
    if (systemText) {
      parts.push(`<system>\n${systemText}\n</system>`);
    }
  }

  // Find the index of the latest user message so we can tag it as the
  // "current turn". This is the most important signal on long histories
  // — without it, every <user> tag looks the same and the model has no
  // structural cue for "what the user just asked."
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && (m.role || 'user') === 'user') { lastUserIdx = i; break; }
  }

  // 处理 messages
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role || 'user';
    let content = '';

    // Track whether this user message has any actual user-typed content
    // (text/image) vs. being purely tool_results. A pure-tool_result user
    // message is the proxy reconstructing a continuation after a cache
    // miss — there's no "new user instruction" to pivot on, just data
    // the model needs to continue with.
    let userHasOriginalContent = false;
    if (typeof msg.content === 'string') {
      content = msg.content;
      if (role === 'user' && msg.content.trim()) userHasOriginalContent = true;
    } else if (Array.isArray(msg.content)) {
      const segments = [];
      for (const b of msg.content) {
        if (!b || !b.type) continue;
        if (b.type === 'text') {
          if (b.text) {
            segments.push(b.text);
            if (role === 'user') userHasOriginalContent = true;
          }
        } else if (b.type === 'tool_use') {
          let argStr = '';
          try {
            argStr = JSON.stringify(b.input || {});
          } catch (_) {
            argStr = '{}';
          }
          segments.push(`[Tool call: ${b.name || ''}(${argStr})]`);
        } else if (b.type === 'tool_result') {
          let resultText = '';
          if (typeof b.content === 'string') {
            resultText = b.content;
          } else if (Array.isArray(b.content)) {
            resultText = b.content
              .filter(c => c && c.type === 'text')
              .map(c => c.text)
              .join('\n');
          }
          segments.push(`[Tool result for ${b.tool_use_id || ''}]:\n${resultText}`);
        } else if (b.type === 'image') {
          segments.push('[image]');
          if (role === 'user') userHasOriginalContent = true;
        }
      }
      content = segments.join('\n');
    }

    if (!content) continue;

    if (role === 'assistant') {
      parts.push(`<assistant>\n${content}\n</assistant>`);
    } else if (role === 'user') {
      // Tag every user turn so the model can see role boundaries; mark
      // the latest one so it doesn't drown in 1000+ messages of history.
      if (i === lastUserIdx) {
        parts.push(_wrapLatestUser(content, messages.length, userHasOriginalContent));
      } else {
        parts.push(`<user>\n${content}\n</user>`);
      }
    } else {
      parts.push(content);
    }
  }

  return parts.join('\n\n');
}

// Threshold above which we add an explicit pivot directive inside the
// latest-user wrapper. On short conversations the structural tag is
// enough; on long ones (~50+ messages, common in agentic sessions),
// model attention gets dominated by accumulated tool_results and
// plan-state, and a brief "do handover" instruction at the end is
// frequently ignored. The directive coaches the model to treat the
// content as a fresh ask rather than continuation context.
const LONG_HISTORY_THRESHOLD = (() => {
  const raw = process.env.LATEST_USER_FRAMING_THRESHOLD;
  if (raw == null || raw === '') return 50;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
})();

// Patterns that indicate the user explicitly interrupted or is pivoting
// hard. When present, strengthen even on short histories.
const INTERRUPT_PATTERN = /\[Request interrupted by user\]/i;
const PIVOT_KEYWORDS = /\b(stop|halt|abort|cancel|instead|nevermind|never mind|actually do|forget (that|the|previous)|switch to|do .{0,20} instead|change of plans|new plan|forget everything|start over)\b/i;

function _wrapLatestUser(content, totalMessages, hasOriginalUserContent) {
  // Don't add the ATTENTION directive when the latest user message is
  // PURELY tool_results (no user-typed text/image). That happens on
  // cache-miss continuation rebuilds — we'd be telling the model "do NOT
  // auto-continue the prior plan" exactly when continuing IS the correct
  // response. Mixed signal trains the model in-context that the directive
  // is noise. Only trigger when there's actual new user content to
  // anchor on.
  if (!hasOriginalUserContent) {
    return `<user latest="true">\n${content}\n</user>`;
  }

  const isInterrupt = INTERRUPT_PATTERN.test(content);
  const isPivot = PIVOT_KEYWORDS.test(content);
  const isLong = totalMessages >= LONG_HISTORY_THRESHOLD;
  const needsDirective = isInterrupt || isPivot || isLong;

  if (!needsDirective) {
    return `<user latest="true">\n${content}\n</user>`;
  }

  // Short, semantic directive. Kept terse to minimize the chance the
  // model quotes it back or treats it as part of the user's content.
  // The double-rule ("CURRENT TURN" + "high priority") + the explicit
  // anti-stickiness clause is the combination that overcomes long-
  // history task anchoring.
  const flavor = isInterrupt
    ? 'The user has interrupted the prior plan. The message below is the new directive.'
    : isPivot
      ? 'The message below appears to redirect or override the prior plan.'
      : 'The conversation above is history; the message below is the user\'s active request.';

  return (
    `<user latest="true">\n` +
    `[ATTENTION — CURRENT USER TURN. ${flavor} Respond directly to it; do NOT auto-continue the prior plan unless the user explicitly asks you to.]\n\n` +
    `${content}\n` +
    `</user>`
  );
}

/**
 * 映射模型名称: Anthropic → Cursor
 */
function mapAnthropicModel(model, configMapping) {
  if (!model) return null;

  if (configMapping) {
    const mapped = configMapping[model];
    if (mapped) return mapped;
  }

  // 直通 (未知模型原样传递)
  return model;
}

// Effort levels supported by Cursor's per-model variants. Sorted longest-first
// so the regex-based suffix strip matches `xhigh` before `high`.
const EFFORT_LEVELS = ['xhigh', 'medium', 'high', 'low', 'max'];
const EFFORT_REGEX = new RegExp(`-(${EFFORT_LEVELS.sort((a,b)=>b.length-a.length).join('|')})$`);

/**
 * Apply per-request overrides to a Cursor model name based on Anthropic
 * request body fields:
 *   - body.output_config.effort   ∈ {low,medium,high,xhigh,max}  (claude-code's --effort)
 *   - body.thinking.type          ∈ {adaptive,enabled,disabled}  (claude-code's extended-thinking signal)
 *
 * Without this hook, every `claude-opus-4-7` request gets the static
 * `claude-opus-4-7-thinking-max` mapping regardless of the user's --effort.
 *
 * Strategy: detect known model families that have full effort/thinking
 * variant suites and rebuild the suffix; for families with restricted
 * variants (Sonnet 4.6 only has -medium and -medium-thinking) toggle
 * just the thinking segment; for unknown families, leave alone.
 *
 * Returns the (possibly adjusted) cursor model name.
 */
function applyModelOverrides(cursorModel, opts = {}) {
  if (!cursorModel) return cursorModel;
  const { effort, thinkingType } = opts;

  // thinkingType semantics — default to thinking ON. Cursor's `-thinking-`
  // variants are strictly more capable (model still skips trivial reasoning
  // when not needed), and claude-code never sends `disabled` from the CLI
  // anyway, so this is the most useful default. Explicit opt-out paths:
  //   body.thinking.type === 'disabled' / 'none'      → off
  //   CURSOR_FORCE_THINKING=off|disabled|false|0     → off (env, wins over body)
  let wantThinking;
  if (thinkingType === 'disabled' || thinkingType === 'none') {
    wantThinking = false;
  } else {
    wantThinking = true;
  }

  const wantEffort = effort && EFFORT_LEVELS.includes(effort) ? effort : null;

  // Family: claude-opus-4-7 — full grid (5 effort × 2 thinking).
  if (/^claude-opus-4-7(?:-thinking)?(?:-(?:low|medium|high|xhigh|max))?$/.test(cursorModel)) {
    const e = wantEffort || 'max';
    return wantThinking ? `claude-opus-4-7-thinking-${e}` : `claude-opus-4-7-${e}`;
  }

  // Family: claude-4.6-opus-{high,max-thinking,high-thinking} — known to exist.
  if (/^claude-4\.6-opus(?:-high|-max)?(?:-thinking)?$/.test(cursorModel)) {
    // Only -high and -max-thinking are documented; preserve unless explicitly set.
    if (wantEffort === 'max' && wantThinking) return 'claude-4.6-opus-max-thinking';
    if (wantThinking) return 'claude-4.6-opus-high-thinking';
    return 'claude-4.6-opus-high';
  }

  // Family: claude-4.6-sonnet-medium — only thinking on/off available.
  if (/^claude-4\.6-sonnet-medium(?:-thinking)?$/.test(cursorModel)) {
    return wantThinking ? 'claude-4.6-sonnet-medium-thinking' : 'claude-4.6-sonnet-medium';
  }

  // Family: claude-4.5-sonnet[-thinking]
  if (/^claude-4\.5-sonnet(?:-thinking)?$/.test(cursorModel)) {
    return wantThinking ? 'claude-4.5-sonnet-thinking' : 'claude-4.5-sonnet';
  }

  // Family: claude-4.5-opus-high[-thinking]
  if (/^claude-4\.5-opus-high(?:-thinking)?$/.test(cursorModel)) {
    return wantThinking ? 'claude-4.5-opus-high-thinking' : 'claude-4.5-opus-high';
  }

  // Family: claude-4-sonnet[-thinking]
  if (/^claude-4-sonnet(?:-thinking)?$/.test(cursorModel)) {
    return wantThinking ? 'claude-4-sonnet-thinking' : 'claude-4-sonnet';
  }

  // Unknown family — don't touch, just pass through.
  return cursorModel;
}

/**
 * Extract the override signals from an Anthropic /v1/messages body.
 * Returns `{ effort, thinkingType }` (either may be undefined).
 *
 * Precedence:
 *   CURSOR_FORCE_EFFORT     (env)        — overrides body
 *   CURSOR_FORCE_THINKING   (env)        — overrides body
 *   body.output_config.effort           — claude-code's --effort
 *   body.thinking.type                  — Anthropic API thinking signal
 */
function extractModelOverrides(body) {
  const out = {};
  if (body && typeof body === 'object') {
    // claude-code stores --effort under `output_config.effort`.
    if (body.output_config && typeof body.output_config.effort === 'string') {
      out.effort = body.output_config.effort.toLowerCase();
    }
    // Anthropic API: `thinking: { type: 'adaptive'|'enabled'|'disabled', budget_tokens?: N }`.
    if (body.thinking && typeof body.thinking === 'object' && typeof body.thinking.type === 'string') {
      out.thinkingType = body.thinking.type.toLowerCase();
    }
  }

  // Env overrides win over body. Useful for "always max" or "never thinking"
  // policies independent of the client.
  const envEffort = (process.env.CURSOR_FORCE_EFFORT || '').toLowerCase().trim();
  if (envEffort) out.effort = envEffort;
  const envThinking = (process.env.CURSOR_FORCE_THINKING || '').toLowerCase().trim();
  if (envThinking === 'on' || envThinking === 'enabled' || envThinking === 'true' || envThinking === '1') {
    out.thinkingType = 'enabled';
  } else if (envThinking === 'off' || envThinking === 'disabled' || envThinking === 'false' || envThinking === '0') {
    out.thinkingType = 'disabled';
  } else if (envThinking === 'adaptive' || envThinking === 'auto') {
    out.thinkingType = 'adaptive';
  }
  return out;
}

/**
 * 构建非流式 Anthropic 响应
 *
 * options:
 *   - stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn'
 *   - toolUses: [{ id, name, input }, ...]
 */
function buildAnthropicResponse(text, model, inputTokens, outputTokens, options = {}) {
  const { stopReason = 'end_turn', toolUses = [] } = options;

  const content = [];
  if (text) {
    content.push({ type: 'text', text: text });
  }
  for (const tu of toolUses) {
    content.push({
      type: 'tool_use',
      id: tu.id,
      name: tu.name,
      input: tu.input,
    });
  }

  return {
    id: `msg_${uuidv4()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens || 0,
      output_tokens: outputTokens || 0,
    },
  };
}

/**
 * 构建 Anthropic 错误响应
 */
function buildAnthropicErrorResponse(message, type = 'api_error', statusCode = 500) {
  return {
    type: 'error',
    error: {
      type: type,
      message: message,
    },
  };
}

// ─── SSE 流式辅助 ───────────────────────────────

/**
 * 格式化 Anthropic SSE 事件
 * Anthropic 格式: event: <type>\ndata: <json>\n\n
 */
function formatSSE(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * message_start 事件
 */
function buildMessageStart(model, inputTokens) {
  return formatSSE('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${uuidv4()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: 0,
      },
    },
  });
}

/**
 * content_block_start 事件
 */
function buildContentBlockStart(index) {
  return formatSSE('content_block_start', {
    type: 'content_block_start',
    index: index,
    content_block: { type: 'text', text: '' },
  });
}

/**
 * content_block_delta 事件
 */
function buildContentBlockDelta(index, text) {
  return formatSSE('content_block_delta', {
    type: 'content_block_delta',
    index: index,
    delta: { type: 'text_delta', text: text },
  });
}

/**
 * content_block_start 事件 (tool_use)
 */
function buildContentBlockStartToolUse(index, toolUseId, toolName) {
  return formatSSE('content_block_start', {
    type: 'content_block_start',
    index: index,
    content_block: {
      type: 'tool_use',
      id: toolUseId,
      name: toolName,
      input: {},
    },
  });
}

/**
 * content_block_delta 事件 (tool_use input — 增量 JSON)
 */
function buildContentBlockDeltaInputJson(index, partialJson) {
  return formatSSE('content_block_delta', {
    type: 'content_block_delta',
    index: index,
    delta: {
      type: 'input_json_delta',
      partial_json: partialJson,
    },
  });
}

/**
 * content_block_start 事件 (thinking)
 */
function buildContentBlockStartThinking(index) {
  return formatSSE('content_block_start', {
    type: 'content_block_start',
    index: index,
    content_block: { type: 'thinking', thinking: '' },
  });
}

/**
 * content_block_delta 事件 (thinking)
 */
function buildContentBlockDeltaThinking(index, text) {
  return formatSSE('content_block_delta', {
    type: 'content_block_delta',
    index: index,
    delta: { type: 'thinking_delta', thinking: text },
  });
}

/**
 * content_block_stop 事件
 */
function buildContentBlockStop(index) {
  return formatSSE('content_block_stop', {
    type: 'content_block_stop',
    index: index,
  });
}

/**
 * message_delta 事件
 */
function buildMessageDelta(stopReason, outputTokens) {
  return formatSSE('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason || 'end_turn',
      stop_sequence: null,
    },
    usage: {
      output_tokens: outputTokens || 0,
    },
  });
}

/**
 * message_stop 事件
 */
function buildMessageStop() {
  return formatSSE('message_stop', {
    type: 'message_stop',
  });
}

/**
 * ping 事件
 */
function buildPing() {
  return formatSSE('ping', {
    type: 'ping',
  });
}

module.exports = {
  anthropicMessagesToPrompt, mapAnthropicModel,
  applyModelOverrides, extractModelOverrides,
  buildAnthropicResponse, buildAnthropicErrorResponse,
  formatSSE,
  buildMessageStart, buildContentBlockStart, buildContentBlockDelta,
  buildContentBlockStartToolUse, buildContentBlockDeltaInputJson,
  buildContentBlockStartThinking, buildContentBlockDeltaThinking,
  buildContentBlockStop, buildMessageDelta, buildMessageStop, buildPing,
};
