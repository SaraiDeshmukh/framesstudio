// Security rules for the free (Spark) plan additions: frame pictures kept in
// Firestore (productFiles, and small ones inline on the product) and each
// shop's catalogue index (catalogues/{shopId}). Run in the emulator with the
// same people as firestore.rules.test.mjs.
import { test, before, beforeEach, after } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, writeBatch, serverTimestamp, deleteField, FieldPath
} from 'firebase/firestore';
import { makeEnv, seed, ADMIN, A, B, P, S, CUSTOMER, VERIFIED, ANON, draft, pricing } from './helpers.mjs';

var env;
before(async function () { env = await makeEnv(); });
beforeEach(async function () { await seed(env); });
after(async function () { if (env) await env.cleanup(); });

function as(uid, token) { return env.authenticatedContext(uid, token).firestore(); }
function guest() { return env.unauthenticatedContext().firestore(); }

var PNG = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(10);
function thumbData(n) { return 'data:image/webp;base64,' + 'A'.repeat(n || 12000); }
function manifestData() { return 'data:application/json;base64,' + 'eyJ2IjoxfQ=='; }
function file(shopId, productId, kind, extra) {
  return Object.assign({ shopId: shopId, productId: productId, kind: kind || 'assets', type: 'image/png', data: PNG, bytes: 80, w: 10, h: 10, createdAt: serverTimestamp() }, extra || {});
}
function path(shopId, productId, kind, name) { return 'shops/' + shopId + '/products/' + productId + '/' + kind + '/' + name; }
// The images the app writes on the free plan.
function freeImages(shopId, id, over) {
  return Object.assign({
    thumb: { path: path(shopId, id, 'assets', 'thumb-1.webp'), w: 260, h: 260, bytes: 9000, data: thumbData() },
    cutout: { path: path(shopId, id, 'assets', 'cutout-1.png'), w: 890, h: 297, bytes: 100000, fid: id + '__cutout-1' },
    manifest: { path: path(shopId, id, 'assets', 'asset-1.json'), bytes: 3200, data: manifestData() },
    source: { path: path(shopId, id, 'source', 'source-1.jpg'), w: 1600, h: 1200, bytes: 400000, fid: id + '__source-1' }
  }, over || {});
}

// ---------- productFiles ----------

test('a shop stores picture documents for its own products only', async function () {
  var a = as(A, VERIFIED);
  await assertSucceeds(setDoc(doc(a, 'productFiles', 'pA2__cutout-1'), file(A, 'pA2')));
  await assertSucceeds(setDoc(doc(a, 'productFiles', 'pA2__source-1'), file(A, 'pA2', 'source', { type: 'image/jpeg', data: 'data:image/jpeg;base64,/9j/4AAQ' })));
  // another shop's product, a product that doesn't exist, a name for another product
  await assertFails(setDoc(doc(as(B, VERIFIED), 'productFiles', 'pA2__cutout-2'), file(B, 'pA2')));
  await assertFails(setDoc(doc(as(B, VERIFIED), 'productFiles', 'pA2__cutout-3'), file(A, 'pA2')));
  await assertFails(setDoc(doc(a, 'productFiles', 'nope__cutout-1'), file(A, 'nope')));
  await assertFails(setDoc(doc(a, 'productFiles', 'pB2__cutout-1'), file(A, 'pA2')));
  // customers and anonymous devices
  await assertFails(setDoc(doc(guest(), 'productFiles', 'pA2__x-1'), file(A, 'pA2')));
  await assertFails(setDoc(doc(as('anonDevice', ANON), 'productFiles', 'pA2__x-1'), file('anonDevice', 'pA2')));
  // a suspended shop can't add pictures; a pending one can (drafts)
  await assertFails(setDoc(doc(as(S, VERIFIED), 'productFiles', 'pS1__cutout-1'), file(S, 'pS1')));
  await assertSucceeds(setDoc(doc(as(P, VERIFIED), 'productFiles', 'pP1__cutout-1'), file(P, 'pP1')));
});

test('picture documents are checked and never change', async function () {
  var a = as(A, VERIFIED);
  await assertFails(setDoc(doc(a, 'productFiles', 'pA2__c-1'), file(A, 'pA2', 'assets', { data: 'https://evil.example.com/x.png' })));
  await assertFails(setDoc(doc(a, 'productFiles', 'pA2__c-2'), file(A, 'pA2', 'assets', { type: 'text/html' })));
  await assertFails(setDoc(doc(a, 'productFiles', 'pA2__c-3'), file(A, 'pA2', 'other')));
  await assertFails(setDoc(doc(a, 'productFiles', 'pA2__c-4'), file(A, 'pA2', 'assets', { extra: 1 })));
  await assertFails(setDoc(doc(a, 'productFiles', 'pA2__c-5'), file(A, 'pA2', 'assets', { createdAt: new Date(0) })));
  await assertFails(setDoc(doc(a, 'productFiles', 'pA2__c-6'), file(A, 'pA2', 'assets', { data: 'data:image/png;base64,' + 'A'.repeat(1000001) })));
  await assertSucceeds(setDoc(doc(a, 'productFiles', 'pA2__c-7'), file(A, 'pA2', 'assets', { data: 'data:image/png;base64,' + 'A'.repeat(880000) })));
  await assertFails(updateDoc(doc(a, 'productFiles', 'pA2__c-7'), { data: PNG }));
});

test('customer pictures are readable by name but not listable; original photos stay private', async function () {
  await env.withSecurityRulesDisabled(async function (ctx) {
    var db = ctx.firestore();
    await setDoc(doc(db, 'productFiles', 'pA1__cutout-1'), file(A, 'pA1'));
    await setDoc(doc(db, 'productFiles', 'pA1__source-1'), file(A, 'pA1', 'source'));
  });
  for (var db of [guest(), as(CUSTOMER, VERIFIED), as(B, VERIFIED)]) {
    await assertSucceeds(getDoc(doc(db, 'productFiles', 'pA1__cutout-1')));
    await assertFails(getDoc(doc(db, 'productFiles', 'pA1__source-1')));
    await assertFails(getDocs(collection(db, 'productFiles')));
  }
  await assertSucceeds(getDoc(doc(as(A, VERIFIED), 'productFiles', 'pA1__source-1')));
  await assertSucceeds(getDoc(doc(as(ADMIN, VERIFIED), 'productFiles', 'pA1__source-1')));
  await assertFails(deleteDoc(doc(as(B, VERIFIED), 'productFiles', 'pA1__cutout-1')));
  await assertSucceeds(deleteDoc(doc(as(A, VERIFIED), 'productFiles', 'pA1__cutout-1')));
  await assertSucceeds(deleteDoc(doc(as(ADMIN, VERIFIED), 'productFiles', 'pA1__source-1')));
});

// ---------- pictures on the product ----------

test('a product can show inline and Firestore-stored pictures, and be published with them', async function () {
  var a = as(A, VERIFIED);
  await assertSucceeds(updateDoc(doc(a, 'products', 'pA2'), {
    images: freeImages(A, 'pA2'), pricing: pricing(), availability: 'in_stock',
    tryOn: { status: 'ready', level: '3d', prepared: 'auto', updatedAt: serverTimestamp() },
    status: 'published', public: true, updatedAt: serverTimestamp()
  }));
  var snap = await assertSucceeds(getDoc(doc(guest(), 'products', 'pA2')));
  if (!snap.data().public) throw new Error('should be public');
});

test('inline pictures are small data: URLs, file references belong to the product, the original is never inline', async function () {
  var a = as(A, VERIFIED);
  function upd(images) { return updateDoc(doc(a, 'products', 'pA2'), { images: images, updatedAt: serverTimestamp() }); }
  await assertFails(upd(freeImages(A, 'pA2', { thumb: { path: path(A, 'pA2', 'assets', 'thumb-1.webp'), data: thumbData(40001) } })));
  await assertFails(upd(freeImages(A, 'pA2', { thumb: { path: path(A, 'pA2', 'assets', 'thumb-1.webp'), data: 'javascript:alert(1)' } })));
  await assertFails(upd(freeImages(A, 'pA2', { cutout: { path: path(A, 'pA2', 'assets', 'cutout-1.png'), fid: 'pB1__cutout-1' } })));
  await assertFails(upd(freeImages(A, 'pA2', { source: { path: path(A, 'pA2', 'source', 'source-1.jpg'), data: 'data:image/jpeg;base64,/9j/' } })));
  await assertSucceeds(upd(freeImages(A, 'pA2', { thumb: { path: path(A, 'pA2', 'assets', 'thumb-1.webp'), data: thumbData(39000) } })));
});

test('the fullest free-plan product fits within the rules\' evaluation limits', async function () {
  var a = as(A, VERIFIED);
  var id = 'fp1';
  var details = {
    name: 'Matte black rectangle', sku: 'SKU-fp1', brand: 'House brand', frameType: 'eyeglasses',
    colourName: 'Matte black', material: 'Acetate', description: 'd'.repeat(1000), link: 'https://shop.example.com/p/fp1',
    legacyId: 'legacy-fp1', availability: 'in_stock',
    tags: { shape: 'rectangle', color: 'black', gender: 'unisex', rim: 'fullrim', free: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] },
    size: { eye: 52, bridge: 18, temple: 140 },
    pricing: pricing({ taxMode: 'exclusive', taxRate: 12.5, salePaise: 199900, hsn: '9003' }),
    tryOn: { status: 'pending' }
  };
  await assertSucceeds(setDoc(doc(a, 'products', id), draft(A, details)));
  var images = freeImages(A, id, {
    thumb: { path: path(A, id, 'assets', 'thumb-1.webp'), w: 260, h: 260, bytes: 29000, data: thumbData(39900) },
    side: { path: path(A, id, 'assets', 'side-1.png'), w: 600, h: 200, bytes: 50000, fid: id + '__side-1' }
  });
  var b = writeBatch(a);
  b.update(doc(a, 'products', id), {
    images: images,
    tryOn: { status: 'ready', level: '3d', prepared: 'auto', quality: 0.92, rimType: 'full', translucent: false,
      warnings: Array.from({ length: 30 }, function (_, i) { return 'w' + i; }), error: null, hasSide: true, updatedAt: serverTimestamp() },
    assetBytes: 480000, status: 'published', public: true, updatedAt: serverTimestamp()
  });
  b.set(doc(a, 'catalogues', A), { v: 1, updatedAt: serverTimestamp(), items: { [id]: { n: 'Matte black rectangle', r: true, c: serverTimestamp(), u: serverTimestamp() } } },
    { mergeFields: [new FieldPath('items', id), 'v', 'updatedAt'] });
  await assertSucceeds(b.commit());
});

// ---------- catalogue index ----------

test('anyone reads a shop\'s catalogue index; only the shop and the admin write it', async function () {
  var item = { n: 'Black rectangle', t: { shape: 'rectangle' }, pr: { p: 249900, m: 'inclusive', r: 18 }, a: 'in_stock', c: serverTimestamp(), u: serverTimestamp() };
  await assertSucceeds(setDoc(doc(as(A, VERIFIED), 'catalogues', A), { v: 1, items: { pA1: item }, updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(guest(), 'catalogues', A)));
  await assertSucceeds(getDoc(doc(as('anonDevice', ANON), 'catalogues', A)));
  await assertFails(getDocs(collection(guest(), 'catalogues')));
  await assertFails(setDoc(doc(as(B, VERIFIED), 'catalogues', A), { v: 1, items: {}, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(guest(), 'catalogues', A), { v: 1, items: {}, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as(CUSTOMER, VERIFIED), 'catalogues', CUSTOMER + 'x'), { v: 1, items: {}, updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(as(ADMIN, VERIFIED), 'catalogues', B), { v: 1, items: {}, updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(as(B, VERIFIED), 'catalogues', A)));
  await assertSucceeds(deleteDoc(doc(as(A, VERIFIED), 'catalogues', A)));
});

test('the catalogue index is checked for shape and size', async function () {
  var a = as(A, VERIFIED);
  await assertFails(setDoc(doc(a, 'catalogues', A), { v: 1, items: {}, updatedAt: new Date(0) }));
  await assertFails(setDoc(doc(a, 'catalogues', A), { v: 1, items: {}, other: 1, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(a, 'catalogues', A), { v: 1, items: 'x', updatedAt: serverTimestamp() }));
  var many = {};
  for (var i = 0; i < 2001; i++) many['p' + i] = { n: 'x' };
  await assertFails(setDoc(doc(a, 'catalogues', A), { v: 1, items: many, updatedAt: serverTimestamp() }));
  delete many.p0;
  await assertSucceeds(setDoc(doc(a, 'catalogues', A), { v: 1, items: many, updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(a, 'catalogues', A), { v: 1, overflow: true, items: {}, updatedAt: serverTimestamp() }));
});

test('a product write and its index entry go together, as the app sends them', async function () {
  var a = as(A, VERIFIED);
  var b = writeBatch(a);
  b.update(doc(a, 'products', 'pA1'), { name: 'Renamed frame', updatedAt: serverTimestamp() });
  b.set(doc(a, 'catalogues', A), { v: 1, updatedAt: serverTimestamp(), items: { pA1: { n: 'Renamed frame', c: serverTimestamp(), u: serverTimestamp() } } },
    { mergeFields: [new FieldPath('items', 'pA1'), 'v', 'updatedAt'] });
  await assertSucceeds(b.commit());
  // removing it when unpublished
  var b2 = writeBatch(a);
  b2.update(doc(a, 'products', 'pA1'), { status: 'draft', public: false, updatedAt: serverTimestamp() });
  b2.set(doc(a, 'catalogues', A), { v: 1, updatedAt: serverTimestamp(), items: { pA1: deleteField() } },
    { mergeFields: [new FieldPath('items', 'pA1'), 'v', 'updatedAt'] });
  await assertSucceeds(b2.commit());
  var idx = await getDoc(doc(guest(), 'catalogues', A));
  if (Object.keys(idx.data().items).length !== 0) throw new Error('entry should be gone');
  // B can't slip an entry into A's index alongside its own product write
  var bb = as(B, VERIFIED), b3 = writeBatch(bb);
  b3.update(doc(bb, 'products', 'pB1'), { name: 'B frame', updatedAt: serverTimestamp() });
  b3.set(doc(bb, 'catalogues', A), { v: 1, updatedAt: serverTimestamp(), items: { pB1: { n: 'B frame' } } },
    { mergeFields: [new FieldPath('items', 'pB1'), 'v', 'updatedAt'] });
  await assertFails(b3.commit());
});
