// The admin manages a shop's frames: imports a photo package (zip) into the
// shop, publishing without prices; customers then see the frames ("ask the
// shop for the price") and can try on the ones with a cut-out; running the
// package again adds nothing; a price added later shows up.
//
//   node --test --test-concurrency=1 tests/e2e/admin-import.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve, openBrowser, collectErrors, ROOT } from './harness.mjs';
import { buildSeed } from './seed.mjs';
import { DEMO_FRAMES } from '../../demo/catalog.js';
import { zipSync } from '../../vendor/fflate.mjs';

const seed = buildSeed({ s1: { name: 'Alpha Opticals', count: 3 }, s9: { name: 'Suspended Optics', count: 0, status: 'suspended' } });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-pkg-'));
let server, origin, ZIP;

before(async () => {
  ({ server, origin } = await serve());
  // a package: two frames with try-on (from the demo frames), one photo only
  const files = {}, frames = [];
  DEMO_FRAMES.slice(0, 3).forEach((f, i) => {
    const fid = 'q' + i, png = fs.readFileSync(path.join(ROOT, f.cutout)), thumb = fs.readFileSync(path.join(ROOT, f.thumb));
    files['pkg/' + fid + '.thumb.webp'] = new Uint8Array(thumb);          // (a PNG under the .webp name is fine for the test)
    files['pkg/' + fid + '.source.jpg'] = new Uint8Array(png);
    const tryOn = i < 2;
    if (tryOn) {
      files['pkg/' + fid + '.cutout.png'] = new Uint8Array(png);
      files['pkg/' + fid + '.manifest.json'] = new TextEncoder().encode(JSON.stringify(f.manifest));
    }
    frames.push({ fid, name: 'Package frame ' + (i + 1), brand: 'Test Brand', sku: 'PK-' + i, frameType: 'eyeglasses', material: 'Metal',
      colourName: 'Black', tags: { shape: 'rectangle', color: 'black', gender: 'unisex', rim: 'fullrim', free: ['package'] },
      size: { eye: 50 + i, bridge: 18, temple: 140 }, tryOn, fit: tryOn ? { level: '3d', rimType: 'full', translucent: false, quality: 0.9, warnings: [], cut: { w: f.manifest.imgW, h: f.manifest.imgH } } : undefined,
      src: { w: f.manifest.imgW, h: f.manifest.imgH } });
  });
  files['pkg/frames.json'] = new TextEncoder().encode(JSON.stringify({ package: 'test-pkg', frames }));
  files['__MACOSX/pkg/._frames.json'] = new Uint8Array([1, 2, 3]);
  ZIP = path.join(TMP, 'frames.zip');
  fs.writeFileSync(ZIP, zipSync(files));
});
after(() => { if (server) server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const ADMIN = { uid: 'admin1', email: 'admin@example.com' };
async function adminPage(seedNow) {
  const { browser, context } = await openBrowser({ fake: { seed: seedNow || seed, user: ADMIN } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  return { browser, page, errors: collectErrors(page) };
}
function dump(page) {
  return page.evaluate(() => {
    const plain = (v) => v && typeof v.toMillis === 'function' ? { __ts: [v.seconds, v.nanoseconds] } : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
    const out = {};
    for (const [k, v] of window.__fakeStore) out[k] = plain(v);
    return out;
  });
}

let afterImport;
test('the admin opens a shop\'s dashboard from Admin → Shops and imports a photo package, published without prices', async () => {
  const { browser, page, errors } = await adminPage();
  await page.goto(origin + '/#/admin/shops');
  await page.click('#adminRoot .chip-row button:has-text("Approved")');
  await page.locator('#adminRoot .admin-item', { hasText: 'Alpha Opticals' }).locator('button:has-text("Manage frames")').click();
  await page.waitForSelector('.acting-banner');
  assert.match(await page.textContent('.acting-banner'), /Admin: managing Alpha Opticals/);
  // the shop's own frames are listed
  await page.waitForFunction(() => /Alpha Opticals frame/.test(document.getElementById('partnerRoot').textContent));
  await page.goto(origin + '/#/partner/import');
  await page.waitForSelector('#pkgFile', { state: 'attached' });
  assert.equal(await page.locator('text=Copy old frames').count(), 0, 'the old-library copy is the shop\'s own business');
  await page.setInputFiles('#pkgFile', ZIP);
  await page.waitForFunction(() => /3 frames found, 2 with try-on ready/.test(document.getElementById('partnerRoot').textContent));
  assert.equal(await page.locator('.pkg-grid figure').count(), 3);
  await page.click('button:has-text("Add 3 frames")');
  await page.waitForFunction(() => /Done: 3 added \(2 with try-on, 3 published\), 0 already there, 0 failed/.test(document.getElementById('partnerRoot').textContent), null, { timeout: 60000 });
  const store = await dump(page);
  const mine = Object.entries(store).filter(([k, v]) => k.startsWith('products/') && v.legacyId && v.legacyId.startsWith('pkg:test-pkg:'));
  assert.equal(mine.length, 3);
  for (const [k, p] of mine) {
    assert.equal(p.shopId, 's1');
    assert.equal(p.status, 'published');
    assert.equal(p.public, true, k + ' public');
    assert.equal(p.pricing, undefined, 'no price yet');
    assert.equal(p.availability, 'in_stock');
    assert.match(p.images.thumb.data, /^data:image\//);
    assert.ok(p.images.source.fid && store['productFiles/' + p.images.source.fid].kind === 'source');
    assert.ok(store['catalogues/s1'].items[k.slice(9)], 'in the shop index');
  }
  const ready = mine.filter(([, p]) => p.tryOn.status === 'ready');
  assert.equal(ready.length, 2);
  for (const [, p] of ready) assert.ok(store['productFiles/' + p.images.cutout.fid] && p.images.manifest.data);
  assert.deepEqual(errors, []);
  afterImport = store;
  // a second run adds nothing
  await page.goto(origin + '/#/partner/products');
  await page.goto(origin + '/#/partner/import');
  await page.waitForSelector('#pkgFile', { state: 'attached' });
  await page.setInputFiles('#pkgFile', ZIP);
  await page.click('button:has-text("Add 3 frames")');
  await page.waitForFunction(() => /0 added .* 3 already there/.test(document.getElementById('partnerRoot').textContent), null, { timeout: 30000 });
  await page.click('.acting-banner button');
  await page.waitForFunction(() => location.hash.startsWith('#/admin'));
  await browser.close();
});

test('customers see the imported frames without a price, and try one on', async () => {
  const { browser, context } = await openBrowser({ fake: { seed: afterImport } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = collectErrors(page);
  await page.goto(origin + '/#/shop/s1');
  await page.waitForSelector('#libraryRow .frame-card');
  assert.match(await page.textContent('#catalogNote'), /6 frames/);
  const card = page.locator('#libraryRow .frame-card', { hasText: 'Package frame 1' });
  assert.equal(await card.locator('.price-line').count(), 0, 'no price line on the card');
  await card.locator('.frame-card-link').click();
  await page.waitForSelector('.price-block');
  assert.match(await page.textContent('.price-block'), /Ask the shop for the price/);
  await page.click('.detail-actions .btn.primary');
  await page.waitForFunction(() => location.hash.startsWith('#/try-on/'));
  await page.waitForTimeout(500);
  if (await page.isVisible('#liveStartBtn')) await page.click('#liveStartBtn');
  await page.waitForFunction(() => window.__stubFaceCalls > 5, null, { timeout: 20000 });
  assert.equal((await page.evaluate(() => window.__fakeReadLog)).filter((x) => x.startsWith('get productFiles/') && /cutout/.test(x)).length, 1);
  // the photo-only frame says try-on isn't available
  await page.goto(origin + '/#/shop/s1');
  const p3 = page.locator('#libraryRow .frame-card', { hasText: 'Package frame 3' });
  await p3.waitFor();
  assert.equal(await p3.locator('.no-tryon').count(), 1);
  assert.deepEqual(errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), []);
  await browser.close();
});

test('a price added later in the dashboard shows up for customers', async () => {
  const { browser, page, errors } = await adminPage(afterImport);
  const id = Object.keys(afterImport).find((k) => k.startsWith('products/') && afterImport[k].legacyId === 'pkg:test-pkg:q0').slice(9);
  await page.goto(origin + '/#/partner/product/' + id + '?as=s1');
  await page.waitForSelector('#fPrice');
  // the checklist says the price is optional
  assert.match(await page.textContent('.checklist'), /optional: can be added later/);
  await page.fill('#fPrice', '2499');
  // GST: inclusive, 5%, and confirm
  await page.check('#fTax_inclusive');
  await page.selectOption('#fRateSel', '5');
  await page.check('#fConfirm');
  await page.click('.save-bar button[type="submit"]');
  await page.waitForFunction(() => /Saved/.test(document.body.textContent), null, { timeout: 20000 });
  const store = await dump(page);
  const p = store['products/' + id];
  assert.equal(p.pricing.pricePaise, 249900);
  assert.equal(p.public, true);
  assert.equal(store['catalogues/s1'].items[id].pr.p, 249900, 'the index has the price');
  assert.deepEqual(errors, []);
  await browser.close();
});

test('the admin can\'t add frames to a suspended shop', async () => {
  const { browser, page } = await adminPage();
  await page.goto(origin + '/#/partner/import?as=s9');
  await page.waitForSelector('#pkgFile', { state: 'attached' });
  await page.setInputFiles('#pkgFile', ZIP);
  await page.waitForSelector('button:has-text("Add 3 frames")');
  assert.equal(await page.locator('button:has-text("Add 3 frames")').isDisabled(), true);
  await browser.close();
});
