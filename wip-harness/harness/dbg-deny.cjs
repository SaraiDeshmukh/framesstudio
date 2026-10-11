const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const H = require('./serve.cjs');
(async () => {
  for (const args of [['--use-fake-device-for-media-stream', '--deny-permission-prompts'], ['--use-fake-device-for-media-stream']]) {
    const browser = await chromium.launch({ args: H.launchArgs(args) });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route('**/*', r => H.route(r));
    await page.goto('https://app.test/render-test.html');
    console.log(args.join(' '), await page.evaluate(async () => { try { await navigator.mediaDevices.getUserMedia({ video: true }); return 'ok'; } catch (e) { return e.name + ': ' + e.message; } }));
    await browser.close();
  }
  const browser = await chromium.launch({ headless: true, args: H.launchArgs(['--use-fake-device-for-media-stream']) });
  const ctx = await browser.newContext({ permissions: [] });
  const page = await ctx.newPage();
  await page.route('**/*', r => H.route(r));
  await page.goto('https://app.test/render-test.html');
  console.log('query', await page.evaluate(async () => (await navigator.permissions.query({ name: 'camera' })).state));
  await browser.close();
})();
