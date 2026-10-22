// Try-on counts: a customer's live try-on adds one per frame per visit, the
// shop's own previews don't count, the shop sees its numbers on its frames
// list, and the admin sees every shop's numbers and can add earlier try-ons.
//
//   node --test --test-concurrency=1 tests/e2e/tryon-counts.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, openBrowser, collectErrors } from './harness.mjs';
import { buildSeed } from './seed.mjs';

function today(off) {
  const t = new Date(Date.now() + 5.5 * 3600000 - (off || 0) * 86400000);
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(t.getUTCDate()).padStart(2, '0');
}
const seed = buildSeed({ s1: { name: 'Alpha Opticals', count: 12 }, s2: { name: 'Beta Eyewear', count: 4 } });
const T0 = { __ts: [1790000000, 0] };
seed['tryons/s1'] = { total: 6, days: { [today()]: 2, [today(3)]: 3, [today(60)]: 1 }, frames: { s1p001: 5, s1p004: 1 }, lastDay: today(), lastFrame: 's1p001', updatedAt: T0 };
seed['tryons/s2'] = { total: 1, days: { [today(1)]: 1 }, frames: { s2p000: 1 }, lastDay: today(1), lastFrame: 's2p000', updatedAt: T0 };
const notGpu = (e) => !/WebGL|GPU|swiftshader/i.test(e);
let server, origin;
before(async () => { ({ server, origin } = await serve()); });
after(() => { if (server) server.close(); });

const counts = (page, shop) => page.evaluate((p) => { const d = window.__fakeStore.get(p); return d ? JSON.parse(JSON.stringify({ total: d.total, frames: d.frames, days: d.days, before: d.before })) : null; }, 'tryons/' + shop);

test('a customer\'s live try-on is counted once per frame per visit', async () => {
  const { browser, context } = await openBrowser({ fake: { seed }, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  await page.goto(origin + '/#/shop/s2');
  await page.waitForSelector('#libraryRow .frame-card');
  assert.equal((await counts(page, 's2')).total, 1, 'just looking at frames counts nothing');
  await page.locator('#libraryRow .frame-card').first().locator('.frame-card-tryon').click();
  await page.waitForFunction(() => location.hash.startsWith('#/try-on/s2p'));
  const first = await page.evaluate(() => location.hash.split('/')[2].split('?')[0]);
  if (await page.isVisible('#liveStartBtn')) await page.click('#liveStartBtn');
  await page.waitForFunction(() => window.__stubFaceCalls > 5);
  await page.waitForFunction(() => (window.__fakeStore.get('tryons/s2') || {}).total === 2);
  let c = await counts(page, 's2');
  assert.equal(c.frames[first], (first === 's2p000' ? 2 : 1));
  assert.equal(c.days[today()], 1);
  // another frame from the picker: one more; back to the first: no more
  const items = page.locator('#liveStrip .similar-item:not(.more-item)');
  await items.nth(1).click();
  await page.waitForFunction(() => (window.__fakeStore.get('tryons/s2') || {}).total === 3);
  await items.nth(0).click();
  await page.waitForTimeout(1200);
  c = await counts(page, 's2');
  assert.equal(c.total, 3, 'the same frame again in this visit isn\'t counted twice: ' + JSON.stringify(c));
  assert.equal(c.days[today()], 2);
  await page.click('#liveStopBtn');
  assert.deepEqual(errors.filter(notGpu), []);
  await browser.close();
});

test('the shop\'s own try-on previews aren\'t counted, and it sees its numbers on its frames list', async () => {
  const { browser, context } = await openBrowser({ fake: { seed, user: { uid: 's1', email: 's1@example.com' } } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  await page.goto(origin + '/#/try-on/s1p002');
  if (await page.isVisible('#liveStartBtn')) await page.click('#liveStartBtn');
  await page.waitForFunction(() => window.__stubFaceCalls > 5);
  await page.waitForTimeout(800);
  assert.equal((await counts(page, 's1')).total, 6, 'not counted');
  await page.click('#liveStopBtn');
  await page.goto(origin + '/#/partner/products');
  await page.waitForSelector('.tryon-count');
  const sum = await page.textContent('.tryon-count');
  assert.match(sum, /Tried on 2 times today, 5 in the last 30 days, 6 in all/);
  // most tried first
  await page.selectOption('#pFSort', 'tryons');
  await page.waitForTimeout(200);
  const firstRow = await page.locator('table tbody tr').first().textContent();
  assert.match(firstRow, /frame 002/); assert.match(firstRow, /tried on 5/);
  assert.deepEqual(errors.filter(notGpu), []);
  await browser.close();
});

test('the admin sees try-ons per shop, the most-tried frames, and can add earlier try-ons', async () => {
  const { browser, context } = await openBrowser({ fake: { seed, user: { uid: 'admin1', email: 'admin@example.com' } } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  await page.goto(origin + '/#/admin');
  await page.waitForSelector('.tryon-table');
  const rows = await page.locator('.tryon-table tbody tr').allTextContents();
  assert.equal(rows.length, 3);
  assert.match(rows[0], /Alpha Opticals\s*2\s*5\s*5\s*6/);
  assert.match(rows[1], /Beta Eyewear\s*0\s*1\s*1\s*1/);
  assert.match(rows[2], /All\s*2\s*6\s*6\s*7/);
  // Shops → Alpha → Details
  await page.goto(origin + '/#/admin/shops');
  await page.click('#adminRoot .chip-row button:has-text("Approved")');
  const det = page.locator('#adminRoot .admin-item', { hasText: 'Alpha Opticals' }).first();
  await det.locator('button:has-text("Details")').click();
  await det.locator('.shop-tryons ol.top-frames').waitFor();
  const top = await det.locator('.top-frames li').allTextContents();
  assert.match(top[0], /Alpha Opticals frame 002 — 5/);
  await det.locator('.shop-tryons input').fill('40');
  await det.locator('.shop-tryons button:has-text("Save")').click();
  await page.waitForFunction(() => (window.__fakeStore.get('tryons/s1') || {}).before === 40);
  assert.equal((await counts(page, 's1')).total, 6, 'the counted try-ons are untouched');
  await page.goto(origin + '/#/admin');
  await page.waitForSelector('.tryon-table');
  assert.match(await page.locator('.tryon-table tbody tr').first().textContent(), /46 \(incl\. 40 earlier\)/);
  assert.deepEqual(errors.filter(notGpu), []);
  await browser.close();
});
