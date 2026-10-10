// Run with:  node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseFrame, analyseSide, cleanSize, sizeLabel } from '../glasses-model.js';

// ---- tiny rasteriser for synthetic frame cut-outs (transparent background) ----
function blank(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
function paint(img, inside, rgb) {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!inside(x + 0.5, y + 0.5)) continue;
    const k = (y * img.width + x) * 4;
    img.data[k] = rgb[0]; img.data[k + 1] = rgb[1]; img.data[k + 2] = rgb[2]; img.data[k + 3] = 255;
  }
}
function roundRect(cx, cy, hw, hh, r) {
  return (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - (hw - r), 0), dy = Math.max(Math.abs(y - cy) - (hh - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
}
// A front-view frame: two rims (rim = thickness), bridge, end pieces. Optional tilt
// (radians, about the image centre) and open bottoms (semi-rimless).
function makeFrame({ w = 700, h = 320, rim = 14, tilt = 0, colour = [30, 30, 32], semiRimless = false, specks = false } = {}) {
  const img = blank(w, h), c = Math.cos(tilt), s = Math.sin(tilt), mx = w / 2, my = h / 2;
  const rot = f => (x, y) => { const dx = x - mx, dy = y - my; return f(mx + dx * c + dy * s, my - dx * s + dy * c); };
  const lensHW = 125, lensHH = 85, gap = 28, cxL = mx - gap - lensHW, cxR = mx + gap + lensHW, cy = my;
  const ring = cx => (x, y) => {
    const outer = roundRect(cx, cy, lensHW, lensHH, 40)(x, y), inner = roundRect(cx, cy, lensHW - rim, lensHH - rim, 30)(x, y);
    if (semiRimless && y > cy + 10) return outer && !inner && y < cy + 10 + rim;   // top half only
    return outer && !inner;
  };
  paint(img, rot(ring(cxL)), colour);
  paint(img, rot(ring(cxR)), colour);
  paint(img, rot((x, y) => Math.abs(x - mx) <= gap + 2 && y > cy - lensHH + 6 && y < cy - lensHH + 6 + rim), colour); // bridge
  paint(img, rot((x, y) => (x < cxL - lensHW + 4 && x > cxL - lensHW - 18 || x > cxR + lensHW - 4 && x < cxR + lensHW + 18) && y > cy - lensHH + 10 && y < cy - lensHH + 34), colour); // end pieces
  if (specks) { paint(img, (x, y) => x < 3 && y < 3, [255, 0, 0]); paint(img, (x, y) => x > w - 3 && y > h - 3, [255, 0, 0]); }
  const toImg = (x, y) => { const dx = x - mx, dy = y - my; return { x: mx + dx * c - dy * s, y: my + dx * s + dy * c }; };
  return { img, p1: toImg(cxL, cy), p2: toImg(cxR, cy), lensHW, lensHH, cxL, cxR, cy, mx, my, gap };
}

test('size helpers keep only plausible numbers and format them', () => {
  assert.deepEqual(cleanSize({ eye: '52', bridge: 18, temple: 140 }), { eye: 52, bridge: 18, temple: 140 });
  assert.deepEqual(cleanSize({ eye: 5, bridge: 18 }), { eye: null, bridge: 18, temple: null });
  assert.equal(cleanSize({}), null);
  assert.equal(cleanSize(null), null);
  assert.equal(sizeLabel({ eye: 52, bridge: 18, temple: 140 }), '52□18 140');
  assert.equal(sizeLabel({ temple: 145 }), 'temple 145');
});

test('analyseFrame: axis, hinges, lens openings and rim of a level frame', () => {
  const f = makeFrame();
  const m = analyseFrame(f.img, f.p2, f.p1, {});          // reversed tap order must not matter
  assert.ok(m.ok);
  assert.ok(Math.abs(m.angle) < 1e-9);
  assert.ok(Math.abs(m.lensDistPx - (f.cxR - f.cxL)) < 1e-6);
  // hinges sit on the outer end pieces, at their height
  const outer = f.lensHW * 2 + f.gap + 18;
  assert.ok(Math.abs(m.hinges.right.u - outer) < 8 && Math.abs(m.hinges.left.u + outer) < 8, JSON.stringify(m.hinges));
  assert.ok(m.hinges.left.v < -40, 'end pieces are at the top corners');
  // both lens openings are found; outside stays outside
  assert.deepEqual(m.lensFound, [true, true]);
  const inner = (2 * (f.lensHW - 14)) * (2 * (f.lensHH - 14));
  assert.ok(m.lensPixels > 1.6 * inner && m.lensPixels < 2.05 * inner, 'lens area ' + m.lensPixels);
  assert.equal(m.lensMask[5 * f.img.width + 5], 0);
  assert.equal(m.lensMask[Math.round(f.cy) * f.img.width + Math.round(f.cxL)], 1);
  // rim thickness ~ 14 px, strip carries the rim colour
  assert.ok(Math.abs(m.rim.thicknessPx - 14) < 2.5, 'rim ' + m.rim.thicknessPx);
  const s = m.rim.strip;
  for (let i = 0; i < s.width * s.height; i += 37) assert.deepEqual([s.data[i * 4], s.data[i * 4 + 1], s.data[i * 4 + 2], s.data[i * 4 + 3]], [30, 30, 32, 255]);
  assert.equal(m.metal, false);
  assert.equal(m.mmPerPx, null, 'no size known -> no real-world scale invented');
});

test('analyseFrame: a tilted photo gives the same frame in axis space', () => {
  const a = analyseFrame(makeFrame().img, makeFrame().p1, makeFrame().p2, {});
  const t = makeFrame({ tilt: 0.12 });
  const b = analyseFrame(t.img, t.p1, t.p2, {});
  assert.ok(Math.abs(b.angle - 0.12) < 1e-6);
  assert.ok(Math.abs(b.widthPx - a.widthPx) < 4);
  assert.ok(Math.abs(b.hinges.right.u - a.hinges.right.u) < 5 && Math.abs(b.hinges.right.v - a.hinges.right.v) < 5);
  assert.deepEqual(b.lensFound, [true, true]);
});

test('analyseFrame: stray specks do not move the hinges', () => {
  const clean = makeFrame(), dirty = makeFrame({ specks: true });
  const a = analyseFrame(clean.img, clean.p1, clean.p2, {}), b = analyseFrame(dirty.img, dirty.p1, dirty.p2, {});
  assert.ok(Math.abs(a.hinges.left.u - b.hinges.left.u) < 2 && Math.abs(a.hinges.right.u - b.hinges.right.u) < 2);
});

test('analyseFrame: semi-rimless has no closed lens opening (no glass invented)', () => {
  const f = makeFrame({ semiRimless: true });
  const m = analyseFrame(f.img, f.p1, f.p2, {});
  assert.deepEqual(m.lensFound, [false, false]);
  assert.equal(m.lensPixels, 0);
});

test('analyseFrame: metal vs acetate from tags first, rim thickness otherwise; size gives real scale', () => {
  const thin = makeFrame({ rim: 5 }), thick = makeFrame({ rim: 18 });
  assert.equal(analyseFrame(thin.img, thin.p1, thin.p2, {}).metal, true);
  assert.equal(analyseFrame(thick.img, thick.p1, thick.p2, {}).metal, false);
  assert.equal(analyseFrame(thick.img, thick.p1, thick.p2, { tags: { color: 'gold' } }).metal, true);
  assert.equal(analyseFrame(thin.img, thin.p1, thin.p2, { tags: { color: 'tortoise' } }).metal, false);
  const m = analyseFrame(thick.img, thick.p1, thick.p2, { size: { eye: 52, bridge: 18 } });
  assert.equal(m.lensDistMm, 70);
  assert.ok(Math.abs(m.mmPerPx * m.lensDistPx - 70) < 1e-9);
});

test('analyseFrame: refuses unusable input', () => {
  const f = makeFrame();
  assert.equal(analyseFrame(f.img, null, f.p2).ok, false);
  assert.equal(analyseFrame(f.img, f.p1, f.p1).ok, false);
  assert.equal(analyseFrame(blank(50, 50), { x: 10, y: 25 }, { x: 40, y: 25 }).ok, false);
});

test('analyseSide: finds the straight part of the temple despite the ear bend', () => {
  const img = blank(600, 300);
  // straight part from (60,100) to (430,118) (~2.8 deg down), then bends down to (520,200)
  const seg = (ax, ay, bx, by, r) => (x, y) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) <= r;
  };
  paint(img, seg(60, 100, 430, 118, 6), [120, 70, 30]);
  paint(img, seg(430, 118, 520, 200, 5), [120, 70, 30]);
  paint(img, (x, y) => x > 40 && x < 64 && y > 88 && y < 112, [120, 70, 30]);   // hinge block
  const s = analyseSide(img, { x: 60, y: 100 }, { x: 520, y: 200 }, 145);
  assert.ok(s.ok);
  const straight = Math.atan2(18, 370);
  assert.ok(Math.abs(s.angle - straight) < 0.03, 'angle ' + s.angle + ' vs ' + straight);
  assert.ok(Math.abs(s.mmPerPx * s.lengthPx - 145) < 1e-9);
  assert.ok(s.heightNearHingePx > 8 && s.heightNearHingePx < 16, 'temple height ' + s.heightNearHingePx);
  // photographed the other way round (tip on the left): still straight-on, bend still down
  const flipped = blank(600, 300);
  for (let y = 0; y < 300; y++) for (let x = 0; x < 600; x++) {
    const a = (y * 600 + x) * 4, b = (y * 600 + (599 - x)) * 4;
    for (let k = 0; k < 4; k++) flipped.data[b + k] = img.data[a + k];
  }
  const f = analyseSide(flipped, { x: 539, y: 100 }, { x: 79, y: 200 }, 145);
  assert.ok(f.ok && f.flip === -1);
  assert.ok(f.crop.maxV > 60, 'the ear bend still points down (+v)');
});

test('analyseFrame uses stored fitting metadata (semi-rimless lens outlines, translucency)', async () => {
  const { readPNG } = await import('./png.mjs');
  const { extractFrame } = await import('../frame-extract.js');
  const r = extractFrame(readPNG(new URL('./fixtures/semirimless-stand.png', import.meta.url)));
  const fit = { v: 1, lenses: r.lenses, rimType: r.rimType, translucent: r.translucent };
  const m = analyseFrame(r.cutout, r.landmarks.lensL, r.landmarks.lensR, { fit });
  assert.ok(m.ok);
  assert.deepEqual(m.lensFound, [true, true], 'open-bottom lenses still get glass from the stored outlines');
  assert.ok(m.lensPixels > 0.8 * (r.lenses[0].width * r.lenses[0].height * 2) * 0.8, 'lens area covers the outlines');
  assert.equal(m.rimType, 'semi');
  const noFit = analyseFrame(r.cutout, r.landmarks.lensL, r.landmarks.lensR, {});
  assert.ok(noFit.lensPixels < m.lensPixels * 0.5, 'without metadata the open lenses are not detected');

  const g = extractFrame(readPNG(new URL('./fixtures/translucent-fullrim.png', import.meta.url)));
  const solidView = analyseFrame(g.cutout, g.landmarks.lensL, g.landmarks.lensR, { fit: { v: 1, lenses: g.lenses, translucent: false } });
  const transView = analyseFrame(g.cutout, g.landmarks.lensL, g.landmarks.lensR, { fit: { v: 1, lenses: g.lenses, translucent: true } });
  assert.ok(transView.rim.thicknessPx > solidView.rim.thicknessPx, 'translucent material counts as frame');
});
