const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path'); const H = require('./serve.cjs');
(async () => {
  for (const extra of [[], ['--use-fake-ui-for-media-stream']]) {
    const browser = await chromium.launch({ args: H.launchArgs(['--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(H.S, 'assets/face_motion.y4m')].concat(extra)) });
    const ctx = await browser.newContext(); await ctx.grantPermissions(['camera'], { origin: 'https://app.test' });
    const page = await ctx.newPage();
    await page.route('**/*', r => H.route(r));
    await page.goto('https://app.test/render-test.html');
    const r = await page.evaluate(async () => { try { const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } }); const t = s.getVideoTracks()[0]; return 'ok ' + JSON.stringify(t.getSettings()); } catch (e) { return 'err ' + e.name + ' ' + e.message; } });
    console.log(extra.join(' ') || '(no fake ui)', r);
    await browser.close();
  }
})();
