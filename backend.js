// Everything the site reads from and writes to Firebase, in one place.
// The rules in firestore.rules / storage.rules decide what is allowed; these
// functions just ask. Nothing in here ever receives a customer's photo or
// camera image: the try-on code doesn't import this module's upload helpers,
// and there is no place for such files (see firestore.rules, storage.rules).
//
// Cost notes (Firestore bills, and the free Spark plan limits, per document
// read, write and delete; see COSTS.md):
//   - customers' catalogue pages read one small index per shop
//     (catalogues/{shopId}) and then only the products actually shown;
//   - public data is cached in the browser (cache.js) so a repeat visit
//     reads almost nothing;
//   - on the free plan frame pictures live in Firestore (productFiles, and
//     small ones inline on the product), because Spark has no Cloud Storage.

import { auth, db, storage, CONFIGURED, IMAGE_STORE, setKeepSignedIn } from './firebase-init.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  sendEmailVerification, sendPasswordResetEmail, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit, startAfter,
  writeBatch, serverTimestamp, getCountFromServer, getAggregateFromServer, sum, count, deleteField, FieldPath, Timestamp
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import {
  ref, uploadBytes, getDownloadURL, deleteObject, getBlob
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js';
import { shouldBePublic } from './validation.js';
import { cacheGet, cacheSet, cacheDelete, lsGet, lsSet, lsDelete } from './cache.js';
import { INDEX_VERSION, INDEX_MAX_ITEMS, indexItem, buildItems, sameItems, hasRef, imgSrc } from './catalogue-index.js';

export { CONFIGURED, IMAGE_STORE, hasRef, imgSrc };
export var serverTime = serverTimestamp;

function need() { if (!CONFIGURED) throw Object.assign(new Error('Firebase is not configured'), { code: 'not-configured' }); }
function tsMillis(v) {
  if (typeof v === 'number') return v;
  return v && typeof v.toMillis === 'function' ? v.toMillis() : null;
}
function withId(snap) { var d = snap.data(); d.id = snap.id; return d; }

// ---------- read accounting ----------
// Roughly what Firestore bills for this page's requests (1 per document read,
// at least 1 per query; security-rule lookups are not included). Shown by
// tests and handy in the browser console: __ftsStats.
var stats = { reads: 0, writes: 0, cacheHits: 0 };
export function readStats() { return Object.assign({}, stats); }
if (typeof window !== 'undefined') window.__ftsStats = stats;
function gd(r) { return getDoc(r).then(function (s) { stats.reads++; return s; }); }
function gq(q) { return getDocs(q).then(function (s) { stats.reads += Math.max(1, s.size); return s; }); }
function gc(q) { return getCountFromServer(q).then(function (s) { stats.reads += Math.max(1, Math.ceil(s.data().count / 1000)); return s.data().count; }); }
function commit(b, n) { return b.commit().then(function (r) { stats.writes += n || 1; return r; }); }

// Firestore values in a form that can be cached (and back again, exactly:
// a Timestamp keeps its nanoseconds, so writing a cached value back is a no-op).
function plain(v) {
  if (v instanceof Timestamp) return { __ts: [v.seconds, v.nanoseconds] };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    var o = {};
    Object.keys(v).forEach(function (k) { o[k] = plain(v[k]); });
    return o;
  }
  return v;
}
function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if (Array.isArray(v.__ts) && v.__ts.length === 2) return new Timestamp(v.__ts[0], v.__ts[1]);
    var o = {};
    Object.keys(v).forEach(function (k) { o[k] = revive(v[k]); });
    return o;
  }
  return v;
}

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
  return gd(doc(db, 'admins', uid)).then(function (s) { return s.exists(); }).catch(function () { return false; });
}

// ---------- platform configuration (public) ----------

// Always from the server (the dashboards, which act on it).
export function getConfig(docId) {
  if (!db) return Promise.resolve(null);
  return gd(doc(db, 'config', docId)).then(function (s) {
    var d = s.exists() ? s.data() : null;
    lsSet('config.' + docId, { d: plain(d) });
    return d;
  });
}
// For customers' pages: a copy up to `maxAgeMs` old is fine (the demo frame
// list and the announcement change rarely).
export function getConfigCached(docId, maxAgeMs) {
  var c = lsGet('config.' + docId, maxAgeMs == null ? 15 * 60000 : maxAgeMs);
  if (c) { stats.cacheHits++; return Promise.resolve(revive(c.d)); }
  return getConfig(docId).catch(function (e) { return staleOr(lsGet('config.' + docId), e, function (x) { return revive(x.d); }); });
}
// When the server can't be reached or the free daily quota is used up
// (Firestore refuses with 'resource-exhausted' until midnight Pacific time,
// 13:30 IST), pages carry on with whatever this browser saw last.
function staleOr(cached, err, map) {
  if (cached == null || (err && err.code === 'permission-denied')) throw err;
  console.warn('Using saved data: ' + ((err && err.code) || err));
  stats.stale = (stats.stale || 0) + 1;
  return map ? map(cached) : cached;
}
export function saveConfig(docId, data) {
  var u = auth.currentUser;
  var rec = Object.assign({}, data, { updatedAt: serverTimestamp(), updatedBy: u.uid });
  return setDoc(doc(db, 'config', docId), rec).then(function () { stats.writes++; lsDelete('config.' + docId); });
}

// ---------- legal acceptance ----------

export function myAcceptances(uid) {
  return gq(query(collection(db, 'acceptances'), where('uid', '==', uid))).then(function (snap) {
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
  return commit(b, docs.length);
}
// Which of the required documents still need accepting.
export function missingAcceptances(accepted, legal) {
  return ['retailerTerms', 'privacy'].filter(function (k) {
    return legal && legal[k] && (accepted[k] || []).indexOf(legal[k].version) === -1;
  });
}

// ---------- shops ----------

export function getShop(id) {
  return gd(doc(db, 'shops', id)).then(function (s) { return s.exists() ? withId(s) : null; });
}
// For customers' pages: from the shop list or an earlier visit if recent.
var SHOP_MAX_AGE = 15 * 60000;
export function getShopCached(id) {
  var c = lsGet('shop.' + id, SHOP_MAX_AGE);
  if (c) { stats.cacheHits++; return Promise.resolve(revive(c)); }
  return getShop(id).then(function (s) { if (s && s.status === 'approved') lsSet('shop.' + id, plain(s)); return s; })
    .catch(function (e) { return staleOr(lsGet('shop.' + id), e, revive); });
}
export function getShopPrivate(id) {
  return gd(doc(db, 'shopPrivate', id)).then(function (s) { return s.exists() ? s.data() : null; });
}
// Approved shops, newest first. The list is kept in the browser for 15
// minutes (one read per shop each time it is fetched).
export function listApprovedShops(max, opts) {
  need();
  max = max || 100;
  var key = 'shops.' + max;
  if (!(opts && opts.fresh)) {
    var c = lsGet(key, SHOP_MAX_AGE) || (max < 100 ? lsGet('shops.100', SHOP_MAX_AGE) : null);
    if (c) { stats.cacheHits++; return Promise.resolve(revive(c).slice(0, max)); }
  }
  return gq(query(collection(db, 'shops'), where('status', '==', 'approved'), orderBy('createdAt', 'desc'), limit(max)))
    .then(function (snap) {
      var list = snap.docs.map(withId);
      lsSet(key, plain(list));
      list.forEach(function (s) { lsSet('shop.' + s.id, plain(s)); });
      return list;
    }).catch(function (e) { return staleOr(lsGet(key) || lsGet('shops.100'), e, function (x) { return revive(x).slice(0, max); }); });
}

// The application: acceptances (if not yet given), the public profile and the
// private details, in one batch so they stand or fall together.
export function applyForShop(uid, profile, priv, legal, alreadyAccepted) {
  var b = writeBatch(db);
  var toAccept = missingAcceptances(alreadyAccepted || {}, legal);
  acceptanceRefs(b, uid, toAccept, legal);
  b.set(doc(db, 'shops', uid), Object.assign({}, profile, { status: 'pending', ownerUid: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  b.set(doc(db, 'shopPrivate', uid), Object.assign({}, priv, { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  return commit(b, toAccept.length + 2);
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
  return commit(b, priv ? 2 : 1).then(function () { lsDelete('shop.' + uid); lsDelete('shops.100'); lsDelete('shops.6'); });
}

// ---------- products ----------

export function productFromSnap(snap) {
  var p = withId(snap);
  p.createdMs = tsMillis(p.createdAt);
  p.updatedMs = tsMillis(p.updatedAt);
  p.priceUpdatedMs = p.pricing ? tsMillis(p.pricing.updatedAt) : null;
  return p;
}
function productFromCache(o) {
  var p = revive(o);
  p.createdMs = tsMillis(p.createdAt);
  p.updatedMs = tsMillis(p.updatedAt);
  p.priceUpdatedMs = p.pricing ? tsMillis(p.pricing.updatedAt) : null;
  return p;
}
function cacheableProduct(p) {
  var o = Object.assign({}, p);
  delete o.createdMs; delete o.updatedMs; delete o.priceUpdatedMs;
  return plain(o);
}

// One product, always from the server (the shop dashboard and admin).
export function getProduct(id) {
  return gd(doc(db, 'products', id)).then(function (s) {
    var p = s.exists() ? productFromSnap(s) : null;
    if (p) rememberMine(p);
    return p;
  });
}

// Published products for customers' pages, by id. A product is taken from the
// browser's cache when the catalogue index says it hasn't changed since
// (`known[id]` is its updatedAt in ms), or when no version is known and the
// cached copy is under 10 minutes old. Returns { id: product | null }
// (null: not public any more, or gone).
var PRODUCT_MAX_AGE = 10 * 60000;
var inflight = {};
export function getPublicProducts(ids, known) {
  known = known || {};
  var out = {};
  return Promise.all(ids.map(function (id) {
    return cacheGet('p:' + id, known[id] ? null : PRODUCT_MAX_AGE).then(function (c) {
      if (c && (!known[id] || c.u === known[id])) { stats.cacheHits++; out[id] = productFromCache(c.p); return; }
      if (!inflight[id]) {
        inflight[id] = gd(doc(db, 'products', id)).then(function (s) {
          if (!s.exists()) return null;
          var p = productFromSnap(s);
          if (p.public !== true) return null;
          cacheSet('p:' + id, { u: p.updatedMs, p: cacheableProduct(p) });
          return p;
        }).catch(function (e) {
          if (e && (e.code === 'permission-denied' || e.code === 'not-found')) return null;
          // offline or out of quota: an older copy is better than nothing
          return cacheGet('p:' + id).then(function (old) {
            if (old) return staleOr(old, e, function (x) { return productFromCache(x.p); });
            console.warn('Could not load product ' + id, e);
            return undefined;
          });
        }).then(function (p) { delete inflight[id]; return p; });
      }
      return inflight[id].then(function (p) { out[id] = p; });
    });
  })).then(function () { return out; });
}

// A shop's published catalogue, newest first, in pages (used when a shop has
// no catalogue index yet, or too many frames for one).
export function listPublicProducts(shopId, opts) {
  opts = opts || {};
  var size = opts.pageSize || 24;
  var parts = [collection(db, 'products'), where('public', '==', true), where('shopId', '==', shopId), orderBy('createdAt', 'desc')];
  if (opts.after) parts.push(startAfter(opts.after));
  parts.push(limit(size));
  return gq(query.apply(null, parts)).then(function (snap) {
    var items = snap.docs.map(productFromSnap);
    items.forEach(function (p) { cacheSet('p:' + p.id, { u: p.updatedMs, p: cacheableProduct(p) }); });
    return { items: items, last: snap.docs.length ? snap.docs[snap.docs.length - 1] : null, more: snap.docs.length === size };
  });
}

// ---------- the catalogue index (see catalogue-index.js) ----------

function catRef(shopId) { return doc(db, 'catalogues', shopId); }

// The shop's index as { items: {id: item}, overflow }, items' times in ms;
// null when the shop has none. Kept in the browser for `maxAgeMs`.
var INDEX_MAX_AGE = 10 * 60000;
export function getCatalogueIndex(shopId, maxAgeMs) {
  return cacheGet('idx:' + shopId, maxAgeMs == null ? INDEX_MAX_AGE : maxAgeMs).then(function (c) {
    if (c) { stats.cacheHits++; return c.none ? null : c; }
    return gd(catRef(shopId)).then(function (s) {
      if (!s.exists()) { cacheSet('idx:' + shopId, { none: true }); return null; }
      var d = s.data(), items = {};
      Object.keys(d.items || {}).forEach(function (id) {
        var it = Object.assign({}, d.items[id]);
        it.c = tsMillis(it.c); it.u = tsMillis(it.u);
        items[id] = it;
      });
      var out = { items: items, overflow: d.overflow === true, updatedMs: tsMillis(d.updatedAt) };
      cacheSet('idx:' + shopId, out);
      return out;
    }).catch(function (e) {
      return cacheGet('idx:' + shopId).then(function (old) { return staleOr(old, e, function (x) { return x.none ? null : x; }); });
    });
  });
}
export function forgetCatalogueIndex(shopId) { return cacheDelete('idx:' + shopId); }

// Adds, replaces or removes (item null) one product in its shop's index, as
// part of the batch that writes the product.
function indexOp(batch, shopId, productId, item) {
  var data = { v: INDEX_VERSION, updatedAt: serverTimestamp(), items: {} };
  data.items[productId] = item || deleteField();
  batch.set(catRef(shopId), data, { mergeFields: [new FieldPath('items', productId), 'v', 'updatedAt'] });
}
// Commits a batch that includes an index change. If the product write is fine
// but the index part is refused (rules not deployed yet, or the index has hit
// the 1 MiB document limit), the product is saved without it and the index is
// left for the shop dashboard to rebuild (or marked as full).
function commitWithIndex(full, withoutIndex, shopId, n) {
  return commit(full, n).catch(function (e) {
    return commit(withoutIndex(), n - 1).then(function () {
      console.warn('Saved, but the catalogue index could not be updated', e);
      if (/maximum|exceed|too (big|large)|size/i.test((e && e.message) || '')) markIndexFull(shopId);
      return null;
    }, function () { throw e; });
  });
}
function markIndexFull(shopId) {
  return setDoc(catRef(shopId), { v: INDEX_VERSION, overflow: true, items: {}, updatedAt: serverTimestamp() })
    .catch(function (e) { console.warn('Could not mark the index as full', e); });
}

// Makes the shop's index match its products (called by the shop dashboard
// once per visit, after loading its products). One read, plus one write only
// when something differs. Returns true if it was rewritten.
export function syncCatalogueIndex(shopId, products) {
  var expected = buildItems(products || []);
  var n = Object.keys(expected).length;
  return gd(catRef(shopId)).then(function (s) {
    var d = s.exists() ? s.data() : null;
    if (n > INDEX_MAX_ITEMS) {
      if (d && d.overflow === true) return false;
      return setDoc(catRef(shopId), { v: INDEX_VERSION, overflow: true, items: {}, updatedAt: serverTimestamp() }).then(function () { stats.writes++; return true; });
    }
    if (d && d.overflow !== true && sameItems(d.items, expected, tsMillis)) return false;
    if (!d && n === 0) return false;
    return setDoc(catRef(shopId), { v: INDEX_VERSION, items: expected, updatedAt: serverTimestamp() }).then(function () {
      stats.writes++;
      forgetCatalogueIndex(shopId);
      return true;
    });
  });
}

// ---------- the shop's own products (dashboard) ----------

// The retailer's own products (any status), newest change first.
export function listMyProducts(uid, opts) {
  opts = opts || {};
  var parts = [collection(db, 'products'), where('shopId', '==', uid)];
  if (opts.status) parts.push(where('status', '==', opts.status));
  parts.push(orderBy('updatedAt', 'desc'));
  if (opts.after) parts.push(startAfter(opts.after));
  parts.push(limit(opts.pageSize || 100));
  return gq(query.apply(null, parts)).then(function (snap) {
    return { items: snap.docs.map(productFromSnap), last: snap.docs.length ? snap.docs[snap.docs.length - 1] : null, more: snap.docs.length === (opts.pageSize || 100) };
  });
}

// All of the shop's products. The list is kept in this browser; on the next
// visit only products changed since are read, plus one count to notice
// products deleted elsewhere (if the count doesn't match, everything is read
// again). A shop with 300 frames opening its dashboard: ~2 reads instead of 300.
var mine = { uid: null, map: null };
function mineKey(uid) { return 'mine:' + uid; }
function saveMine() {
  if (!mine.uid || !mine.map) return;
  var list = Object.keys(mine.map).map(function (id) { return cacheableProduct(mine.map[id]); });
  cacheSet(mineKey(mine.uid), { list: list });
}
function rememberMine(p) {
  if (!p || !mine.map || p.shopId !== mine.uid) return;
  mine.map[p.id] = p;
  saveMine();
}
function forgetMine(id) {
  if (!mine.map || !mine.map[id]) return;
  delete mine.map[id];
  saveMine();
}
function fullLoadMine(uid, max) {
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
export function loadAllMyProducts(uid, max) {
  function done(list) {
    mine = { uid: uid, map: {} };
    list.forEach(function (p) { mine.map[p.id] = p; });
    saveMine();
    return list.slice().sort(function (a, b) { return (b.updatedMs || 0) - (a.updatedMs || 0); });
  }
  return cacheGet(mineKey(uid)).then(function (c) {
    if (!c || !Array.isArray(c.list)) return fullLoadMine(uid, max).then(done);
    var cached = c.list.map(productFromCache);
    var map = {};
    var newest = null;
    cached.forEach(function (p) {
      map[p.id] = p;
      if (p.updatedAt instanceof Timestamp && (!newest || p.updatedAt.toMillis() > newest.toMillis())) newest = p.updatedAt;
    });
    var changedQ = newest
      ? query(collection(db, 'products'), where('shopId', '==', uid), where('updatedAt', '>', newest), orderBy('updatedAt', 'desc'), limit(500))
      : null;
    return Promise.all([
      changedQ ? gq(changedQ).then(function (s) { return s.docs.map(productFromSnap); }) : Promise.resolve(null),
      gc(query(collection(db, 'products'), where('shopId', '==', uid)))
    ]).then(function (r) {
      if (r[0] === null || r[0].length >= 500) return fullLoadMine(uid, max).then(done);
      r[0].forEach(function (p) { map[p.id] = p; });
      var list = Object.keys(map).map(function (k) { return map[k]; });
      if (list.length !== r[1]) return fullLoadMine(uid, max).then(done);
      stats.cacheHits += cached.length;
      return done(list);
    });
  }).catch(function (e) {
    console.warn('Product cache unavailable; reading everything', e);
    return fullLoadMine(uid, max).then(done);
  });
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
  stripUndefined(p);
  function build(withIndex) {
    var b = writeBatch(db);
    b.set(doc(db, 'products', id), p);
    if (withIndex) indexOp(b, uid, id, indexItem(p, serverTimestamp(), serverTimestamp()));
    return b;
  }
  var op = p.public ? commitWithIndex(build(true), function () { return build(false); }, uid, 2) : commit(build(false));
  return op.then(function () { if (p.public) forgetCatalogueIndex(uid); return id; });
}

function samePricing(a, b) {
  if (!a || !b) return false;
  return ['pricePaise', 'currency', 'taxMode', 'taxRate', 'salePaise', 'hsn', 'confirmed'].every(function (k) { return (a[k] == null ? null : a[k]) === (b[k] == null ? null : b[k]); });
}

// Saves changes to one of the shop's products. `current` is the product as
// last read; the result is what was written (for the page to show). The
// shop's catalogue index changes in the same batch when the product is (or
// was) public.
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
  var shopId = current.shopId;
  var touchIndex = out.public || current.public === true;
  function build(withIndex) {
    var b = writeBatch(db);
    b.update(doc(db, 'products', current.id), out);
    if (withIndex) {
      var merged = Object.assign({}, current, out);
      indexOp(b, shopId, current.id, out.public ? indexItem(merged, current.createdAt || null, serverTimestamp()) : null);
    }
    return b;
  }
  var op = touchIndex ? commitWithIndex(build(true), function () { return build(false); }, shopId, 2) : commit(build(false));
  return op.then(function () {
    cacheDelete('p:' + current.id);
    if (touchIndex) forgetCatalogueIndex(shopId);
    return Object.assign({}, current, out, { public: out.public });
  });
}

// Removes a product, its index entry and all its stored files.
export function deleteProduct(p) {
  var files = imageFiles(p);
  function build(withIndex) {
    var b = writeBatch(db);
    b.delete(doc(db, 'products', p.id));
    if (withIndex) indexOp(b, p.shopId, p.id, null);
    return b;
  }
  var op = p.public === true ? commitWithIndex(build(true), function () { return build(false); }, p.shopId, 2) : commit(build(false));
  return op.then(function () {
    forgetMine(p.id);
    cacheDelete('p:' + p.id);
    if (p.public === true) forgetCatalogueIndex(p.shopId);
    return deleteFiles(files);
  });
}

// The stored files of a product (for deleting), as image info objects.
export function imageFiles(p) {
  var im = p.images || {}, out = [];
  ['thumb', 'cutout', 'side', 'source', 'manifest'].forEach(function (k) { if (im[k] && (im[k].path || im[k].fid)) out.push(im[k]); });
  return out;
}
// Kept for callers that want paths only.
export function imagePaths(p) { return imageFiles(p).map(function (i) { return i.path; }).filter(Boolean); }

// ---------- stored files (retailers' frame photos only) ----------
//
// Free plan ('firestore'): a file becomes a data: URL. Thumbnails and the
// small fitting-data file are kept on the product itself (so a catalogue card
// needs no extra read); cut-outs, temple photos and the private original photo
// each get a productFiles document, read only when a frame is tried on or
// re-processed. Pictures too big for a Firestore document (1 MiB) are scaled
// down first; the try-on scales its fitting points to the picture's real size.
//
// Blaze ('storage'): Cloud Storage, as before.

var IMMUTABLE = 'public, max-age=31536000, immutable';
var INLINE_MAX = 40000;        // characters of data: URL kept on the product
var FILE_MAX = 900000;         // per productFiles document (limit is 1 MiB)
var SOURCE_MAX = 600000;       // the original photo, kept smaller on the free plan

export function assetVersion() { return Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

function extFor(type) { return type === 'image/webp' ? 'webp' : type === 'image/jpeg' ? 'jpg' : type === 'application/json' ? 'json' : 'png'; }

export function fileIdFor(productId, name) { return productId + '__' + name; }

function blobToDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () { resolve(String(r.result)); };
    r.onerror = function () { reject(r.error || new Error('Could not read the file')); };
    r.readAsDataURL(blob);
  });
}
function dataUrlToBlob(u) {
  var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(u || '');
  if (!m) throw new Error('not a data URL');
  var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]), arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: m[1] });
}
function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(blob), img = new Image();
    img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
// The picture as a data: URL of at most maxChars, scaled down if needed.
function imageWithin(blob, maxChars) {
  return blobToDataUrl(blob).then(function (url) {
    if (url.length <= maxChars) return { url: url, resized: false };
    return decodeImage(blob).then(function (img) {
      var type = blob.type || 'image/png';
      var q = type === 'image/png' ? undefined : (type === 'image/jpeg' ? 0.85 : 0.86);
      var w0 = img.width, h0 = img.height, scale = 1, out = url, w = w0, h = h0;
      for (var i = 0; i < 14 && out.length > maxChars; i++) {
        scale *= Math.sqrt(maxChars / out.length) * 0.95;
        w = Math.max(16, Math.round(w0 * scale)); h = Math.max(16, Math.round(h0 * scale));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var g = c.getContext('2d');
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, w, h);
        out = q == null ? c.toDataURL(type) : c.toDataURL(type, q);
      }
      if (img.close) img.close();
      if (out.length > maxChars) throw Object.assign(new Error('Picture too large to store'), { code: 'file-too-large' });
      return { url: out, resized: true, w: w, h: h };
    });
  });
}
function bytesOf(dataUrl) {
  var i = dataUrl.indexOf(',');
  return Math.round((dataUrl.length - i - 1) * 3 / 4);
}
function clean(o) { Object.keys(o).forEach(function (k) { if (o[k] === undefined) delete o[k]; }); return o; }

// Stores one file for a product. kind: 'assets' (shown to customers once
// published) or 'source' (the original photo, private to the shop).
// Resolves with the image info to keep on the product:
//   { path, bytes, w, h } plus url (Storage), data (inline) or fid (productFiles).
export function uploadProductFile(uid, productId, kind, name, blob, extra) {
  var type = blob.type || 'image/png';
  var file = name + '.' + extFor(type);
  var path = 'shops/' + uid + '/products/' + productId + '/' + kind + '/' + file;
  if (IMAGE_STORE === 'storage') {
    var r = ref(storage, path);
    var meta = { contentType: type, cacheControl: kind === 'assets' ? IMMUTABLE : 'private, max-age=0' };
    return uploadBytes(r, blob, meta).then(function () {
      var info = clean(Object.assign({ path: path, bytes: blob.size }, extra || {}));
      if (kind === 'source') return info;               // private: no public link is ever made
      return getDownloadURL(r).then(function (url) { info.url = url; return info; });
    });
  }
  var isJson = type === 'application/json';
  var inlineWanted = kind === 'assets' && (/^thumb/.test(name) || isJson);
  var max = kind === 'source' ? SOURCE_MAX : inlineWanted && !isJson ? INLINE_MAX : FILE_MAX;
  var prep = isJson ? blobToDataUrl(blob).then(function (u) { return { url: u, resized: false }; }) : imageWithin(blob, max);
  return prep.then(function (res) {
    var info = clean(Object.assign({ path: path }, extra || {}));
    if (res.resized) { info.w = res.w; info.h = res.h; }
    info.bytes = bytesOf(res.url);
    if (inlineWanted && res.url.length <= INLINE_MAX) { info.data = res.url; return info; }
    if (res.url.length > FILE_MAX) throw Object.assign(new Error('File too large to store'), { code: 'file-too-large' });
    var fid = fileIdFor(productId, name);
    var rec = clean({ shopId: uid, productId: productId, kind: kind, type: type, data: res.url, bytes: info.bytes, createdAt: serverTimestamp() });
    if (typeof info.w === 'number') rec.w = info.w;
    if (typeof info.h === 'number') rec.h = info.h;
    return setDoc(doc(db, 'productFiles', fid), rec).then(function () {
      stats.writes++;
      if (kind === 'assets') cacheSet('f:' + fid, res.url);
      info.fid = fid;
      return info;
    });
  });
}

// A link or data: URL for a stored file (cut-out, temple photo, fitting data).
// productFiles documents never change (each new version gets a new id), so
// they are cached in the browser without an age limit.
var fileInflight = {};
export function fileUrl(info) {
  if (!info) return Promise.reject(new Error('No file'));
  if (info.url) return Promise.resolve(info.url);
  if (info.data) return Promise.resolve(info.data);
  if (!info.fid) return Promise.reject(new Error('No file'));
  var fid = info.fid;
  return cacheGet('f:' + fid).then(function (c) {
    if (c) { stats.cacheHits++; return c; }
    if (!fileInflight[fid]) {
      fileInflight[fid] = gd(doc(db, 'productFiles', fid)).then(function (s) {
        delete fileInflight[fid];
        if (!s.exists()) throw new Error('File not found');
        var d = s.data();
        if (d.kind === 'assets') cacheSet('f:' + fid, d.data);
        return d.data;
      }, function (e) { delete fileInflight[fid]; throw e; });
    }
    return fileInflight[fid];
  });
}

// Deletes stored files. Accepts image info objects (preferred) or Storage paths.
export function deleteFiles(list) {
  return Promise.all((list || []).map(function (x) {
    if (!x) return null;
    var info = typeof x === 'string' ? { path: x } : x;
    if (info.fid) {
      return deleteDoc(doc(db, 'productFiles', info.fid)).then(function () { stats.writes++; cacheDelete('f:' + info.fid); }).catch(function (e) {
        if (e && (e.code === 'not-found' || e.code === 'permission-denied')) return null;
        console.warn('Could not delete ' + info.fid, e);
        return null;
      });
    }
    if (info.data || !info.path || info.url == null && IMAGE_STORE !== 'storage') return null;   // inline: nothing stored separately
    return deleteObject(ref(storage, info.path)).catch(function (e) {
      if (e && e.code === 'storage/object-not-found') return null;
      console.warn('Could not delete ' + info.path, e);
      return null;
    });
  }));
}

// The original photo, for re-processing (the owning shop only).
export function getSourceBlob(info) {
  if (typeof info === 'string') info = { path: info };
  if (info && info.fid) {
    return gd(doc(db, 'productFiles', info.fid)).then(function (s) {
      if (!s.exists()) throw new Error('Original photo not found');
      return dataUrlToBlob(s.data().data);
    });
  }
  return getBlob(ref(storage, info.path));
}

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
// The fitting data of a product, wherever it is stored.
export function loadManifest(info) { return fileUrl(info).then(fetchManifest); }

// ---------- reports of wrong or inappropriate listings ----------

export function submitReport(product, reason, note) {
  return ensureSignedIn().then(function (u) {
    var b = writeBatch(db);
    b.set(doc(db, 'limits', u.uid), { lastReportAt: serverTimestamp() });
    var rec = { productId: product.id, shopId: product.shopId, reason: reason, createdAt: serverTimestamp(), status: 'open', reporterUid: u.uid };
    if (note) rec.note = String(note).slice(0, 500);
    b.set(doc(collection(db, 'reports')), rec);
    return commit(b, 2);
  });
}

// ---------- the old single-shop library (before shops existed) ----------

export function legacyFrames(uid) {
  return gq(collection(db, 'users', uid, 'frames')).then(function (snap) { return snap.docs.map(withId); });
}
export function legacyFull(uid, id) {
  return Promise.all([
    gd(doc(db, 'users', uid, 'framesFull', id)),
    gd(doc(db, 'users', uid, 'framesSource', id)).catch(function () { return null; }),
    gd(doc(db, 'users', uid, 'framesSide', id)).catch(function () { return null; })
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
  return setDoc(doc(collection(db, 'auditLog')), rec).then(function () { stats.writes++; }).catch(function (e) { console.warn('Audit log write failed', e); });
}

export function adminListShops(status) {
  var parts = [collection(db, 'shops')];
  if (status) parts.push(where('status', '==', status));
  parts.push(orderBy('createdAt', 'desc'), limit(300));
  return gq(query.apply(null, parts)).then(function (snap) {
    return snap.docs.map(function (d) { var s = withId(d); s.createdMs = tsMillis(s.createdAt); s.statusMs = tsMillis(s.statusAt); return s; });
  });
}

// Changes a shop's status, re-derives every product's `public` flag in the
// same batches (approved: ready published products appear; anything else:
// all of them disappear) and rewrites the shop's catalogue index to match.
export function adminSetShopStatus(shop, status, reason) {
  var u = auth.currentUser;
  return gq(query(collection(db, 'products'), where('shopId', '==', shop.id))).then(function (snap) {
    var products = snap.docs.map(productFromSnap);
    var changes = products.filter(function (p) { return p.public !== shouldBePublic(p, status); });
    var batches = [], b = writeBatch(db), n = 2;
    b.update(doc(db, 'shops', shop.id), { status: status, statusReason: reason || '', statusAt: serverTimestamp(), reviewedBy: u.uid, updatedAt: serverTimestamp() });
    var items = {};
    products.forEach(function (p) {
      var pub = shouldBePublic(p, status);
      if (!pub) return;
      var changed = p.public !== pub;
      items[p.id] = indexItem(p, p.createdAt || null, changed ? serverTimestamp() : (p.updatedAt || null));
    });
    var tooMany = Object.keys(items).length > INDEX_MAX_ITEMS;
    b.set(catRef(shop.id), tooMany ? { v: INDEX_VERSION, overflow: true, items: {}, updatedAt: serverTimestamp() }
      : { v: INDEX_VERSION, items: items, updatedAt: serverTimestamp() });
    changes.forEach(function (p) {
      if (n >= 450) { batches.push(b); b = writeBatch(db); n = 0; }
      b.update(doc(db, 'products', p.id), { public: shouldBePublic(p, status), updatedAt: serverTimestamp() });
      n++;
    });
    batches.push(b);
    return batches.reduce(function (pr, bt) { return pr.then(function () { return commit(bt); }); }, Promise.resolve())
      .then(function () { lsDelete('shop.' + shop.id); lsDelete('shops.100'); lsDelete('shops.6'); forgetCatalogueIndex(shop.id); })
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
  return gq(query.apply(null, parts)).then(function (snap) {
    return { items: snap.docs.map(productFromSnap), last: snap.docs.length ? snap.docs[snap.docs.length - 1] : null, more: snap.docs.length === 50 };
  });
}

export function adminModerateProduct(p, state, reason, shopStatus) {
  var u = auth.currentUser;
  var mod = state === 'suspended' ? { state: 'suspended', reason: reason || '', at: serverTimestamp(), by: u.uid } : { state: 'ok' };
  var next = Object.assign({}, p, { moderation: { state: state } });
  var pub = shouldBePublic(next, shopStatus);
  var touchIndex = pub || p.public === true;
  function build(withIndex) {
    var b = writeBatch(db);
    b.update(doc(db, 'products', p.id), { moderation: mod, public: pub, updatedAt: serverTimestamp() });
    if (withIndex) indexOp(b, p.shopId, p.id, pub ? indexItem(next, p.createdAt || null, serverTimestamp()) : null);
    return b;
  }
  var op = touchIndex ? commitWithIndex(build(true), function () { return build(false); }, p.shopId, 2) : commit(build(false));
  return op
    .then(function () { cacheDelete('p:' + p.id); forgetCatalogueIndex(p.shopId); return adminAudit(state === 'suspended' ? 'product.suspend' : 'product.restore', 'product', p.id, reason); })
    .then(function () { return { public: pub, moderation: mod }; });
}

export function adminDeleteProduct(p, reason) {
  return deleteProduct(p).then(function () { return adminAudit('product.remove', 'product', p.id, reason); });
}

export function adminListReports(status) {
  return gq(query(collection(db, 'reports'), where('status', '==', status || 'open'), orderBy('createdAt', 'desc'), limit(200)))
    .then(function (snap) { return snap.docs.map(function (d) { var r = withId(d); r.createdMs = tsMillis(r.createdAt); return r; }); });
}
export function adminResolveReport(r, status, resolution) {
  var u = auth.currentUser;
  return updateDoc(doc(db, 'reports', r.id), { status: status, resolution: resolution || '', resolvedAt: serverTimestamp(), resolvedBy: u.uid })
    .then(function () { stats.writes++; return adminAudit('report.' + status, 'report', r.id, resolution); });
}

export function adminListAcceptances(docKey) {
  var parts = [collection(db, 'acceptances')];
  if (docKey) parts.push(where('doc', '==', docKey));
  parts.push(orderBy('acceptedAt', 'desc'), limit(300));
  return gq(query.apply(null, parts)).then(function (snap) {
    return snap.docs.map(function (d) { var a = withId(d); a.acceptedMs = tsMillis(a.acceptedAt); return a; });
  });
}

export function adminListAudit() {
  return gq(query(collection(db, 'auditLog'), orderBy('at', 'desc'), limit(200)))
    .then(function (snap) { return snap.docs.map(function (d) { var a = withId(d); a.atMs = tsMillis(a.at); return a; }); });
}

// Platform-wide numbers from server-side counts (each costs about one read
// per 1,000 matching documents, not one per document).
export function adminCounts() {
  var P = collection(db, 'products'), S = collection(db, 'shops');
  function c(q) { return gc(q).catch(function () { return null; }); }
  return Promise.all([
    c(S), c(query(S, where('status', '==', 'approved'))), c(query(S, where('status', '==', 'pending'))), c(query(S, where('status', '==', 'suspended'))),
    c(P), c(query(P, where('public', '==', true))), c(query(P, where('tryOn.status', '==', 'ready'))), c(query(P, where('tryOn.status', '==', 'failed'))),
    c(query(P, where('moderation.state', '==', 'suspended'))),
    getAggregateFromServer(P, { bytes: sum('assetBytes'), n: count() }).then(function (s) { stats.reads++; return s.data().bytes; }).catch(function () { return null; }),
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
  return getAggregateFromServer(P, { n: count(), bytes: sum('assetBytes') }).then(function (s) { stats.reads++; return s.data(); }).catch(function () { return null; });
}

export { tsMillis };
