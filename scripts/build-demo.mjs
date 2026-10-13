// Builds the public demo's six frames from their photos (demo/src/*.png) with
// the site's real pipeline: frame-extract.js finds the frame, its lens
// openings and fitting points exactly as it does for a shop's phone photo,
// then asset-build.js crops the cut-out and writes the fitting metadata.
//
//   node scripts/build-demo.mjs
//
// Writes demo/<id>/cutout.png, demo/<id>/thumb.png and demo/catalog.js.
// Fails loudly if any photo doesn't extract cleanly, so a broken demo can't
// be committed by accident.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPNG } from '../tests/png.mjs';
import { extractFrame, resizeRGBA } from '../frame-extract.js';
import { analyseFrame } from '../glasses-model.js';
import { alphaBoxRGBA, cropRGBA, buildFit, scalePt, makeManifest, manifestOk } from '../asset-build.js';
import { encodePNG } from './png-write.mjs';

var ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
var THUMB = 260;

// What each demo frame is (they're original computer-rendered designs, not
// products of any shop or brand). Sizes are the millimetres they were drawn at.
export var DEMO_SPECS = [
  { id: 'demo-black-rectangle', name: 'Black rectangle', tags: { shape: 'rectangle', color: 'black', gender: 'unisex', rim: 'fullrim' }, size: { eye: 53, bridge: 18, temple: 145 }, material: 'Acetate', expect: { rimType: 'full', translucent: false } },
  { id: 'demo-silver-rectangle', name: 'Thin silver rectangle', tags: { shape: 'rectangle', color: 'silver', gender: 'unisex', rim: 'fullrim' }, size: { eye: 54, bridge: 17, temple: 140 }, material: 'Metal', expect: { rimType: 'full', translucent: false } },
  { id: 'demo-gold-round', name: 'Gold round', tags: { shape: 'round', color: 'gold', gender: 'unisex', rim: 'fullrim' }, size: { eye: 47, bridge: 21, temple: 145 }, material: 'Metal', expect: { rimType: 'full', translucent: false } },
  { id: 'demo-crystal-square', name: 'Translucent blue-grey square', tags: { shape: 'square', color: 'clear', gender: 'unisex', rim: 'fullrim' }, size: { eye: 52, bridge: 19, temple: 145 }, material: 'Translucent acetate', expect: { rimType: 'full', translucent: true } },
  { id: 'demo-tortoise-catseye', name: 'Tortoiseshell cat-eye', tags: { shape: 'catseye', color: 'tortoise', gender: 'womens', rim: 'fullrim' }, size: { eye: 54, bridge: 17, temple: 140 }, material: 'Acetate', expect: { rimType: 'full' } },
  { id: 'demo-black-browline', name: 'Semi-rimless browline', tags: { shape: 'browline', color: 'black', gender: 'mens', rim: 'semirimless' }, size: { eye: 51, bridge: 21, temple: 145 }, material: 'Acetate and metal', expect: { rimType: 'semi' } }
];

// Resizes with premultiplied alpha, so transparent pixels don't leave fringes.
function resizePremul(img, W, H) {
  var n = img.width * img.height, pm = new Uint8ClampedArray(n * 4);
  for (var i = 0; i < n; i++) {
    var a = img.data[i * 4 + 3] / 255;
    pm[i * 4] = img.data[i * 4] * a; pm[i * 4 + 1] = img.data[i * 4 + 1] * a; pm[i * 4 + 2] = img.data[i * 4 + 2] * a; pm[i * 4 + 3] = img.data[i * 4 + 3];
  }
  var out = resizeRGBA(pm, img.width, img.height, W, H);
  for (var j = 0; j < W * H; j++) {
    var al = out[j * 4 + 3] / 255;
    if (al > 0) { out[j * 4] = Math.min(255, out[j * 4] / al); out[j * 4 + 1] = Math.min(255, out[j * 4 + 1] / al); out[j * 4 + 2] = Math.min(255, out[j * 4 + 2] / al); }
  }
  return { data: out, width: W, height: H };
}

// The cut-out centred in a square at 92%, like the site's thumbnails.
function thumbnail(img) {
  var s = Math.min(THUMB / img.width, THUMB / img.height) * 0.92;
  var w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  var small = resizePremul(img, w, h);
  var out = new Uint8ClampedArray(THUMB * THUMB * 4), ox = Math.round((THUMB - w) / 2), oy = Math.round((THUMB - h) / 2);
  for (var y = 0; y < h; y++) out.set(small.data.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * THUMB + ox) * 4);
  return { data: out, width: THUMB, height: THUMB };
}

export function buildOne(spec) {
  var photo = readPNG(path.join(ROOT, 'demo', 'src', spec.id + '.png'));
  var r = extractFrame(photo, {});
  if (!r.ok) throw new Error(spec.id + ': extraction failed: ' + r.reason);
  var level = r.representation.level;
  var box = alphaBoxRGBA(r.cutout.data, r.width, r.height);
  var cut = cropRGBA({ data: r.cutout.data, width: r.width, height: r.height }, box);
  var p1 = scalePt(r.landmarks.lensL, box.x, box.y, 1, 1), p2 = scalePt(r.landmarks.lensR, box.x, box.y, 1, 1);
  var fit = buildFit(r, level, box.x, box.y, 1, 1);
  var manifest = makeManifest({ imgW: cut.width, imgH: cut.height, p1: p1, p2: p2, fit: fit });
  if (!manifestOk(manifest)) throw new Error(spec.id + ': bad manifest');
  var model = analyseFrame(cut, p1, p2, { tags: spec.tags, size: spec.size, fit: fit });
  if (!model.ok) throw new Error(spec.id + ': 3D model failed: ' + model.reason);
  return { spec: spec, r: r, cut: cut, manifest: manifest, model: model, level: level };
}

function main() {
  var entries = [];
  DEMO_SPECS.forEach(function (spec) {
    var b = buildOne(spec);
    var r = b.r;
    if (spec.expect.rimType && r.rimType !== spec.expect.rimType) throw new Error(spec.id + ': expected rim ' + spec.expect.rimType + ', got ' + r.rimType);
    if (spec.expect.translucent != null && r.translucent !== spec.expect.translucent) throw new Error(spec.id + ': expected translucent=' + spec.expect.translucent);
    var dir = path.join(ROOT, 'demo', spec.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cutout.png'), encodePNG(b.cut));
    fs.writeFileSync(path.join(dir, 'thumb.png'), encodePNG(thumbnail(b.cut)));
    entries.push({
      id: spec.id, demo: true, name: spec.name, tags: Object.assign({ free: [] }, spec.tags), size: spec.size, material: spec.material,
      frameType: 'eyeglasses', level: b.level, rimType: r.rimType, translucent: r.translucent, prepared: 'auto',
      quality: Math.round(r.quality * 100) / 100, warnings: r.warnings.map(function (w) { return w.code; }),
      thumb: 'demo/' + spec.id + '/thumb.png', cutout: 'demo/' + spec.id + '/cutout.png', manifest: b.manifest
    });
    console.log(spec.id.padEnd(24), r.rimType.padEnd(5), (r.translucent ? 'translucent' : 'solid').padEnd(12), b.level,
      'quality', r.quality.toFixed(2), b.cut.width + 'x' + b.cut.height, 'warnings:', r.warnings.map(function (w) { return w.code; }).join(',') || '-');
  });
  var js = '// Generated by scripts/build-demo.mjs from demo/src/*.png. Do not edit by hand.\n' +
    '// Six original, computer-rendered demo frames (not products of any shop or brand),\n' +
    '// prepared by the site\'s own frame-extraction pipeline.\n' +
    'export var DEMO_FRAMES = ' + JSON.stringify(entries, null, 1) + ';\n';
  fs.writeFileSync(path.join(ROOT, 'demo', 'catalog.js'), js);
  console.log('wrote demo/catalog.js (' + Math.round(js.length / 1024) + ' KB)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
