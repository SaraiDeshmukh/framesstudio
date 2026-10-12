// The six public demo frames: each has its own record and try-on asset, the
// assets really come out of the site's extraction pipeline, and each one
// builds a 3D try-on model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readPNG } from './png.mjs';
import { DEMO_FRAMES } from '../demo/catalog.js';
import { extractFrame } from '../frame-extract.js';
import { analyseFrame } from '../glasses-model.js';
import { manifestOk, alphaBoxRGBA } from '../asset-build.js';

const root = new URL('../', import.meta.url);

test('six demo frames in visibly different styles, each its own product with its own asset', () => {
  assert.equal(DEMO_FRAMES.length, 6);
  const ids = new Set(DEMO_FRAMES.map(f => f.id));
  assert.equal(ids.size, 6);
  const looks = new Set(DEMO_FRAMES.map(f => f.tags.shape + '/' + f.tags.color + '/' + f.tags.rim));
  assert.equal(looks.size, 6, 'no two demo frames look the same');
  const shapes = DEMO_FRAMES.map(f => f.tags.shape);
  for (const s of ['rectangle', 'round', 'square', 'catseye', 'browline']) assert.ok(shapes.includes(s), 'has a ' + s);
  assert.ok(DEMO_FRAMES.some(f => f.translucent), 'one is translucent');
  assert.ok(DEMO_FRAMES.some(f => f.tags.color === 'tortoise'), 'one is tortoiseshell');
  assert.ok(DEMO_FRAMES.some(f => f.rimType === 'semi'), 'one is semi-rimless');
  assert.ok(DEMO_FRAMES.some(f => f.material === 'Metal' && f.tags.shape === 'rectangle'), 'one is a thin metal rectangle');
  const cutouts = new Set();
  for (const f of DEMO_FRAMES) {
    assert.equal(f.demo, true, f.id + ' is marked as a demo');
    assert.ok(f.id.startsWith('demo-'), 'demo ids never collide with shop product ids');
    assert.ok(fs.existsSync(new URL(f.thumb, root)), f.thumb);
    assert.ok(fs.existsSync(new URL(f.cutout, root)), f.cutout);
    assert.ok(manifestOk(f.manifest), f.id + ' manifest');
    assert.equal(f.level, '3d');
    cutouts.add(fs.readFileSync(new URL(f.cutout, root)).toString('base64').slice(0, 2000));
  }
  assert.equal(cutouts.size, 6, 'every frame has a different try-on asset');
});

test('the committed assets are what the real extraction pipeline produces from the demo photos', () => {
  for (const f of DEMO_FRAMES) {
    const photo = readPNG(new URL('demo/src/' + f.id + '.png', root));
    const r = extractFrame(photo, {});
    assert.ok(r.ok, f.id + ': ' + r.reason);
    assert.equal(r.rimType, f.rimType, f.id + ' rim type');
    assert.equal(r.translucent, f.translucent, f.id + ' translucency');
    assert.equal(r.representation.level, f.level, f.id + ' 3D/2D');
    assert.ok(!r.warnings.some(w => w.severity === 'error'), f.id + ' has no serious problems');
    const box = alphaBoxRGBA(r.cutout.data, r.width, r.height);
    const p1 = { x: r.landmarks.lensL.x - box.x, y: r.landmarks.lensL.y - box.y };
    assert.ok(Math.hypot(p1.x - f.manifest.p1.x, p1.y - f.manifest.p1.y) < 1.5, f.id + ' lens centre matches the stored asset');
    const cut = readPNG(new URL(f.cutout, root));
    assert.equal(cut.width, f.manifest.imgW);
    assert.equal(cut.height, f.manifest.imgH);
  }
});

test('every demo frame builds a 3D try-on model, at a consistent real size', () => {
  for (const f of DEMO_FRAMES) {
    const cut = readPNG(new URL(f.cutout, root));
    const m = analyseFrame(cut, f.manifest.p1, f.manifest.p2, { tags: f.tags, size: f.size, fit: f.manifest.fit });
    assert.ok(m.ok, f.id + ': ' + m.reason);
    // the photos were drawn at 6 px per mm: lens centres are (eye + bridge) mm apart
    const px = Math.hypot(f.manifest.p2.x - f.manifest.p1.x, f.manifest.p2.y - f.manifest.p1.y);
    const mm = f.size.eye + f.size.bridge;
    assert.ok(Math.abs(px / mm - 6) < 0.25, f.id + ' scale ' + (px / mm).toFixed(2) + ' px/mm');
  }
});
