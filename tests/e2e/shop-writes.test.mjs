// Browser tests for the shop side on the free plan: pictures stored in
// Firestore (inline or productFiles, scaled down to fit), the catalogue index
// kept in step with product writes, and the dashboard reading only what
// changed since its last visit. Uses the in-memory Firestore
// (fake-firebase.mjs) and calls backend.js inside the page.
//
//   node --test --test-concurrency=1 tests/e2e/shop-writes.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, openBrowser, collectErrors } from './harness.mjs';
import { buildSeed } from './seed.mjs';

const seed = buildSeed({ s1: { name: 'Alpha Opticals', count: 40 }, s2: { name: 'Beta Eyewear', count: 5 } });
let server, origin;
before(async () => { ({ server, origin } = await serve()); });
after(() => { if (server) server.close(); });

async function shopPage(user) {
  const { browser, context } = await openBrowser({ fake: { seed, user: user === undefined ? { uid: 's1', email: 's1@example.com' } : user } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = collectErrors(page);
  await page.goto(origin + '/#/');
  await page.waitForFunction(() => !!document.querySelector('#homeDemoRow .frame-card'));
  return { browser, context, page, errors };
}

test('pictures are kept in Firestore: thumbnail and fitting data inline, cut-out and original as documents', async () => {
  const { browser, page, errors } = await shopPage();
  const r = await page.evaluate(async () => {
    const B = await import('/backend.js');
    function canvasBlob(w, h, type, noisy) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      if (noisy) { const d = g.createImageData(w, h); for (let i = 0; i < d.data.length; i++) d.data[i] = (Math.random() * 256) | 0; g.putImageData(d, 0, 0); }
      else { g.fillStyle = '#123'; g.fillRect(10, 10, w - 20, h - 20); }
      return new Promise((res) => c.toBlob(res, type, 0.9));
    }
    const id = 's1p000';
    const thumb = await B.uploadProductFile('s1', id, 'assets', 'thumb-t1', await canvasBlob(260, 260, 'image/webp'), { w: 260, h: 260 });
    const manifest = await B.uploadProductFile('s1', id, 'assets', 'asset-t1', new Blob([JSON.stringify({ v: 1, imgW: 10, imgH: 10 })], { type: 'application/json' }));
    // a noisy 1400x900 PNG is far too big for one document: it gets scaled down
    const big = await canvasBlob(1400, 900, 'image/png', true);
    const cutout = await B.uploadProductFile('s1', id, 'assets', 'cutout-t1', big, { w: 1400, h: 900 });
    const source = await B.uploadProductFile('s1', id, 'source', 'source-t1', await canvasBlob(1600, 1200, 'image/jpeg', true), { w: 1600, h: 1200 });
    const store = window.__fakeStore;
    const cdoc = store.get('productFiles/' + cutout.fid), sdoc = store.get('productFiles/' + source.fid);
    const back = await B.fileUrl(cutout);
    const srcBlob = await B.getSourceBlob(source);
    return {
      thumb: { inline: !!thumb.data, fid: thumb.fid || null, len: (thumb.data || '').length },
      manifest: { inline: !!manifest.data },
      cutout: { fid: cutout.fid, w: cutout.w, h: cutout.h, len: cdoc.data.length, kind: cdoc.kind, bigBytes: big.size },
      source: { fid: source.fid, kind: sdoc.kind, len: sdoc.data.length, blob: srcBlob.size, type: srcBlob.type },
      sameBack: back === cdoc.data
    };
  });
  assert.equal(r.thumb.inline, true, 'thumbnail inline');
  assert.equal(r.thumb.fid, null);
  assert.ok(r.thumb.len <= 40000);
  assert.equal(r.manifest.inline, true, 'fitting data inline');
  assert.equal(r.cutout.fid, 's1p000__cutout-t1');
  assert.equal(r.cutout.kind, 'assets');
  assert.ok(r.cutout.bigBytes > 900000, 'the test picture really was too big (' + r.cutout.bigBytes + ')');
  assert.ok(r.cutout.len <= 900000, 'stored within one document: ' + r.cutout.len);
  assert.ok(r.cutout.w < 1400 && Math.abs(r.cutout.w / r.cutout.h - 1400 / 900) < 0.02, 'scaled down, same proportions: ' + r.cutout.w + 'x' + r.cutout.h);
  assert.equal(r.source.kind, 'source');
  assert.ok(r.source.len <= 600000, 'original kept smaller on the free plan: ' + r.source.len);
  assert.equal(r.source.type, 'image/jpeg');
  assert.equal(r.sameBack, true);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('publishing, editing, unpublishing and deleting keep the shop\'s index in step', async () => {
  const { browser, page, errors } = await shopPage();
  const r = await page.evaluate(async () => {
    const B = await import('/backend.js');
    const store = window.__fakeStore;
    const idx = () => store.get('catalogues/s1').items;
    const out = {};
    const p = await B.getProduct('s1p001');
    out.listedBefore = !!idx().s1p001;
    // rename (still public): the index entry follows, with the product's new time
    await B.saveProduct(p, { name: 'Renamed frame' }, 'approved');
    out.renamed = idx().s1p001.n;
    out.sameTime = idx().s1p001.u.toMillis() === store.get('products/s1p001').updatedAt.toMillis();
    // unpublish: removed from the index
    const p2 = await B.getProduct('s1p001');
    await B.saveProduct(p2, { status: 'draft' }, 'approved');
    out.afterDraft = !!idx().s1p001;
    out.publicAfterDraft = store.get('products/s1p001').public;
    // publish again
    const p3 = await B.getProduct('s1p001');
    await B.saveProduct(p3, { status: 'published' }, 'approved');
    out.afterRepublish = !!idx().s1p001;
    // a product in a pending shop never enters the index
    const p4 = await B.getProduct('s1p002');
    await B.saveProduct(p4, { name: 'Pending shop edit' }, 'pending');
    out.pendingRemoved = !idx().s1p002;
    // delete: product, index entry and its picture documents go
    store.set('productFiles/s1p003__cutout-x', { shopId: 's1', productId: 's1p003', kind: 'assets', data: 'data:image/png;base64,AA' });
    const p5 = await B.getProduct('s1p003');
    p5.images.cutout = { path: 'shops/s1/products/s1p003/assets/cutout-x.png', fid: 's1p003__cutout-x' };
    await B.deleteProduct(p5);
    out.deleted = !store.has('products/s1p003') && !idx().s1p003 && !store.has('productFiles/s1p003__cutout-x');
    out.count = Object.keys(idx()).length;
    return out;
  });
  assert.equal(r.listedBefore, true);
  assert.equal(r.renamed, 'Renamed frame');
  assert.equal(r.sameTime, true, 'index time = product time (lets browsers trust their cached copy)');
  assert.equal(r.afterDraft, false);
  assert.equal(r.publicAfterDraft, false);
  assert.equal(r.afterRepublish, true);
  assert.equal(r.pendingRemoved, true);
  assert.equal(r.deleted, true);
  assert.equal(r.count, 38);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('if the index can\'t be written the product is still saved, and the dashboard repairs the index', async () => {
  const { browser, page, errors } = await shopPage();
  const r = await page.evaluate(async () => {
    const B = await import('/backend.js');
    const store = window.__fakeStore;
    window.__fakeDenyWrites = ['catalogues/'];
    const p = await B.getProduct('s1p004');
    const origWarn = console.warn; console.warn = () => {};
    await B.saveProduct(p, { name: 'Saved without index' }, 'approved');
    console.warn = origWarn;
    const saved = store.get('products/s1p004').name;
    const staleName = store.get('catalogues/s1').items.s1p004.n;
    window.__fakeDenyWrites = null;
    const list = await B.loadAllMyProducts('s1');
    const rewritten = await B.syncCatalogueIndex('s1', list);
    const again = await B.syncCatalogueIndex('s1', list);
    return { saved, staleName, fixedName: store.get('catalogues/s1').items.s1p004.n, rewritten, again };
  });
  assert.equal(r.saved, 'Saved without index');
  assert.notEqual(r.staleName, 'Saved without index');
  assert.equal(r.rewritten, true);
  assert.equal(r.fixedName, 'Saved without index');
  assert.equal(r.again, false, 'nothing to do the second time (no write)');
  assert.deepEqual(errors, []);
  await browser.close();
});

test('the dashboard reads all products once, then only what changed', async () => {
  const { browser, context, page, errors } = await shopPage();
  const first = await page.evaluate(async () => {
    const B = await import('/backend.js');
    const r0 = window.__fakeReads;
    const list = await B.loadAllMyProducts('s1');
    return { n: list.length, reads: window.__fakeReads - r0 };
  });
  assert.equal(first.n, 40);
  assert.ok(first.reads >= 40 && first.reads <= 41, 'first visit reads every product: ' + first.reads);
  // next visit (a new page, same device), after one product changed on the server
  const p2 = await context.newPage();
  p2.setDefaultTimeout(20000);
  await p2.goto(origin + '/#/');
  await p2.waitForFunction(() => !!document.querySelector('#homeDemoRow .frame-card'));
  const second = await p2.evaluate(async () => {
    const B = await import('/backend.js');
    const { Timestamp } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
    const store = window.__fakeStore;
    const d = store.get('products/s1p010'); d.name = 'Changed elsewhere'; d.updatedAt = Timestamp.now(); store.set('products/s1p010', d);
    const r0 = window.__fakeReads;
    const list = await B.loadAllMyProducts('s1');
    const reads = window.__fakeReads - r0;
    // a product deleted on another device: noticed by the count, so everything is read again
    store.delete('products/s1p011');
    const r1 = window.__fakeReads;
    const list2 = await B.loadAllMyProducts('s1');
    return { n: list.length, reads, changed: list.find((p) => p.id === 's1p010').name, first: list[0].id, n2: list2.length, reads2: window.__fakeReads - r1, gone: !list2.some((p) => p.id === 's1p011') };
  });
  assert.equal(second.n, 40);
  assert.equal(second.changed, 'Changed elsewhere');
  assert.equal(second.first, 's1p010', 'most recently changed first');
  assert.ok(second.reads <= 3, 'repeat visit: changed products + 1 count, got ' + second.reads);
  assert.equal(second.n2, 39);
  assert.equal(second.gone, true);
  console.log('# reads: dashboard 40 frames: first', first.reads, 'then', second.reads);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('the shop dashboard opens and lists its frames with their pictures', async () => {
  const { browser, page, errors } = await shopPage();
  await page.goto(origin + '/#/partner');
  await page.waitForSelector('#partnerRoot img', { timeout: 20000 });
  const imgs = await page.locator('#partnerRoot img').count();
  assert.ok(imgs >= 10, 'thumbnails shown: ' + imgs);
  const src = await page.locator('#partnerRoot img').first().getAttribute('src');
  assert.match(src, /^data:image\//);
  await page.waitForTimeout(500);
  const l = await page.evaluate(() => window.__fakeReadLog.slice());
  assert.ok(l.some((x) => x === 'get catalogues/s1 1'), 'the index was checked once');
  assert.deepEqual(errors, []);
  await browser.close();
});

test('approving or suspending a shop rewrites its index; moderating a listing updates it', async () => {
  const { browser, page, errors } = await shopPage({ uid: 'admin1', email: 'admin@example.com' });
  const r = await page.evaluate(async () => {
    const B = await import('/backend.js');
    const store = window.__fakeStore;
    const out = {};
    // suspend s2: all its frames leave the index
    const shop = Object.assign({ id: 's2' }, store.get('shops/s2'));
    await B.adminSetShopStatus(shop, 'suspended', 'test');
    out.suspended = Object.keys(store.get('catalogues/s2').items).length;
    out.publicAfterSuspend = ['s2p000', 's2p001'].map((id) => store.get('products/' + id).public);
    // approve again: they come back
    await B.adminSetShopStatus(Object.assign({ id: 's2' }, store.get('shops/s2')), 'approved', '');
    out.approved = Object.keys(store.get('catalogues/s2').items).length;
    // suspend one listing, then restore it
    const p = await B.getProduct('s2p002');
    await B.adminModerateProduct(p, 'suspended', 'wrong photo', 'approved');
    out.afterModeration = !!store.get('catalogues/s2').items.s2p002;
    const p2 = await B.getProduct('s2p002');
    await B.adminModerateProduct(p2, 'ok', '', 'approved');
    out.afterRestore = !!store.get('catalogues/s2').items.s2p002;
    return out;
  });
  assert.equal(r.suspended, 0);
  assert.deepEqual(r.publicAfterSuspend, [false, false]);
  assert.equal(r.approved, 5);
  assert.equal(r.afterModeration, false);
  assert.equal(r.afterRestore, true);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('a shop photographs a frame: it is cut out, saved to Firestore and tried on by a customer', async () => {
  const fixture = (await import('node:path')).join((await import('./harness.mjs')).ROOT, 'tests/fixtures/metal-fullrim-stand.png');
  const { browser, context, page, errors } = await shopPage();
  // a new draft product of shop s1, without pictures yet
  await page.evaluate(async () => {
    const B = await import('/backend.js');
    await B.createProduct('s1', 'newframe1', { name: 'Photographed frame', status: 'draft', availability: 'in_stock',
      pricing: { pricePaise: 199900, currency: 'INR', taxMode: 'inclusive', taxRate: 18, confirmed: true },
      tags: { shape: 'rectangle', color: 'silver', gender: null, rim: null, free: [] } }, 'approved');
  });
  await page.goto(origin + '/#/add/newframe1');
  await page.waitForSelector('#addContent:not([hidden])');
  await page.setInputFiles('#frameFileInputEl', fixture);
  await page.waitForFunction(() => !document.getElementById('addToLibraryBtn').disabled, null, { timeout: 60000 });
  await page.click('#addToLibraryBtn');
  // a "please check" confirmation may appear for a doubtful extraction
  const ok = page.locator('.confirm-dialog .btn.primary, dialog .btn.primary').first();
  if (await ok.isVisible().catch(() => false)) await ok.click();
  await page.waitForFunction(() => location.hash.startsWith('#/partner'), null, { timeout: 30000 });
  const saved = await page.evaluate(() => {
    const p = window.__fakeStore.get('products/newframe1');
    const im = p.images || {};
    const f = im.cutout && window.__fakeStore.get('productFiles/' + im.cutout.fid);
    return {
      tryOn: p.tryOn.status, thumbInline: !!(im.thumb && im.thumb.data), manifestInline: !!(im.manifest && im.manifest.data),
      cutoutFid: im.cutout && im.cutout.fid, cutoutDoc: !!f, cutoutLen: f ? f.data.length : 0,
      sourceFid: im.source && im.source.fid, sourceDoc: !!(im.source && window.__fakeStore.get('productFiles/' + im.source.fid)),
      urls: JSON.stringify(im).includes('firebasestorage')
    };
  });
  assert.equal(saved.tryOn, 'ready');
  assert.equal(saved.thumbInline, true);
  assert.equal(saved.manifestInline, true);
  assert.match(saved.cutoutFid, /^newframe1__cutout-/);
  assert.equal(saved.cutoutDoc, true);
  assert.ok(saved.cutoutLen > 1000 && saved.cutoutLen <= 900000);
  assert.equal(saved.sourceDoc, true, 'original photo kept privately for re-processing');
  assert.equal(saved.urls, false, 'nothing in Cloud Storage');
  // publish, then a customer (no sign-in) finds it in the shop and tries it on
  await page.evaluate(async () => {
    const B = await import('/backend.js');
    const p = await B.getProduct('newframe1');
    await B.saveProduct(p, { status: 'published' }, 'approved');
  });
  const seedNow = await page.evaluate(() => {
    const out = {};
    const plain = (v) => v && typeof v.toMillis === 'function' ? { __ts: [v.seconds, v.nanoseconds] } : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
    for (const [k, v] of window.__fakeStore) out[k] = plain(v);
    return out;
  });
  await browser.close();
  const cust = await openBrowser({ fake: { seed: seedNow } });
  const cp = await cust.context.newPage();
  cp.setDefaultTimeout(20000);
  const cerr = collectErrors(cp);
  await cp.goto(origin + '/#/shop/s1');
  await cp.waitForSelector('#libraryRow .frame-card');
  assert.equal(await cp.locator('#libraryRow .frame-card').first().locator('.frame-card-link').textContent(), 'Photographed frame');
  await cp.locator('#libraryRow .frame-card').first().locator('.frame-card-tryon').click();
  await cp.waitForFunction(() => location.hash === '#/try-on/newframe1');
  await cp.waitForTimeout(500);
  if (await cp.isVisible('#liveStartBtn')) await cp.click('#liveStartBtn');
  await cp.waitForFunction(() => window.__stubFaceCalls > 10, null, { timeout: 20000 });
  await cp.waitForTimeout(800);
  const status = await cp.textContent('#liveStatus').catch(() => '');
  assert.ok(!/can.t|couldn|unavailable/i.test(status || ''), 'try-on running: ' + status);
  assert.equal((await cp.evaluate(() => window.__fakeReadLog)).filter((x) => x.startsWith('get productFiles/newframe1__cutout')).length, 1);
  assert.deepEqual(errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), []);
  assert.deepEqual(cerr.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), []);
  await cust.browser.close();
});
