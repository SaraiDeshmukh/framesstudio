// Pure helpers for the live try-on: smoothing, head-pose estimation and the
// transform used to place a frame cutout on the face. No DOM and no network,
// so it can be unit-tested in Node (see tests/tracking.test.mjs).
//
// How a frame is placed (2D, anisotropic):
//   * Each frame in the catalog is a cut-out photo with two calibration points,
//     p1 and p2, marking the centre of each lens.
//   * Each video frame we get the two pupil centres from MediaPipe.
//   * The frame is translated so the midpoint of its lens centres sits on the
//     midpoint of the pupils, rotated by the eye-line angle (head roll) and
//     scaled so lens spacing matches pupil spacing.
//   * Head turn (yaw) is approximated: when the head turns, the pupils get
//     closer together in the image (width shrinks by cos(yaw)) but the frame's
//     height does not. We therefore scale X by the pupil spacing and Y by
//     pupil spacing / cos(yaw). It's an affine approximation of perspective,
//     not real 3D, and is deliberately capped.

// ---------- One Euro filter (Casiez et al. 2012) ----------
// Low-pass filter whose cut-off rises with speed: still head = heavy smoothing
// (no jitter), fast head = light smoothing (no lag).

function smoothingAlpha(cutoff, dt) {
  var tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff == null ? 1.0 : minCutoff;
    this.beta = beta == null ? 0.0 : beta;
    this.dCutoff = dCutoff == null ? 1.0 : dCutoff;
    this.reset();
  }
  reset() { this.xPrev = null; this.dxPrev = 0; this.tPrev = null; }
  filter(x, tMs) {
    if (this.xPrev === null) {
      this.xPrev = x; this.tPrev = tMs; this.dxPrev = 0;
      return x;
    }
    var dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    var dx = (x - this.xPrev) / dt;
    var aD = smoothingAlpha(this.dCutoff, dt);
    var dxHat = aD * dx + (1 - aD) * this.dxPrev;
    var cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    var a = smoothingAlpha(cutoff, dt);
    var xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat; this.dxPrev = dxHat; this.tPrev = tMs;
    return xHat;
  }
}

// ---------- pose from MediaPipe face landmarks ----------

var IRIS_A = 468, IRIS_B = 473;           // iris centres (478-landmark model)
var EYE_A_OUT = 33, EYE_A_IN = 133;       // fallback: eye corners
var EYE_B_IN = 362, EYE_B_OUT = 263;
var NOSE_TIP = 1, CHEEK_A = 234, CHEEK_B = 454;

var YAW_DEADZONE = 0.10;                  // rad (~6 deg): ignore tiny estimates
var COS_YAW_MIN = 0.6;                    // cap at ~53 deg so height never blows up

function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

// landmarks: normalised [0..1] list from MediaPipe; w/h: pixel size of the video.
// Returns raw (unsmoothed) pose in pixel space, or null if the data is unusable.
export function poseFromLandmarks(lm, w, h) {
  if (!lm || lm.length < 468) return null;
  var a, b;
  if (lm.length >= 478) { a = lm[IRIS_A]; b = lm[IRIS_B]; }
  else { a = mid(lm[EYE_A_OUT], lm[EYE_A_IN]); b = mid(lm[EYE_B_IN], lm[EYE_B_OUT]); }
  if (!a || !b) return null;
  var pa = { x: a.x * w, y: a.y * h }, pb = { x: b.x * w, y: b.y * h };
  // order left->right in image space so roll is always within +-90 degrees
  var left = pa.x <= pb.x ? pa : pb, right = pa.x <= pb.x ? pb : pa;
  var ipd = Math.hypot(right.x - left.x, right.y - left.y);
  if (!(ipd > 4)) return null;
  var roll = Math.atan2(right.y - left.y, right.x - left.x);

  // |yaw| from where the nose tip sits between the two cheek edges
  var nose = lm[NOSE_TIP], c1 = lm[CHEEK_A], c2 = lm[CHEEK_B];
  var yaw = 0;
  if (nose && c1 && c2) {
    var d1 = Math.hypot((nose.x - c1.x) * w, (nose.y - c1.y) * h);
    var d2 = Math.hypot((nose.x - c2.x) * w, (nose.y - c2.y) * h);
    var s = d1 + d2;
    if (s > 1) {
      var r = Math.abs(d1 - d2) / s;                 // 0 = facing camera, ->1 = profile
      yaw = Math.asin(Math.min(0.95, r * 1.1));
    }
  }
  return { mid: mid(left, right), ipd: ipd, roll: roll, yaw: yaw };
}

// Smooths a stream of raw poses. Call reset() when the face is lost.
export class PoseSmoother {
  constructor() {
    this.fx = new OneEuro(1.2, 0.03, 1.0);
    this.fy = new OneEuro(1.2, 0.03, 1.0);
    this.fIpd = new OneEuro(0.8, 0.02, 1.0);
    this.fRoll = new OneEuro(1.0, 0.5, 1.0);
    this.fYaw = new OneEuro(0.6, 0.2, 1.0);
  }
  reset() { this.fx.reset(); this.fy.reset(); this.fIpd.reset(); this.fRoll.reset(); this.fYaw.reset(); }
  update(raw, tMs) {
    return {
      mid: { x: this.fx.filter(raw.mid.x, tMs), y: this.fy.filter(raw.mid.y, tMs) },
      ipd: this.fIpd.filter(raw.ipd, tMs),
      roll: this.fRoll.filter(raw.roll, tMs),
      yaw: this.fYaw.filter(raw.yaw, tMs)
    };
  }
}

// ---------- placing the frame ----------

// Transform parameters for a frame cut-out given a smoothed pose.
// frame: { p1:{x,y}, p2:{x,y} } lens centres in the cut-out image's pixels.
export function frameTransform(frame, pose, userScale) {
  var p1 = frame.p1, p2 = frame.p2;
  if (p2.x < p1.x) { var t = p1; p1 = p2; p2 = t; }   // same left->right ordering as the face
  var frameD = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!(frameD > 1)) return null;
  var frameAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  var frameMid = mid(p1, p2);
  var k = userScale == null ? 1 : userScale;

  var effYaw = Math.max(0, pose.yaw - YAW_DEADZONE);
  var cosYaw = Math.max(COS_YAW_MIN, Math.cos(effYaw));
  var sx = (pose.ipd / frameD) * k;
  var sy = sx / cosYaw;
  return {
    tx: pose.mid.x, ty: pose.mid.y,
    roll: pose.roll, sx: sx, sy: sy,
    unrotate: -frameAngle,
    ox: -frameMid.x, oy: -frameMid.y,
    cosYaw: cosYaw
  };
}

// Draws the frame onto a 2D context already sized to the video.
export function drawFrame(ctx, img, tf) {
  if (!tf) return;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // soft contact shadow so the frame doesn't read as a flat sticker
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = Math.max(2, 5 * tf.sx);
  ctx.shadowOffsetY = Math.max(1, 2.5 * tf.sx);
  ctx.translate(tf.tx, tf.ty);
  ctx.rotate(tf.roll);
  ctx.scale(tf.sx, tf.sy);
  ctx.rotate(tf.unrotate);
  ctx.translate(tf.ox, tf.oy);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
