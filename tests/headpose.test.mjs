// Run with:  node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateHeadPose, fitSimilarity, matrixFromQuat, quatFromMatrix, applyMatrix, eulerFromMatrix,
  focalLengthPx, unproject, project, canonicalPoint, HeadPoseFilter, CANONICAL_IPD_MM, EYE_CORNERS
} from '../headpose.js';

const DEG = Math.PI / 180;

function rotation(yaw, pitch, roll) {            // Rz(roll) * Ry(yaw) * Rx(pitch), row-major
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp], Rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  const mul = (a, b) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c]));
  return mul(Rz, mul(Ry, Rx));
}

function angleBetween(A, B) {                   // angle of A * B^T
  const tr = [0, 1, 2].reduce((s, i) => s + A[3 * i] * B[3 * i] + A[3 * i + 1] * B[3 * i + 1] + A[3 * i + 2] * B[3 * i + 2], 0);
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
}

// Renders the canonical face through a real pinhole camera, the way MediaPipe
// reports it: x, y normalised image position, z relative depth in x's scale.
function synthLandmarks({ yaw = 0, pitch = 0, roll = 0, T = [0, 0, 550], w = 1280, h = 720, faceScale = 1, zScale = 1, noisePx = 0, seed = 7 }) {
  const f = focalLengthPx(w, h), R = rotation(yaw, pitch, roll);
  const cam = i => { const p = applyMatrix(R, canonicalPoint(i).map(v => v * faceScale)); return [p[0] + T[0], p[1] + T[1], p[2] + T[2]]; };
  const eyeZ = EYE_CORNERS.reduce((s, i) => s + cam(i)[2] / 4, 0);
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const lm = [];
  for (let i = 0; i < 478; i++) {
    const c = cam(Math.min(i, 467));
    const u = w / 2 + f * c[0] / c[2] + rnd() * 2 * noisePx, v = h / 2 + f * c[1] / c[2] + rnd() * 2 * noisePx;
    lm.push({ x: u / w, y: v / h, z: zScale * (c[2] - eyeZ) * f / eyeZ / w });
  }
  return { lm, R, f, w, h, eyeZ, cam };
}

test('canonical model: eye corners straddle the origin and give a ~63 mm pupil distance', () => {
  const m = EYE_CORNERS.map(canonicalPoint).reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]);
  assert.ok(Math.hypot(...m) < 1e-9);
  assert.ok(Math.abs(CANONICAL_IPD_MM - 63) < 0.5, 'ipd ' + CANONICAL_IPD_MM);
  // image-style axes: nose tip is towards the camera (negative z), chin is down (positive y)
  assert.ok(canonicalPoint(1)[2] < -30 && canonicalPoint(152)[1] > 80);
  assert.ok(canonicalPoint(33)[0] < 0 && canonicalPoint(263)[0] > 0, "landmark 33 is on the image left");
});

test('quaternion <-> matrix round trip', () => {
  for (const [y, p, r] of [[0, 0, 0], [0.4, -0.2, 0.3], [2.5, 0.1, -1.2], [-1.5, 1.2, 3.0]]) {
    const R = rotation(y, p, r);
    assert.ok(angleBetween(R, matrixFromQuat(quatFromMatrix(R))) < 1e-6);
  }
});

test('fitSimilarity recovers an exact similarity transform', () => {
  const src = [[0, 0, 0], [10, 0, 0], [0, 20, 0], [0, 0, 30], [5, -7, 12], [-9, 4, -3]];
  const R = rotation(0.7, -0.3, 0.2), s = 2.7, t = [100, -40, 12];
  const dst = src.map(p => { const q = applyMatrix(R, p); return [s * q[0] + t[0], s * q[1] + t[1], s * q[2] + t[2]]; });
  const fit = fitSimilarity(src, dst);
  assert.ok(angleBetween(fit.R, R) < 1e-6 && Math.abs(fit.s - s) < 1e-9 && fit.rms < 1e-6);
});

test('unproject/project are inverses and leave the reference depth unchanged', () => {
  const cam = { f: 1000, zRef: 12, cx: 640, cy: 360 };
  for (const [X, Y, Z] of [[100, 50, 12], [900, 600, -80], [300, 200, 140]]) {
    const P = unproject(X, Y, Z, cam), back = project(P, cam);
    assert.ok(Math.abs(back[0] - X) < 1e-9 && Math.abs(back[1] - Y) < 1e-9);
    if (Z === 12) assert.ok(Math.abs(P[0] - X) < 1e-9 && Math.abs(P[1] - Y) < 1e-9);
  }
});

test('head pose: recovers yaw / pitch / roll and scale through real perspective', () => {
  const cases = [
    { yaw: 0, pitch: 0, roll: 0 },
    { yaw: 30 * DEG, pitch: 0, roll: 0 },
    { yaw: -45 * DEG, pitch: 10 * DEG, roll: 5 * DEG },
    { yaw: 15 * DEG, pitch: -15 * DEG, roll: -20 * DEG, T: [120, -60, 420] },   // off-centre and close
    { yaw: 0, pitch: 0, roll: 0, T: [-150, 80, 700], faceScale: 0.92 },        // smaller face, far, off-centre
  ];
  for (const c of cases) {
    const s = synthLandmarks(c);
    const pose = estimateHeadPose(s.lm, s.w, s.h);
    const err = angleBetween(pose.R, s.R) / DEG;
    assert.ok(err < 0.2, 'rotation error ' + err.toFixed(3) + ' deg for ' + JSON.stringify(c));
    const expectS = s.f / s.eyeZ * (c.faceScale || 1);
    assert.ok(Math.abs(pose.s / expectS - 1) < 0.005, 'scale');
    // the head origin (3D eye-corner midpoint) projects where the real one does
    const mid3 = EYE_CORNERS.reduce((a, i) => { const c = s.cam(i); return [a[0] + c[0] / 4, a[1] + c[1] / 4, a[2] + c[2] / 4]; }, [0, 0, 0]);
    const eye = [s.w / 2 + s.f * mid3[0] / mid3[2], s.h / 2 + s.f * mid3[1] / mid3[2]];
    const pa = project(pose.anchor, pose.cam);
    assert.ok(Math.hypot(pa[0] - eye[0], pa[1] - eye[1]) < 0.5);
    assert.ok(pose.rmsMm < 0.5, 'clean data fits almost exactly');
  }
});

test('head pose: stays accurate with landmark noise and MediaPipe-style depth compression', () => {
  const s = synthLandmarks({ yaw: 25 * DEG, pitch: 8 * DEG, roll: -6 * DEG, noisePx: 1.5, zScale: 0.88 });
  const pose = estimateHeadPose(s.lm, s.w, s.h);
  const err = angleBetween(pose.R, s.R) / DEG;
  assert.ok(err < 4, 'rotation error ' + err.toFixed(2) + ' deg');
  const e = eulerFromMatrix(pose.R), t = eulerFromMatrix(s.R);
  assert.ok(Math.abs(e.roll - t.roll) / DEG < 1.5, 'roll is tight');
});

test('head pose: rejects unusable input', () => {
  assert.equal(estimateHeadPose(null, 640, 480), null);
  assert.equal(estimateHeadPose([], 640, 480), null);
  const s = synthLandmarks({});
  assert.equal(estimateHeadPose(s.lm, 0, 480), null);
});

test('pose filter: removes jitter, follows real turns, and keeps quaternion sign continuous', () => {
  const f = new HeadPoseFilter();
  let rawErr = 0, smErr = 0, n = 0;
  for (let i = 0; i < 120; i++) {
    const s = synthLandmarks({ yaw: 10 * DEG, noisePx: 2, seed: 11 + i });
    const raw = estimateHeadPose(s.lm, s.w, s.h);
    const sm = f.update(raw, i * 33);
    if (i > 20) { rawErr += angleBetween(raw.R, s.R); smErr += angleBetween(sm.R, s.R); n++; }
  }
  assert.ok(smErr / n < 0.6 * rawErr / n, 'rotation jitter reduced');
  // a sign flip of the input quaternion is the same rotation and must not cause a jump
  const s2 = synthLandmarks({ yaw: 10 * DEG });
  const p = estimateHeadPose(s2.lm, s2.w, s2.h);
  const flipped = Object.assign({}, p, { q: p.q.map(v => -v) });
  const a = f.update(p, 5000), b = f.update(flipped, 5033);
  assert.ok(angleBetween(a.R, b.R) < 0.5 * DEG);
  // a real 40 degree turn is followed within a few frames
  f.reset();
  let last;
  for (let i = 0; i < 10; i++) last = f.update(estimateHeadPose(s2.lm, s2.w, s2.h), i * 33);
  const turned = synthLandmarks({ yaw: 50 * DEG });
  for (let i = 0; i < 12; i++) last = f.update(estimateHeadPose(turned.lm, turned.w, turned.h), 330 + i * 33);
  assert.ok(angleBetween(last.R, turned.R) / DEG < 5, 'lag after 0.4 s: ' + (angleBetween(last.R, turned.R) / DEG).toFixed(1));
});
