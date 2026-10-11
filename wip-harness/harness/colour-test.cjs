const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const H = require('./serve.cjs');
const meta = JSON.parse(fs.readFileSync(path.join(H.S, 'frames/meta.json')));
(async () => {
  const browser = await chromium.launch({ args: H.launchArgs() });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.route('**/*', r => H.route(r));
  await page.goto('https://app.test/preview-test.html');
  await page.waitForFunction(() => window.ready);
  for (const name of ['gold', 'acetate', 'tortoise']) {
    const res = await page.evaluate(async ({ name, m }) => {
      const { createTryOnRenderer } = await import('/ar-renderer.js');
      const r = window._r || (window._r = await createTryOnRenderer());
      r.setSize(700, 400);
      const img = new Image(); img.src = '/' + name + '.png'; await img.decode();
      r.setFrame('c-' + name, { img, p1: m.p1, p2: m.p2, tags: { color: name === 'gold' ? 'gold' : name === 'tortoise' ? 'tortoise' : 'black' } });
      const out = {};
      for (const sheenOn of [false, true]) {
        r.glasses.children.forEach(c => { if (c.renderOrder === 30) c.visible = sheenOn; });
        r.renderPreview(0, 0);
        const c = document.createElement('canvas'); c.width = 700; c.height = 400; const g = c.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, 700, 400); g.drawImage(r.canvas, 0, 0);
        const d = g.getImageData(0, 0, 700, 400).data; let s = [0, 0, 0], n = 0;
        // only fully covered pixels: brightness clearly above black background and not edge
        for (let i = 0; i < d.length; i += 4) { const a = r.canvas; }
        const gl = r.renderer.getContext();
        const px = new Uint8Array(700 * 400 * 4); r.renderPreview(0, 0); gl.readPixels(0, 0, 700, 400, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < px.length; i += 4) if (px[i + 3] === 255) { s[0] += px[i]; s[1] += px[i + 1]; s[2] += px[i + 2]; n++; }
        out[sheenOn ? 'withSheen' : 'noSheen'] = s.map(v => Math.round(v / n)).concat([n]);
      }
      return out;
    }, { name, m: meta[name] });
    console.log(name, JSON.stringify(res));
  }
  await browser.close();
})();
