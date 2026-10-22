// Tries the site's frame extraction with several settings on cleaned photos
// and keeps the best clean result per frame (used to prepare a shop's photos).
//   node scripts/sweep-extract.mjs <cleanDir> <meta.json> <outDir> <fid,fid,...>
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from '../tests/png.mjs';
import { extractFrame } from '../frame-extract.js';
var [dir, metaPath, outDir, list] = process.argv.slice(2);
var meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
list.split(',').forEach(function (fid) {
  var m = meta[fid], best = null, tried = 0;
  ['v1', 'v0'].forEach(function (v) {
    var file = path.join(dir, fid + '-' + v + '.png');
    if (!fs.existsSync(file)) return;
    var img = readPNG(file);
    [1, 0.75, 1.35, 0.55, 1.8].forEach(function (sens) {
      ['auto', m.rim].filter(function (x, i, a) { return x && a.indexOf(x) === i; }).forEach(function (rim) {
        ['auto'].concat(m.clear ? [true] : []).forEach(function (tr) {
          tried++;
          var r;
          try { r = extractFrame(img, { sensitivity: sens, rimType: rim, translucent: tr }); } catch (e) { return; }
          if (!r.ok) return;
          var errs = r.warnings.filter(function (w) { return w.severity === 'error'; }).length;
          var score = r.quality - errs * 0.5;
          if (!best || score > best.score) best = { score: score, quality: r.quality, errs: errs, variant: v, sens: sens, rim: rim, tr: tr, warnings: r.warnings.map(function (w) { return w.severity[0] + ':' + w.code; }) };
        });
      });
    });
  });
  fs.writeFileSync(path.join(outDir, fid + '.best.json'), JSON.stringify(best));
  console.log(fid, tried, best ? ('q=' + best.quality + ' errs=' + best.errs + ' ' + best.variant + ' s=' + best.sens + ' ' + best.rim + ' tr=' + best.tr + ' ' + best.warnings.filter(function (w) { return w[0] !== 'i'; }).join(',')) : 'none');
});
