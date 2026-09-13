import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getAnalytics, isSupported, logEvent } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-analytics.js";

// No Firebase Storage — images live directly inside Firestore documents, so this
// app runs entirely on the free Spark plan. No billing account needed.
//
// No customer photo is ever written to the account either: this is a single shared
// login used at the counter for many different people, so the photo stays purely
// in-memory for the current visit and is discarded the moment it's replaced or the
// page is closed.

var CONFIGURED = firebaseConfig.apiKey && firebaseConfig.apiKey.indexOf('YOUR_') !== 0;
var setupNotice = document.getElementById('setupNotice');
var authGate = document.getElementById('authGate');

if (!CONFIGURED) {
  setupNotice.style.display = 'block';
  throw new Error('firebase-config.js still has placeholder values.');
}

var app = initializeApp(firebaseConfig);
var auth = getAuth(app);
var db = getFirestore(app);

// Analytics is initialized only after confirming the browser supports it (per
// Firebase's own guidance), and every call site below is guarded so a missing or
// unsupported Analytics instance can never break the actual try-on functionality.
var analytics = null;
isSupported().then(function (supported) {
  if (supported) analytics = getAnalytics(app);
}).catch(function () {});

function track(eventName, params) {
  if (!analytics) return;
  try { logEvent(analytics, eventName, params || {}); } catch (e) { /* analytics must never break the app */ }
}

(function () {
  var MAX_FACE_DIM = 800;
  var MAX_FRAME_DIM = 700;
  var THUMB_DIM = 260;
  var FULL_BYTE_BUDGET = 750000;
  var THUMB_BYTE_BUDGET = 150000;

  var FACETS = {
    shape: { options: ['round', 'square', 'catseye', 'aviator', 'browline', 'rectangle', 'oval'] },
    color: { options: ['black', 'tortoise', 'gold', 'silver', 'clear', 'navy', 'red'] },
    gender: { options: ['womens', 'mens', 'unisex', 'kids'] },
    rim: { options: ['fullrim', 'semirimless', 'rimless'] }
  };

  function labelize(v) {
    var map = {
      catseye: 'Cat-Eye', womens: "Women's", mens: "Men's", kids: "Kids'",
      fullrim: 'Full-Rim', semirimless: 'Semi-Rimless'
    };
    return map[v] || (v ? (v.charAt(0).toUpperCase() + v.slice(1)) : '');
  }

  // Renders a facet's chip buttons fresh into `container`, marking `currentValue`
  // active. Reusable for the Add-frame form, the single-frame editor, and the
  // bulk-edit bar -- all three just point it at a different container/state.
  function renderChipGroup(container, facetKey, currentValue, onChange) {
    container.innerHTML = '';
    FACETS[facetKey].options.forEach(function (val) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (currentValue === val ? ' active' : '');
      chip.textContent = labelize(val);
      chip.addEventListener('click', function () {
        var wasActive = chip.classList.contains('active');
        container.querySelectorAll('.tag-chip').forEach(function (c) { c.classList.remove('active'); });
        if (wasActive) { onChange(null); }
        else { chip.classList.add('active'); onChange(val); }
      });
      container.appendChild(chip);
    });
  }

  // ---------- auth elements ----------
  var appShell = document.getElementById('appShell');
  var authForm = document.getElementById('authForm');
  var authEmail = document.getElementById('authEmail');
  var authPassword = document.getElementById('authPassword');
  var authError = document.getElementById('authError');
  var signUpBtn = document.getElementById('signUpBtn');
  var signOutBtn = document.getElementById('signOutBtn');
  var userEmailLabel = document.getElementById('userEmailLabel');

  var currentUser = null;

  function friendlyAuthError(err) {
    var map = {
      'auth/email-already-in-use': 'That email already has an account \u2014 try signing in instead.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/weak-password': 'Password should be at least 6 characters.',
      'auth/invalid-email': 'That email address looks invalid.',
      'auth/user-not-found': 'No account found with that email \u2014 try creating one.',
      'auth/missing-password': 'Enter a password.'
    };
    return map[err.code] || ('Something went wrong (' + err.code + ').');
  }

  function showAuthError(err) {
    authError.textContent = friendlyAuthError(err);
    authError.style.display = 'block';
  }

  authForm.addEventListener('submit', function (e) {
    e.preventDefault();
    authError.style.display = 'none';
    signInWithEmailAndPassword(auth, authEmail.value.trim(), authPassword.value).catch(showAuthError);
  });

  signUpBtn.addEventListener('click', function () {
    authError.style.display = 'none';
    var email = authEmail.value.trim(), pass = authPassword.value;
    if (!email || pass.length < 6) {
      authError.textContent = 'Enter an email and a password with at least 6 characters.';
      authError.style.display = 'block';
      return;
    }
    createUserWithEmailAndPassword(auth, email, pass).catch(showAuthError);
  });

  signOutBtn.addEventListener('click', function () { signOut(auth); });

  onAuthStateChanged(auth, function (user) {
    currentUser = user;
    if (user) {
      authGate.style.display = 'none';
      appShell.style.display = 'block';
      userEmailLabel.textContent = user.email;
      resetLocalState();
      loadCatalog(user.uid);
    } else {
      appShell.style.display = 'none';
      authGate.style.display = 'block';
    }
  });

  // ---------- tabs ----------
  var tabBrowseBtn = document.getElementById('tabBrowseBtn');
  var tabTryOnBtn = document.getElementById('tabTryOnBtn');
  var tabAddBtn = document.getElementById('tabAddBtn');
  var pageBrowse = document.getElementById('pageBrowse');
  var pageTryOn = document.getElementById('pageTryOn');
  var pageAdd = document.getElementById('pageAdd');

  function showTab(name) {
    pageBrowse.style.display = name === 'browse' ? 'block' : 'none';
    pageTryOn.style.display = name === 'tryon' ? 'block' : 'none';
    pageAdd.style.display = name === 'add' ? 'block' : 'none';
    tabBrowseBtn.classList.toggle('active', name === 'browse');
    tabTryOnBtn.classList.toggle('active', name === 'tryon');
    tabAddBtn.classList.toggle('active', name === 'add');
    if (name === 'tryon') updateTryOnHint();
    if (name === 'browse') updateSelectedBanner();
  }
  tabBrowseBtn.addEventListener('click', function () { showTab('browse'); });
  tabTryOnBtn.addEventListener('click', function () { showTab('tryon'); });
  tabAddBtn.addEventListener('click', function () { showTab('add'); });

  // ---------- try-on/face elements ----------
  var video = document.getElementById('video');
  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d');
  var placeholder = document.getElementById('placeholder');
  var cameraBtn = document.getElementById('cameraBtn');
  var uploadBtn = document.getElementById('uploadBtn');
  var fileInput = document.getElementById('fileInput');
  var captureBtn = document.getElementById('captureBtn');
  var calibBanner = document.getElementById('calibBanner');
  var recalBtn = document.getElementById('recalBtn');
  var retakeBtn = document.getElementById('retakeBtn');
  var fitRow = document.getElementById('fitRow');
  var fitSize = document.getElementById('fitSize');
  var fitSizeVal = document.getElementById('fitSizeVal');
  var noSelectionNote = document.getElementById('noSelectionNote');
  var noSelectionText = document.getElementById('noSelectionText');
  var noSelectionBtn = document.getElementById('noSelectionBtn');
  var similarLabel = document.getElementById('similarLabel');
  var similarRow = document.getElementById('similarRow');

  // ---------- browse elements ----------
  var filterBar = document.getElementById('filterBar');
  var libraryRow = document.getElementById('libraryRow');
  var catalogNote = document.getElementById('catalogNote');
  var selectedBanner = document.getElementById('selectedBanner');
  var selectedThumbWrap = document.getElementById('selectedThumbWrap');
  var selectedText = document.getElementById('selectedText');
  var goTryOnBtn = document.getElementById('goTryOnBtn');
  goTryOnBtn.addEventListener('click', function () { showTab('tryon'); });

  // ---------- select mode / bulk edit elements ----------
  var selectModeBtn = document.getElementById('selectModeBtn');
  var bulkBar = document.getElementById('bulkBar');
  var bulkCountLabel = document.getElementById('bulkCountLabel');
  var bulkShapeChips = document.getElementById('bulkShapeChips');
  var bulkColorChips = document.getElementById('bulkColorChips');
  var bulkGenderChips = document.getElementById('bulkGenderChips');
  var bulkRimChips = document.getElementById('bulkRimChips');
  var applyBulkBtn = document.getElementById('applyBulkBtn');
  var exitSelectModeBtn = document.getElementById('exitSelectModeBtn');

  // ---------- single-frame edit elements ----------
  var editTagsPanel = document.getElementById('editTagsPanel');
  var editThumbWrap = document.getElementById('editThumbWrap');
  var editShapeChips = document.getElementById('editShapeChips');
  var editColorChips = document.getElementById('editColorChips');
  var editGenderChips = document.getElementById('editGenderChips');
  var editRimChips = document.getElementById('editRimChips');
  var editFreeTagInput = document.getElementById('editFreeTagInput');
  var editFreeTagList = document.getElementById('editFreeTagList');
  var saveTagsBtn = document.getElementById('saveTagsBtn');
  var cancelEditTagsBtn = document.getElementById('cancelEditTagsBtn');

  // ---------- add-frame elements ----------
  var frameSourceChooser = document.getElementById('frameSourceChooser');
  var frameCalibSectionEl = document.getElementById('frameCalibSection');
  var frameCameraBtn = document.getElementById('frameCameraBtn');
  var frameUploadBtn = document.getElementById('frameUploadBtn');
  var frameFileInputEl = document.getElementById('frameFileInputEl');
  var frameSourcePlaceholder = document.getElementById('frameSourcePlaceholder');
  var frameVideo = document.getElementById('frameVideo');
  var frameCaptureBtn = document.getElementById('frameCaptureBtn');
  var addedMsg = document.getElementById('addedMsg');

  var toleranceRow = document.getElementById('toleranceRow');
  var bgTolerance = document.getElementById('bgTolerance');
  var bgToleranceVal = document.getElementById('bgToleranceVal');
  var trimLeft = document.getElementById('trimLeft');
  var trimRight = document.getElementById('trimRight');
  var trimLeftVal = document.getElementById('trimLeftVal');
  var trimRightVal = document.getElementById('trimRightVal');
  var autoTrimBtn = document.getElementById('autoTrimBtn');
  var eraseSpotBtn = document.getElementById('eraseSpotBtn');
  var eraseSpotHint = document.getElementById('eraseSpotHint');
  var restoreSpotBtn = document.getElementById('restoreSpotBtn');
  var restoreSpotHint = document.getElementById('restoreSpotHint');
  var undoToolBtn = document.getElementById('undoToolBtn');
  var frameCalibCanvas = document.getElementById('frameCalibCanvas');
  var fctx = frameCalibCanvas.getContext('2d');
  var frameCalibBanner = document.getElementById('frameCalibBanner');
  var addToLibraryBtn = document.getElementById('addToLibraryBtn');
  var cancelFrameBtn = document.getElementById('cancelFrameBtn');

  var shapeChips = document.getElementById('shapeChips');
  var colorChips = document.getElementById('colorChips');
  var genderChips = document.getElementById('genderChips');
  var rimChips = document.getElementById('rimChips');
  var freeTagInput = document.getElementById('freeTagInput');
  var tagSuggestions = document.getElementById('tagSuggestions');
  var freeTagList = document.getElementById('freeTagList');

  // ---------- state ----------
  var stream = null;
  var faceHasImage = false;
  var facePoints = [];
  var faceBaseCanvas = document.createElement('canvas');

  var frameStream = null;

  var catalogIndex = [];      // [{id, thumbData, tags}]  -- light, from users/{uid}/frames
  var fullDataCache = {};     // id -> {img, p1, p2}       -- heavy, lazy-loaded from users/{uid}/framesFull
  var activeFrameId = null;
  var allFreeTags = new Set();
  var activeFilters = { shape: new Set(), color: new Set(), gender: new Set(), rim: new Set(), search: '' };

  var pendingRawCanvas = null;
  var pendingProcessedCanvas = document.createElement('canvas');
  var frameCalibPoints = [];
  var pendingTags = { shape: null, color: null, gender: null, rim: null, free: [] };
  var autoTrimSuggested = false;
  var toolHistory = []; // ordered actions: {type:'eraseSpot',x,y} | {type:'eraseStroke',points} | {type:'restoreStroke',points}
  var currentStrokePoints = [];
  var currentStrokeType = null; // 'erase' | 'restore', while a drag is in progress
  var eraseModeActive = false;
  var restoreModeActive = false;
  var eraseDragging = false;
  var eraseDownPos = null;
  var ERASE_DRAG_THRESHOLD = 6;
  var ERASE_BRUSH_RADIUS = 10;

  var selectMode = false;
  var selectedIds = new Set();
  var bulkPending = { shape: null, color: null, gender: null, rim: null };
  var bulkTouched = { shape: false, color: false, gender: false, rim: false };

  var editingFrameId = null;
  var editPendingTags = null;

  function resetLocalState() {
    catalogIndex = []; fullDataCache = {}; activeFrameId = null;
    allFreeTags = new Set();
    activeFilters = { shape: new Set(), color: new Set(), gender: new Set(), rim: new Set(), search: '' };
    faceHasImage = false; facePoints = [];
    placeholder.style.display = 'block';
    placeholder.textContent = 'No image yet. Start your camera or upload a photo to begin.';
    canvas.style.display = 'none'; video.style.display = 'none';
    retakeBtn.style.display = 'none'; fitRow.style.display = 'none';
    libraryRow.innerHTML = '';
    selectMode = false; selectedIds = new Set();
    bulkBar.style.display = 'none';
    editTagsPanel.style.display = 'none'; editingFrameId = null;
  }

  // ---------- helpers ----------

  function capDimensions(w, h, max) {
    if (Math.max(w, h) <= max) return { w: w, h: h };
    var s = max / Math.max(w, h);
    return { w: Math.round(w * s), h: Math.round(h * s) };
  }

  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  function normalizeSearch(s) {
    return (s || '').toLowerCase().replace(/[\u2018\u2019'".,]/g, '');
  }

  function describeTags(tags) {
    var t = tags || {};
    var parts = [t.shape, t.color, t.gender, t.rim].filter(Boolean).map(labelize);
    return parts.length ? parts.join(', ') : 'Untagged frame';
  }

  function findEntry(id) {
    for (var i = 0; i < catalogIndex.length; i++) { if (catalogIndex[i].id === id) return catalogIndex[i]; }
    return null;
  }

  function shrinkToBudget(canvas, maxBytes, mime, quality) {
    mime = mime || 'image/png';
    var toUrl = function (c) { return quality != null ? c.toDataURL(mime, quality) : c.toDataURL(mime); };
    var dataUrl = toUrl(canvas);
    var scale = 1, tries = 0;
    while (dataUrl.length > maxBytes && tries < 7) {
      scale *= 0.82;
      var w = Math.max(80, Math.round(canvas.width * scale));
      var h = Math.max(80, Math.round(canvas.height * scale));
      var tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      tmp.getContext('2d').drawImage(canvas, 0, 0, w, h);
      dataUrl = toUrl(tmp);
      tries++;
    }
    return dataUrl;
  }

  function drawMarkerOn(c, x, y) {
    c.save();
    c.strokeStyle = '#2E7A72';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x - 9, y); c.lineTo(x + 9, y);
    c.moveTo(x, y - 9); c.lineTo(x, y + 9);
    c.stroke();
    c.beginPath();
    c.arc(x, y, 11, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  function drawCheckerboard(c, w, h, cell) {
    cell = cell || 10;
    for (var y = 0; y < h; y += cell) {
      for (var x = 0; x < w; x += cell) {
        var even = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
        c.fillStyle = even ? '#EDEBE6' : '#F8F7F4';
        c.fillRect(x, y, cell, cell);
      }
    }
  }

  // Samples many points along the outer border (not just 4 corners) and builds a
  // coarse, spatially-interpolated background model via inverse-distance weighting.
  // This tracks uneven lighting -- a highlight pooling in the middle of one edge, a
  // shadow gathering in a corner -- far more precisely than a plain corner-to-corner
  // gradient, which is what let stray opaque background survive as leftover clutter,
  // or conversely let translucent frame material near a bright spot get erased as if
  // it were background.
  function buildBackgroundModel(data, w, h) {
    var margin = Math.max(2, Math.round(Math.min(w, h) * 0.035));
    var step = Math.max(4, Math.round(Math.min(w, h) / 50));
    var samples = [];
    function add(x, y) {
      x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
      var i = (y * w + x) * 4;
      samples.push({ x: x, y: y, r: data[i], g: data[i + 1], b: data[i + 2] });
    }
    for (var x = 0; x < w; x += step) { add(x, margin); add(x, h - 1 - margin); }
    for (var y = 0; y < h; y += step) { add(margin, y); add(w - 1 - margin, y); }

    var gridSize = 14;
    var grid = new Array(gridSize * gridSize);
    for (var gy = 0; gy < gridSize; gy++) {
      for (var gx = 0; gx < gridSize; gx++) {
        var px = (gx + 0.5) / gridSize * w, py = (gy + 0.5) / gridSize * h;
        var wsum = 0, rsum = 0, gsum = 0, bsum = 0;
        for (var s = 0; s < samples.length; s++) {
          var sm = samples[s];
          var dx = sm.x - px, dy = sm.y - py;
          var wt = 1 / (dx * dx + dy * dy + 400);
          wsum += wt; rsum += sm.r * wt; gsum += sm.g * wt; bsum += sm.b * wt;
        }
        grid[gy * gridSize + gx] = [rsum / wsum, gsum / wsum, bsum / wsum];
      }
    }
    return { grid: grid, gridSize: gridSize, w: w, h: h };
  }

  function backgroundAt(model, x, y) {
    var gs = model.gridSize;
    var gx = (x / model.w) * gs - 0.5, gy = (y / model.h) * gs - 0.5;
    var gx0 = Math.max(0, Math.min(gs - 1, Math.floor(gx)));
    var gy0 = Math.max(0, Math.min(gs - 1, Math.floor(gy)));
    var gx1 = Math.min(gs - 1, gx0 + 1), gy1 = Math.min(gs - 1, gy0 + 1);
    var fx = Math.max(0, Math.min(1, gx - gx0)), fy = Math.max(0, Math.min(1, gy - gy0));
    var c00 = model.grid[gy0 * gs + gx0], c10 = model.grid[gy0 * gs + gx1];
    var c01 = model.grid[gy1 * gs + gx0], c11 = model.grid[gy1 * gs + gx1];
    var r = (c00[0] * (1 - fx) + c10[0] * fx) * (1 - fy) + (c01[0] * (1 - fx) + c11[0] * fx) * fy;
    var g = (c00[1] * (1 - fx) + c10[1] * fx) * (1 - fy) + (c01[1] * (1 - fx) + c11[1] * fx) * fy;
    var b = (c00[2] * (1 - fx) + c10[2] * fx) * (1 - fy) + (c01[2] * (1 - fx) + c11[2] * fx) * fy;
    return [r, g, b];
  }

  // Removes background by comparing each pixel to the spatially-interpolated model
  // above. Being purely color-based (not connectivity-based) also means it reaches
  // background-colored pixels trapped inside an enclosed area, like the surface
  // visible through a lens opening, which a border-seeded flood fill never could.
  // Shrinks the opaque region inward by `r` in a separable pass (min-filter along
  // each axis), then grows it back out by the same amount with dilateAlpha. Run
  // together this is a standard "opening": it snips off anything only as wide as a thin bridge
  // (a reflection connected to the rim by a sliver of similarly-lit plastic) while
  // leaving the substantial frame itself basically untouched, so the size-based
  // region-keeping step below can then correctly recognize and discard the artifact.
  function erodeAlpha(data, w, h, r) {
    var src = new Uint8ClampedArray(w * h);
    for (var p = 0; p < w * h; p++) src[p] = data[p * 4 + 3];
    var tmp = new Uint8ClampedArray(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var m = 255;
        for (var dx = -r; dx <= r; dx++) {
          var nx = x + dx; if (nx < 0 || nx >= w) continue;
          var v = src[y * w + nx]; if (v < m) m = v;
        }
        tmp[y * w + x] = m;
      }
    }
    var out = new Uint8ClampedArray(w * h);
    for (var y2 = 0; y2 < h; y2++) {
      for (var x2 = 0; x2 < w; x2++) {
        var m2 = 255;
        for (var dy = -r; dy <= r; dy++) {
          var ny = y2 + dy; if (ny < 0 || ny >= h) continue;
          var v2 = tmp[ny * w + x2]; if (v2 < m2) m2 = v2;
        }
        out[y2 * w + x2] = m2;
      }
    }
    for (var i = 0; i < w * h; i++) data[i * 4 + 3] = out[i];
  }

  function dilateAlpha(data, w, h, r) {
    var src = new Uint8ClampedArray(w * h);
    for (var p = 0; p < w * h; p++) src[p] = data[p * 4 + 3];
    var tmp = new Uint8ClampedArray(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var m = 0;
        for (var dx = -r; dx <= r; dx++) {
          var nx = x + dx; if (nx < 0 || nx >= w) continue;
          var v = src[y * w + nx]; if (v > m) m = v;
        }
        tmp[y * w + x] = m;
      }
    }
    var out = new Uint8ClampedArray(w * h);
    for (var y2 = 0; y2 < h; y2++) {
      for (var x2 = 0; x2 < w; x2++) {
        var m2 = 0;
        for (var dy = -r; dy <= r; dy++) {
          var ny = y2 + dy; if (ny < 0 || ny >= h) continue;
          var v2 = tmp[ny * w + x2]; if (v2 > m2) m2 = v2;
        }
        out[y2 * w + x2] = m2;
      }
    }
    for (var i = 0; i < w * h; i++) data[i * 4 + 3] = out[i];
  }

  function removeBackground(imageData, tolerance) {
    var data = imageData.data, w = imageData.width, h = imageData.height;
    var model = buildBackgroundModel(data, w, h);
    var soft = Math.max(8, tolerance * 0.6);

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var bg = backgroundAt(model, x, y);
        var i = (y * w + x) * 4;
        var dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2];
        var d = Math.sqrt(dr * dr + dg * dg + db * db);
        if (d < tolerance) data[i + 3] = 0;
        else if (d < tolerance + soft) data[i + 3] = Math.round(255 * (d - tolerance) / soft);
      }
    }

    var openRadius = 2;
    erodeAlpha(data, w, h, openRadius);
    dilateAlpha(data, w, h, openRadius);

    keepLargeOpaqueRegions(imageData);
    featherEdges(imageData);
  }

  // After the color pass, anything opaque that's fully disconnected from the main
  // frame silhouette is almost always clutter -- a finger, a reflection, a shadow
  // blob. But a very translucent frame can occasionally get cut through at a thin
  // point (a temple arm catching a highlight) and split into two real pieces, so
  // this keeps every region big enough to plausibly be part of the frame, not just
  // the single largest one, and only discards genuinely small leftover islands.
  function keepLargeOpaqueRegions(imageData) {
    var data = imageData.data, w = imageData.width, h = imageData.height;
    var n = w * h;
    var labels = new Int32Array(n).fill(-1);
    var qx = new Int32Array(n), qy = new Int32Array(n);
    var sizes = [];

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var id = y * w + x;
        if (labels[id] !== -1) continue;
        if (data[id * 4 + 3] < 10) { labels[id] = -2; continue; }
        var label = sizes.length;
        var qHead = 0, qTail = 0;
        qx[qTail] = x; qy[qTail] = y; qTail++;
        labels[id] = label;
        var count = 0;
        while (qHead < qTail) {
          var cx = qx[qHead], cy = qy[qHead]; qHead++;
          count++;
          var neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
          for (var k = 0; k < 4; k++) {
            var nx = neighbors[k][0], ny = neighbors[k][1];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            var nid = ny * w + nx;
            if (labels[nid] !== -1) continue;
            if (data[nid * 4 + 3] < 10) { labels[nid] = -2; continue; }
            labels[nid] = label;
            qx[qTail] = nx; qy[qTail] = ny; qTail++;
          }
        }
        sizes.push(count);
      }
    }

    if (!sizes.length) return;
    var maxSize = 0;
    for (var l = 0; l < sizes.length; l++) if (sizes[l] > maxSize) maxSize = sizes[l];
    var keepThreshold = Math.max(30, maxSize * 0.12);
    for (var id2 = 0; id2 < n; id2++) {
      if (labels[id2] >= 0 && sizes[labels[id2]] < keepThreshold) data[id2 * 4 + 3] = 0;
    }
  }

  // Light feather so the hard flood-fill cutout doesn't leave jagged pixel edges --
  // only touches pixels adjacent to an alpha transition, so solid interior/exterior
  // regions are left untouched.
  function featherEdges(imageData) {
    var data = imageData.data, w = imageData.width, h = imageData.height;
    var origA = new Uint8ClampedArray(w * h);
    for (var p = 0; p < w * h; p++) origA[p] = data[p * 4 + 3];
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var id = y * w + x;
        var a = origA[id], an = origA[id - w], as = origA[id + w], ae = origA[id + 1], aw = origA[id - 1];
        if (a === an && a === as && a === ae && a === aw) continue;
        data[id * 4 + 3] = Math.round((a * 4 + an + as + ae + aw) / 8);
      }
    }
  }

  // Manual cleanup for whatever the automatic passes above don't catch (usually
  // clutter that happens to touch the frame silhouette, so it survives the
  // largest-region pass too). Erases the connected opaque blob under (x0, y0).
  // Capped so an accidental tap on the frame itself can't wipe out the whole thing.
  function eraseConnectedComponent(imageData, x0, y0) {
    var data = imageData.data, w = imageData.width, h = imageData.height;
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return false;
    var startId = y0 * w + x0;
    if (data[startId * 4 + 3] < 10) return false;

    var n = w * h;
    var visited = new Uint8Array(n);
    var qx = new Int32Array(n), qy = new Int32Array(n);
    var qHead = 0, qTail = 0;
    qx[qTail] = x0; qy[qTail] = y0; qTail++;
    visited[startId] = 1;
    var cap = Math.max(2000, Math.round(n * 0.15));
    var collected = [startId];

    while (qHead < qTail) {
      var cx = qx[qHead], cy = qy[qHead]; qHead++;
      if (collected.length > cap) return false; // too big to be a stray artifact -- bail out untouched
      var neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
      for (var k = 0; k < 4; k++) {
        var nx = neighbors[k][0], ny = neighbors[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var nid = ny * w + nx;
        if (visited[nid]) continue;
        visited[nid] = 1;
        if (data[nid * 4 + 3] < 10) continue;
        collected.push(nid);
        qx[qTail] = nx; qy[qTail] = ny; qTail++;
      }
    }
    if (collected.length > cap) return false;
    collected.forEach(function (id) { data[id * 4 + 3] = 0; });
    return true;
  }

  // Deliberate paint-to-erase, used when the user drags rather than taps.
  // Unlike the spot eraser above, this has no size cap -- a drag is unambiguous
  // intent, so it can clear something as large as a hand holding the frame.
  function eraseBrush(imageData, cx, cy, radius) {
    var data = imageData.data, w = imageData.width, h = imageData.height;
    var r2 = radius * radius;
    var minX = Math.max(0, Math.floor(cx - radius)), maxX = Math.min(w - 1, Math.ceil(cx + radius));
    var minY = Math.max(0, Math.floor(cy - radius)), maxY = Math.min(h - 1, Math.ceil(cy + radius));
    for (var y = minY; y <= maxY; y++) {
      for (var x = minX; x <= maxX; x++) {
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) data[(y * w + x) * 4 + 3] = 0;
      }
    }
  }

  // The counterpart to eraseBrush: paints original, fully-opaque pixels back in from
  // the untouched raw photo. This is the honest fallback for a genuinely translucent
  // frame, where no automatic color-based pass can perfectly tell "clear plastic with
  // background showing through" apart from actual background -- when the automatic
  // pass takes a bit too much off a thin or backlit section, this brings it back.
  function restoreBrush(rawImageData, workingImageData, cx, cy, radius) {
    var rd = rawImageData.data, wd = workingImageData.data;
    var w = workingImageData.width, h = workingImageData.height;
    var r2 = radius * radius;
    var minX = Math.max(0, Math.floor(cx - radius)), maxX = Math.min(w - 1, Math.ceil(cx + radius));
    var minY = Math.max(0, Math.floor(cy - radius)), maxY = Math.min(h - 1, Math.ceil(cy + radius));
    for (var y = minY; y <= maxY; y++) {
      for (var x = minX; x <= maxX; x++) {
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          var i = (y * w + x) * 4;
          wd[i] = rd[i]; wd[i + 1] = rd[i + 1]; wd[i + 2] = rd[i + 2]; wd[i + 3] = 255;
        }
      }
    }
  }

  function trimSides(imageData, leftFrac, rightFrac) {
    var data = imageData.data;
    var w = imageData.width, h = imageData.height;
    var leftCut = Math.round(w * leftFrac);
    var rightCut = Math.round(w * (1 - rightFrac));
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (x < leftCut || x >= rightCut) {
          var i = (y * w + x) * 4;
          data[i + 3] = 0;
        }
      }
    }
  }

  // Estimates how much of each side is thin temple arm vs. the substantial lens/bridge
  // front, by comparing how many opaque pixels sit in each column. Arms are consistently
  // thin; the front is consistently tall, so the transition point is a reasonable cut line.
  function suggestTrim(imageData) {
    var data = imageData.data, w = imageData.width, h = imageData.height;
    var colCount = new Array(w).fill(0);
    for (var y = 0; y < h; y++) {
      var rowStart = y * w * 4;
      for (var x = 0; x < w; x++) {
        if (data[rowStart + x * 4 + 3] > 10) colCount[x]++;
      }
    }
    var maxCount = 0;
    for (var i = 0; i < w; i++) if (colCount[i] > maxCount) maxCount = colCount[i];
    if (maxCount < 6) return { left: 0, right: 0 };

    var threshold = maxCount * 0.35;
    var sustain = Math.max(2, Math.round(w * 0.012));

    var leftEdge = 0;
    while (leftEdge < w && colCount[leftEdge] === 0) leftEdge++;
    var run = 0, leftLensStart = leftEdge;
    for (var x1 = leftEdge; x1 < w; x1++) {
      if (colCount[x1] >= threshold) { run++; if (run >= sustain) { leftLensStart = x1 - run + 1; break; } }
      else run = 0;
    }

    var rightEdge = w - 1;
    while (rightEdge >= 0 && colCount[rightEdge] === 0) rightEdge--;
    run = 0;
    var rightLensEnd = rightEdge;
    for (var x2 = rightEdge; x2 >= 0; x2--) {
      if (colCount[x2] >= threshold) { run++; if (run >= sustain) { rightLensEnd = x2 + run - 1; break; } }
      else run = 0;
    }

    var leftTrim = Math.min(0.35, Math.max(0, leftLensStart - leftEdge) / w);
    var rightTrim = Math.min(0.35, Math.max(0, rightEdge - rightLensEnd) / w);
    return { left: leftTrim, right: rightTrim };
  }

  // ---------- face photo / try-on (session-only, never persisted) ----------

  function redrawFacePreview() {
    if (!faceHasImage) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(faceBaseCanvas, 0, 0);
    if (facePoints.length < 2) {
      facePoints.forEach(function (p) { drawMarkerOn(ctx, p.x, p.y); });
      return;
    }
    if (!activeFrameId) return;
    var thisId = activeFrameId;
    getFullFrameData(thisId).then(function (full) {
      if (activeFrameId !== thisId) return;
      drawFrameOnFace(full, facePoints[0], facePoints[1]);
    }).catch(function (e) { console.error('Could not load frame data', e); });
  }

  function getFullFrameData(id) {
    if (fullDataCache[id]) return Promise.resolve(fullDataCache[id]);
    if (!currentUser) return Promise.reject(new Error('Not signed in'));
    return getDoc(doc(db, 'users', currentUser.uid, 'framesFull', id)).then(function (snap) {
      if (!snap.exists()) throw new Error('Frame data missing');
      var data = snap.data();
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var result = { img: img, p1: data.p1, p2: data.p2 };
          fullDataCache[id] = result;
          resolve(result);
        };
        img.onerror = reject;
        img.src = data.imageData;
      });
    });
  }

  function drawFrameOnFace(full, faceP1, faceP2) {
    var frameD = dist(full.p1, full.p2);
    if (frameD < 1) return;
    var frameAngle = Math.atan2(full.p2.y - full.p1.y, full.p2.x - full.p1.x);
    var frameMid = { x: (full.p1.x + full.p2.x) / 2, y: (full.p1.y + full.p2.y) / 2 };
    var faceD = dist(faceP1, faceP2);
    var faceAngle = Math.atan2(faceP2.y - faceP1.y, faceP2.x - faceP1.x);
    var faceMid = { x: (faceP1.x + faceP2.x) / 2, y: (faceP1.y + faceP2.y) / 2 };

    var rotationDelta = faceAngle - frameAngle;
    while (rotationDelta > Math.PI) rotationDelta -= 2 * Math.PI;
    while (rotationDelta <= -Math.PI) rotationDelta += 2 * Math.PI;
    if (Math.abs(rotationDelta) > Math.PI / 2) {
      rotationDelta += (rotationDelta > 0 ? -Math.PI : Math.PI);
    }

    var userScale = fitSize.value / 100;
    var scale = (faceD / frameD) * userScale;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(faceBaseCanvas, 0, 0);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(faceMid.x, faceMid.y);
    ctx.rotate(rotationDelta);
    ctx.scale(scale, scale);
    ctx.translate(-frameMid.x, -frameMid.y);
    ctx.drawImage(full.img, 0, 0);
    ctx.restore();
  }

  function updateCalibBanner() {
    if (!faceHasImage) { calibBanner.style.display = 'none'; return; }
    if (facePoints.length === 0) {
      calibBanner.textContent = 'Tap one pupil in the photo to size the frame.';
      calibBanner.style.display = 'block';
      recalBtn.style.display = 'none';
      fitRow.style.display = 'none';
    } else if (facePoints.length === 1) {
      calibBanner.textContent = 'Now tap the other pupil.';
      calibBanner.style.display = 'block';
      recalBtn.style.display = 'none';
      fitRow.style.display = 'none';
    } else {
      calibBanner.style.display = 'none';
      recalBtn.style.display = 'inline-block';
      fitRow.style.display = 'block';
    }
  }

  function updateTryOnHint() {
    if (!catalogIndex.length) {
      noSelectionNote.style.display = 'flex';
      noSelectionText.textContent = "There's nothing in the catalog yet.";
      noSelectionBtn.textContent = 'Add your first frame \u2192';
      noSelectionBtn.onclick = function () { showTab('add'); };
    } else if (!activeFrameId) {
      noSelectionNote.style.display = 'flex';
      noSelectionText.textContent = 'No frame selected yet.';
      noSelectionBtn.textContent = 'Browse the catalog \u2192';
      noSelectionBtn.onclick = function () { showTab('browse'); };
    } else {
      noSelectionNote.style.display = 'none';
    }
  }

  function updateSelectedBanner() {
    var entry = activeFrameId ? findEntry(activeFrameId) : null;
    if (!entry) { selectedBanner.style.display = 'none'; return; }
    selectedBanner.style.display = 'flex';
    selectedThumbWrap.innerHTML = '';
    var img = document.createElement('img');
    img.src = entry.thumbData;
    selectedThumbWrap.appendChild(img);
    selectedText.textContent = 'Selected: ' + describeTags(entry.tags);
  }

  function updateSimilarCarousel() {
    similarRow.innerHTML = '';
    var active = activeFrameId ? findEntry(activeFrameId) : null;
    if (!active) { similarLabel.style.display = 'none'; similarRow.style.display = 'none'; return; }

    var pool = catalogIndex.filter(function (e) { return e.id !== activeFrameId; });
    var sameShape = active.tags.shape ? pool.filter(function (e) { return e.tags.shape === active.tags.shape; }) : [];
    var sameColor = active.tags.color ? pool.filter(function (e) { return e.tags.color === active.tags.color; }) : [];
    var list = sameShape.length ? sameShape : (sameColor.length ? sameColor : pool);
    list = list.slice(0, 8);

    if (!list.length) { similarLabel.style.display = 'none'; similarRow.style.display = 'none'; return; }

    similarLabel.textContent = sameShape.length ? 'More ' + labelize(active.tags.shape) + ' frames' : 'You might also like';
    similarLabel.style.display = 'block';
    similarRow.style.display = 'flex';

    list.forEach(function (e) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'similar-item';
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.src = e.thumbData;
      item.appendChild(img);
      var cap = document.createElement('span');
      cap.textContent = describeTags(e.tags);
      item.appendChild(cap);
      item.addEventListener('click', function () { selectFrame(e.id); });
      similarRow.appendChild(item);
    });
  }

  function startCamera() {
    stopStream();
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }).then(function (s) {
      stream = s;
      video.srcObject = stream;
      return video.play();
    }).then(function () {
      faceHasImage = false;
      facePoints = [];
      placeholder.style.display = 'none';
      video.style.display = 'block';
      canvas.style.display = 'none';
      captureBtn.style.display = 'inline-block';
      retakeBtn.style.display = 'none';
      updateCalibBanner();
    }).catch(function () {
      placeholder.textContent = "Couldn't access the camera (permission denied or unavailable). Try uploading a photo instead.";
      placeholder.style.display = 'block';
      video.style.display = 'none';
    });
  }

  function stopStream() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  function capturePhoto() {
    var capped = capDimensions(video.videoWidth || 640, video.videoHeight || 480, MAX_FACE_DIM);
    var w = capped.w, h = capped.h;
    faceBaseCanvas.width = w; faceBaseCanvas.height = h;
    canvas.width = w; canvas.height = h;
    var bctx = faceBaseCanvas.getContext('2d');
    bctx.setTransform(-1, 0, 0, 1, w, 0);
    bctx.drawImage(video, 0, 0, w, h);
    bctx.setTransform(1, 0, 0, 1, 0, 0);

    stopStream();
    faceHasImage = true;
    facePoints = [];
    fitSize.value = 100; fitSizeVal.textContent = '100%';
    video.style.display = 'none';
    canvas.style.display = 'block';
    captureBtn.style.display = 'none';
    retakeBtn.style.display = 'inline-block';
    redrawFacePreview();
    updateCalibBanner();
    track('customer_session_started', { source: 'camera' });
  }

  function handleFaceUpload(file) {
    stopStream();
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var capped = capDimensions(img.naturalWidth, img.naturalHeight, MAX_FACE_DIM);
      faceBaseCanvas.width = capped.w; faceBaseCanvas.height = capped.h;
      canvas.width = capped.w; canvas.height = capped.h;
      faceBaseCanvas.getContext('2d').drawImage(img, 0, 0, capped.w, capped.h);

      faceHasImage = true;
      facePoints = [];
      fitSize.value = 100; fitSizeVal.textContent = '100%';
      placeholder.style.display = 'none';
      video.style.display = 'none';
      canvas.style.display = 'block';
      captureBtn.style.display = 'none';
      retakeBtn.style.display = 'inline-block';
      redrawFacePreview();
      updateCalibBanner();
      URL.revokeObjectURL(url);
      track('customer_session_started', { source: 'upload' });
    };
    img.src = url;
  }

  function retakeFace() {
    stopStream();
    faceHasImage = false;
    facePoints = [];
    fitSize.value = 100; fitSizeVal.textContent = '100%';
    placeholder.textContent = 'No image yet. Start your camera or upload a photo to begin.';
    placeholder.style.display = 'block';
    video.style.display = 'none';
    canvas.style.display = 'none';
    captureBtn.style.display = 'none';
    retakeBtn.style.display = 'none';
    updateCalibBanner();
  }

  canvas.addEventListener('click', function (e) {
    if (!faceHasImage || facePoints.length >= 2) return;
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    facePoints.push({ x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY });
    updateCalibBanner();
    redrawFacePreview();
  });

  cameraBtn.addEventListener('click', startCamera);
  uploadBtn.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) handleFaceUpload(e.target.files[0]);
  });
  captureBtn.addEventListener('click', capturePhoto);
  recalBtn.addEventListener('click', function () { facePoints = []; updateCalibBanner(); redrawFacePreview(); });
  retakeBtn.addEventListener('click', retakeFace);
  fitSize.addEventListener('input', function () { fitSizeVal.textContent = fitSize.value + '%'; redrawFacePreview(); });

  // ---------- add-frame tags ----------

  function renderAddChips() {
    renderChipGroup(shapeChips, 'shape', pendingTags.shape, function (v) { pendingTags.shape = v; });
    renderChipGroup(colorChips, 'color', pendingTags.color, function (v) { pendingTags.color = v; });
    renderChipGroup(genderChips, 'gender', pendingTags.gender, function (v) { pendingTags.gender = v; });
    renderChipGroup(rimChips, 'rim', pendingTags.rim, function (v) { pendingTags.rim = v; });
  }

  function resetTagInputs() {
    pendingTags = { shape: null, color: null, gender: null, rim: null, free: [] };
    renderAddChips();
    freeTagInput.value = '';
    renderFreeTagList();
  }
  renderAddChips();

  function renderFreeTagList() {
    freeTagList.innerHTML = '';
    pendingTags.free.forEach(function (t) {
      var chip = document.createElement('span');
      chip.className = 'tag-chip removable';
      chip.appendChild(document.createTextNode(t + ' '));
      var x = document.createElement('span');
      x.textContent = '\u00d7';
      x.addEventListener('click', function () {
        pendingTags.free = pendingTags.free.filter(function (f) { return f !== t; });
        renderFreeTagList();
      });
      chip.appendChild(x);
      freeTagList.appendChild(chip);
    });
  }

  function refreshTagSuggestions() {
    tagSuggestions.innerHTML = '';
    Array.from(allFreeTags).sort().forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t;
      tagSuggestions.appendChild(opt);
    });
  }

  freeTagInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var t = freeTagInput.value.trim().toLowerCase();
      if (t && pendingTags.free.indexOf(t) === -1) {
        pendingTags.free.push(t);
        renderFreeTagList();
        if (!allFreeTags.has(t)) { allFreeTags.add(t); refreshTagSuggestions(); }
      }
      freeTagInput.value = '';
    }
  });

  // ---------- single-frame tag editing ----------

  function renderEditFreeTagList() {
    editFreeTagList.innerHTML = '';
    editPendingTags.free.forEach(function (t) {
      var chip = document.createElement('span');
      chip.className = 'tag-chip removable';
      chip.appendChild(document.createTextNode(t + ' '));
      var x = document.createElement('span');
      x.textContent = '\u00d7';
      x.addEventListener('click', function () {
        editPendingTags.free = editPendingTags.free.filter(function (f) { return f !== t; });
        renderEditFreeTagList();
      });
      chip.appendChild(x);
      editFreeTagList.appendChild(chip);
    });
  }

  function openEditTags(id) {
    var entry = findEntry(id);
    if (!entry) return;
    editingFrameId = id;
    var t = entry.tags || {};
    editPendingTags = { shape: t.shape || null, color: t.color || null, gender: t.gender || null, rim: t.rim || null, free: (t.free || []).slice() };

    editThumbWrap.innerHTML = '';
    var img = document.createElement('img');
    img.src = entry.thumbData;
    editThumbWrap.appendChild(img);

    renderChipGroup(editShapeChips, 'shape', editPendingTags.shape, function (v) { editPendingTags.shape = v; });
    renderChipGroup(editColorChips, 'color', editPendingTags.color, function (v) { editPendingTags.color = v; });
    renderChipGroup(editGenderChips, 'gender', editPendingTags.gender, function (v) { editPendingTags.gender = v; });
    renderChipGroup(editRimChips, 'rim', editPendingTags.rim, function (v) { editPendingTags.rim = v; });
    renderEditFreeTagList();
    editFreeTagInput.value = '';

    editTagsPanel.style.display = 'block';
    editTagsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeEditTags() {
    editTagsPanel.style.display = 'none';
    editingFrameId = null;
    editPendingTags = null;
  }

  editFreeTagInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var t = editFreeTagInput.value.trim().toLowerCase();
      if (t && editPendingTags.free.indexOf(t) === -1) {
        editPendingTags.free.push(t);
        renderEditFreeTagList();
        if (!allFreeTags.has(t)) { allFreeTags.add(t); refreshTagSuggestions(); }
      }
      editFreeTagInput.value = '';
    }
  });

  cancelEditTagsBtn.addEventListener('click', closeEditTags);

  saveTagsBtn.addEventListener('click', function () {
    if (!editingFrameId || !currentUser || !editPendingTags) return;
    var id = editingFrameId;
    var newTags = {
      shape: editPendingTags.shape, color: editPendingTags.color,
      gender: editPendingTags.gender, rim: editPendingTags.rim,
      free: editPendingTags.free.slice()
    };
    saveTagsBtn.disabled = true;
    updateDoc(doc(db, 'users', currentUser.uid, 'frames', id), { tags: newTags }).then(function () {
      var entry = findEntry(id);
      if (entry) entry.tags = newTags;
      saveTagsBtn.disabled = false;
      renderLibrary();
      rebuildFilterBar();
      applyFilters();
      if (activeFrameId === id) updateSelectedBanner();
      closeEditTags();
    }).catch(function (e) {
      console.error('Failed to save tags', e);
      saveTagsBtn.disabled = false;
    });
  });

  // ---------- select mode / bulk tag editing ----------

  function renderBulkChips() {
    renderChipGroup(bulkShapeChips, 'shape', bulkPending.shape, function (v) { bulkPending.shape = v; bulkTouched.shape = true; updateApplyBulkState(); });
    renderChipGroup(bulkColorChips, 'color', bulkPending.color, function (v) { bulkPending.color = v; bulkTouched.color = true; updateApplyBulkState(); });
    renderChipGroup(bulkGenderChips, 'gender', bulkPending.gender, function (v) { bulkPending.gender = v; bulkTouched.gender = true; updateApplyBulkState(); });
    renderChipGroup(bulkRimChips, 'rim', bulkPending.rim, function (v) { bulkPending.rim = v; bulkTouched.rim = true; updateApplyBulkState(); });
  }

  function updateBulkCountLabel() {
    bulkCountLabel.textContent = selectedIds.size + ' selected';
  }

  function updateApplyBulkState() {
    var anyTouched = bulkTouched.shape || bulkTouched.color || bulkTouched.gender || bulkTouched.rim;
    applyBulkBtn.disabled = !(selectedIds.size > 0 && anyTouched);
  }

  function enterSelectMode() {
    selectMode = true;
    selectedIds = new Set();
    bulkPending = { shape: null, color: null, gender: null, rim: null };
    bulkTouched = { shape: false, color: false, gender: false, rim: false };
    renderBulkChips();
    bulkBar.style.display = 'block';
    updateBulkCountLabel();
    updateApplyBulkState();
    renderLibrary();
  }

  function exitSelectMode() {
    selectMode = false;
    selectedIds = new Set();
    bulkBar.style.display = 'none';
    renderLibrary();
  }

  selectModeBtn.addEventListener('click', enterSelectMode);
  exitSelectModeBtn.addEventListener('click', exitSelectMode);

  applyBulkBtn.addEventListener('click', function () {
    if (!currentUser || !selectedIds.size) return;
    applyBulkBtn.disabled = true;
    var uid = currentUser.uid;
    var patch = {};
    if (bulkTouched.shape) patch.shape = bulkPending.shape;
    if (bulkTouched.color) patch.color = bulkPending.color;
    if (bulkTouched.gender) patch.gender = bulkPending.gender;
    if (bulkTouched.rim) patch.rim = bulkPending.rim;

    var ids = Array.from(selectedIds);
    var writes = ids.map(function (id) {
      var entry = findEntry(id);
      if (!entry) return Promise.resolve();
      var newTags = Object.assign({}, entry.tags, patch);
      return updateDoc(doc(db, 'users', uid, 'frames', id), { tags: newTags }).then(function () {
        entry.tags = newTags;
      });
    });

    Promise.all(writes).then(function () {
      rebuildFilterBar();
      exitSelectMode();
    }).catch(function (e) {
      console.error('Bulk tag update failed', e);
      applyBulkBtn.disabled = false;
    });
  });

  // ---------- filtering ----------

  function frameMatchesFilters(tags) {
    var t = tags || {};
    if (activeFilters.shape.size && !activeFilters.shape.has(t.shape)) return false;
    if (activeFilters.color.size && !activeFilters.color.has(t.color)) return false;
    if (activeFilters.gender.size && !activeFilters.gender.has(t.gender)) return false;
    if (activeFilters.rim.size && !activeFilters.rim.has(t.rim)) return false;
    if (activeFilters.search) {
      var hay = normalizeSearch([t.shape, t.color, t.gender, t.rim].concat(t.free || []).filter(Boolean).join(' '));
      if (hay.indexOf(activeFilters.search) === -1) return false;
    }
    return true;
  }

  function applyFilters() {
    var cards = libraryRow.querySelectorAll('.frame-card');
    for (var i = 0; i < cards.length; i++) {
      var entry = findEntry(cards[i].dataset.id);
      cards[i].style.display = (entry && frameMatchesFilters(entry.tags)) ? '' : 'none';
    }
  }

  function appendFilterGroup(label, facet, values) {
    if (!values.size) return;
    var wrap = document.createElement('div');
    wrap.className = 'filter-group';
    var lab = document.createElement('div');
    lab.className = 'slider-label';
    lab.textContent = label;
    wrap.appendChild(lab);
    var row = document.createElement('div');
    row.className = 'chip-row';
    Array.from(values).sort().forEach(function (v) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (activeFilters[facet].has(v) ? ' active' : '');
      chip.textContent = labelize(v);
      chip.addEventListener('click', function () {
        if (activeFilters[facet].has(v)) activeFilters[facet].delete(v);
        else activeFilters[facet].add(v);
        chip.classList.toggle('active');
        applyFilters();
      });
      row.appendChild(chip);
    });
    wrap.appendChild(row);
    filterBar.appendChild(wrap);
  }

  function rebuildFilterBar() {
    filterBar.innerHTML = '';
    if (!catalogIndex.length) { filterBar.style.display = 'none'; return; }
    filterBar.style.display = 'block';

    var shapes = new Set(), colors = new Set(), genders = new Set(), rims = new Set();
    catalogIndex.forEach(function (e) {
      var t = e.tags || {};
      if (t.shape) shapes.add(t.shape);
      if (t.color) colors.add(t.color);
      if (t.gender) genders.add(t.gender);
      if (t.rim) rims.add(t.rim);
    });

    appendFilterGroup('Shape', 'shape', shapes);
    appendFilterGroup('Color', 'color', colors);
    appendFilterGroup('Gender', 'gender', genders);
    appendFilterGroup('Rim type', 'rim', rims);

    var searchWrap = document.createElement('div');
    searchWrap.className = 'filter-search-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search tags\u2026';
    input.value = activeFilters.search;
    input.addEventListener('input', function () { activeFilters.search = normalizeSearch(input.value); applyFilters(); });
    searchWrap.appendChild(input);
    filterBar.appendChild(searchWrap);

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn ghost';
    clearBtn.textContent = 'Clear filters';
    clearBtn.addEventListener('click', function () {
      activeFilters = { shape: new Set(), color: new Set(), gender: new Set(), rim: new Set(), search: '' };
      rebuildFilterBar();
      applyFilters();
    });
    filterBar.appendChild(clearBtn);
  }

  // ---------- browse: card grid ----------

  function renderLibrary() {
    libraryRow.innerHTML = '';
    catalogIndex.forEach(function (entry) {
      var isSelected = selectMode && selectedIds.has(entry.id);
      var card = document.createElement('div');
      card.className = 'frame-card' + (isSelected ? ' selected' : '');
      card.dataset.id = entry.id;

      var mark = document.createElement('span');
      mark.className = 'frame-card-select-mark';
      card.appendChild(mark);

      if (!selectMode) {
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'frame-card-remove';
        rm.textContent = '\u00d7';
        rm.setAttribute('aria-label', 'Remove frame');
        rm.addEventListener('click', function (e) { e.stopPropagation(); removeFrame(entry.id); });
        card.appendChild(rm);
      }

      var imgWrap = document.createElement('div');
      imgWrap.className = 'frame-card-image';
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = describeTags(entry.tags);
      img.src = entry.thumbData;
      imgWrap.appendChild(img);
      card.appendChild(imgWrap);

      var tagsWrap = document.createElement('div');
      tagsWrap.className = 'frame-card-tags';
      var parts = [entry.tags.shape, entry.tags.color, entry.tags.gender, entry.tags.rim].filter(Boolean);
      if (!parts.length) {
        var span = document.createElement('span');
        span.className = 'tag-chip';
        span.textContent = 'Untagged';
        tagsWrap.appendChild(span);
      } else {
        parts.forEach(function (p) {
          var s = document.createElement('span');
          s.className = 'tag-chip';
          s.textContent = labelize(p);
          tagsWrap.appendChild(s);
        });
      }
      card.appendChild(tagsWrap);

      if (!selectMode) {
        var actions = document.createElement('div');
        actions.className = 'frame-card-actions';

        var tryBtn = document.createElement('button');
        tryBtn.type = 'button';
        tryBtn.className = 'btn primary frame-card-tryon';
        tryBtn.textContent = 'Try it on';
        tryBtn.addEventListener('click', function (e) { e.stopPropagation(); selectFrame(entry.id); });
        actions.appendChild(tryBtn);

        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn ghost frame-card-edit';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', function (e) { e.stopPropagation(); openEditTags(entry.id); });
        actions.appendChild(editBtn);

        card.appendChild(actions);
      }

      card.addEventListener('click', function () {
        if (selectMode) {
          if (selectedIds.has(entry.id)) selectedIds.delete(entry.id); else selectedIds.add(entry.id);
          card.classList.toggle('selected');
          updateBulkCountLabel();
          updateApplyBulkState();
        } else {
          selectFrame(entry.id);
        }
      });

      libraryRow.appendChild(card);
    });
    applyFilters();
  }

  function updateCatalogNote() {
    catalogNote.textContent = catalogIndex.length
      ? catalogIndex.length + ' frame' + (catalogIndex.length === 1 ? '' : 's') + ' in the catalog.'
      : 'Nothing saved yet \u2014 add the first frame on the Add Frames tab.';
  }

  function removeFrame(id) {
    if (!currentUser) return;
    catalogIndex = catalogIndex.filter(function (f) { return f.id !== id; });
    delete fullDataCache[id];
    selectedIds.delete(id);
    var el = libraryRow.querySelector('[data-id="' + id + '"]');
    if (el) el.parentNode.removeChild(el);
    if (activeFrameId === id) { activeFrameId = null; redrawFacePreview(); }
    updateCatalogNote();
    rebuildFilterBar();
    applyFilters();
    updateSelectedBanner();
    updateTryOnHint();
    updateSimilarCarousel();

    var uid = currentUser.uid;
    deleteDoc(doc(db, 'users', uid, 'frames', id)).catch(function (e) { console.error('Failed to delete frame doc', e); });
    deleteDoc(doc(db, 'users', uid, 'framesFull', id)).catch(function (e) { console.error('Failed to delete frame data', e); });
  }

  function selectFrame(id) {
    activeFrameId = id;
    var cards = libraryRow.querySelectorAll('.frame-card');
    for (var i = 0; i < cards.length; i++) cards[i].classList.toggle('active', cards[i].dataset.id === id);
    updateSelectedBanner();
    updateTryOnHint();
    updateSimilarCarousel();
    redrawFacePreview();
    var entry = findEntry(id);
    if (entry) {
      track('frame_tried_on', {
        shape: entry.tags.shape || 'untagged',
        color: entry.tags.color || 'untagged',
        rim: entry.tags.rim || 'untagged'
      });
    }
  }

  function loadCatalog(uid) {
    return getDocs(collection(db, 'users', uid, 'frames')).then(function (snap) {
      catalogIndex = [];
      snap.forEach(function (d) {
        var data = d.data();
        if (data.tags && data.tags.free) data.tags.free.forEach(function (t) { allFreeTags.add(t); });
        catalogIndex.push({ id: d.id, thumbData: data.thumbData, tags: data.tags || {} });
      });
      refreshTagSuggestions();
      renderLibrary();
      rebuildFilterBar();
      updateCatalogNote();
      updateTryOnHint();
      updateSimilarCarousel();
    }).catch(function (e) {
      console.error('Failed to load catalog', e);
      catalogIndex = [];
      updateCatalogNote();
      updateTryOnHint();
    });
  }

  // ---------- add-frame: source (camera or upload) ----------

  function showFrameCalibSection() {
    frameSourceChooser.style.display = 'none';
    frameCalibSectionEl.style.display = 'block';
  }
  function showFrameSourceChooser() {
    frameSourceChooser.style.display = 'block';
    frameCalibSectionEl.style.display = 'none';
  }

  function beginAddFrameFromSource(source, naturalW, naturalH) {
    var capped = capDimensions(naturalW, naturalH, MAX_FRAME_DIM);
    pendingRawCanvas = document.createElement('canvas');
    pendingRawCanvas.width = capped.w; pendingRawCanvas.height = capped.h;
    pendingRawCanvas.getContext('2d').drawImage(source, 0, 0, capped.w, capped.h);

    frameCalibPoints = [];
    toleranceRow.style.display = 'block';
    autoTrimSuggested = false;
    toolHistory = [];
    setTool('none');
    updateUndoState();
    trimLeft.value = 0; trimRight.value = 0;
    trimLeftVal.textContent = '0%'; trimRightVal.textContent = '0%';
    resetTagInputs();
    showFrameCalibSection();
    processPendingFrame();
  }

  function openAddFrameFromFile(file) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      beginAddFrameFromSource(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  function startFrameCamera() {
    stopFrameStream();
    addedMsg.style.display = 'none';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(function (s) {
      frameStream = s;
      frameVideo.srcObject = frameStream;
      return frameVideo.play();
    }).then(function () {
      frameSourcePlaceholder.style.display = 'none';
      frameVideo.style.display = 'block';
      frameCaptureBtn.style.display = 'inline-block';
    }).catch(function () {
      frameSourcePlaceholder.textContent = "Couldn't access the camera (permission denied or unavailable). Try uploading a photo instead.";
      frameSourcePlaceholder.style.display = 'block';
      frameVideo.style.display = 'none';
    });
  }

  function stopFrameStream() {
    if (frameStream) { frameStream.getTracks().forEach(function (t) { t.stop(); }); frameStream = null; }
  }

  function captureFramePhoto() {
    var w = frameVideo.videoWidth || 640, h = frameVideo.videoHeight || 480;
    var tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').drawImage(frameVideo, 0, 0, w, h);
    stopFrameStream();
    frameVideo.style.display = 'none';
    frameCaptureBtn.style.display = 'none';
    beginAddFrameFromSource(tmp, w, h);
  }

  frameCameraBtn.addEventListener('click', startFrameCamera);
  frameUploadBtn.addEventListener('click', function () {
    addedMsg.style.display = 'none';
    frameFileInputEl.value = '';
    frameFileInputEl.click();
  });
  frameFileInputEl.addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) openAddFrameFromFile(e.target.files[0]);
  });
  frameCaptureBtn.addEventListener('click', captureFramePhoto);

  // ---------- add-frame: processing + calibration + tags ----------

  function processPendingFrame() {
    if (!pendingRawCanvas) return;
    var w = pendingRawCanvas.width, h = pendingRawCanvas.height;
    pendingProcessedCanvas.width = w;
    pendingProcessedCanvas.height = h;
    var pctx = pendingProcessedCanvas.getContext('2d', { willReadFrequently: true });
    pctx.clearRect(0, 0, w, h);
    pctx.drawImage(pendingRawCanvas, 0, 0);
    var imgData = pctx.getImageData(0, 0, w, h);
    removeBackground(imgData, parseInt(bgTolerance.value, 10));

    if (!autoTrimSuggested) {
      var suggestion = suggestTrim(imgData);
      trimLeft.value = Math.round(suggestion.left * 100);
      trimRight.value = Math.round(suggestion.right * 100);
      trimLeftVal.textContent = trimLeft.value + '%';
      trimRightVal.textContent = trimRight.value + '%';
      autoTrimSuggested = true;
    }

    trimSides(imgData, trimLeft.value / 100, trimRight.value / 100);

    var needsRaw = currentStrokeType === 'restore';
    for (var hIdx = 0; !needsRaw && hIdx < toolHistory.length; hIdx++) {
      if (toolHistory[hIdx].type === 'restoreStroke') needsRaw = true;
    }
    var rawData = needsRaw ? pendingRawCanvas.getContext('2d').getImageData(0, 0, w, h) : null;

    function applyToolAction(action) {
      if (action.type === 'eraseSpot') eraseConnectedComponent(imgData, action.x, action.y);
      else if (action.type === 'eraseStroke') action.points.forEach(function (p) { eraseBrush(imgData, p.x, p.y, p.radius); });
      else if (action.type === 'restoreStroke') action.points.forEach(function (p) { restoreBrush(rawData, imgData, p.x, p.y, p.radius); });
    }
    toolHistory.forEach(applyToolAction);
    if (currentStrokePoints.length) {
      applyToolAction({ type: currentStrokeType === 'erase' ? 'eraseStroke' : 'restoreStroke', points: currentStrokePoints });
    }

    pctx.putImageData(imgData, 0, 0);

    frameCalibCanvas.width = w;
    frameCalibCanvas.height = h;
    drawFrameCalibView();
  }

  function drawFrameCalibView() {
    var w = frameCalibCanvas.width, h = frameCalibCanvas.height;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, w, h);
    drawCheckerboard(fctx, w, h, Math.max(6, Math.round(w / 60)));
    fctx.drawImage(pendingProcessedCanvas, 0, 0);
    frameCalibPoints.forEach(function (p) { drawMarkerOn(fctx, p.x, p.y); });
    updateFrameCalibBanner();
  }

  function updateFrameCalibBanner() {
    addToLibraryBtn.disabled = frameCalibPoints.length < 2;
    if (frameCalibPoints.length === 0) frameCalibBanner.textContent = 'Tap one lens center, then the other.';
    else if (frameCalibPoints.length === 1) frameCalibBanner.textContent = 'Now tap the other lens center.';
    else frameCalibBanner.textContent = 'Ready \u2014 add it to your library.';
  }

  bgTolerance.addEventListener('input', function () {
    bgToleranceVal.textContent = bgTolerance.value;
    processPendingFrame();
  });
  trimLeft.addEventListener('input', function () { trimLeftVal.textContent = trimLeft.value + '%'; processPendingFrame(); });
  trimRight.addEventListener('input', function () { trimRightVal.textContent = trimRight.value + '%'; processPendingFrame(); });
  autoTrimBtn.addEventListener('click', function () { autoTrimSuggested = false; processPendingFrame(); });

  function setTool(tool) {
    eraseModeActive = (tool === 'erase');
    restoreModeActive = (tool === 'restore');
    eraseSpotBtn.classList.toggle('active', eraseModeActive);
    restoreSpotBtn.classList.toggle('active', restoreModeActive);
    eraseSpotHint.style.display = eraseModeActive ? 'block' : 'none';
    restoreSpotHint.style.display = restoreModeActive ? 'block' : 'none';
    frameCalibCanvas.style.cursor = (eraseModeActive || restoreModeActive) ? 'crosshair' : '';
    eraseDragging = false;
    eraseDownPos = null;
    currentStrokePoints = [];
    currentStrokeType = null;
  }
  eraseSpotBtn.addEventListener('click', function () { setTool(eraseModeActive ? 'none' : 'erase'); });
  restoreSpotBtn.addEventListener('click', function () { setTool(restoreModeActive ? 'none' : 'restore'); });

  function imagePosFromEvent(e) {
    var rect = frameCalibCanvas.getBoundingClientRect();
    var scaleX = frameCalibCanvas.width / rect.width, scaleY = frameCalibCanvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function updateUndoState() {
    undoToolBtn.disabled = !toolHistory.length;
  }

  function undoLastToolAction() {
    if (!toolHistory.length) return;
    toolHistory.pop();
    processPendingFrame();
    updateUndoState();
  }
  undoToolBtn.addEventListener('click', undoLastToolAction);

  frameCalibCanvas.addEventListener('click', function (e) {
    if (!pendingRawCanvas || eraseModeActive || restoreModeActive) return; // handled by the pointer events below
    if (frameCalibPoints.length >= 2) return;
    var pos = imagePosFromEvent(e);
    frameCalibPoints.push({ x: Math.round(pos.x), y: Math.round(pos.y) });
    drawFrameCalibView();
  });

  frameCalibCanvas.addEventListener('pointerdown', function (e) {
    if (!pendingRawCanvas || (!eraseModeActive && !restoreModeActive)) return;
    eraseDownPos = imagePosFromEvent(e);
    eraseDragging = false;
    currentStrokePoints = [];
    currentStrokeType = eraseModeActive ? 'erase' : 'restore';
    frameCalibCanvas.setPointerCapture(e.pointerId);
  });

  frameCalibCanvas.addEventListener('pointermove', function (e) {
    if (!pendingRawCanvas || (!eraseModeActive && !restoreModeActive) || !eraseDownPos) return;
    var pos = imagePosFromEvent(e);
    var dx = pos.x - eraseDownPos.x, dy = pos.y - eraseDownPos.y;
    if (!eraseDragging && Math.sqrt(dx * dx + dy * dy) > ERASE_DRAG_THRESHOLD) {
      eraseDragging = true;
      currentStrokePoints.push({ x: eraseDownPos.x, y: eraseDownPos.y, radius: ERASE_BRUSH_RADIUS });
    }
    if (eraseDragging) {
      currentStrokePoints.push({ x: pos.x, y: pos.y, radius: ERASE_BRUSH_RADIUS });
      processPendingFrame();
    }
  });

  frameCalibCanvas.addEventListener('pointerup', function (e) {
    if (!pendingRawCanvas || (!eraseModeActive && !restoreModeActive) || !eraseDownPos) { eraseDownPos = null; return; }
    if (!eraseDragging) {
      if (eraseModeActive) {
        toolHistory.push({ type: 'eraseSpot', x: Math.round(eraseDownPos.x), y: Math.round(eraseDownPos.y) });
      } else {
        toolHistory.push({ type: 'restoreStroke', points: [{ x: eraseDownPos.x, y: eraseDownPos.y, radius: ERASE_BRUSH_RADIUS }] });
      }
    } else {
      toolHistory.push({ type: currentStrokeType === 'erase' ? 'eraseStroke' : 'restoreStroke', points: currentStrokePoints.slice() });
    }
    currentStrokePoints = [];
    currentStrokeType = null;
    eraseDownPos = null;
    eraseDragging = false;
    processPendingFrame();
    updateUndoState();
  });

  function makeThumbCanvas(imgSource, size) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var tctx = c.getContext('2d');
    var iw = imgSource.width, ih = imgSource.height;
    var scale = Math.min(size / iw, size / ih) * 0.92;
    var dw = iw * scale, dh = ih * scale;
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(imgSource, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return c;
  }

  addToLibraryBtn.addEventListener('click', function () {
    if (frameCalibPoints.length < 2 || !currentUser) return;
    addToLibraryBtn.disabled = true;
    var uid = currentUser.uid;
    var id = 'f' + Date.now() + '_' + Math.floor(Math.random() * 10000);

    var fullCanvas = document.createElement('canvas');
    fullCanvas.width = pendingProcessedCanvas.width;
    fullCanvas.height = pendingProcessedCanvas.height;
    fullCanvas.getContext('2d').drawImage(pendingProcessedCanvas, 0, 0);
    var thumbCanvas = makeThumbCanvas(pendingProcessedCanvas, THUMB_DIM);

    var fullData = shrinkToBudget(fullCanvas, FULL_BYTE_BUDGET, 'image/png');
    var thumbData = shrinkToBudget(thumbCanvas, THUMB_BYTE_BUDGET, 'image/png');

    var p1 = frameCalibPoints[0], p2 = frameCalibPoints[1];
    var tags = { shape: pendingTags.shape, color: pendingTags.color, gender: pendingTags.gender, rim: pendingTags.rim, free: pendingTags.free.slice() };

    Promise.all([
      setDoc(doc(db, 'users', uid, 'frames', id), { thumbData: thumbData, tags: tags, createdAt: serverTimestamp() }),
      setDoc(doc(db, 'users', uid, 'framesFull', id), { imageData: fullData, p1: p1, p2: p2 })
    ]).then(function () {
      var img = new Image();
      img.onload = function () { fullDataCache[id] = { img: img, p1: p1, p2: p2 }; };
      img.src = fullData;

      catalogIndex.push({ id: id, thumbData: thumbData, tags: tags });
      renderLibrary();
      rebuildFilterBar();
      applyFilters();
      updateCatalogNote();
      track('frame_added', { shape: tags.shape || 'untagged', color: tags.color || 'untagged', rim: tags.rim || 'untagged' });

      pendingRawCanvas = null;
      frameSourcePlaceholder.textContent = 'No frame photo yet.\nUse your camera or upload a photo of a frame.';
      frameSourcePlaceholder.style.display = 'block';
      showFrameSourceChooser();
      addedMsg.style.display = 'block';
      selectFrame(id);
    }).catch(function (e) {
      console.error('Failed to add frame', e);
      addToLibraryBtn.disabled = false;
      frameCalibBanner.textContent = 'Something went wrong saving this frame \u2014 check the console and try again.';
    });
  });

  cancelFrameBtn.addEventListener('click', function () {
    pendingRawCanvas = null;
    frameCalibPoints = [];
    toolHistory = [];
    setTool('none');
    updateUndoState();
    showFrameSourceChooser();
  });

  window.addEventListener('beforeunload', function () { stopStream(); stopFrameStream(); });
})();
