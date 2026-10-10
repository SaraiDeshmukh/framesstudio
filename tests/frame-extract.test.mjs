// Run with:  node --test tests/*.test.mjs
// The fixtures are ordinary phone photos of three real frames from the shop
// (reduced to 900 px): a translucent grey-green full-rim acetate on a table,
// a navy metal full-rim on a display stand, and a brown semi-rimless on a stand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPNG } from './png.mjs';
import { extractFrame, rasterPolygon, convexHull, components } from '../frame-extract.js';

const fixture = name => readPNG(new URL('./fixtures/' + name, import.meta.url));
const near = (p, q, tol) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;

function alphaAt(r, x, y) { return r.cutout.data[(Math.round(y) * r.width + Math.round(x)) * 4 + 3]; }
function insideLens(r, side, x, y) {
  const lens = r.lenses[side === 'left' ? 0 : 1];
  return rasterPolygon(lens.poly, r.width, r.height)[Math.round(y) * r.width + Math.round(x)] === 1;
}
// fraction of opaque-ish pixels inside a box of the cut-out
function coverage(r, x0, y0, x1, y1, min = 60) {
  let n = 0, on = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { n++; if (alphaAt(r, x, y) > min) on++; }
  return on / n;
}

// ---- reference photos (ground truth measured by hand on the photos, 900 px scale) ----

test('translucent grey-green full-rim on a table: frame, openings, translucency', () => {
  const r = extractFrame(fixture('translucent-fullrim.png'));
  assert.ok(r.ok, r.reason);
  assert.equal(r.rimType, 'full');
  assert.equal(r.translucent, true, 'translucent acetate stays see-through');
  assert.equal(r.representation.level, '3d');
  assert.ok(near(r.landmarks.lensL, { x: 271, y: 349 }, 8), 'left lens centre ' + JSON.stringify(r.landmarks.lensL));
  assert.ok(near(r.landmarks.lensR, { x: 674, y: 338 }, 8), 'right lens centre ' + JSON.stringify(r.landmarks.lensR));
  // lens openings are clear, including where the temples and table edge show through them
  assert.ok(coverage(r, 200, 300, 330, 420, 20) < 0.01, 'left lens interior is transparent');
  assert.ok(coverage(r, 640, 250, 760, 300, 20) < 0.02, 'temple seen through the right lens removed');
  // the rim itself is kept, with its colour (not a black silhouette) and partly see-through
  const rim = { x: 310, y: 469 };
  assert.ok(alphaAt(r, rim.x, rim.y) > 120, 'bottom rim kept');
  const col = [];
  for (let y = 205; y <= 240; y++) { const a = alphaAt(r, 225, y); if (a > 0) col.push(a); }
  col.sort((p, q) => p - q);
  const med = col[col.length >> 1];
  assert.ok(col.length >= 8 && med > 60 && med < 220, 'top rim is translucent (median alpha ' + med + ')');
  // nothing kept far below the frame (table, shadows)
  assert.ok(coverage(r, 100, 495, 850, 505, 60) < 0.02, 'no shadow band under the frame');
  // the shadow on the table runs out sideways from where each rim touches it
  assert.ok(coverage(r, 180, 464, 200, 478, 30) < 0.05, 'shadow beside the left rim removed');
  assert.ok(coverage(r, 752, 450, 785, 462, 30) < 0.05, 'shadow beside the right rim removed');
  assert.ok(coverage(r, 260, 462, 300, 470, 30) > 0.6 && coverage(r, 640, 452, 700, 460, 30) > 0.6, 'bottom rims kept');
  assert.ok(r.warnings.some(w => w.code === 'seenThrough'));
});

test('metal full-rim on a display stand: stand removed, bridge rebuilt and flagged', () => {
  const r = extractFrame(fixture('metal-fullrim-stand.png'));
  assert.ok(r.ok, r.reason);
  assert.equal(r.rimType, 'full');
  assert.equal(r.translucent, false);
  assert.ok(near(r.landmarks.lensL, { x: 224, y: 137 }, 8), 'left lens centre ' + JSON.stringify(r.landmarks.lensL));
  assert.ok(near(r.landmarks.lensR, { x: 642, y: 137 }, 8), 'right lens centre ' + JSON.stringify(r.landmarks.lensR));
  // white display discs (behind the lens ends, partly above the frame) are not frame
  assert.ok(coverage(r, 55, 5, 100, 50, 60) < 0.05, 'left disc above the rim removed');
  // printing on the demo lenses is gone
  assert.ok(coverage(r, 100, 155, 170, 185, 40) < 0.01, 'lens printing removed');
  // the acrylic clip below the bridge is gone; the bridge is continuous
  assert.ok(coverage(r, 420, 110, 470, 170, 60) < 0.03, 'clip below the bridge removed');
  for (let x = 410; x <= 480; x += 5) {
    let solid = 0;
    for (let y = 60; y <= 100; y++) if (alphaAt(r, x, y) > 150) solid++;
    assert.ok(solid >= 6, 'bridge present at x=' + x);
  }
  const rep = r.warnings.find(w => w.code === 'bridgeRepaired');
  assert.ok(rep && rep.box, 'rebuilt bridge flagged for review');
  assert.equal(r.representation.level, '3d');
});

test('semi-rimless on a stand: no invented lower rim, lens edges kept faint, clip removed', () => {
  const r = extractFrame(fixture('semirimless-stand.png'));
  assert.ok(r.ok, r.reason);
  assert.equal(r.rimType, 'semi', 'thick top rim, thin lens edge below');
  assert.equal(r.translucent, false);
  assert.ok(near(r.landmarks.lensL, { x: 220, y: 205 }, 8), 'left lens centre ' + JSON.stringify(r.landmarks.lensL));
  assert.ok(near(r.landmarks.lensR, { x: 593, y: 203 }, 8), 'right lens centre ' + JSON.stringify(r.landmarks.lensR));
  // along the bottom of each lens: only a faint edge line, never a solid rim
  for (const [side, x] of [['left', 220], ['right', 593]]) {
    const lens = r.lenses[side === 'left' ? 0 : 1];
    let maxA = 0, sum = 0;
    for (let y = Math.round(lens.box.maxY) - 4; y <= Math.round(lens.box.maxY) + 6; y++) { const a = alphaAt(r, x, y); maxA = Math.max(maxA, a); sum += a; }
    assert.ok(maxA > 20, side + ' lens edge is visible');
    assert.ok(maxA < 200 && sum < 900, side + ' lens edge is faint, not a rim (max ' + maxA + ')');
  }
  // the brown browline is solid and keeps its colour
  const k = (Math.round(108) * r.width + 600) * 4, d = r.cutout.data;
  assert.ok(d[k + 3] > 200 && d[k] > d[k + 2] + 30, 'browline solid and brown');
  // clip below the bridge removed
  assert.ok(coverage(r, 385, 180, 435, 225, 60) < 0.05, 'clip removed');
  assert.ok(r.warnings.some(w => w.code === 'bridgeRepaired'));
});

test('different products give different assets (shape, size, landmarks)', () => {
  const a = extractFrame(fixture('translucent-fullrim.png')), b = extractFrame(fixture('metal-fullrim-stand.png'));
  assert.notEqual(a.measurements.aspect.toFixed(1), b.measurements.aspect.toFixed(1));
  assert.ok(Math.abs(a.measurements.lensHeightPx / a.measurements.lensWidthPx - b.measurements.lensHeightPx / b.measurements.lensWidthPx) > 0.2);
});

// ---- synthetic photos: specific situations ----

function synth({ w = 640, h = 320, rim = 10, lower = true, bg = [200, 198, 192], gradient = 30, tableEdge = null, frameRGB = [40, 40, 45], textInLens = false, touchEdge = false } = {}) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = gradient * (x / w - 0.5) + (tableEdge && y > tableEdge ? 18 : 0);
    const k = (y * w + x) * 4; data[k] = bg[0] + g; data[k + 1] = bg[1] + g; data[k + 2] = bg[2] + g; data[k + 3] = 255;
  }
  const cy = h / 2, lw = 120, lh = 75, gap = 30, cxL = w / 2 - gap - lw, cxR = w / 2 + gap + lw;
  const inRR = (x, y, cx, hw, hh, r) => { const dx = Math.max(Math.abs(x - cx) - (hw - r), 0), dy = Math.max(Math.abs(y - cy) - (hh - r), 0); return dx * dx + dy * dy <= r * r; };
  const paint = (x, y, c) => { const k = (y * w + x) * 4; data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; };
  const ext = touchEdge ? lw + 20 + 60 : lw + 20;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (const cx of [cxL, cxR]) {
      const outer = inRR(x, y, cx, lw, lh, 30), inner = inRR(x, y, cx, lw - rim, lh - rim, 22);
      if (outer && !inner && (lower || y < cy)) paint(x, y, frameRGB);
      if (!lower && outer && !inner && y >= cy && Math.abs(Math.hypot(0, 0)) >= 0) { /* open below */ }
    }
    if (Math.abs(x - w / 2) <= gap + 2 && y > cy - lh + 4 && y < cy - lh + 4 + rim) paint(x, y, frameRGB);
    if ((x < cxL - lw + 2 && x > w / 2 - ext - gap - lw + (touchEdge ? -200 : 0) && x > cxL - lw - 16 || x > cxR + lw - 2 && x < cxR + lw + 16) && y > cy - lh + 6 && y < cy - lh + 28) paint(x, y, frameRGB);
    if (touchEdge && x < 6 && y > cy - lh + 6 && y < cy - lh + 28) paint(x, y, frameRGB);
    if (!lower) for (const cx of [cxL, cxR]) {
      const edge = inRR(x, y, cx, lw - 2, lh - 2, 24) && !inRR(x, y, cx, lw - 4, lh - 4, 22);
      if (edge && y >= cy) { const k = (y * w + x) * 4; data[k] -= 28; data[k + 1] -= 28; data[k + 2] -= 28; }
    }
  }
  if (touchEdge) for (let y = Math.round(cy - lh + 6); y < cy - lh + 28; y++) for (let x = 0; x < cxL - lw; x++) paint(x, y, frameRGB);
  if (textInLens) for (let y = cy + 30; y < cy + 40; y++) for (let x = cxL - 40; x < cxL + 40; x++) if ((x >> 2) % 2) paint(x, y, [30, 30, 30]);
  return { data, width: w, height: h, cxL, cxR, cy, lw, lh, rim };
}

test('synthetic: lighting gradient and a table edge behind the frame are background', () => {
  const s = synth({ gradient: 60, tableEdge: 200 });
  const r = extractFrame(s);
  assert.ok(r.ok);
  assert.equal(r.rimType, 'full');
  assert.ok(near(r.landmarks.lensL, { x: s.cxL, y: s.cy }, 4) && near(r.landmarks.lensR, { x: s.cxR, y: s.cy }, 4));
  assert.ok(coverage(r, 0, 195, 30, 205, 30) === 0 && coverage(r, s.width - 30, 195, s.width - 1, 205, 30) === 0, 'table edge not kept');
  // lens outline matches the drawn inner rim (width within 3 px)
  assert.ok(Math.abs(r.lenses[0].width - 2 * (s.lw - s.rim)) <= 8, 'lens width ' + r.lenses[0].width);
});

test('synthetic: printing inside a lens is removed; the rim stays solid and opaque', () => {
  const s = synth({ textInLens: true });
  const r = extractFrame(s);
  assert.ok(coverage(r, s.cxL - 40, s.cy + 30, s.cxL + 40, s.cy + 40, 20) === 0);
  assert.ok(alphaAt(r, s.cxL, s.cy - s.lh + 4) === 255, 'rim opaque');
  assert.equal(r.translucent, false);
});

test('synthetic: open-bottom lenses with faint edges are semi-rimless', () => {
  const s = synth({ lower: false });
  const r = extractFrame(s);
  assert.ok(r.ok);
  assert.equal(r.rimType, 'semi');
});

test('synthetic: a frame cut off by the photo edge is flagged and kept flat', () => {
  const s = synth({ touchEdge: true });
  const r = extractFrame(s);
  assert.ok(r.warnings.some(w => w.code === 'cropped' && w.severity === 'error'));
  assert.equal(r.representation.level, '2d');
});

test('blank or tiny photos fail with a clear reason', () => {
  const blank = { data: new Uint8ClampedArray(400 * 200 * 4).fill(200), width: 400, height: 200 };
  const r = extractFrame(blank);
  assert.equal(r.ok, false);
  assert.match(r.reason, /No frame found/);
  assert.equal(extractFrame({ data: new Uint8ClampedArray(16), width: 2, height: 2 }).ok, false);
});

test('helpers: polygon raster, hull, components', () => {
  const m = rasterPolygon([{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 6 }, { x: 2, y: 6 }], 10, 10);
  assert.equal(m.reduce((a, b) => a + b, 0), 24);
  const hull = convexHull([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);
  assert.equal(hull.length, 4);
  const c = components(Uint8Array.from([1, 1, 0, 0, 0, 1, 1, 0, 1]), 3, 3);
  assert.equal(c.count, 3);
});
