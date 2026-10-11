import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getAnalytics, isSupported, logEvent } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-analytics.js";
import { PoseSmoother, poseFromLandmarks, frameTransform, drawFrame } from './tracking.js';
import { estimateHeadPose, HeadPoseFilter, eulerFromMatrix } from './headpose.js';
import { cleanSize, sizeLabel } from './frame-size.js';
import { LANGS, t, tn, getLang, setLang, hasLang, tagLabel, tagAdjective, tagLabelsAll, applyStatic } from './i18n.js';

// Heavy parts load only when they're needed, never just because the catalogue
// was opened: face tracking (MediaPipe, pinned to a tested version; its JS and
// WASM must match) and the 3D renderer when try-on starts, the photo extraction
// when staff add a frame.
var MEDIAPIPE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
var DEFAULT_PD_MM = 63;   // adult average (same value as ar-renderer.js)
var visionModule = null, rendererModule = null, extractModule = null;
function loadVision() { return visionModule || (visionModule = import(MEDIAPIPE_URL).catch(function (e) { visionModule = null; throw e; })); }
function loadRenderer() { return rendererModule || (rendererModule = import('./ar-renderer.js').catch(function (e) { rendererModule = null; throw e; })); }
function loadExtract() { return extractModule || (extractModule = import('./frame-extract.js').catch(function (e) { extractModule = null; throw e; })); }
function createTryOnRenderer() { return loadRenderer().then(function (m) { return m.createTryOnRenderer(); }); }

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
  var MAX_FRAME_DIM = 1000;        // working size for frame photos (the saved cut-out is cropped to the frame)
  var SOURCE_MAX_DIM = 1600;       // the original photo is kept at up to this size for re-processing
  var SOURCE_BYTE_BUDGET = 900000;
  var THUMB_DIM = 260;
  var FULL_BYTE_BUDGET = 750000;
  var THUMB_BYTE_BUDGET = 150000;

  var FACETS = {
    shape: { options: ['round', 'square', 'catseye', 'aviator', 'browline', 'rectangle', 'oval'] },
    color: { options: ['black', 'tortoise', 'gold', 'silver', 'clear', 'navy', 'red'] },
    gender: { options: ['womens', 'mens', 'unisex', 'kids'] },
    rim: { options: ['fullrim', 'semirimless', 'rimless'] }
  };

  // Renders a facet's chip buttons fresh into `container`, marking `currentValue`
  // active. Reusable for the Add-frame form, the single-frame editor, and the
  // bulk-edit bar -- all three just point it at a different container/state.
  function renderChipGroup(container, facetKey, currentValue, onChange) {
    container.innerHTML = '';
    FACETS[facetKey].options.forEach(function (val) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (currentValue === val ? ' active' : '');
      chip.setAttribute('aria-pressed', currentValue === val ? 'true' : 'false');
      chip.textContent = tagLabel(val);
      chip.addEventListener('click', function () {
        var wasActive = chip.classList.contains('active');
        container.querySelectorAll('.tag-chip').forEach(function (c) { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
        if (wasActive) { onChange(null); }
        else { chip.classList.add('active'); chip.setAttribute('aria-pressed', 'true'); onChange(val); }
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
  var mainNav = document.getElementById('mainNav');
  var staffWrap = document.getElementById('staffWrap');

  var currentUser = null;

  function friendlyAuthError(err) {
    var map = {
      'auth/email-already-in-use': 'auth.err.inUse',
      'auth/wrong-password': 'auth.err.wrong',
      'auth/invalid-credential': 'auth.err.invalid',
      'auth/invalid-login-credentials': 'auth.err.invalid',
      'auth/weak-password': 'auth.err.weak',
      'auth/invalid-email': 'auth.err.email',
      'auth/missing-email': 'auth.err.noEmail',
      'auth/user-not-found': 'auth.err.noUser',
      'auth/missing-password': 'auth.err.noPass',
      'auth/too-many-requests': 'auth.err.many',
      'auth/network-request-failed': 'auth.err.network'
    };
    return map[err && err.code] || 'auth.err.other';
  }

  // takes a text key (or a Firebase error); remembered so a language change re-renders it
  var authErrorKey = null;
  function showAuthError(err) {
    authErrorKey = typeof err === 'string' ? err : friendlyAuthError(err);
    authError.textContent = t(authErrorKey);
    authError.style.display = 'block';
  }

  authForm.addEventListener('submit', function (e) {
    e.preventDefault();
    authError.style.display = 'none'; authErrorKey = null;
    if (!authEmail.value.trim()) { showAuthError('auth.err.noEmail'); authEmail.focus(); return; }
    if (!authPassword.value) { showAuthError('auth.err.noPass'); authPassword.focus(); return; }
    signInWithEmailAndPassword(auth, authEmail.value.trim(), authPassword.value).catch(showAuthError);
  });

  signUpBtn.addEventListener('click', function () {
    authError.style.display = 'none'; authErrorKey = null;
    var email = authEmail.value.trim(), pass = authPassword.value;
    if (!email || pass.length < 6) {
      showAuthError('auth.err.create');
      return;
    }
    createUserWithEmailAndPassword(auth, email, pass).catch(showAuthError);
  });

  signOutBtn.addEventListener('click', function () { closeStaffMenu(); setStaff(false); endCustomerSession(); signOut(auth); });

  onAuthStateChanged(auth, function (user) {
    currentUser = user;
    if (user) {
      authGate.style.display = 'none';
      appShell.style.display = 'block';
      mainNav.hidden = false; staffWrap.hidden = false;
      userEmailLabel.textContent = user.email;
      resetLocalState();
      restoreShortlist();
      restoreStaff();
      view = { name: null, id: null };
      renderRoute(parseHash(), { initial: true });
      loadCatalog(user.uid);
      loadPhotoCount(user.uid);
    } else {
      stopLive();
      setStaff(false, false, true);
      appShell.style.display = 'none';
      mainNav.hidden = true; staffWrap.hidden = true;
      authGate.style.display = 'block';
      view = { name: 'signin', id: null };
      setTitle(t('title.signIn'));
    }
  });

  // ---------- small UI helpers: notifications and confirmations ----------
  var toastRegion = document.getElementById('toastRegion');
  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.textContent = message;
    toastRegion.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, kind === 'error' ? 7000 : 4000);
  }

  var confirmDialog = document.getElementById('confirmDialog');
  var confirmTitle = document.getElementById('confirmTitle');
  var confirmBody = document.getElementById('confirmBody');
  var confirmOk = document.getElementById('confirmOk');
  var confirmCancel = document.getElementById('confirmCancel');
  // Resolves true/false. `body` is text or a list of lines.
  function confirmAction(o) {
    var lines = Array.isArray(o.body) ? o.body : [o.body || ''];
    if (!confirmDialog.showModal) return Promise.resolve(window.confirm(o.title + '\n\n' + lines.join('\n')));
    return new Promise(function (resolve) {
      var opener = document.activeElement;
      confirmTitle.textContent = o.title;
      confirmBody.innerHTML = '';
      lines.forEach(function (t) {
        var p = document.createElement('p');
        p.textContent = t;
        confirmBody.appendChild(p);
      });
      confirmOk.textContent = o.ok || t('common.ok');
      confirmOk.className = 'btn ' + (o.danger ? 'danger' : 'primary');
      confirmCancel.textContent = o.cancel || t('common.cancel');
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        confirmOk.onclick = confirmCancel.onclick = null;
        confirmDialog.removeEventListener('close', onClose);
        if (confirmDialog.open) confirmDialog.close();
        if (opener && opener.focus) opener.focus();
        resolve(v);
      }
      function onClose() { finish(false); }
      confirmOk.onclick = function () { finish(true); };
      confirmCancel.onclick = function () { finish(false); };
      confirmDialog.addEventListener('close', onClose);
      confirmDialog.showModal();
      (o.danger ? confirmCancel : confirmOk).focus();
    });
  }

  // ---------- staff mode ----------
  // A shared shop screen: customers browse and try on; adding, editing and
  // deleting frames needs the account password again. Staff can keep the tools
  // unlocked on their own device; otherwise they lock after 15 minutes idle.
  var staffBtn = document.getElementById('staffBtn');
  var staffBtnLabel = document.getElementById('staffBtnLabel');
  var staffLockShackle = document.getElementById('staffLockShackle');
  var staffMenu = document.getElementById('staffMenu');
  var staffLockBtn = document.getElementById('staffLockBtn');
  var menuAddLink = document.getElementById('menuAddLink');
  var staffDialog = document.getElementById('staffDialog');
  var staffForm = document.getElementById('staffForm');
  var staffPassword = document.getElementById('staffPassword');
  var staffKeep = document.getElementById('staffKeep');
  var staffError = document.getElementById('staffError');
  var staffUnlockBtn = document.getElementById('staffUnlockBtn');
  var staffCancelBtn = document.getElementById('staffCancelBtn');
  var STAFF_IDLE_MS = 15 * 60 * 1000;
  var staff = { on: false, keep: false, lastActive: 0, after: null };

  function staffKey() { return 'fts.staffKeep.' + (currentUser ? currentUser.uid : ''); }
  function setStaff(on, keep, silent) {
    var was = staff.on;
    staff.on = !!on; staff.keep = !!(on && keep);
    staff.lastActive = Date.now();
    document.body.classList.toggle('staff', staff.on);
    try { if (currentUser) { if (staff.keep) localStorage.setItem(staffKey(), '1'); else localStorage.removeItem(staffKey()); } } catch (e) { /* storage blocked: tools just lock with the session */ }
    syncStaffLabels();
    staffBtn.setAttribute('aria-haspopup', staff.on ? 'true' : 'dialog');
    staffLockShackle.setAttribute('d', staff.on ? 'M7 9V6.5a3 3 0 0 1 5.6-1.5' : 'M7 9V6.5a3 3 0 0 1 6 0V9');
    if (!staff.on) {
      closeStaffMenu();
      if (selectMode) exitSelectMode();
      if (editingFrameId) closeEditTags();
    }
    syncAddLock();
    if (was !== staff.on && view.name === 'detail') renderDetail(view.id);
    if (was && !staff.on && !silent) toast(t('staff.locked'));
  }
  function syncStaffLabels() {
    staffBtnLabel.textContent = staff.on ? t('staff.btnOn') : t('staff.btn');
    staffBtn.setAttribute('aria-label', staff.on ? t('staff.aria.menu') : t('staff.aria.unlock'));
  }
  function restoreStaff() {
    var keep = false;
    try { keep = localStorage.getItem(staffKey()) === '1'; } catch (e) { keep = false; }
    setStaff(keep, keep, true);
  }
  function openStaffDialog(after) {
    staff.after = after || null;
    staffError.classList.remove('show'); staffError.textContent = '';
    staffPassword.value = ''; staffKeep.checked = false;
    if (staffDialog.showModal) staffDialog.showModal(); else staffDialog.setAttribute('open', '');
    staffPassword.focus();
  }
  function closeStaffDialog() { if (staffDialog.open) staffDialog.close(); }
  function staffAuthError(err) {
    var code = err && err.code;
    if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials') return t('staff.err.wrong');
    if (code === 'auth/too-many-requests') return t('staff.err.many');
    if (code === 'auth/network-request-failed') return t('staff.err.network');
    return t('staff.err.other');
  }
  staffForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!currentUser) return;
    if (!staffPassword.value) { staffError.textContent = t('staff.err.empty'); staffError.classList.add('show'); staffPassword.focus(); return; }
    staffUnlockBtn.disabled = true;
    staffUnlockBtn.textContent = t('staff.dialog.checking');
    var cred = EmailAuthProvider.credential(currentUser.email, staffPassword.value);
    reauthenticateWithCredential(auth.currentUser, cred).then(function () {
      setStaff(true, staffKeep.checked);
      closeStaffDialog();
      toast(staffKeep.checked ? t('staff.unlockedDevice') : t('staff.unlockedSession'));
      var after = staff.after; staff.after = null;
      if (after) after();
    }).catch(function (err) {
      staffError.textContent = staffAuthError(err);
      staffError.classList.add('show');
      staffPassword.select();
    }).then(function () { staffUnlockBtn.disabled = false; staffUnlockBtn.textContent = t('staff.dialog.unlock'); });
  });
  staffCancelBtn.addEventListener('click', function () { staff.after = null; closeStaffDialog(); staffBtn.focus(); });
  staffDialog.addEventListener('close', function () { staffPassword.value = ''; });

  function openStaffMenu() {
    staffMenu.hidden = false;
    staffBtn.setAttribute('aria-expanded', 'true');
    var first = staffMenu.querySelector('.menu-item');
    if (first) first.focus();
  }
  function closeStaffMenu() {
    if (staffMenu.hidden) return;
    staffMenu.hidden = true;
    staffBtn.setAttribute('aria-expanded', 'false');
  }
  staffBtn.addEventListener('click', function () {
    if (!staff.on) { openStaffDialog(); return; }
    if (staffMenu.hidden) openStaffMenu(); else closeStaffMenu();
  });
  staffLockBtn.addEventListener('click', function () { setStaff(false); staffBtn.focus(); });
  menuAddLink.addEventListener('click', function () { closeStaffMenu(); });
  document.addEventListener('click', function (e) { if (!staffMenu.hidden && !staffMenu.contains(e.target) && !staffBtn.contains(e.target)) closeStaffMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !staffMenu.hidden) { closeStaffMenu(); staffBtn.focus(); } });
  ['pointerdown', 'keydown'].forEach(function (t) { document.addEventListener(t, function () { if (staff.on) staff.lastActive = Date.now(); }, true); });
  setInterval(function () {
    if (staff.on && !staff.keep && Date.now() - staff.lastActive > STAFF_IDLE_MS) {
      setStaff(false, false, true);
      toast(t('staff.lockedIdle'));
    }
  }, 30000);

  // ---------- views and addresses ----------
  // Each view has its own address (#/, #/frame/<id>, #/try-on/<id>, #/add), so a
  // refresh keeps the customer where they were and Back works as expected.
  var tabBrowseBtn = document.getElementById('tabBrowseBtn');
  var tabTryOnBtn = document.getElementById('tabTryOnBtn');
  var tabAddBtn = document.getElementById('tabAddBtn');
  var pageBrowse = document.getElementById('pageBrowse');
  var pageDetail = document.getElementById('pageDetail');
  var pageTryOn = document.getElementById('pageTryOn');
  var pageShortlist = document.getElementById('pageShortlist');
  var tabShortlistBtn = document.getElementById('tabShortlistBtn');
  var photoCountDisplay = document.getElementById('photoCountDisplay');
  var pageAdd = document.getElementById('pageAdd');
  var addLocked = document.getElementById('addLocked');
  var addContent = document.getElementById('addContent');
  var addUnlockBtn = document.getElementById('addUnlockBtn');
  var tryonBack = document.getElementById('tryonBack');

  var view = { name: null, id: null };
  var catalogLoaded = false;
  var catalogScrollY = 0;
  var tryonFrom = null;          // the frame whose page opened the try-on (for "Back to …")

  // An address may carry ?pd=62.5 (e.g. a link or QR code from the eye test):
  // it is applied once and then removed from the address.
  function parseHash() {
    var hash = location.hash || '', query = '';
    var qi = hash.indexOf('?');
    if (qi >= 0) { query = hash.slice(qi + 1); hash = hash.slice(0, qi); }
    var parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(function (p) {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    var r;
    if (parts[0] === 'frame' && parts[1]) r = { name: 'detail', id: parts[1] };
    else if (parts[0] === 'try-on') r = { name: 'tryon', id: parts[1] || null };
    else if (parts[0] === 'add') r = { name: 'add', id: null };
    else if (parts[0] === 'shortlist') r = { name: 'shortlist', id: null };
    else r = { name: 'browse', id: null };
    if (query) {
      var m = /(?:^|&)pd=([0-9]+(?:[.,][0-9]+)?)/.exec(query);
      if (m) r.pd = parseFloat(m[1].replace(',', '.'));
      r.hadQuery = true;
    }
    return r;
  }
  function hashFor(r) {
    if (r.name === 'detail') return '#/frame/' + encodeURIComponent(r.id);
    if (r.name === 'tryon') return '#/try-on' + (r.id ? '/' + encodeURIComponent(r.id) : '');
    if (r.name === 'add') return '#/add';
    if (r.name === 'shortlist') return '#/shortlist';
    return '#/';
  }
  function navigate(r, opts) {
    var h = hashFor(r);
    var cur = location.hash || '#/';
    if (cur !== h) {
      if (opts && opts.replace) history.replaceState(null, '', h); else history.pushState(null, '', h);
    }
    renderRoute(r, opts);
  }
  function onAddressChange() { renderRoute(parseHash()); }
  function takeQuery(r) {
    if (!r.hadQuery) return;
    history.replaceState(null, '', hashFor(r));
    if (r.pd != null) applyPdFromLink(r.pd);
  }
  window.addEventListener('popstate', onAddressChange);
  window.addEventListener('hashchange', onAddressChange);

  function setTitle(title) { document.title = (title ? title + ' | ' : '') + 'Frame Try-On Studio'; }
  // the page title for the current view, in the current language
  function refreshTitle() {
    if (view.name === 'browse') setTitle(t('title.frames'));
    else if (view.name === 'detail') { var e = findEntry(view.id); setTitle(e && !e.draft ? frameName(e) : t(catalogLoaded ? 'title.notFound' : 'title.frame')); }
    else if (view.name === 'tryon') setTitle(t('title.tryon'));
    else if (view.name === 'add') setTitle(t('title.add'));
    else if (view.name === 'shortlist') setTitle(t('title.shortlist'));
    else if (view.name === 'signin') setTitle(t('title.signIn'));
  }

  function renderRoute(r, opts) {
    if (!currentUser) return;
    opts = opts || {};
    takeQuery(r);
    var same = view.name === r.name && (view.id || null) === (r.id || null);
    if (same && !opts.force) return;
    var prev = view.name;
    if (prev === 'browse' && r.name !== 'browse') catalogScrollY = window.scrollY;
    view = { name: r.name, id: r.id || null };
    showView(r.name);
    if (r.name === 'browse') {
      setTitle(t('title.frames'));
      requestAnimationFrame(function () { window.scrollTo(0, prev && prev !== 'browse' ? catalogScrollY : 0); });
    } else if (r.name === 'detail') {
      renderDetail(r.id);
      window.scrollTo(0, 0);
    } else if (r.name === 'tryon') {
      if (r.id && r.id !== activeFrameId && findEntry(r.id)) selectFrame(r.id, { keepUrl: true });
      if (opts.from) tryonFrom = opts.from;
      else if (prev !== 'tryon') tryonFrom = prev === 'detail' ? (r.id || activeFrameId) : null;
      syncTryonBack();
      setTitle(t('title.tryon'));
      if (prev !== 'tryon') window.scrollTo(0, 0);
    } else if (r.name === 'add') {
      setTitle(t('title.add'));
      syncAddLock();
      window.scrollTo(0, 0);
    } else if (r.name === 'shortlist') {
      setTitle(t('title.shortlist'));
      renderShortlistPage();
      window.scrollTo(0, 0);
    }
    if (!opts.initial && prev) {
      var page = { browse: pageBrowse, detail: pageDetail, tryon: pageTryOn, add: pageAdd, shortlist: pageShortlist }[r.name];
      var h1 = page && page.querySelector('h1:not([hidden])');
      if (h1 && (r.name !== 'browse')) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
    }
  }

  function showView(name) {
    pageBrowse.style.display = name === 'browse' ? 'block' : 'none';
    pageDetail.style.display = name === 'detail' ? 'block' : 'none';
    pageTryOn.style.display = name === 'tryon' ? 'block' : 'none';
    pageAdd.style.display = name === 'add' ? 'block' : 'none';
    pageShortlist.style.display = name === 'shortlist' ? 'block' : 'none';
    [[tabBrowseBtn, name === 'browse' || name === 'detail'], [tabTryOnBtn, name === 'tryon'], [tabShortlistBtn, name === 'shortlist'], [tabAddBtn, name === 'add']].forEach(function (pair) {
      if (pair[1]) pair[0].setAttribute('aria-current', 'page'); else pair[0].removeAttribute('aria-current');
    });
    if (name === 'tryon') { updateTryOnHint(); updateSelectedBanner(); renderLiveStrip(); syncStage(); }
    if (name !== 'tryon') { stopLive(); stopStream(); }  // never leave a camera running in the background
    if (name !== 'tryon' && draftEntry) endDraftPreview(false);
    if (name !== 'detail' && editingFrameId) closeEditTags();
  }

  // Internal callers still think in tabs.
  function showTab(name) { navigate({ name: name, id: null }); }

  function syncTryonBack() {
    var from = tryonFrom && tryonFrom !== DRAFT_ID ? findEntry(tryonFrom) : null;
    if (from) {
      tryonBack.textContent = t('try.backTo', { name: frameName(from) });
      tryonBack.href = hashFor({ name: 'detail', id: from.id });
    } else {
      tryonBack.textContent = t('try.allFrames');
      tryonBack.href = '#/';
    }
  }

  function syncAddLock() {
    var locked = !staff.on;
    addLocked.hidden = !locked;
    addContent.hidden = locked;
    if (locked && view.name === 'add') { stopFrameStream(); }
  }
  addUnlockBtn.addEventListener('click', function () { openStaffDialog(function () { syncAddLock(); }); });

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
  var draftBanner = document.getElementById('draftBanner');
  var draftBackBtn = document.getElementById('draftBackBtn');
  var pdInput = document.getElementById('pdInput');
  var pdSplit = document.getElementById('pdSplit');
  var pdSplitRow = document.getElementById('pdSplitRow');
  var pdSingle = document.getElementById('pdSingle');
  var pdRight = document.getElementById('pdRight');
  var pdLeft = document.getElementById('pdLeft');
  var pdTotal = document.getElementById('pdTotal');
  var pdError = document.getElementById('pdError');
  var pdStatus = document.getElementById('pdStatus');
  var pdClearBtn = document.getElementById('pdClearBtn');
  var pdBadge = document.getElementById('pdBadge');
  var selectedHeartBtn = document.getElementById('selectedHeartBtn');
  var pickerFilterEl = document.getElementById('pickerFilter');
  var pickAllBtn = document.getElementById('pickAllBtn');
  var pickShortlistBtn = document.getElementById('pickShortlistBtn');
  var shortlistCount = document.getElementById('shortlistCount');
  var shortlistNote = document.getElementById('shortlistNote');
  var shortlistFilled = document.getElementById('shortlistFilled');
  var shortlistEmpty = document.getElementById('shortlistEmpty');
  var shortlistTryBtn = document.getElementById('shortlistTryBtn');
  var shortlistClearBtn = document.getElementById('shortlistClearBtn');
  var compareWrap = document.getElementById('compareWrap');
  var compareHint = document.getElementById('compareHint');

  // ---------- browse elements ----------
  var filterBar = document.getElementById('filterBar');
  var libraryRow = document.getElementById('libraryRow');
  var catalogNote = document.getElementById('catalogNote');
  var selectedBanner = document.getElementById('selectedBanner');
  var selectedThumbWrap = document.getElementById('selectedThumbWrap');
  var selectedText = document.getElementById('selectedText');
  var selectedDetailsLink = document.getElementById('selectedDetailsLink');
  var stageStart = document.getElementById('stageStart');
  var photoLiveBtn = document.getElementById('photoLiveBtn');
  var photoViewport = document.getElementById('viewport');
  var photoError = document.getElementById('photoError');
  var adjustBox = document.getElementById('adjustBox');
  var catalogSearch = document.getElementById('catalogSearch');
  var filterToggleBtn = document.getElementById('filterToggleBtn');
  var filterPanel = document.getElementById('filterPanel');
  var filterCount = document.getElementById('filterCount');
  var filterDoneBtn = document.getElementById('filterDoneBtn');
  var clearFiltersBtn = document.getElementById('clearFiltersBtn');
  var sortSelect = document.getElementById('sortSelect');
  var activeFiltersEl = document.getElementById('activeFilters');
  var noResults = document.getElementById('noResults');
  var noResultsClearBtn = document.getElementById('noResultsClearBtn');
  var emptyCatalog = document.getElementById('emptyCatalog');
  var emptyCatalogText = document.getElementById('emptyCatalogText');
  var detailBody = document.getElementById('detailBody');
  var detailMissing = document.getElementById('detailMissing');
  var bulkError = document.getElementById('bulkError');
  var editError = document.getElementById('editError');
  var editNameInput = document.getElementById('editNameInput');
  var frameNameInput = document.getElementById('frameNameInput');

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
  var bgModeAutoBtn = document.getElementById('bgModeAutoBtn');
  var bgModeAutoHint = document.getElementById('bgModeAutoHint');
  var autoReview = document.getElementById('autoReview');
  var autoStatus = document.getElementById('autoStatus');
  var autoWarnings = document.getElementById('autoWarnings');
  var autoRimChips = document.getElementById('autoRimChips');
  var autoMaterialChips = document.getElementById('autoMaterialChips');
  var autoLevelChips = document.getElementById('autoLevelChips');
  var autoSens = document.getElementById('autoSens');
  var autoSensVal = document.getElementById('autoSensVal');
  var autoGuides = document.getElementById('autoGuides');
  var autoLevel = document.getElementById('autoLevel');
  var autoControls = document.getElementById('autoControls');
  var autoPreviewBtn = document.getElementById('autoPreviewBtn');
  var autoFallbackBtn = document.getElementById('autoFallbackBtn');
  var moveLensHint = document.getElementById('moveLensHint');
  var replaceTargetHint = document.getElementById('replaceTargetHint');
  var replaceTargetRow = document.getElementById('replaceTargetRow');
  var reprocessBtn = document.getElementById('reprocessBtn');
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
  var bgRemovalMode = 'auto'; // 'auto' | 'single' | 'twoShot' | 'ai'
  // Automatic extraction (frame-extract.js) of the photo being added: its result
  // is cached per set of options, so brush strokes don't re-run it.
  var auto = { result: null, key: '', busy: false, rim: 'auto', trans: 'auto', level: null, calibManual: false, token: 0 };
  var pendingSourceCanvas = null;   // the original photo (up to SOURCE_MAX_DIM), kept with the frame
  var pendingSourceIsNew = true;    // false while re-processing the stored original (no need to save it again)
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
  var editPhotoStatus = document.getElementById('editPhotoStatus');
  var editPhotoBtn = document.getElementById('editPhotoBtn');
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
    clearPd();
    catalogIndex = []; fullDataCache = {}; activeFrameId = null;
    allFreeTags = new Set();
    activeFilters = { shape: new Set(), color: new Set(), gender: new Set(), rim: new Set(), search: '' };
    catalogSearch.value = ''; sortSelect.value = 'new';
    catalogLoaded = false; tryonFrom = null;
    faceHasImage = false; facePoints = [];
    canvas.style.display = 'none'; video.style.display = 'none';
    retakeBtn.style.display = 'none'; fitRow.style.display = 'none';
    showPhotoError('');
    libraryRow.innerHTML = '';
    selectMode = false; selectedIds = new Set();
    libraryRow.classList.remove('selecting');
    bulkBar.style.display = 'none';
    editTagsPanel.style.display = 'none'; editingFrameId = null;
    syncStage();
  }

  // The try-on stage shows one thing at a time: the start panel, the live
  // camera, or the photo (camera preview or picture).
  function syncStage() {
    var liveOn = liveViewport.style.display !== 'none';
    var photoOn = !liveOn && (faceHasImage || !!stream);
    photoViewport.style.display = photoOn ? 'block' : 'none';
    stageStart.hidden = liveOn || photoOn;
    photoLiveBtn.style.display = photoOn && faceHasImage ? 'inline-flex' : 'none';
    liveTips.hidden = !liveOn;
    var adjustable = liveFitRow.style.display !== 'none' || fitRow.style.display !== 'none';
    adjustBox.hidden = !adjustable;
  }
  var photoErrorKey = '';
  function showPhotoError(key) {
    photoErrorKey = key || '';
    photoError.textContent = key ? t(key) : '';
    photoError.hidden = !key;
  }

  // ---------- helpers ----------

  function capDimensions(w, h, max) {
    if (Math.max(w, h) <= max) return { w: w, h: h };
    var s = max / Math.max(w, h);
    return { w: Math.round(w * s), h: Math.round(h * s) };
  }

  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  function normalizeSearch(s) {
    return (s || '').toLowerCase().replace(/[\u2018\u2019'".,]/g, '').replace(/[-_]/g, ' ');
  }

  // What customers call a frame: its name if staff gave it one, else colour and
  // shape in the current language ("Tortoise round frame", "काला गोल फ्रेम").
  function frameName(entry) {
    if (!entry) return '';
    if (entry.name) return entry.name;
    var tg = entry.tags || {};
    var en = getLang() === 'en';
    var color = tg.color ? tagAdjective(tg.color) : '';
    var shape = tg.shape ? (en ? tagLabel(tg.shape).toLowerCase() : tagLabel(tg.shape)) : '';
    var n = color && shape ? t('name.colorShape', { color: color, shape: shape })
      : color ? t('name.color', { color: color })
      : shape ? t('name.shape', { shape: shape }) : t('name.untitled');
    return n.charAt(0).toUpperCase() + n.slice(1);
  }
  // Secondary facts for cards: who it's for and the rim ("Men's, full-rim").
  function frameMeta(entry) {
    var tg = (entry && entry.tags) || {};
    var bits = [tg.gender ? tagLabel(tg.gender) : '', tg.rim ? tagLabel(tg.rim) : ''].filter(Boolean);
    var en = getLang() === 'en';
    return bits.map(function (b, i) { return i && en ? b.charAt(0).toLowerCase() + b.slice(1) : b; }).join(', ');
  }
  // Name plus the recorded size (if any), e.g. "Tortoise round frame, 49\u25A121 145".
  function describeFrame(entry) {
    if (!entry) return '';
    var size = sizeShort(entry.size);
    return frameName(entry) + (size ? ', ' + size : '');
  }
  // Everything a search can match, with tag words in every language, so "गोल",
  // "round" and "गोल फ्रेम" all find a round frame whatever language is showing.
  function searchText(entry) {
    var tg = (entry && entry.tags) || {};
    var words = [entry.name || '', frameName(entry), tg.shape, tg.color, tg.gender, tg.rim,
      sizeLabel(entry.size), entry.size && entry.size.eye ? entry.size.eye + 'mm' : ''];
    [tg.shape, tg.color, tg.gender, tg.rim].forEach(function (v) { words = words.concat(tagLabelsAll(v)); });
    return normalizeSearch(words.concat(tg.free || []).filter(Boolean).join(' '));
  }

  function findEntry(id) {
    if (id === DRAFT_ID) return draftEntry;
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
          var result = { img: img, p1: scalePoint(data.p1, data, img), p2: scalePoint(data.p2, data, img), fit: fitForImage(data, img) };
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

    var userScale = fitSize.value / 100 * trueSizeFactor(activeFrameId);
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
      syncStage();
      return;
    }
    if (detectingPupils) {
      calibBanner.textContent = t('calib.finding');
      calibBanner.style.display = 'block';
      recalBtn.style.display = 'none';
      fitRow.style.display = 'none';
    } else if (facePoints.length === 0) {
      calibBanner.textContent = photoManual ? t('calib.tapOne') : t('calib.noFace');
      calibBanner.style.display = 'block';
      recalBtn.style.display = 'none';
      fitRow.style.display = 'none';
    } else if (facePoints.length === 1) {
      calibBanner.textContent = t('calib.tapOther');
      calibBanner.style.display = 'block';
      recalBtn.style.display = 'none';
      fitRow.style.display = 'none';
    } else {
      calibBanner.style.display = 'none';
      recalBtn.style.display = 'inline-flex';
      fitRow.style.display = 'block';
    }
    syncStage();
  }

  function updateTryOnHint() {
    var noSel = !activeFrameId || !findEntry(activeFrameId);
    if (catalogLoaded && !catalogIndex.length) {
      noSelectionNote.style.display = 'flex';
      noSelectionText.textContent = t('try.noFrames');
      noSelectionBtn.style.display = staff.on ? 'inline-flex' : 'none';
      noSelectionBtn.textContent = t('try.addFrame');
      noSelectionBtn.onclick = function () { showTab('add'); };
    } else if (noSel && catalogLoaded) {
      noSelectionNote.style.display = 'flex';
      noSelectionText.textContent = t('try.choose');
      noSelectionBtn.style.display = 'inline-flex';
      noSelectionBtn.textContent = t('try.browse');
      noSelectionBtn.onclick = function () { showTab('browse'); };
    } else {
      noSelectionNote.style.display = 'none';
    }
  }

  function updateSelectedBanner() {
    var entry = activeFrameId ? findEntry(activeFrameId) : null;
    if (!entry) { selectedBanner.style.display = 'none'; syncPdStatus(); return; }
    selectedBanner.style.display = 'flex';
    selectedThumbWrap.innerHTML = '';
    var img = document.createElement('img');
    img.src = entry.thumbData;
    img.alt = '';
    selectedThumbWrap.appendChild(img);
    selectedText.textContent = describeFrame(entry);
    selectedDetailsLink.style.display = entry.draft ? 'none' : '';
    selectedHeartBtn.style.display = entry.draft ? 'none' : '';
    if (!entry.draft) {
      selectedDetailsLink.href = hashFor({ name: 'detail', id: entry.id });
      selectedDetailsLink.setAttribute('aria-label', t('try.currentDetails.aria', { name: frameName(entry) }));
      syncHeart(selectedHeartBtn, entry.id);
    }
    syncPdStatus();
  }

  // "Similar frames" on a frame's page: same shape first, then same colour.
  function updateSimilarCarousel() {
    similarRow.innerHTML = '';
    var baseId = view.name === 'detail' ? view.id : null;
    var active = baseId ? findEntry(baseId) : null;
    if (!active) { similarLabel.style.display = 'none'; similarRow.style.display = 'none'; return; }

    var pool = catalogIndex.filter(function (e) { return e.id !== active.id; });
    var sameShape = active.tags.shape ? pool.filter(function (e) { return e.tags.shape === active.tags.shape; }) : [];
    var sameColor = active.tags.color ? pool.filter(function (e) { return e.tags.color === active.tags.color && sameShape.indexOf(e) === -1; }) : [];
    var list = sameShape.concat(sameColor);
    if (!list.length) list = pool;
    list = list.slice(0, 10);

    if (!list.length) { similarLabel.style.display = 'none'; similarRow.style.display = 'none'; return; }

    similarLabel.textContent = sameShape.length
      ? t('detail.similarShape', { shape: getLang() === 'en' ? tagLabel(active.tags.shape).toLowerCase() : tagLabel(active.tags.shape) })
      : t('detail.similar');
    similarLabel.style.display = 'block';
    similarRow.style.display = 'flex';

    list.forEach(function (e) {
      var item = document.createElement('a');
      item.className = 'similar-item';
      item.href = hashFor({ name: 'detail', id: e.id });
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = e.thumbData;
      item.appendChild(img);
      var cap = document.createElement('span');
      cap.textContent = frameName(e);
      item.appendChild(cap);
      var sz = sizeShort(e.size);
      if (sz) { var z = document.createElement('span'); z.className = 'item-size'; z.textContent = sz; item.appendChild(z); }
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
      showPhotoError('');
      video.style.display = 'block';
      canvas.style.display = 'none';
      captureBtn.style.display = 'inline-flex';
      retakeBtn.style.display = 'inline-flex';
      retakeBtn.textContent = t('common.cancel');
      updateCalibBanner();
      syncStage();
    }).catch(function (err) {
      stopStream();
      video.style.display = 'none';
      syncStage();
      cameraPermissionState().then(function (state) { showPhotoError(liveCameraErrorMessage(err, state)); });
    });
  }

  function stopStream() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (video.style.display !== 'none' && !faceHasImage) { video.style.display = 'none'; captureBtn.style.display = 'none'; }
  }

  var MP_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
  var MP_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

  // Loaded once, on first use, not eagerly on page load -- the model is a real
  // download and most visits to this app never touch the Try On tab at all.
  var faceLandmarkerPromise = null;
  function getFaceLandmarker() {
    if (!faceLandmarkerPromise) {
      faceLandmarkerPromise = loadVision().then(function (vision) {
        return vision.FilesetResolver.forVisionTasks(MP_WASM).then(function (filesetResolver) { return [vision, filesetResolver]; });
      }).then(function (pair) {
        return pair[0].FaceLandmarker.createFromOptions(pair[1], {
          baseOptions: {
            modelAssetPath: MP_MODEL
          },
          runningMode: "IMAGE",
          numFaces: 1
        });
      }).catch(function (e) { faceLandmarkerPromise = null; throw e; });
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
    retakeBtn.style.display = 'inline-flex';
    retakeBtn.textContent = t('try.replace');
    photoManual = false;
    photoSource = 'camera';
    syncStage();
    redrawFacePreview();
    detectFaceInPhoto();
    track('customer_session_started', { source: 'camera' });
    bumpPhotoCount();
  }

  var PHOTO_TYPES = /^image\/(jpeg|png|webp)$/;
  var PHOTO_MAX_BYTES = 25 * 1024 * 1024;
  function handleFaceUpload(file) {
    stopStream();
    showPhotoError('');
    if (file.type && !PHOTO_TYPES.test(file.type)) {
      showPhotoError(/heic|heif/i.test(file.type + file.name) ? 'photo.heic' : 'photo.type');
      syncStage();
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) { showPhotoError('photo.big'); syncStage(); return; }
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var capped = capDimensions(img.naturalWidth, img.naturalHeight, MAX_FACE_DIM);
      faceBaseCanvas.width = capped.w; faceBaseCanvas.height = capped.h;
      canvas.width = capped.w; canvas.height = capped.h;
      faceBaseCanvas.getContext('2d').drawImage(img, 0, 0, capped.w, capped.h);

      faceHasImage = true;
      facePoints = [];
      photoManual = false;
      fitSize.value = 100; fitSizeVal.textContent = '100%';
      video.style.display = 'none';
      canvas.style.display = 'block';
      captureBtn.style.display = 'none';
      retakeBtn.style.display = 'inline-flex';
      retakeBtn.textContent = t('try.replace');
      photoSource = 'upload';
      syncStage();
      redrawFacePreview();
      detectFaceInPhoto();
      URL.revokeObjectURL(url);
      track('customer_session_started', { source: 'upload' });
      bumpPhotoCount();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      showPhotoError('photo.broken');
      syncStage();
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
    video.style.display = 'none';
    canvas.style.display = 'none';
    captureBtn.style.display = 'none';
    retakeBtn.style.display = 'none';
    photoToggleBtn.style.display = 'none';
    photoCatalogBtn.style.display = 'none';
    updateCalibBanner();
    syncStage();
  }

  var photoManual = false;           // true once staff chose to mark the pupils by hand
  var photoSource = null;            // 'upload' | 'camera': what "Replace photo" goes back to
  canvas.addEventListener('click', function (e) {
    if (!faceHasImage || facePoints.length >= 2 || detectingPupils) return;
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    facePoints.push({ x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY });
    updateCalibBanner();
    redrawFacePreview();
  });

  cameraBtn.addEventListener('click', function () { stopLive(); showLiveError(''); startCamera(); });
  uploadBtn.addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) { stopLive(); showLiveError(''); handleFaceUpload(e.target.files[0]); }
  });
  captureBtn.addEventListener('click', capturePhoto);
  // Manual taps replace the automatic fit (and its 3D pose) with the 2D overlay.
  recalBtn.addEventListener('click', function () { facePoints = []; photo3d = null; photoManual = true; updateCalibBanner(); redrawFacePreview(); });
  retakeBtn.addEventListener('click', function () {
    var hadPhoto = faceHasImage;
    retakeFace();
    // "Replace photo" goes straight back to where the photo came from
    if (hadPhoto && photoSource === 'upload') { fileInput.value = ''; fileInput.click(); }
    else if (hadPhoto && photoSource === 'camera') startCamera();
    else stageStart.querySelector('button').focus();
  });
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
  var LEGACY_FRAME_DIM = 700;   // working size of frame photos before imgW/imgH were stored
  function legacyShrinkFactor(img) {
    var long = Math.max(img.naturalWidth, img.naturalHeight), s = 1;
    for (var n = 1; n <= 7; n++) {
      s *= 0.82;
      if (Math.abs(long - Math.max(80, Math.round(LEGACY_FRAME_DIM * s))) <= 1) return long / LEGACY_FRAME_DIM;
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
      return { img: r[0].img, p1: r[0].p1, p2: r[0].p2, fit: r[0].fit || null, tags: (entry && entry.tags) || {}, size: entry ? entry.size : null, side: r[1] };
    });
  }

  // Fitting metadata is stored in the saved image's pixels; if the image on
  // hand has another size, scale it to match.
  function fitForImage(data, img) {
    var fit = data.fit;
    if (!fit || !fit.v) return null;
    var w = data.imgW, h = data.imgH;
    if (!w || !h || (w === img.naturalWidth && h === img.naturalHeight)) return fit;
    var sx = img.naturalWidth / w, sy = img.naturalHeight / h;
    function mp(p) { return p && { x: p.x * sx, y: p.y * sy }; }
    var out = JSON.parse(JSON.stringify(fit));
    out.lenses.forEach(function (ln) { ln.poly = ln.poly.map(mp); ln.centre = mp(ln.centre); });
    Object.keys(out.landmarks).forEach(function (k) { if (out.landmarks[k] && out.landmarks[k].x != null) out.landmarks[k] = mp(out.landmarks[k]); });
    return out;
  }

  // Makes the renderer show frame `id`; resolves true when it's ready, false if it
  // can't be shown in 3D (then the caller uses the 2D overlay for this frame).
  function arUseFrame(id) {
    var r = ar.renderer, entry = findEntry(id);
    if (!r || !id) return Promise.resolve(false);
    if (entry && entry.level === '2d') return Promise.resolve(false);   // prepared as a flat overlay
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

  // ---------- true size: the customer's PD from their eye test ----------
  // Kept in memory only (never stored or sent), and cleared with the rest of the
  // customer's visit. With a frame whose size is recorded, the frame is drawn at
  // its real width relative to the customer's eyes; without a PD, the adult
  // average (63 mm) is used. Frames without a recorded size are fitted to the eyes.
  var pdValue = null;
  function customerPD() { return pdValue != null ? pdValue : DEFAULT_PD_MM; }
  function fmtMm(v) { return v == null ? '' : String(Math.round(v * 10) / 10); }
  function frameLensDistMm(entry) {
    var sz = entry ? cleanSize(entry.size) : null;
    return sz && sz.eye && sz.bridge ? sz.eye + sz.bridge : null;
  }
  // flat overlay: how much bigger or smaller than "lens centres on the pupils" the frame really is
  function trueSizeFactor(id) {
    var L = frameLensDistMm(findEntry(id));
    if (!L) return 1;
    return Math.max(0.7, Math.min(1.45, L / customerPD()));
  }
  function setPd(v) {
    if (v === pdValue) { syncPdStatus(); return; }
    pdValue = v;
    if (ar.renderer) ar.renderer.setPD(customerPD());
    redrawFacePreview();
    syncPdStatus();
  }
  function num(input) {
    var raw = (input.value || '').trim().replace(',', '.');
    return raw === '' ? null : parseFloat(raw);
  }
  // Reads the inputs; returns the text key of a problem, or ''.
  function readPd() {
    if (pdSplit.checked) {
      var r = num(pdRight), l = num(pdLeft);
      var okR = r != null && r >= 25 && r <= 40, okL = l != null && l >= 25 && l <= 40;
      if (r == null && l == null) { pdTotal.textContent = ''; setPd(null); return ''; }
      if (okR && okL) {
        var tot = Math.round((r + l) * 10) / 10;
        pdTotal.textContent = t('pd.total', { pd: fmtMm(tot) });
        setPd(tot);
        return '';
      }
      pdTotal.textContent = '';
      setPd(null);
      return (r != null && !okR) || (l != null && !okL) ? 'pd.err.half' : '';
    }
    var v = num(pdInput);
    if (v == null) { setPd(null); return ''; }
    if (v >= 50 && v <= 80) { setPd(Math.round(v * 10) / 10); return ''; }
    setPd(null);
    return 'pd.err.range';
  }
  var pdErrorKey = '';
  function showPdError(key) {
    pdErrorKey = key || '';
    pdError.textContent = key ? t(key) : '';
    pdError.classList.toggle('show', !!key);
    [pdInput, pdRight, pdLeft].forEach(function (el) { el.setAttribute('aria-invalid', key ? 'true' : 'false'); });
  }
  // while typing: apply when valid, keep quiet otherwise; when done (change): say what's wrong
  [pdInput, pdRight, pdLeft].forEach(function (el) {
    el.addEventListener('input', function () { var k = readPd(); if (!k) showPdError(''); });
    el.addEventListener('change', function () { showPdError(readPd()); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); showPdError(readPd()); } });
  });
  pdSplit.addEventListener('change', function () {
    pdSplitRow.hidden = !pdSplit.checked;
    pdSingle.hidden = pdSplit.checked;
    showPdError(readPd());
    (pdSplit.checked ? pdRight : pdInput).focus();
  });
  function clearPd() {
    pdInput.value = ''; pdRight.value = ''; pdLeft.value = '';
    pdSplit.checked = false; pdSplitRow.hidden = true; pdSingle.hidden = false;
    pdTotal.textContent = '';
    showPdError('');
    setPd(null);
  }
  pdClearBtn.addEventListener('click', function () { clearPd(); pdInput.focus(); });
  // ?pd=62.5 in the address (a link or QR code from the eye test)
  function applyPdFromLink(v) {
    if (!(v >= 50 && v <= 80)) return;
    pdSplit.checked = false; pdSplitRow.hidden = true; pdSingle.hidden = false;
    pdInput.value = fmtMm(v);
    showPdError(readPd());
    customerLastActive = Date.now();
    toast(t('pd.applied', { pd: fmtMm(v) }));
  }
  function syncPdStatus() {
    var entry = activeFrameId ? findEntry(activeFrameId) : null;
    pdClearBtn.hidden = pdValue == null && !(pdInput.value || pdRight.value || pdLeft.value);
    if (!entry) { pdStatus.textContent = ''; pdBadge.textContent = ''; pdBadge.className = 'pd-badge'; return; }
    var key = !frameLensDistMm(entry) ? 'noSize' : pdValue != null ? 'true' : 'avg';
    pdStatus.textContent = t('pd.status.' + key, { pd: fmtMm(pdValue) });
    pdBadge.textContent = t('pd.badge.' + key);
    pdBadge.className = 'pd-badge ' + key;
  }

  // ---------- shortlist: frames a customer liked, to compare (this visit only) ----------
  // Kept in this browser tab only (sessionStorage), never in the account, and
  // cleared after 20 minutes without anyone using the screen.
  var SHORTLIST_MAX = 6;
  var CUSTOMER_IDLE_MS = 20 * 60 * 1000;
  var shortlist = [];
  var customerLastActive = Date.now();
  var pickerFilter = 'all';
  function shortlistKey() { return 'fts.shortlist.' + (currentUser ? currentUser.uid : ''); }
  function saveShortlist() {
    try {
      if (shortlist.length) sessionStorage.setItem(shortlistKey(), JSON.stringify({ ids: shortlist, at: Date.now() }));
      else sessionStorage.removeItem(shortlistKey());
    } catch (e) { /* storage blocked: the shortlist just lasts until the page is reloaded */ }
  }
  function restoreShortlist() {
    shortlist = [];
    try {
      var raw = JSON.parse(sessionStorage.getItem(shortlistKey()) || 'null');
      if (raw && Array.isArray(raw.ids) && Date.now() - (raw.at || 0) < CUSTOMER_IDLE_MS) {
        shortlist = raw.ids.filter(function (x) { return typeof x === 'string'; }).slice(0, SHORTLIST_MAX);
      }
    } catch (e) { shortlist = []; }
    syncShortlistUi();
  }
  function inShortlist(id) { return !!id && shortlist.indexOf(id) !== -1; }
  function toggleShortlist(id) {
    var entry = findEntry(id);
    if (!entry || entry.draft) return;
    if (inShortlist(id)) {
      shortlist = shortlist.filter(function (x) { return x !== id; });
      toast(t('sl.removed'));
    } else {
      if (shortlist.length >= SHORTLIST_MAX) { toast(t('sl.full', { n: SHORTLIST_MAX }), 'error'); return; }
      shortlist.push(id);
      toast(t('sl.added'));
    }
    saveShortlist();
    syncShortlistUi();
  }
  // drop frames that are no longer in the catalogue
  function pruneShortlist() {
    if (!catalogLoaded) return;
    var before = shortlist.length;
    shortlist = shortlist.filter(function (id) { var e = findEntry(id); return e && !e.draft; });
    if (shortlist.length !== before) saveShortlist();
  }
  function heartSvg() {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16.6S3.6 12.9 3.6 8.2A3.3 3.3 0 0 1 10 6.6a3.3 3.3 0 0 1 6.4 1.6c0 4.7-6.4 8.4-6.4 8.4z"/></svg>';
  }
  // A heart button: icon-only ones carry the action in their label; text ones say it
  function syncHeart(btn, id) {
    if (!btn) return;
    var entry = id ? findEntry(id) : null;
    var on = inShortlist(id);
    btn.classList.toggle('on', on);
    var name = entry ? frameName(entry) : '';
    var label = btn.querySelector('.heart-label');
    if (label) label.textContent = on ? t('sl.removeBtn') : t('sl.add');
    else btn.setAttribute('aria-label', on ? t('sl.removeAria', { name: name }) : t('sl.addAria', { name: name }));
  }
  function syncShortlistUi() {
    var n = shortlist.length;
    shortlistCount.textContent = n ? String(n) : '';
    tabShortlistBtn.setAttribute('aria-label', tn('nav.shortlist.aria', n));
    document.querySelectorAll('[data-heart]').forEach(function (b) { syncHeart(b, b.getAttribute('data-heart')); });
    syncHeart(selectedHeartBtn, activeFrameId);
    pickShortlistBtn.textContent = t('try.pick.shortlist', { n: n });
    pickerFilterEl.hidden = n === 0;
    if (!n) pickerFilter = 'all';
    syncPickerFilter();
    if (view.name === 'tryon') renderLiveStrip();
    if (view.name === 'shortlist') renderShortlistPage();
  }
  function syncPickerFilter() {
    [[pickAllBtn, pickerFilter === 'all'], [pickShortlistBtn, pickerFilter === 'shortlist']].forEach(function (p) {
      p[0].classList.toggle('active', p[1]);
      p[0].setAttribute('aria-pressed', p[1] ? 'true' : 'false');
    });
  }
  pickAllBtn.addEventListener('click', function () { pickerFilter = 'all'; syncPickerFilter(); renderLiveStrip(); });
  pickShortlistBtn.addEventListener('click', function () { pickerFilter = 'shortlist'; syncPickerFilter(); renderLiveStrip(); });
  selectedHeartBtn.addEventListener('click', function () { if (activeFrameId) toggleShortlist(activeFrameId); });

  // The end of a customer's visit: their shortlist and PD go (camera and photo
  // have their own rules: they never outlive the try-on page).
  function endCustomerSession() {
    shortlist = [];
    saveShortlist();
    clearPd();
    syncShortlistUi();
  }
  ['pointerdown', 'keydown'].forEach(function (type) { document.addEventListener(type, function () { customerLastActive = Date.now(); }, true); });
  setInterval(function () {
    var idle = Date.now() - customerLastActive;
    if (idle > CUSTOMER_IDLE_MS && (shortlist.length || pdValue != null || pdInput.value || pdRight.value || pdLeft.value)) endCustomerSession();
    else if (shortlist.length && idle < 60000) saveShortlist();      // keep the stored list fresh while in use
  }, 30000);

  // Side-by-side comparison of the shortlisted frames.
  function renderShortlistPage() {
    pruneShortlist();
    var entries = shortlist.map(findEntry).filter(function (e) { return e && !e.draft; });
    var waiting = !catalogLoaded && shortlist.length > 0;
    shortlistNote.textContent = waiting ? t('cat.loading') : entries.length ? tn('cat.count', entries.length) : '';
    shortlistFilled.hidden = !entries.length;
    shortlistEmpty.hidden = !!entries.length || waiting;
    compareWrap.innerHTML = '';
    if (!entries.length) return;
    var table = document.createElement('table');
    table.className = 'compare-table';
    var cap = document.createElement('caption');
    cap.className = 'visually-hidden';
    cap.textContent = t('sl.compare');
    table.appendChild(cap);
    var thead = document.createElement('thead'), hr = document.createElement('tr');
    hr.appendChild(document.createElement('td'));
    entries.forEach(function (e) {
      var th = document.createElement('th');
      th.scope = 'col';
      var a = document.createElement('a');
      a.className = 'compare-frame';
      a.href = hashFor({ name: 'detail', id: e.id });
      var media = document.createElement('span');
      media.className = 'compare-media';
      var img = document.createElement('img');
      img.alt = ''; img.src = e.thumbData; img.decoding = 'async';
      media.appendChild(img);
      a.appendChild(media);
      var nm = document.createElement('span');
      nm.className = 'compare-name';
      nm.textContent = frameName(e);
      a.appendChild(nm);
      th.appendChild(a);
      var acts = document.createElement('div');
      acts.className = 'compare-actions';
      var tryB = document.createElement('button');
      tryB.type = 'button'; tryB.className = 'btn primary small';
      tryB.textContent = t('card.tryon');
      tryB.setAttribute('aria-label', t('card.tryon.aria', { name: frameName(e) }));
      tryB.addEventListener('click', function () { pickerFilter = 'shortlist'; syncPickerFilter(); tryOnFrame(e.id, 'auto'); });
      var rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'btn secondary small';
      rm.textContent = t('sl.remove');
      rm.setAttribute('aria-label', t('sl.removeAria', { name: frameName(e) }));
      rm.addEventListener('click', function () {
        toggleShortlist(e.id);
        var next = compareWrap.querySelector('.compare-actions .btn.secondary');
        (next || shortlistEmpty.querySelector('a')).focus();
      });
      acts.appendChild(tryB); acts.appendChild(rm);
      th.appendChild(acts);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    var anyMaterial = entries.some(function (e) { return e.prepared === 'auto' && e.translucent != null; });
    var rows = [
      ['attr.size', function (e) { var sz = sizeShort(e.size); return sz || t('sl.none'); }, 'mono'],
      ['attr.shape', function (e) { return e.tags.shape ? tagLabel(e.tags.shape) : t('sl.none'); }],
      ['attr.colour', function (e) { return e.tags.color ? tagLabel(e.tags.color) : t('sl.none'); }],
      ['attr.rim', function (e) { return e.tags.rim ? tagLabel(e.tags.rim) : t('sl.none'); }],
      ['attr.for', function (e) { return e.tags.gender ? tagLabel(e.tags.gender) : t('sl.none'); }]
    ];
    if (anyMaterial) rows.push(['attr.material', function (e) { return e.prepared === 'auto' && e.translucent != null ? t(e.translucent ? 'material.translucent' : 'material.solid') : t('sl.none'); }]);
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.scope = 'row';
      th.textContent = t(row[0]);
      tr.appendChild(th);
      entries.forEach(function (e) {
        var td = document.createElement('td');
        td.textContent = row[1](e);
        if (row[2]) td.className = row[2];
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    compareWrap.appendChild(table);
    requestAnimationFrame(function () { compareHint.hidden = compareWrap.scrollWidth <= compareWrap.clientWidth + 2; });
  }
  shortlistTryBtn.addEventListener('click', function () {
    pruneShortlist();
    if (!shortlist.length) return;
    pickerFilter = 'shortlist';
    syncPickerFilter();
    tryOnFrame(inShortlist(activeFrameId) ? activeFrameId : shortlist[0], 'auto');
  });
  shortlistClearBtn.addEventListener('click', function () {
    var n = shortlist.length;
    if (!n) return;
    confirmAction({ title: t('sl.clearTitle'), body: t('sl.clearBody', { n: n }), ok: t('sl.clear'), cancel: t('common.cancel'), danger: true }).then(function (yes) {
      if (!yes) return;
      shortlist = [];
      saveShortlist();
      syncShortlistUi();
      toast(t('sl.cleared'));
    });
  });

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
      liveLandmarkerPromise = loadVision().then(function (vision) {
        return vision.FilesetResolver.forVisionTasks(MP_WASM).then(function (fileset) { return [vision, fileset]; });
      }).then(function (pair) {
        var vision = pair[0], fileset = pair[1];
        function make(delegate) {
          return vision.FaceLandmarker.createFromOptions(fileset, {
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

  // takes a text key; remembered so a language change can re-render it
  var liveErrorKey = '';
  function showLiveError(key) {
    liveErrorKey = key || '';
    liveError.textContent = key ? t(key) : '';
    liveError.style.display = key ? 'block' : 'none';
  }

  function liveCameraErrorMessage(err, permissionState) {
    var name = err && err.name;
    // some browsers report a refused permission with other error names
    if (permissionState === 'denied' || name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return 'cam.blocked';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'cam.none';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return 'cam.busy';
    }
    return 'cam.other';
  }

  function cameraPermissionState() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve('unknown');
      return navigator.permissions.query({ name: 'camera' }).then(function (s) { return s.state; }, function () { return 'unknown'; });
    } catch (e) { return Promise.resolve('unknown'); }
  }

  function syncLiveToggle() {
    liveToggleBtn.textContent = live.overlayOn ? t('try.hide') : t('try.show');
    liveToggleBtn.setAttribute('aria-pressed', live.overlayOn ? 'false' : 'true');
  }

  function setLiveRunningUi(running) {
    liveStartBtn.disabled = false;
    liveStopBtn.style.display = running ? 'inline-flex' : 'none';
    liveToggleBtn.style.display = running ? 'inline-flex' : 'none';
    liveCatalogBtn.style.display = running && activeFrameId && activeFrameId !== DRAFT_ID ? 'inline-flex' : 'none';
    liveFitRow.style.display = running ? 'block' : 'none';
    if (!running) liveSwitchBtn.style.display = 'none';
    syncStage();
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
    liveViewport.classList.remove('no-face');
    live.noFace = false;
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
      showLiveError('cam.unsupported');
      return;
    }
    stopLive();
    stopStream();
    retakeFace();                       // leave photo mode cleanly
    var token = ++live.token;
    var stage = 'camera';
    liveStartBtn.disabled = true;
    showPhotoError('');
    liveViewport.style.display = 'block';
    liveViewport.classList.remove('no-face');
    syncStage();
    setLiveStatus(t('live.starting'));

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
      if (liveVideo.videoWidth && liveVideo.videoHeight) liveViewport.style.setProperty('--cam-ar', liveVideo.videoWidth + ' / ' + liveVideo.videoHeight);
      stage = 'model';
      setLiveStatus(liveLandmarkerPromise ? t('live.loading') : t('live.loadingFirst'));
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
        showLiveError('cam.model');
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
        if (!live.noFace) { live.noFace = true; liveViewport.classList.add('no-face'); }
        setLiveStatus(t('live.noFace'));
      } else if (r3 && now - live.lastSeen > FACE_BLINK_MS) {
        r3.clear();               // don't leave glasses floating where the face was
      }                           // (a one- or two-frame dropout keeps the last glasses: no flicker)
      return;
    }
    live.lastSeen = now;
    if (live.noFace) { live.noFace = false; liveViewport.classList.remove('no-face'); }

    if (!activeFrameId) { if (r3) r3.clear(); setLiveStatus(t('live.choose')); return; }
    if (!live.overlayOn) { if (r3) r3.clear(); setLiveStatus(t('live.hidden')); return; }

    // 3D path: full head pose (turns, nods, tilts), perspective, occlusion
    if (r3 && ar.failedKey !== activeFrameId) {
      if (ar.frameKey !== activeFrameId) {
        r3.clear();
        arUseFrame(activeFrameId);
        setLiveStatus(t('live.preparing'));
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
      setLiveStatus(turn > 1.0 ? t('live.turnBack') : '');
      return;
    }
    if (r3) r3.clear();

    // 2D fallback (no WebGL, or this frame can't be built in 3D)
    if (live.failedId === activeFrameId) { setLiveStatus(t('live.cantShow')); return; }
    if (live.frameId !== activeFrameId) { loadLiveFrame(activeFrameId); setLiveStatus(t('live.loadingFrame')); return; }

    var pose = live.smoother.update(raw, now);
    var tf = frameTransform(live.frame, pose, liveFit.value / 100 * trueSizeFactor(activeFrameId));
    if (!tf) { setLiveStatus(t('live.cantShow')); return; }
    setLiveStatus('');
    drawFrame(g, live.frame.img, tf);
  }

  function renderLiveStrip() {
    liveStrip.innerHTML = '';
    var q = normalizeSearch(liveSearch.value);
    var pool = catalogIndex;
    if (pickerFilter === 'shortlist') pool = shortlist.map(findEntry).filter(function (e) { return e && !e.draft; });
    var list = pool.filter(function (e) {
      if (!q) return true;
      var hay = searchText(e);
      return q.split(/\s+/).every(function (word) { return hay.indexOf(word) !== -1; });
    });
    if (draftEntry && pickerFilter !== 'shortlist') list = [draftEntry].concat(list);
    list.forEach(function (e) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'similar-item' + (e.id === activeFrameId ? ' active' : '');
      item.dataset.id = e.id;
      item.setAttribute('aria-pressed', e.id === activeFrameId ? 'true' : 'false');
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = e.thumbData;
      item.appendChild(img);
      var cap = document.createElement('span');
      cap.textContent = e.draft ? t('try.unsaved') : frameName(e);
      item.appendChild(cap);
      var sz = sizeShort(e.size);
      if (sz) { var z = document.createElement('span'); z.className = 'item-size'; z.textContent = sz; item.appendChild(z); }
      item.setAttribute('aria-label', t('card.tryon.aria', { name: describeFrame(e) }));
      item.addEventListener('click', function () { selectFrame(e.id); });
      liveStrip.appendChild(item);
    });
    liveStrip.style.display = list.length ? '' : 'none';
    if (catalogLoaded && !catalogIndex.length && !draftEntry) {
      liveStripEmpty.textContent = t('try.pick.empty');
      liveStripEmpty.style.display = 'block';
    } else if (catalogLoaded && !list.length) {
      liveStripEmpty.textContent = t(pickerFilter === 'shortlist' ? 'try.pick.noneShortlist' : 'try.pick.none');
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
  photoLiveBtn.addEventListener('click', function () { startLive(); });   // from a photo straight to the live camera
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
  liveSearch.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
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
    frameNameInput.value = '';
    renderAddChips();
    freeTagInput.value = '';
    renderFreeTagList();
  }
  renderAddChips();

  function renderFreeTagList() {
    freeTagList.innerHTML = '';
    pendingTags.free.forEach(function (tag) {
      var chip = document.createElement('span');
      chip.className = 'tag-chip removable';
      chip.appendChild(document.createTextNode(tag + ' '));
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'tag-remove';
      x.textContent = '\u00d7';
      x.setAttribute('aria-label', t('add.removeTag', { tag: tag }));
      x.addEventListener('click', function () {
        pendingTags.free = pendingTags.free.filter(function (f) { return f !== tag; });
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
    editPendingTags.free.forEach(function (tag) {
      var chip = document.createElement('span');
      chip.className = 'tag-chip removable';
      chip.appendChild(document.createTextNode(tag + ' '));
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'tag-remove';
      x.textContent = '\u00d7';
      x.setAttribute('aria-label', t('add.removeTag', { tag: tag }));
      x.addEventListener('click', function () {
        editPendingTags.free = editPendingTags.free.filter(function (f) { return f !== tag; });
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
    var tg = entry.tags || {};
    editPendingTags = { shape: tg.shape || null, color: tg.color || null, gender: tg.gender || null, rim: tg.rim || null, free: (tg.free || []).slice() };

    editThumbWrap.innerHTML = '';
    var img = document.createElement('img');
    img.src = entry.thumbData;
    img.alt = '';
    editThumbWrap.appendChild(img);
    editNameInput.value = entry.name || '';
    editError.classList.remove('show');

    renderEditChips();
    renderEditFreeTagList();
    editFreeTagInput.value = '';
    fillSize(entry.size, editSizeEye, editSizeBridge, editSizeTemple);
    syncEditPanelText();

    editTagsPanel.style.display = 'block';
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    editTagsPanel.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    editNameInput.focus({ preventScroll: true });
  }

  function renderEditChips() {
    renderChipGroup(editShapeChips, 'shape', editPendingTags.shape, function (v) { editPendingTags.shape = v; });
    renderChipGroup(editColorChips, 'color', editPendingTags.color, function (v) { editPendingTags.color = v; });
    renderChipGroup(editGenderChips, 'gender', editPendingTags.gender, function (v) { editPendingTags.gender = v; });
    renderChipGroup(editRimChips, 'rim', editPendingTags.rim, function (v) { editPendingTags.rim = v; });
  }
  // The editor's code-drawn text (also redrawn when the language changes).
  function syncEditPanelText() {
    var entry = editingFrameId && findEntry(editingFrameId);
    if (!entry) return;
    editNameInput.placeholder = frameName(Object.assign({}, entry, { name: null }));
    editSideStatus.textContent = entry.hasSide ? t('edit.side.own') : t('edit.side.generated');
    editPhotoStatus.textContent = preparedText(entry);
    editSideBtn.textContent = entry.hasSide ? t('staffTools.replaceTemple') : t('staffTools.addTemple');
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
  editPhotoBtn.addEventListener('click', function () {
    var id = editingFrameId;
    closeEditTags();
    if (id) enterReplaceMode(id);
  });
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
    var newName = editNameInput.value.trim().slice(0, 60) || null;
    saveTagsBtn.disabled = true;
    editError.classList.remove('show');
    updateDoc(doc(db, 'users', currentUser.uid, 'frames', id), { tags: newTags, size: newSize, name: newName }).then(function () {
      var entry = findEntry(id);
      if (entry) { entry.tags = newTags; entry.size = newSize; entry.name = newName; }
      arForget(id);                       // tags/size change how the 3D model is built
      renderLiveStrip();
      if (activeFrameId === id) redrawFacePreview();
      saveTagsBtn.disabled = false;
      renderLibrary();
      rebuildFilterBar();
      applyFilters();
      if (activeFrameId === id) updateSelectedBanner();
      closeEditTags();
      if (view.name === 'detail' && view.id === id) renderDetail(id);
      toast(t('toast.saved'));
    }).catch(function (e) {
      console.error('Failed to save tags', e);
      saveTagsBtn.disabled = false;
      editError.textContent = t('edit.err');
      editError.classList.add('show');
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
    bulkCountLabel.textContent = tn('bulk.count', selectedIds.size);
  }

  function updateApplyBulkState() {
    var anyTouched = bulkTouched.shape || bulkTouched.color || bulkTouched.gender || bulkTouched.rim;
    applyBulkBtn.disabled = !(selectedIds.size > 0 && anyTouched);
  }

  function enterSelectMode() {
    if (!staff.on) return;
    selectMode = true;
    selectedIds = new Set();
    bulkPending = { shape: null, color: null, gender: null, rim: null };
    bulkTouched = { shape: false, color: false, gender: false, rim: false };
    renderBulkChips();
    bulkError.classList.remove('show');
    bulkBar.style.display = 'block';
    selectModeBtn.style.display = 'none';
    updateBulkCountLabel();
    updateApplyBulkState();
    renderLibrary();
  }

  function exitSelectMode() {
    selectMode = false;
    selectedIds = new Set();
    bulkBar.style.display = 'none';
    selectModeBtn.style.display = '';
    renderLibrary();
  }

  selectModeBtn.addEventListener('click', enterSelectMode);
  exitSelectModeBtn.addEventListener('click', exitSelectMode);

  applyBulkBtn.addEventListener('click', function () {
    if (!currentUser || !selectedIds.size) return;
    applyBulkBtn.disabled = true;
    bulkError.classList.remove('show');
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
      toast(tn('bulk.done', ids.length));
    }).catch(function (e) {
      console.error('Bulk tag update failed', e);
      renderLibrary(); rebuildFilterBar();
      bulkError.textContent = t('bulk.err');
      bulkError.classList.add('show');
      applyBulkBtn.disabled = false;
    });
  });

  // ---------- filtering, search and sorting ----------

  function facetLabel(k) { return t('facet.' + k); }
  var FACET_KEYS = ['shape', 'color', 'gender', 'rim'];

  function activeFilterCount() {
    return FACET_KEYS.reduce(function (n, k) { return n + activeFilters[k].size; }, 0);
  }

  function frameMatchesFilters(entry) {
    var t = (entry && entry.tags) || {};
    for (var i = 0; i < FACET_KEYS.length; i++) {
      var k = FACET_KEYS[i];
      if (activeFilters[k].size && !activeFilters[k].has(t[k])) return false;
    }
    if (activeFilters.search) {
      var hay = searchText(entry);
      var words = activeFilters.search.split(/\s+/).filter(Boolean);
      for (var j = 0; j < words.length; j++) if (hay.indexOf(words[j]) === -1) return false;
    }
    return true;
  }

  function applyFilters() {
    var cards = libraryRow.querySelectorAll('.frame-card'), shown = 0;
    for (var i = 0; i < cards.length; i++) {
      var entry = findEntry(cards[i].dataset.id);
      var ok = !!entry && frameMatchesFilters(entry);
      cards[i].style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    var total = catalogIndex.length;
    noResults.hidden = !(catalogLoaded && total && shown === 0);
    emptyCatalog.hidden = !(catalogLoaded && total === 0) && !catalogProblem;
    var n = activeFilterCount();
    filterCount.textContent = n ? String(n) : '';
    filterToggleBtn.setAttribute('aria-label', n ? t('cat.filters.aria', { n: n }) : t('cat.filters'));
    filterDoneBtn.textContent = tn('cat.show', shown);
    renderActiveFilters();
    updateCatalogNote(shown);
  }

  function updateCatalogNote(shown) {
    var total = catalogIndex.length;
    if (shown == null) {
      shown = 0;
      catalogIndex.forEach(function (e) { if (frameMatchesFilters(e)) shown++; });
    }
    var filtering = activeFilterCount() > 0 || !!activeFilters.search;
    if (!catalogLoaded) catalogNote.textContent = catalogProblem ? '' : t('cat.loading');
    else if (!total) catalogNote.textContent = '';
    else if (filtering) catalogNote.textContent = t('cat.showing', { shown: shown, total: total });
    else catalogNote.textContent = tn('cat.count', total);
  }

  function toggleFilter(facet, value) {
    if (activeFilters[facet].has(value)) activeFilters[facet].delete(value);
    else activeFilters[facet].add(value);
    filterBar.querySelectorAll('[data-facet="' + facet + '"]').forEach(function (b) {
      var on = activeFilters[facet].has(b.dataset.value);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    applyFilters();
  }

  function clearAllFilters() {
    activeFilters = { shape: new Set(), color: new Set(), gender: new Set(), rim: new Set(), search: '' };
    catalogSearch.value = '';
    rebuildFilterBar();
    applyFilters();
  }

  function rebuildFilterBar() {
    filterBar.innerHTML = '';
    var values = { shape: {}, color: {}, gender: {}, rim: {} };
    catalogIndex.forEach(function (e) {
      var tg = e.tags || {};
      FACET_KEYS.forEach(function (k) { if (tg[k]) values[k][tg[k]] = (values[k][tg[k]] || 0) + 1; });
    });
    var any = false;
    FACET_KEYS.forEach(function (k) {
      // forget filters for values no frame has any more
      activeFilters[k].forEach(function (v) { if (!values[k][v]) activeFilters[k].delete(v); });
      var keys = Object.keys(values[k]);
      if (!keys.length) return;
      any = true;
      var order = FACETS[k].options;
      keys.sort(function (a, b) {
        var ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      });
      var group = document.createElement('fieldset');
      group.className = 'filter-group';
      var legend = document.createElement('legend');
      legend.textContent = facetLabel(k);
      group.appendChild(legend);
      var row = document.createElement('div');
      row.className = 'chip-row';
      keys.forEach(function (v) {
        var on = activeFilters[k].has(v);
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tag-chip' + (on ? ' active' : '');
        chip.dataset.facet = k; chip.dataset.value = v;
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        chip.textContent = tagLabel(v);
        var count = document.createElement('span');
        count.className = 'visually-hidden';
        count.textContent = tn('cat.chipCount', values[k][v]);
        chip.appendChild(count);
        chip.addEventListener('click', function () { toggleFilter(k, v); });
        row.appendChild(chip);
      });
      group.appendChild(row);
      filterBar.appendChild(group);
    });
    if (!any && catalogIndex.length) {
      var none = document.createElement('p');
      none.className = 'hint';
      none.textContent = t('cat.noTags');
      filterBar.appendChild(none);
    }
    filterToggleBtn.hidden = !any;
    clearFiltersBtn.hidden = !any;
  }

  function renderActiveFilters() {
    activeFiltersEl.innerHTML = '';
    FACET_KEYS.forEach(function (k) {
      activeFilters[k].forEach(function (v) {
        var chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.appendChild(document.createTextNode(tagLabel(v)));
        var x = document.createElement('button');
        x.type = 'button';
        x.className = 'chip-x';
        x.setAttribute('aria-label', t('cat.removeFilter', { facet: facetLabel(k), value: tagLabel(v) }));
        x.textContent = '×';
        x.addEventListener('click', function () {
          toggleFilter(k, v);
          var next = activeFiltersEl.querySelector('.chip-x');
          (next || catalogSearch).focus();
        });
        chip.appendChild(x);
        activeFiltersEl.appendChild(chip);
      });
    });
    if (activeFilterCount() > 1) {
      var clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'link-btn';
      clear.textContent = t('cat.clearAll');
      clear.addEventListener('click', function () { clearAllFilters(); catalogSearch.focus(); });
      activeFiltersEl.appendChild(clear);
    }
  }

  catalogSearch.addEventListener('input', function () { activeFilters.search = normalizeSearch(catalogSearch.value).trim(); applyFilters(); });
  catalogSearch.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); catalogSearch.blur(); } });
  sortSelect.addEventListener('change', function () { renderLibrary(); });
  clearFiltersBtn.addEventListener('click', clearAllFilters);
  noResultsClearBtn.addEventListener('click', function () { clearAllFilters(); catalogSearch.focus(); });
  function setFilterPanel(open) {
    filterPanel.classList.toggle('open', open);
    filterToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  filterToggleBtn.addEventListener('click', function () {
    var open = !filterPanel.classList.contains('open');
    setFilterPanel(open);
    if (open) { var first = filterPanel.querySelector('.tag-chip'); if (first) first.focus(); }
  });
  filterDoneBtn.addEventListener('click', function () {
    setFilterPanel(false);
    filterToggleBtn.focus();
    var first = libraryRow.querySelector('.frame-card:not([style*="none"])');
    if (first) first.scrollIntoView({ block: 'nearest' });
  });

  function addedAt(entry) {
    if (entry.createdAt) return entry.createdAt;
    var m = /^f(\d{10,})/.exec(entry.id || '');
    return m ? Number(m[1]) : 0;
  }
  function sortedCatalog() {
    var mode = sortSelect.value;
    var order = new Map(catalogIndex.map(function (e, i) { return [e.id, i]; }));
    return catalogIndex.slice().sort(function (a, b) {
      if (mode === 'eye') {
        var ea = (a.size && a.size.eye) || Infinity, eb = (b.size && b.size.eye) || Infinity;
        if (ea !== eb) return ea - eb;
      }
      var d = addedAt(b) - addedAt(a);
      if (mode === 'old') d = -d;
      return d || order.get(a.id) - order.get(b.id);
    });
  }

  // ---------- catalogue: cards ----------

  function renderLibrary() {
    libraryRow.innerHTML = '';
    libraryRow.classList.toggle('selecting', selectMode);
    sortedCatalog().forEach(function (entry) {
      var isSelected = selectMode && selectedIds.has(entry.id);
      var card = document.createElement('article');
      card.className = 'frame-card' + (isSelected ? ' selected' : '');
      card.dataset.id = entry.id;

      var mark = document.createElement('span');
      mark.className = 'frame-card-select-mark';
      mark.setAttribute('aria-hidden', 'true');
      card.appendChild(mark);

      var media = document.createElement('div');
      media.className = 'frame-card-media';
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 260; img.height = 160;
      img.alt = '';
      img.src = entry.thumbData;
      media.appendChild(img);
      card.appendChild(media);
      if (!selectMode) {
        var heart = document.createElement('button');
        heart.type = 'button';
        heart.className = 'icon-btn heart-btn card-heart';
        heart.setAttribute('data-heart', entry.id);
        heart.innerHTML = heartSvg();
        heart.addEventListener('click', function () { toggleShortlist(entry.id); });
        syncHeart(heart, entry.id);
        card.appendChild(heart);
      }

      var body = document.createElement('div');
      body.className = 'frame-card-body';
      var title = document.createElement('h2');
      title.className = 'frame-card-title';
      var link = document.createElement('a');
      link.className = 'frame-card-link';
      link.href = hashFor({ name: 'detail', id: entry.id });
      link.textContent = frameName(entry);
      link.addEventListener('click', function (e) {
        if (selectMode) { e.preventDefault(); toggleSelected(entry.id, card); }
      });
      title.appendChild(link);
      body.appendChild(title);
      var sizeText = sizeShort(entry.size);
      if (sizeText) {
        var sz = document.createElement('div');
        sz.className = 'frame-card-size';
        sz.textContent = sizeText;
        sz.setAttribute('aria-label', sizeSpoken(entry.size));
        body.appendChild(sz);
      }
      var meta = frameMeta(entry);
      if (meta) {
        var m = document.createElement('div');
        m.className = 'frame-card-meta';
        m.textContent = meta;
        body.appendChild(m);
      }
      card.appendChild(body);

      if (!selectMode) {
        var actions = document.createElement('div');
        actions.className = 'frame-card-actions';
        var tryBtn = document.createElement('button');
        tryBtn.type = 'button';
        tryBtn.className = 'btn secondary frame-card-tryon';
        tryBtn.textContent = t('card.tryon');
        tryBtn.setAttribute('aria-label', t('card.tryon.aria', { name: frameName(entry) }));
        tryBtn.addEventListener('click', function () { tryOnFrame(entry.id, 'auto'); });
        actions.appendChild(tryBtn);
        card.appendChild(actions);
      } else {
        card.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        card.addEventListener('click', function (e) {
          if (e.target.closest('a')) return;
          toggleSelected(entry.id, card);
        });
      }
      libraryRow.appendChild(card);
    });
    applyFilters();
  }

  function sizeShort(size) {
    var sz = cleanSize(size);
    if (!sz) return '';
    return sz.eye && sz.bridge ? sizeLabel(sz) : sizeSpoken(sz);
  }
  // "lens width 52 mm, bridge 18 mm, temple 140 mm" (the □ sign isn't read out well)
  function sizeSpoken(size) {
    var sz = cleanSize(size);
    if (!sz) return '';
    return [sz.eye ? t('size.part.eye', { n: sz.eye }) : '', sz.bridge ? t('size.part.bridge', { n: sz.bridge }) : '', sz.temple ? t('size.part.temple', { n: sz.temple }) : ''].filter(Boolean).join(', ');
  }

  function toggleSelected(id, card) {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    card.classList.toggle('selected', selectedIds.has(id));
    card.setAttribute('aria-selected', selectedIds.has(id) ? 'true' : 'false');
    updateBulkCountLabel();
    updateApplyBulkState();
  }

  var catalogProblem = false;
  function showCatalogProblem(on) {
    catalogProblem = on;
    var h = emptyCatalog.querySelector('h2');
    if (on) {
      h.textContent = t('cat.error.title');
      emptyCatalogText.textContent = t('cat.error.text');
      var b = emptyCatalog.querySelector('button');
      if (!b) {
        b = document.createElement('button');
        b.type = 'button'; b.className = 'btn primary';
        b.addEventListener('click', function () { if (currentUser) { catalogNote.textContent = t('cat.loading'); loadCatalog(currentUser.uid); } });
        emptyCatalog.appendChild(b);
      }
      b.textContent = t('cat.error.retry');
    } else {
      h.textContent = t('cat.empty.title');
      emptyCatalogText.textContent = staff.on ? t('cat.empty.staff') : t('cat.empty.customer');
      var old = emptyCatalog.querySelector('button');
      if (old) old.parentNode.removeChild(old);
    }
    emptyCatalog.hidden = !on && !(catalogLoaded && !catalogIndex.length);
  }

  // ---------- frame details ----------

  function sizeMark(size) {
    var s = cleanSize(size);
    if (!s || !(s.eye || s.bridge || s.temple)) return null;
    var wrap = document.createElement('figure');
    wrap.className = 'size-mark';
    wrap.style.margin = '0 0 24px';
    var ns = 'http://www.w3.org/2000/svg';
    function el(name, attrs, text) {
      var e = document.createElementNS(ns, name);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      if (text != null) e.textContent = text;
      return e;
    }
    // a frame front with its lens width and bridge measured, as on an optician's drawing
    var svg = el('svg', { viewBox: '0 0 360 132', class: 'size-mark-figure', role: 'img', 'aria-hidden': 'true' });
    svg.appendChild(el('rect', { x: 18, y: 42, width: 136, height: 70, rx: 26, class: 'lens' }));
    svg.appendChild(el('rect', { x: 206, y: 42, width: 136, height: 70, rx: 26, class: 'lens' }));
    svg.appendChild(el('path', { d: 'M154 60 Q180 46 206 60', class: 'lens' }));
    if (s.eye) {
      svg.appendChild(el('path', { d: 'M18 22 H154 M18 16 V28 M154 16 V28', class: 'dim' }));
      svg.appendChild(el('text', { x: 86, y: 14, 'text-anchor': 'middle' }, String(s.eye)));
      svg.appendChild(el('text', { x: 86, y: 128, 'text-anchor': 'middle', class: 'cap' }, t('size.lensWidth')));
    }
    if (s.bridge) {
      svg.appendChild(el('path', { d: 'M154 36 H206 M154 30 V42 M206 30 V42', class: 'dim' }));
      svg.appendChild(el('text', { x: 180, y: 26, 'text-anchor': 'middle' }, String(s.bridge)));
      svg.appendChild(el('text', { x: 180, y: 128, 'text-anchor': 'middle', class: 'cap' }, t('size.bridge')));
    }
    if (s.temple) svg.appendChild(el('text', { x: 274, y: 128, 'text-anchor': 'middle', class: 'cap' }, t('size.temple', { n: s.temple })));
    wrap.appendChild(svg);
    var code = document.createElement('p');
    code.className = 'size-mark-code';
    code.textContent = sizeLabel(s);
    wrap.appendChild(code);
    var cap = document.createElement('figcaption');
    cap.className = 'size-mark-legend';
    cap.textContent = t('size.caption', { parts: sizeSpoken(s) });
    wrap.appendChild(cap);
    return wrap;
  }

  // How the try-on asset was made (for staff).
  function preparedText(entry) {
    if (entry.prepared === 'auto') {
      var details = [rimLabel(entry.rimType), t(entry.translucent ? 'prep.translucent' : 'prep.solid'), t(entry.level === '2d' ? 'prep.2d' : 'prep.3d')].filter(Boolean).join(', ');
      return t('prep.auto', { details: details }) + (entry.hasSource ? ' ' + t('prep.kept') : '');
    }
    var flat = entry.level === '2d';
    return t(entry.hasSource ? (flat ? 'prep.handFlatKept' : 'prep.handKept') : (flat ? 'prep.handFlat' : 'prep.hand'));
  }

  function renderDetail(id) {
    detailBody.innerHTML = '';
    var entry = findEntry(id);
    if (!entry || entry.draft) {
      similarLabel.style.display = 'none'; similarRow.style.display = 'none';
      if (!catalogLoaded && !catalogProblem) {
        var wait = document.createElement('p');
        wait.className = 'page-count';
        wait.setAttribute('role', 'status');
        wait.textContent = t('detail.loading');
        detailBody.appendChild(wait);
        detailMissing.hidden = true;
        setTitle(t('title.frame'));
        return;
      }
      detailMissing.hidden = false;
      setTitle(t('title.notFound'));
      return;
    }
    detailMissing.hidden = true;
    var name = frameName(entry);
    setTitle(name);
    var tg = entry.tags || {};
    var en = getLang() === 'en';

    var grid = document.createElement('div');
    grid.className = 'detail-grid';
    var media = document.createElement('div');
    media.className = 'detail-media';
    var img = document.createElement('img');
    img.alt = name + (tg.color && entry.name ? ', ' + (en ? tagLabel(tg.color).toLowerCase() : tagLabel(tg.color)) : '');
    img.src = entry.thumbData;
    media.appendChild(img);
    grid.appendChild(media);

    var info = document.createElement('div');
    info.className = 'detail-info';
    var h1 = document.createElement('h1');
    h1.id = 'detailTitle';
    h1.textContent = name;
    info.appendChild(h1);
    var subBits = [];
    if (entry.name && (tg.color || tg.shape)) {
      subBits.push([tg.color ? tagLabel(tg.color) : '', tg.shape ? (en ? tagLabel(tg.shape).toLowerCase() : tagLabel(tg.shape)) : ''].filter(Boolean).join(' '));
    }
    var meta = frameMeta(entry);
    if (meta) subBits.push(subBits.length && en ? meta.charAt(0).toLowerCase() + meta.slice(1) : meta);
    if (subBits.length) {
      var sub = document.createElement('p');
      sub.className = 'detail-sub';
      sub.textContent = subBits.join(', ');
      info.appendChild(sub);
    }
    var mark = sizeMark(entry.size);

    var dl = document.createElement('dl');
    dl.className = 'attr-list';
    function attr(label, value) {
      if (!value) return;
      var dt = document.createElement('dt'); dt.textContent = label;
      var dd = document.createElement('dd'); dd.textContent = value;
      dl.appendChild(dt); dl.appendChild(dd);
    }
    attr(t('attr.shape'), tg.shape && tagLabel(tg.shape));
    attr(t('attr.colour'), tg.color && tagLabel(tg.color));
    attr(t('attr.rim'), tg.rim && tagLabel(tg.rim));
    attr(t('attr.for'), tg.gender && tagLabel(tg.gender));
    if (entry.translucent != null && entry.prepared === 'auto') attr(t('attr.material'), t(entry.translucent ? 'material.translucent' : 'material.solid'));
    if (tg.free && tg.free.length) attr(t('attr.tags'), tg.free.join(', '));
    if (!mark) attr(t('attr.size'), t('attr.sizeMissing'));

    var actions = document.createElement('div');
    actions.className = 'detail-actions';
    var liveBtn = document.createElement('button');
    liveBtn.type = 'button';
    liveBtn.className = 'btn primary large';
    liveBtn.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="5" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m14 9 4-2.5v7L14 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    liveBtn.appendChild(document.createTextNode(t('detail.tryCamera')));
    liveBtn.addEventListener('click', function () { tryOnFrame(entry.id, 'live'); });
    var photoBtn = document.createElement('button');
    photoBtn.type = 'button';
    photoBtn.className = 'btn secondary large';
    photoBtn.textContent = t('detail.tryPhoto');
    photoBtn.addEventListener('click', function () { tryOnFrame(entry.id, 'photo'); });
    actions.appendChild(liveBtn);
    actions.appendChild(photoBtn);
    info.appendChild(actions);
    var heart = document.createElement('button');
    heart.type = 'button';
    heart.className = 'btn secondary heart-btn heart-text';
    heart.setAttribute('data-heart', entry.id);
    heart.innerHTML = heartSvg() + '<span class="heart-label"></span>';
    heart.addEventListener('click', function () { toggleShortlist(entry.id); });
    syncHeart(heart, entry.id);
    info.appendChild(heart);
    var note = document.createElement('p');
    note.className = 'detail-note';
    note.textContent = t('detail.note');
    info.appendChild(note);
    // the try-on actions come first; the size and the details follow
    if (mark) {
      if (frameLensDistMm(entry)) {
        var ts = document.createElement('p');
        ts.className = 'size-mark-true';
        ts.textContent = t('detail.trueSize');
        mark.appendChild(ts);
      }
      info.appendChild(mark);
    }
    if (dl.children.length) info.appendChild(dl);

    if (staff.on) {
      var tools = document.createElement('div');
      tools.className = 'staff-tools';
      var th = document.createElement('h2');
      th.textContent = t('staffTools.title');
      tools.appendChild(th);
      var prep = document.createElement('p');
      prep.className = 'hint staff-prepared';
      prep.textContent = preparedText(entry);
      tools.appendChild(prep);
      var row = document.createElement('div');
      row.className = 'row';
      [[t('staffTools.edit'), function () { openEditTags(entry.id); }, 'secondary'],
       [t('staffTools.photo'), function () { enterReplaceMode(entry.id); }, 'secondary'],
       [entry.hasSide ? t('staffTools.replaceTemple') : t('staffTools.addTemple'), function () { enterSideMode(entry.id); }, 'secondary'],
       [t('staffTools.delete'), function () { removeFrame(entry.id); }, 'danger']].forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small ' + a[2];
        b.textContent = a[0];
        b.addEventListener('click', a[1]);
        row.appendChild(b);
      });
      tools.appendChild(row);
      info.appendChild(tools);
    }
    grid.appendChild(info);
    detailBody.appendChild(grid);
    updateSimilarCarousel();

    // the full-size picture (and whether a try-on asset exists at all)
    getFullFrameData(entry.id).then(function (full) {
      if (view.name !== 'detail' || view.id !== entry.id) return;
      if (full.img && full.img.src) img.src = full.img.src;
    }).catch(function (e) {
      if (view.name !== 'detail' || view.id !== entry.id) return;
      console.warn('No try-on picture for this frame', e);
      var msg = document.createElement('p');
      msg.className = 'detail-unavailable';
      msg.textContent = staff.on ? t('detail.noAsset.staff') : t('detail.noAsset.customer');
      if (actions.parentNode) actions.parentNode.replaceChild(msg, actions);
      note.textContent = '';
      entry.noAsset = true;
    });
  }

  // From a card, a frame's page or "Frame details": open the try-on with this frame.
  function tryOnFrame(id, mode) {
    var entry = findEntry(id);
    if (!entry) return;
    var fromDetail = view.name === 'detail';
    selectFrame(id, { keepUrl: true });
    navigate({ name: 'tryon', id: id }, { from: fromDetail ? id : null });
    if (mode === 'live') startLive();
    else if (mode === 'photo') { fileInput.value = ''; fileInput.click(); }
    else {
      // from the catalogue: start the camera straight away only if it's already allowed
      cameraPermissionState().then(function (state) {
        if (state === 'granted' && view.name === 'tryon' && !live.running && !faceHasImage && !stream) startLive();
        else if (view.name === 'tryon') { var b = document.getElementById('liveStartBtn'); if (b && !stageStart.hidden) b.focus({ preventScroll: true }); }
      });
    }
  }

  function removeFrame(id) {
    var entry = findEntry(id);
    if (!currentUser || !entry) return;
    confirmAction({
      title: t('del.title'),
      body: [t('del.body', { name: frameName(entry) })],
      ok: t('del.ok'), cancel: t('common.cancel'), danger: true
    }).then(function (yes) {
      if (!yes) return;
      var uid = currentUser.uid;
      return Promise.all([
        deleteDoc(doc(db, 'users', uid, 'frames', id)),
        deleteDoc(doc(db, 'users', uid, 'framesFull', id))
      ]).then(function () {
        deleteDoc(doc(db, 'users', uid, 'framesSide', id)).catch(function (e) { console.error('Failed to delete temple photo', e); });
        deleteDoc(doc(db, 'users', uid, 'framesSource', id)).catch(function (e) { console.error('Failed to delete original photo', e); });
        catalogIndex = catalogIndex.filter(function (f) { return f.id !== id; });
        delete fullDataCache[id];
        selectedIds.delete(id);
        var el = libraryRow.querySelector('[data-id="' + id + '"]');
        if (el) el.parentNode.removeChild(el);
        if (activeFrameId === id) { activeFrameId = null; redrawFacePreview(); }
        if (editingFrameId === id) closeEditTags();
        rebuildFilterBar();
        applyFilters();
        updateSelectedBanner();
        updateTryOnHint();
        renderLiveStrip();
        arForget(id);
        if (addTarget.kind === 'side' && addTarget.frameId === id) { discardPendingFrame(); exitSideMode(); }
        if (addTarget.kind === 'replace' && addTarget.frameId === id) { discardPendingFrame(); exitReplaceMode(); }
        if (inShortlist(id)) { shortlist = shortlist.filter(function (x) { return x !== id; }); saveShortlist(); syncShortlistUi(); }
        toast(t('del.done'));
        if (view.name === 'detail' && view.id === id) navigate({ name: 'browse', id: null }, { replace: true });
      }).catch(function (e) {
        console.error('Failed to delete frame', e);
        toast(t('del.fail'), 'error');
      });
    });
  }

  // "Return to the product": the frame's own page.
  function showInCatalog(id) {
    if (!id || id === DRAFT_ID || !findEntry(id)) return;
    navigate({ name: 'detail', id: id });
  }

  function updateCatalogButtons() {
    var inCatalog = activeFrameId && activeFrameId !== DRAFT_ID;
    liveCatalogBtn.style.display = live.running && inCatalog ? 'inline-flex' : 'none';
    var photoReady = faceHasImage && activeFrameId && facePoints.length >= 2;
    photoCatalogBtn.style.display = photoReady && inCatalog ? 'inline-flex' : 'none';
    photoToggleBtn.style.display = photoReady ? 'inline-flex' : 'none';
    photoToggleBtn.textContent = photoOverlayOn ? t('try.hide') : t('try.show');
    photoToggleBtn.setAttribute('aria-pressed', photoOverlayOn ? 'false' : 'true');
  }

  function selectFrame(id, opts) {
    activeFrameId = id;
    live.overlayOn = true;
    photoOverlayOn = true;
    syncLiveToggle();
    updateLiveStripActive();
    updateCatalogButtons();
    if (view.name === 'tryon' && id !== DRAFT_ID && !(opts && opts.keepUrl)) {
      history.replaceState(null, '', hashFor({ name: 'tryon', id: id }));
    }
    if (view.name === 'tryon') view.id = id === DRAFT_ID ? null : id;
    updateSelectedBanner();
    updateTryOnHint();
    redrawFacePreview();
    var entry = findEntry(id);
    if (entry && !entry.draft) {
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
      photoCountDisplay.textContent = t('staff.photoCount', { n: count });
      photoCountDisplay.dataset.count = count;
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
    showCatalogProblem(false);
    return getDocs(collection(db, 'users', uid, 'frames')).then(function (snap) {
      if (!currentUser || currentUser.uid !== uid) return;
      catalogIndex = [];
      snap.forEach(function (d) {
        var data = d.data();
        if (data.tags && data.tags.free) data.tags.free.forEach(function (t) { allFreeTags.add(t); });
        var created = data.createdAt && typeof data.createdAt.toMillis === 'function' ? data.createdAt.toMillis() : null;
        catalogIndex.push({
          id: d.id, thumbData: data.thumbData, tags: data.tags || {}, size: cleanSize(data.size), hasSide: !!data.hasSide,
          name: typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 60) : null, createdAt: created,
          hasSource: !!data.hasSource, level: data.level || '3d', rimType: data.rimType || null,
          translucent: data.translucent == null ? null : !!data.translucent, prepared: data.prepared || 'manual'
        });
      });
      catalogLoaded = true;
      refreshTagSuggestions();
      rebuildFilterBar();
      renderLibrary();
      showCatalogProblem(false);
      updateTryOnHint();
      pruneShortlist();
      syncShortlistUi();
      renderLiveStrip();
      // a link straight to a frame or a try-on can only be honoured now
      if (view.name === 'detail') renderDetail(view.id);
      if (view.name === 'tryon') {
        if (view.id && findEntry(view.id) && activeFrameId !== view.id) selectFrame(view.id, { keepUrl: true });
        syncTryonBack(); updateSelectedBanner();
      }
    }).catch(function (e) {
      console.error('Failed to load catalog', e);
      catalogIndex = [];
      catalogLoaded = false;
      libraryRow.innerHTML = '';
      showCatalogProblem(true);
      updateCatalogNote(0);
      updateTryOnHint();
      if (view.name === 'detail') renderDetail(view.id);
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

  // The add page's placeholder text for the current mode (or the last error).
  var addSourceErrorKey = null;
  function addSourceText() {
    if (addSourceErrorKey) return t(addSourceErrorKey);
    if (bgRemovalMode === 'twoShot' && addTarget.kind !== 'side') return t(twoShotStep === 1 ? 'add.two.ph1' : 'add.two.ph2');
    return t(addTarget.kind === 'side' ? 'add.ph.side' : 'add.ph.front');
  }
  function showAddSourceError(key) {
    addSourceErrorKey = key;
    frameSourcePlaceholder.textContent = t(key);
    frameSourcePlaceholder.style.display = 'block';
  }
  function updateFrameSourceUI() {
    addSourceErrorKey = null;
    var none = t(addTarget.kind === 'side' ? 'add.ph.side' : 'add.ph.front');
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
    twoShotStepLabel.textContent = t(twoShotStep === 1 ? 'add.two.step1' : 'add.two.step2');
    frameSourcePlaceholder.textContent = t(twoShotStep === 1 ? 'add.two.ph1' : 'add.two.ph2');
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
    bgModeAutoBtn.classList.toggle('active', mode === 'auto');
    bgModeAutoHint.style.display = mode === 'auto' ? 'block' : 'none';
    bgModeSingleBtn.classList.toggle('active', mode === 'single');
    bgModeTwoShotBtn.classList.toggle('active', mode === 'twoShot');
    bgModeAiBtn.classList.toggle('active', mode === 'ai');
    [[bgModeAutoBtn, 'auto'], [bgModeSingleBtn, 'single'], [bgModeTwoShotBtn, 'twoShot'], [bgModeAiBtn, 'ai']].forEach(function (p) {
      p[0].setAttribute('aria-pressed', mode === p[1] ? 'true' : 'false');
    });
    bgModeHint.style.display = (mode === 'twoShot') ? 'block' : 'none';
    bgModeAiHint.style.display = (mode === 'ai') ? 'block' : 'none';
    clearBackgroundReference();
  }
  bgModeAutoBtn.addEventListener('click', function () { setBgMode('auto'); reprocessIfPending(); });
  bgModeSingleBtn.addEventListener('click', function () { setBgMode('single'); reprocessIfPending(); });
  bgModeTwoShotBtn.addEventListener('click', function () { setBgMode('twoShot'); });
  bgModeAiBtn.addEventListener('click', function () { setBgMode('ai'); });
  retakeBgBtn.addEventListener('click', clearBackgroundReference);

  // Temple (side) photos have no lenses to find, so they use the simple removal.
  function effectiveMode() {
    return bgRemovalMode === 'auto' && addTarget.kind === 'side' ? 'single' : bgRemovalMode;
  }

  // Switching between the automatic and simple modes re-processes the photo
  // already loaded (the two-photo and AI modes need a new photo).
  function reprocessIfPending() {
    if (!pendingRawCanvas || bgRemovalMode === 'twoShot' || bgRemovalMode === 'ai') return;
    toleranceRow.style.display = effectiveMode() === 'single' ? 'block' : 'none';
    processPendingFrame();
  }

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
    // keep the original photo (larger than the working copy) to store with the frame
    var cs = capDimensions(naturalW, naturalH, SOURCE_MAX_DIM);
    pendingSourceCanvas = document.createElement('canvas');
    pendingSourceCanvas.width = cs.w; pendingSourceCanvas.height = cs.h;
    pendingSourceCanvas.getContext('2d').drawImage(source, 0, 0, cs.w, cs.h);
    auto.result = null; auto.key = ''; auto.calibManual = false; auto.rim = 'auto'; auto.trans = 'auto'; auto.level = null;
    autoSens.value = 100; autoSensVal.textContent = '100%';
    var mode = effectiveMode();
    toleranceRow.style.display = (mode === 'single' || mode === 'twoShot') ? 'block' : 'none';
    autoReview.style.display = mode === 'auto' ? 'block' : 'none';
    toolHistory = [];
    setTool('none');
    updateUndoState();
    resetTagInputs();
    if (addTarget.kind === 'replace') prefillFromEntry(findEntry(addTarget.frameId));
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
      pendingSourceIsNew = true;
      beginAddFrameFromSource(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      showAddSourceError('add.err.file');
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
      showAddSourceError('add.err.camera');
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
    pendingSourceIsNew = true;
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

  function autoKey() { return [autoSens.value, auto.rim, auto.trans].join('|'); }

  // Runs the automatic extraction (about a second; longer on phones) after
  // letting the page show that it is working.
  function runAuto() {
    var token = ++auto.token, key = autoKey(), raw = pendingRawCanvas;
    auto.busy = true;
    renderAutoReview();
    updateFrameCalibBanner();
    setTimeout(function () {
      if (token !== auto.token || raw !== pendingRawCanvas) return;
      loadExtract().then(function (m) {
        if (token !== auto.token || raw !== pendingRawCanvas) return null;
        var img = raw.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, raw.width, raw.height);
        return m.extractFrame(img, {
          sensitivity: autoSens.value / 100,
          rimType: auto.rim,
          translucent: auto.trans === 'auto' ? 'auto' : auto.trans === '1'
        });
      }).catch(function (e) {
        console.error('Automatic extraction failed', e);
        return { ok: false, reason: 'Something went wrong while finding the frame. Check the connection and try again.' };
      }).then(function (res) {
      if (res === null || token !== auto.token || raw !== pendingRawCanvas) return;
      auto.busy = false;
      auto.result = res; auto.key = key;
      if (res.ok && !auto.calibManual) {
        frameCalibPoints = [res.landmarks.lensL, res.landmarks.lensR].map(function (p) { return { x: Math.round(p.x), y: Math.round(p.y) }; });
      }
      // fill the catalogue's rim tag from the detected rim type, unless chosen already
      if (res.ok && !pendingTags.rim && addTarget.kind !== 'replace') {
        pendingTags.rim = { full: 'fullrim', semi: 'semirimless', rimless: 'rimless' }[res.rimType] || null;
        renderAddChips();
      }
      if (!res.ok && !auto.calibManual) frameCalibPoints = [];
      renderAutoReview();
      processPendingFrame();
      });
    }, 40);
  }

  function chipsActive(container, attr, value) {
    container.querySelectorAll('.tag-chip').forEach(function (c) { c.classList.toggle('active', c.getAttribute(attr) === value); });
  }

  var RIM_TAG = { full: 'fullrim', semi: 'semirimless', rimless: 'rimless' };
  function rimLabel(rimType) { return rimType ? tagLabel(RIM_TAG[rimType] || rimType) : ''; }
  // The extraction's notes, in the current language (English text as the fallback).
  function fxWarning(wn) { var k = 'fx.w.' + wn.code; return t(k, wn.vars || null) === k ? wn.message : t(k, wn.vars || null); }
  function fxLevelLabel(rep) {
    if (rep.level === '3d') return t('fx.level.3d');
    var reasons = (rep.reasons || []).map(function (c) { return t('fx.reason.' + c); });
    return t('fx.level.2d', { reasons: reasons.length ? reasons.join('; ') : t('fx.reason.default') });
  }

  function renderAutoReview() {
    var r = auto.result;
    autoWarnings.innerHTML = '';
    if (auto.busy) {
      autoStatus.textContent = t('add.auto.finding');
      autoControls.style.display = 'none'; autoLevel.textContent = ''; autoLevelChips.style.display = 'none';
      autoPreviewBtn.style.display = 'none'; autoFallbackBtn.style.display = 'none';
      return;
    }
    if (!r) return;
    if (!r.ok) {
      autoStatus.textContent = t('add.auto.notFound');
      var li = document.createElement('li'); li.className = 'error';
      li.textContent = (r.code ? t('fx.fail.' + r.code) : r.reason) + ' ' + t('add.auto.notFoundTip');
      autoWarnings.appendChild(li);
      autoControls.style.display = 'block'; autoLevelChips.style.display = 'none'; autoLevel.textContent = '';
      autoPreviewBtn.style.display = 'none'; autoFallbackBtn.style.display = 'inline-block';
      return;
    }
    var level = currentLevel();
    var bits = [rimLabel(r.rimType), t(r.translucent ? 'prep.translucent' : 'prep.solid'), t(level === '3d' ? 'prep.3d' : 'prep.2d')];
    var q = t(r.quality >= 0.85 ? 'add.auto.q.good' : r.quality >= 0.6 ? 'add.auto.q.check' : 'add.auto.q.bad');
    autoStatus.innerHTML = '';
    var strong = document.createElement('span'); strong.textContent = t('add.auto.found', { details: bits.join(' \u00b7 ') });
    var muted = document.createElement('span'); muted.className = 'muted'; muted.textContent = ' (' + q + ')';
    autoStatus.appendChild(strong); autoStatus.appendChild(muted);
    r.warnings.forEach(function (wn) {
      var item = document.createElement('li');
      item.className = wn.severity;
      item.textContent = fxWarning(wn);
      autoWarnings.appendChild(item);
    });
    chipsActive(autoRimChips, 'data-rim', r.rimType);
    chipsActive(autoMaterialChips, 'data-trans', r.translucent ? '1' : '0');
    chipsActive(autoLevelChips, 'data-level', level);
    autoControls.style.display = 'block'; autoLevelChips.style.display = 'flex';
    autoLevel.textContent = level === r.representation.level ? fxLevelLabel(r.representation)
      : t(level === '3d' ? 'add.auto.hand3d' : 'add.auto.hand2d');
    autoPreviewBtn.style.display = 'inline-block'; autoFallbackBtn.style.display = 'none';
  }

  function currentLevel() {
    return auto.level || (auto.result && auto.result.ok ? auto.result.representation.level : '3d');
  }

  autoRimChips.addEventListener('click', function (e) {
    var v = e.target.getAttribute('data-rim'); if (!v) return;
    auto.rim = v; processPendingFrame();
  });
  autoMaterialChips.addEventListener('click', function (e) {
    var v = e.target.getAttribute('data-trans'); if (!v) return;
    auto.trans = v; processPendingFrame();
  });
  autoLevelChips.addEventListener('click', function (e) {
    var v = e.target.getAttribute('data-level'); if (!v) return;
    auto.level = v; renderAutoReview(); schedulePreview();
  });
  autoSens.addEventListener('input', function () { autoSensVal.textContent = autoSens.value + '%'; });
  autoSens.addEventListener('change', function () { processPendingFrame(); });
  autoGuides.addEventListener('change', function () { drawFrameCalibView(); });
  autoFallbackBtn.addEventListener('click', function () { setBgMode('single'); reprocessIfPending(); });
  autoPreviewBtn.addEventListener('click', function () { startDraftPreview(); });

  function processPendingFrame() {
    if (!pendingRawCanvas) return;
    var w = pendingRawCanvas.width, h = pendingRawCanvas.height;
    var mode = effectiveMode();
    autoReview.style.display = mode === 'auto' ? 'block' : 'none';
    if (mode === 'auto' && (!auto.result || auto.key !== autoKey())) {
      if (!auto.busy || auto.key !== autoKey()) runAuto();
      // show the photo itself while it works
      pendingProcessedCanvas.width = w; pendingProcessedCanvas.height = h;
      pendingProcessedCanvas.getContext('2d').drawImage(pendingRawCanvas, 0, 0);
      frameCalibCanvas.width = w; frameCalibCanvas.height = h;
      drawFrameCalibView();
      return;
    }
    pendingProcessedCanvas.width = w;
    pendingProcessedCanvas.height = h;
    var pctx = pendingProcessedCanvas.getContext('2d', { willReadFrequently: true });
    var useAi = (mode === 'ai' && pendingAiRemovedCanvas &&
      pendingAiRemovedCanvas.width === w && pendingAiRemovedCanvas.height === h);
    var useTwoShot = !useAi && mode === 'twoShot' && pendingBgOnlyCanvas &&
      pendingBgOnlyCanvas.width === w && pendingBgOnlyCanvas.height === h;
    var useAuto = mode === 'auto' && auto.result && auto.result.ok;

    pctx.clearRect(0, 0, w, h);
    pctx.drawImage(useAi ? pendingAiRemovedCanvas : pendingRawCanvas, 0, 0, w, h);
    var imgData = pctx.getImageData(0, 0, w, h);

    if (useAuto) {
      imgData.data.set(auto.result.cutout.data);
    } else if (mode === 'auto') {
      // extraction failed: show the photo so the problem is visible
    } else if (useAi) {
      // Already cleanly cut out by remove.bg -- the local cleanup passes below exist
      // to compensate for the weaker color-based methods, and could only hurt an
      // already-good result, so they're skipped here.
    } else if (useTwoShot) {
      var bgOnlyData = pendingBgOnlyCanvas.getContext('2d').getImageData(0, 0, w, h);
      removeBackgroundDiff(imgData, bgOnlyData, parseInt(bgTolerance.value, 10));
    } else if (mode === 'single' || mode === 'ai' || mode === 'twoShot') {
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
    if (effectiveMode() === 'auto' && auto.result && auto.result.ok && autoGuides.checked && !auto.busy) drawAutoGuides(fctx, auto.result, w);
    frameCalibPoints.forEach(function (p) { drawMarkerOn(fctx, p.x, p.y); });
    updateFrameCalibBanner();
    schedulePreview();
  }

  // Lens outlines (teal), bridge (blue), hinges (brass) and the areas a note
  // refers to (dashed red) over the cut-out.
  function drawAutoGuides(g, r, w) {
    var lw = Math.max(1.5, w / 500);
    g.save();
    g.lineWidth = lw;
    g.strokeStyle = 'rgba(46,122,114,0.95)';
    g.setLineDash([lw * 3, lw * 2]);
    r.lenses.forEach(function (ln) {
      g.beginPath();
      ln.poly.forEach(function (p, i) { if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); });
      g.closePath(); g.stroke();
    });
    g.setLineDash([]);
    function dot(p, col, rad) { g.beginPath(); g.arc(p.x, p.y, rad, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.lineWidth = lw * 0.8; g.strokeStyle = '#fff'; g.stroke(); }
    dot(r.landmarks.bridge, '#2D5DA8', lw * 3);
    dot(r.landmarks.hingeL, '#8A6D45', lw * 2.6);
    dot(r.landmarks.hingeR, '#8A6D45', lw * 2.6);
    g.setLineDash([lw * 4, lw * 3]);
    g.strokeStyle = 'rgba(194,77,40,0.95)';
    g.lineWidth = lw * 1.2;
    r.warnings.forEach(function (wn) {
      if (!wn.box || wn.severity === 'info') return;
      var b = wn.box, pad = lw * 3;
      g.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + 2 * pad, b.maxY - b.minY + 2 * pad);
    });
    g.restore();
  }

  // ---------- add-frame: 3D preview of the generated model ----------

  function schedulePreview() {
    clearTimeout(preview.timer);
    if (!pendingRawCanvas || frameCalibPoints.length < 2 || aiRemovalLoading || auto.busy) {
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
      : Promise.resolve({
          img: snap, p1: pts[0], p2: pts[1], tags: pendingTags, size: readSize(sizeEye, sizeBridge, sizeTemple), side: null,
          fit: effectiveMode() === 'auto' ? buildFit(auto.result, 0, 0, 1, 1, pts) : null
        });
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
        modelHint = function () {
          return target.kind === 'side' ? t('add.model.sideFail') : t('add.model.no3d', { reason: GM_REASON[out.reason] ? t(GM_REASON[out.reason]) : out.reason });
        };
        modelPreviewHint.textContent = modelHint();
        return;
      }
      var a = out.analysis;
      modelHint = function () {
        if (target.kind === 'side') return t('add.model.side');
        if (effectiveMode() === 'auto' && currentLevel() === '2d') return t('add.model.flat');
        var extras = (a.lensFound[0] || a.lensFound[1] ? t('add.model.glass') : '') + (a.metal ? t('add.model.metal') : '') + (a.translucent ? t('add.model.trans') : '');
        return t('add.model.generated', { extras: extras });
      };
      modelPreviewHint.textContent = modelHint();
      renderPreviewNow();
    }).catch(function (e) { console.error('Preview failed', e); });
  }

  var modelHint = null;
  var GM_REASON = { 'missing image or lens points': 'gm.missingPoints', 'lens points are on top of each other': 'gm.samePoint', 'the cut-out has almost no frame pixels': 'gm.noPixels' };

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

  // ---------- add-frame: update the photo of an existing frame ----------
  // Re-process the stored original with the current settings (or take a better
  // photo). The frame keeps its id, tags, size and temple photo.

  function prefillFromEntry(entry) {
    if (!entry) return;
    var t = entry.tags || {};
    pendingTags = { shape: t.shape || null, color: t.color || null, gender: t.gender || null, rim: t.rim || null, free: (t.free || []).slice() };
    renderAddChips(); renderFreeTagList();
    fillSize(entry.size, sizeEye, sizeBridge, sizeTemple);
    frameNameInput.value = entry.name || '';
  }

  function enterReplaceMode(id) {
    var entry = findEntry(id);
    if (!entry) return;
    showTab('add');
    discardPendingFrame();
    if (addTarget.kind === 'side') exitSideMode();
    addTarget = { kind: 'replace', frameId: id };
    sideTargetThumb.innerHTML = '';
    var img = document.createElement('img');
    img.src = entry.thumbData; img.alt = '';
    sideTargetThumb.appendChild(img);
    sideTarget.style.display = 'flex';
    replaceTargetHint.style.display = 'block';
    replaceTargetRow.style.display = entry.hasSource ? 'flex' : 'none';
    syncAddTargetText();
    addedMsg.style.display = 'none';
    if (bgRemovalMode !== 'auto') setBgMode('auto');
    advanceForNextCapture();
  }

  function exitReplaceMode() {
    addTarget = { kind: 'front', frameId: null };
    sideTarget.style.display = 'none';
    replaceTargetHint.style.display = 'none';
    replaceTargetRow.style.display = 'none';
    syncAddTargetText();
    updateFrameSourceUI();
  }

  reprocessBtn.addEventListener('click', function () {
    if (addTarget.kind !== 'replace' || !currentUser) return;
    var id = addTarget.frameId;
    reprocessBtn.disabled = true;
    getDoc(doc(db, 'users', currentUser.uid, 'framesSource', id)).then(function (snap) {
      if (!snap.exists()) throw new Error('No original photo saved for this frame');
      return loadImage(snap.data().imageData);
    }).then(function (img) {
      if (addTarget.kind !== 'replace' || addTarget.frameId !== id) return;
      pendingSourceIsNew = false;
      beginAddFrameFromSource(img, img.naturalWidth, img.naturalHeight);
    }).catch(function (e) {
      console.error('Could not load the original photo', e);
      showAddSourceError('add.err.original');
    }).then(function () { reprocessBtn.disabled = false; });
  });

  // ---------- add-frame: preview the unsaved frame in the real try-on ----------

  var DRAFT_ID = '__draft__', draftEntry = null, draftPrevActive = null;

  function startDraftPreview() {
    if (!pendingRawCanvas || frameCalibPoints.length < 2) return;
    endDraftPreview(false);
    var c = document.createElement('canvas');
    c.width = pendingProcessedCanvas.width; c.height = pendingProcessedCanvas.height;
    c.getContext('2d').drawImage(pendingProcessedCanvas, 0, 0);
    var fit = effectiveMode() === 'auto' ? buildFit(auto.result, 0, 0, 1, 1, frameCalibPoints) : null;
    fullDataCache[DRAFT_ID] = { img: c, p1: frameCalibPoints[0], p2: frameCalibPoints[1], fit: fit };
    draftEntry = {
      id: DRAFT_ID, draft: true, thumbData: makeThumbCanvas(c, THUMB_DIM).toDataURL('image/png'),
      tags: { shape: pendingTags.shape, color: pendingTags.color, gender: pendingTags.gender, rim: pendingTags.rim, free: pendingTags.free.slice() },
      size: readSize(sizeEye, sizeBridge, sizeTemple), hasSide: false, level: fit ? fit.level : '3d',
      name: frameNameInput.value.trim() || null
    };
    draftPrevActive = activeFrameId;
    draftBanner.style.display = 'flex';
    showTab('tryon');
    selectFrame(DRAFT_ID);
    draftBanner.scrollIntoView({ block: 'nearest' });
  }

  function endDraftPreview(goBack) {
    if (!draftEntry) { if (goBack) showTab('add'); return; }
    draftEntry = null;
    draftBanner.style.display = 'none';
    arForget(DRAFT_ID);
    delete fullDataCache[DRAFT_ID];
    if (live.frameId === DRAFT_ID) { live.frame = null; live.frameId = null; }
    if (activeFrameId === DRAFT_ID) {
      activeFrameId = null;
      if (draftPrevActive && findEntry(draftPrevActive)) selectFrame(draftPrevActive);
      else { updateSelectedBanner(); updateTryOnHint(); updateSimilarCarousel(); updateCatalogButtons(); redrawFacePreview(); }
    }
    if (goBack) showTab('add');
  }
  draftBackBtn.addEventListener('click', function () { endDraftPreview(true); });

  // ---------- add-frame: temple (side) photo for an existing frame ----------

  function enterSideMode(id) {
    var entry = findEntry(id);
    if (!entry) return;
    showTab('add');
    discardPendingFrame();
    if (addTarget.kind === 'replace') exitReplaceMode();
    addTarget = { kind: 'side', frameId: id };
    sideTargetThumb.innerHTML = '';
    var img = document.createElement('img');
    img.src = entry.thumbData; img.alt = '';
    sideTargetThumb.appendChild(img);
    addTarget.replacingSide = !!entry.hasSide;
    sideTarget.style.display = 'flex';
    sideTargetHint.style.display = 'block';
    frontOnlySection.style.display = 'none';
    syncAddTargetText();
    addedMsg.style.display = 'none';
    advanceForNextCapture();
  }

  function exitSideMode() {
    addTarget = { kind: 'front', frameId: null };
    sideTarget.style.display = 'none';
    sideTargetHint.style.display = 'none';
    frontOnlySection.style.display = 'block';
    syncAddTargetText();
    updateFrameSourceUI();
  }

  // Labels that depend on what the add page is doing (new frame, new photo, temple photo).
  function syncAddTargetText() {
    var kind = addTarget.kind, entry = addTarget.frameId ? findEntry(addTarget.frameId) : null;
    framePhotoLabel.textContent = t(kind === 'side' ? 'add.templePhoto' : 'add.framePhoto');
    addToLibraryBtn.textContent = t(kind === 'side' ? 'add.saveTemple' : kind === 'replace' ? 'add.saveUpdated' : 'add.save');
    if (entry) sideTargetText.textContent = t(kind === 'replace' ? 'add.target.replace' : addTarget.replacingSide ? 'add.target.sideReplace' : 'add.target.side', { name: describeFrame(entry) });
  }

  function discardPendingFrame() {
    auto.token++; auto.busy = false; auto.result = null; auto.key = ''; auto.calibManual = false;
    autoReview.style.display = 'none';
    pendingSourceCanvas = null;
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
    if (addTarget.kind === 'replace') exitReplaceMode(); else exitSideMode();
  });
  addSideAfterBtn.addEventListener('click', function () { if (lastAddedId) enterSideMode(lastAddedId); });

  var addedMsgKey = null;
  function setAddedMsg(key) { addedMsgKey = key; addedMsgText.textContent = t(key); }

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
      setAddedMsg('add.templeSaved');
      addSideAfterBtn.style.display = 'none';
      addedMsg.style.display = 'block';
      track('temple_photo_added', {});
    }).catch(function (e) {
      console.error('Failed to save temple photo', e);
      addToLibraryBtn.disabled = false;
      frameCalibBanner.textContent = t('add.templeFail');
    });
  }

  function updateFrameCalibBanner() {
    addToLibraryBtn.disabled = frameCalibPoints.length < 2 || aiRemovalLoading || auto.busy;
    var side = addTarget.kind === 'side';
    var autoOk = effectiveMode() === 'auto' && auto.result && auto.result.ok;
    moveLensHint.style.display = frameCalibPoints.length === 2 && !eraseModeActive && !restoreModeActive ? 'block' : 'none';
    if (aiRemovalLoading) { frameCalibBanner.textContent = t('add.calib.ai'); return; }
    if (auto.busy && effectiveMode() === 'auto') { frameCalibBanner.textContent = t('add.calib.finding'); return; }
    if (autoOk && frameCalibPoints.length === 2 && !auto.calibManual) {
      frameCalibBanner.textContent = t('add.calib.auto');
      return;
    }
    if (frameCalibPoints.length === 0) frameCalibBanner.textContent = t(side ? 'add.calib.tap0side' : 'add.calib.tap0');
    else if (frameCalibPoints.length === 1) frameCalibBanner.textContent = t(side ? 'add.calib.tap1side' : 'add.calib.tap1');
    else frameCalibBanner.textContent = t(side ? 'add.calib.readySide' : 'add.calib.ready');
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
    eraseSpotBtn.setAttribute('aria-pressed', eraseModeActive ? 'true' : 'false');
    restoreSpotBtn.setAttribute('aria-pressed', restoreModeActive ? 'true' : 'false');
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
    auto.calibManual = true;
    drawFrameCalibView();
  });

  // Dragging a lens-centre marker moves it (when no brush is active).
  var dragMarker = -1;
  frameCalibCanvas.addEventListener('pointerdown', function (e) {
    if (!pendingRawCanvas || eraseModeActive || restoreModeActive || frameCalibPoints.length < 2) return;
    var pos = imagePosFromEvent(e), rect = frameCalibCanvas.getBoundingClientRect();
    var grab = 24 * frameCalibCanvas.width / Math.max(1, rect.width);
    for (var k = 0; k < frameCalibPoints.length; k++) {
      if (Math.hypot(pos.x - frameCalibPoints[k].x, pos.y - frameCalibPoints[k].y) <= grab) {
        dragMarker = k; frameCalibCanvas.setPointerCapture(e.pointerId); e.preventDefault(); return;
      }
    }
  });
  frameCalibCanvas.addEventListener('pointermove', function (e) {
    if (dragMarker < 0) return;
    var pos = imagePosFromEvent(e);
    frameCalibPoints[dragMarker] = { x: Math.round(pos.x), y: Math.round(pos.y) };
    auto.calibManual = true;
    drawFrameCalibView();
  });
  frameCalibCanvas.addEventListener('pointerup', function () { dragMarker = -1; });
  frameCalibCanvas.addEventListener('pointercancel', function () { dragMarker = -1; });

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

  // Fitting metadata for the try-on, in the saved image's pixels (cropped by
  // x0, y0 and scaled by sx, sy). Only for frames prepared automatically.
  function buildFit(r, x0, y0, sx, sy, lensPts) {
    if (!r || !r.ok) return null;
    x0 = x0 || 0; y0 = y0 || 0; sx = sx || 1; sy = sy || 1;
    function mp(p) { return { x: Math.round((p.x - x0) * sx * 10) / 10, y: Math.round((p.y - y0) * sy * 10) / 10 }; }
    function mb(b) { return { minX: Math.round((b.minX - x0) * sx), minY: Math.round((b.minY - y0) * sy), maxX: Math.round((b.maxX - x0) * sx), maxY: Math.round((b.maxY - y0) * sy) }; }
    var lm = r.landmarks, m = r.measurements, L = lensPts ? lensPts[0] : lm.lensL, R = lensPts ? lensPts[1] : lm.lensR;
    if (L.x > R.x) { var t = L; L = R; R = t; }
    return {
      v: 1, source: 'auto', unmixed: true,
      rimType: r.rimType, translucent: r.translucent, level: currentLevel(), quality: Math.round(r.quality * 100) / 100,
      lenses: r.lenses.map(function (ln) { return { side: ln.side, poly: ln.poly.map(mp), centre: mp(ln.centre) }; }),
      landmarks: { lensL: mp(L), lensR: mp(R), bridge: mp(lm.bridge), bridgeTop: mp(lm.bridgeTop), hingeL: mp(lm.hingeL), hingeR: mp(lm.hingeR), angle: Math.round(lm.angle * 1e4) / 1e4 },
      measurements: {
        frameWidthPx: Math.round(m.frameWidthPx * sx), frameHeightPx: Math.round(m.frameHeightPx * sy),
        lensWidthPx: Math.round(m.lensWidthPx * sx), lensHeightPx: Math.round(m.lensHeightPx * sy),
        bridgePx: Math.round(m.bridgePx * sx), lensDistPx: Math.round(m.lensDistPx * sx), aspect: Math.round(m.aspect * 100) / 100
      },
      warnings: r.warnings.map(function (wn) { return wn.code; }),
      repaired: r.repaired.map(mb)
    };
  }

  // Bounding box of the cut-out's visible pixels, with a margin.
  function alphaBox(c) {
    var w = c.width, h = c.height, d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return { x: 0, y: 0, w: w, h: h };
    var pad = Math.max(6, Math.round((x1 - x0) * 0.03));
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function sourceJpeg() {
    if (!pendingSourceCanvas) return null;
    var q = 0.88, url = pendingSourceCanvas.toDataURL('image/jpeg', q);
    while (url.length > SOURCE_BYTE_BUDGET && q > 0.5) { q -= 0.08; url = pendingSourceCanvas.toDataURL('image/jpeg', q); }
    return url.length > SOURCE_BYTE_BUDGET ? shrinkToBudget(pendingSourceCanvas, SOURCE_BYTE_BUDGET, 'image/jpeg', 0.7) : url;
  }

  addToLibraryBtn.addEventListener('click', function () {
    if (frameCalibPoints.length < 2 || !currentUser) return;
    if (addTarget.kind === 'side') { saveSidePhoto(); return; }
    var replacing = addTarget.kind === 'replace' ? findEntry(addTarget.frameId) : null;
    if (addTarget.kind === 'replace' && !replacing) return;
    // an extraction with serious problems is never saved without a deliberate yes
    if (effectiveMode() === 'auto' && auto.result && auto.result.ok) {
      var bad = auto.result.warnings.filter(function (wn) { return wn.severity === 'error'; });
      if (bad.length || auto.result.quality < 0.6) {
        confirmAction({
          title: t('add.attn.title'),
          body: (bad.length ? bad.map(fxWarning) : [t('add.attn.some')]).concat([t('add.attn.check')]),
          ok: t('add.attn.ok'), cancel: t('add.attn.cancel')
        }).then(function (yes) { if (yes) saveFrame(replacing); });
        return;
      }
    }
    saveFrame(replacing);
  });

  function saveFrame(replacing) {
    if (frameCalibPoints.length < 2 || !currentUser) return;
    addToLibraryBtn.disabled = true;
    var uid = currentUser.uid;
    var id = replacing ? replacing.id : 'f' + Date.now() + '_' + Math.floor(Math.random() * 10000);

    // crop to the frame (smaller documents, more detail per byte)
    var box = alphaBox(pendingProcessedCanvas);
    var fullCanvas = document.createElement('canvas');
    fullCanvas.width = box.w; fullCanvas.height = box.h;
    fullCanvas.getContext('2d').drawImage(pendingProcessedCanvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    var thumbCanvas = makeThumbCanvas(fullCanvas, THUMB_DIM);

    var full = shrinkToBudgetScaled(fullCanvas, FULL_BYTE_BUDGET, 'image/png');
    var fullData = full.dataUrl;
    var thumbData = shrinkToBudget(thumbCanvas, THUMB_BYTE_BUDGET, 'image/png');

    // lens centres and fitting metadata in the saved image's pixels
    var sc = function (p) { return { x: Math.round((p.x - box.x) * full.sx * 10) / 10, y: Math.round((p.y - box.y) * full.sy * 10) / 10 }; };
    var p1 = sc(frameCalibPoints[0]), p2 = sc(frameCalibPoints[1]);
    var fit = effectiveMode() === 'auto' ? buildFit(auto.result, box.x, box.y, full.sx, full.sy, frameCalibPoints) : null;
    var level = fit ? fit.level : '3d';
    var tags = { shape: pendingTags.shape, color: pendingTags.color, gender: pendingTags.gender, rim: pendingTags.rim, free: pendingTags.free.slice() };
    var size = readSize(sizeEye, sizeBridge, sizeTemple);
    var source = replacing && !pendingSourceIsNew ? null : sourceJpeg();
    var name = frameNameInput.value.trim().slice(0, 60) || null;
    var light = { thumbData: thumbData, tags: tags, size: size, name: name, level: level, rimType: fit ? fit.rimType : null, translucent: fit ? fit.translucent : null, prepared: fit ? 'auto' : 'manual' };
    if (source) light.hasSource = true;
    if (!replacing) light.createdAt = serverTimestamp();

    var writes = [
      replacing ? updateDoc(doc(db, 'users', uid, 'frames', id), light) : setDoc(doc(db, 'users', uid, 'frames', id), light),
      setDoc(doc(db, 'users', uid, 'framesFull', id), { imageData: fullData, p1: p1, p2: p2, imgW: full.w, imgH: full.h, fit: fit })
    ];
    if (source) writes.push(setDoc(doc(db, 'users', uid, 'framesSource', id), { imageData: source, w: pendingSourceCanvas.width, h: pendingSourceCanvas.height, createdAt: serverTimestamp() }));

    Promise.all(writes).then(function () {
      delete fullDataCache[id];
      arForget(id);
      var img = new Image();
      img.onload = function () { fullDataCache[id] = { img: img, p1: p1, p2: p2, fit: fit }; };
      img.src = fullData;

      var entry = replacing || { id: id, hasSide: false, createdAt: Date.now() };
      entry.thumbData = thumbData; entry.tags = tags; entry.size = size; entry.level = level; entry.name = name;
      entry.rimType = light.rimType; entry.translucent = light.translucent; entry.prepared = light.prepared;
      if (source) entry.hasSource = true;
      if (!replacing) catalogIndex.push(entry);
      catalogLoaded = true;
      rebuildFilterBar();
      renderLibrary();
      renderLiveStrip();
      track(replacing ? 'frame_photo_updated' : 'frame_added', { shape: tags.shape || 'untagged', color: tags.color || 'untagged', rim: tags.rim || 'untagged', prepared: light.prepared });

      endDraftPreview(false);
      pendingRawCanvas = null;
      pendingAiRemovedCanvas = null;
      modelPreview.style.display = 'none';
      if (replacing) exitReplaceMode();
      advanceForNextCapture();
      showFrameSourceChooser();
      lastAddedId = id;
      setAddedMsg(replacing ? 'add.updated' : 'add.added');
      addSideAfterBtn.style.display = 'flex';
      addedMsg.style.display = 'block';
      toast(t(replacing ? 'add.updated' : 'add.toastAdded'));
      selectFrame(id);
    }).catch(function (e) {
      console.error('Failed to save frame', e);
      addToLibraryBtn.disabled = false;
      frameCalibBanner.textContent = t('add.saveFail');
      toast(t('add.saveFail'), 'error');
    });
  }

  cancelFrameBtn.addEventListener('click', function () {
    discardPendingFrame();
    advanceForNextCapture();
  });

  window.addEventListener('beforeunload', function () { stopStream(); stopFrameStream(); });

  // ---------- language: English, हिंदी, मराठी ----------
  // The choice is remembered on this device. Without one, the browser's own
  // language decides (Hindi or Marathi), else English.
  var langBar = document.getElementById('langBar');
  var LANG_KEY = 'fts.lang';
  function initialLang() {
    try { var saved = localStorage.getItem(LANG_KEY); if (saved && hasLang(saved)) return saved; } catch (e) { /* storage blocked */ }
    var prefs = (navigator.languages || [navigator.language || 'en']).map(function (l) { return String(l).slice(0, 2).toLowerCase(); });
    for (var i = 0; i < prefs.length; i++) { if (prefs[i] === 'en') return 'en'; if (hasLang(prefs[i])) return prefs[i]; }
    return 'en';
  }
  function useLanguage(code, remember) {
    setLang(code);
    document.documentElement.lang = getLang();
    if (remember) { try { localStorage.setItem(LANG_KEY, getLang()); } catch (e) { /* storage blocked */ } }
    langBar.querySelectorAll('.lang-btn').forEach(function (b) {
      var on = b.getAttribute('data-lang') === getLang();
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('active', on);
    });
    applyStatic(document);
    rerenderForLanguage();
  }
  // Everything drawn by code, redrawn in the new language.
  function rerenderForLanguage() {
    syncStaffLabels();
    staffUnlockBtn.textContent = staffUnlockBtn.disabled ? t('staff.dialog.checking') : t('staff.dialog.unlock');
    if (photoCountDisplay.dataset.count != null) photoCountDisplay.textContent = t('staff.photoCount', { n: photoCountDisplay.dataset.count });
    if (authErrorKey) authError.textContent = t(authErrorKey);
    if (staffError.classList.contains('show') && !staffPassword.value) staffError.textContent = '';
    refreshTitle();
    if (!currentUser) return;
    if (catalogLoaded || catalogProblem) { rebuildFilterBar(); renderLibrary(); showCatalogProblem(catalogProblem); }
    else updateCatalogNote();
    if (view.name === 'detail') renderDetail(view.id);
    syncTryonBack();
    updateTryOnHint();
    updateSelectedBanner();
    renderLiveStrip();
    syncLiveToggle();
    updateCatalogButtons();
    updateCalibBanner();
    retakeBtn.textContent = faceHasImage ? t('try.replace') : t('common.cancel');
    if (liveErrorKey) showLiveError(liveErrorKey);
    if (photoErrorKey) showPhotoError(photoErrorKey);
    if (pdErrorKey) showPdError(pdErrorKey);
    if (pdValue != null && pdSplit.checked) pdTotal.textContent = t('pd.total', { pd: fmtMm(pdValue) });
    syncPdStatus();
    syncShortlistUi();
    live.statusText = null;          // the live loop writes its status again in the new language
    // staff screens
    if (selectMode) { renderBulkChips(); updateBulkCountLabel(); }
    if (editingFrameId && editPendingTags) { renderEditChips(); renderEditFreeTagList(); syncEditPanelText(); }
    if (pendingTags) { renderAddChips(); renderFreeTagList(); }
    syncAddTargetText();
    frameSourcePlaceholder.textContent = addSourceText();
    if (bgRemovalMode === 'twoShot') twoShotStepLabel.textContent = t(twoShotStep === 1 ? 'add.two.step1' : 'add.two.step2');
    if (addedMsgKey) addedMsgText.textContent = t(addedMsgKey);
    if (frameCalibSectionEl.style.display !== 'none') updateFrameCalibBanner();
    if (autoReview.style.display !== 'none') renderAutoReview();
    if (modelHint && modelPreview.style.display !== 'none') modelPreviewHint.textContent = modelHint();
  }
  langBar.addEventListener('click', function (e) {
    var b = e.target.closest('.lang-btn');
    if (!b || b.getAttribute('data-lang') === getLang()) return;
    useLanguage(b.getAttribute('data-lang'), true);
  });
  useLanguage(initialLang(), false);
})();
