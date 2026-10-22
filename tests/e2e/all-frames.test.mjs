// "Frames": every shop's frames together (newest first, with the shop's name
// on each card), a link to the demo frames and back, within the free plan's
// read budget; a shop's QR/kiosk mode still stays on that shop.
//
//   node --test --test-concurrency=1 tests/e2e/all-frames.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, openBrowser, collectErrors } from './harness.mjs';
import { buildSeed } from './seed.mjs';

const seed = buildSeed({ s1: { name: 'Alpha Opticals', count: 20 }, s2: { name: 'Beta Eyewear', count: 10 }, s5: { name: 'Pending Optics', count: 3, status: 'pending' } });
const notGpu = (e) => !/WebGL|GPU|swiftshader/i.test(e);
let server, origin;
before(async () => { ({ server, origin } = await serve()); });
after(() => { if (server) server.close(); });

test('"Frames" shows every approved shop\'s frames, and links to the demo frames', async () => {
  const { browser, context } = await openBrowser({ fake: { seed } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  await page.goto(origin + '/#/');
  assert.equal(await page.textContent('#tabBrowseBtn'), 'Frames');
  await page.click('#tabBrowseBtn');
  await page.waitForFunction(() => location.hash === '#/frames');
  await page.waitForSelector('#libraryRow .frame-card');
  assert.equal(await page.textContent('#browseTitle'), 'Frames');
  assert.match(await page.textContent('#catalogNote'), /30 frames/);
  const shops = await page.locator('#libraryRow .frame-card-shop').allTextContents();
  assert.equal(shops.length, 24);
  assert.ok(shops.includes('Alpha Opticals') && shops.includes('Beta Eyewear'), 'both shops: ' + [...new Set(shops)]);
  assert.ok(!shops.includes('Pending Optics'));
  assert.equal(await page.locator('#libraryRow .demo-card').count(), 0, 'no demo frames here');
  await page.waitForTimeout(500);
  const reads = await page.evaluate(() => window.__fakeReads);

  // home (settings, 6 shops) + the shop list + one index per shop + the cards on screen
  assert.ok(reads <= 22, '"Frames" ≤ 22 reads, got ' + reads);
  console.log('# reads: home then "Frames" (2 shops) =', reads);
  // to the demo frames and back
  await page.click('.source-switch');
  await page.waitForFunction(() => location.hash === '#/demo');
  await page.waitForSelector('#libraryRow .demo-card');
  assert.equal(await page.textContent('#browseTitle'), 'Demo frames');
  assert.equal(await page.locator('#libraryRow .frame-card-shop').count(), 0);
  await page.click('.source-switch');
  await page.waitForFunction(() => location.hash === '#/frames');
  await page.waitForFunction(() => /30 frames/.test(document.getElementById('catalogNote').textContent));
  // a frame's page leads back to "Frames"; trying it on keeps every shop in the picker
  await page.locator('#libraryRow .frame-card', { hasText: 'Beta Eyewear frame' }).first().locator('.frame-card-link').click();
  await page.waitForSelector('#detailBack');
  await page.waitForFunction(() => document.getElementById('detailBack').getAttribute('href') === '#/frames');
  assert.equal(await page.textContent('#detailBack'), 'All frames');
  await page.click('.detail-actions .btn.primary');
  await page.waitForFunction(() => location.hash.startsWith('#/try-on/s2p'));
  if (await page.isVisible('#liveStartBtn')) await page.click('#liveStartBtn');
  await page.waitForFunction(() => window.__stubFaceCalls > 5);
  const picker = await page.locator('#liveStrip .similar-item:not(.more-item) span:first-of-type').allTextContents();
  assert.ok(picker.some((n) => n.startsWith('Alpha')) && picker.some((n) => n.startsWith('Beta')), 'picker has both shops');
  await page.click('#liveStopBtn');
  // a repeat visit within minutes reads (almost) nothing
  const p2 = await context.newPage();
  await p2.goto(origin + '/#/frames');
  await p2.waitForSelector('#libraryRow .frame-card');
  await p2.waitForTimeout(500);
  const again = await p2.evaluate(() => window.__fakeReads);
  assert.ok(again <= 3, 'again: ≤ 3 reads, got ' + again);
  assert.deepEqual(errors.filter(notGpu), []);
  await browser.close();
});

test('a shop\'s QR code still stays on that shop, without the switch', async () => {
  const { browser, context } = await openBrowser({ fake: { seed }, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(origin + '/#/shop/s2?qr=1');
  await page.waitForSelector('#libraryRow .frame-card');
  assert.equal(await page.getAttribute('#tabBrowseBtn', 'href'), '#/shop/s2');
  assert.equal(await page.locator('.source-switch').count(), 0);
  assert.equal(await page.locator('#libraryRow .frame-card-shop').count(), 0);
  await browser.close();
});
