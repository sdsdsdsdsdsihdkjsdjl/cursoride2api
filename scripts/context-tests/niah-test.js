#!/usr/bin/env node
// NIAH (Needle In A Haystack) context window test
//
// Tests both shallow and deep needle placement at various payload sizes.
// Compares claude-opus-4-7 vs claude-opus-4-6 to control for recall ability.

const http = require('http');
const crypto = require('crypto');

const SERVER = process.env.SERVER || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || '';

function post(body) {
  const url = new URL('/v1/messages', SERVER);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', timeout: 600000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'anthropic-version': '2023-06-01',
        ...(API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── Filler ──
const LOREM = [
  'Lorem ipsum dolor sit amet consectetur adipiscing elit.',
  'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam quis nostrud exercitation ullamco laboris.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.',
  'Excepteur sint occaecat cupidatat non proident sunt in culpa qui officia.',
  'Nulla facilisi morbi tempus iaculis urna id volutpat lacus laoreet.',
  'Pellentesque habitant morbi tristique senectus et netus et malesuada fames.',
  'Viverra accumsan in nisl nisi scelerisque eu ultrices vitae auctor.',
];

function filler(chars, seed = 12345) {
  let s = '', n = 1, rng = seed;
  while (s.length < chars) {
    rng = ((rng ^ (rng << 13)) ^ (rng >> 17) ^ (rng << 5)) >>> 0;
    const cnt = 2 + (rng % 4);
    let p = `[Paragraph ${n}] `;
    for (let i = 0; i < cnt; i++) p += LOREM[rng % LOREM.length] + ' ';
    s += p + '\n';
    n++;
  }
  return s;
}

// ── Single trial: one payload size, one model, two needles (shallow + deep) ──
async function trial(model, payloadKTokens, shallowPct, deepPct) {
  const CPC = 4.0; // ~4 chars/token verified via tiktoken
  const totalChars = payloadKTokens * 1000 * CPC;

  const shallowNeedle = 'SHALLOW_' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const deepNeedle = 'DEEP_' + crypto.randomBytes(6).toString('hex').toUpperCase();

  const shallowPos = Math.floor(totalChars * shallowPct);
  const deepPos = Math.floor(totalChars * deepPct);

  const seed = (payloadKTokens * 7 + model.charCodeAt(model.length - 1)) >>> 0;
  let text = filler(totalChars + 5000, seed).slice(0, totalChars);

  // Insert deep first (higher offset) to preserve shallow position
  text = text.slice(0, deepPos)
    + `\n[SECRET CODE: ${deepNeedle}]\n`
    + text.slice(deepPos);
  text = text.slice(0, shallowPos)
    + `\n[SECRET CODE: ${shallowNeedle}]\n`
    + text.slice(shallowPos);

  const systemPrompt =
    'You are a text analyst. The user gives you a document with exactly TWO hidden codes ' +
    'formatted as [SECRET CODE: ...]. Find both and list them. Output ONLY the two codes, one per line.';

  const mb = (Buffer.byteLength(text) / 1e6).toFixed(2);
  const shallowK = Math.round(payloadKTokens * shallowPct);
  const deepK = Math.round(payloadKTokens * deepPct);

  process.stdout.write(
    `  ${model.padEnd(20)} ${String(payloadKTokens + 'K').padEnd(7)} ` +
    `shallow@${shallowK}K deep@${deepK}K (${mb}MB) ... `
  );

  const t0 = Date.now();
  try {
    const resp = await post({
      model,
      max_tokens: 256,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const out = (resp?.content?.[0]?.text || '').trim();
    const stopReason = resp?.stop_reason || '?';
    const shallowFound = out.includes(shallowNeedle);
    const deepFound = out.includes(deepNeedle);

    let verdict;
    if (shallowFound && deepFound) verdict = '✅✅ BOTH';
    else if (shallowFound && !deepFound) verdict = '✅❌ shallow only';
    else if (!shallowFound && deepFound) verdict = '❌✅ deep only';
    else verdict = '❌❌ NEITHER';

    console.log(`${verdict}  (${elapsed}s, stop=${stopReason})`);

    if (!shallowFound || !deepFound) {
      console.log(`    response: "${out.slice(0, 120)}"`);
    }

    return { model, payloadKTokens, shallowFound, deepFound, elapsed, stopReason, response: out };
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`💥 ERROR (${elapsed}s): ${e.message}`);
    return { model, payloadKTokens, error: e.message, elapsed };
  }
}

async function main() {
  const SHALLOW = 0.10; // needle at 10% depth
  const DEEP = 0.90;    // needle at 90% depth

  // Payload sizes to test (in K tokens)
  const sizes = [200, 400, 600, 700, 800, 900];
  const models = ['claude-opus-4-7', 'claude-opus-4-6'];

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  NIAH Context Window Test                                    ║');
  console.log('║  Shallow needle @ 10% depth, Deep needle @ 90% depth         ║');
  console.log('║  If shallow=✅ deep=❌ → truncation (content cut off)         ║');
  console.log('║  If shallow=❌ deep=❌ → request rejected or garbled          ║');
  console.log('║  If shallow=✅ deep=✅ → full context processed              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const results = [];

  for (const size of sizes) {
    console.log(`── ${size}K tokens ──`);
    for (const model of models) {
      const r = await trial(model, size, SHALLOW, DEEP);
      results.push(r);
    }
    console.log('');
  }

  // Summary table
  console.log('═══ SUMMARY ═══');
  console.log('Size    │ opus-4-7 shallow │ opus-4-7 deep │ opus-4-6 shallow │ opus-4-6 deep');
  console.log('────────┼──────────────────┼───────────────┼──────────────────┼──────────────');
  for (const size of sizes) {
    const o47 = results.find(r => r.model === 'claude-opus-4-7' && r.payloadKTokens === size);
    const o46 = results.find(r => r.model === 'claude-opus-4-6' && r.payloadKTokens === size);
    const row = [
      `${size}K`.padEnd(7),
      o47?.error ? '💥 err' : (o47?.shallowFound ? '  ✅' : '  ❌'),
      o47?.error ? '💥 err' : (o47?.deepFound ? '  ✅' : '  ❌'),
      o46?.error ? '💥 err' : (o46?.shallowFound ? '  ✅' : '  ❌'),
      o46?.error ? '💥 err' : (o46?.deepFound ? '  ✅' : '  ❌'),
    ];
    console.log(row.join('  │  '));
  }

  console.log('');
  console.log('Key insight: if opus-4-6 finds deep@90% where opus-4-7 misses it,');
  console.log('the miss is recall failure, not truncation. If BOTH miss it, it\'s truncation.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
