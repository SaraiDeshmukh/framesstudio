// WebGL renderer for the 3D try-on (three.js, MIT licence, loaded on first use).
//
// Turns a catalogue frame (front cut-out photo + lens points, optional size and
// side photo) into a 3D model and draws it on the customer's face:
//   * Front: the real photo, bent to a gentle face-form wrap and tilted like real
//     glasses (pantoscopic tilt), drawn as a stack of layers so the rim has real
//     thickness when the head turns. Unlit, so colours stay exactly as
//     photographed; a separate additive layer adds moving reflections.
//   * Lenses: the clear lens openings found in the cut-out get a glass surface
//     with environment reflections and a faint tint.
//   * Temples: start at the detected hinges and run back to the ears, textured
//     with the frame's own rim material (or the real temple, if a side photo was
//     added), fading out where they disappear into the hair/ear.
//   * Occlusion: the customer's face mesh (from the landmarks) and an ellipsoid
//     for the back of the head are drawn depth-only, so the nose hides the far
//     rim and the head hides the far temple, as in reality.
//   * A soft contact shadow under the front.
//
// World space = video pixels at the depth of the eyes (x right, y down, z away
// from the camera); see headpose.js. Everything runs locally in the browser.

import { CANONICAL_TRIANGLES } from './face-geometry.js';
import { HEAD, CANONICAL_IPD_MM, unprojectMesh } from './headpose.js';
import { analyseFrame, analyseSide, cleanSize } from './glasses-model.js';

// face-outline landmarks along the side of the head where the temples pass
var SIDE_LEFT = [21, 162, 127, 234, 139, 34];
var SIDE_RIGHT = [251, 389, 356, 454, 368, 264];

export var THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
export var DEFAULT_PD_MM = 63;           // adult average; staff can enter the real one
export var DEFAULT_TEMPLE_MM = 140;      // most common temple length, used only if none is recorded
var MAX_CACHED_FRAMES = 8;

var THREE = null;
var threePromise = null;
export function loadThree() {
  if (!threePromise) {
    threePromise = import(THREE_URL).then(function (m) { THREE = m; return m; })
      .catch(function (e) { threePromise = null; throw e; });
  }
  return threePromise;
}

export function webglAvailable() {
  try {
    var c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (e) { return false; }
}

export function createTryOnRenderer() {
  if (!webglAvailable()) return Promise.reject(new Error('WebGL is not available'));
  return loadThree().then(function () { return new TryOnRenderer(); });
}

// ---------- canvas helpers ----------

function makeCanvas(w, h) {
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

function readPixels(img) {
  var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  var c = makeCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, w, h);
}

// Copies the source image into a new canvas in "axis space" (see glasses-model.js)
// cropped to [u0, u0+cw] x [v0, v0+ch]. Masks get a black background, because
// three.js alpha maps are read from the (grey) colour channels, not from alpha.
function axisCanvas(src, centre, angle, u0, v0, cw, ch, isMask) {
  var c = makeCanvas(cw, ch), g = c.getContext('2d');
  if (isMask) { g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch); }
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.translate(-u0, -v0);
  g.rotate(-angle);
  g.translate(-centre.x, -centre.y);
  g.drawImage(src, 0, 0);
  return c;
}

function maskCanvas(mask, w, h) {
  var c = makeCanvas(w, h), g = c.getContext('2d'), id = g.createImageData(w, h);
  for (var i = 0; i < w * h; i++) {
    var v = mask[i] ? 255 : 0;
    id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  return c;
}

// Background removal leaves the backdrop's colour in the soft edge pixels of a
// cut-out (a light halo on a white table). Replace the colour of every
// semi-transparent pixel with that of its solid neighbours, keeping its alpha.
function defringe(canvas, passes) {
  var w = canvas.width, h = canvas.height, g = canvas.getContext('2d', { willReadFrequently: true });
  var id = g.getImageData(0, 0, w, h), d = id.data, n = w * h;
  var solid = new Uint8Array(n);
  for (var i = 0; i < n; i++) solid[i] = d[i * 4 + 3] >= 235 ? 1 : 0;
  for (var pass = 0; pass < (passes || 3); pass++) {
    var next = solid.slice();
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x;
        if (solid[k] || d[k * 4 + 3] === 0) continue;
        var r = 0, gg = 0, b = 0, c = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= w) continue;
            var m = yy * w + xx;
            if (!solid[m]) continue;
            r += d[m * 4]; gg += d[m * 4 + 1]; b += d[m * 4 + 2]; c++;
          }
        }
        if (!c) continue;
        d[k * 4] = r / c; d[k * 4 + 1] = gg / c; d[k * 4 + 2] = b / c;
        next[k] = 1;
      }
    }
    solid = next;
  }
  g.putImageData(id, 0, 0);
  return canvas;
}

// Soft blur by down- and up-sampling (works in every browser, unlike ctx.filter).
function blurred(src, factor) {
  var sw = Math.max(2, Math.round(src.width / factor)), sh = Math.max(2, Math.round(src.height / factor));
  var small = makeCanvas(sw, sh), gs = small.getContext('2d');
  gs.imageSmoothingEnabled = true; gs.imageSmoothingQuality = 'high';
  gs.drawImage(src, 0, 0, sw, sh);
  var out = makeCanvas(src.width, src.height), go = out.getContext('2d');
  go.imageSmoothingEnabled = true; go.imageSmoothingQuality = 'high';
  go.drawImage(small, 0, 0, src.width, src.height);
  return out;
}

// White-on-black silhouette of the source's alpha (for alpha maps).
function alphaAsWhite(src) {
  var sil = makeCanvas(src.width, src.height), gs = sil.getContext('2d');
  gs.drawImage(src, 0, 0);
  gs.globalCompositeOperation = 'source-in';
  gs.fillStyle = '#fff';
  gs.fillRect(0, 0, sil.width, sil.height);
  var c = makeCanvas(src.width, src.height), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(sil, 0, 0);
  return c;
}

function stripCanvas(strip) {
  var c = makeCanvas(strip.width, strip.height), g = c.getContext('2d');
  var id = g.createImageData(strip.width, strip.height);
  id.data.set(strip.data);
  g.putImageData(id, 0, 0);
  return c;
}

function colorTex(canvas, premultiplied) {
  var t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  // cut-outs are uploaded premultiplied so filtering doesn't darken their edges
  if (premultiplied) t.premultiplyAlpha = true;
  return t;
}
function dataTex(canvas) { return new THREE.CanvasTexture(canvas); }

// Smooth-edged drawing of premultiplied cut-out textures (the frame photo).
function premultipliedBlend(mat) {
  mat.transparent = true;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return mat;
}

// Draw order (transparent objects are drawn in this order, after the depth-only
// occluders): shadow, temples, lens tint, lens reflections, rim layers back to
// front, highlights.
var ORDER = { shadow: 0, temple: 1, lensTint: 2, lensRefl: 3, rim: 4, sheen: 30 };

// Adds light on top of what is already drawn without changing coverage: lens
// reflections over the camera image, and highlights over the frame photo.
function additive(mat) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.SrcAlphaFactor; mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor; mat.blendDstAlpha = THREE.OneFactor;
  return mat;
}

// A small studio "room" rendered into an environment map: dim walls, a bright
// ceiling and two soft boxes in front of the customer. Built in world axes
// (y down, camera looks along +z), so reflections come from the right places.
function makeEnvironment(renderer) {
  var room = new THREE.Scene();
  var box = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial({ color: 0x4d4f52, side: THREE.BackSide }));
  room.add(box);
  function panel(w, h, pos, look, value) {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(value, value, value), side: THREE.DoubleSide }));
    m.position.set(pos[0], pos[1], pos[2]); m.lookAt(look[0], look[1], look[2]);
    room.add(m);
  }
  panel(14, 8, [0, -9.5, -2], [0, 0, -2], 1.8);       // ceiling light (world -y is up)
  panel(5, 7, [-6, -3, -9], [0, 0, 0], 2.0);           // soft box, front left
  panel(4, 6, [7, -2, -8], [0, 0, 0], 1.3);            // soft box, front right
  panel(20, 3, [0, 9.5, 0], [0, 0, 0], 0.25);          // floor bounce
  var pm = new THREE.PMREMGenerator(renderer);
  var env = pm.fromScene(room, 0.03).texture;
  pm.dispose();
  room.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return env;
}

// Grid over an axis-space rectangle, mapped to millimetres, bent and tilted the
// way a real frame front sits on a face. depth: extra offset into the head (mm).
function frontGeometry(rect, mmPerPx, shape, depth) {
  var NX = 40, NY = 10, pos = [], uv = [], idx = [];
  for (var j = 0; j <= NY; j++) {
    for (var i = 0; i <= NX; i++) {
      var u = rect.u0 + i / NX * rect.cw, v = rect.v0 + j / NY * rect.ch;
      var x = u * mmPerPx, y = v * mmPerPx;
      var p = shape(x, y);
      pos.push(p[0], p[1], p[2] + depth);
      uv.push(i / NX, 1 - j / NY);
    }
  }
  for (j = 0; j < NY; j++) for (i = 0; i < NX; i++) {
    var a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Rectangular tube along a polyline. path: [{p:[x,y,z], h, a}] with h = height,
// a = opacity. side: unit vector pointing away from the head (thickness axis).
function templeGeometry(path, thickness, side) {
  var pos = [], col = [], uv = [], idx = [], total = 0, lens = [0];
  for (var i = 1; i < path.length; i++) {
    total += Math.hypot(path[i].p[0] - path[i - 1].p[0], path[i].p[1] - path[i - 1].p[1], path[i].p[2] - path[i - 1].p[2]);
    lens.push(total);
  }
  var faces = [[1, 1], [1, -1], [-1, -1], [-1, 1]];        // (side, up) corners, walked around
  for (i = 0; i < path.length; i++) {
    var prev = path[Math.max(0, i - 1)].p, next = path[Math.min(path.length - 1, i + 1)].p;
    var dir = new THREE.Vector3(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]).normalize();
    var up = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(side[0], side[1], side[2])).normalize();
    if (up.y > 0) up.negate();                                         // world -y is up
    var sd = new THREE.Vector3().crossVectors(up, dir).normalize();    // thickness axis, perpendicular to both
    for (var f = 0; f < 4; f++) {
      var c = faces[f];
      var x = path[i].p[0] + sd.x * c[0] * thickness / 2 + up.x * c[1] * path[i].h / 2;
      var y = path[i].p[1] + sd.y * c[0] * thickness / 2 + up.y * c[1] * path[i].h / 2;
      var z = path[i].p[2] + sd.z * c[0] * thickness / 2 + up.z * c[1] * path[i].h / 2;
      pos.push(x, y, z);
      col.push(1, 1, 1, path[i].a);
      uv.push(lens[i] / total, f === 0 || f === 3 ? 0.85 : 0.15);
    }
  }
  for (i = 0; i < path.length - 1; i++) {
    for (f = 0; f < 4; f++) {
      var a = i * 4 + f, b = i * 4 + (f + 1) % 4, cc = a + 4, d = b + 4;
      idx.push(a, cc, b, b, cc, d);
    }
  }
  // cap at the hinge end
  idx.push(0, 1, 2, 0, 2, 3);
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function disposeObject(root) {
  if (!root) return;
  root.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
    }
  });
  if (root.parent) root.parent.remove(root);
}

// ---------- the renderer ----------

export class TryOnRenderer {
  constructor() {
    var canvas = document.createElement('canvas');
    canvas.className = 'ar-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    this.canvas = canvas;
    var r = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(1);
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.scene.environment = makeEnvironment(r);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 10000);
    this.scene.add(this.camera);

    var amb = new THREE.AmbientLight(0xffffff, 1.4);
    var key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-0.35, -1, -1.1);       // from above-left, in front of the customer
    this.camera.add(amb);
    this.scene.add(key); this.scene.add(key.target);
    this.keyLight = key;

    this.head = new THREE.Group();
    this.scene.add(this.head);

    var occ = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide });
    this.occluderMaterial = occ;
    var sk = HEAD.skull;
    this.skull = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), occ);
    this.skull.scale.set(sk.rx, sk.ry, sk.rz);
    this.skull.position.set(sk.cx, sk.cy, sk.cz);
    this.skull.renderOrder = -10;
    this.head.add(this.skull);

    var fg = new THREE.BufferGeometry();
    this.facePositions = new Float32Array(468 * 3);
    fg.setAttribute('position', new THREE.BufferAttribute(this.facePositions, 3).setUsage(THREE.DynamicDrawUsage));
    fg.setIndex(CANONICAL_TRIANGLES.slice());
    this.face = new THREE.Mesh(fg, occ);
    this.face.renderOrder = -10;
    this.face.frustumCulled = false;
    this.scene.add(this.face);

    this.w = 0; this.h = 0;
    this.pd = DEFAULT_PD_MM;
    this.fit = 1;
    this.cache = new Map();          // key -> prepared frame (analysis + textures)
    this.current = null;             // prepared frame in use
    this.glasses = null;             // THREE.Group for the front (in the head group)
    this.temples = null;
    this.frontInfo = null;
    this.shadowMesh = null;
    this.visible = true;
    this.exposure = 1;              // scene brightness relative to a well-lit shop (see setExposure)
    this.tinted = [];               // [{ mat, base, emissive }] materials that follow the exposure
    this.resetFaceFit();
    this.laidEarX = { left: HEAD.earX, right: HEAD.earX };
  }

  attach(container) {
    if (this.canvas.parentNode !== container) container.appendChild(this.canvas);
  }
  detach() {
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
  setSize(w, h) {
    w = Math.round(w); h = Math.round(h);
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
  }
  setVisible(on) { this.visible = !!on; }

  // The frame photo was taken in good light; in a dim shop it would glow. k is
  // the scene's brightness relative to normal (1 = unchanged), clamped.
  setExposure(k) {
    k = Math.max(0.5, Math.min(1.1, Number(k) || 1));
    if (Math.abs(k - this.exposure) < 0.005) return;
    this.exposure = k;
    this.applyExposure();
  }
  applyExposure() {
    var k = this.exposure;
    this.tinted.forEach(function (t) {
      if (t.env != null) { t.mat.envMapIntensity = t.env * k * k; return; }   // reflections fall off faster
      t.mat.color.setScalar(t.base * k);
      if (t.emissive != null) t.mat.emissive.setScalar(t.emissive * k);
    });
  }
  track(mat, base, emissive) {
    this.tinted.push({ mat: mat, base: base, emissive: emissive == null ? null : emissive });
    return mat;
  }
  setFit(k) {
    if (!(k > 0) || k === this.fit) return;
    this.fit = k;
    this.layout();
  }
  setPD(mm) {
    mm = Number(mm);
    if (!(mm >= 50 && mm <= 80) || mm === this.pd) return;
    this.pd = mm;
    this.layout();
  }

  // Analyses a catalogue frame and builds its textures (cached per key).
  // frame: { img, p1, p2, tags, size, side: { img, hinge, tip } | null }
  prepare(key, frame) {
    if (this.cache.has(key)) {
      var hit = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key, hit);       // most recently used last
      return hit;
    }
    // keep GPU memory bounded on phones/kiosks: drop the least recently used frames
    var self = this;
    Array.from(this.cache.keys()).forEach(function (k) {
      if (self.cache.size >= MAX_CACHED_FRAMES && (!self.current || self.current.key !== k)) self.forget(k);
    });
    var px = readPixels(frame.img);
    var a = analyseFrame(px, frame.p1, frame.p2, { tags: frame.tags, size: frame.size });
    if (!a.ok) { var bad = { ok: false, reason: a.reason }; return bad; }
    var pad = 6;
    var rect = { u0: Math.floor(a.bbox.minU - pad), v0: Math.floor(a.bbox.minV - pad) };
    rect.cw = Math.ceil(a.bbox.maxU + pad) - rect.u0;
    rect.ch = Math.ceil(a.bbox.maxV + pad) - rect.v0;
    var front = defringe(axisCanvas(frame.img, a.centre, a.angle, rect.u0, rect.v0, rect.cw, rect.ch));
    var lens = a.lensPixels ? axisCanvas(maskCanvas(a.lensMask, a.width, a.height), a.centre, a.angle, rect.u0, rect.v0, rect.cw, rect.ch, true) : null;
    var shadowSrc = alphaAsWhite(front);
    var prepared = {
      ok: true, key: key, analysis: a, rect: rect,
      tex: {
        front: colorTex(front, true),
        lens: lens ? dataTex(blurred(lens, 2)) : null,
        shadow: dataTex(blurred(shadowSrc, 14)),
        strip: colorTex(stripCanvas(a.rim.strip))
      },
      size: cleanSize(frame.size),
      tags: frame.tags || {},
      side: null
    };
    prepared.tex.strip.wrapS = THREE.MirroredRepeatWrapping;
    if (frame.side && frame.side.img) {
      var templeMm = (prepared.size && prepared.size.temple) || DEFAULT_TEMPLE_MM;
      var sp = readPixels(frame.side.img);
      var s = analyseSide(sp, frame.side.hinge, frame.side.tip, templeMm);
      if (s.ok) {
        var su0 = Math.floor(s.crop.minU - 2), sv0 = Math.floor(s.crop.minV - 3);
        var scw = Math.ceil(s.crop.maxU + 3) - su0, sch = Math.ceil(s.crop.maxV + 3) - sv0;
        var sc = makeCanvas(scw, sch), sg = sc.getContext('2d');
        sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
        sg.translate(-su0, -sv0);
        if (s.flip < 0) sg.scale(1, -1);
        sg.rotate(-s.angle);
        sg.translate(-s.hinge.x, -s.hinge.y);
        sg.drawImage(frame.side.img, 0, 0);
        prepared.side = { analysis: s, rect: { u0: su0, v0: sv0, cw: scw, ch: sch }, canvas: defringe(sc), tex: null };
      }
    }
    this.cache.set(key, prepared);
    return prepared;
  }

  forget(key) {
    var p = this.cache.get(key);
    if (!p) return;
    if (p.ok) Object.keys(p.tex).forEach(function (k) { if (p.tex[k]) p.tex[k].dispose(); });
    if (p.side && p.side.tex) p.side.tex.dispose();
    this.cache.delete(key);
    if (this.current === p) this.clearFrame();
  }

  setFrame(key, frame) {
    var p = this.prepare(key, frame);
    if (!p.ok) { this.clearFrame(); return p; }
    this.current = p;
    this.layout();
    return p;
  }

  clearFrame() {
    disposeObject(this.glasses); this.glasses = null;
    disposeObject(this.temples); this.temples = null;
    this.current = null; this.frontInfo = null; this.shadowMesh = null;
  }

  // (Re)builds meshes for the current frame from its cached analysis/textures.
  layout() {
    disposeObject(this.glasses); this.glasses = null;
    disposeObject(this.temples); this.temples = null;
    this.tinted = [];
    var p = this.current;
    if (!p) return;
    var a = p.analysis, T = THREE;
    // real millimetres per photo pixel: from the recorded size, else lens centres = pupils
    var mmPerPx = a.mmPerPx || this.pd / a.lensDistPx;
    var g = CANONICAL_IPD_MM / this.pd * this.fit;          // real mm -> head-frame mm
    var metal = a.metal;
    var thick = metal ? 1.4 : 3.6;                            // mm, rim depth front-to-back
    var wrapR = p.tags.shape === 'aviator' ? 240 : 300;      // face-form curve radius, mm
    var panto = 8 * Math.PI / 180;
    function shape(x, y) {
      return [x, y * Math.cos(panto), x * x / (2 * wrapR) + y * Math.sin(panto)];
    }
    this.frontInfo = { mmPerPx: mmPerPx, g: g, metal: metal, thick: thick, shape: shape };
    var group = new T.Group();
    group.position.set(0, 0, HEAD.frontZ);
    group.scale.setScalar(g);

    // stacked layers give the rim its depth; the back ones are darker (rim
    // sides). Drawn back to front with smooth (blended) edges.
    var layers = metal ? 3 : 7;
    for (var i = layers - 1; i >= 0; i--) {
      var depth = i / (layers - 1) * thick;
      // the front layer keeps soft edges; the hidden-unless-turned back layers are
      // cut hard so soft edge pixels don't pile up into a halo at an angle
      var m = premultipliedBlend(new T.MeshBasicMaterial({ map: p.tex.front, alphaTest: i > 0 ? 0.6 : 0.01, side: T.DoubleSide, depthWrite: true }));
      this.track(m, i > 0 ? (metal ? 0.7 : 0.5 - 0.08 * i / (layers - 1)) : 1);
      var mesh = new T.Mesh(frontGeometry(p.rect, mmPerPx, shape, depth), m);
      mesh.renderOrder = ORDER.rim + (layers - 1 - i);
      group.add(mesh);
    }
    // moving reflections over the photo (specular only, added on top)
    // (a clear-coat style glint: colours stay as photographed - measured within
    // ~2/255 of the photo without it, ~+8 with it)
    var sheen = additive(new T.MeshStandardMaterial({
      map: p.tex.front, color: 0x000000, metalness: 0,
      roughness: metal ? 0.15 : 0.22, envMapIntensity: metal ? 0.6 : 0.7
    }));
    this.tinted.push({ mat: sheen, env: sheen.envMapIntensity });
    var sheenMesh = new T.Mesh(frontGeometry(p.rect, mmPerPx, shape, -0.05), sheen);
    sheenMesh.renderOrder = ORDER.sheen;
    group.add(sheenMesh);

    // lens glass: reflections + a faint tint, only inside the detected openings
    if (p.tex.lens) {
      var lensDepth = thick * 0.45;
      var refl = additive(new T.MeshStandardMaterial({ color: 0x000000, roughness: 0.06, metalness: 0, alphaMap: p.tex.lens, envMapIntensity: 0.5 }));
      this.tinted.push({ mat: refl, env: refl.envMapIntensity });
      var lm = new T.Mesh(frontGeometry(p.rect, mmPerPx, shape, lensDepth), refl);
      lm.renderOrder = ORDER.lensRefl;
      group.add(lm);
      var tint = new T.MeshBasicMaterial({ color: 0xa9bccd, alphaMap: p.tex.lens, transparent: true, opacity: 0.045, depthWrite: false });
      var tm = new T.Mesh(frontGeometry(p.rect, mmPerPx, shape, lensDepth + 0.05), tint);
      tm.renderOrder = ORDER.lensTint;
      group.add(tm);
    }

    // soft contact shadow on the face just behind the front
    var sh = new T.MeshBasicMaterial({ color: 0x000000, alphaMap: p.tex.shadow, transparent: true, opacity: 0.15, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    var shMesh = new T.Mesh(frontGeometry(p.rect, mmPerPx, function (x, y) { return [x * 1.02, y + 2, x * x / (2 * wrapR)]; }, thick + 9), sh);
    shMesh.renderOrder = ORDER.shadow;
    this.shadowMesh = shMesh;
    group.add(shMesh);

    this.head.add(group);
    this.glasses = group;
    this.layoutTemples();
  }

  // Hinge position of one side in head-frame mm.
  hingeHead(sideName) {
    var fi = this.frontInfo, a = this.current.analysis, hg = a.hinges[sideName];
    var hp = fi.shape(hg.u * fi.mmPerPx, hg.v * fi.mmPerPx);
    return [hp[0] * fi.g, hp[1] * fi.g, HEAD.frontZ + (hp[2] + fi.thick * 0.6) * fi.g];
  }

  // Temples run from the hinges to the ears (head-frame millimetres). They are
  // kept outside this customer's measured face outline (this.earX), else the
  // face occluder would swallow them.
  layoutTemples() {
    disposeObject(this.temples); this.temples = null;
    var self0 = this;
    this.tinted = this.tinted.filter(function (t) { return !t.temple; });
    var p = this.current;
    if (!p || !this.frontInfo) { self0.applyExposure(); return; }
    var T = THREE, a = p.analysis, fi = this.frontInfo, g = fi.g, metal = fi.metal;
    var temples = new T.Group();
    var templeMm = ((p.size && p.size.temple) || DEFAULT_TEMPLE_MM) * g;
    var self = this;
    this.laidEarX = { left: this.earX.left, right: this.earX.right };
    ['left', 'right'].forEach(function (sideName) {
      var hg = a.hinges[sideName], sgn = sideName === 'left' ? -1 : 1;
      var H0 = self.hingeHead(sideName);
      var ex = sgn * Math.max(self.earX[sideName], Math.abs(H0[0]) + 3);
      var E = [ex, HEAD.earY, HEAD.earZ];
      var straight = Math.hypot(E[0] - H0[0], E[1] - H0[1], E[2] - H0[2]);
      var bendLen = Math.max(14, templeMm - straight);
      var dir = [(E[0] - H0[0]) / straight, (E[1] - H0[1]) / straight, (E[2] - H0[2]) / straight];
      // the ear bend turns the temple downwards (+y) in its own vertical plane
      var hlen = Math.hypot(dir[0], dir[2]) || 1, hdir = [dir[0] / hlen, dir[2] / hlen];
      var a0 = Math.asin(Math.max(-1, Math.min(1, dir[1]))), bendAng = 38 * Math.PI / 180;
      var fadeStart = straight * 0.6, fadeEnd = straight + 4;
      var h0 = Math.min(metal ? 3.5 : 9, Math.max(metal ? 1.6 : 3, hg.height * fi.mmPerPx * 0.8)) * g;
      var h1 = Math.max(metal ? 1.5 : 2.4, h0 * 0.55);
      var path = [];
      var NS = 18;
      for (var k = 0; k <= NS; k++) {
        var t = k / NS;
        path.push({ p: [H0[0] + (E[0] - H0[0]) * t, H0[1] + (E[1] - H0[1]) * t, H0[2] + (E[2] - H0[2]) * t], h: h0 + (h1 - h0) * Math.min(1, t * 1.6), s: t * straight });
      }
      var NB = 6;
      for (k = 1; k <= NB; k++) {
        var tb = k / NB, ang = a0 + bendAng * (k - 0.5) / NB;
        var d = [Math.cos(ang) * hdir[0], Math.sin(ang), Math.cos(ang) * hdir[1]];
        var last = path[path.length - 1].p, step = bendLen / NB;
        path.push({ p: [last[0] + d[0] * step, last[1] + d[1] * step, last[2] + d[2] * step], h: h1, s: straight + tb * bendLen });
      }
      path.forEach(function (q) { q.a = q.s <= fadeStart ? 1 : Math.max(0, 1 - (q.s - fadeStart) / (fadeEnd - fadeStart)); });

      if (p.side) {
        temples.add(self.sideTemple(p, H0, dir, sgn, g, fadeStart, fadeEnd));
      } else {
        // mostly self-lit with the rim's own colours, so it matches the unlit
        // photo of the front; the lights add just enough shading to show its shape
        var mat = new T.MeshStandardMaterial({
          map: p.tex.strip, emissiveMap: p.tex.strip, emissive: 0xb0b0b0, color: 0x707070,
          vertexColors: true, transparent: true, side: T.DoubleSide,
          roughness: metal ? 0.35 : 0.45, metalness: metal ? 0.3 : 0.0, envMapIntensity: metal ? 0.6 : 0.35
        });
        self.tinted.push({ mat: mat, base: mat.color.r, emissive: mat.emissive.r, temple: true });
        self.tinted.push({ mat: mat, env: mat.envMapIntensity, temple: true });
        var thickness = (metal ? 1.3 : 2.6) * g;
        var mesh2 = new T.Mesh(templeGeometry(path, thickness, [sgn, 0, 0]), mat);
        mesh2.renderOrder = ORDER.temple;
        temples.add(mesh2);
      }
    });
    this.head.add(temples);
    this.temples = temples;
    this.applyExposure();
  }

  // How far out the ear end of each temple must be so the temple clears this
  // customer's face outline (head-frame mm), from the current face mesh.
  measureEars(pose) {
    if (!this.frontInfo) return;
    var R = pose.R, s = pose.s, A = pose.anchor, fp = this.facePositions, self = this;
    ['left', 'right'].forEach(function (sideName) {
      var ids = sideName === 'left' ? SIDE_LEFT : SIDE_RIGHT;
      var H0 = self.hingeHead(sideName), hx = Math.abs(H0[0]), need = HEAD.earX;
      for (var k = 0; k < ids.length; k++) {
        var i = ids[k], P = [fp[3 * i] - A[0], fp[3 * i + 1] - A[1], fp[3 * i + 2] - A[2]];
        // world -> head frame: R^T * P / s
        var x = Math.abs((R[0] * P[0] + R[3] * P[1] + R[6] * P[2]) / s);
        var z = (R[2] * P[0] + R[5] * P[1] + R[8] * P[2]) / s;
        if (z < H0[2] + 10 || z > HEAD.earZ) continue;
        var reqd = hx + (x + 4 - hx) * (HEAD.earZ - H0[2]) / (z - H0[2]);
        if (reqd > need) need = reqd;
      }
      need = Math.min(110, need);
      // ease towards the measurement; it only drifts with landmark noise
      self.earX[sideName] = self.earX[sideName] + (need - self.earX[sideName]) * (self.earPrimed ? 0.15 : 1);
    });
    this.earPrimed = true;
    if (Math.abs(this.earX.left - this.laidEarX.left) > 2 || Math.abs(this.earX.right - this.laidEarX.right) > 2) this.layoutTemples();
  }

  resetFaceFit() {
    this.earX = { left: HEAD.earX, right: HEAD.earX };
    this.earPrimed = false;
  }

  // The real temple from a side photo: a textured ribbon (two layers for
  // thickness) running from the hinge towards the ear.
  sideTemple(p, H0, dir, sgn, g, fadeStart, fadeEnd) {
    var T = THREE, s = p.side, an = s.analysis, r = s.rect;
    var mmPx = an.mmPerPx * g;                      // head mm per side-photo pixel
    if (!s.tex) {
      // bake the fade into the texture (alpha falls off towards the ear)
      var c = makeCanvas(r.cw, r.ch), cg = c.getContext('2d');
      cg.drawImage(s.canvas, 0, 0);
      var u0 = r.u0;
      var grad = cg.createLinearGradient((fadeStart / mmPx) - u0, 0, (fadeEnd / mmPx) - u0, 0);
      grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      cg.globalCompositeOperation = 'destination-in';
      cg.fillStyle = grad; cg.fillRect(0, 0, r.cw, r.ch);
      s.tex = colorTex(c, true);
    }
    // ribbon axes: along the temple, and "down" orthogonal to it
    var along = new T.Vector3(dir[0], dir[1], dir[2]).normalize();
    var down = new T.Vector3(0, 1, 0).addScaledVector(along, -along.y).normalize();
    var outward = new T.Vector3().crossVectors(along, down).normalize();
    if (outward.x * sgn < 0) outward.negate();
    var group = new T.Group(), self = this;
    var thickness = Math.max(1.2, Math.min(4, an.heightNearHingePx * mmPx * 0.35));
    [0.5, -0.5].forEach(function (off, li) {
      var geo = new T.PlaneGeometry(1, 1);
      var pos = geo.attributes.position;
      for (var i = 0; i < pos.count; i++) {
        var px = pos.getX(i) + 0.5, py = 0.5 - pos.getY(i);           // 0..1 across the texture
        var u = (r.u0 + px * r.cw) * mmPx, v = (r.v0 + py * r.ch) * mmPx;
        var P = new T.Vector3(H0[0], H0[1], H0[2]).addScaledVector(along, u).addScaledVector(down, v).addScaledVector(outward, off * thickness);
        pos.setXYZ(i, P.x, P.y, P.z);
      }
      geo.computeVertexNormals();
      var m = premultipliedBlend(new T.MeshBasicMaterial({ map: s.tex, alphaTest: 0.01, side: T.DoubleSide, depthWrite: true }));
      self.tinted.push({ mat: m, base: li === 1 ? 0.6 : 1, emissive: null, temple: true });
      var mesh = new T.Mesh(geo, m);
      mesh.renderOrder = ORDER.temple;
      group.add(mesh);
    });
    return group;
  }

  // Development aid: draw the occluders (face mesh, head) in grey.
  setDebugOccluders(on) {
    var m = on ? new THREE.MeshLambertMaterial({ color: 0xd8cfc6, side: THREE.DoubleSide }) : this.occluderMaterial;
    this.face.material = m; this.skull.material = m;
  }

  clear() {
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, true, true);
  }

  setCamera(cam) {
    var c = this.camera, f = cam.f;
    c.position.set(cam.cx, cam.cy, cam.zRef - f);
    c.up.set(0, -1, 0);
    c.lookAt(cam.cx, cam.cy, cam.zRef);
    c.fov = 2 * Math.atan(this.h / 2 / f) * 180 / Math.PI;
    c.aspect = this.w / this.h;
    c.near = f * 0.25;
    c.far = f * 3 + 4000;
    c.updateProjectionMatrix();
  }

  // pose: from headpose.js (smoothed for video); lm: raw MediaPipe landmarks.
  renderFace(pose, lm) {
    if (!this.w || !this.h) return;
    if (!pose || !this.visible || !this.glasses) { this.clear(); return; }
    this.setCamera(pose.cam);
    this.head.position.set(pose.anchor[0], pose.anchor[1], pose.anchor[2]);
    this.head.quaternion.set(pose.q[1], pose.q[2], pose.q[3], pose.q[0]);
    this.head.scale.setScalar(pose.s);
    this.face.visible = !!lm;
    this.skull.visible = true;
    if (this.shadowMesh) this.shadowMesh.visible = true;
    if (lm) {
      unprojectMesh(lm, this.w, this.h, pose.cam, this.facePositions, 3 * pose.s);
      this.face.geometry.attributes.position.needsUpdate = true;
      this.measureEars(pose);
    }
    this.renderer.render(this.scene, this.camera);
  }

  // Turntable view of the current frame without a face (used when adding frames).
  renderPreview(yaw, pitch) {
    if (!this.w || !this.h) return;
    if (!this.glasses) { this.clear(); return; }
    var f = Math.hypot(this.w, this.h) * 1.4;
    var cam = { f: f, zRef: 0, cx: this.w / 2, cy: this.h / 2 };
    this.setCamera(cam);
    var a = this.current.analysis;
    var mmPerPx = a.mmPerPx || this.pd / a.lensDistPx;
    var widthHeadMm = a.widthPx * mmPerPx * CANONICAL_IPD_MM / this.pd * this.fit;
    var s = this.w * 0.62 / widthHeadMm;
    var e = new THREE.Euler(pitch || 0, yaw || 0, 0, 'YXZ');
    this.head.quaternion.setFromEuler(e);
    this.head.scale.setScalar(s);
    // keep the frame front centred: rotate about the middle of the frame, not the eyes
    var centre = new THREE.Vector3(0, 0, HEAD.frontZ + 25).applyQuaternion(this.head.quaternion).multiplyScalar(s);
    this.head.position.set(this.w / 2 - centre.x, this.h / 2 - centre.y + this.h * 0.06, -centre.z);
    this.face.visible = false;
    this.skull.visible = false;
    if (this.shadowMesh) this.shadowMesh.visible = false;   // nothing to cast onto
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    var self = this;
    Array.from(this.cache.keys()).forEach(function (k) { self.forget(k); });
    this.clearFrame();
    disposeObject(this.skull); disposeObject(this.face);
    if (this.scene.environment) this.scene.environment.dispose();
    this.renderer.dispose();
    this.detach();
  }
}
