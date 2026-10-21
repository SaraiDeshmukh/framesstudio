// The catalogue index entries (catalogue-index.js): what goes into a shop's
// index, what a customer's page gets back, and when a stored index differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexItem, entryFromItem, buildItems, sameItems, isTryOnReady, hasRef, imgSrc, INDEX_MAX_ITEMS } from '../catalogue-index.js';
import { priceView } from '../pricing.js';

function product(over) {
  return Object.assign({
    id: 'p1', shopId: 's1', name: '  Matte black rectangle ', sku: 'SKU-1', brand: 'House', colourName: 'Matte black', material: 'Acetate',
    frameType: 'eyeglasses', availability: 'in_stock', description: 'long text that stays out of the index', link: 'https://x.example/p1',
    tags: { shape: 'rectangle', color: 'black', gender: 'unisex', rim: 'fullrim', free: ['light', 'office'] },
    size: { eye: 52, bridge: 18, temple: 140 },
    pricing: { pricePaise: 249900, currency: 'INR', taxMode: 'inclusive', taxRate: 18, salePaise: 199900, confirmed: true, updatedAt: 5 },
    tryOn: { status: 'ready', level: '3d', rimType: 'full', translucent: false, prepared: 'auto' },
    images: { thumb: { path: 't', data: 'data:image/webp;base64,AAAA' }, cutout: { path: 'c', fid: 'p1__cutout-1' }, manifest: { path: 'm', data: 'data:application/json;base64,e30=' }, side: { path: 's', fid: 'p1__side-1' } },
    public: true, createdAt: 1000, updatedAt: 2000
  }, over || {});
}

test('an index entry has what cards, search, filters and sorting need, and nothing long', function () {
  var it = indexItem(product(), 1000, 2000);
  assert.equal(it.n, 'Matte black rectangle');
  assert.deepEqual(it.t, { shape: 'rectangle', color: 'black', gender: 'unisex', rim: 'fullrim', free: ['light', 'office'] });
  assert.deepEqual(it.z, { eye: 52, bridge: 18, temple: 140 });
  assert.deepEqual(it.pr, { p: 249900, m: 'inclusive', r: 18, s: 199900 });
  assert.equal(it.r, true); assert.equal(it.sd, true); assert.equal(it.l, '3d');
  assert.equal(it.c, 1000); assert.equal(it.u, 2000);
  var json = JSON.stringify(it);
  assert.ok(!/long text|data:|https:/.test(json), 'no description, link or pictures');
  assert.ok(json.length < 400, 'small: ' + json.length);
});

test('an entry rebuilt from the index matches the product for display and sorting', function () {
  var p = product();
  var e = entryFromItem('p1', indexItem(p, 1000, 2000), 's1');
  assert.equal(e.lite, true);
  assert.equal(e.name, 'Matte black rectangle');
  assert.equal(e.tryOnReady, true);
  assert.equal(e.hasSide, true);
  assert.equal(e.createdAt, 1000);
  assert.equal(e.updatedMs, 2000);
  assert.equal(e.thumbData, '');
  assert.deepEqual(priceView(e.pricing), priceView(p.pricing), 'same price shown and sorted');
  var none = entryFromItem('p2', indexItem(product({ pricing: { pricePaise: 100000, currency: 'INR', taxMode: 'none', confirmed: true } }), 1, 2), 's1');
  assert.deepEqual(priceView(none.pricing), priceView({ pricePaise: 100000, currency: 'INR', taxMode: 'none', confirmed: true }));
});

test('frames without try-on or price still index cleanly', function () {
  var it = indexItem(product({ tryOn: { status: 'none' }, images: { thumb: { path: 't', url: 'https://firebasestorage.googleapis.com/x' } }, pricing: null, tags: {}, size: null, sku: '' }), null, null);
  assert.equal(it.r, undefined); assert.equal(it.pr, undefined); assert.equal(it.t, undefined); assert.equal(it.z, undefined); assert.equal(it.k, undefined);
  var e = entryFromItem('p1', it, 's1');
  assert.equal(e.tryOnReady, false); assert.equal(e.pricing, null); assert.deepEqual(e.tags.free, []);
  for (var k of Object.keys(it)) assert.notEqual(it[k], undefined, 'Firestore rejects undefined: ' + k);
});

test('try-on is ready only with a cut-out and fitting data, from any store', function () {
  assert.equal(isTryOnReady(product()), true);
  assert.equal(isTryOnReady(product({ images: { thumb: { data: 'x' }, cutout: { url: 'u' }, manifest: { url: 'm' } } })), true);
  assert.equal(isTryOnReady(product({ images: { thumb: { data: 'x' }, cutout: { path: 'only-a-path' }, manifest: { url: 'm' } } })), false);
  assert.equal(isTryOnReady(product({ tryOn: { status: 'failed' } })), false);
  assert.equal(hasRef({ fid: 'a__b' }), true); assert.equal(hasRef({ path: 'x' }), false);
  assert.equal(imgSrc({ data: 'data:x' }), 'data:x'); assert.equal(imgSrc({ url: 'u', data: 'd' }), 'u'); assert.equal(imgSrc(null), '');
});

test('the index lists public products only, and notices any difference', function () {
  var items = buildItems([product(), product({ id: 'p2', public: false }), product({ id: 'p3', name: 'Gold round' })]);
  assert.deepEqual(Object.keys(items).sort(), ['p1', 'p3']);
  var millis = function (v) { return typeof v === 'number' ? v : (v && v.ms) || null; };
  var copy = JSON.parse(JSON.stringify(items));
  copy.p1.c = { ms: 1000 }; copy.p1.u = { ms: 2000 };       // timestamps stored differently, same moment
  assert.equal(sameItems(items, copy, millis), true);
  copy.p3.n = 'Gold round 2';
  assert.equal(sameItems(items, copy, millis), false);
  delete copy.p3;
  assert.equal(sameItems(items, copy, millis), false);
  assert.ok(INDEX_MAX_ITEMS * 400 < 1048576, 'a full index stays under the 1 MiB document limit');
});
