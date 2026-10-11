// End-to-end checks of the real app (index.html + app.js) with mocked Firebase,
// real MediaPipe, real three.js, a fake camera and seeded catalogue frames.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const H = require('./serve.cjs');
const OUT = path.join(H.S, 'harness/out');
const seed = JSON.parse(fs.readFileSync(path.join(H.S, 'frames/seed.json')));
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newPage(browser, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1100, height: 1300 } }, opts && opts.ctx));
  if (opts && opts.grant) await ctx.grantPermissions(['camera'], { origin: 'https://app.test' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/^(W|I|E)\d{4}|INFO:|GL_INVALID|GPU stall/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  await page.addInitScript(([s, staff]) => {
    window.__seed = s;
    // staff tools unlocked ("keep unlocked on this device"), as a shop member's own device
    if (staff) { try { localStorage.setItem('fts.staffKeep.kiosk', '1'); } catch (e) {} }
  }, [seed, !!(opts && opts.staff)]);
  await page.route('**/*', r => H.route(r, async (u) => {
    if (u.host === 'www.gstatic.com' && u.pathname.includes('/firebasejs/')) return path.join(H.S, 'harness/mocks', path.basename(u.pathname));
    return null;
  }));
  return { ctx, page, errors };
}

const sharp = require('/opt/npm-tools/node_modules/sharp');
async function raw(buf) { const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true }); return { data, info }; }
// Pixels that change on screen when the 3D layer inside `sel` is hidden = what the
// customer sees of the frame. (WebGL canvases can't be read back after compositing.)
async function arPixels(page, sel) {
  const has = await page.evaluate(sel => !!document.querySelector(sel + ' .ar-canvas'), sel);
  if (!has) return -1;
  const el = await page.$(sel);
  // hide the (moving) camera image so only the overlay differs between the two shots
  await page.evaluate(sel => { document.querySelectorAll(sel + ' video, ' + sel + ' canvas:not(.ar-canvas)').forEach(v => { v.style.visibility = 'hidden'; }); }, sel);
  const a = await raw(await el.screenshot());
  await page.evaluate(sel => { document.querySelector(sel + ' .ar-canvas').style.visibility = 'hidden'; }, sel);
  const b = await raw(await el.screenshot());
  await page.evaluate(sel => { document.querySelector(sel + ' .ar-canvas').style.visibility = ''; document.querySelectorAll(sel + ' video, ' + sel + ' canvas:not(.ar-canvas)').forEach(v => { v.style.visibility = ''; }); }, sel);
  let n = 0;
  for (let i = 0; i < a.data.length; i += a.info.channels) {
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30) n++;
  }
  return n;
}
async function shot(page, sel) { return raw(await (await page.$(sel)).screenshot()); }
function diffCount(a, b) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += a.info.channels) if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30) n++;
  return n;
}

module.exports = { newPage, arPixels, shot, diffCount, check, results, sleep, OUT, H };

if (require.main === module) (async () => {
  const which = process.argv[2] || 'photo';
  const browser = await chromium.launch({ args: H.launchArgs(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(H.S, 'assets/face_motion.y4m')]) });
  await require('./e2e-' + which + '.cjs')(browser);
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results-' + which + '.json'), JSON.stringify(results, null, 1));
  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
})().catch(e => { console.error(e); process.exit(1); });
