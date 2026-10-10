// Minimal PNG reader for the tests (8-bit RGB/RGBA, non-interlaced), so the
// test suite needs nothing beyond Node itself.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function readPNG(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + path);
  let off = 8, w = 0, h = 0, colorType = 0, depth = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace || (colorType !== 2 && colorType !== 6)) throw new Error('unsupported PNG format: ' + path);
  const ch = colorType === 6 ? 4 : 3, stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8ClampedArray(w * h * 4), prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      px[(y * w + x) * 4] = cur[x * ch]; px[(y * w + x) * 4 + 1] = cur[x * ch + 1]; px[(y * w + x) * 4 + 2] = cur[x * ch + 2];
      px[(y * w + x) * 4 + 3] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev.set(cur);
  }
  return { data: px, width: w, height: h };
}
