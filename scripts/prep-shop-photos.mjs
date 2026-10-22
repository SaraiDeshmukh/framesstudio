// Prepares try-on assets for a folder of frame photos with the site's own
// pipeline (as the Add-a-frame page does): extraction at 1000 px, cut-out,
// fitting data, thumbnail. Used to bulk-load a shop's frames as drafts.
//
//   node scripts/prep-shop-photos.mjs <inDir of .png> <outDir>
//
// Writes <id>.cutout.png, <id>.thumb.png, <id>.photo-thumb.png, <id>.json
// (manifest + extraction summary) for each photo, and summary.json.
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from '../tests/png.mjs';
import { extractFrame } from '../frame-extract.js';
import { alphaBoxRGBA, cropRGBA, buildFit, scalePt, makeManifest, manifestOk } from '../asset-build.js';
import { encodePNG } from './png-write.mjs';
import { resizeRGBA } from '../frame-extract.js';

var THUMB = 260;
function resizePremul(img, W, H) {
  var n = img.width * img.height, pm = new Uint8ClampedArray(n * 4);
  for (var i = 0; i < n; i++) { var a = img.data[i * 4 + 3] / 255; pm[i * 4] = img.data[i * 4] * a; pm[i * 4 + 1] = img.data[i * 4 + 1] * a; pm[i * 4 + 2] = img.data[i * 4 + 2] * a; pm[i * 4 + 3] = img.data[i * 4 + 3]; }
  var out = resizeRGBA(pm, img.width, img.height, W, H);
  for (var j = 0; j < W * H; j++) { var al = out[j * 4 + 3] / 255; if (al > 0) { out[j * 4] = Math.min(255, out[j * 4] / al); out[j * 4 + 1] = Math.min(255, out[j * 4 + 1] / al); out[j * 4 + 2] = Math.min(255, out[j * 4 + 2] / al); } }
  return { data: out, width: W, height: H };
}
function thumbnail(img, photo) {
  var s = Math.min(THUMB / img.width, THUMB / img.height) * (photo ? 1 : 0.92);
  var w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  var small = resizePremul(img, w, h);
  var out = new Uint8ClampedArray(THUMB * THUMB * 4), ox = Math.round((THUMB - w) / 2), oy = Math.round((THUMB - h) / 2);
  if (photo) for (var k = 0; k < THUMB * THUMB; k++) { out[k * 4] = 0xEC; out[k * 4 + 1] = 0xEE; out[k * 4 + 2] = 0xEB; out[k * 4 + 3] = 255; }
  for (var y = 0; y < h; y++) out.set(small.data.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * THUMB + ox) * 4);
  return { data: out, width: THUMB, height: THUMB };
}

var inDir = process.argv[2], outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });
var summary = [];
fs.readdirSync(inDir).filter(function (f) { return f.endsWith('.png'); }).sort().forEach(function (f) {
  var id = f.replace(/\.png$/, '');
  var photo = readPNG(path.join(inDir, f));
  fs.writeFileSync(path.join(outDir, id + '.photo-thumb.png'), encodePNG(thumbnail(photo, true)));
  var r;
  try { r = extractFrame(photo, { rimType: 'auto', translucent: 'auto' }); } catch (e) { r = { ok: false, code: 'error', reason: String(e && e.message || e) }; }
  var rec = { id: id, ok: !!r.ok, code: r.code || null, reason: r.reason || null };
  if (r.ok) {
    var level = r.representation.level;
    var box = alphaBoxRGBA(r.cutout.data, r.width, r.height);
    var cut = cropRGBA({ data: r.cutout.data, width: r.width, height: r.height }, box);
    var p1 = scalePt(r.landmarks.lensL, box.x, box.y, 1, 1), p2 = scalePt(r.landmarks.lensR, box.x, box.y, 1, 1);
    if (p1.x > p2.x) { var t = p1; p1 = p2; p2 = t; }
    var fit = buildFit(r, level, box.x, box.y, 1, 1);
    var manifest = makeManifest({ imgW: cut.width, imgH: cut.height, p1: p1, p2: p2, fit: fit, side: null });
    rec.manifestOk = manifestOk(manifest);
    rec.level = level; rec.rimType = r.rimType; rec.translucent = r.translucent; rec.quality = Math.round(r.quality * 100) / 100;
    rec.warnings = r.warnings.map(function (w) { return { code: w.code, severity: w.severity }; });
    rec.cut = { w: cut.width, h: cut.height };
    fs.writeFileSync(path.join(outDir, id + '.cutout.png'), encodePNG(cut));
    fs.writeFileSync(path.join(outDir, id + '.thumb.png'), encodePNG(thumbnail(cut)));
    fs.writeFileSync(path.join(outDir, id + '.manifest.json'), JSON.stringify(manifest));
  }
  summary.push(rec);
  console.log(id.padEnd(6), rec.ok ? 'ok   q=' + rec.quality + ' ' + rec.rimType + (rec.translucent ? ' transl' : '') + ' ' + rec.level + ' ' + rec.warnings.map(function (w) { return w.severity[0] + ':' + w.code; }).join(',') : 'FAIL ' + rec.code + ' ' + rec.reason);
});
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
