// Builds a bigger test catalogue (test data only, never in the repo): the three
// seeded studio cut-outs plus the three reference photos run through the real
// extraction, each saved the way the app saves frames.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('/opt/npm-tools/node_modules/sharp');
import { extractFrame, resizeRGBA } from '/home/claude/framesstudio/frame-extract.js';
const S = '/tmp/claude-0/-home-claude-framesstudio/7f645946-6658-5275-9df6-0c8bac7c2301/scratchpad';
const seed = JSON.parse(fs.readFileSync(S + '/frames/seed.json'));
const out = {};
const png = async (raw, w, h) => 'data:image/png;base64,' + (await sharp(Buffer.from(raw), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()).toString('base64');
async function thumbOf(dataUrl) {
  const b = Buffer.from(dataUrl.split(',')[1], 'base64');
  const t = await sharp(b).resize(260, 260, { fit: 'inside' }).png().toBuffer();
  return 'data:image/png;base64,' + t.toString('base64');
}
async function fromPhoto(file) {
  const { data, info } = await sharp(S + '/photos/' + file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let w = info.width, h = info.height, px = new Uint8ClampedArray(data);
  const k = Math.min(1, 1000 / Math.max(w, h));
  if (k < 1) { const W = Math.round(w * k), H = Math.round(h * k); px = resizeRGBA(px, w, h, W, H); w = W; h = H; }
  const r = extractFrame({ data: px, width: w, height: h });
  // crop to alpha box with 3% pad
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (r.cutout.data[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const pad = Math.max(6, Math.round((x1 - x0) * 0.03));
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, crop = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) crop.set(r.cutout.data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + cw) * 4), y * cw * 4);
  const mp = p => ({ x: Math.round((p.x - x0) * 10) / 10, y: Math.round((p.y - y0) * 10) / 10 });
  const fit = { v: 1, source: 'auto', unmixed: true, rimType: r.rimType, translucent: r.translucent, level: r.representation.level, quality: r.quality,
    lenses: r.lenses.map(l => ({ side: l.side, poly: l.poly.map(mp), centre: mp(l.centre) })),
    landmarks: { lensL: mp(r.landmarks.lensL), lensR: mp(r.landmarks.lensR), bridge: mp(r.landmarks.bridge), bridgeTop: mp(r.landmarks.bridgeTop), hingeL: mp(r.landmarks.hingeL), hingeR: mp(r.landmarks.hingeR), angle: r.landmarks.angle },
    measurements: r.measurements, warnings: r.warnings.map(x => x.code), repaired: [] };
  const imageData = await png(crop, cw, ch);
  return { imageData, p1: fit.landmarks.lensL, p2: fit.landmarks.lensR, imgW: cw, imgH: ch, fit, rimType: r.rimType, translucent: r.translucent };
}
const defs = [
  { id: 'f1', src: 'seed:f1', tags: { shape: 'rectangle', color: 'black', gender: 'unisex', rim: 'fullrim', free: ['acetate'] }, size: { eye: 52, bridge: 18, temple: 145 }, name: 'Classic Rectangle' },
  { id: 'f2', src: 'seed:f2', tags: { shape: 'round', color: 'tortoise', gender: 'womens', rim: 'fullrim', free: ['acetate'] } },
  { id: 'f3', src: 'seed:f3', tags: { shape: 'aviator', color: 'gold', gender: 'mens', rim: 'fullrim', free: ['metal'] }, size: { eye: 55, bridge: 20, temple: 140 } },
  { id: 'f1791600000001', src: 'photo:greygreen.png', tags: { shape: 'square', color: 'clear', gender: 'unisex', rim: 'fullrim', free: ['acetate', 'translucent'] } },
  { id: 'f1791600000002', src: 'photo:redcherry.png', tags: { shape: 'rectangle', color: 'navy', gender: 'mens', rim: 'fullrim', free: ['metal'] }, size: { eye: 49, bridge: 18, temple: 138 }, name: 'Red Cherry' },
  { id: 'f1791600000003', src: 'photo:semirimless.png', tags: { shape: 'rectangle', color: 'tortoise', gender: 'unisex', rim: 'semirimless', free: [] }, size: { eye: 51, bridge: 16, temple: 135 } },
];
const made = {};
for (const d of defs) {
  let full, light = {};
  if (d.src.startsWith('seed:')) {
    const sid = d.src.slice(5);
    full = seed['users/kiosk/framesFull/' + sid];
    light = { thumbData: seed['users/kiosk/frames/' + sid].thumbData, hasSide: !!seed['users/kiosk/frames/' + sid].hasSide };
    if (seed['users/kiosk/framesSide/' + sid]) out['users/kiosk/framesSide/' + d.id] = seed['users/kiosk/framesSide/' + sid];
  } else {
    const r = await fromPhoto(d.src.slice(6));
    full = { imageData: r.imageData, p1: r.p1, p2: r.p2, imgW: r.imgW, imgH: r.imgH, fit: r.fit };
    light = { thumbData: await thumbOf(r.imageData), level: r.fit.level, rimType: r.rimType, translucent: r.translucent, prepared: 'auto' };
  }
  made[d.id] = { full, light };
  out['users/kiosk/frames/' + d.id] = Object.assign({ tags: d.tags, createdAt: { __ts: 0 } }, d.size ? { size: d.size } : {}, d.name ? { name: d.name } : {}, light);
  out['users/kiosk/framesFull/' + d.id] = full;
}
// a few more catalogue entries reusing the same pictures, so the grid, filters and
// paging behave like a real ~20-frame catalogue (test data only)
const extra = [
  ['f1', { shape: 'rectangle', color: 'black', gender: 'mens', rim: 'fullrim', free: ['acetate', 'bold'] }, { eye: 54, bridge: 18, temple: 145 }],
  ['f2', { shape: 'round', color: 'tortoise', gender: 'unisex', rim: 'fullrim', free: ['acetate'] }, { eye: 47, bridge: 21, temple: 140 }],
  ['f3', { shape: 'aviator', color: 'gold', gender: 'unisex', rim: 'fullrim', free: ['metal', 'pilot'] }, null],
  ['f1791600000001', { shape: 'square', color: 'clear', gender: 'womens', rim: 'fullrim', free: ['translucent'] }, { eye: 50, bridge: 20, temple: 145 }],
  ['f1791600000003', { shape: 'browline', color: 'tortoise', gender: 'mens', rim: 'semirimless', free: [] }, null],
  ['f1791600000002', { shape: 'rectangle', color: 'navy', gender: 'unisex', rim: 'fullrim', free: ['metal', 'light'] }, { eye: 52, bridge: 17, temple: 140 }],
  ['f2', { shape: 'oval', color: 'tortoise', gender: 'kids', rim: 'fullrim', free: [] }, { eye: 44, bridge: 16, temple: 125 }],
  ['f1', { shape: 'square', color: 'black', gender: 'womens', rim: 'fullrim', free: [] }, null],
  ['f3', { shape: 'aviator', color: 'gold', gender: 'mens', rim: 'fullrim', free: ['metal'] }, { eye: 58, bridge: 14, temple: 140 }],
  ['f1791600000001', { shape: 'square', color: 'clear', gender: 'unisex', rim: 'fullrim', free: [] }, null],
  ['f1791600000003', { shape: 'rectangle', color: 'tortoise', gender: 'womens', rim: 'semirimless', free: ['half-rim'] }, { eye: 53, bridge: 17, temple: 140 }],
  ['f1791600000002', { shape: 'rectangle', color: 'navy', gender: 'mens', rim: 'fullrim', free: [] }, null],
];
extra.forEach(([base, tags, size], i) => {
  const id = 'f17916' + String(10000000 + i * 1000).padStart(8, '0');
  out['users/kiosk/frames/' + id] = Object.assign({ tags, createdAt: { __ts: 0 } }, size ? { size } : {}, made[base].light);
  out['users/kiosk/framesFull/' + id] = made[base].full;
});
// one entry whose try-on asset is missing (as if the heavy doc failed to save)
out['users/kiosk/frames/f1791699999999'] = Object.assign({ tags: { shape: 'round', color: 'black', gender: 'unisex', rim: 'fullrim', free: [] }, createdAt: { __ts: 0 } }, made['f1'].light);
fs.writeFileSync(S + '/frames/seed-ux.json', JSON.stringify(out));
console.log('frames', Object.keys(out).filter(k => k.includes('/frames/')).length, 'bytes', JSON.stringify(out).length);
