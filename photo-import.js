// Adds many frames to a shop at once from a "photo package": a .zip (or the
// files themselves) holding frames.json and, for each frame,
//   <fid>.source.jpg      the photo (kept privately, so the cut-out can be redone)
//   <fid>.thumb.webp      the picture shown in the catalogue
//   <fid>.cutout.png      optional: the try-on cut-out ...
//   <fid>.manifest.json   ... and its fitting data (both or neither)
// frames.json: { "package": "<name>", "frames": [ { fid, name, brand, sku,
//   frameType, material, colourName, tags, size, tryOn: bool, fit: {...} } ] }
// (fit.prepared 'manual': a hand-made cut-out whose manifest has only the lens centres)
// (scripts/prep-shop-photos.mjs prepares the cut-outs with the site's own
// extraction, the same as the Add-a-frame page.)
//
// Each frame becomes a product of the shop: created, its pictures stored, then
// saved as a draft, or published straight away when asked (a price is optional
// and can be added later). Frames from the same package that are already in
// the shop are skipped, so running it again only adds what's missing.
// Works for the shop itself and for the admin managing a shop.

import { unzipSync } from './vendor/fflate.mjs';

var TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', json: 'application/json' };

function typeOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name); return (m && TYPES[m[1].toLowerCase()]) || 'application/octet-stream'; }
function base(name) { return name.split('/').pop(); }

// Reads the chosen files (one .zip, or the loose files) into { name: Blob }.
export function readPackage(fileList) {
  var files = Array.prototype.slice.call(fileList || []);
  var zip = files.filter(function (f) { return /\.zip$/i.test(f.name); })[0];
  if (zip) {
    return zip.arrayBuffer().then(function (buf) {
      var all = unzipSync(new Uint8Array(buf)), out = {};
      Object.keys(all).forEach(function (k) {
        var n = base(k);
        if (!n || n.charAt(0) === '.' || /__MACOSX\//.test(k)) return;
        out[n] = new Blob([all[k]], { type: typeOf(n) });
      });
      return out;
    });
  }
  var out = {};
  files.forEach(function (f) { out[base(f.name)] = f.type ? f : new Blob([f], { type: typeOf(f.name) }); });
  return Promise.resolve(out);
}

// Checks the package and lists what it holds.
export function parsePackage(files) {
  if (!files['frames.json']) return Promise.reject(Object.assign(new Error('frames.json is missing'), { code: 'no-index' }));
  return files['frames.json'].text().then(function (txt) {
    var j = JSON.parse(txt);
    var list = Array.isArray(j) ? j : j.frames;
    var pkg = (!Array.isArray(j) && j.package) || 'package';
    if (!Array.isArray(list) || !list.length) throw Object.assign(new Error('No frames listed'), { code: 'empty' });
    var frames = list.map(function (f) {
      var fid = String(f.fid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      var hasCut = !!(f.tryOn && files[fid + '.cutout.png'] && files[fid + '.manifest.json']);
      return {
        fid: fid, meta: f, tryOn: hasCut,
        ok: !!(fid && files[fid + '.thumb.webp'] && files[fid + '.source.jpg']),
        legacyId: ('pkg:' + pkg + ':' + fid).slice(0, 80)
      };
    });
    return { pkg: String(pkg).slice(0, 40), frames: frames, files: files };
  });
}

function clean(s, max) { return typeof s === 'string' ? s.trim().slice(0, max) : ''; }
function cleanTags(t) {
  t = t || {};
  return { shape: t.shape || null, color: t.color || null, gender: t.gender || null, rim: t.rim || null,
    free: (Array.isArray(t.free) ? t.free : []).map(function (x) { return String(x).trim().toLowerCase().slice(0, 30); }).filter(Boolean).slice(0, 12) };
}
function cleanSize(s) {
  if (!s) return null;
  var o = {};
  if (s.eye >= 30 && s.eye <= 75) o.eye = Math.round(s.eye);
  if (s.bridge >= 10 && s.bridge <= 30) o.bridge = Math.round(s.bridge);
  if (s.temple >= 100 && s.temple <= 170) o.temple = Math.round(s.temple);
  return Object.keys(o).length ? o : null;
}

// Imports the package into shop `shopId`. opts: { publish, availability,
// shopStatus, onProgress(done, total, fid) }. Resolves with counts.
export function importPackage(B, shopId, pack, opts) {
  opts = opts || {};
  var res = { total: pack.frames.length, added: 0, skipped: 0, failed: 0, tryOn: 0, published: 0, errors: [] };
  var done = 0;
  function tick(fid) { done++; if (opts.onProgress) opts.onProgress(done, res.total, fid); }
  return B.loadAllMyProducts(shopId, 5000).then(function (existing) {
    var have = {};
    existing.forEach(function (p) { if (p.legacyId) have[p.legacyId] = true; });
    return pack.frames.reduce(function (chain, fr) {
      return chain.then(function () {
        if (!fr.ok) { res.failed++; res.errors.push(fr.fid + ': files missing'); tick(fr.fid); return; }
        if (have[fr.legacyId]) { res.skipped++; tick(fr.fid); return; }
        return importOne(B, shopId, pack, fr, opts).then(function (w) {
          res.added++; if (fr.tryOn) res.tryOn++; if (w && w.public) res.published++;
        }).catch(function (e) {
          console.error('Could not import ' + fr.fid, e);
          res.failed++; res.errors.push(fr.fid + ': ' + ((e && (e.code || e.message)) || e));
        }).then(function () { tick(fr.fid); });
      });
    }, Promise.resolve());
  }).then(function () { return res; });
}

function importOne(B, shopId, pack, fr, opts) {
  var m = fr.meta, f = pack.files, id = B.newProductId(), v = B.assetVersion(), uploaded = [];
  var base = {
    name: clean(m.name, 80) || 'Frame', sku: clean(m.sku, 40), brand: clean(m.brand, 40),
    colourName: clean(m.colourName, 40), material: clean(m.material, 40),
    frameType: m.frameType || null, tags: cleanTags(m.tags), size: cleanSize(m.size),
    legacyId: fr.legacyId, status: 'draft', tryOn: { status: 'pending' }
  };
  Object.keys(base).forEach(function (k) { if (base[k] === '' || base[k] === undefined) delete base[k]; });
  function up(kind, name, blob, extra) {
    return B.uploadProductFile(shopId, id, kind, name, blob, extra).then(function (info) { uploaded.push(info); return info; });
  }
  var fit = m.fit || {};
  return B.createProduct(shopId, id, base, opts.shopStatus).then(function () {
    var src = m.src || {};
    var jobs = [
      up('assets', 'thumb-' + v, f[fr.fid + '.thumb.webp'], { w: 260, h: 260 }),
      up('source', 'source-' + v, f[fr.fid + '.source.jpg'], src.w ? { w: src.w, h: src.h } : null)
    ];
    if (fr.tryOn) {
      jobs.push(up('assets', 'cutout-' + v, f[fr.fid + '.cutout.png'], fit.cut ? { w: fit.cut.w, h: fit.cut.h } : null));
      jobs.push(up('assets', 'asset-' + v, new Blob([f[fr.fid + '.manifest.json']], { type: 'application/json' })));
    }
    return Promise.all(jobs);
  }).then(function (r) {
    var images = { thumb: r[0], source: r[1] };
    var tryOn;
    if (fr.tryOn) {
      images.cutout = r[2]; images.manifest = r[3];
      // 'manual': a hand-made cut-out with its two lens centres, no fitting data
      // (the same as a shop placing the lens centres itself on Add a frame)
      var manual = fit.prepared === 'manual';
      tryOn = { status: 'ready', level: fit.level === '2d' ? '2d' : '3d', prepared: manual ? 'manual' : 'auto',
        quality: !manual && typeof fit.quality === 'number' ? fit.quality : null, rimType: manual ? null : fit.rimType || null,
        translucent: manual || fit.translucent == null ? null : !!fit.translucent,
        warnings: manual ? [] : (fit.warnings || []).slice(0, 30).map(String), hasSide: false, updatedAt: B.serverTime() };
    } else {
      // listed with its photo; the cut-out can be redone from the original in the dashboard
      tryOn = { status: 'none', error: 'cutout-needed', updatedAt: B.serverTime() };
    }
    var bytes = 0;
    Object.keys(images).forEach(function (k) { if (images[k] && images[k].bytes) bytes += images[k].bytes; });
    var changes = { images: images, tryOn: tryOn, assetBytes: Math.min(50000000, Math.round(bytes)) };
    if (opts.publish) { changes.status = 'published'; changes.availability = opts.availability || 'in_stock'; }
    var current = Object.assign({ id: id, shopId: shopId, moderation: { state: 'ok' } }, base);
    return B.saveProduct(current, changes, opts.shopStatus);
  }).catch(function (e) {
    // nothing half-made is left behind
    B.deleteFiles(uploaded);
    return B.deleteProduct({ id: id, shopId: shopId, public: false, images: {} }).catch(function () {}).then(function () { throw e; });
  });
}
