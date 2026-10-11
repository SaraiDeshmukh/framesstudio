// In-memory stand-in for Firestore, seeded by the test via window.__seed.
var store = window.__store || (window.__store = new Map(Object.entries(window.__seed || {})));
window.__writes = window.__writes || [];
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
export function getFirestore() { return {}; }
export function doc(db) { return { path: Array.prototype.slice.call(arguments, 1).join('/') }; }
export function collection(db) { return { path: Array.prototype.slice.call(arguments, 1).join('/') }; }
export function getDoc(ref) { var d = store.get(ref.path); return Promise.resolve({ id: ref.path.split('/').pop(), exists: function () { return !!d; }, data: function () { return clone(d); } }); }
export function getDocs(coll) {
  var n = coll.path.split('/').length + 1, docs = [];
  store.forEach(function (v, k) { if (k.indexOf(coll.path + '/') === 0 && k.split('/').length === n) docs.push({ id: k.split('/').pop(), data: function () { return clone(v); } }); });
  return Promise.resolve({ docs: docs, forEach: function (f) { docs.forEach(f); } });
}
export function setDoc(ref, data, opts) {
  window.__writes.push(['set', ref.path]);
  store.set(ref.path, opts && opts.merge ? Object.assign({}, store.get(ref.path), clone(data)) : clone(data));
  return Promise.resolve();
}
export function updateDoc(ref, patch) {
  window.__writes.push(['update', ref.path]);
  if (!store.has(ref.path)) return Promise.reject(new Error('not-found'));
  var cur = store.get(ref.path);
  Object.keys(patch).forEach(function (k) { var v = patch[k]; cur[k] = v && v.__inc ? (cur[k] || 0) + v.__inc : clone(v); });
  return Promise.resolve();
}
export function deleteDoc(ref) { window.__writes.push(['delete', ref.path]); store.delete(ref.path); return Promise.resolve(); }
export function serverTimestamp() { return { __ts: Date.now() }; }
export function increment(n) { return { __inc: n }; }
