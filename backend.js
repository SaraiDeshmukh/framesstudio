// Everything the site reads from and writes to Firebase, in one place.
// The rules in firestore.rules / storage.rules decide what is allowed; these
// functions just ask. Nothing in here ever receives a customer's photo or
// camera image: the try-on code doesn't import this module's upload helpers,
// and Storage has no place for such files (see storage.rules).

import { auth, db, storage, CONFIGURED, setKeepSignedIn } from './firebase-init.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  sendEmailVerification, sendPasswordResetEmail, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit, startAfter,
  writeBatch, serverTimestamp, getCountFromServer, getAggregateFromServer, sum, count
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import {
  ref, uploadBytes, getDownloadURL, deleteObject, getBlob
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js';
import { shouldBePublic } from './validation.js';

export { CONFIGURED };
export var serverTime = serverTimestamp;

function need() { if (!CONFIGURED) throw Object.assign(new Error('Firebase is not configured'), { code: 'not-configured' }); }
function tsMillis(v) { return v && typeof v.toMillis === 'function' ? v.toMillis() : null; }
function withId(snap) { var d = snap.data(); d.id = snap.id; return d; }

// ---------- accounts ----------

export function currentUser() { return auth ? auth.currentUser : null; }
export function onAuth(cb) { if (!auth) { cb(null); return function () {}; } return onAuthStateChanged(auth, cb); }

export function signIn(email, password, keep) {
  need();
  return setKeepSignedIn(!!keep).then(function () { return signInWithEmailAndPassword(auth, email, password); });
}
export function signUp(email, password, keep) {
  need();
  return setKeepSignedIn(!!keep).then(function () { return createUserWithEmailAndPassword(auth, email, password); })
    .then(function (cred) { return sendEmailVerification(cred.user).catch(function () {}).then(function () { return cred; }); });
}
export function resendVerification() { return auth.currentUser ? sendEmailVerification(auth.currentUser) : Promise.reject(new Error('Not signed in')); }
// After the person clicks the link in the email: reload, and refresh the
// sign-in token so the server sees the verified address too.
export function refreshUser() {
  var u = auth && auth.currentUser;
  if (!u) return Promise.resolve(null);
  return u.reload().then(function () { return u.getIdToken(true); }).then(function () { return auth.currentUser; });
}
export function resetPassword(email) { need(); return sendPasswordResetEmail(auth, email); }
export function signOutUser() { return auth ? signOut(auth) : Promise.resolve(); }

// A throwaway anonymous sign-in, used only so a listing report can be rate
// limited. Never used when someone is already signed in.
function ensureSignedIn() {
  need();
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return signInAnonymously(auth).then(function (c) { return c.user; });
}

export function isRealUser(u) { return !!(u && !u.isAnonymous); }

// Whether this account is an admin. Only the server can make someone one;
// reading your own admins/{uid} document is how the page finds out.
export function checkAdmin(uid) {
  if (!uid || !db) return Promise.resolve(false);
  return getDoc(doc(db, 'admins', uid)).then(function (s) { return s.exists(); }).catch(function () { return false; });
}

// ---------- platform configuration (public) ----------

export function getConfig(docId) {
  if (!db) return Promise.resolve(null);
  return getDoc(doc(db, 'config', docId)).then(function (s) { return s.exists() ? s.data() : null; });
}
export function saveConfig(docId, data) {
  var u = auth.currentUser;
  var rec = Object.assign({}, data, { updatedAt: serverTimestamp(), updatedBy: u.uid });
  return setDoc(doc(db, 'config', docId), rec);
}

// ---------- legal acceptance ----------

export function myAcceptances(uid) {
  return getDocs(query(collection(db, 'acceptances'), where('uid', '==', uid))).then(function (snap) {
    var out = {};
    snap.forEach(function (d) { var a = d.data(); (out[a.doc] = out[a.doc] || []).push(a.version); });
    return out;
  });
}
function acceptanceRefs(batch, uid, docs, legal) {
  docs.forEach(function (key) {
    var v = legal[key].version;
    batch.set(doc(db, 'acceptances', uid + '_' + key + '_' + v), { uid: uid, doc: key, version: v, acceptedAt: serverTimestamp() });
  });
}
// Records that this person accepted the current version of each document.
export function acceptDocuments(uid, docs, legal) {
  var b = writeBatch(db);
  acceptanceRefs(b, uid, docs, legal);
  return b.commit();
}
// Which of the required documents still need accepting.
export function missingAcceptances(accepted, legal) {
  return ['retailerTerms', 'privacy'].filter(function (k) {
    return legal && legal[k] && (accepted[k] || []).indexOf(legal[k].version) === -1;
  });
}

// ---------- shops ----------

export function getShop(id) {
  return getDoc(doc(db, 'shops', id)).then(function (s) { return s.exists() ? withId(s) : null; });
}
export function getShopPrivate(id) {
  return getDoc(doc(db, 'shopPrivate', id)).then(function (s) { return s.exists() ? s.data() : null; });
}
export function listApprovedShops(max) {
  need();
  return getDocs(query(collection(db, 'shops'), where('status', '==', 'approved'), orderBy('createdAt', 'desc'), limit(max || 100)))
    .then(function (snap) { return snap.docs.map(withId); });
}

// The application: acceptances (if not yet given), the public profile and the
// private details, in one batch so they stand or fall together.
export function applyForShop(uid, profile, priv, legal, alreadyAccepted) {
  var b = writeBatch(db);
  var toAccept = missingAcceptances(alreadyAccepted || {}, legal);
  acceptanceRefs(b, uid, toAccept, legal);
  b.set(doc(db, 'shops', uid), Object.assign({}, profile, { status: 'pending', ownerUid: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  b.set(doc(db, 'shopPrivate', uid), Object.assign({}, priv, { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  return b.commit();
}
export function updateShop(uid, profile, priv, privExists, reapply) {
  var b = writeBatch(db);
  var pub = Object.assign({}, profile, { updatedAt: serverTimestamp() });
  if (reapply) { pub.status = 'pending'; pub.statusReason = ''; }
  b.update(doc(db, 'shops', uid), pub);
  if (priv) {
    var p = Object.assign({}, priv, { updatedAt: serverTimestamp() });
    if (privExists) b.update(doc(db, 'shopPrivate', uid), p);
    else b.set(doc(db, 'shopPrivate', uid), Object.assign(p, { createdAt: serverTimestamp() }));
  }
  return b.commit();
}

// ---------- products ----------

export function productFromSnap(snap) {
  var p = withId(snap);
  p.createdMs = tsMillis(p.createdAt);
  p.updatedMs = tsMillis(p.updatedAt);
  p.priceUpdatedMs = p.pricing ? tsMillis(p.pricing.updatedAt) : null;
  return p;
}

export function getProduct(id) {
  return getDoc(doc(db, 'products', id)).then(function (s) { return s.exists() ? productFromSnap(s) : null; });
}

// A shop's published catalogue, newest first, in pages.
export function listPublicProducts(shopId, opts) {
  opts = opts || {};
  var parts = [collection(db, 'products'), where('public', '==', true), where('shopId', '==', shopId), orderBy('createdAt', 'desc')];
  if (opts.after) parts.push(startAfter(opts.after));
  parts.push(limit(opts.pageSize || 100));
  return getDocs(query.apply(null, parts)).then(function (snap) {
    return { items: snap.docs.map(productFromSnap), last: snap.docs.length ? snap.docs[snap.docs.length - 1] : null, more: snap.docs.length === (opts.pageSize || 100) };
  });
}
// Loads a whole published catalogue (up to `max`), page by page.
export function loadPublicCatalogue(shopId, max) {
  var all = [];
  function next(after) {
    return listPublicProducts(shopId, { after: after, pageSize: 100 }).then(function (pg) {
      all = all.concat(pg.items);
      if (pg.more && all.length < (max || 2000)) return next(pg.last);
      return all;
    });
  }
  return next(null);
}

// The retailer's own products (any status), newest change first.
export function listMyProducts(uid, opts) {
  opts = opts || {};
  var parts = [collection(db, 'products'), where('shopId', '==', uid)];
  if (opts.status) parts.push(where('status', '==', opts.status));
  parts.push(orderBy('updatedAt', 'desc'));
  if (opts.after) parts.push(startAfter(opts.after));
  parts.push(limit(opts.pageSize || 100));
  return getDocs(query.apply(null, parts)).then(function (snap) {
    return { items: snap.docs.map(productFromSnap), last: snap.docs.length ? snap.docs[snap.docs.length - 1] : null, more: snap.docs.length === (opts.pageSize || 100) };
  });
}
export function loadAllMyProducts(uid, max) {
  var all = [];
  function next(after) {
    return listMyProducts(uid, { after: after, pageSize: 100 }).then(function (pg) {
      all = all.concat(pg.items);
      if (pg.more && all.length < (max || 5000)) return next(pg.last);
      return all;
    });
  }
  return next(null);
}

var EDITABLE = ['name', 'sku', 'brand', 'frameType', 'tags', 'colourName', 'material', 'description', 'size',
  'pricing', 'availability', 'link', 'status', 'tryOn', 'images', 'assetBytes', 'legacyId'];

function stripUndefined(o) {
  Object.keys(o).forEach(function (k) { if (o[k] === undefined) delete o[k]; });
  return o;
}

// A new product id (Firestore's random id), so files can be uploaded under it.
export function newProductId() { return doc(collection(db, 'products')).id; }

// Creates a product owned by the signed-in shop. `public` is worked out the
// same way the rules do, from the product and the shop's status.
export function createProduct(uid, id, data, shopStatus) {
  var p = { shopId: uid, name: '', status: 'draft', moderation: { state: 'ok' }, tryOn: { status: 'none' } };
  EDITABLE.forEach(function (k) { if (data[k] !== undefined) p[k] = data[k]; });
  if (p.pricing) p.pricing = Object.assign({}, p.pricing, { updatedAt: serverTimestamp() });
  p.public = shouldBePublic(p, shopStatus);
  p.createdAt = serverTimestamp();
  p.updatedAt = serverTimestamp();
  return setDoc(doc(db, 'products', id), stripUndefined(p)).then(function () { return id; });
}

function samePricing(a, b) {
  if (!a || !b) return false;
  return ['pricePaise', 'currency', 'taxMode', 'taxRate', 'salePaise', 'hsn', 'confirmed'].every(function (k) { return (a[k] == null ? null : a[k]) === (b[k] == null ? null : b[k]); });
}

// Saves changes to one of the shop's products. `current` is the product as
// last read; the result is what was written (for the page to show).
export function saveProduct(current, changes, shopStatus) {
  var next = Object.assign({}, current, changes);
  var out = {};
  EDITABLE.forEach(function (k) { if (changes[k] !== undefined) out[k] = changes[k]; });
  if (changes.pricing !== undefined) {
    if (changes.pricing && samePricing(changes.pricing, current.pricing)) out.pricing = current.pricing;
    else if (changes.pricing) out.pricing = Object.assign({}, changes.pricing, { updatedAt: serverTimestamp() });
  }
  out.public = shouldBePublic(next, shopStatus);
  out.updatedAt = serverTimestamp();
  return updateDoc(doc(db, 'products', current.id), out).then(function () {
    var written = Object.assign({}, current, out, { public: out.public });
    return written;
  });
}

// Removes a product and all its stored files.
export function deleteProduct(p) {
  var paths = imagePaths(p);
  return deleteDoc(doc(db, 'products', p.id)).then(function () { return deleteFiles(paths); });
}

export function imagePaths(p) {
  var im = p.images || {}, out = [];
  ['thumb', 'cutout', 'side', 'source', 'manifest'].forEach(function (k) { if (im[k] && im[k].path) out.push(im[k].path); });
  return out;
}

// ---------- stored files (retailers' frame photos only) ----------

var IMMUTABLE = 'public, max-age=31536000, immutable';

export function assetVersion() { return Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

function extFor(type) { return type === 'image/webp' ? 'webp' : type === 'image/jpeg' ? 'jpg' : type === 'application/json' ? 'json' : 'png'; }

// Uploads one file for a product. kind: 'assets' (shown to customers once
// published) or 'source' (the original photo, private to the shop).
export function uploadProductFile(uid, productId, kind, name, blob, extra) {
  var type = blob.type || 'image/png';
  var file = name + '.' + extFor(type);
  var path = 'shops/' + uid + '/products/' + productId + '/' + kind + '/' + file;
  var r = ref(storage, path);
  var meta = { contentType: type, cacheControl: kind === 'assets' ? IMMUTABLE : 'private, max-age=0' };
  return uploadBytes(r, blob, meta).then(function () {
    var info = Object.assign({ path: path, bytes: blob.size }, extra || {});
    if (kind === 'source') return info;               // private: no public link is ever made
    return getDownloadURL(r).then(function (url) { info.url = url; return info; });
  });
}

export function deleteFiles(paths) {
  return Promise.all((paths || []).map(function (p) {
    return deleteObject(ref(storage, p)).catch(function (e) {
      if (e && e.code === 'storage/object-not-found') return null;
      console.warn('Could not delete ' + p, e);
      return null;
    });
  }));
}

// The original photo, for re-processing (the owning shop only).
export function getSourceBlob(path) { return getBlob(ref(storage, path)); }

var manifestCache = {};
export function fetchManifest(url) {
  if (!manifestCache[url]) {
    manifestCache[url] = fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('manifest ' + r.status);
      return r.json();
    }).catch(function (e) { delete manifestCache[url]; throw e; });
  }
  return manifestCache[url];
}

// ---------- reports of wrong or inappropriate listings ----------

export function submitReport(product, reason, note) {
  return ensureSignedIn().then(function (u) {
    var b = writeBatch(db);
    b.set(doc(db, 'limits', u.uid), { lastReportAt: serverTimestamp() });
    var rec = { productId: product.id, shopId: product.shopId, reason: reason, createdAt: serverTimestamp(), status: 'open', reporterUid: u.uid };
    if (note) rec.note = String(note).slice(0, 500);
    b.set(doc(collection(db, 'reports')), rec);
    return b.commit();
  });
}

// ---------- the old single-shop library (before shops existed) ----------

export function legacyFrames(uid) {
  return getDocs(collection(db, 'users', uid, 'frames')).then(function (snap) { return snap.docs.map(withId); });
}
export function legacyFull(uid, id) {
  return Promise.all([
    getDoc(doc(db, 'users', uid, 'framesFull', id)),
    getDoc(doc(db, 'users', uid, 'framesSource', id)).catch(function () { return null; }),
    getDoc(doc(db, 'users', uid, 'framesSide', id)).catch(function () { return null; })
  ]).then(function (r) {
    return {
      full: r[0] && r[0].exists() ? r[0].data() : null,
      source: r[1] && r[1].exists() ? r[1].data() : null,
      side: r[2] && r[2].exists() ? r[2].data() : null
    };
  });
}

// ---------- admin ----------

export function adminAudit(action, targetType, targetId, note) {
  var u = auth.currentUser;
  var rec = { at: serverTimestamp(), actorUid: u.uid, action: action, targetType: targetType, targetId: String(targetId).slice(0, 128) };
  if (note) rec.note = String(note).slice(0, 300);
  return setDoc(doc(collection(db, 'auditLog')), rec).catch(function (e) { console.warn('Audit log write failed', e); });
}

export function adminListShops(status) {
  var parts = [collection(db, 'shops')];
  if (status) parts.push(where('status', '==', status));
  parts.push(orderBy('createdAt', 'desc'), limit(300));
  return getDocs(query.apply(null, parts)).then(function (snap) {
    return snap.docs.map(function (d) { var s = withId(d); s.createdMs = tsMillis(s.createdAt); s.statusMs = tsMillis(s.statusAt); return s; });
  });
}

// Changes a shop's status and re-derives every product's `public` flag in
// the same batches (approved: ready published products appear; anything
// else: all of them disappear).
export function adminSetShopStatus(shop, status, reason) {
  var u = auth.currentUser;
  return getDocs(query(collection(db, 'products'), where('shopId', '==', shop.id))).then(function (snap) {
    var products = snap.docs.map(productFromSnap);
    var changes = products.filter(function (p) { return p.public !== shouldBePublic(p, status); });
    var batches = [], b = writeBatch(db), n = 1;
    b.update(doc(db, 'shops', shop.id), { status: status, statusReason: reason || '', statusAt: serverTimestamp(), reviewedBy: u.uid, updatedAt: serverTimestamp() });
    changes.forEach(function (p) {
      if (n >= 450) { batches.push(b); b = writeBatch(db); n = 0; }
      b.update(doc(db, 'products', p.id), { public: shouldBePublic(p, status), updatedAt: serverTimestamp() });
      n++;
    });
    batches.push(b);
    return batches.reduce(function (pr, bt) { return pr.then(function () { return bt.commit(); }); }, Promise.resolve())
      .then(function () { return adminAudit('shop.' + status, 'shop', shop.id, reason); })
      .then(function () { return { changed: changes.length }; });
  });
}

export function adminListProducts(filter, after) {
  var parts = [collection(db, 'products')];
  if (filter === 'suspended') parts.push(where('moderation.state', '==', 'suspended'));
  else if (filter === 'failed') parts.push(where('tryOn.status', '==', 'failed'));
  else if (filter && filter.indexOf('shop:') === 0) parts.push(where('shopId', '==', filter.slice(5)));
  parts.push(orderBy('updatedAt', 'desc'));
  if (after) parts.push(startAfter(after));
  parts.push(limit(50));
  return getDocs(query.apply(null, parts)).then(function (snap) {
    return { items: snap.docs.map(productFromSnap), last: snap.docs.length ? snap.docs[snap.docs.length - 1] : null, more: snap.docs.length === 50 };
  });
}

export function adminModerateProduct(p, state, reason, shopStatus) {
  var u = auth.currentUser;
  var mod = state === 'suspended' ? { state: 'suspended', reason: reason || '', at: serverTimestamp(), by: u.uid } : { state: 'ok' };
  var next = Object.assign({}, p, { moderation: { state: state } });
  var pub = shouldBePublic(next, shopStatus);
  return updateDoc(doc(db, 'products', p.id), { moderation: mod, public: pub, updatedAt: serverTimestamp() })
    .then(function () { return adminAudit(state === 'suspended' ? 'product.suspend' : 'product.restore', 'product', p.id, reason); })
    .then(function () { return { public: pub, moderation: mod }; });
}

export function adminDeleteProduct(p, reason) {
  return deleteProduct(p).then(function () { return adminAudit('product.remove', 'product', p.id, reason); });
}

export function adminListReports(status) {
  return getDocs(query(collection(db, 'reports'), where('status', '==', status || 'open'), orderBy('createdAt', 'desc'), limit(200)))
    .then(function (snap) { return snap.docs.map(function (d) { var r = withId(d); r.createdMs = tsMillis(r.createdAt); return r; }); });
}
export function adminResolveReport(r, status, resolution) {
  var u = auth.currentUser;
  return updateDoc(doc(db, 'reports', r.id), { status: status, resolution: resolution || '', resolvedAt: serverTimestamp(), resolvedBy: u.uid })
    .then(function () { return adminAudit('report.' + status, 'report', r.id, resolution); });
}

export function adminListAcceptances(docKey) {
  var parts = [collection(db, 'acceptances')];
  if (docKey) parts.push(where('doc', '==', docKey));
  parts.push(orderBy('acceptedAt', 'desc'), limit(300));
  return getDocs(query.apply(null, parts)).then(function (snap) {
    return snap.docs.map(function (d) { var a = withId(d); a.acceptedMs = tsMillis(a.acceptedAt); return a; });
  });
}

export function adminListAudit() {
  return getDocs(query(collection(db, 'auditLog'), orderBy('at', 'desc'), limit(200)))
    .then(function (snap) { return snap.docs.map(function (d) { var a = withId(d); a.atMs = tsMillis(a.at); return a; }); });
}

// Platform-wide numbers from server-side counts (each costs about one read
// per 1,000 matching documents, not one per document).
export function adminCounts() {
  var P = collection(db, 'products'), S = collection(db, 'shops');
  function c(q) { return getCountFromServer(q).then(function (s) { return s.data().count; }).catch(function () { return null; }); }
  return Promise.all([
    c(S), c(query(S, where('status', '==', 'approved'))), c(query(S, where('status', '==', 'pending'))), c(query(S, where('status', '==', 'suspended'))),
    c(P), c(query(P, where('public', '==', true))), c(query(P, where('tryOn.status', '==', 'ready'))), c(query(P, where('tryOn.status', '==', 'failed'))),
    c(query(P, where('moderation.state', '==', 'suspended'))),
    getAggregateFromServer(P, { bytes: sum('assetBytes'), n: count() }).then(function (s) { return s.data().bytes; }).catch(function () { return null; }),
    c(query(collection(db, 'reports'), where('status', '==', 'open')))
  ]).then(function (r) {
    return {
      shops: r[0], shopsApproved: r[1], shopsPending: r[2], shopsSuspended: r[3],
      products: r[4], productsPublic: r[5], tryOnReady: r[6], tryOnFailed: r[7], productsSuspended: r[8],
      storageBytes: r[9], reportsOpen: r[10]
    };
  });
}

// For the admin's per-shop table: product counts and stored bytes per shop.
export function adminShopUsage(shopId) {
  var P = query(collection(db, 'products'), where('shopId', '==', shopId));
  return getAggregateFromServer(P, { n: count(), bytes: sum('assetBytes') }).then(function (s) { return s.data(); }).catch(function () { return null; });
}

export { tsMillis };
