const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const H = require('./serve.cjs');
const meta = JSON.parse(fs.readFileSync(path.join(H.S, 'frames/meta.json')));
const jobs = JSON.parse(process.argv[2]);
(async () => {
  const browser = await chromium.launch({ args: H.launchArgs() });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200)); });
  await page.route('**/*', r => H.route(r));
  await page.goto('https://app.test/preview-test.html');
  await page.waitForFunction(() => window.ready);
  for (const job of jobs) {
    const m = meta[job.frame];
    const o = { key: job.name, frame: '/' + job.frame + '.png', p1: m.p1, p2: m.p2, tags: job.tags, size: job.size, views: job.views || [[0,0],[25,0],[60,0],[90,0],[-35,10],[0,-30]] };
    if (job.side) o.side = { src: '/' + job.side + '.png', hinge: meta[job.side].hinge, tip: meta[job.side].tip };
    const png = await page.evaluate(x => window.run(x), o);
    fs.writeFileSync(path.join(H.S, 'harness/out', job.name + '.png'), Buffer.from(png.split(',')[1], 'base64'));
    console.log('done', job.name);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
