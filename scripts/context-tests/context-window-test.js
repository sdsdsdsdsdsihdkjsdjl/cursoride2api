#!/usr/bin/env node
// Context window experiment for Cursor's claude-opus-4-7-thinking-max
//
// 1. Calibrate chars-per-token ratio with a small probe
// 2. Generate a ~1M token payload with unique needles at known positions
// 3. Ask the model to recall all needles
// 4. Report: actual inputTokens, which needles recalled, where truncation happens

const http = require('http');
const crypto = require('crypto');

const SERVER = process.env.SERVER || 'http://localhost:3000';
const MODEL = process.env.MODEL || 'claude-opus-4-7';
const API_KEY = process.env.API_KEY || '';

// ── HTTP helper ──
function postMessages(body, timeoutMs = 600_000) {
  const url = new URL('/v1/messages', SERVER);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: timeoutMs,
    };
    if (API_KEY) opts.headers['Authorization'] = `Bearer ${API_KEY}`;

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── Filler generation ──
// Use numbered paragraphs of Lorem Ipsum-style text. Each paragraph is
// unique (numbered) so the model can't collapse repetition, and the
// content is clearly benign — won't trigger content filters.
const LOREM_SENTENCES = [
  'Lorem ipsum dolor sit amet consectetur adipiscing elit.',
  'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam quis nostrud exercitation ullamco laboris.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.',
  'Excepteur sint occaecat cupidatat non proident sunt in culpa qui officia.',
  'Nulla facilisi morbi tempus iaculis urna id volutpat lacus laoreet.',
  'Pellentesque habitant morbi tristique senectus et netus et malesuada fames.',
  'Viverra accumsan in nisl nisi scelerisque eu ultrices vitae auctor.',
  'Adipiscing commodo elit at imperdiet dui accumsan sit amet nulla.',
  'Egestas integer eget aliquet nibh praesent tristique magna sit amet.',
];

function generateFiller(charCount, rng) {
  const chunks = [];
  let total = 0;
  let paraNum = 1;
  while (total < charCount) {
    const sentCount = 2 + (rng() % 4); // 2-5 sentences per paragraph
    let para = `[Paragraph ${paraNum}] `;
    for (let i = 0; i < sentCount; i++) {
      para += LOREM_SENTENCES[rng() % LOREM_SENTENCES.length] + ' ';
    }
    para += '\n';
    chunks.push(para);
    total += para.length;
    paraNum++;
  }
  return chunks.join('');
}

// Simple seeded RNG (xorshift32) for reproducibility
function makeRng(seed) {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return (s >>> 0);
  };
}

// ── Needle generation ──
function makeNeedle(positionLabel) {
  const id = crypto.randomBytes(4).toString('hex');
  return `NEEDLE_${positionLabel}_${id}`;
}

// ── STEP 1: Calibration ──
async function calibrate() {
  console.log('═══ STEP 1: CALIBRATION ═══');
  const rng = makeRng(42);
  const fillerText = generateFiller(20_000, rng); // ~20K chars ≈ ~5-6K tokens
  const charCount = fillerText.length;

  console.log(`  Sending ${charCount.toLocaleString()} chars of filler...`);

  const resp = await postMessages({
    model: MODEL,
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: fillerText + '\n\nHow many words are in the above text? Just say "approximately N" and nothing else.',
    }],
  }, 300_000);

  if (resp.status !== 200) {
    console.error('  Calibration failed:', resp.status, resp.body);
    process.exit(1);
  }

  const inputTokens = resp.body?.usage?.input_tokens;
  const text = resp.body?.content?.[0]?.text || '';
  console.log(`  Response: "${text.trim()}"`);
  console.log(`  Reported inputTokens: ${inputTokens}`);

  if (!inputTokens || inputTokens < 100) {
    // Cursor doesn't report inputTokens for this model. Fall back to
    // Claude's typical ~4 chars/token for Latin-heavy text. The needle
    // test is the real verification — exact token count doesn't matter.
    const fallback = 4.0;
    console.log(`  inputTokens not reported (got ${inputTokens}). Using fallback: ${fallback} chars/token`);
    console.log(`  (This is normal — Cursor hides token counts for some models)`);
    console.log('');
    return fallback;
  }

  const ratio = charCount / inputTokens;
  console.log(`  Calibrated: ${ratio.toFixed(2)} chars/token`);
  console.log('');
  return ratio;
}

// ── STEP 2 & 3: Needle-in-haystack test ──
async function testContextWindow(charsPerToken, targetTokens) {
  console.log(`═══ TESTING ${(targetTokens/1000).toFixed(0)}K TOKENS ═══`);

  const rng = makeRng(12345);
  const targetChars = Math.floor(targetTokens * charsPerToken);

  // Place needles at specific token positions
  const needlePositions = [
    { label: '50K',  frac: 50_000  / targetTokens },
    { label: '100K', frac: 100_000 / targetTokens },
    { label: '200K', frac: 200_000 / targetTokens },
    { label: '300K', frac: 300_000 / targetTokens },
    { label: '500K', frac: 500_000 / targetTokens },
    { label: '750K', frac: 750_000 / targetTokens },
    { label: '900K', frac: 900_000 / targetTokens },
    { label: '950K', frac: 950_000 / targetTokens },
  ].filter(n => n.frac > 0 && n.frac < 1);

  const needles = needlePositions.map(p => ({
    ...p,
    needle: makeNeedle(p.label),
    charPos: Math.floor(p.frac * targetChars),
  }));

  console.log('  Needles planted:');
  for (const n of needles) {
    console.log(`    ${n.label.padEnd(6)} → ${n.needle}  (at char ~${n.charPos.toLocaleString()})`);
  }

  // Build the payload
  console.log(`  Generating ${(targetChars / 1_000_000).toFixed(1)}MB of filler text...`);
  const fullFiller = generateFiller(targetChars + 10_000, rng);

  // Splice needles in
  let payload = fullFiller.slice(0, targetChars);
  // Insert from end to start so positions don't shift
  const sortedNeedles = [...needles].sort((a, b) => b.charPos - a.charPos);
  for (const n of sortedNeedles) {
    const before = payload.slice(0, n.charPos);
    const after = payload.slice(n.charPos);
    payload = before + `\n[SECRET CODE: ${n.needle}]\n` + after;
  }

  const question = `\n\nIMPORTANT TASK: In the text above, I have hidden several secret codes that look like NEEDLE_XXXK_XXXXXXXX. Please list ALL of the secret codes you can find. List each one on its own line, exactly as written. Do not explain, just list them.`;

  const fullMessage = payload + question;
  const msgBytes = Buffer.byteLength(fullMessage);
  console.log(`  Payload size: ${(msgBytes / 1_000_000).toFixed(2)} MB (${msgBytes.toLocaleString()} bytes)`);
  console.log(`  Expected tokens: ~${(msgBytes / charsPerToken / 1000).toFixed(0)}K`);
  console.log('  Sending request (this may take a while)...');

  const t0 = Date.now();
  let resp;
  try {
    resp = await postMessages({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: fullMessage }],
    }, 900_000); // 15 min timeout for large payloads
  } catch (e) {
    console.error(`  REQUEST FAILED: ${e.message}`);
    return { targetTokens, error: e.message };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (resp.status !== 200) {
    console.error(`  HTTP ${resp.status}`);
    const errMsg = typeof resp.body === 'string' ? resp.body.slice(0, 500) : JSON.stringify(resp.body).slice(0, 500);
    console.error(`  ${errMsg}`);
    return { targetTokens, error: `HTTP ${resp.status}: ${errMsg}`, elapsed };
  }

  const inputTokens = resp.body?.usage?.input_tokens || 0;
  const outputTokens = resp.body?.usage?.output_tokens || 0;
  const responseText = resp.body?.content?.[0]?.text || '';
  const stopReason = resp.body?.stop_reason || '?';

  console.log(`  ✅ Response received in ${elapsed}s`);
  console.log(`  inputTokens:  ${inputTokens.toLocaleString()}`);
  console.log(`  outputTokens: ${outputTokens.toLocaleString()}`);
  console.log(`  stopReason:   ${stopReason}`);
  console.log(`  Response text:`);
  console.log(`  ---`);
  console.log(`  ${responseText.trim()}`);
  console.log(`  ---`);

  // Check which needles were recalled
  const results = needles.map(n => ({
    label: n.label,
    needle: n.needle,
    found: responseText.includes(n.needle),
  }));

  console.log('  Needle recall:');
  for (const r of results) {
    console.log(`    ${r.label.padEnd(6)} ${r.needle}  ${r.found ? '✅ FOUND' : '❌ MISSING'}`);
  }

  const foundCount = results.filter(r => r.found).length;
  const lastFound = results.filter(r => r.found).pop();
  const firstMissing = results.find(r => !r.found);

  console.log(`  Summary: ${foundCount}/${results.length} needles recalled`);
  if (lastFound) console.log(`  Last found:    ${lastFound.label} tokens`);
  if (firstMissing) console.log(`  First missing: ${firstMissing.label} tokens`);
  console.log('');

  return {
    targetTokens,
    inputTokens,
    outputTokens,
    elapsed,
    stopReason,
    foundCount,
    totalNeedles: results.length,
    lastFound: lastFound?.label,
    firstMissing: firstMissing?.label,
    results,
    responseText,
  };
}

// ── Main ──
async function main() {
  console.log(`Server:  ${SERVER}`);
  console.log(`Model:   ${MODEL}`);
  console.log('');

  // Step 1: calibrate
  const charsPerToken = await calibrate();

  // Step 2: test at 1M tokens (the big question)
  // If 1M works, context is >= 1M.
  // If it fails, we can do a follow-up at 500K, 300K, etc.
  const targetK = parseInt(process.env.TARGET_K || '1000');
  const result = await testContextWindow(charsPerToken, targetK * 1000);

  console.log('═══ FINAL VERDICT ═══');
  if (result.error) {
    console.log(`  ❌ ${targetK}K tokens FAILED: ${result.error}`);
    console.log(`  → Try a smaller TARGET_K (e.g. TARGET_K=500)`);
  } else if (result.foundCount === result.totalNeedles) {
    console.log(`  ✅ ALL needles found at ${targetK}K tokens!`);
    console.log(`  → Context window is >= ${targetK}K tokens`);
    console.log(`  → Cursor reported inputTokens: ${result.inputTokens?.toLocaleString()}`);
  } else {
    console.log(`  ⚠️  Partial recall: ${result.foundCount}/${result.totalNeedles} needles`);
    console.log(`  → Last confirmed:  ${result.lastFound} tokens`);
    console.log(`  → First missing:   ${result.firstMissing} tokens`);
    console.log(`  → Context window is between ${result.lastFound} and ${result.firstMissing} tokens`);
    console.log(`  → Cursor reported inputTokens: ${result.inputTokens?.toLocaleString()}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
