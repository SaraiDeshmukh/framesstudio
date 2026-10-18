// Stand-ins for the Firebase Firestore and Auth modules, served to the page in
// place of the real SDK files during browser tests. There is no real Firebase
// project in tests (and the emulators can't be downloaded everywhere), so this
// keeps the data in memory and counts every document read the way Firestore
// bills them (1 per document returned, at least 1 per query, 1 per 1,000 for
// counts). That lets the tests check how many reads a visit really costs.
//
// It also applies the parts of the security rules that matter to what a page
// can read: unpublished products and original photos only for their shop.
// (The real rules are tested in the emulator: tests/rules.)

export function fakeFirestoreSource() {
  return `
const W = window;
const store = W.__fakeStore || (W.__fakeStore = new Map());
W.__fakeReads = W.__fakeReads || 0;
W.__fakeWrites = W.__fakeWrites || 0;
W.__fakeReadLog = W.__fakeReadLog || [];
function logRead(kind, path, n) { W.__fakeReads += n; W.__fakeReadLog.push(kind + ' ' + path + ' ' + n); }

export class Timestamp {
  constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds || 0; }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  isEqual(o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
  valueOf() { return String(this.toMillis()).padStart(16, '0'); }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
  static now() { return Timestamp.fromMillis(Date.now()); }
}
export class FieldPath { constructor(...segs) { this.segs = segs; } }
const SERVER_TS = { __sentinel: 'serverTimestamp' };
const DELETE = { __sentinel: 'delete' };
export function serverTimestamp() { return SERVER_TS; }
export function deleteField() { return DELETE; }

// seed format: timestamps as {__ts:[s, ns]}
function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if (Array.isArray(v.__ts)) return new Timestamp(v.__ts[0], v.__ts[1]);
    const o = {}; for (const k of Object.keys(v)) o[k] = revive(v[k]); return o;
  }
  return v;
}
if (W.__fakeSeed && !W.__fakeSeeded) {
  W.__fakeSeeded = true;
  for (const [k, v] of Object.entries(W.__fakeSeed)) store.set(k, revive(v));
}

function clone(v) {
  if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o; }
  return v;
}
function resolveSentinels(v, now) {
  if (v === SERVER_TS) return now;
  if (Array.isArray(v)) return v.map((x) => resolveSentinels(x, now));
  if (v && typeof v === 'object' && !(v instanceof Timestamp)) {
    const o = {};
    for (const k of Object.keys(v)) { if (v[k] === DELETE) continue; o[k] = resolveSentinels(v[k], now); }
    return o;
  }
  return v;
}
function getPath(obj, segs) { let o = obj; for (const s of segs) { if (o == null || typeof o !== 'object') return undefined; o = o[s]; } return o; }
function setPath(obj, segs, val) {
  let o = obj;
  for (let i = 0; i < segs.length - 1; i++) { if (!o[segs[i]] || typeof o[segs[i]] !== 'object') o[segs[i]] = {}; o = o[segs[i]]; }
  if (val === DELETE) delete o[segs[segs.length - 1]]; else o[segs[segs.length - 1]] = val;
}
function segsOf(f) { return f instanceof FieldPath ? f.segs : String(f).split('.'); }

export function getFirestore() { return { fake: true }; }
export function connectFirestoreEmulator() {}

let autoId = 0;
function newId() { autoId++; return 'auto' + Date.now().toString(36) + autoId.toString(36) + Math.random().toString(36).slice(2, 8); }

class DocRef { constructor(path) { this.path = path; const p = path.split('/'); this.id = p[p.length - 1]; this.parentPath = p.slice(0, -1).join('/'); this.type = 'document'; } }
class ColRef { constructor(path) { this.path = path; this.type = 'collection'; } }
export function collection(db, ...parts) { return new ColRef(parts.join('/')); }
export function doc(base, ...parts) {
  if (base instanceof ColRef) return new DocRef(base.path + '/' + (parts.length ? parts.join('/') : newId()));
  return new DocRef(parts.join('/'));
}

function user() { return W.__fakeUser || null; }
function isAdmin() { const u = user(); return !!(u && store.has('admins/' + u.uid)); }
// What a page may read (a slice of firestore.rules).
function canRead(path, data) {
  const col = path.split('/')[0];
  const u = user();
  if (col === 'products') return data.public === true || (u && u.uid === data.shopId) || isAdmin();
  if (col === 'productFiles') return data.kind === 'assets' || (u && u.uid === data.shopId) || isAdmin();
  if (col === 'shops') return data.status === 'approved' || (u && u.uid === path.split('/')[1]) || isAdmin();
  if (col === 'shopPrivate') return (u && u.uid === path.split('/')[1]) || isAdmin();
  if (col === 'admins') return !!(u && u.uid === path.split('/')[1]);
  if (col === 'users') return !!(u && u.uid === path.split('/')[1]);
  if (col === 'acceptances') return !!(u && data.uid === u.uid) || isAdmin();
  return true;
}
function denied() { return Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); }

class DocSnap {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; }
  exists() { return this._d !== undefined; }
  data() { return this._d === undefined ? undefined : clone(this._d); }
  get(f) { return getPath(this._d, segsOf(f)); }
}
const delay = () => new Promise((r) => setTimeout(r, W.__fakeLatency == null ? 5 : W.__fakeLatency));

export async function getDoc(ref) {
  await delay();
  if (W.__fakeOffline) throw Object.assign(new Error('offline'), { code: 'unavailable' });
  const d = store.get(ref.path);
  logRead('get', ref.path, 1);
  if (d === undefined) {
    const col = ref.path.split('/')[0];
    if (col === 'products' || col === 'productFiles') throw denied();   // rules see a null resource
    return new DocSnap(ref, undefined);
  }
  if (!canRead(ref.path, d)) throw denied();
  return new DocSnap(ref, d);
}

class Query { constructor(col, cons) { this.col = col; this.cons = cons; this.type = 'query'; } }
export function where(f, op, v) { return { k: 'where', f, op, v }; }
export function orderBy(f, dir) { return { k: 'orderBy', f, dir: dir || 'asc' }; }
export function limit(n) { return { k: 'limit', n }; }
export function startAfter(snap) { return { k: 'startAfter', snap }; }
export function query(base, ...cons) {
  if (base instanceof Query) return new Query(base.col, base.cons.concat(cons));
  return new Query(base, cons);
}
function cmp(a, b) {
  if (a instanceof Timestamp) a = a.toMillis();
  if (b instanceof Timestamp) b = b.toMillis();
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return a < b ? -1 : 1;
}
function matches(d, w) {
  const v = getPath(d, segsOf(w.f));
  switch (w.op) {
    case '==': return cmp(v, w.v) === 0 && v !== undefined;
    case '>': return v !== undefined && cmp(v, w.v) > 0;
    case '>=': return v !== undefined && cmp(v, w.v) >= 0;
    case '<': return v !== undefined && cmp(v, w.v) < 0;
    case '<=': return v !== undefined && cmp(v, w.v) <= 0;
    case 'in': return w.v.some((x) => cmp(v, x) === 0);
    default: throw new Error('op ' + w.op);
  }
}
function run(q) {
  const col = q.col instanceof ColRef ? q.col.path : q.col.path;
  const depth = col.split('/').length + 1;
  let rows = [];
  for (const [path, d] of store) {
    if (!path.startsWith(col + '/') || path.split('/').length !== depth) continue;
    rows.push({ path, d });
  }
  const wh = q.cons.filter((c) => c.k === 'where'), ob = q.cons.filter((c) => c.k === 'orderBy');
  const lim = q.cons.find((c) => c.k === 'limit'), sa = q.cons.find((c) => c.k === 'startAfter');
  rows = rows.filter((r) => wh.every((w) => matches(r.d, w)));
  // a list query is refused if any matching document isn't readable (like the rules)
  if (rows.some((r) => !canRead(r.path, r.d))) throw denied();
  rows.sort((a, b) => {
    for (const o of ob) { const c = cmp(getPath(a.d, segsOf(o.f)), getPath(b.d, segsOf(o.f))); if (c) return o.dir === 'desc' ? -c : c; }
    return a.path < b.path ? -1 : 1;
  });
  if (sa) { const i = rows.findIndex((r) => r.path === sa.snap.ref.path); rows = i >= 0 ? rows.slice(i + 1) : rows; }
  if (lim) rows = rows.slice(0, lim.n);
  return rows;
}
export async function getDocs(q) {
  await delay();
  if (W.__fakeOffline) throw Object.assign(new Error('offline'), { code: 'unavailable' });
  if (q instanceof ColRef) q = new Query(q, []);
  const rows = run(q);
  logRead('query', q.col.path + JSON.stringify(q.cons.filter((c) => c.k !== 'startAfter').map((c) => [c.f, c.op, c.v && c.v.toMillis ? c.v.toMillis() : c.v, c.n])), Math.max(1, rows.length));
  const docs = rows.map((r) => new DocSnap(new DocRef(r.path), r.d));
  return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
}
export async function getCountFromServer(q) {
  await delay();
  if (q instanceof ColRef) q = new Query(q, []);
  const n = run(q).length;
  logRead('count', q.col.path, Math.max(1, Math.ceil(n / 1000)));
  return { data: () => ({ count: n }) };
}
export function sum(f) { return { agg: 'sum', f }; }
export function count() { return { agg: 'count' }; }
export async function getAggregateFromServer(q, spec) {
  await delay();
  if (q instanceof ColRef) q = new Query(q, []);
  const rows = run(q);
  logRead('aggregate', q.col.path, Math.max(1, Math.ceil(rows.length / 1000)));
  const out = {};
  for (const k of Object.keys(spec)) out[k] = spec[k].agg === 'count' ? rows.length : rows.reduce((s, r) => s + (Number(getPath(r.d, segsOf(spec[k].f))) || 0), 0);
  return { data: () => out };
}

function applySet(path, data, opts, now) {
  if (opts && (opts.mergeFields || opts.merge)) {
    const cur = clone(store.get(path) || {});
    if (opts.mergeFields) {
      for (const f of opts.mergeFields) {
        const segs = segsOf(f);
        const v = getPath(data, segs);
        setPath(cur, segs, v === DELETE ? DELETE : resolveSentinels(v, now));
      }
    } else {
      (function merge(dst, src) {
        for (const k of Object.keys(src)) {
          const v = src[k];
          if (v === DELETE) delete dst[k];
          else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && v !== SERVER_TS) { if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {}; merge(dst[k], v); }
          else dst[k] = resolveSentinels(v, now);
        }
      })(cur, data);
    }
    store.set(path, cur);
  } else store.set(path, resolveSentinels(data, now));
}
function applyUpdate(path, data, now) {
  if (!store.has(path)) throw Object.assign(new Error('No document to update: ' + path), { code: 'not-found' });
  const cur = clone(store.get(path));
  for (const k of Object.keys(data)) setPath(cur, k.split('.'), data[k] === DELETE ? DELETE : resolveSentinels(data[k], now));
  store.set(path, cur);
}
function checkWrite(path, data) {
  const fail = W.__fakeDenyWrites && W.__fakeDenyWrites.some((p) => path.startsWith(p));
  if (fail) throw denied();
  if (!user()) throw denied();
}
export async function setDoc(ref, data, opts) { await delay(); checkWrite(ref.path, data); W.__fakeWrites++; applySet(ref.path, data, opts, Timestamp.now()); }
export async function updateDoc(ref, data) { await delay(); checkWrite(ref.path, data); W.__fakeWrites++; applyUpdate(ref.path, data, Timestamp.now()); }
export async function deleteDoc(ref) { await delay(); checkWrite(ref.path); W.__fakeWrites++; store.delete(ref.path); }
export function writeBatch() {
  const ops = [];
  return {
    set(ref, data, opts) { ops.push(['set', ref, data, opts]); return this; },
    update(ref, data) { ops.push(['update', ref, data]); return this; },
    delete(ref) { ops.push(['delete', ref]); return this; },
    async commit() {
      await delay();
      for (const o of ops) checkWrite(o[1].path, o[2]);
      const backup = new Map(store);
      const now = Timestamp.now();
      try {
        for (const o of ops) {
          W.__fakeWrites++;
          if (o[0] === 'set') applySet(o[1].path, o[2], o[3], now);
          else if (o[0] === 'update') applyUpdate(o[1].path, o[2], now);
          else store.delete(o[1].path);
        }
      } catch (e) { store.clear(); for (const [k, v] of backup) store.set(k, v); throw e; }
    }
  };
}
`;
}

// Firebase Auth: whoever the test says is signed in (window.__fakeUser).
export function fakeAuthSource() {
  return `
const W = window;
function mk(u) {
  if (!u) return null;
  return Object.assign({ isAnonymous: false, emailVerified: true, reload: async () => {}, getIdToken: async () => 'token' }, u);
}
export function getAuth() {
  const a = { currentUser: mk(W.__fakeUser) };
  W.__fakeAuth = a;
  return a;
}
export function connectAuthEmulator() {}
export async function setPersistence() {}
export const browserLocalPersistence = {}, browserSessionPersistence = {};
export function onAuthStateChanged(auth, cb) { setTimeout(() => cb(auth.currentUser), 0); return () => {}; }
export async function signInWithEmailAndPassword() { throw Object.assign(new Error('no'), { code: 'auth/invalid-credential' }); }
export async function createUserWithEmailAndPassword() { throw Object.assign(new Error('no'), { code: 'auth/operation-not-allowed' }); }
export async function signOut(auth) { auth.currentUser = null; W.__fakeUser = null; }
export async function sendEmailVerification() {}
export async function sendPasswordResetEmail() {}
export async function signInAnonymously(auth) { auth.currentUser = mk({ uid: 'anon1', isAnonymous: true }); return { user: auth.currentUser }; }
`;
}
