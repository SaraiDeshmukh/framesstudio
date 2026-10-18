// A small cache in the browser, used to avoid reading the same Firestore
// documents again (each document read counts against the free daily quota).
//
//   - IndexedDB where the browser allows it (survives reloads; a kiosk keeps
//     its catalogue between customers), otherwise memory only.
//   - Every entry carries the time it was stored, so callers can ask for
//     "no older than N minutes".
//   - Nothing about customers is stored here: only shops' public catalogue
//     data, frame pictures and (for a signed-in shop) its own products.
//   - At most MAX_ENTRIES entries; the oldest are dropped first.
//
// All functions return promises and never reject: a cache that fails just
// behaves as empty.

var DB_NAME = 'fts-cache';
var VAL = 'kv';                  // key -> { t, v }
var META = 'meta';               // key -> t   (small, for pruning without loading values)
var VERSION = 1;
var MAX_ENTRIES = 1200;
var mem = new Map();             // first level, this page only
var dbPromise = null;
var writesSincePrune = 0;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve) {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      var req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(VAL)) db.createObjectStore(VAL);
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    } catch (e) { resolve(null); }
  });
  return dbPromise;
}

// Runs fn(stores) in one transaction; resolves with fn's request result (if any).
function tx(mode, fn) {
  return openDb().then(function (db) {
    if (!db) return null;
    return new Promise(function (resolve) {
      try {
        var t = db.transaction([VAL, META], mode);
        var req = fn(t.objectStore(VAL), t.objectStore(META));
        t.oncomplete = function () { resolve(req && 'result' in req ? req.result : null); };
        t.onerror = function () { resolve(null); };
        t.onabort = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }).catch(function () { return null; });
}

function fresh(rec, maxAgeMs) {
  if (!rec || typeof rec !== 'object' || !('v' in rec)) return null;
  if (maxAgeMs != null && Date.now() - (rec.t || 0) > maxAgeMs) return null;
  return rec.v;
}

// The stored value for `key`, or null when missing or older than maxAgeMs.
export function cacheGet(key, maxAgeMs) {
  if (mem.has(key)) return Promise.resolve(fresh(mem.get(key), maxAgeMs));
  return tx('readonly', function (v) { return v.get(key); }).then(function (rec) {
    if (rec) mem.set(key, rec);
    return fresh(rec, maxAgeMs);
  });
}

export function cacheSet(key, value) {
  var rec = { t: Date.now(), v: value };
  mem.set(key, rec);
  return tx('readwrite', function (v, m) { v.put(rec, key); m.put(rec.t, key); return null; }).then(function () {
    if (++writesSincePrune >= 50) { writesSincePrune = 0; return prune(); }
    return null;
  });
}

export function cacheDelete(key) {
  mem.delete(key);
  return tx('readwrite', function (v, m) { v.delete(key); m.delete(key); return null; });
}

// Drops the oldest entries once there are more than MAX_ENTRIES.
function prune() {
  return openDb().then(function (db) {
    if (!db) {
      if (mem.size > MAX_ENTRIES) {
        Array.from(mem.entries()).sort(function (a, b) { return a[1].t - b[1].t; })
          .slice(0, mem.size - MAX_ENTRIES).forEach(function (e) { mem.delete(e[0]); });
      }
      return null;
    }
    return new Promise(function (resolve) {
      try {
        var t = db.transaction([VAL, META], 'readwrite');
        var meta = t.objectStore(META), val = t.objectStore(VAL);
        var all = [];
        var cur = meta.openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (c) { all.push([c.key, c.value]); c.continue(); return; }
          if (all.length <= MAX_ENTRIES) return;
          all.sort(function (a, b) { return a[1] - b[1]; });
          all.slice(0, all.length - Math.round(MAX_ENTRIES * 0.8)).forEach(function (e) {
            meta.delete(e[0]); val.delete(e[0]); mem.delete(e[0]);
          });
        };
        t.oncomplete = function () { resolve(null); };
        t.onerror = function () { resolve(null); };
        t.onabort = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }).catch(function () { return null; });
}

// Empties the cache (both levels).
export function cacheClear() {
  mem.clear();
  return tx('readwrite', function (v, m) { v.clear(); m.clear(); return null; });
}

// Small values in localStorage with an age limit (settings, the shop list):
// synchronous, so the first screen can use them straight away.
var LS_PREFIX = 'fts.c.';
export function lsGet(key, maxAgeMs) {
  try {
    var raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    var rec = JSON.parse(raw);
    if (!rec || (maxAgeMs != null && Date.now() - rec.t > maxAgeMs)) return null;
    return rec.v;
  } catch (e) { return null; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify({ t: Date.now(), v: value })); } catch (e) { /* full or blocked */ }
}
export function lsDelete(key) {
  try { localStorage.removeItem(LS_PREFIX + key); } catch (e) { /* blocked */ }
}
