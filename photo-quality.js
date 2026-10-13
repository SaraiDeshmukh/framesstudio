// Quick checks of a shop's frame photo before (and alongside) the automatic
// extraction, so the shop can be told how to retake it: too small, too dark,
// washed out, blurred, or flat. No DOM, no network; unit-tested in
// tests/photo-quality.test.mjs.
//
// img: { data: RGBA bytes, width, height } (the working copy, up to 1000 px);
// naturalW/H: the size of the photo as taken.

export var PHOTO_MIN_SIDE = 700;   // shorter side of the original, below which detail suffers

function luma(d, i) { return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; }

// Variance of the Laplacian over a grey copy about 400 px wide: a standard,
// cheap sharpness measure (blurred photos have weak edges everywhere).
function sharpness(img) {
  var step = Math.max(1, Math.round(img.width / 400));
  var w = Math.floor(img.width / step), h = Math.floor(img.height / step);
  if (w < 8 || h < 8) return 0;
  var g = new Float32Array(w * h), d = img.data;
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var sum = 0, n = 0;
    for (var yy = 0; yy < step; yy++) for (var xx = 0; xx < step; xx++) {
      sum += luma(d, ((y * step + yy) * img.width + (x * step + xx)) * 4); n++;
    }
    g[y * w + x] = sum / n;
  }
  var vals = [];
  for (var y2 = 1; y2 < h - 1; y2++) for (var x2 = 1; x2 < w - 1; x2++) {
    var i = y2 * w + x2;
    vals.push(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]);
  }
  // the strongest edges matter (a frame on a plain background is mostly flat):
  // the mean square of the top 2% of responses
  vals = vals.map(Math.abs).sort(function (a, b) { return b - a; });
  var k = Math.max(20, Math.floor(vals.length * 0.02)), s2 = 0;
  for (var j = 0; j < k && j < vals.length; j++) s2 += vals[j] * vals[j];
  return Math.sqrt(s2 / Math.min(k, vals.length));
}

export function checkPhoto(img, naturalW, naturalH) {
  var d = img.data, n = img.width * img.height;
  var sum = 0, sum2 = 0, bright = 0, dark = 0;
  var stride = Math.max(1, Math.floor(n / 60000));
  var count = 0;
  for (var p = 0; p < n; p += stride) {
    var l = luma(d, p * 4);
    sum += l; sum2 += l * l; count++;
    if (l > 250) bright++;
    if (l < 25) dark++;
  }
  var mean = sum / count, std = Math.sqrt(Math.max(0, sum2 / count - mean * mean));
  var sharp = sharpness(img);
  var issues = [];
  var shortSide = Math.min(naturalW || img.width, naturalH || img.height);
  if (shortSide < PHOTO_MIN_SIDE * 0.6) issues.push({ code: 'tooSmall', severity: 'error' });
  else if (shortSide < PHOTO_MIN_SIDE) issues.push({ code: 'small', severity: 'warn' });
  if (mean < 45) issues.push({ code: 'veryDark', severity: 'error' });
  else if (mean < 75) issues.push({ code: 'dark', severity: 'warn' });
  if (bright / count > 0.25) issues.push({ code: 'overexposed', severity: 'warn' });
  if (dark / count > 0.5) issues.push({ code: 'darkBackground', severity: 'info' });
  if (std < 10) issues.push({ code: 'flat', severity: 'warn' });
  if (sharp < 10) issues.push({ code: 'veryBlurry', severity: 'error' });
  else if (sharp < 35) issues.push({ code: 'blurry', severity: 'warn' });
  return {
    ok: !issues.some(function (i) { return i.severity === 'error'; }),
    issues: issues,
    stats: { mean: Math.round(mean), std: Math.round(std), sharpness: Math.round(sharp * 10) / 10, shortSide: shortSide }
  };
}

// The extraction's own findings that mean "retake the photo" (frame-extract.js
// warning codes), as opposed to notes about what was cleaned up.
export var RETAKE_WARNINGS = ['cropped', 'asymmetricStrong', 'lowContrast', 'small', 'wide', 'bridgeRepaired'];
