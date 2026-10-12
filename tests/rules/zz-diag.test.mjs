// Temporary diagnostics: which parts of a complete product the rules accept.
import { test, before, after } from 'node:test';
import { doc, setDoc } from 'firebase/firestore';
import { makeEnv, seed, A, VERIFIED, draft, complete, pricing, img } from './helpers.mjs';

var env;
before(async function () { env = await makeEnv(); await seed(env); });
after(async function () { if (env) await env.cleanup(); });

test('diag', async function () {
  var db = env.authenticatedContext(A, VERIFIED).firestore();
  var cases = {
    tags: draft(A, { tags: { shape: 'rectangle', color: 'black', gender: null, rim: 'fullrim', free: [] } }),
    tagsNoNull: draft(A, { tags: { shape: 'rectangle', color: 'black', rim: 'fullrim', free: [] } }),
    size: draft(A, { size: { eye: 52, bridge: 18, temple: 140 } }),
    avail: draft(A, { availability: 'in_stock' }),
    many: draft(A, { sku: 'BLK-52', brand: 'House', frameType: 'eyeglasses', material: 'Acetate', description: 'Everyday frame.', link: 'https://example.com/p/blk-52' }),
    priceImg: draft(A, { pricing: pricing(), images: { thumb: img(A, 'd7', 'thumb-1.webp') } }),
    completeDraft: complete(A, 'd8'),
    completePubNo: complete(A, 'd9', { status: 'published', public: false, pricing: pricing({ confirmed: false }) }),
    completePubYes: complete(A, 'd10', { status: 'published', public: true })
  };
  var i = 0;
  for (var name of Object.keys(cases)) {
    i++;
    var id = 'd' + i;
    var data = cases[name];
    if (data.images && data.images.thumb) data.images = { thumb: img(A, id, 'thumb-1.webp') };
    try { await setDoc(doc(db, 'products', id), data); console.log('# DIAG ' + name + ' OK'); }
    catch (e) { console.log('# DIAG ' + name + ' DENIED ' + String(e.message).replace(/\s+/g, ' ').slice(0, 400)); }
  }
});
