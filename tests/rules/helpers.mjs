// Shared setup for the security-rules tests. They run inside the Firebase
// emulators (npm run test:rules), never against the real project.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { serverTimestamp } from 'firebase/firestore';

export var PROJECT_ID = 'demo-frame-studio';

export async function makeEnv() {
  var fsHost = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  var stHost = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':');
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host: fsHost[0], port: +fsHost[1] },
    storage: { rules: readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8'), host: stHost[0], port: +stHost[1] }
  });
}

// People in the tests.
export var ADMIN = 'admin1';
export var A = 'retailerA';         // approved shop
export var B = 'retailerB';         // approved shop
export var P = 'retailerP';         // pending shop
export var S = 'retailerS';         // suspended shop
export var CUSTOMER = 'customer1';  // signed in, no shop
export var NEWBIE = 'newbie1';      // signed in, about to apply

export var VERIFIED = { email_verified: true };
export var ANON = { firebase: { sign_in_provider: 'anonymous' } };

export function storageUrl(path) {
  return 'https://firebasestorage.googleapis.com/v0/b/demo-frame-studio.appspot.com/o/' + encodeURIComponent(path) + '?alt=media&token=abc';
}

export function img(shopId, productId, name, withUrl) {
  var path = 'shops/' + shopId + '/products/' + productId + '/assets/' + name;
  var o = { path: path, w: 260, h: 260, bytes: 12000 };
  if (withUrl !== false) o.url = storageUrl(path);
  return o;
}

export function pricing(over) {
  return Object.assign({ pricePaise: 249900, currency: 'INR', taxMode: 'inclusive', taxRate: 18, confirmed: true, updatedAt: serverTimestamp() }, over || {});
}

// A draft with only the required fields.
export function draft(shopId, over) {
  return Object.assign({
    shopId: shopId, name: 'Black rectangle', status: 'draft', moderation: { state: 'ok' }, public: false,
    tryOn: { status: 'none' }, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  }, over || {});
}

// Everything needed to be shown to customers (as a no-try-on listing).
export function complete(shopId, productId, over) {
  return draft(shopId, Object.assign({
    pricing: pricing(), availability: 'in_stock',
    images: { thumb: img(shopId, productId, 'thumb-1.webp') },
    tags: { shape: 'rectangle', color: 'black', gender: null, rim: 'fullrim', free: [] },
    size: { eye: 52, bridge: 18, temple: 140 }
  }, over || {}));
}

export function shop(uid, status, over) {
  return Object.assign({
    name: 'Shop ' + uid, city: 'Amravati', status: status, ownerUid: uid,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  }, over || {});
}

// Seeds the world the tests start from (rules switched off while seeding).
export async function seed(env) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async function (ctx) {
    var db = ctx.firestore();
    var { doc, setDoc } = await import('firebase/firestore');
    await setDoc(doc(db, 'admins', ADMIN), { email: 'admin@example.com' });
    await setDoc(doc(db, 'config', 'legal'), {
      retailerTerms: { version: '1.0', date: '2026-10-12' }, customerTerms: { version: '1.0', date: '2026-10-12' },
      privacy: { version: '1.0', date: '2026-10-12' }, updatedAt: serverTimestamp(), updatedBy: ADMIN
    });
    var shops = { [A]: 'approved', [B]: 'approved', [P]: 'pending', [S]: 'suspended' };
    for (var uid of Object.keys(shops)) {
      await setDoc(doc(db, 'shops', uid), shop(uid, shops[uid]));
      await setDoc(doc(db, 'shopPrivate', uid), { ownerName: 'Owner ' + uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      for (var d of ['retailerTerms', 'privacy']) {
        await setDoc(doc(db, 'acceptances', uid + '_' + d + '_1.0'), { uid: uid, doc: d, version: '1.0', acceptedAt: serverTimestamp() });
      }
    }
    await setDoc(doc(db, 'products', 'pA1'), complete(A, 'pA1', { status: 'published', public: true }));
    await setDoc(doc(db, 'products', 'pA2'), draft(A));
    await setDoc(doc(db, 'products', 'pB1'), complete(B, 'pB1', { status: 'published', public: true }));
    await setDoc(doc(db, 'products', 'pB2'), draft(B));
    await setDoc(doc(db, 'products', 'pP1'), complete(P, 'pP1', { status: 'published', public: false }));
    await setDoc(doc(db, 'products', 'pS1'), complete(S, 'pS1', { status: 'published', public: false }));
    await setDoc(doc(db, 'users', A, 'frames', 'old1'), { tags: {} });
  });
}
