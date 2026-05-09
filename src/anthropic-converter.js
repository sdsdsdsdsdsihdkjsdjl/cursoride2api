// ═══════════════════════════════════════════════
//  CursorIDE2API - Anthropic ↔ Cursor 格式转换
// ═══════════════════════════════════════════════

const { v4: uuidv4 } = require('uuid');

/**
 * Parse a Bash command string for common file-write idioms and return
 * the writes detected. Used by the file-state simulator so the model
 * gets a recent-attention echo of files written via Bash, just like it
 * does for the structured Write/Edit tools.
 *
 * Handles:
 *   - Heredoc with redirect:    cat > FILE <<TAG ... TAG
 *                                cat >> FILE <<'TAG' ... TAG     (append)
 *                                tee FILE <<TAG ... TAG
 *                                tee -a FILE <<TAG ... TAG       (append)
 *   - Echo with redirect:       echo "..." > FILE
 *                                echo "..." >> FILE              (append)
 *                                printf "..." > FILE
 *
 * Doesn't try to handle every shell idiom — sed -i, awk redirects, command
 * substitution, etc. Catches the dominant patterns we observe in the wild;
 * unknown ones just don't get echoed and the model falls back to
 * re-reading.
 *
 * Returns array of { file_path, content, append }.
 */
function _extractBashFileWrites(command) {
  if (typeof command !== 'string' || !command.includes('\n') && !/[<>]/.test(command)) return [];
  const writes = [];
  const lines = command.split('\n');

  // Heredoc detection — line that opens with `cat`/`tee` and ends with <<TAG
  // (TAG can be quoted with ' or " to disable expansion). We accept either
  // ordering: `cat > FILE <<TAG` or `tee -a FILE <<TAG` or `> FILE cat <<TAG`.
  const heredocOpen =
    /^\s*(cat|tee)\b(?:\s+(-a))?\s+(?:>>?\s*)?(\S+)?\s*(?:>>?\s*(\S+))?\s*<<\s*['"]?(\w+)['"]?\s*$/;

  // Echo/printf one-line redirect.
  const echoRedirect =
    /^\s*(echo|printf)(?:\s+-[neE]+)?\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s+(>>?)\s+(\S+)\s*$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Try heredoc first (multi-line)
    const hm = line.match(heredocOpen);
    if (hm) {
      const cmd = hm[1];
      const teeAppend = hm[2] === '-a';
      // The redirect target may be in capture 3 or 4 depending on the
      // ordering; the first non-empty wins, with `tee FILE` (no >) also
      // valid.
      const filePath = hm[3] || hm[4] || '';
      const tag = hm[5];
      // Detect append redirect (>>) — was the redirect operator >>? We
      // need to re-scan the original line to know.
      const append = teeAppend || /\s>>\s/.test(line);
      if (filePath && tag) {
        // Read content lines until a line equal to the closing tag.
        const contentLines = [];
        let j = i + 1;
        while (j < lines.length && lines[j].trim() !== tag) {
          contentLines.push(lines[j]);
          j++;
        }
        if (j < lines.length) {
          // Found closing tag — record the write
          writes.push({ file_path: filePath, content: contentLines.join('\n'), append });
          i = j + 1;
          continue;
        }
        // No closing tag found — malformed; bail on this match
      }
    }

    // Try echo/printf redirect (single-line)
    const em = line.match(echoRedirect);
    if (em) {
      const tool = em[1];
      const quoted = em[2];
      const op = em[3]; // > or >>
      const filePath = em[4];
      const append = op === '>>';
      // Strip outer quote char and unescape \" / \' / \\
      let payload;
      if (quoted.startsWith('"')) {
        payload = quoted.slice(1, -1).replace(/\\(["\\nrtbf])/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] || c);
      } else {
        payload = quoted.slice(1, -1).replace(/\\(['\\])/g, (m, c) => c);
      }
      // echo (without -n) appends a newline; printf does not by default.
      if (tool === 'echo') payload = payload + '\n';
      writes.push({ file_path: filePath, content: payload, append });
      i++;
      continue;
    }

    i++;
  }
  return writes;
}

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

  // ───────────────────────────────────────────────────────────────────
  // File-state echo: simulate Write/Edit/MultiEdit/Read effects forward
  // through the message history, then attach each file's CURRENT content
  // to the tool_result that was its most recent touch. The model gets
  // exactly one cheap-to-attend recent location per file holding the
  // believed current state. Without this, on long sessions the model
  // re-reads files it just wrote/edited because its own tool_use args
  // (the actual content) are buried far back in attention.
  //
  // Earlier touches of the same file get a brief diff/note instead of
  // the full content, so we don't bloat the prompt with N copies of
  // every file.
  //
  // Env knobs:
  //   ECHO_WRITE_CONTENT=0          — disable entirely (default: on)
  //   ECHO_WRITE_CONTENT_MAX_BYTES  — per-file cap (default: 8192)
  // ───────────────────────────────────────────────────────────────────
  const echoWriteContent = (process.env.ECHO_WRITE_CONTENT || '1') !== '0';
  const echoMaxBytes = (() => {
    const raw = process.env.ECHO_WRITE_CONTENT_MAX_BYTES;
    if (raw == null || raw === '') return 8192;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 8192;
  })();

  // toolUseId → { name, input, file_path?, contentAfter? }
  const toolUseInfoById = new Map();
  // file_path → tool_use_id of the LAST tool_result that touched it (so
  // we know which tool_result gets the full-state echo)
  const lastTouchByFile = new Map();
  // tool_use_id → string content of file AFTER this op (post-state).
  // Used for Write/Edit/MultiEdit/Read (single file per call).
  const fileStateAfterTool = new Map();
  // tool_use_id → Map<file_path, content>. Used for Bash, which may
  // write multiple files in one call (multiple heredocs / redirects).
  // Keys are file_paths; values are believed contents AFTER the Bash
  // operation completes. Echo logic treats each file independently
  // when deciding "is this the latest touch?" and what to emit.
  const bashFileStates = new Map();

  if (echoWriteContent) {
    // Pre-pass 1: index every tool_use by id, and walk forward simulating
    // file ops to compute the post-state content per tool. This requires
    // both assistant tool_use blocks AND user tool_result blocks for Read
    // (since Read's content is in the result, not the input).
    const fileStateNow = new Map(); // file_path → believed current content

    for (const m of messages) {
      if (!m) continue;
      const role = m.role || 'user';
      if (role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || b.type !== 'tool_use' || !b.id) continue;
          const name = b.name || '';
          const input = b.input || {};
          const filePath = input.file_path || input.path || '';
          const info = { name, input, file_path: filePath };
          toolUseInfoById.set(b.id, info);

          if ((name === 'Write' || name === 'mcp_Write') && filePath) {
            const c = typeof input.content === 'string' ? input.content : '';
            fileStateNow.set(filePath, c);
            fileStateAfterTool.set(b.id, c);
            lastTouchByFile.set(filePath, b.id);
          } else if ((name === 'Edit' || name === 'mcp_Edit') && filePath) {
            const cur = fileStateNow.get(filePath);
            const oldS = input.old_string;
            const newS = input.new_string;
            if (typeof cur === 'string' && typeof oldS === 'string' && typeof newS === 'string') {
              const idx = cur.indexOf(oldS);
              if (idx >= 0 || input.replace_all) {
                // Apply succeeded — record post-state.
                let next;
                if (input.replace_all) {
                  next = cur.split(oldS).join(newS);
                } else {
                  next = cur.slice(0, idx) + newS + cur.slice(idx + oldS.length);
                }
                fileStateNow.set(filePath, next);
                fileStateAfterTool.set(b.id, next);
              } else {
                // old_string not in our cached state. The Edit may have
                // succeeded on the actual file (claude-code matched the
                // real content), but our cache is now wrong. Drop our
                // belief about this file rather than echo stale content
                // that misleads the model into a re-read.
                fileStateNow.delete(filePath);
                // Don't set fileStateAfterTool — echo will fall back to
                // the diff-only "[You edited X: replaced Y → Z]" form,
                // which is honest about not knowing the full state.
              }
            }
            // else: types missing or cur unknown — fall through; echo logic
            // handles the diff-only fallback when fileStateAfterTool is unset.
            lastTouchByFile.set(filePath, b.id);
          } else if ((name === 'MultiEdit' || name === 'mcp_MultiEdit') && filePath) {
            let cur = fileStateNow.get(filePath);
            let allApplied = true;
            if (typeof cur === 'string' && Array.isArray(input.edits)) {
              for (const e of input.edits) {
                if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue;
                if (e.replace_all) {
                  cur = cur.split(e.old_string).join(e.new_string);
                } else {
                  const idx = cur.indexOf(e.old_string);
                  if (idx >= 0) {
                    cur = cur.slice(0, idx) + e.new_string + cur.slice(idx + e.old_string.length);
                  } else {
                    // One of the edits couldn't be applied — our state
                    // is now out of sync with reality. Bail.
                    allApplied = false;
                    break;
                  }
                }
              }
              if (allApplied) {
                fileStateNow.set(filePath, cur);
                fileStateAfterTool.set(b.id, cur);
              } else {
                // Same reasoning as Edit: drop the cached belief rather
                // than echo stale content.
                fileStateNow.delete(filePath);
              }
            }
            lastTouchByFile.set(filePath, b.id);
          } else if ((name === 'Read' || name === 'mcp_Read') && filePath) {
            // Defer to user-message pass (Read's content lives in the result)
            // We still mark the last touch — the result will populate state.
            lastTouchByFile.set(filePath, b.id);
          } else if (name === 'Bash' || name === 'mcp_Bash') {
            // Bash file-write idioms — heredoc + redirect, echo > FILE,
            // tee > FILE, etc. Parse the command body and update file
            // state for any writes detected. A single Bash call can
            // write multiple files (multiple heredocs in one script),
            // so we maintain a per-file map keyed by the Bash tool_use_id.
            const cmd = typeof input.command === 'string' ? input.command : '';
            const writes = _extractBashFileWrites(cmd);
            if (writes.length > 0) {
              const perFile = new Map();
              for (const w of writes) {
                let next;
                if (w.append) {
                  const prior = fileStateNow.get(w.file_path) || '';
                  next = prior ? prior + (prior.endsWith('\n') ? '' : '\n') + w.content : w.content;
                } else {
                  next = w.content;
                }
                fileStateNow.set(w.file_path, next);
                perFile.set(w.file_path, next);
                lastTouchByFile.set(w.file_path, b.id);
              }
              bashFileStates.set(b.id, perFile);
            }
          }
        }
      } else if (role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
          const info = toolUseInfoById.get(b.tool_use_id);
          if (!info) continue;
          if ((info.name === 'Read' || info.name === 'mcp_Read') && info.file_path) {
            // Snapshot content from the result, stripped of any line-number
            // prefixes claude-code's Read tool injects ("  123→content").
            let raw = '';
            if (typeof b.content === 'string') raw = b.content;
            else if (Array.isArray(b.content)) {
              raw = b.content.filter(c => c?.type === 'text').map(c => c.text).join('\n');
            }
            const stripped = raw.replace(/^\s*\d+→/gm, '').replace(/^\s*\d+→/gm, '');
            fileStateNow.set(info.file_path, stripped);
            fileStateAfterTool.set(b.tool_use_id, stripped);
          }
        }
      }
    }
  }
  // Backwards-compat alias used by existing code paths below
  const toolUseInputById = toolUseInfoById;

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
          // ──────────── FILE-STATE ECHO ─────────────────────────────
          // For tool_results referring to file-touching tools (Write,
          // Edit, MultiEdit, Read), attach a recent-attention copy of
          // the file's current believed state at the LATEST touch in
          // the conversation. Earlier touches get a brief diff/note.
          // The aim: model finds each file's current state in ONE
          // recent location, no need to re-read.
          // ──────────────────────────────────────────────────────────
          let echoSuffix = '';
          if (echoWriteContent && b.tool_use_id) {
            const info = toolUseInfoById.get(b.tool_use_id);
            if (info && info.file_path) {
              const isLatestForThisFile = lastTouchByFile.get(info.file_path) === b.tool_use_id;
              const fp = info.file_path;
              const isWrite = info.name === 'Write' || info.name === 'mcp_Write';
              const isEdit = info.name === 'Edit' || info.name === 'mcp_Edit';
              const isMultiEdit = info.name === 'MultiEdit' || info.name === 'mcp_MultiEdit';
              const isRead = info.name === 'Read' || info.name === 'mcp_Read';

              if (!isLatestForThisFile && (isWrite || isEdit || isMultiEdit)) {
                // Earlier touch on a file that gets overwritten later.
                // Skip bulky content; just leave a breadcrumb pointing
                // forward to the authoritative latest tool_result.
                echoSuffix = `\n\n[Note: ${fp} was modified again later; refer to the most recent tool_result for that file for current state.]`;
              } else if (isLatestForThisFile && (isWrite || isEdit || isMultiEdit)) {
                // This is the latest touch — echo full state if computed,
                // otherwise fall back to a diff-only or content-only echo
                // depending on what we have. Order matters: prefer full
                // state, then specific tool fallbacks.
                const cur = fileStateAfterTool.get(b.tool_use_id);
                if (typeof cur === 'string' && cur.length > 0) {
                  const truncated = cur.length > echoMaxBytes
                    ? cur.slice(0, echoMaxBytes) + `\n... [truncated; full file is ${cur.length} bytes]`
                    : cur;
                  echoSuffix =
                    `\n\n[Current believed content of ${fp} (after this op) — use this directly, do NOT re-read the file:\n` +
                    '```\n' + truncated + '\n```]';
                } else if (isWrite && typeof info.input?.content === 'string') {
                  // Write with a content arg we just couldn't reach via
                  // fileStateAfterTool (rare). Echo input.content directly.
                  const c = info.input.content;
                  const truncated = c.length > echoMaxBytes
                    ? c.slice(0, echoMaxBytes) + `\n... [truncated; full file is ${c.length} bytes]`
                    : c;
                  echoSuffix =
                    `\n\n[You wrote this content to ${fp}:\n` +
                    '```\n' + truncated + '\n```]';
                } else if ((isEdit || isMultiEdit) && info.input) {
                  // State-tracking failed (old_string didn't match our
                  // cached content, etc.). Fall back to diff-only — be
                  // honest about not knowing the full file state. The
                  // model can re-read if it needs full state, but at
                  // least we don't mislead it with stale content.
                  if (isEdit && typeof info.input.old_string === 'string' && typeof info.input.new_string === 'string') {
                    const trim = (s) => (s.length > 512 ? s.slice(0, 512) + '…' : s);
                    echoSuffix =
                      `\n\n[You edited ${fp}: replaced\n` +
                      '```\n' + trim(info.input.old_string) + '\n```\n→\n```\n' + trim(info.input.new_string) + '\n```\n' +
                      `(Full post-edit file state not cached; re-read if needed.)]`;
                  } else if (isMultiEdit && Array.isArray(info.input.edits)) {
                    const lines = info.input.edits.slice(0, 3).map((e, i) => {
                      const trim = (s) => (s.length > 256 ? s.slice(0, 256) + '…' : s);
                      return `  edit ${i + 1}: ${JSON.stringify(trim(e.old_string || ''))} → ${JSON.stringify(trim(e.new_string || ''))}`;
                    });
                    const more = info.input.edits.length > 3 ? `\n  ... ${info.input.edits.length - 3} more edits` : '';
                    echoSuffix = `\n\n[You multi-edited ${fp} with ${info.input.edits.length} edits:\n${lines.join('\n')}${more}\n(Full post-edit file state not cached; re-read if needed.)]`;
                  }
                }
              }
            }
            // Bash with file writes — emit one echo block per file written.
            // For each, show full content if THIS Bash is the latest touch
            // for that file, else just a breadcrumb.
            if (info && (info.name === 'Bash' || info.name === 'mcp_Bash')) {
              const perFile = bashFileStates.get(b.tool_use_id);
              if (perFile && perFile.size > 0) {
                const echoBlocks = [];
                for (const [fp, cur] of perFile) {
                  const isLatest = lastTouchByFile.get(fp) === b.tool_use_id;
                  if (isLatest && typeof cur === 'string' && cur.length > 0) {
                    const truncated = cur.length > echoMaxBytes
                      ? cur.slice(0, echoMaxBytes) + `\n... [truncated; full file is ${cur.length} bytes]`
                      : cur;
                    echoBlocks.push(
                      `[Current believed content of ${fp} (after this Bash op wrote it) — use this directly, do NOT re-read the file:\n` +
                      '```\n' + truncated + '\n```]'
                    );
                  } else if (!isLatest) {
                    echoBlocks.push(`[Note: ${fp} was modified again later; refer to the most recent tool_result for that file for current state.]`);
                  }
                }
                if (echoBlocks.length > 0) {
                  echoSuffix = (echoSuffix || '') + '\n\n' + echoBlocks.join('\n\n');
                }
              }
            }
          }
          segments.push(`[Tool result for ${b.tool_use_id || ''}]:\n${resultText}${echoSuffix}`);
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
    // When the caller doesn't specify effort, preserve whatever the input
    // model already encodes — this matters for the `-no-thinking` path
    // where we want to flip thinking off without lowering effort. Falls
    // back to 'max' if the input is bare (e.g., raw "claude-opus-4-7").
    let e;
    if (wantEffort) {
      e = wantEffort;
    } else {
      const m = /-(low|medium|high|xhigh|max)$/.exec(cursorModel);
      e = m ? m[1] : 'max';
    }
    return wantThinking ? `claude-opus-4-7-thinking-${e}` : `claude-opus-4-7-${e}`;
  }

  // Family: claude-4.6-opus — Cursor exposes 6 variants: -high, -high-thinking,
  // -high-thinking-fast, -max, -max-thinking, -max-thinking-fast.
  // Effort dimension is binary (high|max), thinking is on/off, and there's
  // a -fast accelerator (only valid combined with thinking). We collapse
  // claude-code's 5-level effort onto the 2 levels Cursor exposes:
  // low/medium/high/xhigh → 'high'; max → 'max'. When effort isn't
  // requested, preserve the input model's effort (so `-no-thinking` on a
  // mapping-default `-max-thinking` keeps `-max`).
  if (/^claude-4\.6-opus(?:-high|-max)(?:-thinking(?:-fast)?)?$/.test(cursorModel) ||
      /^claude-4\.6-opus$/.test(cursorModel)) {
    let effortAxis;
    if (wantEffort) {
      effortAxis = wantEffort === 'max' ? 'max' : 'high';
    } else {
      const m = /^claude-4\.6-opus-(high|max)/.exec(cursorModel);
      effortAxis = m ? m[1] : 'high';
    }
    if (wantThinking) {
      // Preserve -fast suffix from the input model if present (caller opted in).
      const isFast = /-fast$/.test(cursorModel);
      return `claude-4.6-opus-${effortAxis}-thinking${isFast ? '-fast' : ''}`;
    }
    return `claude-4.6-opus-${effortAxis}`;
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
// Marker suffix on body.model for client-side opt-out of thinking. claude-code's
// CLI doesn't have a --no-thinking flag, but it does pass arbitrary --model
// strings through verbatim, so we use the model name itself as the channel.
//
//   --model claude-opus-4-7-no-thinking         → thinking forced off, effort=max
//   --model claude-opus-4-7-no-thinking --effort low   → thinking off, effort=low
//
// Accepts both `-no-thinking` and `-nothinking` for typo tolerance. The stripped
// base name is what gets handed to mapAnthropicModel; thinkingType='disabled' is
// returned alongside the other overrides so applyModelOverrides skips the
// `-thinking-` axis.
const NO_THINKING_SUFFIX = /-no-?thinking$/i;

function stripNoThinkingSuffix(model) {
  if (typeof model !== 'string') return model;
  return model.replace(NO_THINKING_SUFFIX, '');
}

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
    // Client-side `-no-thinking` model-name marker. Wins over body.thinking
    // when present (the model name is the more explicit signal — the user
    // typed it on the CLI), but loses to env vars.
    if (typeof body.model === 'string' && NO_THINKING_SUFFIX.test(body.model)) {
      out.thinkingType = 'disabled';
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
function buildMessageDelta(stopReason, outputTokens, inputTokens) {
  // Per Anthropic SSE spec, message_delta.usage is the FINAL cumulative
  // usage for the response (not an incremental delta). claude-code's
  // /context tracker reads input_tokens from here for streaming
  // responses — without it, the counter is stuck at message_start's
  // initial input_tokens=0 (we don't know the count at start time).
  // omitting input_tokens entirely is also valid per spec, but emitting
  // 0 zeroes out the tracker; only include it when we actually know it.
  const usage = { output_tokens: outputTokens || 0 };
  if (typeof inputTokens === 'number' && inputTokens > 0) {
    usage.input_tokens = inputTokens;
  }
  return formatSSE('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason || 'end_turn',
      stop_sequence: null,
    },
    usage,
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
 * Mid-stream `error` SSE event per Anthropic Messages spec. This is a
 * terminal event — the client should discard the partial response and
 * may retry depending on the error type:
 *   - overloaded_error (529) → typically auto-retried by Anthropic SDK
 *   - api_error (500)         → may be retried per client policy
 *   - rate_limit_error (429)  → retried with backoff
 * We use this for upstream stalls so claude-code sees a transient,
 * potentially retryable failure instead of an opaque "[Error: ...]"
 * appended as content (which it interprets as end_turn — terminal).
 */
function buildSseErrorEvent(message, type = 'overloaded_error') {
  return formatSSE('error', {
    type: 'error',
    error: { type, message },
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
  applyModelOverrides, extractModelOverrides, stripNoThinkingSuffix,
  buildAnthropicResponse, buildAnthropicErrorResponse,
  formatSSE,
  buildMessageStart, buildContentBlockStart, buildContentBlockDelta,
  buildContentBlockStartToolUse, buildContentBlockDeltaInputJson,
  buildContentBlockStartThinking, buildContentBlockDeltaThinking,
  buildContentBlockStop, buildMessageDelta, buildMessageStop, buildPing,
  buildSseErrorEvent,
};
