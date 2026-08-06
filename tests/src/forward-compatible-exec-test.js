#!/usr/bin/env node

const assert = require('node:assert/strict');
const { create } = require('@bufbuild/protobuf');
const {
  loadProto,
  handleExecMessage,
  sendForwardCompatibleSubagentResult,
} = require('../../src/cursor-agent');

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

function varint(value) {
  let n = Number(value);
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

function tag(fieldNo, wireType) {
  return varint((fieldNo * 8) + wireType);
}

function fieldBytes(fieldNo, bytes) {
  const b = Buffer.from(bytes || []);
  return Buffer.concat([tag(fieldNo, WIRE_LENGTH_DELIMITED), varint(b.length), b]);
}

function fieldString(fieldNo, text) {
  return fieldBytes(fieldNo, Buffer.from(String(text || ''), 'utf8'));
}

function message(fields) {
  return Buffer.concat(fields.filter(Boolean));
}

function unknownLengthDelimitedPayload(payload) {
  const body = Buffer.from(payload || []);
  return new Uint8Array(Buffer.concat([varint(body.length), body]));
}

function readVarint(bytes, offset = 0) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return { value: result, offset: pos };
    shift += 7;
  }
  throw new Error('bad varint');
}

function parseFields(bytes) {
  const data = Buffer.from(bytes || []);
  const out = [];
  let offset = 0;
  while (offset < data.length) {
    const t = readVarint(data, offset);
    offset = t.offset;
    const no = Math.floor(t.value / 8);
    const wireType = t.value & 7;
    if (wireType === WIRE_VARINT) {
      const v = readVarint(data, offset);
      out.push({ no, wireType, value: v.value, data: data.subarray(offset, v.offset) });
      offset = v.offset;
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const len = readVarint(data, offset);
      const start = len.offset;
      const end = start + len.value;
      out.push({ no, wireType, data: data.subarray(start, end) });
      offset = end;
    } else {
      throw new Error(`unsupported test wire type ${wireType}`);
    }
  }
  return out;
}

function findField(bytes, no) {
  return parseFields(bytes).find((f) => f.no === no);
}

const TASK_MODEL_ENUM = new Set(['sonnet', 'opus', 'haiku']);
function validateTaskArgs(args) {
  if (typeof args.description !== 'string' || args.description.length === 0) return `bad description: ${JSON.stringify(args.description)}`;
  if (typeof args.prompt !== 'string') return `bad prompt: ${JSON.stringify(args.prompt)}`;
  if ('subagent_type' in args && typeof args.subagent_type !== 'string') return 'subagent_type must be a string';
  if ('model' in args && !TASK_MODEL_ENUM.has(args.model)) return `model not in client enum: ${JSON.stringify(args.model)}`;
  return null;
}

const taskToolDefs = [{ name: 'mcp_Task', toolName: 'Task' }];

(async () => {
  const { agent } = await loadProto();

  {
    const frames = [];
    const exec = create(agent.ExecServerMessageSchema, { id: 2, execId: '' });
    const executeHookArgs = fieldBytes(1, fieldBytes(4, Buffer.alloc(0)));
    exec.$unknown = [{ no: 27, wireType: WIRE_LENGTH_DELIMITED, data: unknownLengthDelimitedPayload(executeHookArgs) }];

    const result = handleExecMessage(exec, [], (buf) => frames.push(Buffer.from(buf)), () => {
      throw new Error('execute_hook must not surface as an MCP call');
    }, { nativeExecKinds: new Map() });

    assert.equal(result, 'executeHook-forward-compatible');
    assert.equal(frames.length, 2);

    const clientMsg = findField(frames[0], 2).data;
    assert.equal(findField(clientMsg, 1).value, 2);
    const executeHookResult = findField(clientMsg, 27).data;
    const response = findField(executeHookResult, 1).data;
    assert.ok(findField(response, 4), 'pre_tool_use empty response is present');

    const control = findField(frames[1], 5).data;
    const streamClose = findField(control, 1).data;
    assert.equal(findField(streamClose, 1).value, 2);
  }

  {
    const frames = [];
    const calls = [];
    const nativeExecKinds = new Map();
    const exec = create(agent.ExecServerMessageSchema, { id: 7, execId: 'exec-subagent' });
    const subagentArgs = message([
      fieldString(1, 'tc-subagent'),
      fieldString(2, 'explore'),
      fieldString(3, 'sonnet'),
      fieldString(4, 'Investigate protocol drift\nCheck generated proto and logs.'),
    ]);
    exec.$unknown = [{ no: 28, wireType: WIRE_LENGTH_DELIMITED, data: unknownLengthDelimitedPayload(subagentArgs) }];

    const result = handleExecMessage(exec, taskToolDefs, (buf) => frames.push(Buffer.from(buf)), (info) => calls.push(info), {
      nativeExecKinds,
    });

    assert.equal(result, 'subagent-passthrough');
    assert.equal(frames.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, 'Task');
    assert.equal(calls[0].toolCallId, 'tc-subagent');
    assert.equal(calls[0].args.subagent_type, 'general-purpose');
    assert.equal(calls[0].args.model, 'sonnet');
    assert.equal(calls[0].args.prompt, 'Investigate protocol drift\nCheck generated proto and logs.');
    assert.equal(nativeExecKinds.get('exec-subagent').kind, 'subagent');
    assert.equal(nativeExecKinds.get('exec-subagent').subagentType, 'explore');
    assert.equal(validateTaskArgs(calls[0].args), null);
  }

  {
    const calls = [];
    const exec = create(agent.ExecServerMessageSchema, { id: 11, execId: 'exec-subagent-2' });
    const subagentArgs = message([
      fieldString(1, 'tc-sub-2'),
      fieldString(2, ''),
      fieldString(3, 'claude-4-sonnet-thinking'),
      fieldString(4, 'Do the thing'),
    ]);
    exec.$unknown = [{ no: 28, wireType: WIRE_LENGTH_DELIMITED, data: unknownLengthDelimitedPayload(subagentArgs) }];
    const result = handleExecMessage(exec, taskToolDefs, () => {}, (info) => calls.push(info), {
      nativeExecKinds: new Map(),
    });
    assert.equal(result, 'subagent-passthrough');
    assert.equal(calls[0].args.subagent_type, 'general-purpose');
    assert.equal('model' in calls[0].args, false);
    assert.equal(calls[0].args.prompt, 'Do the thing');
  }

  {
    process.env.CURSOR_SUBAGENT_TYPE_MAP = 'explore=Explore,plan=Plan';
    try {
      const calls = [];
      const exec = create(agent.ExecServerMessageSchema, { id: 12, execId: 'exec-subagent-3' });
      const subagentArgs = message([
        fieldString(1, 'tc-sub-3'),
        fieldString(2, 'explore'),
        fieldString(4, 'Map the repo'),
      ]);
      exec.$unknown = [{ no: 28, wireType: WIRE_LENGTH_DELIMITED, data: unknownLengthDelimitedPayload(subagentArgs) }];
      handleExecMessage(exec, taskToolDefs, () => {}, (info) => calls.push(info), {
        nativeExecKinds: new Map(),
      });
      assert.equal(calls[0].args.subagent_type, 'Explore');
    } finally {
      delete process.env.CURSOR_SUBAGENT_TYPE_MAP;
    }
  }

  {
    process.env.CURSOR_SUBAGENT_FORWARD_MODEL = '0';
    try {
      const calls = [];
      const exec = create(agent.ExecServerMessageSchema, { id: 13, execId: 'exec-subagent-4' });
      const subagentArgs = message([
        fieldString(1, 'tc-sub-4'),
        fieldString(2, 'explore'),
        fieldString(3, 'sonnet'),
        fieldString(4, 'No model please'),
      ]);
      exec.$unknown = [{ no: 28, wireType: WIRE_LENGTH_DELIMITED, data: unknownLengthDelimitedPayload(subagentArgs) }];
      handleExecMessage(exec, taskToolDefs, () => {}, (info) => calls.push(info), {
        nativeExecKinds: new Map(),
      });
      assert.equal('model' in calls[0].args, false);
    } finally {
      delete process.env.CURSOR_SUBAGENT_FORWARD_MODEL;
    }
  }

  {
    const calls = [];
    const exec = create(agent.ExecServerMessageSchema, { id: 14, execId: 'exec-subagent-5' });
    const subagentArgs = message([
      fieldString(1, 'tc-sub-5'),
      fieldString(2, 'explore'),
      fieldString(3, 'fable'),
      fieldString(4, 'no fable please'),
    ]);
    exec.$unknown = [{ no: 28, wireType: WIRE_LENGTH_DELIMITED, data: unknownLengthDelimitedPayload(subagentArgs) }];
    handleExecMessage(exec, taskToolDefs, () => {}, (info) => calls.push(info), {
      nativeExecKinds: new Map(),
    });
    assert.equal('model' in calls[0].args, false);
    assert.equal(validateTaskArgs(calls[0].args), null);
  }

  {
    process.env.CURSOR_SUBAGENT_MODEL_KEYWORDS = 'sonnet,opus,haiku,fable';
    try {
      const calls = [];
      const exec = create(agent.ExecServerMessageSchema, { id: 15, execId: 'exec-subagent-6' });
      const subagentArgs = message([fieldString(1, 'tc-sub-6'), fieldString(3, 'fable'), fieldString(4, 'override keeps it')]);
      exec.$unknown = [{ no: 28, wireType: WIRE_LENGTH_DELIMITED, data: unknownLengthDelimitedPayload(subagentArgs) }];
      handleExecMessage(exec, taskToolDefs, () => {}, (info) => calls.push(info), {
        nativeExecKinds: new Map(),
      });
      assert.equal(calls[0].args.model, 'fable');
    } finally {
      delete process.env.CURSOR_SUBAGENT_MODEL_KEYWORDS;
    }
  }

  for (const ss of [false, () => false]) {
    const frames = [];
    const calls = [];
    const nativeExecKinds = new Map();
    const exec = create(agent.ExecServerMessageSchema, { id: 20, execId: 'exec-subagent-off' });
    const subagentArgs = message([fieldString(1, 'tc-off'), fieldString(2, 'explore'), fieldString(4, 'should be rejected')]);
    exec.$unknown = [{ no: 28, wireType: WIRE_LENGTH_DELIMITED, data: unknownLengthDelimitedPayload(subagentArgs) }];
    const result = handleExecMessage(exec, taskToolDefs, (buf) => frames.push(Buffer.from(buf)), (info) => calls.push(info), {
      nativeExecKinds,
      subagentSupport: ss,
    });
    assert.equal(result, 'subagent-disabled');
    assert.equal(calls.length, 0);
    assert.ok(frames.length >= 1);
    assert.equal(nativeExecKinds.size, 0);
  }

  {
    const frames = [];
    sendForwardCompatibleSubagentResult(9, 'exec-subagent-result', 'agent-123\nsubagent completed', (buf) => frames.push(Buffer.from(buf)));
    assert.equal(frames.length, 2);

    const clientMsg = findField(frames[0], 2).data;
    assert.equal(findField(clientMsg, 1).value, 9);
    assert.equal(findField(clientMsg, 15).data.toString('utf8'), 'exec-subagent-result');

    const subagentResult = findField(clientMsg, 28).data;
    const success = findField(subagentResult, 1).data;
    assert.match(findField(success, 1).data.toString('utf8'), /^cursoride2api-subagent-/);
    assert.equal(findField(success, 2).data.toString('utf8'), 'agent-123\nsubagent completed');

    const control = findField(frames[1], 5).data;
    const streamClose = findField(control, 1).data;
    assert.equal(findField(streamClose, 1).value, 9);
  }

  {
    const frames = [];
    sendForwardCompatibleSubagentResult(10, 'exec-subagent-error', { error: 'outer Task failed' }, (buf) => frames.push(Buffer.from(buf)));
    const clientMsg = findField(frames[0], 2).data;
    const subagentResult = findField(clientMsg, 28).data;
    const error = findField(subagentResult, 2).data;
    assert.equal(findField(error, 2).data.toString('utf8'), 'outer Task failed');
  }

  console.log('forward-compatible-exec-test: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
