// The admin adding and publishing frames for a shop (for example loading a
// shop's photos in bulk): allowed for active shops, with the same field
// checks; never for suspended shops, never by other retailers.
import { test, before, beforeEach, after } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp, FieldPath } from 'firebase/firestore';
import { makeEnv, seed, ADMIN, A, B, P, S, VERIFIED, draft, pricing } from './helpers.mjs';

var env;
before(async function () { env = await makeEnv(); });
beforeEach(async function () { await seed(env); });
after(async function () { if (env) await env.cleanup(); });
function as(uid, token) { return env.authenticatedContext(uid, token).firestore(); }
function guest() { return env.unauthenticatedContext().firestore(); }

var THUMB = 'data:image/webp;base64,' + 'A'.repeat(9000);
function path(shopId, id, kind, name) { return 'shops/' + shopId + '/products/' + id + '/' + kind + '/' + name; }
function file(shopId, productId, kind) {
  return { shopId: shopId, productId: productId, kind: kind || 'assets', type: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo', bytes: 9, createdAt: serverTimestamp() };
}

test('the admin creates a frame for a shop, adds its pictures and publishes it without a price', async function () {
  var db = as(ADMIN, VERIFIED);
  var id = 'adm1';
  await assertSucceeds(setDoc(doc(db, 'products', id), draft(A, { name: 'Tiger 004 rectangle', sku: '004', brand: 'Tiger Eyewear',
    tags: { shape: 'rectangle', color: 'black', gender: 'mens', rim: 'fullrim', free: [] }, size: { eye: 47, bridge: 18, temple: 138 },
    frameType: 'eyeglasses', material: 'Metal', legacyId: 'pkg:x:p04a', tryOn: { status: 'pending' } })));
  await assertSucceeds(setDoc(doc(db, 'productFiles', id + '__cutout-1'), file(A, id)));
  await assertSucceeds(setDoc(doc(db, 'productFiles', id + '__source-1'), file(A, id, 'source')));
  var b = writeBatch(db);
  b.update(doc(db, 'products', id), {
    images: {
      thumb: { path: path(A, id, 'assets', 'thumb-1.webp'), w: 260, h: 260, bytes: 6000, data: THUMB },
      cutout: { path: path(A, id, 'assets', 'cutout-1.png'), w: 900, h: 300, bytes: 90000, fid: id + '__cutout-1' },
      manifest: { path: path(A, id, 'assets', 'asset-1.json'), bytes: 3000, data: 'data:application/json;base64,e30=' },
      source: { path: path(A, id, 'source', 'source-1.jpg'), w: 1200, h: 400, bytes: 90000, fid: id + '__source-1' }
    },
    tryOn: { status: 'ready', level: '3d', prepared: 'auto', quality: 0.88, warnings: [], hasSide: false, updatedAt: serverTimestamp() },
    assetBytes: 189000, availability: 'in_stock', status: 'published', public: true, updatedAt: serverTimestamp()
  });
  b.set(doc(db, 'catalogues', A), { v: 1, updatedAt: serverTimestamp(), items: { [id]: { n: 'Tiger 004 rectangle', r: true, c: serverTimestamp(), u: serverTimestamp() } } },
    { mergeFields: [new FieldPath('items', id), 'v', 'updatedAt'] });
  await assertSucceeds(b.commit());
  await assertSucceeds(getDoc(doc(guest(), 'products', id)));
  // later: the admin (or the shop) adds the price
  await assertSucceeds(updateDoc(doc(db, 'products', id), { pricing: pricing(), updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as(A, VERIFIED), 'products', id), { pricing: pricing({ pricePaise: 199900 }), updatedAt: serverTimestamp() }));
});

test('the admin can\'t move a frame to another shop, fake its moderation or dates, or skip the checks', async function () {
  var db = as(ADMIN, VERIFIED);
  await assertSucceeds(setDoc(doc(db, 'products', 'adm2'), draft(A)));
  await assertFails(updateDoc(doc(db, 'products', 'adm2'), { shopId: B, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'products', 'adm2'), { createdAt: new Date(0), updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'products', 'adm2'), { name: 'x'.repeat(81), updatedAt: serverTimestamp() }));
  // public must match: a draft can't be marked public
  await assertFails(updateDoc(doc(db, 'products', 'adm2'), { public: true, updatedAt: serverTimestamp() }));
  // a price must carry its tax confirmation to go public
  await assertSucceeds(updateDoc(doc(db, 'products', 'adm2'), { pricing: pricing({ confirmed: false }), availability: 'in_stock', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'products', 'adm2'), { status: 'published', public: true, images: { thumb: { path: path(A, 'adm2', 'assets', 't.webp'), data: THUMB } }, updatedAt: serverTimestamp() }));
  // new products start without photos, and with moderation ok
  await assertFails(setDoc(doc(db, 'products', 'adm3'), draft(A, { images: { thumb: { path: path(A, 'adm3', 'assets', 't.webp'), data: THUMB } } })));
  await assertFails(setDoc(doc(db, 'products', 'adm4'), draft(A, { moderation: { state: 'suspended' } })));
});

test('the admin can\'t add frames to a suspended shop', async function () {
  var db = as(ADMIN, VERIFIED);
  await assertFails(setDoc(doc(db, 'products', 'adm5'), draft(S)));
  await assertSucceeds(setDoc(doc(db, 'products', 'adm6'), draft(P)));     // pending: prepared, not shown
});

test('other retailers still can\'t add frames or pictures to someone else\'s shop', async function () {
  var bdb = as(B, VERIFIED);
  await assertFails(setDoc(doc(bdb, 'products', 'x9'), draft(A)));
  await assertSucceeds(setDoc(doc(as(ADMIN, VERIFIED), 'products', 'adm7'), draft(A)));
  await assertFails(setDoc(doc(bdb, 'productFiles', 'adm7__c-1'), file(A, 'adm7')));
  await assertFails(setDoc(doc(bdb, 'productFiles', 'adm7__c-2'), file(B, 'adm7')));
  await assertFails(updateDoc(doc(bdb, 'products', 'adm7'), { name: 'Hacked', updatedAt: serverTimestamp() }));
  // a picture document must name the product's real shop, even for the admin
  await assertFails(setDoc(doc(as(ADMIN, VERIFIED), 'productFiles', 'adm7__c-3'), file(B, 'adm7')));
});
