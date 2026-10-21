// Test data for the browser tests: shops with many published frames, built
// from the six demo frames' real pictures and fitting data, stored the way the
// free-plan version stores them (thumbnail and fitting data inline on the
// product, cut-out in a productFiles document), plus each shop's catalogue
// index. Timestamps are written as {__ts: [seconds, nanos]}.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';
import { DEMO_FRAMES } from '../../demo/catalog.js';
import { indexItem } from '../../catalogue-index.js';

const SHAPES = ['round', 'square', 'catseye', 'aviator', 'browline', 'rectangle', 'oval'];
const COLORS = ['black', 'tortoise', 'gold', 'silver', 'clear', 'navy', 'red'];
const GENDERS = ['womens', 'mens', 'unisex', 'kids'];
const RIMS = ['fullrim', 'semirimless', 'rimless'];

function b64(file) { return fs.readFileSync(path.join(ROOT, file)).toString('base64'); }
function ts(ms) { return { __ts: [Math.floor(ms / 1000), (ms % 1000) * 1e6] }; }

export function frameAt(i) {
  return {
    shape: SHAPES[i % SHAPES.length], color: COLORS[(i * 3) % COLORS.length],
    gender: GENDERS[i % GENDERS.length], rim: RIMS[i % RIMS.length],
    price: 150000 + ((i * 7919) % 60) * 5000
  };
}

// shops: { id: { name, count, index (bool), status } }
export function buildSeed(shops) {
  const seed = {};
  const t0 = Date.UTC(2026, 9, 1);
  seed['admins/admin1'] = { email: 'admin@example.com' };
  seed['config/platform'] = { applicationsOpen: true, updatedAt: ts(t0), updatedBy: 'admin' };
  seed['config/demo'] = { hidden: [], updatedAt: ts(t0), updatedBy: 'admin' };
  seed['config/legal'] = { retailerTerms: { version: '1.0', date: '2026-10-12' }, privacy: { version: '1.0', date: '2026-10-12' }, updatedAt: ts(t0), updatedBy: 'admin' };
  // the demo frames' pictures, one cut-out document each, shared by the test products
  const assets = DEMO_FRAMES.map((f, k) => {
    const fid = 'demo' + k + '__cutout-1';
    seed['productFiles/' + fid] = { shopId: 'x', productId: 'demo' + k, kind: 'assets', type: 'image/png', data: 'data:image/png;base64,' + b64(f.cutout), bytes: 1, createdAt: ts(t0) };
    return {
      thumb: 'data:image/png;base64,' + b64(f.thumb),
      manifest: 'data:application/json;base64,' + Buffer.from(JSON.stringify(f.manifest)).toString('base64'),
      fid
    };
  });
  let n = 0;
  for (const [shopId, s] of Object.entries(shops)) {
    seed['shops/' + shopId] = { name: s.name, city: 'Amravati', phone: '+91 98765 43210', status: s.status || 'approved', ownerUid: shopId, createdAt: ts(t0 + (n++) * 1000), updatedAt: ts(t0) };
    seed['shopPrivate/' + shopId] = { ownerName: 'Owner', createdAt: ts(t0), updatedAt: ts(t0) };
    seed['acceptances/' + shopId + '_retailerTerms_1.0'] = { uid: shopId, doc: 'retailerTerms', version: '1.0', acceptedAt: ts(t0) };
    seed['acceptances/' + shopId + '_privacy_1.0'] = { uid: shopId, doc: 'privacy', version: '1.0', acceptedAt: ts(t0) };
    const items = {};
    for (let i = 0; i < s.count; i++) {
      const id = shopId + 'p' + String(i).padStart(3, '0');
      const a = assets[i % assets.length], f = frameAt(i);
      const created = t0 + 86400000 + i * 60000, updated = created + 1000;
      const isPublic = !(s.hidden || []).includes(i);
      const p = {
        shopId, name: s.name + ' frame ' + String(i + 1).padStart(3, '0'), sku: shopId.toUpperCase() + '-' + i,
        status: 'published', moderation: { state: 'ok' }, public: isPublic, availability: 'in_stock', frameType: 'eyeglasses',
        description: 'Test frame number ' + (i + 1) + ' of ' + s.name + '.',
        tags: { shape: f.shape, color: f.color, gender: f.gender, rim: f.rim, free: i % 5 === 0 ? ['lightweight'] : [] },
        size: { eye: 48 + (i % 8), bridge: 16 + (i % 5), temple: 140 },
        pricing: { pricePaise: f.price, currency: 'INR', taxMode: 'inclusive', taxRate: 18, confirmed: true, updatedAt: ts(created) },
        tryOn: { status: 'ready', level: '3d', prepared: 'auto', rimType: 'full', translucent: false, hasSide: false },
        images: {
          thumb: { path: 'shops/' + shopId + '/products/' + id + '/assets/thumb-1.png', w: 260, h: 260, bytes: 9000, data: a.thumb },
          cutout: { path: 'shops/' + shopId + '/products/' + id + '/assets/cutout-1.png', bytes: 100000, fid: a.fid },
          manifest: { path: 'shops/' + shopId + '/products/' + id + '/assets/asset-1.json', bytes: 3200, data: a.manifest }
        },
        assetBytes: 112200, createdAt: ts(created), updatedAt: ts(updated)
      };
      seed['products/' + id] = p;
      if (s.index !== false && (isPublic || s.staleIndex)) items[id] = indexItem(p, ts(created), ts(updated));
    }
    if (s.index !== false) seed['catalogues/' + shopId] = { v: 1, items, updatedAt: ts(t0) };
  }
  return seed;
}
