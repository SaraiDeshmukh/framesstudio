// Turning an extraction result (frame-extract.js) into the stored try-on
// asset: the cropped cut-out, its two lens centres and the fitting metadata.
// No DOM, so the same code runs in the shop's browser (Add frames) and in
// Node (scripts/build-demo.mjs, tests).
//
// The asset manifest saved next to each cut-out (asset.json):
//   { v: 1, imgW, imgH,           size of the cut-out the points refer to
//     p1, p2,                     lens centres (left, right) in its pixels
//     fit,                        fitting metadata from the extraction, or null
//     side: { imgW, imgH, hinge, tip } | null }   temple photo, if any

export var MANIFEST_VERSION = 1;

// Bounding box of the visible pixels of an RGBA image, with a margin.
export function alphaBoxRGBA(data, w, h, threshold) {
  threshold = threshold == null ? 8 : threshold;
  var x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > threshold) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { x: 0, y: 0, w: w, h: h };
  var pad = Math.max(6, Math.round((x1 - x0) * 0.03));
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function cropRGBA(img, box) {
  var out = new Uint8ClampedArray(box.w * box.h * 4);
  for (var y = 0; y < box.h; y++) {
    var src = ((box.y + y) * img.width + box.x) * 4;
    out.set(img.data.subarray(src, src + box.w * 4), y * box.w * 4);
  }
  return { data: out, width: box.w, height: box.h };
}

// Fitting metadata in the saved image's pixels (cropped by x0, y0 and scaled
// by sx, sy). `level` is '3d' or '2d' (the extraction's suggestion unless the
// shop chose otherwise); `lensPts` overrides the lens centres if staff moved them.
export function buildFit(r, level, x0, y0, sx, sy, lensPts) {
  if (!r || !r.ok) return null;
  x0 = x0 || 0; y0 = y0 || 0; sx = sx || 1; sy = sy || 1;
  function mp(p) { return { x: Math.round((p.x - x0) * sx * 10) / 10, y: Math.round((p.y - y0) * sy * 10) / 10 }; }
  function mb(b) { return { minX: Math.round((b.minX - x0) * sx), minY: Math.round((b.minY - y0) * sy), maxX: Math.round((b.maxX - x0) * sx), maxY: Math.round((b.maxY - y0) * sy) }; }
  var lm = r.landmarks, m = r.measurements, L = lensPts ? lensPts[0] : lm.lensL, R = lensPts ? lensPts[1] : lm.lensR;
  if (L.x > R.x) { var t = L; L = R; R = t; }
  return {
    v: 1, source: 'auto', unmixed: true,
    rimType: r.rimType, translucent: r.translucent, level: level || r.representation.level, quality: Math.round(r.quality * 100) / 100,
    lenses: r.lenses.map(function (ln) { return { side: ln.side, poly: ln.poly.map(mp), centre: mp(ln.centre) }; }),
    landmarks: { lensL: mp(L), lensR: mp(R), bridge: mp(lm.bridge), bridgeTop: mp(lm.bridgeTop), hingeL: mp(lm.hingeL), hingeR: mp(lm.hingeR), angle: Math.round(lm.angle * 1e4) / 1e4 },
    measurements: {
      frameWidthPx: Math.round(m.frameWidthPx * sx), frameHeightPx: Math.round(m.frameHeightPx * sy),
      lensWidthPx: Math.round(m.lensWidthPx * sx), lensHeightPx: Math.round(m.lensHeightPx * sy),
      bridgePx: Math.round(m.bridgePx * sx), lensDistPx: Math.round(m.lensDistPx * sx), aspect: Math.round(m.aspect * 100) / 100
    },
    warnings: r.warnings.map(function (wn) { return wn.code; }),
    repaired: r.repaired.map(mb)
  };
}

export function scalePt(p, x0, y0, sx, sy) {
  return { x: Math.round((p.x - x0) * sx * 10) / 10, y: Math.round((p.y - y0) * sy * 10) / 10 };
}

export function makeManifest(o) {
  return {
    v: MANIFEST_VERSION, imgW: o.imgW, imgH: o.imgH,
    p1: o.p1, p2: o.p2, fit: o.fit || null, side: o.side || null
  };
}

// Is this a manifest the try-on can use?
export function manifestOk(m) {
  return !!(m && m.v === MANIFEST_VERSION && m.imgW > 0 && m.imgH > 0 && m.p1 && m.p2
    && isFinite(m.p1.x) && isFinite(m.p1.y) && isFinite(m.p2.x) && isFinite(m.p2.y));
}
