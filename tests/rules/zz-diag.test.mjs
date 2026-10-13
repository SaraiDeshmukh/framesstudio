// Temporary: measures how close product writes come to Firestore's
// 1,000-expression limit, with variants of the rules. Removed after tuning.
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { A, VERIFIED, complete, pricing, img } from './helpers.mjs';

var base = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
var fsHost = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
var envs = [];
after(async function () { for (var e of envs) await e.cleanup(); });

function padFn(n) {
  var ten = Array(10).fill('1 == 1').join(' && ');
  var hundred = Array(10).fill('p10()').join(' && ');
  var k = Math.round(n / 100);
  return '    function p10() { return ' + ten + '; }\n    function p100() { return ' + hundred + '; }\n'
    + '    function pad() { return ' + (k ? Array(k).fill('p100()').join(' && ') : 'true') + '; }\n';
}
function variant(name, edit, padN) {
  var r = edit ? edit(base) : base;
  r = r.replace('    // ---------- products ----------', padFn(padN || 0) + '    // ---------- products ----------');
  r = r.replace("&& p.public == shouldBePublic(p);\n    }\n    // The retailer", "&& p.public == shouldBePublic(p) && pad();\n    }\n    // The retailer");
  r = r.replace("&& p.public == shouldBePublic(p);\n    }\n\n    match /products", "&& p.public == shouldBePublic(p) && pad();\n    }\n\n    match /products");
  return { name: name, rules: r };
}

async function envFor(v, i) {
  var env = await initializeTestEnvironment({ projectId: 'demo-diag-' + i, firestore: { rules: v.rules, host: fsHost[0], port: +fsHost[1] } });
  envs.push(env);
  await env.withSecurityRulesDisabled(async function (ctx) {
    var db = ctx.firestore();
    await setDoc(doc(db, 'config', 'legal'), { retailerTerms: { version: '1.0' }, privacy: { version: '1.0' } });
    await setDoc(doc(db, 'shops', A), { name: 'Shop A', city: 'Amravati', status: 'approved', ownerUid: A });
    await setDoc(doc(db, 'acceptances', A + '_retailerTerms_1.0'), { uid: A, doc: 'retailerTerms', version: '1.0' });
  });
  return env;
}

function imgs(id, n) {
  var all = { thumb: img(A, id, 'thumb-1.webp'), cutout: img(A, id, 'cutout-1.png'), manifest: img(A, id, 'asset-1.json'),
    source: { path: 'shops/' + A + '/products/' + id + '/source/source-1.jpg', w: 1600, h: 1200, bytes: 300000 }, side: img(A, id, 'side-1.png') };
  var out = {}; Object.keys(all).slice(0, n).forEach(function (k) { out[k] = all[k]; }); return out;
}
var TRYON = { status: 'ready', level: '3d', prepared: 'auto', quality: 0.9, rimType: 'full', translucent: false, warnings: ['a', 'b'], hasSide: true, updatedAt: serverTimestamp() };

async function attempt(label, fn) {
  try { await fn(); console.log('# DIAG ' + label + ' OK'); }
  catch (e) { var m = String(e.message); console.log('# DIAG ' + label + ' ' + (/1000 expressions/.test(m) ? 'LIMIT' : 'DENIED ' + m.replace(/\s+/g, ' ').slice(0, 160))); }
}

test('diag', async function () {
  var variants = [
    variant('R0'),
    variant('R0pad100', null, 100),
    variant('R0pad200', null, 200),
    variant('R0pad400', null, 400),
    variant('noUrlRe', function (r) { return r.replace(/&& img\.url\.matches\('[^\n]*'\)\)\)/, '))'); }),
    variant('noPathRe', function (r) { return r.replace("&& img.path.matches(base + '(assets|source)/[A-Za-z0-9._-]{1,80}')", ''); }),
    variant('noImages', function (r) { return r.replace("(!('images' in ks) || imagesOk(p.images, 'shops/' + p.shopId + '/products/' + productId + '/'))", 'true'); }),
    variant('noTryOn', function (r) { return r.replace("(!('tryOn' in ks) || tryOnOk(p.tryOn))", 'true'); }),
    variant('noPublishable', function (r) { return r.replace('function shouldBePublic(p) { return publishable(p) &&', 'function shouldBePublic(p) { return p.status == "published" &&'); })
  ];
  for (var i = 0; i < variants.length; i++) {
    var v = variants[i];
    var env = await envFor(v, i);
    var db = env.authenticatedContext(A, VERIFIED).firestore();
    for (var n of [1, 3, 5]) {
      var id = 'c' + n;
      await attempt(v.name + ' create images=' + n, function () {
        return setDoc(doc(db, 'products', id), complete(A, id, { status: 'published', public: true, tryOn: n > 1 ? TRYON : { status: 'none' }, images: imgs(id, n) }));
      });
    }
    await attempt(v.name + ' create draft', function () { return setDoc(doc(db, 'products', 'd1'), (function () { var x = complete(A, 'd1', { pricing: pricing() }); delete x.images; return x; })()); });
    await attempt(v.name + ' update images=5', function () {
      return updateDoc(doc(db, 'products', 'd1'), { images: imgs('d1', 5), tryOn: TRYON, status: 'published', public: true, assetBytes: 900000, updatedAt: serverTimestamp() });
    });
  }
});
