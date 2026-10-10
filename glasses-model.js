// Frame photo -> 3D model description. No DOM, no network: unit-tested in Node
// (tests/glasses-model.test.mjs). ar-renderer.js turns the result into meshes.
//
// Input is what the catalogue already stores for every frame: a front-view
// cut-out (transparent background) and the two lens centres tapped when it was
// added. From that alone this works out:
//   * the frame's own axis (photos are rarely perfectly level),
//   * where the hinges / end pieces are (that is where the temples start),
//   * which transparent areas are the lens openings (they get a glass surface),
//   * how thick the rim is and what the rim material looks like (a strip of the
//     real rim is unwrapped and used to texture the generated temples),
//   * whether it is a metal or an acetate/plastic frame.
// Optionally a side photo of the temple (analyseSide) replaces the generated
// temple with the real one.
//
// Coordinates: "axis space" is photo pixels rotated so the lens-centre line is
// horizontal, origin at the midpoint between the lens centres, u to the right,
// v down.
//
// Frames prepared with the automatic extraction (frame-extract.js) carry their
// fitting metadata ("fit": lens outlines, rim type, translucency, chosen
// representation). When it is passed in, the lens openings come from it
// instead of being re-detected, and translucent material counts as frame.

import { rasterPolygon } from './frame-extract.js';

var OPAQUE_SOLID = 128;        // alpha at or above this counts as frame material
var OPAQUE_TRANSLUCENT = 45;   // ... for frames whose material is see-through
var CLEAR = 100;        // alpha below this counts as see-through

export var SIZE_LIMITS = { eye: [30, 75], bridge: [10, 30], temple: [100, 170] };

// Returns {eye, bridge, temple} with only the plausible numbers kept, or null.
export function cleanSize(size) {
  if (!size) return null;
  var out = {}, any = false;
  ['eye', 'bridge', 'temple'].forEach(function (k) {
    var v = Number(size[k]);
    var lim = SIZE_LIMITS[k];
    if (isFinite(v) && v >= lim[0] && v <= lim[1]) { out[k] = Math.round(v * 10) / 10; any = true; }
    else out[k] = null;
  });
  return any ? out : null;
}

// "52-18-140" style label for whatever is known.
export function sizeLabel(size) {
  var s = cleanSize(size);
  if (!s) return '';
  if (s.eye && s.bridge) return s.eye + '□' + s.bridge + (s.temple ? ' ' + s.temple : '');
  return [s.eye ? 'eye ' + s.eye : '', s.bridge ? 'bridge ' + s.bridge : '', s.temple ? 'temple ' + s.temple : ''].filter(Boolean).join(' · ');
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  var i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

function median(arr) {
  if (!arr.length) return 0;
  var s = Float64Array.from(arr).sort();
  return s[s.length >> 1];
}

// img: { data: RGBA bytes, width, height }. p1, p2: lens centres.
// opts: { tags, size, fit }.
export function analyseFrame(img, p1, p2, opts) {
  opts = opts || {};
  var fit = opts.fit && opts.fit.v ? opts.fit : null;
  var OPAQUE = fit && fit.translucent ? OPAQUE_TRANSLUCENT : OPAQUE_SOLID;
  var W = img.width, H = img.height, D = img.data;
  if (!p1 || !p2 || !(W > 2) || !(H > 2)) return { ok: false, reason: 'missing image or lens points' };
  var L = p1.x <= p2.x ? p1 : p2, R = p1.x <= p2.x ? p2 : p1;
  var lensDistPx = Math.hypot(R.x - L.x, R.y - L.y);
  if (!(lensDistPx > 4)) return { ok: false, reason: 'lens points are on top of each other' };
  var angle = Math.atan2(R.y - L.y, R.x - L.x);
  var C = { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 };
  var ca = Math.cos(angle), sa = Math.sin(angle);
  function toAxis(x, y) { var dx = x - C.x, dy = y - C.y; return [dx * ca + dy * sa, -dx * sa + dy * ca]; }
  function fromAxis(u, v) { return [C.x + u * ca - v * sa, C.y + u * sa + v * ca]; }
  function alphaAt(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    return D[(y * W + x) * 4 + 3];
  }

  // ---- opaque pixels in axis space ----
  var us = [], vs = [], n = W * H, sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var k = (y * W + x) * 4;
      if (D[k + 3] < OPAQUE) continue;
      var a = toAxis(x, y);
      us.push(a[0]); vs.push(a[1]);
      sumR += D[k]; sumG += D[k + 1]; sumB += D[k + 2]; count++;
    }
  }
  if (count < 50) return { ok: false, reason: 'the cut-out has almost no frame pixels' };
  var su = Float64Array.from(us).sort(), sv = Float64Array.from(vs).sort();
  // robust extremes: ignore the outermost 0.15% (stray specks the cut-out missed)
  var bbox = { minU: percentile(su, 0.0015), maxU: percentile(su, 0.9985), minV: percentile(sv, 0.0015), maxV: percentile(sv, 0.9985) };
  var widthPx = bbox.maxU - bbox.minU;

  // ---- hinges: the outermost band of material on each side ----
  var band = Math.max(3, widthPx * 0.015);
  function hingeFor(side) {
    var edge = side < 0 ? bbox.minU : bbox.maxU, inV = [], rr = 0, gg = 0, bb = 0, c = 0;
    for (var i = 0; i < us.length; i++) {
      var inBand = side < 0 ? (us[i] >= edge && us[i] <= edge + band) : (us[i] <= edge && us[i] >= edge - band);
      if (!inBand) continue;
      inV.push(vs[i]);
      var p = fromAxis(us[i], vs[i]), k = (Math.round(p[1]) * W + Math.round(p[0])) * 4;
      if (k >= 0 && k < D.length) { rr += D[k]; gg += D[k + 1]; bb += D[k + 2]; c++; }
    }
    var sorted = Float64Array.from(inV).sort();
    var top = percentile(sorted, 0.05), bottom = percentile(sorted, 0.95);
    return {
      u: edge - side * band * 0.5,
      v: inV.length ? (top + bottom) / 2 : 0,
      height: Math.max(2, bottom - top),
      colour: c ? [rr / c, gg / c, bb / c] : null
    };
  }
  var hinges = { left: hingeFor(-1), right: hingeFor(1) };

  // ---- lens openings: see-through areas not connected to the image border ----
  // (skipped when the outlines were stored with the frame)
  var label = null, sizes = [];
  if (!fit) {
  var outside = new Uint8Array(n), stack = new Int32Array(n), sp = 0;
  function seed(i) { if (!outside[i] && D[i * 4 + 3] < CLEAR) { outside[i] = 1; stack[sp++] = i; } }
  for (x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (sp) {
    var i0 = stack[--sp], ix = i0 % W, iy = (i0 / W) | 0;
    if (ix > 0) seed(i0 - 1);
    if (ix < W - 1) seed(i0 + 1);
    if (iy > 0) seed(i0 - W);
    if (iy < H - 1) seed(i0 + W);
  }
  label = new Int32Array(n).fill(-1);
  for (var j = 0; j < n; j++) {
    if (label[j] !== -1 || outside[j] || D[j * 4 + 3] >= CLEAR) continue;
    var id = sizes.length, cnt = 0;
    label[j] = id; stack[sp++] = j;
    while (sp) {
      var q = stack[--sp], qx = q % W, qy = (q / W) | 0; cnt++;
      var nb = [qx > 0 ? q - 1 : -1, qx < W - 1 ? q + 1 : -1, qy > 0 ? q - W : -1, qy < H - 1 ? q + W : -1];
      for (var t = 0; t < 4; t++) {
        var m = nb[t];
        if (m < 0 || label[m] !== -1 || outside[m] || D[m * 4 + 3] >= CLEAR) continue;
        label[m] = id; stack[sp++] = m;
      }
    }
    sizes.push(cnt);
  }
  }
  var minHole = lensDistPx * lensDistPx * 0.01;
  function holeNear(pt) {
    var r = lensDistPx * 0.22, best = -1, bestD = Infinity;
    var x0 = Math.max(0, Math.floor(pt.x - r)), x1 = Math.min(W - 1, Math.ceil(pt.x + r));
    var y0 = Math.max(0, Math.floor(pt.y - r)), y1 = Math.min(H - 1, Math.ceil(pt.y + r));
    for (var yy = y0; yy <= y1; yy += 2) {
      for (var xx = x0; xx <= x1; xx += 2) {
        var l = label[yy * W + xx];
        if (l < 0 || sizes[l] < minHole) continue;
        var d = (xx - pt.x) * (xx - pt.x) + (yy - pt.y) * (yy - pt.y);
        if (d < bestD) { bestD = d; best = l; }
      }
    }
    return best;
  }
  var holeL = fit ? -1 : holeNear(L), holeR = fit ? -1 : holeNear(R);
  var lensMask = new Uint8Array(n), lensPixels = 0;
  if (fit && fit.lenses && fit.lenses.length === 2) {
    // the lens outlines found when the frame was prepared (also right for
    // semi-rimless lenses, whose openings are not closed by a rim)
    fit.lenses.forEach(function (ln) {
      var m = rasterPolygon(ln.poly, W, H);
      for (var q = 0; q < n; q++) if (m[q] && D[q * 4 + 3] < 200) { lensMask[q] = 1; lensPixels++; }
    });
    holeL = holeR = 0;
  } else if (holeL >= 0 || holeR >= 0) {
    for (var j2 = 0; j2 < n; j2++) {
      if (label[j2] >= 0 && (label[j2] === holeL || label[j2] === holeR)) { lensMask[j2] = 1; lensPixels++; }
    }
  }

  // ---- rim: walk down from the top of the frame along many columns ----
  var STRIP_W = 256, STRIP_H = 16;
  var strip = new Uint8ClampedArray(STRIP_W * STRIP_H * 4), runs = [];
  var lastRun = null, haveAny = false;
  for (var sx = 0; sx < STRIP_W; sx++) {
    var u = bbox.minU + (sx + 0.5) / STRIP_W * widthPx, run = null, start = null;
    for (var v = bbox.minV - 2; v <= bbox.maxV + 2; v += 0.5) {
      var pp = fromAxis(u, v), on = alphaAt(pp[0], pp[1]) >= OPAQUE;
      if (on && start === null) start = v;
      if (!on && start !== null) { run = [start, v]; break; }
    }
    if (!run && start !== null) run = [start, bbox.maxV];
    if (run) {
      lastRun = run; haveAny = true;
      if (Math.abs(u) > lensDistPx * 0.15 && Math.abs(u) < lensDistPx * 0.85) runs.push(run[1] - run[0]);
    }
    var use = run || lastRun;
    for (var sy = 0; sy < STRIP_H; sy++) {
      var o = (sy * STRIP_W + sx) * 4;
      if (!use) { strip[o + 3] = 0; continue; }
      var vv = use[0] + (sy + 0.5) / STRIP_H * (use[1] - use[0]);
      var pq = fromAxis(u, vv), px = Math.min(W - 1, Math.max(0, Math.round(pq[0]))), py = Math.min(H - 1, Math.max(0, Math.round(pq[1])));
      var kk = (py * W + px) * 4;
      strip[o] = D[kk]; strip[o + 1] = D[kk + 1]; strip[o + 2] = D[kk + 2]; strip[o + 3] = 255;
    }
  }
  // columns before the first rim hit were left empty: copy the first good column
  if (haveAny) {
    var firstGood = -1;
    for (sx = 0; sx < STRIP_W && firstGood < 0; sx++) if (strip[sx * 4 + 3]) firstGood = sx;
    for (sx = 0; sx < firstGood; sx++) for (sy = 0; sy < STRIP_H; sy++) {
      var dst = (sy * STRIP_W + sx) * 4, src = (sy * STRIP_W + firstGood) * 4;
      strip[dst] = strip[src]; strip[dst + 1] = strip[src + 1]; strip[dst + 2] = strip[src + 2]; strip[dst + 3] = 255;
    }
  }
  var rimPx = runs.length ? median(runs) : Math.max(2, (bbox.maxV - bbox.minV) * 0.08);

  var tags = opts.tags || {};
  var metal = tags.color === 'gold' || tags.color === 'silver' ? true
    : (tags.color === 'tortoise' || tags.color === 'clear') ? false
    : rimPx / lensDistPx < 0.035;

  var size = cleanSize(opts.size);
  var lensDistMm = size && size.eye && size.bridge ? size.eye + size.bridge : null;

  return {
    ok: true,
    width: W, height: H,
    lensL: { x: L.x, y: L.y }, lensR: { x: R.x, y: R.y },
    centre: C, angle: angle, lensDistPx: lensDistPx,
    bbox: bbox, widthPx: widthPx,
    hinges: hinges,
    lensMask: lensMask, lensFound: [holeL >= 0, holeR >= 0], lensPixels: lensPixels,
    rim: { thicknessPx: rimPx, strip: { data: strip, width: STRIP_W, height: STRIP_H } },
    colour: [sumR / count, sumG / count, sumB / count],
    metal: metal,
    size: size,
    rimType: fit ? fit.rimType : null,
    translucent: !!(fit && fit.translucent),
    lensDistMm: lensDistMm,
    // real-world millimetres per photo pixel, when the frame's size is known
    mmPerPx: lensDistMm ? lensDistMm / lensDistPx : null
  };
}

// Side photo of a temple. hinge, tip: tapped points (hinge end, far end).
// templeMm: the temple length if known (else the caller's default).
export function analyseSide(img, hinge, tip, templeMm) {
  var W = img.width, H = img.height, D = img.data, OPAQUE = OPAQUE_SOLID;
  if (!hinge || !tip) return { ok: false, reason: 'missing points' };
  var Lpx = Math.hypot(tip.x - hinge.x, tip.y - hinge.y);
  if (!(Lpx > 10)) return { ok: false, reason: 'points too close' };
  var chord = Math.atan2(tip.y - hinge.y, tip.x - hinge.x);
  // keep "down in the photo" as down on the temple even if it was shot tip-left
  var flip = Math.cos(chord) < 0 ? -1 : 1;
  function axisFor(ang) {
    var c = Math.cos(ang), s = Math.sin(ang);
    return {
      to: function (x, y) { var dx = x - hinge.x, dy = y - hinge.y; return [dx * c + dy * s, flip * (-dx * s + dy * c)]; },
      from: function (u, v) { v *= flip; return [hinge.x + u * c - v * s, hinge.y + u * s + v * c]; }
    };
  }
  function opaqueAt(x, y) {
    x = Math.round(x); y = Math.round(y);
    return x >= 0 && y >= 0 && x < W && y < H && D[(y * W + x) * 4 + 3] >= OPAQUE;
  }
  // the straight part of the temple runs from the hinge to the ear bend; fit its
  // centre line over the first half so the bend doesn't tilt the result
  var ax = axisFor(chord), pts = [];
  for (var u = Lpx * 0.06; u <= Lpx * 0.55; u += Math.max(1, Lpx / 120)) {
    var lo = null, hi = null;
    for (var v = -Lpx * 0.15; v <= Lpx * 0.15; v += 0.5) {
      var p = ax.from(u, v);
      if (opaqueAt(p[0], p[1])) { if (lo === null) lo = v; hi = v; }
    }
    if (lo !== null) pts.push([u, (lo + hi) / 2]);
  }
  var tilt = 0;
  if (pts.length >= 5) {
    var mu = 0, mv = 0;
    pts.forEach(function (q) { mu += q[0]; mv += q[1]; });
    mu /= pts.length; mv /= pts.length;
    var num = 0, den = 0;
    pts.forEach(function (q) { num += (q[0] - mu) * (q[1] - mv); den += (q[0] - mu) * (q[0] - mu); });
    tilt = den > 0 ? Math.atan(num / den) : 0;
  }
  var angle = chord + flip * tilt;
  ax = axisFor(angle);
  var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, r = 0, g = 0, b = 0, c = 0;
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var k = (y * W + x) * 4;
      if (D[k + 3] < OPAQUE) continue;
      var a = ax.to(x, y);
      if (a[0] < -Lpx * 0.06) continue;                 // ignore the frame front ahead of the hinge
      if (a[0] < minU) minU = a[0]; if (a[0] > maxU) maxU = a[0];
      if (a[1] < minV) minV = a[1]; if (a[1] > maxV) maxV = a[1];
      r += D[k]; g += D[k + 1]; b += D[k + 2]; c++;
    }
  }
  if (c < 30) return { ok: false, reason: 'no temple found between the two points' };
  // height of the temple right behind the hinge (for the edge-on view)
  var hs = [];
  for (u = Lpx * 0.04; u <= Lpx * 0.2; u += Math.max(1, Lpx / 200)) {
    var lo2 = null, hi2 = null;
    for (v = minV; v <= maxV; v += 0.5) { var q = ax.from(u, v); if (opaqueAt(q[0], q[1])) { if (lo2 === null) lo2 = v; hi2 = v; } }
    if (lo2 !== null) hs.push(hi2 - lo2);
  }
  var mm = templeMm || 140;
  return {
    ok: true, hinge: { x: hinge.x, y: hinge.y }, angle: angle, flip: flip,
    lengthPx: Lpx, mmPerPx: mm / Lpx,
    crop: { minU: Math.max(minU, -Lpx * 0.06), maxU: maxU, minV: minV, maxV: maxV },
    heightNearHingePx: hs.length ? median(hs) : (maxV - minV) * 0.3,
    colour: [r / c, g / c, b / c]
  };
}
