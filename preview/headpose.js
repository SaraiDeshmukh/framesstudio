// 3D head pose for the AR try-on. No DOM, no network: unit-tested in Node
// (tests/headpose.test.mjs).
//
// What it does, per video frame:
//   1. Takes MediaPipe's 478 face landmarks (normalised x, y and relative depth z).
//   2. "Unprojects" them through a pinhole camera so each point sits at a real
//      depth in front of the camera, while still projecting exactly onto the
//      pixel MediaPipe reported. (Units are video pixels measured at the depth
//      of the eyes.)
//   3. Fits MediaPipe's canonical 3D face model to the rigid parts of that face
//      (forehead, nose, eye corners, cheekbones, upper face outline - not the
//      mouth, jaw or eyebrows, which move with expressions) with a similarity
//      transform: rotation R, uniform scale s (pixels per canonical mm) and
//      translation t. The rotation is the true head yaw/pitch/roll.
//   4. Anchors the head frame on the detected eye corners (head-locked, unlike
//      the pupils, which move when the customer glances sideways).
//
// Head frame (where the glasses are modelled): origin at the midpoint of the four
// eye corners, millimetres, x towards image right, y down, z into the head
// (away from the camera). This is MediaPipe's canonical model rotated 180 deg
// about x, so it is still a right-handed frame.

import { CANONICAL_VERTICES } from './face-geometry.js';
import { OneEuro } from './tracking.js';

export var EYE_CORNERS = [33, 133, 362, 263];
export var DEFAULT_DIAG_FOV_DEG = 72;     // typical webcam / phone front camera
export var CANONICAL_IPD_MM = 0;          // filled in below

// Rigid landmarks used for the fit, with weights.
var RIGID = [
  // eye corners (canthi) - weighted up, they define where the lenses go
  [33, 3], [133, 3], [362, 3], [263, 3],
  // nose bridge and ridge
  [168, 2], [6, 2], [197, 1.5], [195, 1], [5, 1], [4, 1], [1, 0.7],
  // nose wings
  [98, 1], [327, 1],
  // forehead
  [10, 1], [151, 1], [9, 1.5], [8, 1.5], [109, 1], [338, 1], [67, 1], [297, 1], [108, 1], [337, 1],
  // cheekbones / under the eyes
  [116, 1], [345, 1], [117, 1], [346, 1], [118, 1], [347, 1], [50, 1], [280, 1], [101, 1], [330, 1],
  // upper face outline towards the ears
  [127, 1], [356, 1], [234, 1], [454, 1], [162, 1], [389, 1], [21, 1], [251, 1], [54, 1], [284, 1]
];

function canonicalRaw(i) {
  return [CANONICAL_VERTICES[3 * i] * 10, -CANONICAL_VERTICES[3 * i + 1] * 10, -CANONICAL_VERTICES[3 * i + 2] * 10];
}

var EYE_MID = (function () {
  var m = [0, 0, 0];
  EYE_CORNERS.forEach(function (i) { var p = canonicalRaw(i); m[0] += p[0] / 4; m[1] += p[1] / 4; m[2] += p[2] / 4; });
  return m;
})();

// Canonical landmark i in the head frame (mm, origin at the eye-corner midpoint).
export function canonicalPoint(i) {
  var p = canonicalRaw(i);
  return [p[0] - EYE_MID[0], p[1] - EYE_MID[1], p[2] - EYE_MID[2]];
}

CANONICAL_IPD_MM = (function () {
  var a = canonicalPoint(33), b = canonicalPoint(133), c = canonicalPoint(362), d = canonicalPoint(263);
  return Math.abs((c[0] + d[0]) / 2 - (a[0] + b[0]) / 2);
})();

var RIGID_IDS = RIGID.map(function (r) { return r[0]; });
var RIGID_W = RIGID.map(function (r) { return r[1]; });
var RIGID_SRC = RIGID_IDS.map(canonicalPoint);

// ---------- small linear algebra ----------

// Eigen-decomposition of a symmetric 4x4 matrix (cyclic Jacobi). Returns the
// eigenvector of the largest eigenvalue.
function largestEigenvector4(A) {
  var a = A.map(function (r) { return r.slice(); });
  var v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (var sweep = 0; sweep < 30; sweep++) {
    var off = 0;
    for (var p = 0; p < 4; p++) for (var q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (p = 0; p < 4; p++) {
      for (q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        var theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        var t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        var c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (var k = 0; k < 4; k++) {
          var akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (k = 0; k < 4; k++) {
          var apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (k = 0; k < 4; k++) {
          var vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  var best = 0;
  for (var i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

// Quaternions are [w, x, y, z]. Rotation matrices are row-major arrays of 9.
export function matrixFromQuat(q) {
  var w = q[0], x = q[1], y = q[2], z = q[3];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
  ];
}

export function quatFromMatrix(m) {
  var tr = m[0] + m[4] + m[8], w, x, y, z, s;
  if (tr > 0) {
    s = Math.sqrt(tr + 1) * 2; w = s / 4;
    x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2; w = (m[7] - m[5]) / s;
    x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2; w = (m[2] - m[6]) / s;
    x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2; w = (m[3] - m[1]) / s;
    x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  var n = Math.hypot(w, x, y, z);
  return [w / n, x / n, y / n, z / n];
}

export function applyMatrix(m, p) {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
}

// Yaw (turn left/right, about the head's vertical axis), pitch (nod) and roll
// (tilt), in radians, from a head-to-world rotation. Used for status messages
// and tests; the renderer uses the full rotation.
export function eulerFromMatrix(m) {
  // R = Rz(roll) * Ry(yaw) * Rx(pitch) with the head axes above
  var yaw = Math.asin(Math.max(-1, Math.min(1, -m[6])));
  var pitch = Math.atan2(m[7], m[8]);
  var roll = Math.atan2(m[3], m[0]);
  return { yaw: yaw, pitch: pitch, roll: roll };
}

// Weighted least-squares similarity transform dst ~= s * R * src + t
// (Horn 1987, closed form via quaternions; scale as in Umeyama 1991).
export function fitSimilarity(src, dst, weights) {
  var n = src.length, W = 0, ms = [0, 0, 0], md = [0, 0, 0], i, k;
  for (i = 0; i < n; i++) {
    var w = weights ? weights[i] : 1; W += w;
    for (k = 0; k < 3; k++) { ms[k] += w * src[i][k]; md[k] += w * dst[i][k]; }
  }
  for (k = 0; k < 3; k++) { ms[k] /= W; md[k] /= W; }
  var S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], ss = 0;
  for (i = 0; i < n; i++) {
    var wi = weights ? weights[i] : 1;
    var a = [src[i][0] - ms[0], src[i][1] - ms[1], src[i][2] - ms[2]];
    var b = [dst[i][0] - md[0], dst[i][1] - md[1], dst[i][2] - md[2]];
    for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) S[r][c] += wi * a[r] * b[c];
    ss += wi * (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  }
  var Sxx = S[0][0], Sxy = S[0][1], Sxz = S[0][2], Syx = S[1][0], Syy = S[1][1], Syz = S[1][2], Szx = S[2][0], Szy = S[2][1], Szz = S[2][2];
  var N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]
  ];
  var q = largestEigenvector4(N);
  var nq = Math.hypot(q[0], q[1], q[2], q[3]);
  q = [q[0] / nq, q[1] / nq, q[2] / nq, q[3] / nq];
  if (q[0] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
  var R = matrixFromQuat(q);
  var num = 0;
  for (i = 0; i < n; i++) {
    var wj = weights ? weights[i] : 1;
    var ra = applyMatrix(R, [src[i][0] - ms[0], src[i][1] - ms[1], src[i][2] - ms[2]]);
    num += wj * (ra[0] * (dst[i][0] - md[0]) + ra[1] * (dst[i][1] - md[1]) + ra[2] * (dst[i][2] - md[2]));
  }
  var s = ss > 0 ? num / ss : 0;
  var rms0 = applyMatrix(R, ms);
  var t = [md[0] - s * rms0[0], md[1] - s * rms0[1], md[2] - s * rms0[2]];
  var err = 0;
  for (i = 0; i < n; i++) {
    var p = applyMatrix(R, src[i]);
    var e = [s * p[0] + t[0] - dst[i][0], s * p[1] + t[1] - dst[i][1], s * p[2] + t[2] - dst[i][2]];
    err += (weights ? weights[i] : 1) * (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
  }
  return { R: R, q: q, s: s, t: t, rms: Math.sqrt(err / W) };
}

// ---------- camera ----------

// Focal length in pixels for an assumed diagonal field of view. The real value
// is unknown in a browser; it only changes how strongly the temples foreshorten,
// not where the frame front lands (that is pinned to the landmarks).
export function focalLengthPx(w, h, diagFovDeg) {
  var fov = (diagFovDeg || DEFAULT_DIAG_FOV_DEG) * Math.PI / 180;
  return Math.hypot(w, h) / 2 / Math.tan(fov / 2);
}

// Landmark in image pixels (x*w, y*h, z*w) -> point in front of a pinhole camera
// at (w/2, h/2, zRef - f) looking along +z, chosen so it projects back onto the
// same pixel. Points at depth zRef are unchanged.
export function unproject(X, Y, Z, cam) {
  var d = Math.max(0.2, (cam.f + Z - cam.zRef) / cam.f);
  return [cam.cx + (X - cam.cx) * d, cam.cy + (Y - cam.cy) * d, Z];
}

export function project(P, cam) {
  var d = Math.max(1e-6, (P[2] - (cam.zRef - cam.f)) / cam.f);
  return [cam.cx + (P[0] - cam.cx) / d, cam.cy + (P[1] - cam.cy) / d];
}

// Writes all 468 face-mesh landmarks, unprojected, into out (Float32Array(468*3)).
export function unprojectMesh(lm, w, h, cam, out, insetPx) {
  var n = Math.min(468, lm.length);
  for (var i = 0; i < n; i++) {
    var Z = lm[i].z * w + (insetPx || 0);
    var p = unproject(lm[i].x * w, lm[i].y * h, Z, cam);
    out[3 * i] = p[0]; out[3 * i + 1] = p[1]; out[3 * i + 2] = p[2];
  }
  return out;
}

// ---------- pose ----------

// lm: MediaPipe landmarks (>= 468). w, h: pixel size of the image/video.
// Returns null when the data is unusable.
export function estimateHeadPose(lm, w, h, opts) {
  if (!lm || lm.length < 468 || !(w > 0) || !(h > 0)) return null;
  opts = opts || {};
  var f = opts.focal || focalLengthPx(w, h, opts.diagFovDeg);
  var zRef = 0, k;
  for (k = 0; k < 4; k++) zRef += lm[EYE_CORNERS[k]].z * w / 4;
  var cam = { f: f, zRef: zRef, cx: w / 2, cy: h / 2 };
  var dst = RIGID_IDS.map(function (i) { return unproject(lm[i].x * w, lm[i].y * h, lm[i].z * w, cam); });
  for (k = 0; k < dst.length; k++) if (!isFinite(dst[k][0]) || !isFinite(dst[k][1]) || !isFinite(dst[k][2])) return null;
  var fit = fitSimilarity(RIGID_SRC, dst, RIGID_W);
  if (!(fit.s > 0)) return null;
  var anchor = [0, 0, 0];
  for (k = 0; k < 4; k++) {
    var i = EYE_CORNERS[k];
    var p = unproject(lm[i].x * w, lm[i].y * h, lm[i].z * w, cam);
    anchor[0] += p[0] / 4; anchor[1] += p[1] / 4; anchor[2] += p[2] / 4;
  }
  return {
    R: fit.R, q: fit.q, s: fit.s, anchor: anchor, fitOrigin: fit.t,
    rmsMm: fit.rms / fit.s, cam: cam, w: w, h: h
  };
}

// Smooths a stream of poses (One Euro on every channel: steady when still,
// responsive when moving). Call reset() when the face is lost.
export class HeadPoseFilter {
  constructor() {
    this.fq = [0, 1, 2, 3].map(function () { return new OneEuro(1.0, 1.5, 1.0); });
    this.fa = [0, 1, 2].map(function () { return new OneEuro(1.2, 0.03, 1.0); });
    this.fs = new OneEuro(0.6, 0.8, 1.0);
    this.fz = new OneEuro(0.6, 0.02, 1.0);
    this.prevQ = null;
  }
  reset() {
    this.fq.forEach(function (f) { f.reset(); });
    this.fa.forEach(function (f) { f.reset(); });
    this.fs.reset(); this.fz.reset();
    this.prevQ = null;
  }
  update(pose, tMs) {
    var q = pose.q.slice();
    if (this.prevQ && (q[0] * this.prevQ[0] + q[1] * this.prevQ[1] + q[2] * this.prevQ[2] + q[3] * this.prevQ[3]) < 0) {
      q = [-q[0], -q[1], -q[2], -q[3]];        // same rotation, keep the filter continuous
    }
    var fq = this.fq.map(function (f, i) { return f.filter(q[i], tMs); });
    var n = Math.hypot(fq[0], fq[1], fq[2], fq[3]) || 1;
    fq = [fq[0] / n, fq[1] / n, fq[2] / n, fq[3] / n];
    this.prevQ = fq;
    var a = this.fa.map(function (f, i) { return f.filter(pose.anchor[i], tMs); });
    var zRef = this.fz.filter(pose.cam.zRef, tMs);
    return {
      R: matrixFromQuat(fq), q: fq, s: this.fs.filter(pose.s, tMs), anchor: a,
      cam: { f: pose.cam.f, zRef: zRef, cx: pose.cam.cx, cy: pose.cam.cy },
      w: pose.w, h: pose.h, rmsMm: pose.rmsMm
    };
  }
}

// ---------- head geometry used for fitting the glasses (head frame, mm) ----------
// Generic adult proportions relative to the eye-corner midpoint. They scale with
// the fitted face size; they are approximations, not measurements of the customer.
export var HEAD = {
  // where the temple rests on top of the ear (x is +- this value)
  earX: 84, earY: -3, earZ: 72,
  // cranium occluder (ellipsoid) - hides the far temple behind the head
  skull: { cx: 0, cy: -5, cz: 75, rx: 73, ry: 95, rz: 85 },
  // distance from the eye corners to the plane of the frame front (towards the camera)
  frontZ: -20
};
