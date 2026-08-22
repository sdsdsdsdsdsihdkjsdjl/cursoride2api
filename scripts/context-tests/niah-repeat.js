#!/usr/bin/env node
// Repeated NIAH test: 600K-900K, 3 needles (shallow/middle/deep), 3 reps, 2 models

const http = require('http');
const crypto = require('crypto');

const SERVER = process.env.SERVER || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || '';
const REPS = parseInt(process.env.REPS || '3');

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
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
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

function filler(chars, seed) {
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

async function trial(model, sizeK, rep) {
  const CPC = 4.0;
  const totalChars = sizeK * 1000 * CPC;

  const sNeedle = 'SHALLOW_' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const mNeedle = 'MIDDLE_' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const dNeedle = 'DEEP_' + crypto.randomBytes(5).toString('hex').toUpperCase();

  const sPos = Math.floor(totalChars * 0.10);
  const mPos = Math.floor(totalChars * 0.50);
  const dPos = Math.floor(totalChars * 0.90);

  // Unique seed per trial so filler text varies across reps
  const seed = ((sizeK * 1000 + rep * 7919 + model.charCodeAt(model.length - 1) * 31) >>> 0) || 1;
  let text = filler(totalChars + 5000, seed).slice(0, totalChars);

  // Insert from deepest to shallowest to preserve positions
  text = text.slice(0, dPos) + `\n[SECRET CODE: ${dNeedle}]\n` + text.slice(dPos);
  text = text.slice(0, mPos) + `\n[SECRET CODE: ${mNeedle}]\n` + text.slice(mPos);
  text = text.slice(0, sPos) + `\n[SECRET CODE: ${sNeedle}]\n` + text.slice(sPos);

  const sys =
    'You are a text analyst. The user gives you a document with exactly THREE hidden codes ' +
    'formatted as [SECRET CODE: ...]. Find all three and list them. Output ONLY the codes, one per line.';

  const mb = (Buffer.byteLength(text) / 1e6).toFixed(2);
  const tag = `${model.replace('claude-', '')} ${sizeK}K rep${rep + 1}`;
  process.stdout.write(`  ${tag.padEnd(28)} (${mb}MB) ... `);

  const t0 = Date.now();
  try {
    const resp = await post({ model, max_tokens: 256, system: sys, messages: [{ role: 'user', content: text }] });
    const elapsed = parseFloat(((Date.now() - t0) / 1000).toFixed(1));
    const out = (resp?.content?.[0]?.text || '').trim();
    const stop = resp?.stop_reason || '?';
    const sf = out.includes(sNeedle);
    const mf = out.includes(mNeedle);
    const df = out.includes(dNeedle);

    const icons = (sf ? '✅' : '❌') + (mf ? '✅' : '❌') + (df ? '✅' : '❌');
    console.log(`${icons}  ${elapsed}s  (stop=${stop})`);
    if (!sf || !mf || !df) {
      console.log(`    response: "${out.slice(0, 150).replace(/\n/g, '\\n')}"`);
    }
    return { model, sizeK, rep, shallow: sf, middle: mf, deep: df, elapsed, stop, error: null };
  } catch (e) {
    const elapsed = parseFloat(((Date.now() - t0) / 1000).toFixed(1));
    console.log(`💥 ${e.message}  (${elapsed}s)`);
    return { model, sizeK, rep, shallow: null, middle: null, deep: null, elapsed, stop: null, error: e.message };
  }
}

async function main() {
  const sizes = [600, 700, 750, 800, 900];
  const models = ['claude-opus-4-7', 'claude-opus-4-6'];

  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log(`║  NIAH Repeated Test — ${REPS} reps × ${sizes.length} sizes × ${models.length} models = ${REPS * sizes.length * models.length} trials`.padEnd(68) + '║');
  console.log('║  Needles: shallow@10%  middle@50%  deep@90%                       ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  console.log('');

  const all = [];
  for (const size of sizes) {
    console.log(`── ${size}K tokens ──`);
    for (let rep = 0; rep < REPS; rep++) {
      for (const model of models) {
        const r = await trial(model, size, rep);
        all.push(r);
      }
    }
    console.log('');
  }

  // ── Summary: recall rates ──
  console.log('═══ RECALL RATE SUMMARY ═══');
  console.log('Size    │ Model      │ Shallow(10%) │ Middle(50%) │ Deep(90%) │ Avg Time');
  console.log('────────┼────────────┼──────────────┼─────────────┼───────────┼─────────');
  for (const size of sizes) {
    for (const model of models) {
      const trials = all.filter(r => r.sizeK === size && r.model === model && !r.error);
      const n = trials.length || 1;
      const sRate = trials.filter(r => r.shallow).length;
      const mRate = trials.filter(r => r.middle).length;
      const dRate = trials.filter(r => r.deep).length;
      const avgTime = (trials.reduce((s, r) => s + r.elapsed, 0) / n).toFixed(1);
      const label = model.replace('claude-', '').padEnd(10);
      console.log(
        `${(size + 'K').padEnd(7)} │ ${label} │ ` +
        `${sRate}/${n}`.padEnd(13) + '│ ' +
        `${mRate}/${n}`.padEnd(12) + '│ ' +
        `${dRate}/${n}`.padEnd(10) + '│ ' +
        `${avgTime}s`
      );
    }
  }

  // ── Summary: response times ──
  console.log('');
  console.log('═══ RESPONSE TIME COMPARISON ═══');
  console.log('Size    │ opus-4-7 times          │ opus-4-6 times          │ avg ratio');
  console.log('────────┼─────────────────────────┼─────────────────────────┼──────────');
  for (const size of sizes) {
    const t47 = all.filter(r => r.sizeK === size && r.model === 'claude-opus-4-7' && !r.error).map(r => r.elapsed);
    const t46 = all.filter(r => r.sizeK === size && r.model === 'claude-opus-4-6' && !r.error).map(r => r.elapsed);
    const avg47 = t47.length ? t47.reduce((a, b) => a + b) / t47.length : 0;
    const avg46 = t46.length ? t46.reduce((a, b) => a + b) / t46.length : 0;
    const ratio = (avg46 > 0 && avg47 > 0) ? (avg47 / avg46).toFixed(1) + 'x' : '?';
    console.log(
      `${(size + 'K').padEnd(7)} │ ` +
      `${t47.map(t => t + 's').join(', ').padEnd(23)} │ ` +
      `${t46.map(t => t + 's').join(', ').padEnd(23)} │ ` +
      ratio
    );
  }

  // ── Verdict ──
  console.log('');
  console.log('═══ VERDICT ═══');
  for (const size of sizes) {
    const t46 = all.filter(r => r.sizeK === size && r.model === 'claude-opus-4-6' && !r.error);
    const deepRate46 = t46.filter(r => r.deep).length;
    const midRate46 = t46.filter(r => r.middle).length;
    const n = t46.length || 1;
    if (deepRate46 === n && midRate46 === n) {
      console.log(`  ${size}K: ✅ Full context — both models process all depths`);
    } else if (deepRate46 === 0) {
      console.log(`  ${size}K: ❌ TRUNCATED — opus-4-6 (strong NIAH) also misses deep (${deepRate46}/${n})`);
    } else {
      console.log(`  ${size}K: ⚠️  Inconsistent — opus-4-6 deep=${deepRate46}/${n} middle=${midRate46}/${n}`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
