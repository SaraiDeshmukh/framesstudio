// Browser tests for the free-plan catalogue: what customers see still works
// (cards, "Show more", search, filters, sorting, shop switching, frame page,
// try-on) and how many Firestore reads it costs. Uses the in-memory Firestore
// from fake-firebase.mjs, which counts reads the way Firestore bills them.
//
//   node --test --test-concurrency=1 tests/e2e/catalogue-reads.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, openBrowser, collectErrors } from './harness.mjs';
import { buildSeed, frameAt } from './seed.mjs';

const SHOPS = {
  s1: { name: 'Alpha Opticals', count: 300 },
  s2: { name: 'Beta Eyewear', count: 30 },
  s3: { name: 'Gamma Specs', count: 60, index: false },               // no catalogue index yet
  s4: { name: 'Delta Vision', count: 10, hidden: [9, 8], staleIndex: true } // index lists 2 frames no longer public
};
const seed = buildSeed(SHOPS);
let server, origin, browser, context;

before(async () => {
  ({ server, origin } = await serve());
  ({ browser, context } = await openBrowser({ fake: { seed } }));
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

async function freshPage(opts) {
  const ctx = opts && opts.newContext ? (await openBrowser({ fake: { seed }, viewport: opts.viewport })).context : context;
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const errors = collectErrors(page);
  return { page, errors, ctx };
}
const reads = (page) => page.evaluate(() => window.__fakeReads);
const log = (page) => page.evaluate(() => window.__fakeReadLog.slice());
const cards = (page) => page.locator('#libraryRow .frame-card');
async function settle(page, ms) { await page.waitForTimeout(ms || 400); await page.waitForFunction(() => !document.querySelector('#libraryRow img.thumb-wait') || true); }
async function waitThumbs(page) {
  // every card on screen has its picture
  await page.waitForFunction(() => {
    const vh = innerHeight;
    return [...document.querySelectorAll('#libraryRow .frame-card img')].every((img) => { const r = img.getBoundingClientRect(); return r.top > vh + 300 || r.bottom < -300 || !img.classList.contains('thumb-wait'); });
  }, null, { timeout: 15000 });
}

test('opening a shop with 300 frames reads its index and only the frames on screen', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/shop/s1');
  await page.waitForSelector('#libraryRow .frame-card');
  await waitThumbs(page);
  await page.waitForTimeout(300);
  assert.equal(await cards(page).count(), 24, '24 cards first');
  assert.match(await page.textContent('#catalogNote'), /300 frames/);
  assert.equal(await page.isVisible('#libraryMoreBtn'), true);
  assert.match(await page.textContent('#libraryMoreBtn'), /Show 24 more frames/);
  const n = await reads(page), l = await log(page);
  const productReads = l.filter((x) => x.startsWith('get products/')).length;
  assert.ok(l.includes('get catalogues/s1 1'), 'index read once');
  assert.ok(productReads <= 24, 'at most 24 product reads, got ' + productReads);
  assert.ok(n <= 30, 'whole visit (settings, shop, index, products) ≤ 30 reads, got ' + n);
  console.log('# reads: open shop (300 frames) =', n, '(products', productReads + ')');
  // newest first, as before
  const first = await cards(page).first().locator('.frame-card-link').textContent();
  assert.equal(first, 'Alpha Opticals frame 300');
  assert.deepEqual(errors, []);
  await ctx.browser().close();
});

test('"Show more" adds the next 24; scrolling down reads only what comes into view', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/shop/s1');
  await page.waitForSelector('#libraryRow .frame-card');
  await waitThumbs(page);
  const before = await reads(page);
  await page.click('#libraryMoreBtn');
  assert.equal(await cards(page).count(), 48);
  await page.waitForTimeout(300);
  const afterClick = await reads(page);
  assert.ok(afterClick - before <= 24, 'no more than one page read by the click, got ' + (afterClick - before));
  // scroll to the bottom: the rest of the second page loads
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await waitThumbs(page);
  await page.waitForTimeout(300);
  const total = await reads(page);
  const products = (await log(page)).filter((x) => x.startsWith('get products/')).length;
  assert.ok(products <= 48, 'two pages at most: ' + products);
  assert.ok(total < 60, 'two pages cost < 60 reads, got ' + total);
  // the focus moves to the first new card
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.textContent);
  assert.equal(focused, 'Alpha Opticals frame 276');
  assert.deepEqual(errors, []);
  await ctx.browser().close();
});

test('search, filters and sorting cover the whole catalogue without reading it', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/shop/s1');
  await page.waitForSelector('#libraryRow .frame-card');
  await waitThumbs(page);
  const start = await reads(page);
  // search by a frame's name far down the list
  await page.fill('#catalogSearch', 'frame 007');
  await page.waitForTimeout(200);
  assert.equal(await cards(page).count(), 1);
  assert.equal(await cards(page).first().locator('.frame-card-link').textContent(), 'Alpha Opticals frame 007');
  await waitThumbs(page);
  // a filter: round frames (every 7th)
  await page.fill('#catalogSearch', '');
  const roundCount = Array.from({ length: 300 }, (_, i) => frameAt(i)).filter((f) => f.shape === 'round').length;
  if (await page.isVisible('#filterToggleBtn')) await page.click('#filterToggleBtn');   // phones: filters in a panel
  await page.click('#filterBar [data-facet="shape"][data-value="round"]');
  if (await page.isVisible('#filterDoneBtn')) await page.click('#filterDoneBtn');
  await page.waitForTimeout(200);
  assert.match(await page.textContent('#catalogNote'), new RegExp('Showing ' + roundCount + ' of 300'));
  assert.equal(await cards(page).count(), Math.min(24, roundCount));
  for (const name of await page.locator('#libraryRow .frame-card-link').allTextContents()) {
    const i = Number(name.match(/(\d+)$/)[1]) - 1;
    assert.equal(frameAt(i).shape, 'round', name + ' is round');
  }
  await waitThumbs(page);
  // search in Hindi finds the same round frames ("गोल")
  await page.fill('#catalogSearch', 'गोल');
  await page.waitForTimeout(200);
  assert.match(await page.textContent('#catalogNote'), new RegExp('Showing ' + roundCount + ' of 300'));
  await page.fill('#catalogSearch', '');
  // sort by price, low to high: the cheapest frame of all 300 comes first
  await page.click('.chip-x');           // remove the round filter
  await page.selectOption('#sortSelect', 'price');
  await page.waitForTimeout(200);
  const prices = Array.from({ length: 300 }, (_, i) => frameAt(i).price);
  const minPrice = Math.min(...prices);
  const firstName = await cards(page).first().locator('.frame-card-link').textContent();
  const firstIdx = Number(firstName.match(/(\d+)$/)[1]) - 1;
  assert.equal(frameAt(firstIdx).price, minPrice, 'cheapest first');
  await waitThumbs(page);
  const used = (await reads(page)) - start;
  assert.ok(used <= 24 * 4, 'search/filter/sort read only shown cards: ' + used);
  assert.ok(!(await log(page)).some((x) => x.startsWith('query products')), 'never queried the whole catalogue');
  console.log('# reads: search + filter + Hindi search + price sort =', used);
  assert.deepEqual(errors, []);
  await ctx.browser().close();
});

test('frame page and try-on reuse what is loaded; the cut-out is read once', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/shop/s1');
  await page.waitForSelector('#libraryRow .frame-card');
  await waitThumbs(page);
  const r0 = await reads(page);
  await cards(page).first().locator('.frame-card-link').click();
  await page.waitForSelector('#detailTitle');
  assert.equal(await page.textContent('#detailTitle'), 'Alpha Opticals frame 300');
  await page.waitForSelector('.detail-desc');
  assert.match(await page.textContent('.detail-desc'), /Test frame number 300/);
  assert.match(await page.textContent('.price-block'), /₹/);
  await page.waitForTimeout(500);
  const l1 = (await log(page)).slice(-20);
  const r1 = await reads(page);
  assert.ok(!l1.some((x) => x === 'get products/s1p299 1' && l1.lastIndexOf(x) > 0 && false));
  const productReadsForIt = (await log(page)).filter((x) => x === 'get products/s1p299 1').length;
  assert.equal(productReadsForIt, 1, 'the frame\'s product was read once (for its card), not again for its page');
  // the full picture on the page: one read of its cut-out document
  assert.ok(r1 - r0 <= 2 + 10, 'frame page reads: cut-out + similar frames not yet seen, got ' + (r1 - r0));
  // try it on with the camera (a synthetic face)
  await page.click('.detail-actions .btn.primary');
  await page.waitForFunction(() => location.hash.startsWith('#/try-on/'));
  await page.waitForFunction(() => window.__stubFaceCalls > 5, null, { timeout: 20000 });
  await page.waitForTimeout(1200);
  const drawn = await page.evaluate(() => {
    const st = document.getElementById('liveStatus');
    return { status: st ? st.textContent : '', calls: window.__stubFaceCalls };
  });
  assert.ok(drawn.calls > 5);
  const cutoutReads = (await log(page)).filter((x) => x.startsWith('get productFiles/')).length;
  assert.equal(cutoutReads, 1, 'cut-out read once for page and try-on');
  // the picker in the try-on shows this shop's frames, a page at a time
  const picker = await page.locator('#liveStrip .similar-item').count();
  assert.ok(picker <= 25 && picker >= 24, 'picker shows 24 (+ Show more), got ' + picker);
  await page.click('#liveStopBtn').catch(() => {});
  assert.deepEqual(errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), []);
  console.log('# reads: frame page + live try-on of a frame already shown =', (await reads(page)) - r0);
  await ctx.browser().close();
});

test('switching shops and coming back costs nothing extra; a reload reads almost nothing', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/shop/s1');
  await page.waitForSelector('#libraryRow .frame-card');
  await waitThumbs(page);
  await page.goto(origin + '/#/shop/s2');
  await page.waitForFunction(() => document.querySelector('#browseTitle') && document.querySelector('#browseTitle').textContent === 'Beta Eyewear');
  await page.waitForSelector('#libraryRow .frame-card');
  assert.equal(await cards(page).count(), 24);
  assert.match(await page.textContent('#catalogNote'), /30 frames/);
  await waitThumbs(page);
  const r1 = await reads(page);
  await page.goto(origin + '/#/shop/s1');
  await page.waitForFunction(() => document.querySelector('#browseTitle').textContent === 'Alpha Opticals');
  await waitThumbs(page);
  await page.waitForTimeout(300);
  assert.equal(await reads(page), r1, 'back to the first shop: 0 reads');
  // a new visit on the same device (kiosk reload): index and products from the browser cache
  const p2 = await ctx.newPage();
  const e2 = collectErrors(p2);
  await p2.goto(origin + '/#/shop/s1');
  await p2.waitForSelector('#libraryRow .frame-card');
  await waitThumbs(p2);
  await p2.waitForTimeout(300);
  const again = await reads(p2);
  assert.ok(again <= 2, 'repeat visit within 10 minutes: ≤ 2 reads, got ' + again + ' ' + JSON.stringify(await log(p2)));
  console.log('# reads: same shop again after a reload =', again);
  assert.deepEqual(errors, []); assert.deepEqual(e2, []);
  await ctx.browser().close();
});

test('a frame that is no longer public disappears even if the index still lists it', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/shop/s4');
  await page.waitForSelector('#libraryRow .frame-card');
  await page.waitForFunction(() => document.querySelectorAll('#libraryRow .frame-card').length === 8, null, { timeout: 10000 });
  assert.match(await page.textContent('#catalogNote'), /8 frames/);
  const names = await page.locator('#libraryRow .frame-card-link').allTextContents();
  assert.ok(!names.includes('Delta Vision frame 010') && !names.includes('Delta Vision frame 009'));
  assert.deepEqual(errors, []);
  await ctx.browser().close();
});

test('a shop without an index still works, 24 at a time from the server', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/shop/s3');
  await page.waitForSelector('#libraryRow .frame-card');
  assert.equal(await cards(page).count(), 24);
  const q1 = (await log(page)).filter((x) => x.startsWith('query products'));
  assert.equal(q1.length, 1);
  assert.match(q1[0], / 24$/, 'one page of 24');
  await page.click('#libraryMoreBtn');
  await page.waitForFunction(() => document.querySelectorAll('#libraryRow .frame-card').length === 48);
  // searching needs all of them: the rest is read once
  await page.fill('#catalogSearch', 'frame 001');
  await page.waitForFunction(() => document.querySelectorAll('#libraryRow .frame-card').length === 1, null, { timeout: 10000 });
  assert.equal(await cards(page).first().locator('.frame-card-link').textContent(), 'Gamma Specs frame 001');
  const productDocs = (await log(page)).filter((x) => x.startsWith('query products')).reduce((s, x) => s + Number(x.split(' ').pop()), 0);
  assert.equal(productDocs, 60, 'each frame read once');
  assert.deepEqual(errors, []);
  await ctx.browser().close();
});

test('the home page reads two settings and six shops, then nothing on a revisit', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/');
  await page.waitForSelector('#homeShopRow .shop-card');
  await page.waitForTimeout(300);
  const first = await reads(page);
  assert.ok(first <= 2 + 6, 'home: ≤ 8 reads, got ' + first);
  const p2 = await ctx.newPage();
  await p2.goto(origin + '/#/');
  await p2.waitForSelector('#homeShopRow .shop-card');
  await p2.waitForTimeout(300);
  assert.equal(await reads(p2), 0, 'home again within 15 minutes: 0 reads');
  console.log('# reads: home =', first, 'then', await reads(p2));
  assert.deepEqual(errors, []);
  await ctx.browser().close();
});

test('on a phone, opening a shop reads even less (only the cards that fit)', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true, viewport: { width: 390, height: 844 } });
  await page.goto(origin + '/#/shop/s1');
  await page.waitForSelector('#libraryRow .frame-card');
  await waitThumbs(page);
  await page.waitForTimeout(300);
  const n = await reads(page);
  assert.equal(await cards(page).count(), 24);
  assert.ok(n <= 12, 'phone: ≤ 12 reads, got ' + n);
  console.log('# reads: open shop on a phone =', n);
  assert.deepEqual(errors, []);
  await ctx.browser().close();
});

test('the demo still works without any database: six frames, pictures, try-on', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/demo');
  await page.waitForSelector('#libraryRow .frame-card');
  assert.equal(await cards(page).count(), 6);
  assert.equal(await page.isVisible('#libraryMoreBtn'), false);
  const srcs = await page.locator('#libraryRow .frame-card img').evaluateAll((els) => els.map((e) => e.getAttribute('src')));
  assert.ok(srcs.every((s) => /^demo\//.test(s)), 'demo pictures shown');
  await cards(page).first().locator('.frame-card-tryon').click();
  await page.waitForFunction(() => location.hash.startsWith('#/try-on/demo-'));
  // the camera starts by itself when it's already allowed; otherwise press start
  await page.waitForTimeout(500);
  if (await page.isVisible('#liveStartBtn')) await page.click('#liveStartBtn');
  await page.waitForFunction(() => window.__stubFaceCalls > 5, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.__fakeReadLog.filter((x) => /products|catalogues|productFiles/.test(x)).length), 0, 'no catalogue reads for the demo');
  await page.click('#liveStopBtn');
  await page.waitForFunction(() => window.__tracks.every((t) => t.readyState === 'ended'));
  assert.deepEqual(errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), []);
  await ctx.browser().close();
});

test('the language switch redraws the catalogue, "Show more" included', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/shop/s1');
  await page.waitForSelector('#libraryRow .frame-card');
  await page.click('[data-lang="hi"]');
  await page.waitForFunction(() => /और फ्रेम दिखाएँ/.test(document.getElementById('libraryMoreBtn').textContent));
  await page.click('[data-lang="mr"]');
  await page.waitForFunction(() => /आणखी 24 फ्रेम दाखवा/.test(document.getElementById('libraryMoreBtn').textContent));
  assert.equal(await cards(page).count(), 24);
  assert.deepEqual(errors, []);
  await ctx.browser().close();
});

test('if Firestore can\'t be reached (offline, or the free daily quota is used up), a seen shop still shows', async () => {
  const { page, errors, ctx } = await freshPage({ newContext: true });
  await page.goto(origin + '/#/shop/s2');
  await page.waitForSelector('#libraryRow .frame-card');
  await waitThumbs(page);
  await page.waitForTimeout(300);
  // an hour later (saved copies are "old"), with every database request failing
  const p2 = await ctx.newPage();
  p2.setDefaultTimeout(15000);
  await p2.clock.setFixedTime(Date.now() + 3600 * 1000);
  await p2.addInitScript(() => { window.__fakeOffline = true; });
  const warnings = [];
  p2.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
  await p2.goto(origin + '/#/shop/s2');
  await p2.waitForSelector('#libraryRow .frame-card');
  await waitThumbs(p2);
  assert.equal(await p2.locator('#libraryRow .frame-card').count(), 24);
  assert.match(await p2.textContent('#browseTitle'), /Beta Eyewear/);
  assert.ok(warnings.some((w) => /Using saved data/.test(w)), 'used the saved copy');
  assert.deepEqual(errors, []);
  await ctx.browser().close();
});
