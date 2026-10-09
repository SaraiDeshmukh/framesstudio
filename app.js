import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getAnalytics, isSupported, logEvent } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-analytics.js";
// MediaPipe is pinned to a tested version (JS and WASM must match; an unpinned
// URL silently picks up new major versions).
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
import { PoseSmoother, poseFromLandmarks, frameTransform, drawFrame } from './tracking.js';
import { estimateHeadPose, HeadPoseFilter, eulerFromMatrix } from './headpose.js';
import { createTryOnRenderer, DEFAULT_PD_MM } from './ar-renderer.js';
import { cleanSize, sizeLabel } from './glasses-model.js';

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
      loadPhotoCount(user.uid);
    } else {
      stopLive();
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
  var photoCountDisplay = document.getElementById('photoCountDisplay');
  var pageAdd = document.getElementById('pageAdd');

  function showTab(name) {
    pageBrowse.style.display = name === 'browse' ? 'block' : 'none';
    pageTryOn.style.display = name === 'tryon' ? 'block' : 'none';
    pageAdd.style.display = name === 'add' ? 'block' : 'none';
    tabBrowseBtn.classList.toggle('active', name === 'browse');
    tabTryOnBtn.classList.toggle('active', name === 'tryon');
    tabAddBtn.classList.toggle('active', name === 'add');
    if (name === 'tryon') updateTryOnHint();
    if (name !== 'tryon') stopLive();   // never leave the camera running in the background
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
  var photoCatalogBtn = document.getElementById('photoCatalogBtn');
  var photoToggleBtn = document.getElementById('photoToggleBtn');
  var photoOverlayOn = true;
  var retakeBtn = document.getElementById('retakeBtn');
  var fitRow = document.getElementById('fitRow');
  var fitSize = document.getElementById('fitSize');
  var fitSizeVal = document.getElementById('fitSizeVal');
  var noSelectionNote = document.getElementById('noSelectionNote');
  var noSelectionText = document.getElementById('noSelectionText');
  var noSelectionBtn = document.getElementById('noSelectionBtn');
  var similarLabel = document.getElementById('similarLabel');
  var similarRow = document.getElementById('similarRow');
  var photoStage = document.getElementById('photoStage');
  var livePd = document.getElementById('livePd');
  var photoPd = document.getElementById('photoPd');

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
  var bgModeSingleBtn = document.getElementById('bgModeSingleBtn');
  var bgModeTwoShotBtn = document.getElementById('bgModeTwoShotBtn');
  var bgModeAiBtn = document.getElementById('bgModeAiBtn');
  var bgModeHint = document.getElementById('bgModeHint');
  var bgModeAiHint = document.getElementById('bgModeAiHint');
  var twoShotStepRow = document.getElementById('twoShotStepRow');
  var twoShotStepLabel = document.getElementById('twoShotStepLabel');
  var retakeBgBtn = document.getElementById('retakeBgBtn');
  var bgTolerance = document.getElementById('bgTolerance');
  var bgToleranceVal = document.getElementById('bgToleranceVal');
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

  var sizeEye = document.getElementById('sizeEye');
  var sizeBridge = document.getElementById('sizeBridge');
  var sizeTemple = document.getElementById('sizeTemple');
  var frontOnlySection = document.getElementById('frontOnlySection');
  var framePhotoLabel = document.getElementById('framePhotoLabel');
  var sideTarget = document.getElementById('sideTarget');
  var sideTargetThumb = document.getElementById('sideTargetThumb');
  var sideTargetText = document.getElementById('sideTargetText');
  var sideTargetCancel = document.getElementById('sideTargetCancel');
  var sideTargetHint = document.getElementById('sideTargetHint');
  var addedMsgText = document.getElementById('addedMsgText');
  var addSideAfterBtn = document.getElementById('addSideAfterBtn');
  var modelPreview = document.getElementById('modelPreview');
  var modelPreviewStage = document.getElementById('modelPreviewStage');
  var modelPreviewYaw = document.getElementById('modelPreviewYaw');
  var modelPreviewHint = document.getElementById('modelPreviewHint');

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
  var detectingPupils = false;
  var faceBaseCanvas = document.createElement('canvas');
  // When the photo's face was found automatically: its landmarks and 3D head pose,
  // so the frame is drawn in 3D. null = manual taps / 2D overlay.
  var photo3d = null;

  var frameStream = null;

  var catalogIndex = [];      // [{id, thumbData, tags}]  -- light, from users/{uid}/frames
  var fullDataCache = {};     // id -> {img, p1, p2}       -- heavy, lazy-loaded from users/{uid}/framesFull
  var activeFrameId = null;
  var allFreeTags = new Set();
  var activeFilters = { shape: new Set(), color: new Set(), gender: new Set(), rim: new Set(), search: '' };

  var pendingRawCanvas = null;
  var pendingBgOnlyCanvas = null; // the empty-surface reference photo, only used in two-shot mode
  var pendingAiRemovedCanvas = null; // the remove.bg result, only used in AI mode
  var aiRemovalLoading = false;
  var REMOVEBG_WORKER_URL = 'https://removebg-proxy.thesaraideshmukh.workers.dev/';
  var bgRemovalMode = 'single'; // 'single' | 'twoShot' | 'ai'
  var twoShotStep = 1; // 1 = capturing the empty surface, 2 = capturing the frame on it
  var pendingProcessedCanvas = document.createElement('canvas');
  var frameCalibPoints = [];
  var pendingTags = { shape: null, color: null, gender: null, rim: null, free: [] };
  var toolHistory = []; // ordered actions: {type:'eraseStroke',points} | {type:'restoreStroke',points} -- a tap is just a 1-point stroke
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
  var editSizeEye = document.getElementById('editSizeEye');
  var editSizeBridge = document.getElementById('editSizeBridge');
  var editSizeTemple = document.getElementById('editSizeTemple');
  var editSideStatus = document.getElementById('editSideStatus');
  var editSideBtn = document.getElementById('editSideBtn');

  // What the Add Frames page is photographing: a new frame's front, or the temple
  // (side view) of an existing frame, used for its 3D temples.
  var addTarget = { kind: 'front', frameId: null };
  var lastAddedId = null;
  var SIDE_BYTE_BUDGET = 700000;

  // 3D preview of the model generated from the photo being added (own renderer).
  var preview = { renderer: null, promise: null, key: null, seq: 0, timer: 0, failed: false };

  function readSize(eye, bridge, temple) {
    return cleanSize({ eye: eye.value, bridge: bridge.value, temple: temple.value });
  }
  function fillSize(size, eye, bridge, temple) {
    eye.value = size && size.eye ? size.eye : '';
    bridge.value = size && size.bridge ? size.bridge : '';
    temple.value = size && size.temple ? size.temple : '';
  }

  function resetLocalState() {
    if (ar.renderer) { ar.renderer.dispose(); }
    ar.renderer = null; ar.promise = null; ar.frameKey = null; ar.loadingKey = null; ar.failedKey = null;
    sideCache = {};
    photo3d = null;
    livePd.value = ''; photoPd.value = '';
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

  // Tags plus the recorded size (if any), e.g. "Round, Tortoise \u00b7 49\u25A121 145".
  function describeFrame(entry) {
    if (!entry) return '';
    var size = sizeLabel(entry.size);
    return describeTags(entry.tags) + (size ? ' \u00b7 ' + size : '');
  }

  function findEntry(id) {
    for (var i = 0; i < catalogIndex.length; i++) { if (catalogIndex[i].id === id) return catalogIndex[i]; }
    return null;
  }

  function shrinkToBudget(canvas, maxBytes, mime, quality) {
    return shrinkToBudgetScaled(canvas, maxBytes, mime, quality).dataUrl;
  }

  // Same, but also reports the final pixel size, so points tapped on the original
  // canvas (lens centres, hinge) can be scaled to match the saved image.
  function shrinkToBudgetScaled(canvas, maxBytes, mime, quality) {
    mime = mime || 'image/png';
    var toUrl = function (c) { return quality != null ? c.toDataURL(mime, quality) : c.toDataURL(mime); };
    var dataUrl = toUrl(canvas);
    var scale = 1, tries = 0, w = canvas.width, h = canvas.height;
    while (dataUrl.length > maxBytes && tries < 7) {
      scale *= 0.82;
      w = Math.max(80, Math.round(canvas.width * scale));
      h = Math.max(80, Math.round(canvas.height * scale));
      var tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      tmp.getContext('2d').drawImage(canvas, 0, 0, w, h);
      dataUrl = toUrl(tmp);
      tries++;
    }
    return { dataUrl: dataUrl, w: w, h: h, sx: w / canvas.width, sy: h / canvas.height };
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

  // The two-shot alternative: instead of estimating what the background probably
  // looks like, this compares against an actual photo of the same empty surface.
  // Exact subtraction beats any estimate -- no assumption about the border being
  // background, no getting fooled by a gradient the model didn't fit well. Requires
  // the two photos to be taken from the same camera position; any drift between them
  // shows up as a false edge, which is why the UI asks the person to keep it still.
  function removeBackgroundDiff(imageData, bgOnlyImageData, tolerance) {
    var data = imageData.data, bgData = bgOnlyImageData.data;
    var w = imageData.width, h = imageData.height;
    var soft = Math.max(8, tolerance * 0.6);

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var dr = data[i] - bgData[i], dg = data[i + 1] - bgData[i + 1], db = data[i + 2] - bgData[i + 2];
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

  // Manual cleanup for whatever the automatic passes above don't catch. A tap and a
  // drag now both use the same simple brush below -- no size cap, no connectivity
  // logic to second-guess -- so it behaves exactly the same and just as reliably
  // whether you're dabbing away one small speck or dragging across a whole band of
  // arm visible through the lens opening.
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

  // ---------- face photo / try-on (session-only, never persisted) ----------

  function redrawFacePreview() {
    if (!faceHasImage) { hidePhotoAr(); return; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(faceBaseCanvas, 0, 0);
    if (facePoints.length < 2) {
      hidePhotoAr();
      facePoints.forEach(function (p) { drawMarkerOn(ctx, p.x, p.y); });
      return;
    }
    if (!activeFrameId || !photoOverlayOn) { hidePhotoAr(); return; }
    var thisId = activeFrameId;
    var draw2d = function () {
      hidePhotoAr();
      getFullFrameData(thisId).then(function (full) {
        if (activeFrameId !== thisId) return;
        drawFrameOnFace(full, facePoints[0], facePoints[1]);
      }).catch(function (e) { console.error('Could not load frame data', e); });
    };
    if (!photo3d || !photo3d.pose) { draw2d(); return; }
    var shot = photo3d;
    ensureRenderer().then(function (r) {
      if (!r) return false;
      return arUseFrame(thisId);
    }).then(function (ok) {
      if (activeFrameId !== thisId || photo3d !== shot || !faceHasImage || !photoOverlayOn) return;
      if (!ok) { draw2d(); return; }           // no WebGL, or this frame's photo can't be turned into 3D
      var r = ar.renderer;
      r.attach(photoStage);
      r.setSize(canvas.width, canvas.height);
      r.setFit(fitSize.value / 100);
      r.setVisible(true);
      r.setExposure(shot.exposure);
      r.resetFaceFit();
      r.renderFace(shot.pose, shot.lm);
    });
  }

  function hidePhotoAr() {
    if (ar.renderer && ar.renderer.canvas.parentNode === photoStage) ar.renderer.detach();
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
          var result = { img: img, p1: scalePoint(data.p1, data, img), p2: scalePoint(data.p2, data, img) };
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
    updateCatalogButtons();
    if (!faceHasImage) {
      calibBanner.style.display = 'none';
      recalBtn.style.display = 'none';
      fitRow.style.display = 'none';
      return;
    }
    if (detectingPupils) {
      calibBanner.textContent = 'Finding the pupils automatically\u2026';
      calibBanner.style.display = 'block';
      recalBtn.style.display = 'none';
      fitRow.style.display = 'none';
    } else if (facePoints.length === 0) {
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
    selectedText.textContent = 'Selected: ' + describeFrame(entry);
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
      cap.textContent = describeFrame(e);
      item.appendChild(cap);
      item.addEventListener('click', function () { selectFrame(e.id); });
      similarRow.appendChild(item);
    });
  }

  // 'ideal' is only a soft preference -- some browsers/devices don't reliably honor
  // it and default to the front camera anyway. 'exact' forces the issue; if a device
  // genuinely can't satisfy it (rare, but possible on some hardware), fall back to
  // the soft preference rather than failing outright.
  function getBackCameraStream() {
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: 'environment' } }, audio: false })
      .catch(function () {
        return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      });
  }

  function startCamera() {
    stopStream();
    getBackCameraStream().then(function (s) {
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

  var MP_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
  var MP_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

  // Loaded once, on first use, not eagerly on page load -- the model is a real
  // download and most visits to this app never touch the Try On tab at all.
  var faceLandmarkerPromise = null;
  function getFaceLandmarker() {
    if (!faceLandmarkerPromise) {
      faceLandmarkerPromise = FilesetResolver.forVisionTasks(MP_WASM).then(function (filesetResolver) {
        return FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: MP_MODEL
          },
          runningMode: "IMAGE",
          numFaces: 1
        });
      });
    }
    return faceLandmarkerPromise;
  }

  var lastPhotoLandmarks = null;     // full landmarks from the last automatic detection

  // Runs automatic detection on the photo and, when a face is found, sets up the
  // 3D overlay (photo3d). Falls back to the manual two-tap flow otherwise.
  var photoSeq = 0;                  // bumped per photo, so a slow detection can't land on a newer one
  function detectFaceInPhoto() {
    var seq = ++photoSeq;
    detectingPupils = true;
    photo3d = null;
    lastPhotoLandmarks = null;
    updateCalibBanner();
    var w = faceBaseCanvas.width, h = faceBaseCanvas.height;
    detectPupilsAutomatically(faceBaseCanvas).then(function (points) {
      if (seq !== photoSeq) return;
      detectingPupils = false;
      if (points) {
        facePoints = points;
        var pose = lastPhotoLandmarks ? estimateHeadPose(lastPhotoLandmarks, w, h) : null;
        if (pose) photo3d = { lm: lastPhotoLandmarks, pose: pose, exposure: measureExposure(faceBaseCanvas, lastPhotoLandmarks, w, h) };
      }
      redrawFacePreview();
      updateCalibBanner();
    });
  }

  function midpointOf(a, b) {
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // Tries to find both pupils automatically in the given canvas. Resolves with two
  // pixel-coordinate points on success, or null if no face was found, the model
  // failed to load, or anything else went wrong -- callers treat null exactly like
  // "no taps yet" and fall straight back into the existing manual tap flow, so this
  // can only ever save a step, never block one.
  function detectPupilsAutomatically(sourceCanvas) {
    return getFaceLandmarker().then(function (landmarker) {
      var result = landmarker.detect(sourceCanvas);
      var landmarks = result && result.faceLandmarks && result.faceLandmarks[0];
      if (!landmarks || !landmarks.length) return null;
      lastPhotoLandmarks = landmarks;
      var w = sourceCanvas.width, h = sourceCanvas.height;
      var left, right;
      if (landmarks.length >= 478) {
        left = landmarks[468]; right = landmarks[473]; // iris centers
      } else {
        // No iris landmarks in this result for some reason -- approximate eye
        // center from the inner/outer corner points of the base 468-point mesh.
        left = midpointOf(landmarks[33], landmarks[133]);
        right = midpointOf(landmarks[362], landmarks[263]);
      }
      if (!left || !right) return null;
      return [{ x: left.x * w, y: left.y * h }, { x: right.x * w, y: right.y * h }];
    }).catch(function (e) {
      console.error('Automatic pupil detection failed', e);
      return null;
    });
  }

  function capturePhoto() {
    var capped = capDimensions(video.videoWidth || 640, video.videoHeight || 480, MAX_FACE_DIM);
    var w = capped.w, h = capped.h;
    faceBaseCanvas.width = w; faceBaseCanvas.height = h;
    canvas.width = w; canvas.height = h;
    var bctx = faceBaseCanvas.getContext('2d');
    bctx.drawImage(video, 0, 0, w, h);

    stopStream();
    faceHasImage = true;
    facePoints = [];
    fitSize.value = 100; fitSizeVal.textContent = '100%';
    video.style.display = 'none';
    canvas.style.display = 'block';
    captureBtn.style.display = 'none';
    retakeBtn.style.display = 'inline-block';
    redrawFacePreview();
    detectFaceInPhoto();
    track('customer_session_started', { source: 'camera' });
    bumpPhotoCount();
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
      detectFaceInPhoto();
      URL.revokeObjectURL(url);
      track('customer_session_started', { source: 'upload' });
      bumpPhotoCount();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      placeholder.textContent = "That file couldn't be opened as an image. Try a JPEG or PNG photo.";
      placeholder.style.display = 'block';
    };
    img.src = url;
  }

  function retakeFace() {
    stopStream();
    faceHasImage = false;
    facePoints = [];
    photo3d = null;
    lastPhotoLandmarks = null;
    photoSeq++;
    detectingPupils = false;
    hidePhotoAr();
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

  cameraBtn.addEventListener('click', function () { stopLive(); startCamera(); });
  uploadBtn.addEventListener('click', function () { stopLive(); fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) handleFaceUpload(e.target.files[0]);
  });
  captureBtn.addEventListener('click', capturePhoto);
  // Manual taps replace the automatic fit (and its 3D pose) with the 2D overlay.
  recalBtn.addEventListener('click', function () { facePoints = []; photo3d = null; updateCalibBanner(); redrawFacePreview(); });
  retakeBtn.addEventListener('click', retakeFace);
  photoCatalogBtn.addEventListener('click', function () { showInCatalog(activeFrameId); });
  photoToggleBtn.addEventListener('click', function () {
    photoOverlayOn = !photoOverlayOn;
    updateCatalogButtons();
    redrawFacePreview();
  });
  fitSize.addEventListener('input', function () { fitSizeVal.textContent = fitSize.value + '%'; redrawFacePreview(); });

  // ---------- 3D renderer (shared by live and photo try-on; see ar-renderer.js) ----------
  // Loaded on first use. If WebGL is missing or three.js can't load, everything
  // falls back to the flat 2D overlay.

  var ar = { renderer: null, promise: null, failed: false, frameKey: null, loadingKey: null, loadingPromise: null, failedKey: null };
  var sideCache = {};   // id -> Promise<{img, hinge, tip} | null>

  function ensureRenderer() {
    if (ar.renderer) return Promise.resolve(ar.renderer);
    if (ar.failed) return Promise.resolve(null);
    if (!ar.promise) {
      ar.promise = createTryOnRenderer().then(function (r) {
        ar.renderer = r;
        r.setPD(customerPD());
        return r;
      }).catch(function (e) {
        console.warn('3D try-on unavailable on this device; using the flat overlay', e);
        ar.failed = true;
        return null;
      });
    }
    return ar.promise;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  // Points stored with a photo refer to the canvas it was saved from (imgW x imgH).
  function scalePoint(pt, data, img) {
    if (!pt) return pt;
    var w = data.imgW, h = data.imgH;
    if (!w || !h) {
      var f = legacyShrinkFactor(img);
      return f === 1 ? pt : { x: pt.x * f, y: pt.y * f };
    }
    if (w === img.naturalWidth && h === img.naturalHeight) return pt;
    return { x: pt.x * img.naturalWidth / w, y: pt.y * img.naturalHeight / h };
  }

  // Frames saved before imgW/imgH were recorded: if the photo had to be shrunk
  // (by 0.82 per step) to fit in Firestore, its lens points were left in the
  // original 700 px coordinates. Such images have a tell-tale long side.
  function legacyShrinkFactor(img) {
    var long = Math.max(img.naturalWidth, img.naturalHeight), s = 1;
    for (var n = 1; n <= 7; n++) {
      s *= 0.82;
      if (Math.abs(long - Math.max(80, Math.round(MAX_FRAME_DIM * s))) <= 1) return long / MAX_FRAME_DIM;
    }
    return 1;
  }

  function getSideData(id) {
    var entry = findEntry(id);
    if (!entry || !entry.hasSide || !currentUser) return Promise.resolve(null);
    if (!sideCache[id]) {
      sideCache[id] = getDoc(doc(db, 'users', currentUser.uid, 'framesSide', id)).then(function (snap) {
        if (!snap.exists()) return null;
        var d = snap.data();
        return loadImage(d.imageData).then(function (img) {
          return { img: img, hinge: scalePoint(d.hinge, d, img), tip: scalePoint(d.tip, d, img) };
        });
      }).catch(function (e) {
        console.error('Could not load the temple photo', e);
        delete sideCache[id];
        return null;
      });
    }
    return sideCache[id];
  }

  function getTryOnFrame(id) {
    var entry = findEntry(id);
    return Promise.all([getFullFrameData(id), getSideData(id)]).then(function (r) {
      return { img: r[0].img, p1: r[0].p1, p2: r[0].p2, tags: (entry && entry.tags) || {}, size: entry ? entry.size : null, side: r[1] };
    });
  }

  // Makes the renderer show frame `id`; resolves true when it's ready, false if it
  // can't be shown in 3D (then the caller uses the 2D overlay for this frame).
  function arUseFrame(id) {
    var r = ar.renderer;
    if (!r || !id) return Promise.resolve(false);
    if (ar.failedKey === id) return Promise.resolve(false);
    if (ar.frameKey === id && r.current) return Promise.resolve(true);
    if (ar.loadingKey === id && ar.loadingPromise) return ar.loadingPromise;
    ar.loadingKey = id;
    ar.loadingPromise = getTryOnFrame(id).then(function (data) {
      if (ar.loadingKey !== id) return ar.frameKey === id;
      var res = r.setFrame(id, data);
      ar.loadingKey = null;
      if (!res.ok) {
        console.warn('Frame ' + id + ' cannot be shown in 3D: ' + res.reason);
        ar.failedKey = id; ar.frameKey = null;
        return false;
      }
      ar.frameKey = id;
      return true;
    }).catch(function (e) {
      console.error('Could not prepare frame for 3D', e);
      if (ar.loadingKey === id) { ar.loadingKey = null; ar.failedKey = id; }
      return false;
    });
    return ar.loadingPromise;
  }

  // Drop cached 3D data for a frame after its photo, size or tags change.
  function arForget(id) {
    if (ar.renderer) ar.renderer.forget(id);
    if (ar.frameKey === id) ar.frameKey = null;
    if (ar.failedKey === id) ar.failedKey = null;
    delete sideCache[id];
  }

  // Average brightness of the forehead and cheeks, relative to a well-lit face,
  // so the frame isn't brighter than everything around it in a dim room.
  var EXPOSURE_SPOTS = [151, 9, 50, 280, 101, 330];
  var exposureCanvas = null;
  function measureExposure(source, lm, w, h) {
    try {
      if (!exposureCanvas) exposureCanvas = document.createElement('canvas');
      var c = exposureCanvas; c.width = 64; c.height = 64;
      var g = c.getContext('2d', { willReadFrequently: true });
      var size = Math.max(4, Math.abs(lm[454].x - lm[234].x) * w * 0.06), sum = 0, n = 0;
      for (var i = 0; i < EXPOSURE_SPOTS.length; i++) {
        var p = lm[EXPOSURE_SPOTS[i]];
        g.drawImage(source, p.x * w - size / 2, p.y * h - size / 2, size, size, 0, 0, 8, 8);
        var d = g.getImageData(0, 0, 8, 8).data;
        for (var k = 0; k < d.length; k += 4) { sum += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; n++; }
      }
      return n ? (sum / n / 255) / 0.62 : 1;
    } catch (e) { return 1; }
  }

  function customerPD() {
    var v = parseFloat(livePd.value || photoPd.value);
    return (v >= 50 && v <= 80) ? v : DEFAULT_PD_MM;
  }
  function onPdInput(src, other) {
    other.value = src.value;
    if (ar.renderer) ar.renderer.setPD(customerPD());
    redrawFacePreview();
  }
  livePd.addEventListener('input', function () { onPdInput(livePd, photoPd); });
  photoPd.addEventListener('input', function () { onPdInput(photoPd, livePd); });

  // ---------- live try-on (real-time tracking; see headpose.js / tracking.js for the maths) ----------
  // Camera frames are processed locally by MediaPipe in this tab. Nothing from the
  // camera is stored, uploaded or captured; the stream is stopped whenever the
  // customer leaves the Try On tab, hides the page, signs out or presses Stop.

  var liveStartBtn = document.getElementById('liveStartBtn');
  var liveStopBtn = document.getElementById('liveStopBtn');
  var liveSwitchBtn = document.getElementById('liveSwitchBtn');
  var liveToggleBtn = document.getElementById('liveToggleBtn');
  var liveTips = document.getElementById('liveTips');
  var liveError = document.getElementById('liveError');
  var liveViewport = document.getElementById('liveViewport');
  var liveVideo = document.getElementById('liveVideo');
  var liveCanvas = document.getElementById('liveCanvas');
  var liveStatus = document.getElementById('liveStatus');
  var liveFitRow = document.getElementById('liveFitRow');
  var liveFit = document.getElementById('liveFit');
  var liveFitVal = document.getElementById('liveFitVal');
  var liveStripWrap = document.getElementById('liveStripWrap');
  var liveStrip = document.getElementById('liveStrip');
  var liveSearch = document.getElementById('liveSearch');
  var liveStripEmpty = document.getElementById('liveStripEmpty');
  var liveCatalogBtn = document.getElementById('liveCatalogBtn');

  var CANCELLED = { cancelled: true };
  var FACE_LOST_GRACE_MS = 500;   // keep the last frame on screen through brief detection dropouts
  var FACE_BLINK_MS = 150;        // 3D: hold the last glasses this long before hiding them

  var live = {
    token: 0, running: false, stream: null, landmarker: null, raf: 0,
    mirrored: true, overlayOn: true, devices: [], currentDeviceId: null,
    lastVideoTime: -1, lastTs: 0, lastSeen: 0, statusText: '', synced: false, lastExposureAt: 0, exposure: 0,
    smoother: new PoseSmoother(),        // 2D fallback
    filter: new HeadPoseFilter(),        // 3D
    frame: null, frameId: null, loadingId: null, failedId: null
  };

  var liveLandmarkerPromise = null;
  function getLiveLandmarker() {
    if (!liveLandmarkerPromise) {
      liveLandmarkerPromise = FilesetResolver.forVisionTasks(MP_WASM).then(function (fileset) {
        function make(delegate) {
          return FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MP_MODEL, delegate: delegate },
            runningMode: 'VIDEO',
            numFaces: 1
          });
        }
        return make('GPU').catch(function () { return make('CPU'); });
      }).catch(function (e) { liveLandmarkerPromise = null; throw e; });
    }
    return liveLandmarkerPromise;
  }

  function setLiveStatus(text) {
    text = text || '';
    if (text === live.statusText) return;       // avoid touching the DOM 30x a second
    live.statusText = text;
    liveStatus.textContent = text;
  }

  function showLiveError(msg) {
    liveError.textContent = msg || '';
    liveError.style.display = msg ? 'block' : 'none';
  }

  var CAMERA_BLOCKED_MSG = "Camera access was blocked. Tap the camera/padlock icon in your browser's address bar, allow the camera for this site, then press Start again. You can also upload a photo below.";

  function liveCameraErrorMessage(err, permissionState) {
    var name = err && err.name;
    // some browsers report a refused permission with other error names
    if (permissionState === 'denied' || name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return CAMERA_BLOCKED_MSG;
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return "No camera was found on this device. Connect one and try again, or upload a photo below.";
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return "The camera is busy or couldn't start. Close other apps or tabs that are using it, then try again.";
    }
    return "Couldn't start the camera. Try again, or upload a photo below.";
  }

  function cameraPermissionState() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve('unknown');
      return navigator.permissions.query({ name: 'camera' }).then(function (s) { return s.state; }, function () { return 'unknown'; });
    } catch (e) { return Promise.resolve('unknown'); }
  }

  function syncLiveToggle() {
    liveToggleBtn.textContent = live.overlayOn ? 'Remove frame' : 'Show frame';
  }

  function setLiveRunningUi(running) {
    liveStartBtn.style.display = running ? 'none' : 'inline-block';
    liveStartBtn.disabled = false;
    liveStopBtn.style.display = running ? 'inline-block' : 'none';
    liveToggleBtn.style.display = running ? 'inline-block' : 'none';
    liveCatalogBtn.style.display = running && activeFrameId ? 'inline-block' : 'none';
    liveFitRow.style.display = running ? 'block' : 'none';
    liveStripWrap.style.display = running ? 'block' : 'none';
    if (!running) liveSwitchBtn.style.display = 'none';
  }

  function stopLive() {
    live.token++;                       // cancels any start still in flight
    live.running = false;
    if (live.raf) { cancelAnimationFrame(live.raf); live.raf = 0; }
    if (live.stream) { live.stream.getTracks().forEach(function (t) { t.stop(); }); live.stream = null; }
    try { liveVideo.pause(); } catch (e) { /* ignore */ }
    liveVideo.srcObject = null;
    var g = liveCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    liveViewport.style.display = 'none';
    liveViewport.classList.remove('synced');
    live.synced = false;
    if (ar.renderer && ar.renderer.canvas.parentNode === liveViewport) { ar.renderer.clear(); ar.renderer.detach(); }
    live.smoother.reset();
    live.filter.reset();
    live.lastVideoTime = -1;
    live.frame = null; live.frameId = null; live.loadingId = null; live.failedId = null;
    setLiveStatus('');
    setLiveRunningUi(false);
  }

  function startLive(deviceId) {
    showLiveError('');
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showLiveError("This browser can't open the camera on this page. Use a current version of Chrome, Edge, Safari or Firefox on the https:// address of the site. You can still upload a photo below.");
      return;
    }
    stopLive();
    stopStream();
    retakeFace();                       // leave photo mode cleanly
    var token = ++live.token;
    var stage = 'camera';
    liveStartBtn.disabled = true;
    liveViewport.style.display = 'block';
    setLiveStatus('Starting camera…');

    var size = { width: { ideal: 1280 }, height: { ideal: 720 } };
    var video = deviceId
      ? Object.assign({ deviceId: { exact: deviceId } }, size)
      : Object.assign({ facingMode: 'user' }, size);

    navigator.mediaDevices.getUserMedia({ video: video, audio: false }).then(function (s) {
      if (token !== live.token) { s.getTracks().forEach(function (t) { t.stop(); }); throw CANCELLED; }
      live.stream = s;
      var track0 = s.getVideoTracks()[0];
      var settings = (track0 && track0.getSettings) ? track0.getSettings() : {};
      live.mirrored = settings.facingMode !== 'environment';
      live.currentDeviceId = settings.deviceId || deviceId || null;
      liveViewport.classList.toggle('mirrored', live.mirrored);
      liveVideo.srcObject = s;
      return liveVideo.play();
    }).then(function () {
      if (token !== live.token) throw CANCELLED;
      stage = 'model';
      setLiveStatus('Loading face tracking…');
      // the 3D renderer loads alongside the tracking model; it never blocks the start
      return Promise.all([getLiveLandmarker(), ensureRenderer()]);
    }).then(function (loaded) {
      if (token !== live.token) throw CANCELLED;
      var landmarker = loaded[0];
      if (loaded[1]) {
        loaded[1].attach(liveViewport);
        loaded[1].resetFaceFit();
        loaded[1].setFit(liveFit.value / 100);
        loaded[1].setVisible(true);
      }
      live.filter.reset();
      live.exposure = 0; live.lastExposureAt = 0;
      live.landmarker = landmarker;
      live.running = true;
      live.lastSeen = performance.now();
      live.lastVideoTime = -1;
      live.overlayOn = true;
      syncLiveToggle();
      setLiveRunningUi(true);
      setLiveStatus('');
      renderLiveStrip();
      live.raf = requestAnimationFrame(liveTick);
      track('customer_session_started', { source: 'live' });
      return navigator.mediaDevices.enumerateDevices().then(function (list) {
        if (token !== live.token) return;
        live.devices = list.filter(function (d) { return d.kind === 'videoinput'; });
        liveSwitchBtn.style.display = live.devices.length > 1 ? 'inline-block' : 'none';
      }).catch(function () { /* switching just stays hidden */ });
    }).catch(function (err) {
      if (err === CANCELLED) return;
      console.error('Live try-on failed to start (' + stage + ')', err);
      stopLive();
      if (stage === 'model') {
        showLiveError("Couldn't load the face-tracking model. Check your internet connection and try again.");
        return;
      }
      cameraPermissionState().then(function (state) { showLiveError(liveCameraErrorMessage(err, state)); });
    });
  }

  function loadLiveFrame(id) {
    if (live.loadingId === id || live.failedId === id) return;
    live.loadingId = id;
    getFullFrameData(id).then(function (full) {
      if (live.loadingId !== id) return;
      live.frame = full; live.frameId = id; live.loadingId = null;
    }).catch(function (e) {
      console.error('Could not load frame for live try-on', e);
      if (live.loadingId === id) { live.loadingId = null; live.failedId = id; }
    });
  }

  function liveTick(now) {
    if (!live.running) return;
    live.raf = requestAnimationFrame(liveTick);
    var v = liveVideo;
    if (v.readyState < 2 || !v.videoWidth || v.currentTime === live.lastVideoTime) return;
    live.lastVideoTime = v.currentTime;
    if (liveCanvas.width !== v.videoWidth || liveCanvas.height !== v.videoHeight) {
      liveCanvas.width = v.videoWidth; liveCanvas.height = v.videoHeight;
    }
    var ts = Math.max(now, live.lastTs + 1);    // MediaPipe needs strictly increasing timestamps
    live.lastTs = ts;

    // Snapshot the camera frame first and track that snapshot: the picture shown
    // and the picture tracked are then exactly the same pixels, drawn together
    // with the glasses, so the two can never drift apart (on a slow device the
    // picture updates less often instead of the glasses trailing the face). The
    // <video> element is only the source and is hidden once this starts.
    var g = liveCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(v, 0, 0, liveCanvas.width, liveCanvas.height);
    if (!live.synced) { live.synced = true; liveViewport.classList.add('synced'); }

    var result;
    try { result = live.landmarker.detectForVideo(liveCanvas, ts); }
    catch (e) { console.error('Face tracking error', e); return; }

    var lm = result && result.faceLandmarks && result.faceLandmarks[0];
    var raw = lm ? poseFromLandmarks(lm, v.videoWidth, v.videoHeight) : null;
    var r3 = ar.renderer && ar.renderer.canvas.parentNode === liveViewport ? ar.renderer : null;

    if (!raw) {
      if (now - live.lastSeen > FACE_LOST_GRACE_MS) {
        live.smoother.reset();
        live.filter.reset();
        if (r3) r3.clear();
        setLiveStatus('No face found — move into view and look at the camera');
      } else if (r3 && now - live.lastSeen > FACE_BLINK_MS) {
        r3.clear();               // don't leave glasses floating where the face was
      }                           // (a one- or two-frame dropout keeps the last glasses: no flicker)
      return;
    }
    live.lastSeen = now;

    if (!activeFrameId) { if (r3) r3.clear(); setLiveStatus('Pick a frame below to try it on'); return; }
    if (!live.overlayOn) { if (r3) r3.clear(); setLiveStatus('Frame removed — tap "Show frame" or pick another'); return; }

    // 3D path: full head pose (turns, nods, tilts), perspective, occlusion
    if (r3 && ar.failedKey !== activeFrameId) {
      if (ar.frameKey !== activeFrameId) {
        r3.clear();
        arUseFrame(activeFrameId);
        setLiveStatus('Building the 3D frame…');
        return;
      }
      var pose3 = estimateHeadPose(lm, v.videoWidth, v.videoHeight);
      if (!pose3) { r3.clear(); return; }
      if (now - live.lastExposureAt > 500) {
        live.lastExposureAt = now;
        var e = measureExposure(liveCanvas, lm, v.videoWidth, v.videoHeight);
        live.exposure = live.exposure ? live.exposure + (e - live.exposure) * 0.3 : e;
        r3.setExposure(live.exposure);
      }
      var sm = live.filter.update(pose3, now);
      r3.setSize(v.videoWidth, v.videoHeight);
      r3.renderFace(sm, lm);
      var turn = Math.abs(eulerFromMatrix(sm.R).yaw);
      setLiveStatus(turn > 1.0 ? 'Turn back towards the camera' : '');
      return;
    }
    if (r3) r3.clear();

    // 2D fallback (no WebGL, or this frame can't be built in 3D)
    if (live.failedId === activeFrameId) { setLiveStatus("Couldn't load this frame — pick another"); return; }
    if (live.frameId !== activeFrameId) { loadLiveFrame(activeFrameId); setLiveStatus('Loading frame…'); return; }

    var pose = live.smoother.update(raw, now);
    var tf = frameTransform(live.frame, pose, liveFit.value / 100);
    if (!tf) { setLiveStatus("This frame has no usable lens points — re-add it"); return; }
    setLiveStatus('');
    drawFrame(g, live.frame.img, tf);
  }

  function renderLiveStrip() {
    liveStrip.innerHTML = '';
    var q = normalizeSearch(liveSearch.value);
    var list = catalogIndex.filter(function (e) {
      if (!q) return true;
      var hay = normalizeSearch(describeFrame(e) + ' ' + ((e.tags && e.tags.free) || []).join(' '));
      return q.split(/\s+/).every(function (word) { return hay.indexOf(word) !== -1; });
    });
    list.forEach(function (e) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'similar-item' + (e.id === activeFrameId ? ' active' : '');
      item.dataset.id = e.id;
      item.setAttribute('aria-pressed', e.id === activeFrameId ? 'true' : 'false');
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = e.thumbData;
      item.appendChild(img);
      var cap = document.createElement('span');
      cap.textContent = describeFrame(e);
      item.appendChild(cap);
      item.setAttribute('aria-label', 'Try on: ' + describeFrame(e));
      item.addEventListener('click', function () { selectFrame(e.id); });
      liveStrip.appendChild(item);
    });
    liveStrip.style.display = list.length ? 'flex' : 'none';
    if (!catalogIndex.length) {
      liveStripEmpty.textContent = "There are no frames yet — add some on the Add Frames tab.";
      liveStripEmpty.style.display = 'block';
    } else if (!list.length) {
      liveStripEmpty.textContent = 'No frames match that search.';
      liveStripEmpty.style.display = 'block';
    } else {
      liveStripEmpty.style.display = 'none';
    }
  }

  function updateLiveStripActive() {
    var items = liveStrip.children;
    for (var i = 0; i < items.length; i++) {
      var on = items[i].dataset.id === activeFrameId;
      items[i].classList.toggle('active', on);
      items[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  liveStartBtn.addEventListener('click', function () { startLive(); });
  liveStopBtn.addEventListener('click', stopLive);
  liveToggleBtn.addEventListener('click', function () {
    live.overlayOn = !live.overlayOn;
    syncLiveToggle();
  });
  liveSwitchBtn.addEventListener('click', function () {
    if (live.devices.length < 2) return;
    var idx = -1;
    live.devices.forEach(function (d, i) { if (d.deviceId === live.currentDeviceId) idx = i; });
    startLive(live.devices[(idx + 1) % live.devices.length].deviceId);
  });
  liveFit.addEventListener('input', function () {
    liveFitVal.textContent = liveFit.value + '%';
    if (ar.renderer) ar.renderer.setFit(liveFit.value / 100);
  });
  liveCatalogBtn.addEventListener('click', function () { showInCatalog(activeFrameId); });
  liveSearch.addEventListener('input', renderLiveStrip);
  // Privacy: never keep the camera open while the page is hidden or being closed.
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopLive(); });
  window.addEventListener('pagehide', stopLive);

  // ---------- add-frame tags ----------

  function renderAddChips() {
    renderChipGroup(shapeChips, 'shape', pendingTags.shape, function (v) { pendingTags.shape = v; schedulePreview(); });
    renderChipGroup(colorChips, 'color', pendingTags.color, function (v) { pendingTags.color = v; schedulePreview(); });
    renderChipGroup(genderChips, 'gender', pendingTags.gender, function (v) { pendingTags.gender = v; });
    renderChipGroup(rimChips, 'rim', pendingTags.rim, function (v) { pendingTags.rim = v; });
  }

  function resetTagInputs() {
    pendingTags = { shape: null, color: null, gender: null, rim: null, free: [] };
    fillSize(null, sizeEye, sizeBridge, sizeTemple);
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
    fillSize(entry.size, editSizeEye, editSizeBridge, editSizeTemple);
    editSideStatus.textContent = entry.hasSide ? 'Uses its own temple photo.' : 'Uses a temple generated from the front photo.';
    editSideBtn.textContent = entry.hasSide ? 'Replace temple photo' : 'Add temple photo';

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
  editSideBtn.addEventListener('click', function () {
    var id = editingFrameId;
    closeEditTags();
    if (id) enterSideMode(id);
  });

  saveTagsBtn.addEventListener('click', function () {
    if (!editingFrameId || !currentUser || !editPendingTags) return;
    var id = editingFrameId;
    var newTags = {
      shape: editPendingTags.shape, color: editPendingTags.color,
      gender: editPendingTags.gender, rim: editPendingTags.rim,
      free: editPendingTags.free.slice()
    };
    var newSize = readSize(editSizeEye, editSizeBridge, editSizeTemple);
    saveTagsBtn.disabled = true;
    updateDoc(doc(db, 'users', currentUser.uid, 'frames', id), { tags: newTags, size: newSize }).then(function () {
      var entry = findEntry(id);
      if (entry) { entry.tags = newTags; entry.size = newSize; }
      arForget(id);                       // tags/size change how the 3D model is built
      renderLiveStrip();
      if (activeFrameId === id) redrawFacePreview();
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
        arForget(id);
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
      var sizeText = sizeLabel(entry.size);
      if (sizeText) {
        var sz = document.createElement('span');
        sz.className = 'tag-chip';
        sz.textContent = sizeText;
        tagsWrap.appendChild(sz);
      }
      if (!parts.length && !sizeText) {
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
    deleteDoc(doc(db, 'users', uid, 'framesSide', id)).catch(function (e) { console.error('Failed to delete temple photo', e); });
    arForget(id);
    if (addTarget.kind === 'side' && addTarget.frameId === id) { discardPendingFrame(); exitSideMode(); }
  }

  // "Return to the product": the frame's card in the catalog (Browse tab).
  function showInCatalog(id) {
    if (!id) return;
    showTab('browse');
    var card = libraryRow.querySelector('[data-id="' + id + '"]');
    if (card && card.style.display === 'none') {        // hidden by a filter: clear filters so it shows
      activeFilters = { shape: new Set(), color: new Set(), gender: new Set(), rim: new Set(), search: '' };
      rebuildFilterBar();
      applyFilters();
    }
    if (!card) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    card.classList.add('flash');
    setTimeout(function () { card.classList.remove('flash'); }, 1800);
    var btn = card.querySelector('.frame-card-tryon');
    if (btn) btn.focus({ preventScroll: true });
  }

  function updateCatalogButtons() {
    liveCatalogBtn.style.display = live.running && activeFrameId ? 'inline-block' : 'none';
    var photoReady = faceHasImage && activeFrameId && facePoints.length >= 2;
    photoCatalogBtn.style.display = photoReady ? 'inline-block' : 'none';
    photoToggleBtn.style.display = photoReady ? 'inline-block' : 'none';
    photoToggleBtn.textContent = photoOverlayOn ? 'Remove frame' : 'Show frame';
  }

  function selectFrame(id) {
    activeFrameId = id;
    live.overlayOn = true;
    photoOverlayOn = true;
    syncLiveToggle();
    updateLiveStripActive();
    updateCatalogButtons();
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

  // A plain count of how many times a customer photo has been captured for try-on --
  // no identity, no image, nothing that could tie a number back to a specific person.
  // Lives at users/{uid}/stats/customerPhotos, so it's covered by the same per-account
  // security rule as everything else and needs no separate Firestore rule change.
  function loadPhotoCount(uid) {
    getDoc(doc(db, 'users', uid, 'stats', 'customerPhotos')).then(function (snap) {
      var count = (snap.exists() && snap.data().count) || 0;
      photoCountDisplay.textContent = count + ' patient photo' + (count === 1 ? '' : 's') + ' taken (all-time)';
    }).catch(function (e) { console.error('Could not load photo count', e); });
  }

  function bumpPhotoCount() {
    if (!currentUser) return;
    var ref = doc(db, 'users', currentUser.uid, 'stats', 'customerPhotos');
    updateDoc(ref, { count: increment(1) })
      .catch(function () { return setDoc(ref, { count: 1 }, { merge: true }); })
      .catch(function (e) { console.error('Could not update photo count', e); })
      .then(function () { loadPhotoCount(currentUser.uid); });
  }

  function loadCatalog(uid) {
    return getDocs(collection(db, 'users', uid, 'frames')).then(function (snap) {
      catalogIndex = [];
      snap.forEach(function (d) {
        var data = d.data();
        if (data.tags && data.tags.free) data.tags.free.forEach(function (t) { allFreeTags.add(t); });
        catalogIndex.push({ id: d.id, thumbData: data.thumbData, tags: data.tags || {}, size: cleanSize(data.size), hasSide: !!data.hasSide });
      });
      refreshTagSuggestions();
      renderLibrary();
      rebuildFilterBar();
      updateCatalogNote();
      updateTryOnHint();
      updateSimilarCarousel();
      renderLiveStrip();
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

  function updateFrameSourceUI() {
    var none = addTarget.kind === 'side'
      ? 'No temple photo yet.\nUse your camera or upload a side view of the frame.'
      : 'No frame photo yet.\nUse your camera or upload a photo of a frame.';
    if (bgRemovalMode === 'ai') {
      twoShotStepRow.style.display = 'none';
      frameSourcePlaceholder.textContent = none;
      frameSourcePlaceholder.style.display = 'block';
      return;
    }
    if (bgRemovalMode !== 'twoShot') {
      twoShotStepRow.style.display = 'none';
      frameSourcePlaceholder.textContent = none;
      frameSourcePlaceholder.style.display = 'block';
      return;
    }
    twoShotStepRow.style.display = 'flex';
    retakeBgBtn.style.display = pendingBgOnlyCanvas ? 'inline-block' : 'none';
    if (twoShotStep === 1) {
      twoShotStepLabel.textContent = 'Step 1 of 2: the empty surface';
      frameSourcePlaceholder.textContent = 'No photo yet. Photograph the empty surface first, with nothing on it.';
    } else {
      twoShotStepLabel.textContent = 'Step 2 of 2: place the frame, same spot, same camera position';
      frameSourcePlaceholder.textContent = 'Place the frame on the same surface and photograph it \u2014 keep the camera in the same spot.';
    }
    frameSourcePlaceholder.style.display = 'block';
  }

  // Full reset, including the saved background -- used when switching into two-shot
  // mode fresh, or when the person explicitly wants to retake the background because
  // the camera moved or the surface changed.
  function clearBackgroundReference() {
    pendingBgOnlyCanvas = null;
    twoShotStep = 1;
    updateFrameSourceUI();
  }

  // Used after a frame is added or cancelled: if a background photo is already saved,
  // skip straight to step 2 so it carries over for the next frame instead of asking to
  // retake it every single time.
  function advanceForNextCapture() {
    twoShotStep = (bgRemovalMode === 'twoShot' && pendingBgOnlyCanvas) ? 2 : 1;
    updateFrameSourceUI();
  }

  function setBgMode(mode) {
    bgRemovalMode = mode;
    bgModeSingleBtn.classList.toggle('active', mode === 'single');
    bgModeTwoShotBtn.classList.toggle('active', mode === 'twoShot');
    bgModeAiBtn.classList.toggle('active', mode === 'ai');
    bgModeHint.style.display = (mode === 'twoShot') ? 'block' : 'none';
    bgModeAiHint.style.display = (mode === 'ai') ? 'block' : 'none';
    clearBackgroundReference();
  }
  bgModeSingleBtn.addEventListener('click', function () { setBgMode('single'); });
  bgModeTwoShotBtn.addEventListener('click', function () { setBgMode('twoShot'); });
  bgModeAiBtn.addEventListener('click', function () { setBgMode('ai'); });
  retakeBgBtn.addEventListener('click', clearBackgroundReference);

  function beginAddFrameFromSource(source, naturalW, naturalH) {
    var canvas = document.createElement('canvas');

    if (bgRemovalMode === 'twoShot' && twoShotStep === 1) {
      var cappedBg = capDimensions(naturalW, naturalH, MAX_FRAME_DIM);
      canvas.width = cappedBg.w; canvas.height = cappedBg.h;
      canvas.getContext('2d').drawImage(source, 0, 0, cappedBg.w, cappedBg.h);
      // That was the empty-surface reference shot -- hold onto it and ask for the
      // second photo, with the frame placed on the same spot, before moving on.
      pendingBgOnlyCanvas = canvas;
      twoShotStep = 2;
      updateFrameSourceUI();
      addedMsg.style.display = 'none';
      return;
    }

    if (bgRemovalMode === 'twoShot' && twoShotStep === 2 && pendingBgOnlyCanvas) {
      // Force the exact same pixel dimensions as the reference shot, so every pixel
      // in this photo lines up spatially with the same pixel in that one -- required
      // for the diff to compare the right spot against itself.
      canvas.width = pendingBgOnlyCanvas.width;
      canvas.height = pendingBgOnlyCanvas.height;
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    } else {
      var capped = capDimensions(naturalW, naturalH, MAX_FRAME_DIM);
      canvas.width = capped.w; canvas.height = capped.h;
      canvas.getContext('2d').drawImage(source, 0, 0, capped.w, capped.h);
    }

    pendingRawCanvas = canvas;
    pendingAiRemovedCanvas = null;
    frameCalibPoints = [];
    toleranceRow.style.display = (bgRemovalMode === 'ai') ? 'none' : 'block';
    toolHistory = [];
    setTool('none');
    updateUndoState();
    resetTagInputs();
    showFrameCalibSection();

    if (bgRemovalMode === 'ai') {
      aiRemovalLoading = true;
      updateFrameCalibBanner();
      canvas.toBlob(function (blob) {
        fetch(REMOVEBG_WORKER_URL, { method: 'POST', body: blob })
          .then(function (resp) {
            if (!resp.ok) return resp.text().then(function (t) { throw new Error(t || ('Worker returned ' + resp.status)); });
            return resp.blob();
          })
          .then(function (resultBlob) { return createImageBitmap(resultBlob); })
          .then(function (bitmap) {
            var aiCanvas = document.createElement('canvas');
            aiCanvas.width = canvas.width; aiCanvas.height = canvas.height;
            aiCanvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            pendingAiRemovedCanvas = aiCanvas;
          })
          .catch(function (e) {
            console.error('AI background removal failed, falling back to local removal', e);
            pendingAiRemovedCanvas = null;
          })
          .then(function () {
            aiRemovalLoading = false;
            processPendingFrame();
          });
      }, 'image/png');
    } else {
      processPendingFrame();
    }
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
    getBackCameraStream().then(function (s) {
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
    var useAi = (bgRemovalMode === 'ai' && pendingAiRemovedCanvas &&
      pendingAiRemovedCanvas.width === w && pendingAiRemovedCanvas.height === h);
    var useTwoShot = !useAi && bgRemovalMode === 'twoShot' && pendingBgOnlyCanvas &&
      pendingBgOnlyCanvas.width === w && pendingBgOnlyCanvas.height === h;

    pctx.clearRect(0, 0, w, h);
    pctx.drawImage(useAi ? pendingAiRemovedCanvas : pendingRawCanvas, 0, 0, w, h);
    var imgData = pctx.getImageData(0, 0, w, h);

    if (useAi) {
      // Already cleanly cut out by remove.bg -- the local cleanup passes below exist
      // to compensate for the weaker color-based methods, and could only hurt an
      // already-good result, so they're skipped here.
    } else if (useTwoShot) {
      var bgOnlyData = pendingBgOnlyCanvas.getContext('2d').getImageData(0, 0, w, h);
      removeBackgroundDiff(imgData, bgOnlyData, parseInt(bgTolerance.value, 10));
    } else {
      removeBackground(imgData, parseInt(bgTolerance.value, 10));
    }

    var needsRaw = currentStrokeType === 'restore';
    for (var hIdx = 0; !needsRaw && hIdx < toolHistory.length; hIdx++) {
      if (toolHistory[hIdx].type === 'restoreStroke') needsRaw = true;
    }
    var rawData = needsRaw ? pendingRawCanvas.getContext('2d').getImageData(0, 0, w, h) : null;

    function applyToolAction(action) {
      if (action.type === 'eraseStroke') action.points.forEach(function (p) { eraseBrush(imgData, p.x, p.y, p.radius); });
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
    schedulePreview();
  }

  // ---------- add-frame: 3D preview of the generated model ----------

  function schedulePreview() {
    clearTimeout(preview.timer);
    if (!pendingRawCanvas || frameCalibPoints.length < 2 || aiRemovalLoading) {
      modelPreview.style.display = 'none';
      return;
    }
    preview.timer = setTimeout(buildPreview, 180);   // let slider drags settle first
  }

  function buildPreview() {
    if (preview.failed || !pendingRawCanvas || frameCalibPoints.length < 2) return;
    var seq = ++preview.seq;
    // snapshot: the processed canvas keeps changing while the tools are used
    var snap = document.createElement('canvas');
    snap.width = pendingProcessedCanvas.width; snap.height = pendingProcessedCanvas.height;
    snap.getContext('2d').drawImage(pendingProcessedCanvas, 0, 0);
    var pts = frameCalibPoints.slice();
    var target = addTarget;
    if (!preview.promise) {
      preview.promise = createTryOnRenderer().then(function (r) { preview.renderer = r; return r; })
        .catch(function (e) { console.warn('3D preview unavailable', e); preview.failed = true; return null; });
    }
    var dataPromise = target.kind === 'side'
      ? getFullFrameData(target.frameId).then(function (full) {
          var entry = findEntry(target.frameId) || {};
          return { img: full.img, p1: full.p1, p2: full.p2, tags: entry.tags || {}, size: entry.size || null, side: { img: snap, hinge: pts[0], tip: pts[1] } };
        })
      : Promise.resolve({ img: snap, p1: pts[0], p2: pts[1], tags: pendingTags, size: readSize(sizeEye, sizeBridge, sizeTemple), side: null });
    Promise.all([preview.promise, dataPromise]).then(function (res) {
      var r = res[0], data = res[1];
      if (seq !== preview.seq || !r) { if (!r) modelPreview.style.display = 'none'; return; }
      if (preview.key) r.forget(preview.key);
      preview.key = 'pending-' + seq;
      var out = r.setFrame(preview.key, data);
      modelPreview.style.display = 'block';
      r.attach(modelPreviewStage);
      if (!out.ok) {
        r.clear();
        modelPreviewHint.textContent = target.kind === 'side'
          ? "Couldn't find the temple between the two points \u2014 check the cut-out and tap again."
          : "This cut-out can't be turned into 3D (" + out.reason + "). The flat overlay will be used for it.";
        return;
      }
      var a = out.analysis;
      modelPreviewHint.textContent = target.kind === 'side'
        ? 'The 3D try-on will use this temple. Slide to turn it.'
        : 'Generated from this photo' + (a.lensFound[0] || a.lensFound[1] ? ', with glass lenses' : '') + (a.metal ? ', metal finish' : '') + '. Slide to turn it.';
      renderPreviewNow();
    }).catch(function (e) { console.error('Preview failed', e); });
  }

  function renderPreviewNow() {
    var r = preview.renderer;
    if (!r || !r.current) return;
    var rect = modelPreviewStage.getBoundingClientRect();
    var w = Math.max(320, Math.round(rect.width * (window.devicePixelRatio || 1)));
    r.setSize(Math.min(w, 960), Math.round(Math.min(w, 960) * 9 / 16));
    r.renderPreview(modelPreviewYaw.value * Math.PI / 180, -0.12);
  }
  modelPreviewYaw.addEventListener('input', renderPreviewNow);
  [sizeEye, sizeBridge, sizeTemple].forEach(function (el) { el.addEventListener('change', schedulePreview); });

  // ---------- add-frame: temple (side) photo for an existing frame ----------

  function enterSideMode(id) {
    var entry = findEntry(id);
    if (!entry) return;
    showTab('add');
    discardPendingFrame();
    addTarget = { kind: 'side', frameId: id };
    sideTargetThumb.innerHTML = '';
    var img = document.createElement('img');
    img.src = entry.thumbData; img.alt = '';
    sideTargetThumb.appendChild(img);
    sideTargetText.textContent = (entry.hasSide ? 'Replace the temple photo for: ' : 'Temple photo for: ') + describeFrame(entry);
    sideTarget.style.display = 'flex';
    sideTargetHint.style.display = 'block';
    framePhotoLabel.textContent = 'Temple photo';
    frontOnlySection.style.display = 'none';
    addToLibraryBtn.textContent = 'Save temple photo';
    addedMsg.style.display = 'none';
    advanceForNextCapture();
  }

  function exitSideMode() {
    addTarget = { kind: 'front', frameId: null };
    sideTarget.style.display = 'none';
    sideTargetHint.style.display = 'none';
    framePhotoLabel.textContent = 'Frame photo';
    frontOnlySection.style.display = 'block';
    addToLibraryBtn.textContent = 'Add to library';
    updateFrameSourceUI();
  }

  function discardPendingFrame() {
    pendingRawCanvas = null;
    pendingAiRemovedCanvas = null;
    aiRemovalLoading = false;
    frameCalibPoints = [];
    toolHistory = [];
    setTool('none');
    updateUndoState();
    stopFrameStream();
    frameVideo.style.display = 'none';
    frameCaptureBtn.style.display = 'none';
    modelPreview.style.display = 'none';
    showFrameSourceChooser();
  }

  sideTargetCancel.addEventListener('click', function () {
    discardPendingFrame();
    exitSideMode();
  });
  addSideAfterBtn.addEventListener('click', function () { if (lastAddedId) enterSideMode(lastAddedId); });

  function saveSidePhoto() {
    var id = addTarget.frameId, entry = findEntry(id);
    if (!entry || frameCalibPoints.length < 2 || !currentUser) return;
    addToLibraryBtn.disabled = true;
    var uid = currentUser.uid;
    var out = shrinkToBudgetScaled(pendingProcessedCanvas, SIDE_BYTE_BUDGET, 'image/png');
    var sc = function (p) { return { x: Math.round(p.x * out.sx * 10) / 10, y: Math.round(p.y * out.sy * 10) / 10 }; };
    setDoc(doc(db, 'users', uid, 'framesSide', id), {
      imageData: out.dataUrl, hinge: sc(frameCalibPoints[0]), tip: sc(frameCalibPoints[1]),
      imgW: out.w, imgH: out.h, createdAt: serverTimestamp()
    }).then(function () {
      return updateDoc(doc(db, 'users', uid, 'frames', id), { hasSide: true });
    }).then(function () {
      entry.hasSide = true;
      arForget(id);
      discardPendingFrame();
      exitSideMode();
      addedMsgText.textContent = 'Temple photo saved \u2014 the 3D try-on now uses the real temple for this frame.';
      addSideAfterBtn.style.display = 'none';
      addedMsg.style.display = 'block';
      track('temple_photo_added', {});
    }).catch(function (e) {
      console.error('Failed to save temple photo', e);
      addToLibraryBtn.disabled = false;
      frameCalibBanner.textContent = 'Something went wrong saving the temple photo \u2014 check the connection and try again.';
    });
  }

  function updateFrameCalibBanner() {
    addToLibraryBtn.disabled = frameCalibPoints.length < 2 || aiRemovalLoading;
    var side = addTarget.kind === 'side';
    if (aiRemovalLoading) { frameCalibBanner.textContent = 'Removing background with AI\u2026'; return; }
    if (frameCalibPoints.length === 0) frameCalibBanner.textContent = side ? 'Tap the hinge (where the temple meets the front), then the far tip of the temple.' : 'Tap one lens center, then the other.';
    else if (frameCalibPoints.length === 1) frameCalibBanner.textContent = side ? 'Now tap the far tip of the temple.' : 'Now tap the other lens center.';
    else frameCalibBanner.textContent = side ? 'Ready \u2014 check the 3D preview, then save.' : 'Ready \u2014 check the 3D preview, then add it to your library.';
  }

  bgTolerance.addEventListener('input', function () {
    bgToleranceVal.textContent = bgTolerance.value;
    processPendingFrame();
  });

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
    var pts = eraseDragging ? currentStrokePoints.slice() : [{ x: eraseDownPos.x, y: eraseDownPos.y, radius: ERASE_BRUSH_RADIUS }];
    toolHistory.push({ type: (eraseModeActive ? 'erase' : 'restore') + 'Stroke', points: pts });
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
    if (addTarget.kind === 'side') { saveSidePhoto(); return; }
    addToLibraryBtn.disabled = true;
    var uid = currentUser.uid;
    var id = 'f' + Date.now() + '_' + Math.floor(Math.random() * 10000);

    var fullCanvas = document.createElement('canvas');
    fullCanvas.width = pendingProcessedCanvas.width;
    fullCanvas.height = pendingProcessedCanvas.height;
    fullCanvas.getContext('2d').drawImage(pendingProcessedCanvas, 0, 0);
    var thumbCanvas = makeThumbCanvas(pendingProcessedCanvas, THUMB_DIM);

    var full = shrinkToBudgetScaled(fullCanvas, FULL_BYTE_BUDGET, 'image/png');
    var fullData = full.dataUrl;
    var thumbData = shrinkToBudget(thumbCanvas, THUMB_BYTE_BUDGET, 'image/png');

    // lens centres in the saved image's pixels (it may have been shrunk to fit)
    var sc = function (p) { return { x: Math.round(p.x * full.sx * 10) / 10, y: Math.round(p.y * full.sy * 10) / 10 }; };
    var p1 = sc(frameCalibPoints[0]), p2 = sc(frameCalibPoints[1]);
    var tags = { shape: pendingTags.shape, color: pendingTags.color, gender: pendingTags.gender, rim: pendingTags.rim, free: pendingTags.free.slice() };
    var size = readSize(sizeEye, sizeBridge, sizeTemple);

    Promise.all([
      setDoc(doc(db, 'users', uid, 'frames', id), { thumbData: thumbData, tags: tags, size: size, createdAt: serverTimestamp() }),
      setDoc(doc(db, 'users', uid, 'framesFull', id), { imageData: fullData, p1: p1, p2: p2, imgW: full.w, imgH: full.h })
    ]).then(function () {
      var img = new Image();
      img.onload = function () { fullDataCache[id] = { img: img, p1: p1, p2: p2 }; };
      img.src = fullData;

      catalogIndex.push({ id: id, thumbData: thumbData, tags: tags, size: size, hasSide: false });
      renderLibrary();
      rebuildFilterBar();
      applyFilters();
      updateCatalogNote();
      track('frame_added', { shape: tags.shape || 'untagged', color: tags.color || 'untagged', rim: tags.rim || 'untagged' });

      pendingRawCanvas = null;
      pendingAiRemovedCanvas = null;
      modelPreview.style.display = 'none';
      advanceForNextCapture();
      showFrameSourceChooser();
      lastAddedId = id;
      addedMsgText.textContent = 'Added to your catalog. Add another below, or head to Browse to try it on.';
      addSideAfterBtn.style.display = 'block';
      addedMsg.style.display = 'block';
      selectFrame(id);
    }).catch(function (e) {
      console.error('Failed to add frame', e);
      addToLibraryBtn.disabled = false;
      frameCalibBanner.textContent = 'Something went wrong saving this frame \u2014 check the console and try again.';
    });
  });

  cancelFrameBtn.addEventListener('click', function () {
    discardPendingFrame();
    advanceForNextCapture();
  });

  window.addEventListener('beforeunload', function () { stopStream(); stopFrameStream(); });
})();
