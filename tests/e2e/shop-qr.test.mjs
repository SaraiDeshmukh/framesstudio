// A shop's QR code: the dashboard shows it (and the admin's shop page), the
// downloaded PNG and the printed poster really decode to the shop's address,
// and scanning it opens that shop's frames and try-on on a phone, staying on
// that shop, within the free plan's read budget.
//
//   node --test --test-concurrency=1 tests/e2e/shop-qr.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { serve, openBrowser, collectErrors } from './harness.mjs';
import { buildSeed } from './seed.mjs';
import { readPNG } from '../png.mjs';
import { siteUrl } from '../../firebase-config.js';

const jsQR = createRequire(import.meta.url)('jsqr');
const seed = buildSeed({
  s1: { name: 'Alpha Opticals', count: 40 },
  s2: { name: 'Beta Eyewear', count: 10 },
  s5: { name: 'Pending Optics', count: 0, status: 'pending' }
});
const LINK = siteUrl + '#/shop/s1?qr=1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-qr-'));
let server, origin;
before(async () => { ({ server, origin } = await serve()); });
after(() => { if (server) server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

function decodePngFile(file) {
  const img = readPNG(file);
  const r = jsQR(img.data, img.width, img.height);
  return r ? r.data : null;
}
async function decodeElement(locator, name) {
  const file = path.join(TMP, name + '.png');
  await locator.screenshot({ path: file });
  return decodePngFile(file);
}
const notGpu = (e) => !/WebGL|GPU|swiftshader/i.test(e);

test('the shop dashboard shows a QR code that decodes to the shop\'s address, as a PNG too', async () => {
  const { browser, context } = await openBrowser({ fake: { seed, user: { uid: 's1', email: 's1@example.com' } } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  await page.goto(origin + '/#/partner/shop');
  await page.waitForSelector('.qr-panel .qr-figure svg');
  assert.equal(await page.textContent('.qr-panel .kiosk-link'), LINK);
  assert.equal(await decodeElement(page.locator('.qr-panel .qr-figure'), 'panel'), LINK, 'the code on screen scans');
  // on a test copy of the site, a separate (unprintable) test address is offered
  assert.match(await page.textContent('.qr-test'), /127\.0\.0\.1.*#\/shop\/s1\?qr=1/);
  // the downloaded PNG
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.qr-panel button.btn.primary')]);
  assert.equal(dl.suggestedFilename(), 'qr-alpha-opticals.png');
  const file = path.join(TMP, 'download.png');
  await dl.saveAs(file);
  assert.equal(decodePngFile(file), LINK, 'the PNG scans');
  const png = readPNG(file);
  assert.ok(png.width >= 1000, 'big enough to print: ' + png.width);
  // the kiosk link points to the main site too
  assert.ok((await page.locator('.kiosk-link').allTextContents()).includes(siteUrl + '#/shop/s1?kiosk=1'));
  assert.deepEqual(errors, []);
  await browser.close();
});

test('the printed poster has the shop, three languages, the steps, the privacy line and a code that scans', async () => {
  const { browser, context } = await openBrowser({ fake: { seed, user: { uid: 's1', email: 's1@example.com' } } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.goto(origin + '/#/partner/shop');
  await page.waitForSelector('.qr-panel .qr-figure svg');
  await page.click('.qr-panel .qr-side .row button:nth-child(2)');
  await page.waitForFunction(() => window.__printed === 1);
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.isVisible('#qrPoster'), true);
  assert.equal(await page.isVisible('header, .site-header').catch(() => false), false, 'nothing else prints');
  const text = await page.textContent('#qrPoster');
  for (const s of ['Alpha Opticals', 'Amravati', 'Scan to try on our frames', 'हमारे फ्रेम पहनकर देखने के लिए स्कैन करें', 'आमच्या फ्रेम घालून पाहण्यासाठी स्कॅन करा', 'No photos are taken, sent or saved']) {
    assert.ok(text.includes(s), 'poster says: ' + s);
  }
  assert.equal(await decodeElement(page.locator('#qrPoster .qr-poster-code'), 'poster'), LINK);
  const pdf = await page.pdf({ format: 'A4' });
  assert.ok(pdf.length > 1000);
  fs.writeFileSync(path.join(TMP, 'poster.pdf'), pdf);
  if (process.env.KEEP_POSTER) fs.copyFileSync(path.join(TMP, 'poster.pdf'), process.env.KEEP_POSTER);
  // the poster in Hindi: the steps follow the language, the three headings stay
  await page.emulateMedia({ media: 'screen' });
  await page.click('[data-lang="hi"]');
  await page.waitForSelector('.qr-panel');
  await page.click('.qr-panel .qr-side .row button:nth-child(2)');
  await page.waitForFunction(() => window.__printed === 2);
  assert.ok((await page.textContent('#qrPoster')).includes('अपने फ़ोन का कैमरा खोलें'));
  assert.equal(await page.locator('#qrPoster').count(), 1, 'one poster at a time');
  assert.deepEqual(errors, []);
  await browser.close();
});

test('a shop waiting for approval is told its QR code comes after approval', async () => {
  const { browser, context } = await openBrowser({ fake: { seed, user: { uid: 's5', email: 's5@example.com' } } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  await page.goto(origin + '/#/partner/shop');
  await page.waitForFunction(() => /once your shop is approved/.test(document.getElementById('partnerRoot').textContent));
  assert.equal(await page.locator('.qr-panel').count(), 0);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('the admin sees each approved shop\'s QR code on its details', async () => {
  const { browser, context } = await openBrowser({ fake: { seed, user: { uid: 'admin1', email: 'admin@example.com' } } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  await page.goto(origin + '/#/admin/shops');
  await page.waitForSelector('#adminRoot');
  // the shop list starts on "waiting for review"; switch to approved and open Alpha's details
  await page.click('#adminRoot .chip-row button:has-text("Approved")');
  const det = page.locator('#adminRoot .admin-item', { hasText: 'Alpha Opticals' }).first();
  await det.locator('button:has-text("Details")').click();
  await det.locator('.qr-panel svg').waitFor();
  assert.equal(await det.locator('.qr-panel .kiosk-link').textContent(), LINK);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('scanning the code on a phone opens that shop\'s frames and try-on, and stays on that shop', async () => {
  const { browser, context } = await openBrowser({ fake: { seed }, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  // the address in the code, on this test copy of the site
  await page.goto(origin + '/#/shop/s1?qr=1');
  await page.waitForSelector('#libraryRow .frame-card');
  await page.waitForFunction(() => document.getElementById('browseTitle').textContent === 'Alpha Opticals');
  assert.equal(await page.evaluate(() => location.hash), '#/shop/s1', 'the address is tidied');
  assert.equal(await page.evaluate(() => document.body.classList.contains('kiosk')), true);
  assert.equal(await page.isVisible('#tabShopsBtn'), false, 'no list of other shops');
  assert.equal(await page.getAttribute('#brandLink', 'href'), '#/shop/s1', 'the logo leads back to this shop');
  assert.equal(await page.locator('#libraryRow .frame-card').count(), 24);
  assert.match(await page.textContent('#catalogNote'), /40 frames/);
  await page.waitForTimeout(600);
  const reads = await page.evaluate(() => window.__fakeReads);
  assert.ok(reads <= 12, 'a scan costs ≤ 12 reads on a phone, got ' + reads);
  console.log('# reads: QR scan on a phone =', reads);
  // try a frame on
  await page.locator('#libraryRow .frame-card').first().locator('.frame-card-tryon').click();
  await page.waitForFunction(() => location.hash.startsWith('#/try-on/s1p'));
  await page.waitForTimeout(500);
  if (await page.isVisible('#liveStartBtn')) await page.click('#liveStartBtn');
  await page.waitForFunction(() => window.__stubFaceCalls > 5, null, { timeout: 20000 });
  const picker = await page.locator('#liveStrip .similar-item:not(.more-item) span:first-of-type').allTextContents();
  assert.ok(picker.length >= 10 && picker.every((n) => n.startsWith('Alpha Opticals')), 'picker: this shop\'s frames only');
  await page.click('#liveStopBtn');
  // other pages lead back to the same shop
  await page.goto(origin + '/#/');
  await page.waitForTimeout(300);
  assert.equal(await page.getAttribute('#brandLink', 'href'), '#/shop/s1');
  await page.goto(origin + '/#/shop/s1');
  await page.waitForSelector('#libraryRow .frame-card');
  // a second scan of the same code on the same phone, later: almost nothing read
  const p2 = await context.newPage();
  await p2.goto(origin + '/#/shop/s1?qr=1');
  await p2.waitForSelector('#libraryRow .frame-card');
  await p2.waitForTimeout(600);
  const again = await p2.evaluate(() => window.__fakeReads);
  assert.ok(again <= 2, 'scanning again: ≤ 2 reads, got ' + again);
  assert.deepEqual(errors.filter(notGpu), []);
  await browser.close();
});

test('a code for a shop that is not approved (or mistyped) explains instead of failing', async () => {
  const { browser, context } = await openBrowser({ fake: { seed }, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  for (const id of ['s5', 'nosuchshop']) {
    await page.goto(origin + '/#/shop/' + id + '?qr=1');
    await page.waitForFunction(() => /isn.t available|not available/i.test(document.getElementById('browseTitle').textContent + document.getElementById('browseIntro').textContent));
  }
  assert.deepEqual(errors.filter((e) => !/permission|insufficient/i.test(e)), []);
  await browser.close();
});
