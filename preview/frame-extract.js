// Automatic eyewear extraction from ordinary phone photos. No DOM, no network:
// runs in the browser (Add Frames) and in Node (tests/frame-extract.test.mjs).
//
// Input: an RGB(A) photo of a pair of glasses, front view, on a plain-ish
// background (wall, table, display stand). Output: a cut-out with transparent
// background and lens openings, the frame's fitting landmarks (lens centres,
// bridge, hinges), the rim type, translucency, quality warnings and which
// try-on representation the photo supports.
//
// Pipeline (all classical image processing, no AI model to download):
//   1. Background model: per-row + per-column robust profiles plus a coarse
//      residual grid, fitted only to pixels that look like background, refined
//      over a few rounds. Rows capture a table edge behind the glasses exactly;
//      columns and the grid capture lighting gradients and vignetting.
//   2. Frame evidence per pixel: how much darker, or how differently coloured,
//      it is than the background there. Pixels brighter than the background and
//      neutral in colour (white display discs, glare, reflections) are never
//      frame.
//   3. Hysteresis: confident pixels grow into weaker neighbours only for a few
//      pixels, so soft edges are kept but faint shadows and lines are not.
//   4. Structure: the frame's axis, the two lens openings (closed for full-rim,
//      open at the bottom for semi-rimless), everything seen through a lens
//      (temples, stands, printing on demo lenses, reflections) is removed.
//   5. Matting: alpha from the measured difference to the background, with the
//      background colour un-mixed from edges and translucent material, so
//      translucent frames stay translucent and keep their colour.

var LUMA = [0.2126, 0.7152, 0.0722];

// ---------- small helpers ----------

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function medianOf(arr, n) {
  if (!n) return 0;
  var s = Float32Array.from(arr.subarray ? arr.subarray(0, n) : arr.slice(0, n)).sort();
  return s[n >> 1];
}

// Resizes RGBA data (box filter when shrinking, bilinear when growing).
export function resizeRGBA(src, w, h, W, H) {
  var out = new Uint8ClampedArray(W * H * 4);
  var sx = w / W, sy = h / H;
  if (sx >= 1 && sy >= 1) {
    for (var y = 0; y < H; y++) {
      var y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (var x = 0; x < W; x++) {
        var x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        var r = 0, g = 0, b = 0, a = 0, n = 0;
        for (var yy = y0; yy < y1 && yy < h; yy++) for (var xx = x0; xx < x1 && xx < w; xx++) {
          var k = (yy * w + xx) * 4; r += src[k]; g += src[k + 1]; b += src[k + 2]; a += src[k + 3]; n++;
        }
        var o = (y * W + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
      }
    }
    return out;
  }
  for (var y2 = 0; y2 < H; y2++) {
    var fy = clamp((y2 + 0.5) * sy - 0.5, 0, h - 1), ya = Math.floor(fy), yb = Math.min(h - 1, ya + 1), ty = fy - ya;
    for (var x2 = 0; x2 < W; x2++) {
      var fx = clamp((x2 + 0.5) * sx - 0.5, 0, w - 1), xa = Math.floor(fx), xb = Math.min(w - 1, xa + 1), tx = fx - xa;
      for (var c = 0; c < 4; c++) {
        var v = (src[(ya * w + xa) * 4 + c] * (1 - tx) + src[(ya * w + xb) * 4 + c] * tx) * (1 - ty) +
                (src[(yb * w + xa) * 4 + c] * (1 - tx) + src[(yb * w + xb) * 4 + c] * tx) * ty;
        out[(y2 * W + x2) * 4 + c] = v;
      }
    }
  }
  return out;
}

// Separable box blur of a float map (radius r), in place-safe (returns new array).
function boxBlur(src, w, h, r) {
  if (r < 1) return Float32Array.from(src);
  var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, acc, n;
  for (y = 0; y < h; y++) {
    acc = 0; n = 0;
    for (x = -r; x < w; x++) {
      if (x + r < w) { acc += src[y * w + x + r]; n++; }
      if (x - r - 1 >= 0) { acc -= src[y * w + x - r - 1]; n--; }
      if (x >= 0) tmp[y * w + x] = acc / n;
    }
  }
  for (x = 0; x < w; x++) {
    acc = 0; n = 0;
    for (y = -r; y < h; y++) {
      if (y + r < h) { acc += tmp[(y + r) * w + x]; n++; }
      if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * w + x]; n--; }
      if (y >= 0) out[y * w + x] = acc / n;
    }
  }
  return out;
}

// Binary dilation / erosion with a square of radius r (separable).
export function dilate(mask, w, h, r) {
  if (r < 1) return Uint8Array.from(mask);
  var tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), x, y, last;
  for (y = 0; y < h; y++) {
    last = -1e9;
    for (x = 0; x < w; x++) { if (mask[y * w + x]) last = x; if (x - last <= r) tmp[y * w + x] = 1; }
    last = 1e9;
    for (x = w - 1; x >= 0; x--) { if (mask[y * w + x]) last = x; if (last - x <= r) tmp[y * w + x] = 1; }
  }
  for (x = 0; x < w; x++) {
    last = -1e9;
    for (y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
    last = 1e9;
    for (y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
  }
  return out;
}
export function erode(mask, w, h, r) {
  var inv = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) inv[i] = mask[i] ? 0 : 1;
  var d = dilate(inv, w, h, r);
  for (i = 0; i < w * h; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

// 4-connected components of mask (non-zero). Returns { labels, count, sizes, boxes }.
export function components(mask, w, h) {
  var labels = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h), sizes = [], boxes = [];
  for (var i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i] !== -1) continue;
    var id = sizes.length, sp = 0, n = 0, minX = w, minY = h, maxX = -1, maxY = -1, sx = 0, sy = 0;
    labels[i] = id; stack[sp++] = i;
    while (sp) {
      var p = stack[--sp], px = p % w, py = (p / w) | 0;
      n++; sx += px; sy += py;
      if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (px > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; stack[sp++] = p - 1; }
      if (px < w - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; stack[sp++] = p + 1; }
      if (py > 0 && mask[p - w] && labels[p - w] === -1) { labels[p - w] = id; stack[sp++] = p - w; }
      if (py < h - 1 && mask[p + w] && labels[p + w] === -1) { labels[p + w] = id; stack[sp++] = p + w; }
    }
    sizes.push(n);
    boxes.push({ minX: minX, minY: minY, maxX: maxX, maxY: maxY, cx: sx / n, cy: sy / n });
  }
  return { labels: labels, count: sizes.length, sizes: sizes, boxes: boxes };
}

// ---------- 1. background model ----------

// Fits B(x, y) = R(y) + C(x) + G(x, y) per channel to the pixels where
// bgMask is set. R and C are robust (median) profiles, G a coarse grid.
// First pass (seed): rows are profiled from the left/right margins only and
// columns from the top/bottom margins only, because a flat rim can fill most
// of a row; the glasses rarely reach the photo's sides.
function fitBackground(rgb, w, h, bgMask, seed) {
  var mx = Math.max(4, Math.round(w * 0.08)), my = Math.max(4, Math.round(h * 0.1));
  var B = new Float32Array(w * h * 3);
  var buf = new Float32Array(Math.max(w, h)), col, i, x, y, c, n;
  var GX = 10, GY = Math.max(4, Math.round(10 * h / w));
  var tileBuf = new Float32Array(Math.ceil(w / GX + 1) * Math.ceil(h / GY + 1) + 16);
  for (c = 0; c < 3; c++) {
    // global level, then rows, then columns, then residual grid
    var all = [];
    for (i = 0; i < w * h; i += 7) if (bgMask[i]) all.push(rgb[i * 3 + c]);
    var g0 = all.length ? medianOf(Float32Array.from(all), all.length) : 128;
    var R = new Float32Array(h), C = new Float32Array(w);
    for (y = 0; y < h; y++) {
      n = 0;
      for (x = 0; x < w; x++) {
        if (seed && x >= mx && x < w - mx) continue;
        i = y * w + x; if (bgMask[i]) buf[n++] = rgb[i * 3 + c] - g0;
      }
      R[y] = n > (seed ? mx * 0.5 : w * 0.04) ? medianOf(buf, n) : NaN;
    }
    fillGaps(R);
    R = smooth1d(R, 1);
    for (x = 0; x < w; x++) {
      n = 0;
      for (y = 0; y < h; y++) {
        if (seed && y >= my && y < h - my) continue;
        i = y * w + x; if (bgMask[i]) buf[n++] = rgb[i * 3 + c] - g0 - R[y];
      }
      C[x] = n > (seed ? my * 0.5 : h * 0.04) ? medianOf(buf, n) : NaN;
    }
    fillGaps(C);
    C = smooth1d(C, Math.max(2, Math.round(w / 200)));
    // residual grid
    var tw = w / GX, th = h / GY, grid = new Float32Array(GX * GY), have = new Uint8Array(GX * GY);
    for (var gy = 0; gy < GY; gy++) for (var gx = 0; gx < GX; gx++) {
      n = 0;
      var x0 = Math.floor(gx * tw), x1 = Math.floor((gx + 1) * tw), y0 = Math.floor(gy * th), y1 = Math.floor((gy + 1) * th);
      for (y = y0; y < y1; y += 2) for (x = x0; x < x1; x += 2) {
        i = y * w + x;
        if (bgMask[i]) tileBuf[n++] = rgb[i * 3 + c] - g0 - R[y] - C[x];
      }
      if (n > (x1 - x0) * (y1 - y0) / 4 * 0.08) { grid[gy * GX + gx] = medianOf(tileBuf, n); have[gy * GX + gx] = 1; }
    }
    fillGrid(grid, have, GX, GY);
    for (y = 0; y < h; y++) {
      var fy = clamp(y / th - 0.5, 0, GY - 1), ya = Math.floor(fy), yb = Math.min(GY - 1, ya + 1), ty = fy - ya;
      for (x = 0; x < w; x++) {
        var fx = clamp(x / tw - 0.5, 0, GX - 1), xa = Math.floor(fx), xb = Math.min(GX - 1, xa + 1), tx = fx - xa;
        var gv = (grid[ya * GX + xa] * (1 - tx) + grid[ya * GX + xb] * tx) * (1 - ty) + (grid[yb * GX + xa] * (1 - tx) + grid[yb * GX + xb] * tx) * ty;
        B[(y * w + x) * 3 + c] = g0 + R[y] + C[x] + gv;
      }
    }
  }
  return B;
}

function fillGaps(a) {
  var n = a.length, last = -1, i;
  for (i = 0; i < n; i++) {
    if (isNaN(a[i])) continue;
    if (last < 0) { for (var k = 0; k < i; k++) a[k] = a[i]; }
    else if (i - last > 1) { for (var j = last + 1; j < i; j++) a[j] = a[last] + (a[i] - a[last]) * (j - last) / (i - last); }
    last = i;
  }
  if (last < 0) { for (i = 0; i < n; i++) a[i] = 0; return; }
  for (i = last + 1; i < n; i++) a[i] = a[last];
}

function smooth1d(a, r) {
  var n = a.length, out = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var s = 0, c = 0;
    for (var k = -r; k <= r; k++) { var j = i + k; if (j >= 0 && j < n) { s += a[j]; c++; } }
    out[i] = s / c;
  }
  return out;
}

function fillGrid(grid, have, GX, GY) {
  for (var pass = 0; pass < GX + GY; pass++) {
    var changed = false;
    for (var y = 0; y < GY; y++) for (var x = 0; x < GX; x++) {
      var i = y * GX + x;
      if (have[i]) continue;
      var s = 0, c = 0;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var xx = x + d[0], yy = y + d[1];
        if (xx >= 0 && yy >= 0 && xx < GX && yy < GY && have[yy * GX + xx] === 1) { s += grid[yy * GX + xx]; c++; }
      });
      if (c) { grid[i] = s / c; have[i] = 2; changed = true; }
    }
    for (var j = 0; j < GX * GY; j++) if (have[j] === 2) have[j] = 1;
    if (!changed) break;
  }
  for (var k = 0; k < GX * GY; k++) if (!have[k]) grid[k] = 0;
}

// ---------- 2. per-pixel frame evidence ----------

// Returns { score, dark, chroma, bright } as Float32Arrays (in 0..255 units).
function evidence(rgb, B, w, h) {
  var n = w * h, score = new Float32Array(n), dark = new Float32Array(n), chroma = new Float32Array(n), bright = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var dr = rgb[i * 3] - B[i * 3], dg = rgb[i * 3 + 1] - B[i * 3 + 1], db = rgb[i * 3 + 2] - B[i * 3 + 2];
    var dl = dr * LUMA[0] + dg * LUMA[1] + db * LUMA[2];
    var cr = dr - dl, cg = dg - dl, cb = db - dl;
    var ch = Math.sqrt((cr * cr + cg * cg + cb * cb) / 2);
    dark[i] = -dl; chroma[i] = ch; bright[i] = dl;
    // brighter than the background and neutral = glare, white supports: not frame
    score[i] = dl > 0 ? Math.max(0, 1.6 * ch - 0.5 * dl) : Math.max(-dl, 1.6 * ch);
  }
  return { score: score, dark: dark, chroma: chroma, bright: bright };
}

export function backgroundModel(rgb, w, h, opts) {
  opts = opts || {};
  var n = w * h, bgMask = new Uint8Array(n).fill(1), B = null, ev = null, sigma = 4;
  for (var round = 0; round < 4; round++) {
    B = fitBackground(rgb, w, h, bgMask, round === 0);
    ev = evidence(rgb, B, w, h);
    // noise level from pixels currently believed to be background
    var samp = [];
    for (var i = 0; i < n; i += 5) if (bgMask[i]) samp.push(Math.abs(ev.dark[i]));
    sigma = Math.max(1.5, samp.length ? medianOf(Float32Array.from(samp), samp.length) * 1.4826 : 4);
    var t = Math.max(10, 3.5 * sigma), fg = new Uint8Array(n);
    for (i = 0; i < n; i++) fg[i] = (ev.score[i] > t || ev.bright[i] > t * 1.5) ? 1 : 0;
    var grow = dilate(fg, w, h, Math.max(2, Math.round(w / 250)));
    for (i = 0; i < n; i++) bgMask[i] = grow[i] ? 0 : 1;
  }
  return { B: B, ev: ev, sigma: sigma, bgMask: bgMask };
}

// ---------- 3. hysteresis ----------

var NB8X = [-1, 0, 1, -1, 1, -1, 0, 1], NB8Y = [-1, -1, -1, 0, 0, 1, 1, 1];

// Grows `strong` pixels into `weak` ones, at most `maxDist` steps away.
function hysteresis(strong, weak, w, h, maxDist) {
  var n = w * h, dist = new Int16Array(n).fill(-1), queue = new Int32Array(n), qh = 0, qt = 0, out = new Uint8Array(n);
  for (var i = 0; i < n; i++) if (strong[i]) { dist[i] = 0; queue[qt++] = i; out[i] = 1; }
  while (qh < qt) {
    var p = queue[qh++], d = dist[p];
    if (d >= maxDist) continue;
    var px = p % w, py = (p / w) | 0;
    for (var k = 0; k < 8; k++) {
      var nx = px + NB8X[k], ny = py + NB8Y[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      var q = ny * w + nx;
      if (dist[q] !== -1 || !weak[q]) continue;
      dist[q] = d + 1; out[q] = 1; queue[qt++] = q;
    }
  }
  return out;
}

// ---------- 4. structure ----------

// x position of the frame's mirror axis (maximises mask overlap with its mirror).
function symmetryAxis(mask, w, h, box) {
  var best = (box.minX + box.maxX) / 2, bestScore = -1;
  var span = box.maxX - box.minX, lo = Math.round(best - span * 0.12), hi = Math.round(best + span * 0.12);
  var step = Math.max(1, Math.round(span / 400));
  for (var x0 = lo; x0 <= hi; x0++) {
    var score = 0, total = 0;
    for (var y = box.minY; y <= box.maxY; y += step) {
      for (var x = box.minX; x <= box.maxX; x += step) {
        if (!mask[y * w + x]) continue;
        total++;
        var mx = Math.round(2 * x0 - x);
        if (mx >= 0 && mx < w && mask[y * w + mx]) score++;
      }
    }
    var s = total ? score / total : 0;
    if (s > bestScore) { bestScore = s; best = x0; }
  }
  return { x: best, score: bestScore };
}

// Labels: 0 frame, 1 outside (connected to the image border), 2+ hole ids.
function regions(frame, w, h) {
  var n = w * h, lab = new Int32Array(n).fill(-1), stack = new Int32Array(n), sp = 0, i;
  for (i = 0; i < n; i++) if (frame[i]) lab[i] = 0;
  function seed(p) { if (lab[p] === -1) { lab[p] = 1; stack[sp++] = p; } }
  for (var x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (var y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  function flood(id) {
    while (sp) {
      var p = stack[--sp], px = p % w, py = (p / w) | 0;
      if (px > 0 && lab[p - 1] === -1) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (px < w - 1 && lab[p + 1] === -1) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (py > 0 && lab[p - w] === -1) { lab[p - w] = id; stack[sp++] = p - w; }
      if (py < h - 1 && lab[p + w] === -1) { lab[p + w] = id; stack[sp++] = p + w; }
    }
  }
  flood(1);
  var holes = [];
  for (i = 0; i < n; i++) {
    if (lab[i] !== -1) continue;
    var id = holes.length + 2;
    holes.push(id);
    lab[i] = id; stack[sp++] = i;
    flood(id);
  }
  // hole stats
  var stats = {};
  for (i = 0; i < n; i++) {
    var l = lab[i];
    if (l < 2) continue;
    var s = stats[l] || (stats[l] = { id: l, area: 0, minX: w, minY: h, maxX: -1, maxY: -1, sx: 0, sy: 0 });
    var px = i % w, py = (i / w) | 0;
    s.area++; s.sx += px; s.sy += py;
    if (px < s.minX) s.minX = px; if (px > s.maxX) s.maxX = px; if (py < s.minY) s.minY = py; if (py > s.maxY) s.maxY = py;
  }
  var list = Object.keys(stats).map(function (k) { var s = stats[k]; s.cx = s.sx / s.area; s.cy = s.sy / s.area; return s; });
  return { lab: lab, holes: list };
}

// Walks rays out from a lens centre over the region labels and reports, per
// angle, the rim run: the first run of frame that is followed by the outside
// (so a temple seen through the lens, which has more lens beyond it, is
// skipped). Rays stop at the frame's axis so they never reach the other lens.
// Also samples the evidence map along the run to find the rim's sharp outer
// edge (a soft shadow beyond it is not rim).
function rimProfile(lab, S, w, h, c, axisX, side, rMax, nAng) {
  var out = [];
  for (var k = 0; k < nAng; k++) {
    var th = k / nAng * Math.PI * 2, ca = Math.cos(th), sa = Math.sin(th);
    var runStart = -1, prevFrame = false, found = null, lastRun = null, atAxis = false, startsOutside = null;
    for (var r = 0; r <= rMax; r += 0.5) {
      var x = c.x + ca * r, y = c.y + sa * r;
      var crossed = side < 0 ? x > axisX : x < axisX;
      var xi = Math.round(x), yi = Math.round(y);
      var off = xi < 0 || yi < 0 || xi >= w || yi >= h;
      var l = off ? 1 : lab[yi * w + xi];
      var isFrame = l === 0;
      if (startsOutside === null) startsOutside = l === 1;
      if (isFrame && !prevFrame) runStart = r;
      if (!isFrame && prevFrame) lastRun = [runStart, r - 0.5];
      if (crossed) {
        if (isFrame) { found = [runStart, r]; atAxis = true; }
        break;
      }
      if (!isFrame && l === 1 && lastRun) { found = lastRun; break; }
      prevFrame = isFrame;
    }
    var rec = { th: th, rIn: null, rEnd: null, rOut: null, atAxis: atAxis };
    if (found) {
      rec.rIn = found[0]; rec.rEnd = found[1];
      // outer edge: the outermost strong drop in evidence along the run
      var drops = [], maxDrop = 0;
      for (var rr = found[0] + 1; rr <= found[1] + 2; rr += 0.5) {
        var s0 = sampleS(S, w, h, c.x + ca * (rr - 1), c.y + sa * (rr - 1));
        var s1 = sampleS(S, w, h, c.x + ca * (rr + 1), c.y + sa * (rr + 1));
        drops.push([rr, s0 - s1]);
        if (s0 - s1 > maxDrop) maxDrop = s0 - s1;
      }
      rec.rOut = found[1];
      for (var q = drops.length - 1; q >= 0; q--) if (drops[q][1] >= maxDrop * 0.5 && maxDrop > 8) { rec.rOut = drops[q][0]; break; }
    }
    out.push(rec);
  }
  return out;
}

// Radius of the convex hull of a contour along each ray.
function hullRadii(c, prof, rIn) {
  var K = prof.length, pts = [];
  for (var k = 0; k < K; k++) pts.push({ x: c.x + Math.cos(prof[k].th) * rIn[k], y: c.y + Math.sin(prof[k].th) * rIn[k] });
  var hull = convexHull(pts), out = new Float32Array(K);
  for (k = 0; k < K; k++) {
    var dx = Math.cos(prof[k].th), dy = Math.sin(prof[k].th), best = rIn[k];
    for (var i = 0; i < hull.length; i++) {
      var a = hull[i], b = hull[(i + 1) % hull.length];
      // ray c + t*d against segment a-b
      var ex = b.x - a.x, ey = b.y - a.y, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      var ax = a.x - c.x, ay = a.y - c.y;
      var t = (ax * ey - ay * ex) / den, u = (ax * dy - ay * dx) / den;
      if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6 && t > best) best = t;
    }
    out[k] = best;
  }
  return out;
}

export function convexHull(pts) {
  var p = pts.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
  if (p.length < 3) return p;
  function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
  var lower = [], upper = [];
  for (var i = 0; i < p.length; i++) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop(); lower.push(p[i]); }
  for (i = p.length - 1; i >= 0; i--) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop(); upper.push(p[i]); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function sampleS(S, w, h, x, y) {
  var xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0;
  return S[yi * w + xi];
}

// Smooths a per-angle radius profile (with gaps as null) into a closed contour.
function smoothProfile(vals, rs, maxStep, smoothW, sigma) {
  var K = vals.length, data = [];
  for (var k = 0; k < K; k++) {
    var row = new Float64Array(rs.length), v = vals[k];
    if (v != null) for (var j = 0; j < rs.length; j++) { var d = (rs[j] - v) / sigma; row[j] = Math.min(d * d, 9); }
    data.push(row);
  }
  return contourDP(data, rs, maxStep, smoothW);
}

// Closed contour r(theta) by dynamic programming. data[k][j] = cost of radius
// rs[j] at angle k; the radius may change by at most maxStep indices between
// neighbouring angles (plus a quadratic penalty). The angles are run twice
// round and the middle lap is kept, so the start and end meet up.
function contourDP(data, rs, maxStep, smoothW) {
  var K = data.length, J = rs.length, K2 = K * 2, INF = 1e18;
  var cost = new Float64Array(J), next = new Float64Array(J), back = [];
  for (var j = 0; j < J; j++) cost[j] = data[0][j];
  for (var kk = 1; kk < K2; kk++) {
    var k = kk % K, b = new Int32Array(J);
    for (j = 0; j < J; j++) {
      var best = INF, bj = j;
      for (var d = -maxStep; d <= maxStep; d++) {
        var p = j + d;
        if (p < 0 || p >= J) continue;
        var c = cost[p] + smoothW * d * d;
        if (c < best) { best = c; bj = p; }
      }
      next[j] = best + data[k][j]; b[j] = bj;
    }
    back.push(b);
    var t = cost; cost = next; next = t;
  }
  var end = 0;
  for (j = 1; j < J; j++) if (cost[j] < cost[end]) end = j;
  var path = new Int32Array(K2);
  path[K2 - 1] = end;
  for (kk = K2 - 1; kk >= 1; kk--) path[kk - 1] = back[kk - 1][path[kk]];
  var out = new Float32Array(K), start = Math.floor(K / 2);
  for (var a2 = 0; a2 < K; a2++) { var idx = start + a2; out[idx % K] = rs[path[idx]]; }
  return out;
}

function pointInPoly(poly, x, y) {
  var inside = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

export function rasterPolygon(poly, w, h) {
  var m = new Uint8Array(w * h);
  var minY = Infinity, maxY = -Infinity;
  poly.forEach(function (p) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
  for (var y = Math.max(0, Math.floor(minY)); y <= Math.min(h - 1, Math.ceil(maxY)); y++) {
    var xs = [], yc = y + 0.5;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a.y > yc) !== (b.y > yc)) xs.push(a.x + (yc - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort(function (p, q) { return p - q; });
    for (var k = 0; k + 1 < xs.length; k += 2) {
      for (var x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) m[y * w + x] = 1;
    }
  }
  return m;
}

function polyBox(poly) {
  var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  poly.forEach(function (p) { if (p.x < b.minX) b.minX = p.x; if (p.x > b.maxX) b.maxX = p.x; if (p.y < b.minY) b.minY = p.y; if (p.y > b.maxY) b.maxY = p.y; });
  b.cx = (b.minX + b.maxX) / 2; b.cy = (b.minY + b.maxY) / 2; b.w = b.maxX - b.minX; b.h = b.maxY - b.minY;
  return b;
}

// ---------- main entry ----------

// img: { data: RGBA bytes, width, height }.
// opts: { sensitivity (0.5..2, default 1), rimType ('auto'|'full'|'semi'|'rimless'),
//         translucent ('auto'|true|false), lightFrame (frame lighter than the
//         background, e.g. white acetate), debug }
export function extractFrame(img, opts) {
  opts = opts || {};
  var w = img.width, h = img.height, D = img.data, n = w * h, i, x, y;
  if (!(w >= 64 && h >= 32)) return { ok: false, code: 'tooSmall', reason: 'The photo is too small.' };
  var scale = Math.max(w, h) / 1000;
  var sens = clamp(opts.sensitivity || 1, 0.4, 2.5);
  var rgb = new Float32Array(n * 3);
  for (i = 0; i < n; i++) { rgb[i * 3] = D[i * 4]; rgb[i * 3 + 1] = D[i * 4 + 1]; rgb[i * 3 + 2] = D[i * 4 + 2]; }

  // 1-2. background and evidence
  var bg = backgroundModel(rgb, w, h, opts);
  var S = bg.ev.score;
  if (opts.lightFrame) {           // frames lighter than the background: brightness counts too
    S = new Float32Array(n);
    for (i = 0; i < n; i++) S[i] = Math.max(bg.ev.score[i], Math.abs(bg.ev.bright[i]));
  }
  var Thi = Math.max(36, 9 * bg.sigma) / sens, Tlo = Math.max(15, 4 * bg.sigma) / sens;

  // 3. hysteresis + keep the frame's components
  var strong = new Uint8Array(n), weak = new Uint8Array(n);
  for (i = 0; i < n; i++) { strong[i] = S[i] > Thi ? 1 : 0; weak[i] = S[i] > Tlo ? 1 : 0; }
  var grown = hysteresis(strong, weak, w, h, Math.max(2, Math.round(3 * scale)));
  var comp = components(grown, w, h);
  if (!comp.count) return { ok: false, code: 'noFrame', reason: 'No frame found — the glasses don\'t stand out from the background.' };
  var big = 0;
  for (i = 1; i < comp.count; i++) if (comp.sizes[i] > comp.sizes[big]) big = i;
  var mb = comp.boxes[big], mw = mb.maxX - mb.minX, mh = mb.maxY - mb.minY;
  // grow the frame from its biggest piece: a frame can come apart into pieces
  // (a lens, the bridge, the other lens, end pieces) when a stand hides a joint
  var keep = new Uint8Array(comp.count), ub = { minX: mb.minX, maxX: mb.maxX, minY: mb.minY, maxY: mb.maxY };
  keep[big] = 1;
  var minSize = Math.max(comp.sizes[big] * 0.03, 60 * scale * scale);
  for (var changed = true; changed;) {
    changed = false;
    var uw = ub.maxX - ub.minX, uh = ub.maxY - ub.minY;
    for (i = 0; i < comp.count; i++) {
      if (keep[i] || comp.sizes[i] < minSize) continue;
      var b = comp.boxes[i];
      var nearX = b.maxX >= ub.minX - uw * 0.35 && b.minX <= ub.maxX + uw * 0.35;
      var nearY = b.maxY >= ub.minY - uh * 0.2 && b.minY <= ub.maxY + uh * 0.2;
      if (!nearX || !nearY) continue;
      keep[i] = 1; changed = true;
      ub.minX = Math.min(ub.minX, b.minX); ub.maxX = Math.max(ub.maxX, b.maxX);
      ub.minY = Math.min(ub.minY, b.minY); ub.maxY = Math.max(ub.maxY, b.maxY);
    }
  }
  var frame = new Uint8Array(n);
  for (i = 0; i < n; i++) if (grown[i] && keep[comp.labels[i]]) frame[i] = 1;
  var box = { minX: w, minY: h, maxX: -1, maxY: -1 };
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) if (frame[y * w + x]) {
    if (x < box.minX) box.minX = x; if (x > box.maxX) box.maxX = x; if (y < box.minY) box.minY = y; if (y > box.maxY) box.maxY = y;
  }

  // 4. axis, regions, lens openings
  var axis = symmetryAxis(frame, w, h, box);
  var cr = Math.max(1, Math.round(2 * scale));
  var closed = erode(dilate(frame, w, h, cr), w, h, cr);
  var reg = regions(closed, w, h);
  var dbg = { S: S, Thi: Thi, Tlo: Tlo, frame: frame, closed: closed, lab: reg.lab, axis: axis, box: box, bg: bg };
  var frameArea = (box.maxX - box.minX) * (box.maxY - box.minY);
  var sides = [-1, 1].map(function (side) {
    var holes = reg.holes.filter(function (hl) {
      return (side < 0 ? hl.cx < axis.x : hl.cx > axis.x) && hl.area > frameArea * 0.02;
    }).sort(function (a, b) { return b.area - a.area; });
    var hole = holes[0] || null;
    var c;
    if (hole) c = { x: (hole.minX + hole.maxX) / 2, y: (hole.minY + hole.maxY) / 2 };
    else {
      var half = side < 0 ? axis.x - box.minX : box.maxX - axis.x;
      var cx = axis.x + side * half * 0.5, top = box.maxY;
      for (y = box.minY; y <= box.maxY; y++) if (frame[y * w + Math.round(cx)]) { top = y; break; }
      var bottomOfRim = top;
      while (bottomOfRim < box.maxY && frame[bottomOfRim * w + Math.round(cx)]) bottomOfRim++;
      c = { x: cx, y: bottomOfRim + half * 0.3 };
    }
    return { side: side, hole: hole, c: c };
  });
  dbg.sides = sides;

  // per lens: rim band [inner edge, outer edge] around it
  var NA = 180, halfW = Math.max(axis.x - box.minX, box.maxX - axis.x);
  var removeMask = new Uint8Array(n);       // frame pixels to drop (seen through the lens, shadows)
  var shadowMask = new Uint8Array(n);
  // darker than the background by the same factor in every channel: a shadow,
  // not coloured or tinted frame material
  function neutralShade(q) {
    var lo = 9, hi = 0;
    for (var c = 0; c < 3; c++) { var rt = rgb[q * 3 + c] / Math.max(1, bg.B[q * 3 + c]); if (rt < lo) lo = rt; if (rt > hi) hi = rt; }
    return hi < 0.97 && hi - lo < 0.04;
  }
  var lensMasks = [];
  sides.forEach(function (sd) {
    var rMax = Math.ceil(halfW * 1.05);
    var prof = rimProfile(reg.lab, S, w, h, sd.c, axis.x, sd.side, rMax, NA);
    var rs = []; for (var r = 0; r <= rMax; r++) rs.push(r);
    // first estimate of rim thickness, then snap each ray's inner edge to where the
    // evidence reaches rim strength (weak things stuck to the inside of the rim,
    // like a display disc's shadow, are not rim)
    var t0 = [];
    prof.forEach(function (p) { if (p.rIn != null && !p.atAxis) t0.push(p.rOut - p.rIn); });
    var medT0 = t0.length ? medianOf(Float32Array.from(t0), t0.length) : 0;
    if (medT0 > 0) prof.forEach(function (p) {
      if (p.rIn == null || p.atAxis || p.rEnd - p.rIn < 1.6 * medT0) return;
      var ca = Math.cos(p.th), sa = Math.sin(p.th), lv = [];
      for (var rr = p.rEnd - medT0; rr <= p.rEnd; rr += 1) lv.push(sampleS(S, w, h, sd.c.x + ca * rr, sd.c.y + sa * rr));
      var level = medianOf(Float32Array.from(lv), lv.length);
      if (level < 2 * Thi) return;
      for (rr = p.rIn; rr <= p.rEnd - 0.5 * medT0; rr += 0.5) {
        if (sampleS(S, w, h, sd.c.x + ca * rr, sd.c.y + sa * rr) < 0.5 * level) continue;
        var ok = true;
        for (var r2 = rr; r2 <= p.rEnd; r2 += 1) if (sampleS(S, w, h, sd.c.x + ca * r2, sd.c.y + sa * r2) < 0.3 * level) { ok = false; break; }
        if (ok) { p.rIn = rr; break; }
      }
    });
    var inVals = prof.map(function (p) { return p.rIn; });
    var closedCount = inVals.filter(function (v) { return v != null; }).length;
    sd.closedFrac = closedCount / NA;
    // open rays (no rim, e.g. bottom of a semi-rimless lens): follow faint lens-edge evidence
    var data = [];
    for (var k = 0; k < NA; k++) {
      var row = new Float64Array(rs.length), p = prof[k];
      if (p.rIn != null) { for (var j = 0; j < rs.length; j++) { var d = (rs[j] - p.rIn) / 2; row[j] = Math.min(d * d, 9); } }
      else {
        var ca = Math.cos(p.th), sa = Math.sin(p.th);
        for (j = 0; j < rs.length; j++) {
          var ev = sampleS(S, w, h, sd.c.x + ca * rs[j], sd.c.y + sa * rs[j]);
          row[j] = 1.5 - Math.min(ev, 40) / 40 * 1.5;
        }
      }
      data.push(row);
    }
    // wide rectangular lenses change radius very fast near their corners, so the
    // step limit must be generous; outliers are handled by the hull step below
    var maxStep = Math.max(4, Math.round(10 * scale));
    var rIn = contourDP(data, rs, maxStep, 0.02);
    var thick = [];
    prof.forEach(function (p, k) { if (p.rIn != null && !p.atAxis) thick.push(p.rOut - p.rIn); });
    var medT = thick.length ? medianOf(Float32Array.from(thick), thick.length) : 0;
    // lens shapes are convex: dents in the inner contour are things attached to the
    // rim inside the lens (a temple seen through it near the hinge, a stand) - fill
    // them from the convex hull, but only up to a limited depth
    var hullR = hullRadii(sd.c, prof, rIn);
    var rMed = medianOf(Float32Array.from(rIn), rIn.length);
    var maxFill = Math.max(3 * medT, 0.35 * rMed, 18 * scale);
    for (k = 0; k < NA; k++) if (hullR[k] > rIn[k] && hullR[k] - rIn[k] <= maxFill) rIn[k] = hullR[k];
    // shadows cast below the rim (glasses resting on a table): only below the lens,
    // only where the ray crosses the rim squarely (not end pieces, bridge or grazing rays)
    var rimS = [];
    var outVals = prof.map(function (p) {
      var deg = p.th * 180 / Math.PI;
      rimS.push(0);
      if (p.rIn == null || p.atAxis || deg < 25 || deg > 155) return null;
      if (p.rEnd - p.rIn > Math.max(1.8 * medT, medT + 8 * scale)) return null;
      var v = [];
      for (var rr = p.rIn; rr <= p.rOut; rr += 1) v.push(sampleS(S, w, h, sd.c.x + Math.cos(p.th) * rr, sd.c.y + Math.sin(p.th) * rr));
      rimS[rimS.length - 1] = v.length ? medianOf(Float32Array.from(v), v.length) : 0;
      return p.rOut;
    });
    var rOut = smoothProfile(outVals, rs, maxStep, 0.02, 2);
    sd.prof = prof; sd.rIn = rIn; sd.rOut = rOut; sd.medT = medT;
    sd.poly = [];
    for (k = 0; k < NA; k++) sd.poly.push({ x: sd.c.x + Math.cos(prof[k].th) * rIn[k], y: sd.c.y + Math.sin(prof[k].th) * rIn[k] });
    // thickness top vs bottom (image y points down: 90 deg = down)
    function sectorMedian(a0, a1) {
      var v = [];
      prof.forEach(function (p) {
        var deg = p.th * 180 / Math.PI;
        if (deg >= a0 && deg <= a1) v.push(p.rIn != null ? p.rOut - p.rIn : 0);
      });
      return v.length ? medianOf(Float32Array.from(v), v.length) : 0;
    }
    sd.tTop = sectorMedian(240, 300); sd.tBottom = sectorMedian(60, 120);
    sd.bottomOpen = prof.filter(function (p) { var d = p.th * 180 / Math.PI; return d >= 60 && d <= 120 && p.rIn == null; }).length > 10;
    var lm = rasterPolygon(sd.poly, w, h);
    lensMasks.push(lm);
    // drop frame pixels inside the lens (keeping a 1 px rim edge) and beyond the rim's sharp outer edge
    var inner = erode(lm, w, h, 1);
    var bx0 = Math.max(0, Math.floor(sd.c.x - rMax)), bx1 = Math.min(w - 1, Math.ceil(sd.c.x + rMax));
    var by0 = Math.max(0, Math.floor(sd.c.y - rMax)), by1 = Math.min(h - 1, Math.ceil(sd.c.y + rMax));
    for (y = by0; y <= by1; y++) for (x = bx0; x <= bx1; x++) {
      i = y * w + x;
      if (!frame[i]) continue;
      if (inner[i]) { removeMask[i] = 1; continue; }
      var dx = x - sd.c.x, dy = y - sd.c.y, rr = Math.hypot(dx, dy);
      var ang = Math.atan2(dy, dx); if (ang < 0) ang += Math.PI * 2;
      var kk = Math.round(ang / (Math.PI * 2) * NA) % NA, pk = prof[kk];
      if (outVals[kk] == null || pk.rEnd == null) continue;
      // never remove material that is as strong as the rim itself
      if (rr > rOut[kk] + 1.5 * scale + 1 && rr < pk.rEnd + 4 && S[i] < Math.max(Thi * 1.3, rimS[kk] * 0.55)) removeMask[i] = 1;
    }
    // the shadow on the table runs sideways from where the rim touches it, so rays
    // from the lens centre cross it at a slant and were skipped above (run too
    // long). Walk out from the lens edge along its normal instead, across the
    // lower part of the rim: find the rim's core (strongest evidence) and where
    // it ends; weaker material after it that darkens the background evenly in
    // every channel (a shadow, not coloured or translucent frame material) goes.
    var semiLike = sd.bottomOpen || (sd.tTop > 0 && sd.tBottom < Math.max(0.4 * sd.tTop, 1) && sd.tBottom < 7 * scale) ||
      opts.rimType === 'semi' || opts.rimType === 'rimless';
    if (!semiLike && medT > 0) {
      // the band the shadow can be in: from about one rim width above the
      // bottom of the rim (where the frame meets the table) downwards
      var lb = polyBox(sd.poly), lowY = Math.max(sd.c.y + 0.5 * (lb.maxY - sd.c.y), lb.maxY + Math.max(sd.tBottom, 0.5 * medT) - 1.3 * medT);
      var margin = Math.max(2, Math.round(2 * scale)), depth = Math.max(4 * medT, 30 * scale), reach = 2 * medT + 4;
      var P = sd.poly, NP = P.length, peaks = [];
      for (k = 0; k < NP; k++) {
        var pa = P[k], pb = P[(k + 1) % NP], pPrev = P[(k - 1 + NP) % NP], pNext = P[(k + 2) % NP];
        var tx = pNext.x - pPrev.x, ty = pNext.y - pPrev.y, tl = Math.hypot(tx, ty);
        if (tl < 1e-6) continue;
        var nx = ty / tl, ny = -tx / tl;
        if (nx * (pa.x - sd.c.x) + ny * (pa.y - sd.c.y) < 0) { nx = -nx; ny = -ny; }
        if (ny < 0.3) continue;                    // only where the rim faces downwards
        var seg = Math.hypot(pb.x - pa.x, pb.y - pa.y), steps = Math.max(1, Math.ceil(seg / 0.5));
        for (var st = 0; st < steps; st++) {
          var f = st / steps, sx = pa.x + (pb.x - pa.x) * f, sy = pa.y + (pb.y - pa.y) * f;
          if (sy < lowY - medT) continue;
          var peak = 0, dP = 0, dEnd = -1, dd;
          for (dd = 0; dd <= reach; dd += 0.5) { var sv = sampleS(S, w, h, sx + nx * dd, sy + ny * dd); if (sv > peak) { peak = sv; dP = dd; } }
          if (peak < Thi * 1.3) continue;
          for (dd = dP; dd <= dP + reach; dd += 0.5) {
            if (sampleS(S, w, h, sx + nx * dd, sy + ny * dd) < 0.5 * peak && sampleS(S, w, h, sx + nx * (dd + 1), sy + ny * (dd + 1)) < 0.5 * peak) { dEnd = dd; break; }
          }
          if (dEnd < 0) continue;
          var hit = false;
          for (dd = dEnd + margin; dd <= dEnd + depth; dd += 0.5) {
            var qx = Math.round(sx + nx * dd), qy = Math.round(sy + ny * dd);
            if (qx < 0 || qy < 0 || qx >= w || qy >= h || qy < lowY) continue;
            i = qy * w + qx;
            if (S[i] >= 0.7 * peak) break;         // something solid again: not the shadow
            if (frame[i] && neutralShade(i)) { removeMask[i] = 1; shadowMask[i] = 1; hit = true; }
          }
          if (hit) peaks.push(peak);
        }
      }
      // close the gaps between neighbouring walks
      if (peaks.length) {
        var growThr = 0.6 * medianOf(Float32Array.from(peaks), peaks.length);
        var gx0 = Math.max(1, Math.floor(lb.minX - depth)), gx1 = Math.min(w - 2, Math.ceil(lb.maxX + depth));
        var gy0 = Math.max(1, Math.ceil(lowY)), gy1 = Math.min(h - 2, Math.ceil(lb.maxY + medT + depth));
        for (var it = 0; it < Math.ceil(depth); it++) {
          var add = [];
          for (y = gy0; y <= gy1; y++) for (x = gx0; x <= gx1; x++) {
            i = y * w + x;
            if (!frame[i] || removeMask[i] || S[i] >= growThr) continue;
            if (!(shadowMask[i - 1] || shadowMask[i + 1] || shadowMask[i - w] || shadowMask[i + w] ||
              shadowMask[i - w - 1] || shadowMask[i - w + 1] || shadowMask[i + w - 1] || shadowMask[i + w + 1])) continue;
            if (neutralShade(i)) add.push(i);
          }
          if (!add.length) break;
          add.forEach(function (q) { removeMask[q] = 1; shadowMask[q] = 1; });
        }
      }
    }
  });

  // rim type: a closed thick rim all round = full-rim; thick on top but thin or
  // open below = semi-rimless (the thin line is the lens edge, not a rim)
  var semiVotes = 0, fullVotes = 0, rimlessVotes = 0;
  sides.forEach(function (sd) {
    if (sd.closedFrac < 0.3 && sd.tTop < 4 * scale) rimlessVotes++;
    else if (sd.bottomOpen || (sd.tTop > 0 && sd.tBottom < Math.max(0.4 * sd.tTop, 1) && sd.tBottom < 7 * scale)) semiVotes++;
    else fullVotes++;
  });
  var rimType = rimlessVotes === 2 ? 'rimless' : semiVotes >= 1 && fullVotes < 2 ? 'semi' : 'full';
  if (opts.rimType && opts.rimType !== 'auto') rimType = opts.rimType;
  dbg.removeMask = removeMask; dbg.lensMasks = lensMasks; dbg.shadowMask = shadowMask;

  // 5. matte: alpha from how much background each pixel blocks; colour un-mixed
  var keepF = new Uint8Array(n);
  for (i = 0; i < n; i++) keepF[i] = frame[i] && !removeMask[i] ? 1 : 0;
  var kc = components(keepF, w, h), kbig = 0;
  for (i = 1; i < kc.count; i++) if (kc.sizes[i] > kc.sizes[kbig]) kbig = i;
  for (i = 0; i < n; i++) if (keepF[i] && kc.sizes[kc.labels[i]] < Math.max(kc.sizes[kbig] * 0.02, 30 * scale * scale)) keepF[i] = 0;
  var left = sides[0], right = sides[1];
  var support = removeSupports(keepF, w, h, left, right, lensMasks, scale);
  var soft = dilate(keepF, w, h, 1);
  var lensAll = new Uint8Array(n);
  lensMasks.forEach(function (lm) { var e = erode(lm, w, h, 1); for (var q = 0; q < n; q++) if (e[q]) lensAll[q] = 1; });
  var out = new Uint8ClampedArray(n * 4), B = bg.B, interior = erode(keepF, w, h, Math.max(1, Math.round(2 * scale))), alphaList = [];
  var forceSolid = opts.translucent === false;
  for (i = 0; i < n; i++) {
    if (!soft[i] || (lensAll[i] && !keepF[i])) continue;
    var a = 0;
    for (var c = 0; c < 3; c++) {
      var o = rgb[i * 3 + c], bb = Math.max(1, B[i * 3 + c]);
      var ac = o < bb ? (bb - o) / bb : (o - bb) / Math.max(1, 255 - bb);
      if (ac > a) a = ac;
    }
    a = Math.min(1, a * 1.1 + Math.max(0, a - 0.5) * 1.2);
    if (forceSolid && keepF[i]) a = Math.min(1, a * 2.5);
    if (!keepF[i]) a = Math.min(a, 0.5);            // the 1 px ring outside the mask: edge pixels only
    if (a < 0.03) continue;
    for (c = 0; c < 3; c++) out[i * 4 + c] = clamp((rgb[i * 3 + c] - (1 - a) * B[i * 3 + c]) / a, 0, 255);
    out[i * 4 + 3] = Math.round(a * 255);
    if (interior[i] && (i % 3 === 0)) alphaList.push(a);
  }
  var repaired = [];
  var cov = coveredBridge(out, S, bg.ev.bright, keepF, w, h, support, Tlo, scale);
  var span = null;
  if (support && support.removed > 0 && support.box) span = [Math.max(support.xL + 1, support.box.minX), Math.min(support.xR - 1, support.box.maxX)];
  if (cov) span = span ? [Math.min(span[0], cov[0]), Math.max(span[1], cov[1])] : cov;
  if (span) {
    var rb = repairBridge(out, w, h, support, span[0], span[1]);
    if (rb) { repaired.push(rb); if (!support.removed) { support.removed = 1; support.box = rb; } }
  }
  dbg.keep = keepF; dbg.support = support;
  return finish({
    w: w, h: h, out: out, sides: sides, rimType: rimType, frame: frame, keepF: keepF, removeMask: removeMask,
    lensMasks: lensMasks, support: support, repaired: repaired, S: S, Thi: Thi, scale: scale, axis: axis,
    alphaMean: alphaList.length ? medianOf(Float32Array.from(alphaList), alphaList.length) : 1, opts: opts, debug: opts.debug ? dbg : null
  });
}

// ---------- display stands at the bridge ----------

// The usual shop display holds the frame by an acrylic clip over the bridge.
// Between the lenses, a frame only has the bridge (a band along the top) and
// nose pads (beside the lenses). Material well above the bridge, or a separate
// blob hanging below it in the middle, is the stand.
function removeSupports(keep, w, h, left, right, lensMasks, scale) {
  var xL = -Infinity, xR = Infinity;
  left.poly.forEach(function (p) { if (p.x > xL) xL = p.x; });
  right.poly.forEach(function (p) { if (p.x < xR) xR = p.x; });
  xL = Math.ceil(xL); xR = Math.floor(xR);
  var zw = xR - xL;
  if (zw < 8 * scale) return null;
  function bandAt(x) {
    x = Math.round(x);
    for (var y = 0; y < h; y++) {
      if (!keep[y * w + x]) continue;
      var y2 = y;
      while (y2 + 1 < h && keep[(y2 + 1) * w + x]) y2++;
      return { top: y, bot: y2 };
    }
    return null;
  }
  // the bridge's top edge from the clean ends of the gap, its thickness from a
  // low percentile across the gap (nose-pad legs make some columns much
  // deeper, a clip can make others deeper or shallower)
  var tops = [], thicks = [], topsL = [], topsR = [];
  for (var cx = Math.ceil(xL + 0.05 * zw); cx <= Math.floor(xR - 0.05 * zw); cx++) {
    var fr = bandAt(cx);
    if (!fr) continue;
    thicks.push(fr.bot - fr.top + 1);
    if (cx < xL + 0.2 * zw) topsL.push(fr.top);
    if (cx > xR - 0.2 * zw) topsR.push(fr.top);
  }
  if (!thicks.length || !topsL.length || !topsR.length) return null;
  thicks.sort(function (p, q) { return p - q; });
  var tMin = Math.max(2, thicks[Math.floor(thicks.length * 0.25)]);
  var topL = medianOf(Float32Array.from(topsL), topsL.length), topR = medianOf(Float32Array.from(topsR), topsR.length);
  var x0 = xL + 0.1 * zw, x1 = xR - 0.1 * zw;
  function band(x) {
    var t = clamp((x - x0) / Math.max(1, x1 - x0), 0, 1), top = topL + (topR - topL) * t;
    return { top: top, bot: top + tMin };
  }
  var T = tMin;
  var removed = 0, sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
  function drop(i, x, y) { keep[i] = 0; removed++; if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; if (y < sy0) sy0 = y; if (y > sy1) sy1 = y; }
  // above the bridge line
  for (var x = Math.ceil(x0); x <= Math.floor(x1); x++) {
    var bd = band(x), lim = bd.top - (2 + 0.3 * T);
    for (var y = 0; y < lim; y++) { var i = y * w + x; if (keep[i]) drop(i, x, y); }
  }
  // blobs hanging below the bridge in the middle, not attached to the lenses' rims
  var below = new Uint8Array(w * h);
  for (x = xL + 1; x < xR; x++) {
    var bb = band(x);
    for (y = Math.ceil(bb.bot + Math.max(2, 0.15 * T)); y < h; y++) { i = y * w + x; if (keep[i]) below[i] = 1; }
  }
  var near = new Uint8Array(w * h);
  lensMasks.forEach(function (lm) { var d = dilate(lm, w, h, Math.max(3, Math.round(3 * scale))); for (var q = 0; q < w * h; q++) if (d[q]) near[q] = 1; });
  var cc = components(below, w, h);
  var bad = new Uint8Array(cc.count);
  for (var c = 0; c < cc.count; c++) {
    var bx = cc.boxes[c];
    bad[c] = (bx.cx > xL + 0.15 * zw && bx.cx < xR - 0.15 * zw) ? 1 : 0;
  }
  for (i = 0; i < w * h; i++) if (below[i] && bad[cc.labels[i]] && near[i]) bad[cc.labels[i]] = 0;
  for (y = 0; y < h; y++) for (x = xL + 1; x < xR; x++) { i = y * w + x; if (below[i] && bad[cc.labels[i]]) drop(i, x, y); }
  return {
    removed: removed >= 12 * scale * scale ? removed : 0,
    box: removed ? { minX: sx0, maxX: sx1, minY: sy0, maxY: sy1 } : null,
    xL: xL, xR: xR, band: band, T: T, tRef: tMin, zw: zw
  };
}

// Bridge columns hidden by a clear stand. Directly under a real bridge is plain
// background (the nose gap) or frame (pad legs); under a clear display clip there
// are highlights and edges that are not frame. Columns with such a clear object
// right below the bridge, in the middle of the gap, are the covered stretch.
// Returns [x0, x1] or null.
function coveredBridge(out, S, bright, keep, w, h, sup, Tlo, scale) {
  if (!sup) return null;
  var a0 = Math.ceil(sup.xL + 0.08 * sup.zw), a1 = Math.floor(sup.xR - 0.08 * sup.zw);
  if (a1 - a0 < 4) return null;
  var flags = [];
  for (var x = a0; x <= a1; x++) {
    var bd = sup.band(x), hits = 0, tot = 0;
    for (var y = Math.round(bd.bot + 2); y <= Math.round(bd.bot + 2 + 1.5 * sup.T); y++) {
      if (y < 0 || y >= h) continue;
      var i = y * w + x;
      tot++;
      if (!keep[i] && (bright[i] > 15 || S[i] > Tlo)) hits++;
    }
    flags.push(tot && hits / tot >= 0.3 ? 1 : 0);
  }
  // close 1-2 column gaps, then take the longest run
  for (var k = 1; k < flags.length - 1; k++) if (!flags[k] && flags[k - 1] && (flags[k + 1] || flags[k + 2])) flags[k] = 2;
  var best = null, start = -1;
  for (k = 0; k <= flags.length; k++) {
    if (k < flags.length && flags[k]) { if (start < 0) start = k; continue; }
    if (start >= 0 && (!best || k - start > best[1] - best[0])) best = [start, k - 1];
    start = -1;
  }
  sup.dbgCover = { a0: a0, flags: flags.join(''), best: best };
  if (!best || best[1] - best[0] + 1 < Math.max(4, 3 * scale)) return null;
  var mid = a0 + (best[0] + best[1]) / 2;
  if (mid < sup.xL + 0.15 * sup.zw || mid > sup.xR - 0.15 * sup.zw) return null;
  return [a0 + best[0], a0 + best[1]];
}

// Where a stand covered part of the bridge, rebuild that stretch from clean
// bridge columns either side of it: the top edge is interpolated, the
// thickness taken from the thinner side, the colour interpolated row by row.
// Returns the rebuilt area so it can be flagged for review.
function repairBridge(out, w, h, sup, x0, x1) {
  // the bridge in column x: the first solid run of at least half the bridge thickness
  function colRun(x) {
    var bd = sup.band(x), top = -1;
    var ya = Math.max(0, Math.floor(bd.top - sup.T)), yb = Math.min(h - 1, Math.ceil(bd.bot + 2 * sup.T));
    for (var y = ya; y <= yb + 1; y++) {
      var on = y <= yb && out[(y * w + x) * 4 + 3] > 150;
      if (on && top < 0) top = y;
      if (!on && top >= 0) {
        if (y - top >= Math.max(2, sup.tRef * 0.5)) return { top: top, bot: y - 1, t: y - 1 - top };
        top = -1;
      }
    }
    return null;
  }
  function findRef(xs, dir, limit) {
    for (var x = xs; Math.abs(x - xs) <= limit; x += dir) {
      if (x <= sup.xL || x >= sup.xR) break;
      var c = colRun(x);
      if (c && c.t <= sup.tRef * 1.6 + 2) return { x: x, run: c };
    }
    var xe = dir < 0 ? Math.ceil(sup.xL) + 1 : Math.floor(sup.xR) - 1, ce = colRun(xe);
    return ce ? { x: xe, run: ce } : null;
  }
  var lim = Math.max(6, sup.zw * 0.3);
  var L = findRef(x0 - 3, -1, lim), R = findRef(x1 + 3, 1, lim);
  if (!L || !R || R.x - L.x < 3) return null;
  var t = Math.min(L.run.t, R.run.t);
  var y0 = Infinity, y1 = -Infinity;
  var fx0 = Math.max(L.x + 1, x0 - 2), fx1 = Math.min(R.x - 1, x1 + 2);   // only the covered stretch is touched
  for (var x = fx0; x <= fx1; x++) {
    var f = (x - L.x) / (R.x - L.x), top = L.run.top + (R.run.top - L.run.top) * f, bot = top + t;
    var bd = sup.band(x);
    var ya = Math.max(0, Math.floor(Math.min(bd.top, top) - 2 * sup.T)), yb = Math.min(h - 1, Math.ceil(bd.bot + 4 * sup.T));
    for (var y = ya; y <= yb; y++) {
      var o = (y * w + x) * 4;
      if (y < top - 0.5 || y > bot + 0.5) { out[o + 3] = 0; continue; }
      var u = clamp((y - top) / Math.max(1, t), 0, 1);
      var ol = (Math.round(L.run.top + u * t) * w + L.x) * 4, or = (Math.round(R.run.top + u * t) * w + R.x) * 4;
      for (var c = 0; c < 4; c++) out[o + c] = out[ol + c] * (1 - f) + out[or + c] * f;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { minX: fx0, maxX: fx1, minY: y0, maxY: y1, reason: 'bridge hidden by the display stand' };
}

// ---------- landmarks, checks and the representation decision ----------

var MESSAGES = {
  cropped: 'The frame touches the edge of the photo, so part of it may be cut off. Retake with some space around the glasses.',
  lowContrast: 'The frame barely stands out from the background. A plain background of a different shade (darker for light frames) gives a cleaner result.',
  asymmetric: 'The two lenses come out about {pct}% different in size, so the photo was taken a little from the side. It still works; a straight-on photo gives the most accurate 3D.',
  asymmetricStrong: 'The two lenses come out about {pct}% different in size, so the photo was taken at an angle. Retake it straight on for the 3D try-on; until then it is used as a flat overlay.',
  tilted: 'The photo is tilted; this is corrected automatically.',
  seenThrough: 'Removed things seen through the lenses (temples, stand, printing on demo lenses, reflections).',
  shadow: 'Removed the shadow cast under the frame.',
  support: 'Removed the display stand at the bridge.',
  bridgeRepaired: 'The display clip hid part of the bridge; that part has been rebuilt from the bridge either side of it. Check it (outlined), or photograph the frame off its clip.',
  rimMismatch: 'One lens looks closed at the bottom and the other open. Check the rim type.',
  noLensEdge: 'The lower lens edges were hard to see, so the lens outline below the rim is partly estimated.',
  translucent: 'Translucent material detected: it is kept see-through, so skin shows through it on the face.',
  small: 'The frame is small in the photo. Fill more of the picture with it for finer detail.',
  wide: 'There is a lot of frame beyond the lenses; if the temples are folded out sideways, fold them back and retake.'
};

function finish(r) {
  var w = r.w, h = r.h, out = r.out, scale = r.scale, i, x, y;
  var L = r.sides[0], R = r.sides[1];
  function lens(sd, name) {
    var b = polyBox(sd.poly);
    var poly = [];
    for (var k = 0; k < sd.poly.length; k += 3) poly.push({ x: Math.round(sd.poly[k].x * 10) / 10, y: Math.round(sd.poly[k].y * 10) / 10 });
    return { side: name, poly: poly, box: { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }, centre: { x: b.cx, y: b.cy }, width: b.w, height: b.h };
  }
  var lensL = lens(L, 'left'), lensR = lens(R, 'right');
  // material bounding box (alpha > 0.4) and hinges (outermost material, upper part)
  var mb = { minX: w, minY: h, maxX: -1, maxY: -1 };
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) if (out[(y * w + x) * 4 + 3] > 100) {
    if (x < mb.minX) mb.minX = x; if (x > mb.maxX) mb.maxX = x; if (y < mb.minY) mb.minY = y; if (y > mb.maxY) mb.maxY = y;
  }
  function hingeAt(x0, dir) {
    var sy = 0, c = 0;
    for (var xx = x0; Math.abs(xx - x0) <= 3 * scale; xx += dir) for (var yy = mb.minY; yy <= mb.maxY; yy++) if (out[(yy * w + xx) * 4 + 3] > 100) { sy += yy; c++; }
    return { x: x0 + dir * 2 * scale, y: c ? sy / c : (mb.minY + mb.maxY) / 2 };
  }
  var hingeL = hingeAt(mb.minX, 1), hingeR = hingeAt(mb.maxX, -1);
  var nasalL = lensL.box.maxX, nasalR = lensR.box.minX;
  var bridge = { x: (nasalL + nasalR) / 2, y: (lensL.centre.y + lensR.centre.y) / 2 };
  var bridgeTop = bridge.y;
  for (y = mb.minY; y <= mb.maxY; y++) if (out[(y * w + Math.round(bridge.x)) * 4 + 3] > 100) { bridgeTop = y; break; }
  var angle = Math.atan2(lensR.centre.y - lensL.centre.y, lensR.centre.x - lensL.centre.x);
  var lensDist = Math.hypot(lensR.centre.x - lensL.centre.x, lensR.centre.y - lensL.centre.y);

  // checks
  var warnings = [], level = '3d', reasons = [], reasonCodes = [];
  function warn(code, severity, box, vars) {
    var msg = MESSAGES[code];
    if (vars) Object.keys(vars).forEach(function (k) { msg = msg.replace('{' + k + '}', vars[k]); });
    warnings.push({ code: code, severity: severity, message: msg, box: box || null, vars: vars || null });
  }
  var margin = 2;
  if (mb.minX <= margin || mb.minY <= margin || mb.maxX >= w - 1 - margin || mb.maxY >= h - 1 - margin) {
    warn('cropped', 'error'); level = '2d'; reasons.push('the frame is cut off by the photo edge'); reasonCodes.push('cropped');
  }
  var strongVals = [];
  for (i = 0; i < w * h; i += 3) if (r.keepF[i]) strongVals.push(r.S[i]);
  var medS = strongVals.length ? medianOf(Float32Array.from(strongVals), strongVals.length) : 0;
  if (medS < 45) warn('lowContrast', 'warn');
  var wr = lensL.width / Math.max(1, lensR.width), hr = lensL.height / Math.max(1, lensR.height);
  var asym = Math.max(Math.abs(1 - wr), Math.abs(1 - hr));
  if (asym > 0.1) {
    var both = { minX: Math.min(lensL.box.minX, lensR.box.minX), minY: Math.min(lensL.box.minY, lensR.box.minY), maxX: Math.max(lensL.box.maxX, lensR.box.maxX), maxY: Math.max(lensL.box.maxY, lensR.box.maxY) };
    var strongAsym = asym > 0.18;
    warn(strongAsym ? 'asymmetricStrong' : 'asymmetric', strongAsym ? 'error' : 'warn', both, { pct: Math.round(asym * 100) });
    if (strongAsym) { level = '2d'; reasons.push('the photo is taken at too much of an angle'); reasonCodes.push('angle'); }
  }
  if (Math.abs(angle) > 5 * Math.PI / 180) warn('tilted', 'info');
  var inside = 0, shadow = 0;
  var lensAny = new Uint8Array(w * h);
  r.lensMasks.forEach(function (lm) { for (var q = 0; q < w * h; q++) if (lm[q]) lensAny[q] = 1; });
  for (i = 0; i < w * h; i++) if (r.removeMask[i]) { if (lensAny[i]) inside++; else shadow++; }
  if (inside > 150 * scale * scale) warn('seenThrough', 'info');
  if (shadow > 150 * scale * scale) warn('shadow', 'info');
  if (r.support && r.support.removed > 0) warn('support', 'info', r.support.box);
  r.repaired.forEach(function (b) { warn('bridgeRepaired', 'warn', b); });
  if (L.bottomOpen !== R.bottomOpen && r.rimType !== 'full') warn('rimMismatch', 'warn');
  if (r.rimType !== 'full' && (L.bottomOpen || R.bottomOpen)) warn('noLensEdge', 'warn');
  var translucent = r.opts.translucent === false ? false : r.opts.translucent === true ? true : r.alphaMean < 0.8;
  if (translucent) warn('translucent', 'info');
  var fw = mb.maxX - mb.minX;
  if (fw < 0.45 * w) warn('small', 'info');
  var lensSpan = lensR.box.maxX - lensL.box.minX;
  if (fw > lensSpan * 1.35) warn('wide', 'warn');
  if (L.closedFrac < 0.3 && R.closedFrac < 0.3 && r.rimType === 'rimless') { level = '2d'; reasons.push('no rim was found to build the 3D front from'); reasonCodes.push('noRim'); }

  var penalty = 0;
  warnings.forEach(function (wn) { penalty += wn.severity === 'error' ? 0.35 : wn.severity === 'warn' ? 0.12 : 0; });
  var quality = clamp(1 - penalty - Math.max(0, asym - 0.04), 0, 1);
  var labels = {
    '3d': 'Approximate 3D: the front is built from this photo and the temples are generated (add a temple photo for the real ones). It is not a scanned 3D model.',
    '2d': 'Flat overlay: ' + (reasons.join('; ') || 'this photo is better used flat') + '. It still follows the face, without depth.'
  };
  return {
    ok: true,
    width: w, height: h,
    cutout: { data: out, width: w, height: h },
    lenses: [lensL, lensR],
    landmarks: { lensL: lensL.centre, lensR: lensR.centre, bridge: bridge, bridgeTop: { x: bridge.x, y: bridgeTop }, hingeL: hingeL, hingeR: hingeR, angle: angle, axisX: r.axis.x, frameBox: mb },
    measurements: {
      frameWidthPx: fw, frameHeightPx: mb.maxY - mb.minY, lensDistPx: lensDist,
      lensWidthPx: (lensL.width + lensR.width) / 2, lensHeightPx: (lensL.height + lensR.height) / 2,
      bridgePx: nasalR - nasalL, aspect: fw / Math.max(1, mb.maxY - mb.minY)
    },
    rimType: r.rimType,
    translucent: translucent,
    opacity: r.alphaMean,
    repaired: r.repaired,
    warnings: warnings,
    representation: { level: level, label: labels[level], reasons: reasonCodes },
    quality: quality,
    debug: r.debug
  };
}
