// UX test harness: the real app with mocked Firebase, real fonts, a bigger
// catalogue, phone/tablet/desktop viewports and axe-core.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const H = require('../harness/serve.cjs');
const S = H.S, OUT = path.join(S, 'ux/out');
fs.mkdirSync(OUT, { recursive: true });
const FONT_DIR = path.join(S, 'uxdeps/node_modules/@fontsource');
const AXE = fs.readFileSync(path.join(S, 'uxdeps/node_modules/axe-core/axe.min.js'), 'utf8');
const SEEDS = { ux: JSON.parse(fs.readFileSync(path.join(S, 'frames/seed-ux.json'))), small: JSON.parse(fs.readFileSync(path.join(S, 'frames/seed.json'))), empty: {} };
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  small: { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  laptop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  desktop: { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 },
  landscape: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
};
function fontCss() {
  const face = (fam, dir, w) => `@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};font-display:swap;src:url(https://app.test/__fonts/${dir}/files/${dir}-latin-${w}-normal.woff2) format('woff2');}`;
  return [400, 500, 600, 700].map(w => face('IBM Plex Sans', 'ibm-plex-sans', w)).concat([400, 500, 600].map(w => face('IBM Plex Mono', 'ibm-plex-mono', w))).join('\n');
}
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function launch(video) {
  return chromium.launch({ args: H.launchArgs(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(S, 'assets/' + (video || 'face_motion.y4m'))]) });
}
async function newPage(browser, o) {
  o = o || {};
  const ctx = await browser.newContext(Object.assign({}, VIEWPORTS[o.vp || 'laptop'], o.reducedMotion ? { reducedMotion: 'reduce' } : {}));
  if (o.camera !== false) await ctx.grantPermissions(['camera'], { origin: 'https://app.test' });
  const page = await ctx.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/^(W|I|E)\d{4}|INFO:|GL_INVALID|GPU stall/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  page.on('request', r => requests.push(r.url()));
  await page.addInitScript(([s, signedOut, deny]) => {
    window.__seed = s; if (signedOut) window.__signedOut = true;
    if (deny) {
      const err = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
      navigator.mediaDevices.getUserMedia = err;
      if (navigator.permissions) { const q = navigator.permissions.query.bind(navigator.permissions); navigator.permissions.query = d => d && d.name === 'camera' ? Promise.resolve({ state: 'denied' }) : q(d); }
    }
  }, [SEEDS[o.seed || 'ux'], !!o.signedOut, !!o.denyCamera]);
  await page.route('**/*', r => H.route(r, async (u) => {
    if (u.host === 'www.gstatic.com' && u.pathname.includes('/firebasejs/')) return path.join(S, 'harness/mocks', path.basename(u.pathname));
    if (u.host === 'fonts.googleapis.com') { await r.fulfill({ contentType: 'text/css', body: fontCss() }); return true; }
    if (u.host === 'app.test' && u.pathname.startsWith('/__fonts/')) return path.join(FONT_DIR, u.pathname.slice(9));
    return null;
  }));
  return { ctx, page, errors, requests };
}
async function axe(page, label, opts) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async (o) => {
    const res = await window.axe.run(document, Object.assign({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }, o || {}));
    return res.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map(n => n.target.join(' ')) }));
  }, opts || null);
  fs.writeFileSync(path.join(OUT, 'axe-' + label + '.json'), JSON.stringify(r, null, 1));
  return r;
}
async function shot(page, name, full) { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full }); }
module.exports = { launch, newPage, axe, shot, check, results, sleep, OUT, S, H, VIEWPORTS };
