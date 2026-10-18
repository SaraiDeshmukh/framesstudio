// The catalogue index: one small Firestore document per shop
// (catalogues/{shopId}) listing its published frames in a compact form:
// name, tags, size, price, availability and whether try-on is ready, but no
// pictures and no long text.
//
// Why: Firestore charges (and the free plan limits) per document read. With
// the index, opening a shop costs one read for the whole list, so search,
// filters, sorting and the frame count still cover every frame; only the
// frames actually shown (24 at a time) are then read for their pictures.
//
// The index is kept up to date by the same batched write that changes a
// product (backend.js), by the admin when a shop or listing is approved or
// suspended, and is checked and rebuilt by the shop dashboard if it ever
// drifts. It only decides what is listed and in which order: what a customer
// actually sees on a card or a frame page comes from the product document,
// which the security rules only release when it is public.
//
// Pure functions (no Firebase), so they can be unit tested.

import { cleanSize } from './frame-size.js';

export var INDEX_VERSION = 1;
// Firestore documents are limited to 1 MiB. An entry is ~200-400 bytes, so
// this stays well under the limit; past it, customers' pages fall back to
// reading the catalogue 24 frames at a time without the index.
export var INDEX_MAX_ITEMS = 2000;

// A stored picture or file: a Storage link, an inline data: URL (small files
// on the free plan) or a reference to a productFiles document.
export function hasRef(info) { return !!(info && (info.url || info.data || info.fid)); }
// Something an <img> can show directly (thumbnails are always inline or links).
export function imgSrc(info) { return info ? (info.url || info.data || '') : ''; }

export function isTryOnReady(p) {
  var im = (p && p.images) || {}, tr = (p && p.tryOn) || {};
  return tr.status === 'ready' && hasRef(im.cutout) && hasRef(im.manifest);
}

function put(o, k, v) { if (v !== undefined && v !== null && v !== '') o[k] = v; }

// The index entry for a product. `c` and `u` are its createdAt and updatedAt
// (Firestore Timestamps, or serverTimestamp() when written in the same batch,
// which makes them identical to the product's own values).
export function indexItem(p, c, u) {
  var it = {};
  it.n = typeof p.name === 'string' ? p.name.trim().slice(0, 80) : '';
  var tg = p.tags || {}, t = {};
  ['shape', 'color', 'gender', 'rim'].forEach(function (k) { put(t, k, tg[k]); });
  if (Array.isArray(tg.free) && tg.free.length) t.free = tg.free.slice(0, 12).map(function (x) { return String(x).slice(0, 30); });
  if (Object.keys(t).length) it.t = t;
  var sz = cleanSize(p.size);
  if (sz) it.z = sz;
  var pr = p.pricing;
  if (pr && Number.isInteger(pr.pricePaise)) {
    var x = { p: pr.pricePaise, m: pr.taxMode };
    if (pr.taxMode !== 'none' && typeof pr.taxRate === 'number') x.r = pr.taxRate;
    if (Number.isInteger(pr.salePaise)) x.s = pr.salePaise;
    it.pr = x;
  }
  put(it, 'a', p.availability);
  put(it, 'k', typeof p.sku === 'string' ? p.sku.slice(0, 40) : null);
  put(it, 'b', typeof p.brand === 'string' ? p.brand.slice(0, 40) : null);
  put(it, 'cn', typeof p.colourName === 'string' ? p.colourName.slice(0, 40) : null);
  put(it, 'mt', typeof p.material === 'string' ? p.material.slice(0, 40) : null);
  put(it, 'ft', p.frameType);
  var tr = p.tryOn || {}, im = p.images || {};
  if (isTryOnReady(p)) {
    it.r = true;
    put(it, 'l', tr.level);
    put(it, 'rt', tr.rimType);
    if (tr.translucent === true || tr.translucent === false) it.tl = tr.translucent;
    put(it, 'pp', tr.prepared);
    if (hasRef(im.side)) it.sd = true;
  }
  if (c != null) it.c = c;
  if (u != null) it.u = u;
  return it;
}

// A catalogue entry (the shape app.js uses for cards, filters and sorting)
// from an index item. `lite` marks it as not yet having its pictures or long
// text; those come from the product document when the frame is shown.
export function entryFromItem(id, it, shopId, millis) {
  millis = millis || function (v) { return typeof v === 'number' ? v : (v && typeof v.toMillis === 'function' ? v.toMillis() : 0); };
  var t = it.t || {};
  var pr = it.pr ? { pricePaise: it.pr.p, currency: 'INR', taxMode: it.pr.m, confirmed: true } : null;
  if (pr && it.pr.r != null) pr.taxRate = it.pr.r;
  if (pr && pr.taxMode === 'none') pr.taxRate = null;
  if (pr && it.pr.s != null) pr.salePaise = it.pr.s;
  return {
    id: id, source: 'shop', demo: false, shopId: shopId, lite: true,
    name: typeof it.n === 'string' && it.n.trim() ? it.n.trim().slice(0, 80) : null,
    tags: { shape: t.shape || null, color: t.color || null, gender: t.gender || null, rim: t.rim || null, free: Array.isArray(t.free) ? t.free.slice(0, 12) : [] },
    size: cleanSize(it.z), thumbData: '', cutoutRef: null, manifestRef: null, sideRef: null,
    hasSide: !!(it.r && it.sd), tryOnReady: !!it.r, level: it.l || '3d', rimType: it.rt || null,
    translucent: it.tl == null ? null : !!it.tl, prepared: it.pp || 'auto',
    createdAt: millis(it.c) || 0, updatedMs: millis(it.u) || 0,
    pricing: pr, priceUpdatedAt: null, availability: it.a || null,
    sku: it.k || '', brand: it.b || '', material: it.mt || '', colourName: it.cn || '', description: '',
    frameType: it.ft || null, link: '', isPublic: true, status: 'published'
  };
}

// Index items keyed by product id, for the products that are public now.
export function buildItems(products) {
  var items = {};
  (products || []).forEach(function (p) {
    if (p && p.public === true && p.id) items[p.id] = indexItem(p, p.createdAt || null, p.updatedAt || null);
  });
  return items;
}

// Whether a stored index lists exactly these items (ignoring key order and
// the representation of timestamps), so a shop's dashboard only rewrites it
// when something actually differs.
export function sameItems(a, b, millis) {
  a = a || {}; b = b || {};
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  function norm(it) {
    var o = Object.assign({}, it);
    o.c = millis(it.c); o.u = millis(it.u);
    return stable(o);
  }
  for (var i = 0; i < ka.length; i++) {
    if (!(ka[i] in b)) return false;
    if (norm(a[ka[i]]) !== norm(b[ka[i]])) return false;
  }
  return true;
}

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
