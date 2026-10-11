const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const H = require('./serve.cjs');
const meta = JSON.parse(fs.readFileSync(path.join(H.S, 'frames/meta.json')));
const jobs = JSON.parse(process.argv[2] || '[]');
(async () => {
  const browser = await chromium.launch({ args: H.launchArgs() });
  const page = await browser.newPage();
  page.on('console', m => { const t = m.text(); if (!/^(W|I)\d{4}|OpenGL error|Graph successfully|Feedback manager|GL_INVALID/.test(t)) console.log('[page]', m.type(), t.slice(0, 300)); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.route('**/*', r => H.route(r));
  await page.goto('https://app.test/render-test.html');
  await page.waitForFunction(() => window.ready);
  for (const job of jobs) {
    const m = meta[job.frame];
    const opts = Object.assign({ face: '/business-person.png', frame: '/' + job.frame + '.png', p1: m.p1, p2: m.p2, crop: [300, 160, 400, 260] }, job);
    opts.frame = '/' + job.frame + '.png';
    if (job.side) opts.side = { src: '/' + job.side + '.png', hinge: meta[job.side].hinge, tip: meta[job.side].tip };
    const r = await page.evaluate(o => window.run(o), opts);
    const out = path.join(H.S, 'harness/out', job.name + '.png');
    fs.writeFileSync(out, Buffer.from(r.png.split(',')[1], 'base64'));
    console.log(job.name, JSON.stringify(r.info));
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
