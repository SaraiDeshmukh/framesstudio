// Minimal PNG writer (8-bit RGBA), so the demo build needs nothing beyond Node.
// Picks the best row filter per row and deflates at level 9.
import zlib from 'node:zlib';

var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  var c = 0xffffffff;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  var td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function paeth(a, b, c) {
  var p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function encodePNG(img) {
  var w = img.width, h = img.height, d = img.data, stride = w * 4;
  var raw = Buffer.alloc((stride + 1) * h);
  var prev = new Uint8Array(stride), cur = new Uint8Array(stride), cand = [0, 1, 2, 3, 4].map(function () { return new Uint8Array(stride); });
  for (var y = 0; y < h; y++) {
    for (var i = 0; i < stride; i++) cur[i] = d[y * stride + i];
    var best = 0, bestSum = Infinity;
    for (var f = 0; f < 5; f++) {
      var out = cand[f], sum = 0;
      for (var j = 0; j < stride; j++) {
        var a = j >= 4 ? cur[j - 4] : 0, b = prev[j], c = j >= 4 ? prev[j - 4] : 0, v = cur[j];
        var r = f === 0 ? v : f === 1 ? v - a : f === 2 ? v - b : f === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, c);
        out[j] = r & 255;
        sum += out[j] < 128 ? out[j] : 256 - out[j];
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    raw.set(cand[best], y * (stride + 1) + 1);
    prev.set(cur);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
