// Cloud Storage rules, tested in the emulator (they read Firestore for shop
// status and product ownership, so both emulators run together).
import { test, before, beforeEach, after } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
import { makeEnv, seed, ADMIN, A, B, S, CUSTOMER, VERIFIED, ANON } from './helpers.mjs';

var env;
before(async function () { env = await makeEnv(); });
beforeEach(async function () {
  await seed(env);
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async function (ctx) {
    await uploadBytes(ref(ctx.storage(), 'shops/' + A + '/products/pA1/assets/thumb-1.webp'), png(100), { contentType: 'image/webp' });
    await uploadBytes(ref(ctx.storage(), 'shops/' + A + '/products/pA1/source/source-1.jpg'), png(100), { contentType: 'image/jpeg' });
  });
});
after(async function () { if (env) await env.cleanup(); });

function st(uid, token) { return env.authenticatedContext(uid, token).storage(); }
function guest() { return env.unauthenticatedContext().storage(); }
function png(n) { var b = new Uint8Array(n); b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; return b; }
function path(shopId, productId, kind, file) { return 'shops/' + shopId + '/products/' + productId + '/' + kind + '/' + file; }

test('a retailer uploads frame photos and try-on assets for their own products', async function () {
  var s = st(A, VERIFIED);
  await assertSucceeds(uploadBytes(ref(s, path(A, 'pA2', 'source', 'source-2.jpg')), png(5000), { contentType: 'image/jpeg' }));
  await assertSucceeds(uploadBytes(ref(s, path(A, 'pA2', 'assets', 'cutout-2.png')), png(5000), { contentType: 'image/png' }));
  await assertSucceeds(uploadBytes(ref(s, path(A, 'pA2', 'assets', 'thumb-2.webp')), png(500), { contentType: 'image/webp' }));
  await assertSucceeds(uploadBytes(ref(s, path(A, 'pA2', 'assets', 'asset-2.json')), new TextEncoder().encode('{"v":1}'), { contentType: 'application/json' }));
});

test('a retailer cannot write into another shop or onto another shop\'s product', async function () {
  var s = st(B, VERIFIED);
  await assertFails(uploadBytes(ref(s, path(A, 'pA2', 'assets', 'cutout-x.png')), png(500), { contentType: 'image/png' }));
  await assertFails(uploadBytes(ref(s, path(B, 'pA2', 'assets', 'cutout-x.png')), png(500), { contentType: 'image/png' }));   // A's product under B's folder
  await assertFails(uploadBytes(ref(s, path(B, 'noSuchProduct', 'assets', 'cutout-x.png')), png(500), { contentType: 'image/png' }));
  await assertFails(deleteObject(ref(s, path(A, 'pA1', 'assets', 'thumb-1.webp'))));
  await assertFails(getBytes(ref(s, path(A, 'pA1', 'source', 'source-1.jpg'))));
});

test('only images of a sensible size are accepted', async function () {
  var s = st(A, VERIFIED);
  await assertFails(uploadBytes(ref(s, path(A, 'pA2', 'assets', 'page.html')), new TextEncoder().encode('<script>'), { contentType: 'text/html' }));
  await assertFails(uploadBytes(ref(s, path(A, 'pA2', 'assets', 'logo.svg')), new TextEncoder().encode('<svg/>'), { contentType: 'image/svg+xml' }));
  await assertFails(uploadBytes(ref(s, path(A, 'pA2', 'assets', 'big.png')), new Uint8Array(4 * 1024 * 1024 + 1), { contentType: 'image/png' }));
  await assertFails(uploadBytes(ref(s, path(A, 'pA2', 'source', 'big.jpg')), new Uint8Array(8 * 1024 * 1024 + 1), { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(s, path(A, 'pA2', 'other', 'x.png')), png(500), { contentType: 'image/png' }));
  await assertFails(uploadBytes(ref(s, path(A, 'pA2', 'assets', 'bad name.png')), png(500), { contentType: 'image/png' }));
});

test('a suspended shop cannot upload', async function () {
  await assertFails(uploadBytes(ref(st(S, VERIFIED), path(S, 'pS1', 'assets', 'cutout-1.png')), png(500), { contentType: 'image/png' }));
});

test('stored files are read through the API only by their shop and the admin', async function () {
  await assertSucceeds(getBytes(ref(st(A, VERIFIED), path(A, 'pA1', 'source', 'source-1.jpg'))));
  await assertSucceeds(getBytes(ref(st(ADMIN, VERIFIED), path(A, 'pA1', 'source', 'source-1.jpg'))));
  await assertFails(getBytes(ref(guest(), path(A, 'pA1', 'source', 'source-1.jpg'))));
  await assertFails(getBytes(ref(st(CUSTOMER, VERIFIED), path(A, 'pA1', 'assets', 'thumb-1.webp'))));
  await assertSucceeds(deleteObject(ref(st(ADMIN, VERIFIED), path(A, 'pA1', 'assets', 'thumb-1.webp'))));
});

test('there is nowhere for a customer photo to go', async function () {
  for (var s of [guest(), st('anonDevice', ANON), st(CUSTOMER, VERIFIED), st(A, VERIFIED)]) {
    for (var p of ['faces/selfie.jpg', 'uploads/photo.jpg', 'tryon/' + CUSTOMER + '.png', 'customers/x/photo.jpg', 'shops/' + A + '/faces/x.jpg']) {
      await assertFails(uploadBytes(ref(s, p), png(500), { contentType: 'image/jpeg' }));
    }
  }
});
