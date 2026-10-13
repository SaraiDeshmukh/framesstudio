// The photo checks that tell a shop how to retake a frame photo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPNG } from './png.mjs';
import { checkPhoto } from '../photo-quality.js';

const photo = name => readPNG(new URL(name, import.meta.url));
const codes = r => r.issues.map(i => i.code);

function boxBlur(img, r) {
  const w = img.width, h = img.height;
  let src = Float32Array.from(img.data), out = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    for (const horiz of [true, false]) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let s = 0, n = 0;
          for (let k = -r; k <= r; k++) {
            const xx = horiz ? Math.min(w - 1, Math.max(0, x + k)) : x, yy = horiz ? y : Math.min(h - 1, Math.max(0, y + k));
            s += src[(yy * w + xx) * 4 + c]; n++;
          }
          out[(y * w + x) * 4 + c] = s / n;
        }
        out[(y * w + x) * 4 + 3] = 255;
      }
      [src, out] = [out, src];
    }
  }
  return { data: Uint8ClampedArray.from(src), width: w, height: h };
}
function scale(img, f) {
  const d = Uint8ClampedArray.from(img.data);
  for (let i = 0; i < d.length; i += 4) { d[i] *= f; d[i + 1] *= f; d[i + 2] *= f; }
  return { data: d, width: img.width, height: img.height };
}

test('good phone photos of frames pass', () => {
  for (const f of ['fixtures/metal-fullrim-stand.png', 'fixtures/semirimless-stand.png', 'fixtures/translucent-fullrim.png', '../demo/src/demo-gold-round.png']) {
    const r = checkPhoto(photo(f), 1600, 1200);
    assert.ok(r.ok, f);
    assert.deepEqual(codes(r), [], f + ' ' + JSON.stringify(r.stats));
  }
});

test('blurred photos are caught', () => {
  const img = photo('fixtures/metal-fullrim-stand.png');
  assert.ok(codes(checkPhoto(boxBlur(img, 3), 1600, 1200)).includes('blurry'));
  const bad = checkPhoto(boxBlur(img, 7), 1600, 1200);
  assert.ok(codes(bad).includes('veryBlurry'));
  assert.equal(bad.ok, false);
});

test('dark and washed-out photos are caught', () => {
  const img = photo('fixtures/translucent-fullrim.png');
  assert.ok(codes(checkPhoto(scale(img, 0.35), 1600, 1200)).some(c => c === 'dark' || c === 'veryDark'));
  assert.equal(checkPhoto(scale(img, 0.15), 1600, 1200).ok, false);
  const white = { width: 400, height: 200, data: new Uint8ClampedArray(400 * 200 * 4).fill(255) };
  assert.ok(codes(checkPhoto(white, 1600, 1200)).includes('overexposed'));
});

test('photos that are too small are caught', () => {
  const img = photo('fixtures/metal-fullrim-stand.png');
  assert.ok(codes(checkPhoto(img, 900, 600)).includes('small'));
  assert.equal(checkPhoto(img, 600, 300).ok, false);
});
