// Try-on counts (tryons/{shopId}): anyone may add exactly one try-on at a
// time (total, today and that frame each +1); nothing else can change; the
// shop reads its own, the admin reads all and sets the earlier count.
import { test, before, beforeEach, after } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp, increment } from 'firebase/firestore';
import { makeEnv, seed, ADMIN, A, B, CUSTOMER, VERIFIED, ANON } from './helpers.mjs';

var env;
before(async function () { env = await makeEnv(); });
beforeEach(async function () { await seed(env); });
after(async function () { if (env) await env.cleanup(); });
function as(uid, token) { return env.authenticatedContext(uid, token).firestore(); }
function guest() { return env.unauthenticatedContext().firestore(); }

function day(offsetDays) {
  var t = new Date(Date.now() + 5.5 * 3600000 + (offsetDays || 0) * 86400000);
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(t.getUTCDate()).padStart(2, '0');
}
function one(frame, d) {
  var dd = d || day(), days = {}, frames = {};
  days[dd] = increment(1); frames[frame] = increment(1);
  return { total: increment(1), days: days, frames: frames, lastDay: dd, lastFrame: frame, updatedAt: serverTimestamp() };
}

test('anyone can add one try-on to an existing shop or the demo, the way the site does', async function () {
  var g = guest();
  await assertSucceeds(setDoc(doc(g, 'tryons', A), one('pA1'), { merge: true }));
  await assertSucceeds(setDoc(doc(g, 'tryons', A), one('pA1'), { merge: true }));
  await assertSucceeds(setDoc(doc(as('anonDevice', ANON), 'tryons', A), one('pA9'), { merge: true }));
  await assertSucceeds(setDoc(doc(g, 'tryons', 'demo'), one('demo-gold-round'), { merge: true }));
  await assertFails(setDoc(doc(g, 'tryons', 'noSuchShop'), one('x1'), { merge: true }));
  var snap = await getDoc(doc(as(A, VERIFIED), 'tryons', A));
  var d = snap.data();
  if (d.total !== 3 || d.frames.pA1 !== 2 || d.frames.pA9 !== 1 || d.days[day()] !== 3) throw new Error('counts wrong: ' + JSON.stringify(d));
});

test('counts can only go up by one, for today, and nothing else can be written', async function () {
  var g = guest();
  await assertSucceeds(setDoc(doc(g, 'tryons', A), one('pA1'), { merge: true }));
  var big = one('pA1'); big.total = increment(5);
  await assertFails(setDoc(doc(g, 'tryons', A), big, { merge: true }));
  var two = one('pA1'); two.frames.pA2 = increment(1);
  await assertFails(setDoc(doc(g, 'tryons', A), two, { merge: true }));
  await assertFails(setDoc(doc(g, 'tryons', A), one('pA1', '2020-01-01'), { merge: true }));
  await assertFails(setDoc(doc(g, 'tryons', A), one('pA1', day(5)), { merge: true }));
  var extra = one('pA1'); extra.name = 'x';
  await assertFails(setDoc(doc(g, 'tryons', A), extra, { merge: true }));
  var before = one('pA1'); before.before = 999;
  await assertFails(setDoc(doc(g, 'tryons', A), before, { merge: true }));
  await assertFails(setDoc(doc(g, 'tryons', A), { total: 0, days: {}, frames: {}, lastDay: day(), lastFrame: 'pA1', updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(g, 'tryons', A)));
  await assertFails(deleteDoc(doc(as(A, VERIFIED), 'tryons', A)));
});

test('the shop reads its own counts, the admin reads all and records earlier try-ons', async function () {
  await assertSucceeds(setDoc(doc(guest(), 'tryons', A), one('pA1'), { merge: true }));
  await assertSucceeds(getDoc(doc(as(A, VERIFIED), 'tryons', A)));
  await assertFails(getDoc(doc(as(B, VERIFIED), 'tryons', A)));
  await assertFails(getDoc(doc(guest(), 'tryons', A)));
  await assertFails(getDocs(collection(as(A, VERIFIED), 'tryons')));
  await assertSucceeds(getDocs(collection(as(ADMIN, VERIFIED), 'tryons')));
  var admin = as(ADMIN, VERIFIED);
  await assertSucceeds(setDoc(doc(admin, 'tryons', A), { before: 40, updatedAt: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(admin, 'tryons', B), { before: 12, updatedAt: serverTimestamp() }, { merge: true }));
  await assertFails(setDoc(doc(admin, 'tryons', A), { before: 40, total: 999, updatedAt: serverTimestamp() }, { merge: true }));
  await assertFails(setDoc(doc(as(A, VERIFIED), 'tryons', A), { before: 4000, updatedAt: serverTimestamp() }, { merge: true }));
  // counting carries on after the admin's change
  await assertSucceeds(setDoc(doc(guest(), 'tryons', B), one('pB1'), { merge: true }));
  var d = (await getDoc(doc(admin, 'tryons', B))).data();
  if (d.before !== 12 || d.total !== 1) throw new Error(JSON.stringify(d));
});
