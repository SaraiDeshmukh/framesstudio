// Firestore security rules, tested in the emulator with signed-in users who
// stand for each role: the admin, retailers A and B (approved), P (pending),
// S (suspended), an ordinary signed-in customer, an anonymous device and
// someone not signed in at all.
import { test, before, beforeEach, after } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs, writeBatch, serverTimestamp
} from 'firebase/firestore';
import {
  makeEnv, seed, ADMIN, A, B, P, S, CUSTOMER, NEWBIE, VERIFIED, ANON, draft, complete, pricing, img, shop
} from './helpers.mjs';

var env;
before(async function () { env = await makeEnv(); });
beforeEach(async function () { await seed(env); });
after(async function () { if (env) await env.cleanup(); });

function as(uid, token) { return env.authenticatedContext(uid, token).firestore(); }
function guest() { return env.unauthenticatedContext().firestore(); }

// ---------- customers and the public ----------

test('anyone can read approved shops and public products, nothing else', async function () {
  var db = guest();
  await assertSucceeds(getDoc(doc(db, 'shops', A)));
  await assertFails(getDoc(doc(db, 'shops', P)));
  await assertFails(getDoc(doc(db, 'shops', S)));
  await assertSucceeds(getDocs(query(collection(db, 'shops'), where('status', '==', 'approved'))));
  await assertFails(getDocs(collection(db, 'shops')));
  await assertSucceeds(getDoc(doc(db, 'products', 'pA1')));
  await assertFails(getDoc(doc(db, 'products', 'pA2')));
  await assertFails(getDoc(doc(db, 'products', 'pP1')));
  await assertSucceeds(getDocs(query(collection(db, 'products'), where('public', '==', true), where('shopId', '==', A))));
  await assertFails(getDocs(query(collection(db, 'products'), where('shopId', '==', A))));
  await assertFails(getDoc(doc(db, 'shopPrivate', A)));
  await assertFails(getDocs(collection(db, 'acceptances')));
  await assertFails(getDocs(collection(db, 'reports')));
  await assertFails(getDocs(collection(db, 'auditLog')));
  await assertFails(getDoc(doc(db, 'admins', ADMIN)));
  await assertSucceeds(getDoc(doc(db, 'config', 'legal')));
});

test('customers cannot change the catalogue or reach retailer/admin data', async function () {
  for (var db of [guest(), as(CUSTOMER, VERIFIED), as('anonDevice', ANON)]) {
    await assertFails(setDoc(doc(db, 'products', 'x1'), draft(CUSTOMER)));
    await assertFails(updateDoc(doc(db, 'products', 'pA1'), { name: 'Hacked', updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(db, 'products', 'pA1')));
    await assertFails(updateDoc(doc(db, 'shops', A), { status: 'suspended', updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(db, 'config', 'platform'), { applicationsOpen: false, updatedAt: serverTimestamp(), updatedBy: CUSTOMER }));
    await assertFails(getDoc(doc(db, 'shopPrivate', A)));
    await assertFails(getDocs(collection(db, 'auditLog')));
  }
});

// ---------- nobody can make themselves an admin ----------

test('a normal user cannot promote themselves to admin', async function () {
  var db = as(CUSTOMER, VERIFIED);
  await assertFails(setDoc(doc(db, 'admins', CUSTOMER), { email: 'me@example.com' }));
  await assertFails(getDocs(collection(db, 'admins')));
  // a retailer approving their own shop is the same thing in disguise
  var p = as(P, VERIFIED);
  await assertFails(updateDoc(doc(p, 'shops', P), { status: 'approved', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(p, 'shops', P), { status: 'approved', statusAt: serverTimestamp(), reviewedBy: P, updatedAt: serverTimestamp() }));
  // and the admin collection can't be written even by an admin from the app
  await assertFails(setDoc(doc(as(ADMIN, VERIFIED), 'admins', CUSTOMER), { email: 'x' }));
});

// ---------- tenant isolation ----------

test('retailer B cannot read, change, delete or publish retailer A\'s products', async function () {
  var db = as(B, VERIFIED);
  await assertFails(getDoc(doc(db, 'products', 'pA2')));                                     // A's draft
  await assertFails(getDocs(query(collection(db, 'products'), where('shopId', '==', A))));    // A's whole list
  await assertSucceeds(getDoc(doc(db, 'products', 'pA1')));                                  // A's public product, like anyone
  await assertFails(updateDoc(doc(db, 'products', 'pA1'), { name: 'Mine now', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'products', 'pA2'), { status: 'published', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'products', 'pA1'), { shopId: B, updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(db, 'products', 'pA2')));
  await assertFails(setDoc(doc(db, 'products', 'pA2'), draft(B)));                            // overwrite by id
  await assertFails(setDoc(doc(db, 'products', 'newForA'), draft(A)));                        // create in A's name
  await assertFails(getDoc(doc(db, 'shopPrivate', A)));
  await assertFails(updateDoc(doc(db, 'shops', A), { name: 'Taken over', updatedAt: serverTimestamp() }));
  // moving their own product into A's shop
  await assertFails(updateDoc(doc(db, 'products', 'pB2'), { shopId: A, updatedAt: serverTimestamp() }));
  // pointing their listing at A's stored pictures
  await assertFails(updateDoc(doc(db, 'products', 'pB2'), { images: { thumb: img(A, 'pA1', 'thumb-1.webp') }, updatedAt: serverTimestamp() }));
});

test('a retailer reads and lists only their own products', async function () {
  var db = as(A, VERIFIED);
  await assertSucceeds(getDoc(doc(db, 'products', 'pA2')));
  var res = await assertSucceeds(getDocs(query(collection(db, 'products'), where('shopId', '==', A))));
  if (res.size !== 2) throw new Error('expected 2 products, got ' + res.size);
  await assertSucceeds(getDoc(doc(db, 'shopPrivate', A)));
  await assertSucceeds(getDoc(doc(db, 'shops', A)));
});

// ---------- creating and publishing ----------

test('an approved retailer creates, edits and publishes their own product', async function () {
  var db = as(A, VERIFIED);
  await assertSucceeds(setDoc(doc(db, 'products', 'n1'), draft(A)));
  await assertSucceeds(updateDoc(doc(db, 'products', 'n1'), {
    name: 'Matte black rectangle', sku: 'BLK-52', brand: 'House', frameType: 'eyeglasses', material: 'Acetate',
    description: 'Everyday frame.', link: 'https://example.com/p/blk-52', pricing: pricing(), availability: 'in_stock',
    images: { thumb: img(A, 'n1', 'thumb-1.webp') }, updatedAt: serverTimestamp()
  }));
  // publishing must make it public (approved shop) …
  await assertFails(updateDoc(doc(db, 'products', 'n1'), { status: 'published', public: false, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'products', 'n1'), { status: 'published', public: true, updatedAt: serverTimestamp() }));
  // … and a draft can't be public
  await assertFails(setDoc(doc(db, 'products', 'n2'), draft(A, { public: true })));
  // archiving hides it again
  await assertFails(updateDoc(doc(db, 'products', 'n1'), { status: 'archived', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'products', 'n1'), { status: 'archived', public: false, updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(db, 'products', 'n1')));
});

test('a product is only public when complete: price confirmed, availability, photo, try-on state', async function () {
  var db = as(A, VERIFIED);
  // unconfirmed tax treatment
  await assertFails(setDoc(doc(db, 'products', 'c1'), complete(A, 'c1', { status: 'published', public: true, pricing: pricing({ confirmed: false }) })));
  await assertSucceeds(setDoc(doc(db, 'products', 'c1'), complete(A, 'c1', { status: 'published', public: false, pricing: pricing({ confirmed: false }) })));
  // no photo
  await assertFails(setDoc(doc(db, 'products', 'c2'), complete(A, 'c2', { status: 'published', public: true, images: {} })));
  // try-on claimed ready but the asset isn't there
  await assertFails(setDoc(doc(db, 'products', 'c3'), complete(A, 'c3', { status: 'published', public: true, tryOn: { status: 'ready', level: '3d' } })));
  // try-on that failed must be fixed or switched to "no try-on" before going public
  await assertFails(setDoc(doc(db, 'products', 'c4'), complete(A, 'c4', { status: 'published', public: true, tryOn: { status: 'failed', error: 'noFrame' } })));
  // ready with its asset
  await assertSucceeds(setDoc(doc(db, 'products', 'c5'), complete(A, 'c5', {
    status: 'published', public: true, tryOn: { status: 'ready', level: '3d', prepared: 'auto', quality: 0.9 },
    images: { thumb: img(A, 'c5', 'thumb-1.webp'), cutout: img(A, 'c5', 'cutout-1.png'), manifest: img(A, 'c5', 'asset-1.json'), source: img(A, 'c5', 'source-1.jpg', false) }
  })));
});

test('a pending retailer can prepare and even publish, but nothing is shown until approval', async function () {
  var db = as(P, VERIFIED);
  await assertSucceeds(setDoc(doc(db, 'products', 'p1'), draft(P)));
  await assertFails(setDoc(doc(db, 'products', 'p2'), complete(P, 'p2', { status: 'published', public: true })));
  await assertSucceeds(setDoc(doc(db, 'products', 'p2'), complete(P, 'p2', { status: 'published', public: false })));
  await assertFails(getDoc(doc(guest(), 'products', 'p2')));
});

test('a suspended retailer cannot change their catalogue', async function () {
  var db = as(S, VERIFIED);
  await assertFails(setDoc(doc(db, 'products', 's2'), draft(S)));
  await assertFails(updateDoc(doc(db, 'products', 'pS1'), { name: 'Still here', updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(db, 'products', 'pS1')));    // can still see it
  await assertSucceeds(deleteDoc(doc(db, 'products', 'pS1'))); // and remove it
});

test('a signed-in user without a shop cannot create products', async function () {
  await assertFails(setDoc(doc(as(CUSTOMER, VERIFIED), 'products', 'z1'), draft(CUSTOMER)));
});

test('retailers cannot touch the admin\'s moderation', async function () {
  await env.withSecurityRulesDisabled(async function (ctx) {
    await updateDoc(doc(ctx.firestore(), 'products', 'pA1'), { moderation: { state: 'suspended', reason: 'Wrong photo' }, public: false });
  });
  var db = as(A, VERIFIED);
  await assertFails(updateDoc(doc(db, 'products', 'pA1'), { moderation: { state: 'ok' }, public: true, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'products', 'pA1'), { public: true, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'products', 'pA1'), { name: 'Fixed name', public: false, updatedAt: serverTimestamp() }));
});

test('product fields are validated', async function () {
  var db = as(A, VERIFIED);
  var bad = [
    { pricing: pricing({ pricePaise: -100 }) },
    { pricing: pricing({ pricePaise: 2499.5 }) },
    { pricing: pricing({ taxRate: 60 }) },
    { pricing: pricing({ taxRate: 5.125 }) },
    { pricing: pricing({ taxMode: 'none', taxRate: 18 }) },
    { pricing: pricing({ taxMode: 'exclusive', taxRate: null }) },
    { pricing: pricing({ currency: 'USD' }) },
    { pricing: pricing({ salePaise: 249900 }) },
    { pricing: pricing({ salePaise: 300000 }) },
    { pricing: (function () { var p = pricing(); delete p.confirmed; return p; })() },
    { link: 'http://insecure.example.com' },
    { link: 'javascript:alert(1)' },
    { availability: 'maybe' },
    { frameType: 'helmet' },
    { tags: { shape: 'hexagon' } },
    { size: { eye: 120 } },
    { name: 'x'.repeat(81) },
    { description: 'x'.repeat(1001) },
    { images: { thumb: { path: 'shops/' + A + '/products/v1/assets/t.webp', url: 'https://evil.example.com/pixel.gif' } } },
    { images: { thumb: { path: '../../etc/passwd', url: 'https://firebasestorage.googleapis.com/v0/b/x/o/y' } } },
    { images: { source: img(A, 'v1', 'source-1.jpg', true) } },   // the original photo must stay private (no link)
    { unknownField: 1 },
    { createdAt: new Date(2020, 0, 1) }
  ];
  for (var i = 0; i < bad.length; i++) {
    await assertFails(setDoc(doc(db, 'products', 'v1'), draft(A, bad[i])));
  }
  var good = [
    { pricing: pricing({ taxMode: 'exclusive', taxRate: 5 }) },
    { pricing: pricing({ taxMode: 'inclusive', taxRate: 2.5 }) },
    { pricing: pricing({ taxMode: 'none', taxRate: null }) },
    { pricing: pricing({ salePaise: 199900 }) },
    { pricing: pricing({ taxMode: 'exclusive', taxRate: 0 }) },
    { size: null },
    { link: 'https://wa.me/919999999999' },
    { link: 'https://shop.example.com/products/steel-frames?size=52' },
    { images: { thumb: img(A, 'g8', 'thumb-1.webp') } }
  ];
  for (var j = 0; j < good.length; j++) {
    await assertSucceeds(setDoc(doc(db, 'products', 'g' + j), draft(A, good[j])));
  }
});

test('changing the price must record when it changed', async function () {
  var db = as(A, VERIFIED);
  await assertSucceeds(setDoc(doc(db, 'products', 't1'), draft(A, { pricing: pricing() })));
  var p = pricing({ pricePaise: 199900 });
  p.updatedAt = new Date(2020, 0, 1);
  await assertFails(updateDoc(doc(db, 'products', 't1'), { pricing: p, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'products', 't1'), { pricing: pricing({ pricePaise: 199900 }), updatedAt: serverTimestamp() }));
});

test('retailers must have accepted the current retailer terms to change products', async function () {
  await env.withSecurityRulesDisabled(async function (ctx) {
    await updateDoc(doc(ctx.firestore(), 'config', 'legal'), { retailerTerms: { version: '1.1', date: '2026-11-01' } });
  });
  var db = as(A, VERIFIED);
  await assertFails(setDoc(doc(db, 'products', 'r1'), draft(A)));
  await assertSucceeds(setDoc(doc(db, 'acceptances', A + '_retailerTerms_1.1'), { uid: A, doc: 'retailerTerms', version: '1.1', acceptedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, 'products', 'r1'), draft(A)));
});

// ---------- shop applications ----------

function applyBatch(db, uid, opts) {
  opts = opts || {};
  var b = writeBatch(db);
  if (!opts.skipTerms) {
    b.set(doc(db, 'acceptances', uid + '_retailerTerms_1.0'), { uid: uid, doc: 'retailerTerms', version: '1.0', acceptedAt: serverTimestamp() });
    b.set(doc(db, 'acceptances', uid + '_privacy_1.0'), { uid: uid, doc: 'privacy', version: '1.0', acceptedAt: serverTimestamp() });
  }
  b.set(doc(db, 'shops', opts.shopId || uid), shop(uid, opts.status || 'pending', { phone: '+91 98220 00000', website: 'https://example.com' }));
  b.set(doc(db, 'shopPrivate', opts.shopId || uid), { ownerName: 'New Owner', gstin: '27ABCDE1234F1Z5', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return b.commit();
}

test('a retailer applies with a verified email and accepted terms, and starts pending', async function () {
  await assertSucceeds(applyBatch(as(NEWBIE, VERIFIED), NEWBIE));
});

test('applications are refused without verification, terms, as someone else, pre-approved, or when closed', async function () {
  await assertFails(applyBatch(as(NEWBIE, { email_verified: false }), NEWBIE));
  await assertFails(applyBatch(as(NEWBIE, VERIFIED), NEWBIE, { skipTerms: true }));
  await assertFails(applyBatch(as(NEWBIE, VERIFIED), NEWBIE, { status: 'approved' }));
  await assertFails(applyBatch(as(NEWBIE, VERIFIED), NEWBIE, { shopId: 'someoneElse' }));
  await assertFails(applyBatch(as('anonDevice', Object.assign({ email_verified: true }, ANON)), 'anonDevice'));
  await env.withSecurityRulesDisabled(async function (ctx) {
    await setDoc(doc(ctx.firestore(), 'config', 'platform'), { applicationsOpen: false });
  });
  await assertFails(applyBatch(as(NEWBIE, VERIFIED), NEWBIE));
});

test('a shop owner edits their profile but not their status; a rejected shop can re-apply', async function () {
  var db = as(A, VERIFIED);
  await assertSucceeds(updateDoc(doc(db, 'shops', A), { about: 'Opticians since 1987', phone: '0721 2550000', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'shops', A), { status: 'suspended', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'shops', A), { ownerUid: B, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'shops', A), { website: 'ftp://nope', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as(S, VERIFIED), 'shops', S), { about: 'Back again', updatedAt: serverTimestamp() }));
  await env.withSecurityRulesDisabled(async function (ctx) {
    await updateDoc(doc(ctx.firestore(), 'shops', P), { status: 'rejected', statusReason: 'Incomplete address' });
  });
  var p = as(P, VERIFIED);
  await assertFails(updateDoc(doc(p, 'shops', P), { status: 'approved', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(p, 'shops', P), { address: 'Camp Road, Amravati', status: 'pending', statusReason: '', updatedAt: serverTimestamp() }));
});

// ---------- the admin ----------

test('the admin reviews shops: approve, reject, suspend, reactivate', async function () {
  var db = as(ADMIN, VERIFIED);
  await assertFails(updateDoc(doc(db, 'shops', P), { status: 'approved', updatedAt: serverTimestamp() })); // needs statusAt + reviewedBy
  await assertSucceeds(updateDoc(doc(db, 'shops', P), { status: 'approved', statusAt: serverTimestamp(), reviewedBy: ADMIN, statusReason: '', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'shops', A), { status: 'suspended', statusAt: serverTimestamp(), reviewedBy: ADMIN, statusReason: 'Reported listings', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'shops', A), { status: 'approved', statusAt: serverTimestamp(), reviewedBy: ADMIN, statusReason: '', updatedAt: serverTimestamp() }));
  await assertSucceeds(getDocs(collection(db, 'shops')));
  await assertSucceeds(getDoc(doc(db, 'shopPrivate', B)));
  await assertSucceeds(getDocs(collection(db, 'products')));
});

test('approving a shop and publishing its ready products happen together', async function () {
  var db = as(ADMIN, VERIFIED);
  var b = writeBatch(db);
  b.update(doc(db, 'shops', P), { status: 'approved', statusAt: serverTimestamp(), reviewedBy: ADMIN, updatedAt: serverTimestamp() });
  b.update(doc(db, 'products', 'pP1'), { public: true, updatedAt: serverTimestamp() });
  await assertSucceeds(b.commit());
  await assertSucceeds(getDoc(doc(guest(), 'products', 'pP1')));
  // suspending hides them again; the flag can't stay true
  var b2 = writeBatch(db);
  b2.update(doc(db, 'shops', P), { status: 'suspended', statusAt: serverTimestamp(), reviewedBy: ADMIN, updatedAt: serverTimestamp() });
  b2.update(doc(db, 'products', 'pP1'), { public: true, updatedAt: serverTimestamp() });
  await assertFails(b2.commit());
});

test('the admin suspends and restores a listing but cannot rewrite it', async function () {
  var db = as(ADMIN, VERIFIED);
  await assertFails(updateDoc(doc(db, 'products', 'pB1'), { moderation: { state: 'suspended', reason: 'Counterfeit' }, updatedAt: serverTimestamp() })); // still public: not allowed
  await assertSucceeds(updateDoc(doc(db, 'products', 'pB1'), { moderation: { state: 'suspended', reason: 'Counterfeit' }, public: false, updatedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(guest(), 'products', 'pB1')));
  await assertSucceeds(updateDoc(doc(db, 'products', 'pB1'), { moderation: { state: 'ok' }, public: true, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'products', 'pB1'), { name: 'Admin edit', updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(db, 'products', 'pB2')));
});

test('platform settings: anyone reads, only the admin writes', async function () {
  var good = { applicationsOpen: true, announcement: 'New shops welcome', maxProductsPerShop: 500, updatedAt: serverTimestamp(), updatedBy: ADMIN };
  await assertSucceeds(setDoc(doc(as(ADMIN, VERIFIED), 'config', 'platform'), good));
  await assertFails(setDoc(doc(as(A, VERIFIED), 'config', 'platform'), Object.assign({}, good, { updatedBy: A })));
  await assertFails(setDoc(doc(as(ADMIN, VERIFIED), 'config', 'platform'), Object.assign({}, good, { secret: 'x' })));
  await assertSucceeds(setDoc(doc(as(ADMIN, VERIFIED), 'config', 'legal'), {
    retailerTerms: { version: '1.1', date: '2026-11-01' }, privacy: { version: '1.0', date: '2026-10-12' }, updatedAt: serverTimestamp(), updatedBy: ADMIN
  }));
  await assertSucceeds(setDoc(doc(as(ADMIN, VERIFIED), 'config', 'demo'), { hidden: ['demo-round-gold'], updatedAt: serverTimestamp(), updatedBy: ADMIN }));
  await assertSucceeds(getDoc(doc(guest(), 'config', 'platform')));
});

test('the audit log is admin-only and append-only', async function () {
  var db = as(ADMIN, VERIFIED);
  var entry = { at: serverTimestamp(), actorUid: ADMIN, action: 'shop.approve', targetType: 'shop', targetId: P };
  await assertSucceeds(setDoc(doc(db, 'auditLog', 'e1'), entry));
  await assertFails(updateDoc(doc(db, 'auditLog', 'e1'), { note: 'changed' }));
  await assertFails(deleteDoc(doc(db, 'auditLog', 'e1')));
  await assertFails(setDoc(doc(db, 'auditLog', 'e2'), Object.assign({}, entry, { actorUid: B })));
  await assertFails(setDoc(doc(as(A, VERIFIED), 'auditLog', 'e3'), Object.assign({}, entry, { actorUid: A })));
});

// ---------- legal acceptance records ----------

test('acceptance records are for the current version, by the person themselves, and permanent', async function () {
  var db = as(NEWBIE, VERIFIED);
  var rec = { uid: NEWBIE, doc: 'retailerTerms', version: '1.0', acceptedAt: serverTimestamp() };
  await assertFails(setDoc(doc(db, 'acceptances', NEWBIE + '_retailerTerms_0.9'), Object.assign({}, rec, { version: '0.9' })));
  await assertFails(setDoc(doc(db, 'acceptances', B + '_retailerTerms_1.0'), Object.assign({}, rec, { uid: B })));
  await assertFails(setDoc(doc(db, 'acceptances', NEWBIE + '_retailerTerms_1.0'), Object.assign({}, rec, { acceptedAt: new Date(2020, 0, 1) })));
  await assertFails(setDoc(doc(db, 'acceptances', NEWBIE + '_retailerTerms_1.0'), Object.assign({}, rec, { email: 'a@b.c' })));
  await assertFails(setDoc(doc(db, 'acceptances', NEWBIE + '_customerTerms_1.0'), Object.assign({}, rec, { doc: 'customerTerms' })));
  await assertSucceeds(setDoc(doc(db, 'acceptances', NEWBIE + '_retailerTerms_1.0'), rec));
  await assertFails(updateDoc(doc(db, 'acceptances', NEWBIE + '_retailerTerms_1.0'), { version: '2.0' }));
  await assertFails(deleteDoc(doc(db, 'acceptances', NEWBIE + '_retailerTerms_1.0')));
  await assertFails(setDoc(doc(as('anonDevice', ANON), 'acceptances', 'anonDevice_privacy_1.0'), { uid: 'anonDevice', doc: 'privacy', version: '1.0', acceptedAt: serverTimestamp() }));
  await assertSucceeds(getDocs(query(collection(db, 'acceptances'), where('uid', '==', NEWBIE))));
  await assertFails(getDocs(query(collection(db, 'acceptances'), where('uid', '==', A))));
  await assertSucceeds(getDocs(collection(as(ADMIN, VERIFIED), 'acceptances')));
});

// ---------- reports ----------

function reportBatch(db, uid, productId, shopId) {
  var b = writeBatch(db);
  b.set(doc(db, 'limits', uid), { lastReportAt: serverTimestamp() });
  b.set(doc(collection(db, 'reports')), { productId: productId, shopId: shopId, reason: 'wrong_price', note: 'Price on the tag is different', createdAt: serverTimestamp(), status: 'open', reporterUid: uid });
  return b.commit();
}

test('an anonymous device can report a public listing, at most once a minute', async function () {
  var db = as('anonDevice', ANON);
  await assertSucceeds(reportBatch(db, 'anonDevice', 'pA1', A));
  await assertFails(reportBatch(db, 'anonDevice', 'pB1', B));        // too soon
  await assertFails(reportBatch(as('dev2', ANON), 'dev2', 'pA2', A)); // a draft can't be reported
  await assertFails(reportBatch(as('dev3', ANON), 'dev3', 'pA1', B)); // wrong shop
  // a report without the rate-limit stamp
  await assertFails(setDoc(doc(as('dev4', ANON), 'reports', 'r9'), { productId: 'pA1', shopId: A, reason: 'other', createdAt: serverTimestamp(), status: 'open', reporterUid: 'dev4' }));
  await assertFails(getDocs(collection(db, 'reports')));
  await assertFails(getDocs(collection(as(A, VERIFIED), 'reports')));
  var admin = as(ADMIN, VERIFIED);
  var list = await assertSucceeds(getDocs(collection(admin, 'reports')));
  await assertSucceeds(updateDoc(list.docs[0].ref, { status: 'resolved', resolution: 'Price corrected', resolvedAt: serverTimestamp(), resolvedBy: ADMIN }));
});

// ---------- the old single-shop library ----------

test('the old library is readable only by the account that owns it', async function () {
  await assertSucceeds(getDocs(collection(as(A, VERIFIED), 'users', A, 'frames')));
  await assertFails(getDocs(collection(as(B, VERIFIED), 'users', A, 'frames')));
  await assertFails(getDocs(collection(guest(), 'users', A, 'frames')));
});

