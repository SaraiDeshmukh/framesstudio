// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { OneEuro, PoseSmoother, poseFromLandmarks, frameTransform, drawFrame } from '../tracking.js';

// ---- a tiny recording canvas context that composes transforms like the real one ----
function makeCtx() {
  var m = [1, 0, 0, 1, 0, 0];                 // a b c d e f
  var stack = [];
  function mul(n) {                            // m = m * n  (new op applies to points first)
    m = [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }
  return {
    save() { stack.push(m.slice()); }, restore() { m = stack.pop(); },
    translate(x, y) { mul([1, 0, 0, 1, x, y]); },
    rotate(a) { mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); },
    scale(x, y) { mul([x, 0, 0, y, 0, 0]); },
    drawImage() { this.drawn = m.slice(); },                      // matrix in force when the image was drawn
    apply(p) { var d = this.drawn; return { x: d[0] * p.x + d[2] * p.y + d[4], y: d[1] * p.x + d[3] * p.y + d[5] }; }
  };
}

function landmarks({ a, b, nose = { x: 0.5, y: 0.6 }, c1 = { x: 0.3, y: 0.55 }, c2 = { x: 0.7, y: 0.55 } }) {
  var lm = new Array(478).fill(null).map(function () { return { x: 0.5, y: 0.5 }; });
  lm[468] = a; lm[473] = b; lm[1] = nose; lm[234] = c1; lm[454] = c2;
  return lm;
}

test('pose: midpoint, ipd and roll come from the pupils', () => {
  var p = poseFromLandmarks(landmarks({ a: { x: 0.4, y: 0.45 }, b: { x: 0.6, y: 0.45 } }), 1000, 500);
  assert.ok(Math.abs(p.mid.x - 500) < 1e-6 && Math.abs(p.mid.y - 225) < 1e-6);
  assert.ok(Math.abs(p.ipd - 200) < 1e-6);
  assert.ok(Math.abs(p.roll) < 1e-9);
  assert.ok(p.yaw < 0.05, 'facing the camera => ~0 yaw');
});

test('pose: eye order does not matter (roll stays within +-90 deg)', () => {
  var A = { x: 0.4, y: 0.40 }, B = { x: 0.6, y: 0.5 };
  var p1 = poseFromLandmarks(landmarks({ a: A, b: B }), 1000, 1000);
  var p2 = poseFromLandmarks(landmarks({ a: B, b: A }), 1000, 1000);
  assert.ok(Math.abs(p1.roll - p2.roll) < 1e-9);
  assert.ok(Math.abs(p1.roll) < Math.PI / 2);
});

test('pose: yaw rises when the nose moves toward one cheek, either direction', () => {
  var base = { a: { x: 0.4, y: 0.45 }, b: { x: 0.6, y: 0.45 } };
  var left = poseFromLandmarks(landmarks(Object.assign({ nose: { x: 0.42, y: 0.6 } }, base)), 1000, 1000);
  var right = poseFromLandmarks(landmarks(Object.assign({ nose: { x: 0.58, y: 0.6 } }, base)), 1000, 1000);
  assert.ok(left.yaw > 0.3 && right.yaw > 0.3);
  assert.ok(Math.abs(left.yaw - right.yaw) < 1e-9);
});

test('pose: unusable input returns null', () => {
  assert.equal(poseFromLandmarks(null, 100, 100), null);
  assert.equal(poseFromLandmarks([], 100, 100), null);
  assert.equal(poseFromLandmarks(landmarks({ a: { x: 0.5, y: 0.5 }, b: { x: 0.5, y: 0.5 } }), 100, 100), null);
});

// The core guarantee: whatever the frame photo looks like, its two lens centres must land
// exactly on the two pupils, for any roll / head size, and for tilted frame photos.
test('transform: lens centres land on the pupils (roll, scale, tilted photo)', () => {
  var frames = [
    { p1: { x: 150, y: 200 }, p2: { x: 450, y: 200 } },                  // level
    { p1: { x: 450, y: 230 }, p2: { x: 150, y: 170 } },                  // tilted + tapped in reverse order
  ];
  var poses = [
    { mid: { x: 320, y: 240 }, ipd: 140, roll: 0, yaw: 0 },
    { mid: { x: 300, y: 260 }, ipd: 95, roll: 0.35, yaw: 0 },
    { mid: { x: 400, y: 200 }, ipd: 210, roll: -0.5, yaw: 0.4 },
  ];
  frames.forEach(function (f) {
    poses.forEach(function (pose) {
      var tf = frameTransform(f, pose, 1);
      var ctx = makeCtx(); drawFrame(ctx, {}, tf);
      var a = ctx.apply(f.p1), b = ctx.apply(f.p2);
      var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      assert.ok(Math.hypot(mid.x - pose.mid.x, mid.y - pose.mid.y) < 1e-6, 'midpoint on pupils');
      var d = Math.hypot(b.x - a.x, b.y - a.y);
      assert.ok(Math.abs(d - pose.ipd) < 1e-6, 'lens spacing equals pupil spacing');
      var lineAngle = Math.atan2((b.y - a.y) * Math.sign(b.x - a.x), Math.abs(b.x - a.x));
      assert.ok(Math.abs(lineAngle - pose.roll) < 1e-6, 'lens line follows head roll');
    });
  });
});

test('transform: yaw only stretches height, never width; deadzone and cap hold', () => {
  var f = { p1: { x: 100, y: 100 }, p2: { x: 300, y: 100 } };
  var straight = frameTransform(f, { mid: { x: 0, y: 0 }, ipd: 100, roll: 0, yaw: 0 }, 1);
  var small = frameTransform(f, { mid: { x: 0, y: 0 }, ipd: 100, roll: 0, yaw: 0.08 }, 1);
  var turned = frameTransform(f, { mid: { x: 0, y: 0 }, ipd: 100, roll: 0, yaw: 0.6 }, 1);
  var extreme = frameTransform(f, { mid: { x: 0, y: 0 }, ipd: 100, roll: 0, yaw: 1.4 }, 1);
  assert.equal(straight.sx, turned.sx, 'width follows pupil spacing only');
  assert.equal(straight.sy, small.sy, 'tiny yaw (inside deadzone) is ignored');
  assert.ok(turned.sy > straight.sy, 'turning stretches height to compensate foreshortened width');
  assert.ok(extreme.sy / extreme.sx <= 1 / 0.6 + 1e-9, 'stretch is capped');
});

test('transform: fit slider scales uniformly; bad frame data is rejected', () => {
  var f = { p1: { x: 100, y: 100 }, p2: { x: 300, y: 100 } };
  var pose = { mid: { x: 0, y: 0 }, ipd: 100, roll: 0, yaw: 0 };
  var a = frameTransform(f, pose, 1), b = frameTransform(f, pose, 1.2);
  assert.ok(Math.abs(b.sx / a.sx - 1.2) < 1e-9 && Math.abs(b.sy / a.sy - 1.2) < 1e-9);
  assert.equal(frameTransform({ p1: { x: 5, y: 5 }, p2: { x: 5, y: 5 } }, pose, 1), null);
});

test('smoothing: jitter is strongly reduced while a real move still gets followed', () => {
  var f = new OneEuro(1.2, 0.03, 1.0);
  var seed = 1; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; }
  var rawErr = 0, smErr = 0, n = 0;
  for (var i = 0; i < 300; i++) {                 // still head, +-1.5px sensor noise @ 30fps
    var raw = 320 + rnd() * 3, sm = f.filter(raw, i * 33);
    if (i > 30) { rawErr += Math.abs(raw - 320); smErr += Math.abs(sm - 320); n++; }
  }
  assert.ok(smErr / n < 0.5 * (rawErr / n), 'steady-state jitter at least halved');

  var g = new OneEuro(1.2, 0.03, 1.0), last = 0;  // sudden 200px/s move: must not lag far behind
  for (var t = 0; t < 30; t++) g.filter(100, t * 33);
  for (var k = 0; k < 15; k++) last = g.filter(100 + 200 * (k * 33 / 1000), 1000 + k * 33);
  var target = 100 + 200 * (14 * 33 / 1000);
  assert.ok(target - last < 25, 'lag under fast motion stays small (' + (target - last).toFixed(1) + 'px)');
});

test('PoseSmoother.reset forgets history (no glide from a stale position)', () => {
  var s = new PoseSmoother();
  s.update({ mid: { x: 0, y: 0 }, ipd: 100, roll: 0, yaw: 0 }, 0);
  s.reset();
  var p = s.update({ mid: { x: 500, y: 400 }, ipd: 150, roll: 0.2, yaw: 0.3 }, 5000);
  assert.deepEqual([p.mid.x, p.mid.y, p.ipd], [500, 400, 150]);
});
