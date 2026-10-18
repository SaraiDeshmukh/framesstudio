import { CONFIGURED } from './firebase-init.js';
import * as backend from './backend.js';
import { PoseSmoother, poseFromLandmarks, frameTransform, drawFrame } from './tracking.js';
import { estimateHeadPose, HeadPoseFilter, eulerFromMatrix } from './headpose.js';
import { cleanSize, sizeLabel } from './frame-size.js';
import { LANGS, t, tn, getLang, setLang, hasLang, tagLabel, tagAdjective, tagLabelsAll, applyStatic } from './i18n.js';
import './i18n-platform.js';
import { DEMO_FRAMES } from './demo/catalog.js';
import { priceView, formatINR, formatRate } from './pricing.js';
import { whatsappLink, telLink, REPORT_REASONS } from './validation.js';
import { buildFit as buildFitFrom, makeManifest, manifestOk } from './asset-build.js';
import { checkPhoto } from './photo-quality.js';
import { entryFromItem, isTryOnReady, hasRef, imgSrc } from './catalogue-index.js';

// Heavy parts load only when they're needed, never just because the catalogue
// was opened: face tracking (MediaPipe, pinned to a tested version; its JS and
// WASM must match) and the 3D renderer when try-on starts, the photo extraction
// when a shop adds a frame, and the shop/admin dashboards when they're opened.
var MEDIAPIPE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
var DEFAULT_PD_MM = 63;   // adult average (same value as ar-renderer.js)
var visionModule = null, rendererModule = null, extractModule = null, partnerModule = null, adminModule = null;
function loadVision() { return visionModule || (visionModule = import(MEDIAPIPE_URL).catch(function (e) { visionModule = null; throw e; })); }
function loadRenderer() { return rendererModule || (rendererModule = import('./ar-renderer.js').catch(function (e) { rendererModule = null; throw e; })); }
function loadExtract() { return extractModule || (extractModule = import('./frame-extract.js').catch(function (e) { extractModule = null; throw e; })); }
function loadPartner() { return partnerModule || (partnerModule = import('./partner.js?v=1').catch(function (e) { partnerModule = null; throw e; })); }
function loadAdmin() { return adminModule || (adminModule = import('./admin.js?v=1').catch(function (e) { adminModule = null; throw e; })); }
function createTryOnRenderer() { return loadRenderer().then(function (m) { return m.createTryOnRenderer(); }); }

// Privacy, in short (details in legal/privacy.html and README):
// - Customers never sign in. Their camera video and any photo they choose are
//   processed in this tab only: nothing here uploads, stores, captures or shares
//   them, and the in-memory copies are cleared when they leave the try-on.
// - The only uploads the site makes are a partner shop's FRAME photos, from the
//   Add frames page, signed in, into that shop's own folder (see storage.rules).
// - No analytics or advertising scripts.

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

  // ---------- accounts (shops and the admin only; customers never sign in) ----------
  var accountBtn = document.getElementById('accountBtn');
  var accountMenu = document.getElementById('accountMenu');
  var partnerLink = document.getElementById('partnerLink');
  var userEmailLabel = document.getElementById('userEmailLabel');
  var menuAdmin = document.getElementById('menuAdmin');
  var signOutBtn = document.getElementById('signOutBtn');
  var announcementEl = document.getElementById('announcement');

  var currentUser = null;        // a signed-in shop owner or admin (never a customer)
  var account = { isAdmin: false, checked: false };

  function syncAccountUi() {
    var signedIn = backend.isRealUser(currentUser);
    accountBtn.hidden = !signedIn;
    partnerLink.hidden = signedIn;
    userEmailLabel.textContent = signedIn ? (currentUser.email || '') : '';
    menuAdmin.hidden = !(signedIn && account.isAdmin);
    if (!signedIn) closeAccountMenu();
  }
  function openAccountMenu() {
    accountMenu.hidden = false;
    accountBtn.setAttribute('aria-expanded', 'true');
    var first = accountMenu.querySelector('.menu-item');
    if (first) first.focus();
  }
  function closeAccountMenu() {
    if (accountMenu.hidden) return;
    accountMenu.hidden = true;
    accountBtn.setAttribute('aria-expanded', 'false');
  }
  accountBtn.addEventListener('click', function () { if (accountMenu.hidden) openAccountMenu(); else closeAccountMenu(); });
  accountMenu.addEventListener('click', function (e) { if (e.target.closest('a')) closeAccountMenu(); });
  document.addEventListener('click', function (e) { if (!accountMenu.hidden && !accountMenu.contains(e.target) && !accountBtn.contains(e.target)) closeAccountMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !accountMenu.hidden) { closeAccountMenu(); accountBtn.focus(); } });
  signOutBtn.addEventListener('click', function () {
    closeAccountMenu();
    endCustomerSession();
    backend.signOutUser().then(function () {
      toast(t('acct.signedOut'));
      if (view.name === 'partner' || view.name === 'admin' || view.name === 'add') navigate({ name: 'home', id: null }, { replace: true });
    });
  });

  // On a shared shop screen a dashboard left signed in signs itself out after
  // 30 minutes without use, unless "Keep me signed in on this device" was ticked.
  var ACCOUNT_IDLE_MS = 30 * 60 * 1000, accountLastActive = Date.now();
  ['pointerdown', 'keydown'].forEach(function (type) { document.addEventListener(type, function () { accountLastActive = Date.now(); }, true); });
  setInterval(function () {
    if (backend.isRealUser(currentUser) && !backendKeep() && Date.now() - accountLastActive > ACCOUNT_IDLE_MS) {
      backend.signOutUser().then(function () { toast(t('acct.idleOut')); if (view.name === 'partner' || view.name === 'admin' || view.name === 'add') navigate({ name: 'home', id: null }, { replace: true }); });
    }
  }, 60000);
  function backendKeep() { try { return localStorage.getItem('fts.keepSignedIn') === '1'; } catch (e) { return false; } }

  backend.onAuth(function (user) {
    var before = currentUser ? currentUser.uid : null;
    currentUser = user && !user.isAnonymous ? user : null;
    account = { isAdmin: false, checked: false };
    syncAccountUi();
    var check = currentUser ? backend.checkAdmin(currentUser.uid) : Promise.resolve(false);
    check.then(function (isAdmin) {
      account = { isAdmin: !!isAdmin, checked: true };
      syncAccountUi();
      if ((currentUser ? currentUser.uid : null) !== before || view.name === 'partner' || view.name === 'admin' || view.name === 'add') {
        if (view.name === 'partner' || view.name === 'admin' || view.name === 'add') renderRoute(parseHash(), { force: true });
      }
    });
  });

  // An announcement from the admin (platform settings), shown on every page.
  backend.getConfigCached && CONFIGURED && backend.getConfigCached('platform').then(function (cfg) {
    if (cfg && cfg.announcement) { announcementEl.textContent = cfg.announcement; announcementEl.hidden = false; }
  }).catch(function () {});

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

  // ---------- views and addresses ----------
  // Each view has its own address, so a refresh keeps people where they were
  // and Back works as expected:
  //   #/                 home, with the demo
  //   #/demo             the demo frames      #/shops         participating shops
  //   #/shop/<id>        a shop's frames      #/frame/<id>    a frame's page
  //   #/try-on/<id>      try-on               #/shortlist
  //   #/partner/...      the shop dashboard   #/admin/...     the admin dashboard
  //   #/add/<productId>[/side]  a shop's photo step for one of its products
  var tabBrowseBtn = document.getElementById('tabBrowseBtn');
  var tabTryOnBtn = document.getElementById('tabTryOnBtn');
  var tabShopsBtn = document.getElementById('tabShopsBtn');
  var pageHome = document.getElementById('pageHome');
  var pageShops = document.getElementById('pageShops');
  var pagePartner = document.getElementById('pagePartner');
  var pageAdmin = document.getElementById('pageAdmin');
  var pageBrowse = document.getElementById('pageBrowse');
  var pageDetail = document.getElementById('pageDetail');
  var pageTryOn = document.getElementById('pageTryOn');
  var pageShortlist = document.getElementById('pageShortlist');
  var tabShortlistBtn = document.getElementById('tabShortlistBtn');
  var pageAdd = document.getElementById('pageAdd');
  var addLocked = document.getElementById('addLocked');
  var addContent = document.getElementById('addContent');
  var tryonBack = document.getElementById('tryonBack');
  var detailBack = document.getElementById('detailBack');
  var browseTitle = document.getElementById('browseTitle');
  var browseIntro = document.getElementById('browseIntro');

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
    else if (parts[0] === 'add') r = { name: 'add', id: parts[1] || null, sub: parts[2] || null };
    else if (parts[0] === 'shortlist') r = { name: 'shortlist', id: null };
    else if (parts[0] === 'demo') r = { name: 'browse', id: null, source: 'demo' };
    else if (parts[0] === 'shop' && parts[1]) r = { name: 'browse', id: null, source: 'shop:' + parts[1] };
    else if (parts[0] === 'shops') r = { name: 'shops', id: null };
    else if (parts[0] === 'partner') r = { name: 'partner', id: parts[1] || null, sub: parts[2] || null };
    else if (parts[0] === 'admin') r = { name: 'admin', id: parts[1] || null };
    else r = { name: 'home', id: null };
    if (query) {
      var m = /(?:^|&)pd=([0-9]+(?:[.,][0-9]+)?)/.exec(query);
      if (m) r.pd = parseFloat(m[1].replace(',', '.'));
      if (/(?:^|&)kiosk=1(?:&|$)/.test(query)) r.kiosk = true;
      r.hadQuery = true;
    }
    return r;
  }
  function hashFor(r) {
    if (r.name === 'detail') return '#/frame/' + encodeURIComponent(r.id);
    if (r.name === 'tryon') return '#/try-on' + (r.id ? '/' + encodeURIComponent(r.id) : '');
    if (r.name === 'add') return '#/add' + (r.id ? '/' + encodeURIComponent(r.id) + (r.sub ? '/' + r.sub : '') : '');
    if (r.name === 'shortlist') return '#/shortlist';
    if (r.name === 'browse') return r.source && r.source.indexOf('shop:') === 0 ? '#/shop/' + encodeURIComponent(r.source.slice(5)) : '#/demo';
    if (r.name === 'shops') return '#/shops';
    if (r.name === 'partner') return '#/partner' + (r.id ? '/' + encodeURIComponent(r.id) + (r.sub ? '/' + encodeURIComponent(r.sub) : '') : '');
    if (r.name === 'admin') return '#/admin' + (r.id ? '/' + encodeURIComponent(r.id) : '');
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
    if (r.kiosk) setKiosk(r.source);
    history.replaceState(null, '', hashFor(r));
    if (r.pd != null) applyPdFromLink(r.pd);
  }
  window.addEventListener('popstate', onAddressChange);
  window.addEventListener('hashchange', onAddressChange);

  // Kiosk: a shop's screen opened at #/shop/<id>?kiosk=1 stays on that shop
  // (the logo and "Frames" lead back to it) for this browser tab.
  var kioskSource = null;
  try { kioskSource = sessionStorage.getItem('fts.kiosk') || null; } catch (e) { kioskSource = null; }
  function setKiosk(source) {
    if (!source || source.indexOf('shop:') !== 0) return;
    kioskSource = source;
    try { sessionStorage.setItem('fts.kiosk', source); } catch (e) { /* tab only */ }
    syncKiosk();
  }
  function syncKiosk() {
    document.body.classList.toggle('kiosk', !!kioskSource);
    var brand = document.getElementById('brandLink');
    if (brand) brand.href = kioskSource ? hashFor({ name: 'browse', source: kioskSource }) : '#/';
    tabBrowseBtn.href = kioskSource ? hashFor({ name: 'browse', source: kioskSource }) : '#/demo';
    tabBrowseBtn.textContent = t(kioskSource ? 'nav.frames' : 'nav.demo');
  }

  function setTitle(title) { document.title = (title ? title + ' | ' : '') + 'Frame Try-On Studio'; }
  // the page title for the current view, in the current language
  function refreshTitle() {
    if (view.name === 'home') setTitle('');
    else if (view.name === 'browse') setTitle(sourceTitle());
    else if (view.name === 'detail') { var e = findEntry(view.id); setTitle(e && !e.draft ? frameName(e) : t(catalogLoaded ? 'title.notFound' : 'title.frame')); }
    else if (view.name === 'tryon') setTitle(t('title.tryon'));
    else if (view.name === 'add') setTitle(t('add.titleProduct'));
    else if (view.name === 'shortlist') setTitle(t('title.shortlist'));
    else if (view.name === 'shops') setTitle(t('shops.title'));
    else if (view.name === 'partner') setTitle(t('partner.title'));
    else if (view.name === 'admin') setTitle(t('admin.title'));
  }

  function renderRoute(r, opts) {
    opts = opts || {};
    takeQuery(r);
    var same = view.name === r.name && (view.id || null) === (r.id || null) && (view.source || null) === (r.source || null) && (view.sub || null) === (r.sub || null);
    if (same && !opts.force) return;
    var prev = view.name;
    if (prev === 'browse' && r.name !== 'browse') catalogScrollY = window.scrollY;
    view = { name: r.name, id: r.id || null, source: r.source || null, sub: r.sub || null };
    showView(r.name);
    if (r.name === 'home') {
      setTitle('');
      renderHome();
      window.scrollTo(0, 0);
    } else if (r.name === 'browse') {
      useSource(r.source || 'demo');
      setTitle(sourceTitle());
      requestAnimationFrame(function () { window.scrollTo(0, prev && prev !== 'browse' ? catalogScrollY : 0); });
    } else if (r.name === 'detail') {
      ensureEntry(r.id).then(function () { if (view.name === 'detail' && view.id === r.id) renderDetail(r.id); });
      renderDetail(r.id);
      window.scrollTo(0, 0);
    } else if (r.name === 'tryon') {
      if (!sourceKey) useSource(kioskSource || 'demo');
      if (r.id) {
        ensureEntry(r.id).then(function () {
          if (view.name !== 'tryon' || view.id !== r.id) return;
          if (r.id !== activeFrameId && findEntry(r.id)) selectFrame(r.id, { keepUrl: true });
          syncTryonBack(); updateSelectedBanner(); updateTryOnHint(); renderLiveStrip();
        });
      }
      if (r.id && r.id !== activeFrameId && findEntry(r.id)) selectFrame(r.id, { keepUrl: true });
      if (opts.from) tryonFrom = opts.from;
      else if (prev !== 'tryon') tryonFrom = prev === 'detail' ? (r.id || activeFrameId) : null;
      syncTryonBack();
      setTitle(t('title.tryon'));
      if (prev !== 'tryon') window.scrollTo(0, 0);
    } else if (r.name === 'add') {
      setTitle(t('add.titleProduct'));
      openAddRoute(r);
      window.scrollTo(0, 0);
    } else if (r.name === 'shortlist') {
      setTitle(t('title.shortlist'));
      renderShortlistPage();
      window.scrollTo(0, 0);
    } else if (r.name === 'shops') {
      setTitle(t('shops.title'));
      renderShops();
      window.scrollTo(0, 0);
    } else if (r.name === 'partner') {
      setTitle(t('partner.title'));
      openPartner(r);
      if (prev !== 'partner' || !r.id) window.scrollTo(0, 0);
    } else if (r.name === 'admin') {
      setTitle(t('admin.title'));
      openAdmin(r);
      window.scrollTo(0, 0);
    }
    if (!opts.initial && prev) {
      var page = { browse: pageBrowse, detail: pageDetail, tryon: pageTryOn, add: pageAdd, shortlist: pageShortlist, shops: pageShops }[r.name];
      var h1 = page && page.querySelector('h1:not([hidden])');
      if (h1 && (r.name !== 'browse')) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
    }
  }

  function showView(name) {
    var pages = { home: pageHome, shops: pageShops, partner: pagePartner, admin: pageAdmin, browse: pageBrowse, detail: pageDetail, tryon: pageTryOn, add: pageAdd, shortlist: pageShortlist };
    Object.keys(pages).forEach(function (k) { pages[k].style.display = name === k ? 'block' : 'none'; });
    [[tabBrowseBtn, name === 'browse' || name === 'detail'], [tabTryOnBtn, name === 'tryon'], [tabShortlistBtn, name === 'shortlist'], [tabShopsBtn, name === 'shops']].forEach(function (pair) {
      if (pair[1]) pair[0].setAttribute('aria-current', 'page'); else pair[0].removeAttribute('aria-current');
    });
    if (name === 'tryon') { updateTryOnHint(); updateSelectedBanner(); renderLiveStrip(); syncStage(); }
    if (name !== 'tryon') { stopLive(); stopStream(); if (faceHasImage) retakeFace(); clearFacePixels(); }  // never leave a camera running, or a face photo in memory, in the background
    if (name !== 'tryon' && draftEntry) endDraftPreview(false);
    if (name !== 'add') stopFrameStream();
  }

  // Internal callers still think in tabs.
  function showTab(name) {
    if (name === 'browse') { navigate({ name: 'browse', source: sourceKey || kioskSource || 'demo' }); return; }
    navigate({ name: name, id: null });
  }

  function syncTryonBack() {
    var from = tryonFrom && tryonFrom !== DRAFT_ID ? findEntry(tryonFrom) : null;
    if (from) {
      tryonBack.textContent = t('try.backTo', { name: frameName(from) });
      tryonBack.href = hashFor({ name: 'detail', id: from.id });
    } else {
      tryonBack.textContent = t(sourceKey && sourceKey !== 'demo' ? 'try.allShopFrames' : 'try.allDemo');
      tryonBack.href = hashFor({ name: 'browse', source: sourceKey || kioskSource || 'demo' });
    }
  }

  // ---------- try-on/face elements ----------
  var video = document.getElementById('video');
  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d');
  var placeholder = document.getElementById('placeholder');
  var uploadBtn = document.getElementById('uploadBtn');
  var fileInput = document.getElementById('fileInput');
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
  var libraryMore = document.getElementById('libraryMore');
  var libraryMoreBtn = document.getElementById('libraryMoreBtn');
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

  // ---------- home, shops, report ----------
  var homeDemoRow = document.getElementById('homeDemoRow');
  var homeShopRow = document.getElementById('homeShopRow');
  var shopsGrid = document.getElementById('shopsGrid');
  var shopsNote = document.getElementById('shopsNote');
  var reportDialog = document.getElementById('reportDialog');
  var reportForm = document.getElementById('reportForm');
  var reportReasons = document.getElementById('reportReasons');
  var reportNote = document.getElementById('reportNote');
  var reportError = document.getElementById('reportError');
  var reportSend = document.getElementById('reportSend');
  var reportCancel = document.getElementById('reportCancel');

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
  var photoGuide = document.getElementById('photoGuide');
  var photoCheck = document.getElementById('photoCheck');
  var saveNoTryonBtn = document.getElementById('saveNoTryonBtn');
  var addProductBar = document.getElementById('addProductBar');
  var addProductThumb = document.getElementById('addProductThumb');
  var addProductName = document.getElementById('addProductName');
  var addProductBack = document.getElementById('addProductBack');
  var frameNameInput = document.getElementById('frameNameInput');

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

  // The catalogue being shown (the demo, or one shop's published frames), and
  // every frame loaded so far from any source (a shortlist can mix shops).
  var catalogIndex = [];      // entries of the current source
  var entryMap = {};          // id -> entry, every source loaded this visit
  var sourceKey = null;       // 'demo' | 'shop:<shopId>'
  var sourceShop = null;      // the shop's public profile, for 'shop:' sources
  var shopCache = {};         // shopId -> Promise<public profile | null>
  var fullDataCache = {};     // id -> {img, p1, p2, fit} -- the try-on asset, loaded when a frame is tried
  var activeFrameId = null;
  var allFreeTags = new Set();
  var activeFilters = { shape: new Set(), color: new Set(), gender: new Set(), rim: new Set(), search: '' };

  var pendingRawCanvas = null;
  var pendingBgOnlyCanvas = null; // the empty-surface reference photo, only used in two-shot mode
  // (The old remove.bg option sent frame photos to an outside service; it's gone:
  // everything below runs on the shop's own device.)
  var pendingAiRemovedCanvas = null;
  var aiRemovalLoading = false;
  var bgRemovalMode = 'auto'; // 'auto' | 'single' | 'twoShot'
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

  // What the photo page is photographing for a shop's product: its front
  // (kind 'product'), or a temple from the side (kind 'side') for 3D temples.
  // `product` is the product as last read, `shopStatus` its shop's status.
  var addTarget = { kind: 'none', frameId: null, product: null, shopStatus: null };
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

  // Clears what the catalogue page shows when switching to another source.
  function resetCatalogView() {
    catalogIndex = [];
    allFreeTags = new Set();
    activeFilters = { shape: new Set(), color: new Set(), gender: new Set(), rim: new Set(), search: '' };
    catalogSearch.value = ''; sortSelect.value = 'new';
    catalogLoaded = false; catalogProblem = false;
    libraryRow.innerHTML = '';
    libraryMore.hidden = true;
    filterBar.innerHTML = '';
    noResults.hidden = true; emptyCatalog.hidden = true;
    shownLimit = PAGE_SIZE;
  }

  // Forgets the customer's photo pixels held in memory (the canvases the photo
  // and the tracking used). Called whenever a photo is replaced or the try-on
  // page is left. The browser itself may keep freed memory around for a while;
  // nothing here keeps a reference to it.
  function clearFacePixels() {
    [faceBaseCanvas, canvas].forEach(function (c) {
      try { c.getContext('2d').clearRect(0, 0, c.width, c.height); } catch (e) { /* ignore */ }
      c.width = 1; c.height = 1;
    });
    if (exposureCanvas) { exposureCanvas.width = 1; exposureCanvas.height = 1; }
    lastPhotoLandmarks = null;
    if (ar.renderer && ar.renderer.clear) { try { ar.renderer.clear(); } catch (e) { /* ignore */ } }
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
    if (entry.nameKey) { var dn = t(entry.nameKey); if (dn !== entry.nameKey) return dn; }
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
    return (id && entryMap[id]) || null;
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

  // The try-on asset of a frame: its cut-out image and fitting data. Demo frames
  // ship with the site; shop products load theirs when first tried (from
  // Firestore on the free plan, cached in the browser; or Storage links).
  // Loaded with CORS so the 3D renderer may read the pixels; nothing is sent
  // anywhere.
  function getFullFrameData(id) {
    if (fullDataCache[id]) return Promise.resolve(fullDataCache[id]);
    var entry = findEntry(id);
    if (!entry) return Promise.reject(new Error('Unknown frame'));
    if (!entry.tryOnReady) return Promise.reject(Object.assign(new Error('No try-on asset'), { code: 'no-asset' }));
    if (entry.lite) return ensureFull(id).then(function (e) {
      if (!e || e.lite) throw new Error('Frame not available');
      return getFullFrameData(id);
    });
    var manifestP = entry.manifest ? Promise.resolve(entry.manifest) : backend.loadManifest(entry.manifestRef);
    var cutoutP = entry.cutoutUrl ? Promise.resolve(entry.cutoutUrl) : backend.fileUrl(entry.cutoutRef);
    return Promise.all([manifestP, cutoutP.then(function (u) { return loadImage(u, true); })]).then(function (r) {
      var m = r[0], img = r[1];
      if (!manifestOk(m)) throw new Error('Bad try-on data');
      var result = { img: img, p1: scalePoint(m.p1, m, img), p2: scalePoint(m.p2, m, img), fit: fitForImage(m, img), side: m.side || null };
      fullDataCache[id] = result;
      return result;
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
      noSelectionText.textContent = t('try.noFramesHere');
      noSelectionBtn.style.display = 'inline-flex';
      noSelectionBtn.textContent = t('try.toDemo');
      noSelectionBtn.onclick = function () { useSource('demo'); renderLiveStrip(); updateTryOnHint(); };
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
    setThumb(img, entry);
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

    var pool = Object.keys(entryMap).map(function (k) { return entryMap[k]; }).filter(function (e) {
      if (e.id === active.id) return false;
      return active.demo ? (e.demo && !DEMO_HIDDEN[e.id]) : (e.shopId === active.shopId && e.isPublic);
    });
    var sameShape = active.tags.shape ? pool.filter(function (e) { return e.tags.shape === active.tags.shape; }) : [];
    var sameColor = active.tags.color ? pool.filter(function (e) { return e.tags.color === active.tags.color && sameShape.indexOf(e) === -1; }) : [];
    var list = sameShape.concat(sameColor);
    if (!list.length) list = pool;
    // frames already loaded first (within each group), so this rarely reads more
    var loadedFirst = function (a, b) { return (a.lite ? 1 : 0) - (b.lite ? 1 : 0); };
    list = sameShape.length || sameColor.length ? sameShape.sort(loadedFirst).concat(sameColor.sort(loadedFirst)) : pool.slice().sort(loadedFirst);
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
      setThumb(img, e);
      item.appendChild(img);
      var cap = document.createElement('span');
      cap.textContent = frameName(e);
      item.appendChild(cap);
      var sz = sizeShort(e.size);
      if (sz) { var z = document.createElement('span'); z.className = 'item-size'; z.textContent = sz; item.appendChild(z); }
      similarRow.appendChild(item);
    });
  }

  // The photo mode never opens a camera any more (photos are chosen from the
  // device); this stays as a safety net that stops any stream left behind.
  function stopStream() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (video.srcObject) { try { video.srcObject.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ } video.srcObject = null; }
    video.style.display = 'none';
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
      retakeBtn.style.display = 'inline-flex';
      retakeBtn.textContent = t('try.replace');
      photoSource = 'upload';
      syncStage();
      redrawFacePreview();
      detectFaceInPhoto();
      URL.revokeObjectURL(url);
      img.removeAttribute('src');          // the decoded file isn't kept around
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
    retakeBtn.style.display = 'none';
    photoToggleBtn.style.display = 'none';
    photoCatalogBtn.style.display = 'none';
    clearFacePixels();
    updateCalibBanner();
    syncStage();
  }

  var photoManual = false;           // true once staff chose to mark the pupils by hand
  var photoSource = null;            // 'upload': what "Replace photo" goes back to
  canvas.addEventListener('click', function (e) {
    if (!faceHasImage || facePoints.length >= 2 || detectingPupils) return;
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    facePoints.push({ x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY });
    updateCalibBanner();
    redrawFacePreview();
  });

  uploadBtn.addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) { stopLive(); showLiveError(''); handleFaceUpload(e.target.files[0]); }
  });
  // Manual taps replace the automatic fit (and its 3D pose) with the 2D overlay.
  recalBtn.addEventListener('click', function () { facePoints = []; photo3d = null; photoManual = true; updateCalibBanner(); redrawFacePreview(); });
  retakeBtn.addEventListener('click', function () {
    var hadPhoto = faceHasImage;
    retakeFace();
    // "Replace photo" goes straight back to where the photo came from
    if (hadPhoto && photoSource === 'upload') { fileInput.value = ''; fileInput.click(); }
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

  function loadImage(src, cors) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      if (cors && !/^(data:|blob:)/.test(src)) img.crossOrigin = 'anonymous';
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

  // The temple photo (optional, for the 3D temples), described in the asset.
  function getSideData(id) {
    var entry = findEntry(id);
    if (entry && entry.lite) {
      return ensureFull(id).then(function (e) { return e && !e.lite ? getSideData(id) : null; });
    }
    if (!entry || !entry.hasSide || !(entry.sideUrl || entry.sideRef)) return Promise.resolve(null);
    if (!sideCache[id]) {
      sideCache[id] = getFullFrameData(id).then(function (full) {
        var sd = full.side;
        if (!sd) return null;
        var su = entry.sideUrl ? Promise.resolve(entry.sideUrl) : backend.fileUrl(entry.sideRef);
        return su.then(function (u) { return loadImage(u, true); }).then(function (img) {
          return { img: img, hinge: scalePoint(sd.hinge, sd, img), tip: scalePoint(sd.tip, sd, img) };
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
  function shortlistKey() { return 'fts.shortlist'; }
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
    // frames from shops are fetched again after a refresh
    Promise.all(shortlist.map(ensureEntry)).then(function () { pruneShortlist(); syncShortlistUi(); });
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
    var before = shortlist.length;
    shortlist = shortlist.filter(function (id) { return !missingIds[id] && !(DEMO_HIDDEN[id]) && id !== DRAFT_ID; });
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
    stopLive();
    if (faceHasImage) retakeFace();
    clearFacePixels();
  }
  ['pointerdown', 'keydown'].forEach(function (type) { document.addEventListener(type, function () { customerLastActive = Date.now(); }, true); });
  setInterval(function () {
    var idle = Date.now() - customerLastActive;
    if (idle > CUSTOMER_IDLE_MS && (shortlist.length || pdValue != null || pdInput.value || pdRight.value || pdLeft.value || faceHasImage || live.running)) endCustomerSession();
    else if (shortlist.length && idle < 60000) saveShortlist();      // keep the stored list fresh while in use
  }, 30000);

  // Side-by-side comparison of the shortlisted frames.
  function renderShortlistPage() {
    pruneShortlist();
    var entries = shortlist.map(findEntry).filter(function (e) { return e && !e.draft; });
    var waiting = entries.length < shortlist.length;
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
      img.alt = ''; setThumb(img, e); img.decoding = 'async';
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
      tryB.disabled = !e.tryOnReady;
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
    var anyShop = entries.some(function (e) { return !e.demo; });
    var rows = [];
    if (anyShop) {
      rows.push(['attr.price', function (e) { if (e.demo) return t('demo.badge'); var v = e.pricing ? priceView(e.pricing) : null; return v ? formatINR(v.pay.finalPaise, getLang()) + ' ' + (v.mode === 'none' ? t('price.noGst') : t('price.inclGst')) : t('sl.none'); }]);
      rows.push(['attr.shop', function (e) { var sh = shopOf(e); return e.demo ? t('demo.badge') : sh ? sh.name : t('sl.none'); }]);
    }
    rows = rows.concat([
      ['attr.size', function (e) { var sz = sizeShort(e.size); return sz || t('sl.none'); }, 'mono'],
      ['attr.shape', function (e) { return e.tags.shape ? tagLabel(e.tags.shape) : t('sl.none'); }],
      ['attr.colour', function (e) { return e.tags.color ? tagLabel(e.tags.color) : t('sl.none'); }],
      ['attr.rim', function (e) { return e.tags.rim ? tagLabel(e.tags.rim) : t('sl.none'); }],
      ['attr.for', function (e) { return e.tags.gender ? tagLabel(e.tags.gender) : t('sl.none'); }]
    ]);
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
    var first = shortlist.filter(function (id) { var e = findEntry(id); return e && e.tryOnReady; });
    if (!first.length) return;
    tryOnFrame(inShortlist(activeFrameId) && findEntry(activeFrameId).tryOnReady ? activeFrameId : first[0], 'auto');
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

  var liveLimit = 24;          // frames shown in the try-on picker before "Show more"
  function renderLiveStrip() {
    liveStrip.innerHTML = '';
    var q = normalizeSearch(liveSearch.value);
    var pool = catalogIndex.filter(function (e) { return e.tryOnReady; });
    var act = activeFrameId && activeFrameId !== DRAFT_ID ? findEntry(activeFrameId) : null;
    if (act && pool.indexOf(act) === -1) pool = [act].concat(pool);
    if (pickerFilter === 'shortlist') pool = shortlist.map(findEntry).filter(function (e) { return e && !e.draft && e.tryOnReady; });
    var list = pool.filter(function (e) {
      if (!q) return true;
      var hay = searchText(e);
      return q.split(/\s+/).every(function (word) { return hay.indexOf(word) !== -1; });
    });
    if (draftEntry && pickerFilter !== 'shortlist') list = [draftEntry].concat(list);
    var more = list.length - Math.min(list.length, liveLimit);
    list = list.slice(0, liveLimit);
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
      setThumb(img, e);
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
    if (more > 0) {
      var moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'similar-item more-item';
      moreBtn.textContent = tn('cat.more', Math.min(PAGE_SIZE, more));
      moreBtn.addEventListener('click', function () {
        var at = liveLimit;
        liveLimit += PAGE_SIZE;
        renderLiveStrip();
        var next = liveStrip.children[at];
        if (next) next.focus();
      });
      liveStrip.appendChild(moreBtn);
    }
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
  liveSearch.addEventListener('input', function () { liveLimit = PAGE_SIZE; renderLiveStrip(); });
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

  // A filter or the search changed: back to the first page of matches.
  function applyFilters() {
    shownLimit = PAGE_SIZE;
    renderLibrary();
  }

  // The counts, chips and messages around the cards. `shown` is how many
  // frames match the search and filters (not just the cards on screen).
  function updateFilterUi(shown) {
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
  sortSelect.addEventListener('change', function () { shownLimit = PAGE_SIZE; renderLibrary(); });
  clearFiltersBtn.addEventListener('click', clearAllFilters);
  libraryMoreBtn.addEventListener('click', showMoreFrames);
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
      if (mode === 'price' || mode === 'priceDesc') {
        var pa = payPaise(a), pb = payPaise(b);
        if (pa !== pb) return mode === 'price' ? pa - pb : pb - pa;
      }
      var d = addedAt(b) - addedAt(a);
      if (mode === 'old') d = -d;
      return d || order.get(a.id) - order.get(b.id);
    });
  }

  // ---------- catalogue: cards ----------

  // What a customer pays for a frame (for sorting); frames without a price last.
  function payPaise(e) { var v = e && e.pricing ? priceView(e.pricing) : null; return v ? v.pay.finalPaise : Infinity; }

  // The price line for cards and lists: "₹2,499 incl. GST" (with a struck-out
  // regular price when on sale). Nothing for demo frames.
  function priceLine(entry, cls) {
    var v = entry && entry.pricing ? priceView(entry.pricing) : null;
    if (!v) return null;
    var el = document.createElement('p');
    el.className = cls || 'price-line';
    var now = document.createElement('span');
    now.className = 'price-now';
    now.textContent = formatINR(v.pay.finalPaise, getLang());
    el.appendChild(now);
    if (v.sale) {
      var was = document.createElement('s');
      was.className = 'price-was';
      was.textContent = formatINR(v.regular.finalPaise, getLang());
      el.appendChild(document.createTextNode(' '));
      el.appendChild(was);
    }
    var tax = document.createElement('span');
    tax.className = 'price-tax';
    tax.textContent = ' ' + (v.mode === 'none' ? t('price.noGst') : t('price.inclGst'));
    el.appendChild(tax);
    return el;
  }

  function availabilityText(a) { return a ? t('avail.' + a) : ''; }

  // The catalogue's cards: the frames matching the search and filters, in the
  // chosen order, PAGE_SIZE at a time ("Show more" adds the next page). Only
  // the cards on screen have their pictures loaded.
  function renderLibrary() {
    libraryRow.innerHTML = '';
    var isShop = sourceKey && sourceKey !== 'demo';
    sortSelect.querySelectorAll('option[data-shop-only]').forEach(function (o) { o.hidden = !isShop; o.disabled = !isShop; });
    var filtering = activeFilterCount() > 0 || !!activeFilters.search;
    // without the shop's index, searching, filtering or another order needs every frame
    if (catalogMode === 'paged' && paged.more && (filtering || sortSelect.value !== 'new')) loadRestPaged();
    var matches = sortedCatalog().filter(frameMatchesFilters);
    matches.slice(0, shownLimit).forEach(function (entry) {
      var card = document.createElement('article');
      card.className = 'frame-card' + (entry.demo ? ' demo-card' : '');
      card.dataset.id = entry.id;

      var media = document.createElement('div');
      media.className = 'frame-card-media';
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 260; img.height = 160;
      img.alt = '';
      setThumb(img, entry);
      media.appendChild(img);
      card.appendChild(media);
      var heart = document.createElement('button');
      heart.type = 'button';
      heart.className = 'icon-btn heart-btn card-heart';
      heart.setAttribute('data-heart', entry.id);
      heart.innerHTML = heartSvg();
      heart.addEventListener('click', function () { toggleShortlist(entry.id); });
      syncHeart(heart, entry.id);
      card.appendChild(heart);

      var body = document.createElement('div');
      body.className = 'frame-card-body';
      var title = document.createElement('h2');
      title.className = 'frame-card-title';
      var link = document.createElement('a');
      link.className = 'frame-card-link';
      link.href = hashFor({ name: 'detail', id: entry.id });
      link.textContent = frameName(entry);
      title.appendChild(link);
      body.appendChild(title);
      var pl = priceLine(entry);
      if (pl) body.appendChild(pl);
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
      if (entry.demo) {
        var badge = document.createElement('span');
        badge.className = 'demo-badge';
        badge.textContent = t('demo.badge');
        body.appendChild(badge);
      } else if (entry.availability === 'out_of_stock') {
        var oos = document.createElement('span');
        oos.className = 'avail-badge';
        oos.textContent = availabilityText(entry.availability);
        body.appendChild(oos);
      }
      card.appendChild(body);

      var actions = document.createElement('div');
      actions.className = 'frame-card-actions';
      if (entry.tryOnReady) {
        var tryBtn = document.createElement('button');
        tryBtn.type = 'button';
        tryBtn.className = 'btn secondary frame-card-tryon';
        tryBtn.textContent = t('card.tryon');
        tryBtn.setAttribute('aria-label', t('card.tryon.aria', { name: frameName(entry) }));
        tryBtn.addEventListener('click', function () { tryOnFrame(entry.id, 'auto'); });
        actions.appendChild(tryBtn);
      } else {
        var no = document.createElement('a');
        no.className = 'btn secondary frame-card-tryon';
        no.href = hashFor({ name: 'detail', id: entry.id });
        no.textContent = t('card.details');
        no.setAttribute('aria-label', t('card.details.aria', { name: frameName(entry) }));
        actions.appendChild(no);
        var nt = document.createElement('span');
        nt.className = 'no-tryon';
        nt.textContent = t('card.noTryon');
        body.appendChild(nt);
      }
      card.appendChild(actions);
      libraryRow.appendChild(card);
    });
    var left = matches.length - Math.min(shownLimit, matches.length);
    var serverMore = catalogMode === 'paged' && paged.more && !filtering && sortSelect.value === 'new';
    libraryMore.hidden = !(left > 0 || serverMore);
    if (!libraryMore.hidden) {
      libraryMoreBtn.textContent = tn('cat.more', left > 0 ? Math.min(PAGE_SIZE, left) : PAGE_SIZE);
      libraryMoreBtn.disabled = !!paged.loadingMore;
    }
    updateFilterUi(matches.length);
  }

  function showMoreFrames() {
    var before = libraryRow.querySelectorAll('.frame-card').length;
    function after() {
      renderLibrary();
      // keep the keyboard where the new cards start
      var first = libraryRow.querySelectorAll('.frame-card')[before];
      var link = first && first.querySelector('.frame-card-link');
      if (link) link.focus({ preventScroll: false });
    }
    var filtering = activeFilterCount() > 0 || !!activeFilters.search;
    var loaded = sortedCatalog().filter(frameMatchesFilters).length;
    if (shownLimit >= loaded && catalogMode === 'paged' && paged.more && !filtering) {
      libraryMoreBtn.disabled = true;
      loadMorePaged().then(function () { shownLimit += PAGE_SIZE; after(); });
      return;
    }
    shownLimit += PAGE_SIZE;
    after();
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
        b.addEventListener('click', function () { var k = sourceKey; sourceKey = null; catalogNote.textContent = t('cat.loading'); useSource(k || 'demo'); });
        emptyCatalog.appendChild(b);
      }
      b.textContent = t('cat.error.retry');
    } else {
      h.textContent = t('cat.empty.title');
      emptyCatalogText.textContent = t(sourceKey && sourceKey !== 'demo' ? 'cat.empty.shop' : 'cat.empty.customer');
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

  function fmtDate(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleDateString(getLang() === 'en' ? 'en-IN' : getLang() + '-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return new Date(ms).toDateString(); }
  }

  // The full price block on a frame's page: what the customer pays, and how the
  // retailer's price splits into price before GST and GST.
  function priceBlock(entry, shop) {
    var v = entry.pricing ? priceView(entry.pricing) : null;
    var box = document.createElement('div');
    box.className = 'price-block';
    if (!v) { var none = document.createElement('p'); none.className = 'hint'; none.textContent = t('price.ask'); box.appendChild(none); return box; }
    var now = document.createElement('p');
    now.className = 'price-big';
    now.textContent = formatINR(v.pay.finalPaise, getLang());
    if (v.sale) {
      var was = document.createElement('s');
      was.className = 'price-was';
      was.textContent = formatINR(v.regular.finalPaise, getLang());
      now.appendChild(document.createTextNode(' '));
      now.appendChild(was);
    }
    box.appendChild(now);
    var lines = document.createElement('dl');
    lines.className = 'price-lines';
    function line(label, value) {
      var dt = document.createElement('dt'); dt.textContent = label;
      var dd = document.createElement('dd'); dd.textContent = value;
      lines.appendChild(dt); lines.appendChild(dd);
    }
    if (v.mode === 'none') {
      line(t('price.final'), formatINR(v.pay.finalPaise, getLang()));
      line(t('price.gst'), t('price.noGstLong'));
    } else {
      line(t('price.before'), formatINR(v.pay.basePaise, getLang()));
      line(t('price.gstRate', { rate: formatRate(v.rate) }), formatINR(v.pay.taxPaise, getLang()));
      line(t('price.final'), formatINR(v.pay.finalPaise, getLang()));
    }
    if (v.sale) line(t('price.saving'), formatINR(v.savingPaise, getLang()));
    box.appendChild(lines);
    var fine = document.createElement('p');
    fine.className = 'fine';
    fine.textContent = t('price.setBy', { shop: shop ? shop.name : t('price.theShop') }) +
      (entry.priceUpdatedAt ? ' ' + t('price.updated', { date: fmtDate(entry.priceUpdatedAt) }) : '');
    box.appendChild(fine);
    return box;
  }

  function renderDetail(id) {
    detailBody.innerHTML = '';
    var entry = findEntry(id);
    if (!entry || entry.draft) {
      similarLabel.style.display = 'none'; similarRow.style.display = 'none';
      if (!missingIds[id] && CONFIGURED && !/^demo-/.test(id || '')) {
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
    if (entry.lite) {
      ensureFull(id).then(function (e) { if (e && !e.lite && view.name === 'detail' && view.id === id) renderDetail(id); });
    }
    var name = frameName(entry);
    setTitle(name);
    var tg = entry.tags || {};
    var en = getLang() === 'en';
    var shop = entry.shopId ? shopOf(entry) : null;
    if (entry.shopId && !shop) {
      getShopInfo(entry.shopId).then(function (sh) { if (sh) { rememberShop(entry.shopId, sh); if (view.name === 'detail' && view.id === id) renderDetail(id); } });
    }
    detailBack.href = entry.demo ? '#/demo' : hashFor({ name: 'browse', source: 'shop:' + entry.shopId });
    detailBack.textContent = entry.demo ? t('detail.backDemo') : t('detail.backShop', { shop: shop ? shop.name : t('price.theShop') });

    var own = !entry.demo && currentUser && entry.shopId === currentUser.uid;
    if (!entry.demo && !entry.isPublic) {
      var pv = document.createElement('div');
      pv.className = 'preview-banner';
      pv.textContent = t('detail.previewOnly');
      detailBody.appendChild(pv);
    }

    var grid = document.createElement('div');
    grid.className = 'detail-grid';
    var media = document.createElement('div');
    media.className = 'detail-media';
    var img = document.createElement('img');
    img.alt = name + (tg.color && entry.name ? ', ' + (en ? tagLabel(tg.color).toLowerCase() : tagLabel(tg.color)) : '');
    setThumb(img, entry);
    media.appendChild(img);
    grid.appendChild(media);

    var info = document.createElement('div');
    info.className = 'detail-info';
    var h1 = document.createElement('h1');
    h1.id = 'detailTitle';
    h1.textContent = name;
    info.appendChild(h1);
    var subBits = [];
    if ((entry.name || entry.nameKey) && (tg.color || tg.shape)) {
      subBits.push([entry.colourName || (tg.color ? tagLabel(tg.color) : ''), tg.shape ? (en ? tagLabel(tg.shape).toLowerCase() : tagLabel(tg.shape)) : ''].filter(Boolean).join(' '));
    }
    var meta = frameMeta(entry);
    if (meta) subBits.push(subBits.length && en ? meta.charAt(0).toLowerCase() + meta.slice(1) : meta);
    if (subBits.length) {
      var sub = document.createElement('p');
      sub.className = 'detail-sub';
      sub.textContent = subBits.join(', ');
      info.appendChild(sub);
    }

    if (entry.demo) {
      var dn = document.createElement('p');
      dn.className = 'demo-note';
      dn.textContent = t('detail.demoNote');
      info.appendChild(dn);
    } else {
      var seller = document.createElement('p');
      seller.className = 'sold-by';
      seller.appendChild(document.createTextNode(t('detail.soldBy') + ' '));
      var sl = document.createElement('a');
      sl.href = hashFor({ name: 'browse', source: 'shop:' + entry.shopId });
      sl.textContent = shop ? shop.name : t('price.theShop');
      seller.appendChild(sl);
      if (shop && shop.city) seller.appendChild(document.createTextNode(', ' + shop.city));
      info.appendChild(seller);
      info.appendChild(priceBlock(entry, shop));
      if (entry.availability) {
        var av = document.createElement('p');
        av.className = 'availability avail-' + entry.availability;
        av.textContent = availabilityText(entry.availability);
        info.appendChild(av);
      }
    }

    var actions = document.createElement('div');
    actions.className = 'detail-actions';
    if (entry.tryOnReady) {
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
    } else {
      var unav = document.createElement('p');
      unav.className = 'detail-unavailable';
      unav.textContent = t('detail.noTryon');
      actions.appendChild(unav);
    }
    info.appendChild(actions);
    var heart = document.createElement('button');
    heart.type = 'button';
    heart.className = 'btn secondary heart-btn heart-text';
    heart.setAttribute('data-heart', entry.id);
    heart.innerHTML = heartSvg() + '<span class="heart-label"></span>';
    heart.addEventListener('click', function () { toggleShortlist(entry.id); });
    syncHeart(heart, entry.id);
    info.appendChild(heart);

    if (!entry.demo && shop) {
      var buy = document.createElement('div');
      buy.className = 'buy-box';
      var bh = document.createElement('h2');
      bh.textContent = t('detail.buyTitle');
      buy.appendChild(bh);
      var bp = document.createElement('p');
      bp.className = 'hint';
      bp.textContent = t('detail.buyText', { shop: shop.name });
      buy.appendChild(bp);
      buy.appendChild(contactLinks(shop, entry));
      info.appendChild(buy);
    }

    var note = document.createElement('p');
    note.className = 'detail-note';
    note.textContent = t('detail.note');
    info.appendChild(note);
    var mark = sizeMark(entry.size);
    if (mark) {
      if (frameLensDistMm(entry)) {
        var ts = document.createElement('p');
        ts.className = 'size-mark-true';
        ts.textContent = t('detail.trueSize');
        mark.appendChild(ts);
      }
      info.appendChild(mark);
    }

    var dl = document.createElement('dl');
    dl.className = 'attr-list';
    function attr(label, value) {
      if (!value) return;
      var dt = document.createElement('dt'); dt.textContent = label;
      var dd = document.createElement('dd'); dd.textContent = value;
      dl.appendChild(dt); dl.appendChild(dd);
    }
    attr(t('attr.shape'), tg.shape && tagLabel(tg.shape));
    attr(t('attr.colour'), entry.colourName || (tg.color && tagLabel(tg.color)));
    attr(t('attr.rim'), tg.rim && tagLabel(tg.rim));
    attr(t('attr.for'), tg.gender && tagLabel(tg.gender));
    attr(t('attr.type'), entry.frameType && t('ftype.' + entry.frameType));
    attr(t('attr.material'), entry.material || (entry.translucent != null && entry.prepared === 'auto' ? t(entry.translucent ? 'material.translucent' : 'material.solid') : ''));
    attr(t('attr.brand'), entry.brand);
    attr(t('attr.sku'), entry.sku);
    if (tg.free && tg.free.length) attr(t('attr.tags'), tg.free.join(', '));
    if (!mark) attr(t('attr.size'), t('attr.sizeMissing'));
    if (dl.children.length) info.appendChild(dl);
    if (entry.description) {
      var desc = document.createElement('p');
      desc.className = 'detail-desc';
      desc.textContent = entry.description;
      info.appendChild(desc);
    }

    var foot = document.createElement('div');
    foot.className = 'detail-foot';
    if (!entry.demo && entry.isPublic) {
      var rep = document.createElement('button');
      rep.type = 'button';
      rep.className = 'link-btn';
      rep.textContent = t('report.link');
      rep.addEventListener('click', function () { openReport(entry); });
      foot.appendChild(rep);
    }
    if (own) {
      var ed = document.createElement('a');
      ed.className = 'btn secondary small';
      ed.href = hashFor({ name: 'partner', id: 'product', sub: entry.id });
      ed.textContent = t('detail.editInDashboard');
      foot.appendChild(ed);
    }
    if (foot.childNodes.length) info.appendChild(foot);

    grid.appendChild(info);
    detailBody.appendChild(grid);
    updateSimilarCarousel();

    // the full-size picture of the try-on asset
    if (entry.tryOnReady) {
      getFullFrameData(entry.id).then(function (full) {
        if (view.name !== 'detail' || view.id !== entry.id) return;
        if (full.img && full.img.src) img.src = full.img.src;
      }).catch(function (e) {
        if (view.name !== 'detail' || view.id !== entry.id) return;
        console.warn('No try-on picture for this frame', e);
        var msg = document.createElement('p');
        msg.className = 'detail-unavailable';
        msg.textContent = t('detail.noAsset.customer');
        if (actions.parentNode) actions.parentNode.replaceChild(msg, actions);
        entry.tryOnReady = false;
      });
    }
  }

  // From a card, a frame's page or "Frame details": open the try-on with this frame.
  function tryOnFrame(id, mode) {
    var entry = findEntry(id);
    if (!entry || !entry.tryOnReady) return;
    // the picker shows the frames this one came from
    var src = entry.demo ? 'demo' : 'shop:' + entry.shopId;
    if (sourceKey !== src && entry.isPublic !== false) useSource(src);
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
  }

  // ---------- catalogue sources: the demo and participating shops ----------

  var DEMO_HIDDEN = {};            // demo frames the admin has switched off (config/demo)
  var demoConfigLoaded = !CONFIGURED;
  var missingIds = {};             // product ids confirmed gone (for pruning the shortlist)

  function demoEntry(f) {
    return {
      id: f.id, source: 'demo', demo: true, shopId: null, name: null, nameKey: 'demo.name.' + f.id,
      tags: f.tags, size: cleanSize(f.size), material: f.material, frameType: f.frameType,
      thumbData: f.thumb, cutoutUrl: f.cutout, manifest: f.manifest, tryOnReady: true,
      level: f.level, rimType: f.rimType, translucent: f.translucent, prepared: f.prepared,
      hasSide: false, createdAt: 0, order: DEMO_FRAMES.indexOf(f)
    };
  }
  DEMO_FRAMES.forEach(function (f) { entryMap[f.id] = demoEntry(f); });
  function demoEntries() {
    return DEMO_FRAMES.filter(function (f) { return !DEMO_HIDDEN[f.id]; }).map(function (f) { return entryMap[f.id]; });
  }
  if (CONFIGURED) {
    backend.getConfigCached('demo').then(function (cfg) {
      DEMO_HIDDEN = {};
      ((cfg && cfg.hidden) || []).forEach(function (id) { DEMO_HIDDEN[id] = true; });
    }).catch(function () {}).then(function () {
      demoConfigLoaded = true;
      if (sourceKey === 'demo') { catalogIndex = demoEntries(); afterCatalogLoaded(); }
      if (view.name === 'home') renderHome();
    });
  }

  // A published product as a catalogue entry.
  // Pictures are references (a Storage link, an inline data: URL, or a
  // productFiles document read when the frame is tried on).
  function productEntry(p) {
    var im = p.images || {}, tr = p.tryOn || {};
    var ready = isTryOnReady(p);
    return {
      id: p.id, source: 'shop', demo: false, shopId: p.shopId, lite: false, updatedMs: p.updatedMs || 0,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : null,
      tags: p.tags || {}, size: cleanSize(p.size), thumbData: imgSrc(im.thumb),
      cutoutRef: ready ? im.cutout : null, manifestRef: ready ? im.manifest : null,
      sideRef: ready && hasRef(im.side) ? im.side : null, hasSide: !!(ready && hasRef(im.side)),
      tryOnReady: !!ready, level: tr.level || '3d', rimType: tr.rimType || null,
      translucent: tr.translucent == null ? null : !!tr.translucent, prepared: tr.prepared || 'auto',
      createdAt: p.createdMs || 0, pricing: p.pricing || null, priceUpdatedAt: p.priceUpdatedMs || null,
      availability: p.availability || null, sku: p.sku || '', brand: p.brand || '', material: p.material || '',
      colourName: p.colourName || '', description: p.description || '', frameType: p.frameType || null,
      link: p.link || '', isPublic: p.public === true, status: p.status
    };
  }

  function getShopInfo(shopId) {
    if (!shopCache[shopId]) {
      shopCache[shopId] = backend.getShopCached(shopId).catch(function (e) {
        console.warn('Shop not available', e);
        return null;
      });
    }
    return shopCache[shopId];
  }
  function shopOf(entry) { return entry && entry.shopId && shopCache[entry.shopId] && shopCache[entry.shopId].value; }
  function rememberShop(shopId, shop) { shopCache[shopId] = Promise.resolve(shop); shopCache[shopId].value = shop; }

  // ---------- reading only what is shown ----------
  // A shop's catalogue comes from its index (one read; see catalogue-index.js)
  // as "lite" entries: enough for cards, search, filters and sorting, but no
  // pictures or long text. The product documents of the frames actually shown
  // are read (or taken from the browser's cache) when their cards appear, and
  // a frame's page or try-on reads its own when opened.

  var fullWaiters = {};       // id -> Promise<entry|null> while loading
  var fullQueue = [], fullTimer = 0;

  // Fills in a lite entry from its product document. Resolves with the entry
  // (null if the frame is no longer public).
  function ensureFull(id) {
    var e = entryMap[id];
    if (!e) return ensureEntry(id);
    if (!e.lite) return Promise.resolve(e);
    if (!fullWaiters[id]) {
      fullWaiters[id] = new Promise(function (resolve) {
        fullQueue.push({ id: id, resolve: resolve });
        if (!fullTimer) fullTimer = setTimeout(flushFull, 0);
      });
    }
    return fullWaiters[id];
  }
  function flushFull() {
    fullTimer = 0;
    var batch = fullQueue.splice(0);
    if (!batch.length) return;
    var ids = [], known = {};
    batch.forEach(function (q) { if (ids.indexOf(q.id) === -1) { ids.push(q.id); var e = entryMap[q.id]; if (e && e.updatedMs) known[q.id] = e.updatedMs; } });
    backend.getPublicProducts(ids, known).then(function (res) {
      var dropped = false;
      batch.forEach(function (q) {
        var p = res[q.id], e = entryMap[q.id];
        if (p && e) {
          Object.assign(e, productEntry(p));
          fillThumbs(e);
        } else if (p === null) {
          dropEntry(q.id); dropped = true; e = null;
        }
        delete fullWaiters[q.id];
        q.resolve(e && !e.lite ? e : (p === null ? null : e || null));
      });
      if (dropped) scheduleCatalogRefresh();
    }).catch(function (err) {
      console.warn('Could not load frames', err);
      batch.forEach(function (q) { delete fullWaiters[q.id]; q.resolve(entryMap[q.id] || null); });
    });
  }

  // Shows the entry's thumbnail in `img`, now or when its product arrives. A
  // frame's product is only read once its card is on (or near) the screen, so
  // a hidden picker or cards further down cost nothing until they're seen.
  var thumbObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(function (seen) {
    seen.forEach(function (en) {
      if (!en.isIntersecting) return;
      thumbObserver.unobserve(en.target);
      var id = en.target.getAttribute('data-thumb-for');
      if (id && entryMap[id] && entryMap[id].lite) ensureFull(id);
    });
  }, { rootMargin: '300px 300px' }) : null;
  function setThumb(img, entry) {
    if (!entry) return;
    if (entry.thumbData) { img.src = entry.thumbData; return; }
    img.setAttribute('data-thumb-for', entry.id);
    img.classList.add('thumb-wait');
    if (!entry.lite) return;
    if (thumbObserver) thumbObserver.observe(img); else ensureFull(entry.id);
  }
  function fillThumbs(entry) {
    if (!entry.thumbData) return;
    document.querySelectorAll('img[data-thumb-for]').forEach(function (img) {
      if (img.getAttribute('data-thumb-for') !== entry.id) return;
      if (thumbObserver) thumbObserver.unobserve(img);
      img.src = entry.thumbData;
      img.removeAttribute('data-thumb-for');
      img.classList.remove('thumb-wait');
    });
  }
  // A frame that turned out not to be public any more (or deleted).
  function dropEntry(id) {
    missingIds[id] = true;
    delete entryMap[id];
    catalogIndex = catalogIndex.filter(function (e) { return e.id !== id; });
  }
  var refreshTimer = 0;
  function scheduleCatalogRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      rebuildFilterBar();
      renderLibrary();
      renderLiveStrip();
      updateTryOnHint();
      pruneShortlist(); syncShortlistUi();
      if (view.name === 'detail' && missingIds[view.id]) renderDetail(view.id);
    }, 30);
  }

  // Makes sure a frame (from a link, the shortlist or a refresh) is known,
  // with its pictures.
  function ensureEntry(id) {
    if (!id || id === DRAFT_ID) return Promise.resolve(null);
    var known = entryMap[id];
    if (known) return known.lite ? ensureFull(id) : Promise.resolve(known);
    if (!CONFIGURED || missingIds[id]) return Promise.resolve(null);
    if (!fullWaiters[id]) {
      fullWaiters[id] = backend.getPublicProducts([id]).then(function (res) {
        delete fullWaiters[id];
        var p = res[id];
        if (!p) { if (p === null) missingIds[id] = true; return null; }
        var e = entryMap[id] = productEntry(p);
        return getShopInfo(p.shopId).then(function (shop) {
          if (shop) rememberShop(p.shopId, shop);
          return e;
        });
      }).catch(function () { delete fullWaiters[id]; return null; });
    }
    return fullWaiters[id];
  }

  function sourceTitle() {
    if (sourceKey && sourceKey.indexOf('shop:') === 0) return sourceShop ? sourceShop.name : t('cat.shopFrames');
    return t('cat.demoTitle');
  }

  var PAGE_SIZE = 24;           // frames per "page" of the catalogue (and the try-on picker)
  var shownLimit = PAGE_SIZE;
  // How the current shop's catalogue is read: 'index' (the shop's index,
  // normal) or 'paged' (no usable index: 24 products per query, newest first).
  var catalogMode = 'demo';
  var paged = { shopId: null, last: null, more: false, loadingAll: null, loadingMore: false };

  var sourceSeq = 0;
  // Shows a source in the catalogue page (and the try-on picker).
  function useSource(key) {
    if (key === sourceKey && (catalogLoaded || catalogProblem)) { renderBrowseIntro(); browseTitle.textContent = sourceTitle(); return; }
    var seq = ++sourceSeq;
    sourceKey = key;
    sourceShop = null;
    resetCatalogView();
    browseTitle.textContent = sourceTitle();
    renderBrowseIntro();
    updateCatalogNote(0);
    if (key === 'demo') {
      catalogMode = 'demo';
      catalogIndex = demoEntries();
      afterCatalogLoaded();
      return;
    }
    var shopId = key.slice(5);
    if (!CONFIGURED) { showCatalogProblem(true); return; }
    Promise.all([getShopInfo(shopId), backend.getCatalogueIndex(shopId)]).then(function (r) {
      if (seq !== sourceSeq) return null;
      var shop = r[0], idx = r[1];
      if (!shop || shop.status !== 'approved') { sourceShop = null; catalogIndex = []; catalogLoaded = true; showShopMissing(); return null; }
      rememberShop(shopId, shop);
      sourceShop = shop;
      if (idx && !idx.overflow) {
        catalogMode = 'index';
        // newest first, as before (the try-on picker shows them in this order)
        var ids = Object.keys(idx.items).filter(function (id) { return !missingIds[id]; });
        ids.sort(function (a, b) { return (idx.items[b].c || 0) - (idx.items[a].c || 0) || (a < b ? -1 : 1); });
        catalogIndex = ids.map(function (id) {
          var it = idx.items[id], old = entryMap[id];
          // a full entry already loaded this visit is kept if it hasn't changed since
          if (old && !old.lite && old.shopId === shopId && old.updatedMs && old.updatedMs === it.u) return old;
          var e = entryFromItem(id, it, shopId);
          entryMap[id] = e;
          return e;
        });
        return null;
      }
      catalogMode = 'paged';
      paged = { shopId: shopId, last: null, more: false, loadingAll: null, loadingMore: false };
      return backend.listPublicProducts(shopId, { pageSize: PAGE_SIZE }).then(function (pg) {
        if (seq !== sourceSeq) return;
        paged.last = pg.last; paged.more = pg.more;
        catalogIndex = pg.items.map(function (p) { var e = productEntry(p); entryMap[e.id] = e; return e; });
      });
    }).then(function () {
      if (seq !== sourceSeq || !sourceShop) return;
      browseTitle.textContent = sourceTitle();
      if (view.name === 'browse') setTitle(sourceTitle());
      renderBrowseIntro();
      afterCatalogLoaded();
    }).catch(function (e) {
      if (seq !== sourceSeq) return;
      console.error('Failed to load the shop catalogue', e);
      catalogIndex = []; catalogLoaded = false;
      showCatalogProblem(true);
      updateCatalogNote(0);
      updateTryOnHint();
    });
  }

  // Paged mode: the next 24 products from the server.
  function loadMorePaged() {
    if (catalogMode !== 'paged' || !paged.more || paged.loadingMore) return Promise.resolve();
    var seq = sourceSeq;
    paged.loadingMore = true;
    return backend.listPublicProducts(paged.shopId, { pageSize: PAGE_SIZE, after: paged.last }).then(function (pg) {
      if (seq !== sourceSeq) return;
      paged.last = pg.last; paged.more = pg.more;
      pg.items.forEach(function (p) {
        if (entryMap[p.id] && catalogIndex.indexOf(entryMap[p.id]) !== -1) return;
        var e = productEntry(p); entryMap[e.id] = e; catalogIndex.push(e);
        ((e.tags && e.tags.free) || []).forEach(function (tg) { allFreeTags.add(tg); });
      });
    }).catch(function (e) { console.error('Could not load more frames', e); toast(t('common.loadFailed'), 'error'); })
      .then(function () { paged.loadingMore = false; });
  }
  // Paged mode: searching, filtering or sorting needs every frame.
  function loadRestPaged() {
    if (catalogMode !== 'paged' || !paged.more) return Promise.resolve();
    if (!paged.loadingAll) {
      var seq = sourceSeq;
      paged.loadingAll = (function next() {
        return loadMorePaged().then(function () { if (seq === sourceSeq && paged.more) return next(); });
      })().then(function () {
        paged.loadingAll = null;
        if (seq !== sourceSeq) return;
        rebuildFilterBar();
        renderLibrary();
        renderLiveStrip();
      });
    }
    return paged.loadingAll;
  }

  function afterCatalogLoaded() {
    catalogLoaded = true;
    shownLimit = PAGE_SIZE;
    liveLimit = PAGE_SIZE;
    catalogIndex.forEach(function (e) { ((e.tags && e.tags.free) || []).forEach(function (tg) { allFreeTags.add(tg); }); });
    rebuildFilterBar();
    renderLibrary();
    showCatalogProblem(false);
    updateTryOnHint();
    syncShortlistUi();
    renderLiveStrip();
    syncTryonBack();
    if (view.name === 'detail') renderDetail(view.id);
    if (view.name === 'tryon') {
      if (view.id && findEntry(view.id) && activeFrameId !== view.id) selectFrame(view.id, { keepUrl: true });
      updateSelectedBanner();
    }
  }

  function showShopMissing() {
    libraryRow.innerHTML = '';
    browseTitle.textContent = t('cat.shopMissing.title');
    browseIntro.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'lede';
    p.textContent = t('cat.shopMissing.text');
    var a = document.createElement('a');
    a.className = 'btn primary'; a.href = '#/shops'; a.textContent = t('home.shopsBtn');
    browseIntro.appendChild(p); browseIntro.appendChild(a);
    catalogNote.textContent = '';
    noResults.hidden = true; emptyCatalog.hidden = true;
  }

  // Above the catalogue: what this is (the demo, or which shop and how to reach it).
  function renderBrowseIntro() {
    browseIntro.innerHTML = '';
    if (!sourceKey || sourceKey === 'demo') {
      var note = document.createElement('p');
      note.className = 'demo-note';
      note.textContent = t('cat.demoNote');
      browseIntro.appendChild(note);
      return;
    }
    if (sourceShop) browseIntro.appendChild(shopCard(sourceShop, { full: true }));
  }

  // A shop's name, place and contact links (for its catalogue, frame pages and the shop list).
  function shopCard(shop, opts) {
    opts = opts || {};
    var card = document.createElement(opts.link ? 'a' : 'div');
    card.className = 'shop-card' + (opts.full ? ' full' : '');
    if (opts.link) card.href = hashFor({ name: 'browse', source: 'shop:' + shop.id });
    var h = document.createElement(opts.full ? 'p' : 'h3');
    h.className = 'shop-name';
    h.textContent = shop.name;
    card.appendChild(h);
    var place = [shop.address, shop.city].filter(Boolean).join(', ');
    if (place) { var pl = document.createElement('p'); pl.className = 'shop-place'; pl.textContent = place; card.appendChild(pl); }
    if (opts.full && shop.about) { var ab = document.createElement('p'); ab.className = 'shop-about'; ab.textContent = shop.about; card.appendChild(ab); }
    if (!opts.link) {
      var links = contactLinks(shop, null);
      if (links.childNodes.length) card.appendChild(links);
    }
    return card;
  }

  // Call / WhatsApp / email / website links for a shop (and a product's own page).
  function contactLinks(shop, entry) {
    var row = document.createElement('div');
    row.className = 'contact-row';
    function add(href, key, primary, external) {
      if (!href) return;
      var a = document.createElement('a');
      a.className = 'btn small ' + (primary ? 'primary' : 'secondary');
      a.href = href;
      a.textContent = t(key);
      if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      row.appendChild(a);
    }
    var ask = entry ? t('contact.askAbout', { name: frameName(entry), sku: entry.sku ? ' (' + entry.sku + ')' : '' }) : '';
    add(whatsappLink(shop.whatsapp, ask), 'contact.whatsapp', !!entry, true);
    add(telLink(shop.phone), 'contact.call', false, false);
    if (shop.email) add('mailto:' + shop.email + (entry ? '?subject=' + encodeURIComponent(ask) : ''), 'contact.email', false, false);
    if (entry && entry.link) add(entry.link, 'contact.productPage', false, true);
    else if (shop.website) add(shop.website, 'contact.website', false, true);
    return row;
  }

  // ---------- home and the shop list ----------

  // The shop list: the home page needs 6, the Shops page all (up to 100).
  // Both are kept in the browser for a while (see backend.listApprovedShops).
  var shopsList = null, shopsLoading = null, homeShops = null;
  function loadShops(max) {
    if (!CONFIGURED) return Promise.resolve([]);
    if (shopsList) return Promise.resolve(max ? shopsList.slice(0, max) : shopsList);
    if (max) {
      if (!homeShops) {
        homeShops = backend.listApprovedShops(max).then(function (list) {
          list.forEach(function (sh) { rememberShop(sh.id, sh); });
          return list;
        }).catch(function (e) { console.warn('Could not load shops', e); homeShops = null; return null; });
      }
      return homeShops;
    }
    if (!shopsLoading) {
      shopsLoading = backend.listApprovedShops(100).then(function (list) {
        shopsList = list;
        list.forEach(function (sh) { rememberShop(sh.id, sh); });
        return list;
      }).catch(function (e) { console.warn('Could not load shops', e); shopsLoading = null; return null; });
    }
    return shopsLoading;
  }

  function demoCard(e) {
    var card = document.createElement('article');
    card.className = 'frame-card demo-card';
    var media = document.createElement('div');
    media.className = 'frame-card-media';
    var img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.width = 260; img.height = 160; img.alt = ''; setThumb(img, e);
    media.appendChild(img);
    card.appendChild(media);
    var body = document.createElement('div');
    body.className = 'frame-card-body';
    var title = document.createElement('h3');
    title.className = 'frame-card-title';
    var link = document.createElement('a');
    link.className = 'frame-card-link';
    link.href = hashFor({ name: 'detail', id: e.id });
    link.textContent = frameName(e);
    title.appendChild(link);
    body.appendChild(title);
    var badge = document.createElement('span');
    badge.className = 'demo-badge';
    badge.textContent = t('demo.badge');
    body.appendChild(badge);
    card.appendChild(body);
    var actions = document.createElement('div');
    actions.className = 'frame-card-actions';
    var tryBtn = document.createElement('button');
    tryBtn.type = 'button';
    tryBtn.className = 'btn secondary frame-card-tryon';
    tryBtn.textContent = t('card.tryon');
    tryBtn.setAttribute('aria-label', t('card.tryon.aria', { name: frameName(e) }));
    tryBtn.addEventListener('click', function () { useSource('demo'); tryOnFrame(e.id, 'auto'); });
    actions.appendChild(tryBtn);
    card.appendChild(actions);
    return card;
  }

  function renderHome() {
    homeDemoRow.innerHTML = '';
    demoEntries().forEach(function (e) { homeDemoRow.appendChild(demoCard(e)); });
    var first = demoEntries()[0];
    var tryLink = document.getElementById('homeTryBtn');
    if (first) tryLink.href = hashFor({ name: 'tryon', id: first.id });
    homeShopRow.innerHTML = '';
    if (!CONFIGURED) { homeShopRow.appendChild(emptyLine(t('shops.none'))); return; }
    loadShops(6).then(function (list) {
      if (view.name !== 'home') return;
      homeShopRow.innerHTML = '';
      if (!list) { homeShopRow.appendChild(emptyLine(t('shops.error'))); return; }
      if (!list.length) { homeShopRow.appendChild(emptyLine(t('shops.none'))); return; }
      list.slice(0, 6).forEach(function (sh) { homeShopRow.appendChild(shopCard(sh, { link: true })); });
    });
  }
  document.getElementById('homeTryBtn').addEventListener('click', function () { useSource('demo'); });

  function emptyLine(text) { var p = document.createElement('p'); p.className = 'hint'; p.textContent = text; return p; }

  function renderShops() {
    shopsGrid.innerHTML = '';
    shopsNote.textContent = CONFIGURED ? t('cat.loading') : '';
    if (!CONFIGURED) { shopsGrid.appendChild(emptyLine(t('shops.none'))); return; }
    loadShops().then(function (list) {
      if (view.name !== 'shops') return;
      shopsGrid.innerHTML = '';
      if (!list) { shopsNote.textContent = ''; shopsGrid.appendChild(emptyLine(t('shops.error'))); return; }
      shopsNote.textContent = tn('shops.count', list.length);
      if (!list.length) { shopsGrid.appendChild(emptyLine(t('shops.none'))); return; }
      list.forEach(function (sh) { shopsGrid.appendChild(shopCard(sh, { link: true })); });
    });
  }

  // ---------- the shop dashboard and the admin dashboard ----------
  // Both live in their own modules, loaded on first visit. The server rules
  // decide what each account may do; these pages only offer it.

  function dashboardContext() {
    return {
      backend: backend, t: t, tn: tn, getLang: getLang, toast: toast, confirmAction: confirmAction,
      navigate: navigate, hashFor: hashFor, currentUser: function () { return currentUser; },
      isAdmin: function () { return account.isAdmin; }, adminChecked: function () { return account.checked; },
      tagLabel: tagLabel, frameName: frameName, sizeShort: sizeShort, setTitle: setTitle,
      openPhotoStep: openPhotoStep, previewProduct: previewProduct, productEntry: productEntry,
      forgetProduct: forgetProduct, legacyImport: legacyImport, demoFrames: DEMO_FRAMES, demoName: function (id) { return frameName(entryMap[id]); },
      FACETS: FACETS
    };
  }
  var partnerApi = null, adminApi = null;
  function openPartner(r) {
    if (!CONFIGURED) { pagePartner.querySelector('#partnerRoot').textContent = t('setup.notConfigured'); return; }
    loadPartner().then(function (m) {
      if (!partnerApi) partnerApi = m.initPartner(document.getElementById('partnerRoot'), dashboardContext());
      if (view.name === 'partner') partnerApi.show(r);
    }).catch(function (e) { console.error(e); toast(t('common.loadFailed'), 'error'); });
  }
  function openAdmin(r) {
    if (!CONFIGURED) { pageAdmin.querySelector('#adminRoot').textContent = t('setup.notConfigured'); return; }
    loadAdmin().then(function (m) {
      if (!adminApi) adminApi = m.initAdmin(document.getElementById('adminRoot'), dashboardContext());
      if (view.name === 'admin') adminApi.show(r);
    }).catch(function (e) { console.error(e); toast(t('common.loadFailed'), 'error'); });
  }

  // A shop's own product as customers will see it (also before it's published).
  function previewProduct(p) {
    var e = productEntry(p);
    entryMap[e.id] = e;
    delete fullDataCache[e.id];
    arForget(e.id);
    previewIds[e.id] = true;
    navigate({ name: 'detail', id: e.id });
  }
  var previewIds = {};
  function forgetProduct(id) {
    var e = entryMap[id];
    // the shop's catalogue is read again (with its fresh index) next time it's shown
    if (e && e.shopId && sourceKey === 'shop:' + e.shopId) sourceKey = null;
    delete entryMap[id]; delete fullDataCache[id]; arForget(id);
    catalogIndex = catalogIndex.filter(function (x) { return x.id !== id; });
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
    if (addTarget.product) prefillFromProduct(addTarget.product);
    showFrameCalibSection();

    // quick checks of the photo itself (sharpness, light, size) with advice
    showPhotoCheck(canvas, naturalW, naturalH);
    processPendingFrame();
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
      if (res.ok && !pendingTags.rim) {
        pendingTags.rim = { full: 'fullrim', semi: 'semirimless', rimless: 'rimless' }[res.rimType] || null;
        renderAddChips();
      }
      if (!res.ok && !auto.calibManual) frameCalibPoints = [];
      renderAutoReview();
      processPendingFrame();
      renderPhotoCheck();
      if (!res.ok) recordExtractionFailure(res);
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
          fit: effectiveMode() === 'auto' ? buildFitFrom(auto.result, currentLevel(), 0, 0, 1, 1, pts) : null
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

  // ---------- add-frame: the photo step for one of the shop's products ----------
  // Reached from the product in the shop dashboard (#/add/<productId>, or
  // .../side for a temple photo). The product's details live in the dashboard;
  // this page makes and saves its photo and try-on asset.

  function prefillFromProduct(p) {
    if (!p) return;
    var tg = p.tags || {};
    pendingTags = { shape: tg.shape || null, color: tg.color || null, gender: tg.gender || null, rim: tg.rim || null, free: (tg.free || []).slice() };
    renderAddChips(); renderFreeTagList();
    fillSize(p.size, sizeEye, sizeBridge, sizeTemple);
    frameNameInput.value = p.name || '';
  }

  // Called by the dashboard: start the photo step for `product`.
  function openPhotoStep(product, shopStatus, kind) {
    pendingProducts[product.id] = { product: product, shopStatus: shopStatus };
    navigate({ name: 'add', id: product.id, sub: kind === 'side' ? 'side' : null });
  }
  var pendingProducts = {};

  function openAddRoute(r) {
    var signedIn = backend.isRealUser(currentUser);
    addLocked.hidden = signedIn && !!r.id;
    addContent.hidden = !(signedIn && r.id);
    if (!signedIn || !r.id) return;
    var kind = r.sub === 'side' ? 'side' : 'product';
    if (addTarget.frameId === r.id && addTarget.kind === kind && addTarget.product) { syncProductBar(); return; }
    var known = pendingProducts[r.id];
    var load = known ? Promise.resolve(known)
      : Promise.all([backend.getProduct(r.id), backend.getShop(currentUser.uid)]).then(function (x) { return { product: x[0], shopStatus: x[1] ? x[1].status : null }; });
    load.then(function (k) {
      if (view.name !== 'add' || view.id !== r.id) return;
      if (!k.product || k.product.shopId !== currentUser.uid) { addLocked.hidden = false; addContent.hidden = true; return; }
      if (kind === 'side' && !(k.product.tryOn && k.product.tryOn.status === 'ready')) { navigate({ name: 'add', id: r.id }, { replace: true }); return; }
      enterProductMode(k.product, k.shopStatus, kind);
    }).catch(function (e) {
      console.error('Could not open the product', e);
      toast(t('common.loadFailed'), 'error');
    });
  }

  function enterProductMode(product, shopStatus, kind) {
    discardPendingFrame();
    addTarget = { kind: kind, frameId: product.id, product: product, shopStatus: shopStatus, replacingSide: !!(product.images && product.images.side) };
    pendingProducts[product.id] = { product: product, shopStatus: shopStatus };
    prefillFromProduct(product);
    frontOnlySection.style.display = 'none';
    sideTarget.style.display = 'none';
    sideTargetHint.style.display = kind === 'side' ? 'block' : 'none';
    replaceTargetHint.style.display = 'none';
    var hasSource = !!(product.images && product.images.source);
    replaceTargetRow.style.display = kind === 'product' && hasSource ? 'flex' : 'none';
    addedMsg.style.display = 'none';
    if (kind === 'side' || bgRemovalMode !== 'auto') setBgMode('auto');
    syncProductBar();
    syncAddTargetText();
    renderPhotoGuide(true);
    advanceForNextCapture();
  }

  function syncProductBar() {
    var p = addTarget.product;
    addProductBar.hidden = !p;
    if (!p) return;
    addProductThumb.innerHTML = '';
    if (p.images && backend.imgSrc(p.images.thumb)) {
      var img = document.createElement('img'); img.src = backend.imgSrc(p.images.thumb); img.alt = '';
      addProductThumb.appendChild(img);
    }
    addProductName.textContent = (p.name || t('partner.untitled')) + (p.sku ? ' · ' + p.sku : '');
    addProductBack.href = hashFor({ name: 'partner', id: 'product', sub: p.id });
  }

  function backToProduct(product) {
    var id = product ? product.id : addTarget.frameId;
    if (partnerApi && product) partnerApi.productChanged(product);
    navigate({ name: 'partner', id: 'product', sub: id });
  }

  reprocessBtn.addEventListener('click', function () {
    var p = addTarget.product;
    if (!p || !p.images || !p.images.source) return;
    reprocessBtn.disabled = true;
    backend.getSourceBlob(p.images.source).then(function (blob) {
      var url = URL.createObjectURL(blob);
      return loadImage(url).then(function (img) { URL.revokeObjectURL(url); return img; });
    }).then(function (img) {
      if (!addTarget.product || addTarget.product.id !== p.id) return;
      pendingSourceIsNew = false;
      beginAddFrameFromSource(img, img.naturalWidth, img.naturalHeight);
    }).catch(function (e) {
      console.error('Could not load the original photo', e);
      showAddSourceError('add.err.original');
    }).then(function () { reprocessBtn.disabled = false; });
  });

  // ---------- add-frame: how to photograph a frame, and checking the photo ----------

  var photoQuality = null;     // checkPhoto() result for the photo on the page

  function renderPhotoGuide(open) {
    photoGuide.innerHTML = '';
    var side = addTarget.kind === 'side';
    var d = document.createElement('details');
    d.className = 'photo-guide';
    d.open = !!open;
    var sm = document.createElement('summary');
    sm.textContent = t(side ? 'guide.side.title' : 'guide.title');
    d.appendChild(sm);
    var ul = document.createElement('ul');
    ul.className = 'guide-list';
    (side ? ['guide.side.1', 'guide.side.2', 'guide.side.3'] : ['guide.1', 'guide.2', 'guide.3', 'guide.4', 'guide.5', 'guide.6']).forEach(function (k) {
      var li = document.createElement('li'); li.textContent = t(k); ul.appendChild(li);
    });
    d.appendChild(ul);
    if (!side) {
      var fig = document.createElement('div');
      fig.className = 'guide-examples';
      [['good', 'guide.ex.good'], ['angled', 'guide.ex.angled'], ['cut', 'guide.ex.cut'], ['busy', 'guide.ex.busy']].forEach(function (ex) {
        var f = document.createElement('figure');
        f.className = 'guide-ex guide-ex-' + ex[0];
        f.innerHTML = guideSvg(ex[0]);
        var c = document.createElement('figcaption'); c.textContent = t(ex[1]);
        f.appendChild(c);
        fig.appendChild(f);
      });
      d.appendChild(fig);
    }
    photoGuide.appendChild(d);
  }
  // Little line drawings of a good photo and three common mistakes.
  function guideSvg(kind) {
    var frame = '<g fill="none" stroke="currentColor" stroke-width="5"><rect x="22" y="38" width="62" height="40" rx="12"/><rect x="116" y="38" width="62" height="40" rx="12"/><path d="M84 50q16-10 32 0"/></g>';
    var mark = kind === 'good' ? '<path d="M168 14l8 8 14-16" fill="none" stroke="#2E7A72" stroke-width="5" stroke-linecap="round"/>' : '<path d="M170 8l16 16M186 8l-16 16" stroke="#B42318" stroke-width="5" stroke-linecap="round"/>';
    var body = frame;
    if (kind === 'angled') body = '<g transform="translate(100 58) skewY(-12) scale(0.86 1) translate(-100 -58)">' + frame + '</g>';
    if (kind === 'cut') body = '<g transform="translate(46 0)">' + frame + '</g>';
    if (kind === 'busy') body = '<g stroke="#B8BCB6" stroke-width="3"><path d="M0 30l200 40M0 70l200-30M40 0l30 116M140 0l-20 116"/></g>' + frame;
    return '<svg viewBox="0 0 200 116" aria-hidden="true"><rect x="1" y="1" width="198" height="114" rx="10" fill="var(--display)" stroke="var(--line)"/>' + body + mark + '</svg>';
  }

  function showPhotoCheck(workCanvas, naturalW, naturalH) {
    try {
      var g = workCanvas.getContext('2d', { willReadFrequently: true });
      photoQuality = checkPhoto(g.getImageData(0, 0, workCanvas.width, workCanvas.height), naturalW, naturalH);
    } catch (e) { photoQuality = null; }
    renderPhotoCheck();
    var gd = photoGuide.querySelector('details');
    if (gd) gd.open = false;
  }

  // What's wrong with the photo, and what to do about it: the quick checks
  // above plus the extraction's own findings that call for a new photo.
  function renderPhotoCheck() {
    photoCheck.innerHTML = '';
    var items = [];
    if (photoQuality) photoQuality.issues.forEach(function (i) { items.push({ sev: i.severity, text: t('pq.' + i.code) }); });
    var r = auto.result;
    if (effectiveMode() === 'auto' && r && !auto.busy) {
      if (!r.ok) items.push({ sev: 'error', text: t('pq.notFound') });
      else r.warnings.forEach(function (wn) { if (RETAKE_CODES.indexOf(wn.code) !== -1) items.push({ sev: wn.severity === 'info' ? 'warn' : wn.severity, text: fxWarning(wn) }); });
    }
    var needRetake = items.some(function (i) { return i.sev === 'error' || i.sev === 'warn'; });
    photoCheck.hidden = !items.length && !(photoQuality && !auto.busy);
    var h = document.createElement('p');
    h.className = 'photo-check-head ' + (items.some(function (i) { return i.sev === 'error'; }) ? 'bad' : needRetake ? 'warn' : 'ok');
    h.textContent = !items.length ? t('pq.allGood') : t(needRetake ? 'pq.retakeAdvice' : 'pq.notes');
    photoCheck.appendChild(h);
    if (items.length) {
      var ul = document.createElement('ul');
      items.forEach(function (i) { var li = document.createElement('li'); li.className = i.sev; li.textContent = i.text; ul.appendChild(li); });
      photoCheck.appendChild(ul);
    }
    if (needRetake) {
      var row = document.createElement('div');
      row.className = 'row';
      var again = document.createElement('button');
      again.type = 'button'; again.className = 'btn primary small';
      again.textContent = t('pq.retake');
      again.addEventListener('click', function () { discardPendingFrame(); advanceForNextCapture(); renderPhotoGuide(true); startFrameCamera(); });
      var up = document.createElement('button');
      up.type = 'button'; up.className = 'btn secondary small';
      up.textContent = t('pq.another');
      up.addEventListener('click', function () { discardPendingFrame(); advanceForNextCapture(); frameFileInputEl.value = ''; frameFileInputEl.click(); });
      row.appendChild(again); row.appendChild(up);
      photoCheck.appendChild(row);
    }
    // a frame that can't be extracted can still be listed with its photo, without try-on
    saveNoTryonBtn.hidden = !(addTarget.kind === 'product' && pendingRawCanvas && effectiveMode() === 'auto' && r && !r.ok && !auto.busy);
  }
  var RETAKE_CODES = ['cropped', 'asymmetricStrong', 'lowContrast', 'small', 'wide', 'bridgeRepaired'];

  // ---------- add-frame: preview the unsaved frame in the real try-on ----------

  var DRAFT_ID = '__draft__', draftEntry = null, draftPrevActive = null;

  function startDraftPreview() {
    if (!pendingRawCanvas || frameCalibPoints.length < 2) return;
    endDraftPreview(false);
    var c = document.createElement('canvas');
    c.width = pendingProcessedCanvas.width; c.height = pendingProcessedCanvas.height;
    c.getContext('2d').drawImage(pendingProcessedCanvas, 0, 0);
    var fit = effectiveMode() === 'auto' ? buildFitFrom(auto.result, currentLevel(), 0, 0, 1, 1, frameCalibPoints) : null;
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

  // ---------- importing the old single-shop library ----------
  // Before shops existed, frames were saved under users/{uid}/... with their
  // pictures inside Firestore. This copies them into the shop's products (as
  // drafts, so price and tax can be added before publishing) with their
  // pictures in Storage. Frames imported before are skipped.

  function dataUrlToBlob(u) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(u || '');
    if (!m) throw new Error('not a data URL');
    var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: m[1] });
  }

  function legacyImport(onProgress) {
    if (!currentUser) return Promise.reject(new Error('Not signed in'));
    var uid = currentUser.uid, shopStatus = null, done = 0, imported = 0, skipped = 0, failed = 0;
    return Promise.all([backend.getShop(uid), backend.legacyFrames(uid), backend.loadAllMyProducts(uid)]).then(function (r) {
      shopStatus = r[0] ? r[0].status : null;
      var already = {};
      r[2].forEach(function (p) { if (p.legacyId) already[p.legacyId] = true; });
      var frames = r[1];
      return frames.reduce(function (chain, f) {
        return chain.then(function () {
          if (already[f.id]) { skipped++; done++; if (onProgress) onProgress(done, frames.length); return; }
          return importOne(uid, f, shopStatus).then(function () { imported++; }).catch(function (e) {
            console.error('Could not import frame ' + f.id, e); failed++;
          }).then(function () { done++; if (onProgress) onProgress(done, frames.length); });
        });
      }, Promise.resolve()).then(function () { return { total: frames.length, imported: imported, skipped: skipped, failed: failed }; });
    });
  }

  function importOne(uid, f, shopStatus) {
    var id = backend.newProductId(), v = backend.assetVersion(), uploaded = [];
    function up(kind, name, blob, extra) {
      return backend.uploadProductFile(uid, id, kind, name, blob, extra).then(function (info) { uploaded.push(info); return info; });
    }
    var tg = f.tags || {};
    var base = {
      name: typeof f.name === 'string' ? f.name.trim().slice(0, 80) : '',
      tags: { shape: tg.shape || null, color: tg.color || null, gender: tg.gender || null, rim: tg.rim || null, free: (tg.free || []).slice(0, 12) },
      size: cleanSize(f.size), legacyId: f.id, status: 'draft', tryOn: { status: 'pending' }
    };
    return backend.createProduct(uid, id, base, shopStatus).then(function () {
      return backend.legacyFull(uid, f.id);
    }).then(function (L) {
      var jobs = [];
      if (f.thumbData) jobs.push(up('assets', 'thumb-' + v, dataUrlToBlob(f.thumbData), { w: THUMB_DIM, h: THUMB_DIM }).then(function (i) { return ['thumb', i]; }));
      if (L.source && L.source.imageData) jobs.push(up('source', 'source-' + v, dataUrlToBlob(L.source.imageData), { w: L.source.w || null, h: L.source.h || null }).then(function (i) { return ['source', i]; }));
      var manifestJob = null;
      if (L.full && L.full.imageData) {
        manifestJob = loadImage(L.full.imageData).then(function (img) {
          var m = makeManifest({
            imgW: img.naturalWidth, imgH: img.naturalHeight,
            p1: scalePoint(L.full.p1, L.full, img), p2: scalePoint(L.full.p2, L.full, img),
            fit: fitForImage(L.full, img), side: null
          });
          var sideJob = Promise.resolve(null);
          if (L.side && L.side.imageData && f.hasSide) {
            sideJob = loadImage(L.side.imageData).then(function (simg) {
              m.side = { imgW: simg.naturalWidth, imgH: simg.naturalHeight, hinge: scalePoint(L.side.hinge, L.side, simg), tip: scalePoint(L.side.tip, L.side, simg) };
              return up('assets', 'side-' + v, dataUrlToBlob(L.side.imageData), { w: simg.naturalWidth, h: simg.naturalHeight });
            });
          }
          return Promise.all([
            up('assets', 'cutout-' + v, dataUrlToBlob(L.full.imageData), { w: img.naturalWidth, h: img.naturalHeight }),
            sideJob
          ]).then(function (x) {
            return up('assets', 'asset-' + v, jsonBlob(m)).then(function (mi) { return { cutout: x[0], side: x[1], manifest: mi, fit: m.fit }; });
          });
        });
      }
      return Promise.all([Promise.all(jobs), manifestJob]);
    }).then(function (r) {
      var images = {};
      r[0].forEach(function (pair) { images[pair[0]] = pair[1]; });
      var tryOn = { status: 'none', updatedAt: backend.serverTime() };
      if (r[1]) {
        images.cutout = r[1].cutout; images.manifest = r[1].manifest;
        if (r[1].side) images.side = r[1].side;
        var fit = r[1].fit;
        tryOn = {
          status: 'ready', level: f.level === '2d' ? '2d' : '3d', prepared: f.prepared === 'auto' ? 'auto' : 'manual',
          quality: fit && fit.quality != null ? fit.quality : null, rimType: f.rimType || null,
          translucent: f.translucent == null ? null : !!f.translucent, warnings: fit && fit.warnings ? fit.warnings.slice(0, 30) : [],
          hasSide: !!r[1].side, updatedAt: backend.serverTime()
        };
      }
      var current = { id: id, shopId: uid, name: base.name, status: 'draft', moderation: { state: 'ok' }, tryOn: base.tryOn, tags: base.tags, size: base.size };
      return backend.saveProduct(current, { images: images, tryOn: tryOn, assetBytes: assetBytesOf(images) }, shopStatus);
    }).catch(function (e) {
      backend.deleteFiles(uploaded);
      throw e;
    });
  }

  // ---------- add-frame: labels, discarding, the temple photo ----------

  // Labels that depend on what the page is doing (the frame's photo, or a temple photo).
  function syncAddTargetText() {
    var kind = addTarget.kind;
    framePhotoLabel.textContent = t(kind === 'side' ? 'add.templePhoto' : 'add.framePhoto');
    addToLibraryBtn.textContent = t(kind === 'side' ? 'add.saveTemple' : 'add.saveAsset');
  }

  function discardPendingFrame() {
    auto.token++; auto.busy = false; auto.result = null; auto.key = ''; auto.calibManual = false;
    autoReview.style.display = 'none';
    pendingSourceCanvas = null;
    pendingRawCanvas = null;
    pendingAiRemovedCanvas = null;
    aiRemovalLoading = false;
    pendingSourceIsNew = true;
    photoQuality = null;
    photoCheck.hidden = true; photoCheck.innerHTML = '';
    saveNoTryonBtn.hidden = true;
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

  sideTargetCancel.addEventListener('click', function () { discardPendingFrame(); backToProduct(null); });
  addSideAfterBtn.addEventListener('click', function () { if (addTarget.product) openPhotoStep(addTarget.product, addTarget.shopStatus, 'side'); });

  var addedMsgKey = null;
  function setAddedMsg(key) { addedMsgKey = key; addedMsgText.textContent = t(key); }

  function canvasBlob(c, type, quality) {
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Could not encode the image')); }, type, quality);
    });
  }
  // WebP where the browser can write it (smaller), PNG otherwise.
  function thumbBlob(c) {
    return canvasBlob(c, 'image/webp', 0.86).then(function (b) { return b.type === 'image/webp' ? b : canvasBlob(c, 'image/png'); });
  }
  function jsonBlob(o) { return new Blob([JSON.stringify(o)], { type: 'application/json' }); }

  // Uploads the temple photo and rewrites the asset manifest to include it.
  function saveSidePhoto() {
    var p = addTarget.product;
    if (!p || frameCalibPoints.length < 2 || !currentUser) return;
    if (!(p.images && backend.hasRef(p.images.manifest))) { toast(t('add.templeNeedsFront'), 'error'); return; }
    addToLibraryBtn.disabled = true;
    frameCalibBanner.textContent = t('add.saving');
    var uid = currentUser.uid, v = backend.assetVersion();
    var box = alphaBox(pendingProcessedCanvas);
    var c = document.createElement('canvas');
    c.width = box.w; c.height = box.h;
    c.getContext('2d').drawImage(pendingProcessedCanvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    var sc = function (pt) { return { x: Math.round((pt.x - box.x) * 10) / 10, y: Math.round((pt.y - box.y) * 10) / 10 }; };
    var side = { imgW: c.width, imgH: c.height, hinge: sc(frameCalibPoints[0]), tip: sc(frameCalibPoints[1]) };
    var uploaded = [];
    backend.loadManifest(p.images.manifest).then(function (m) {
      var next = Object.assign({}, m, { side: side });
      return Promise.all([
        canvasBlob(c, 'image/png').then(function (b) { return backend.uploadProductFile(uid, p.id, 'assets', 'side-' + v, b, { w: c.width, h: c.height }); }),
        backend.uploadProductFile(uid, p.id, 'assets', 'asset-' + v, jsonBlob(next))
      ]);
    }).then(function (r) {
      uploaded = [r[0], r[1]];
      var images = Object.assign({}, p.images, { side: r[0], manifest: r[1] });
      var tryOn = Object.assign({}, p.tryOn, { hasSide: true });
      var old = [p.images.side, p.images.manifest].filter(Boolean);
      return backend.saveProduct(p, { images: images, tryOn: tryOn, assetBytes: assetBytesOf(images) }, addTarget.shopStatus).then(function (written) {
        backend.deleteFiles(old);
        return written;
      });
    }).then(function (written) {
      forgetProduct(p.id);
      discardPendingFrame();
      toast(t('add.templeSaved'));
      backToProduct(written);
    }).catch(function (e) {
      console.error('Failed to save temple photo', e);
      backend.deleteFiles(uploaded);
      addToLibraryBtn.disabled = false;
      frameCalibBanner.textContent = t('add.templeFail');
    });
  }

  function assetBytesOf(images) {
    var n = 0;
    Object.keys(images || {}).forEach(function (k) { if (images[k] && images[k].bytes) n += images[k].bytes; });
    return Math.min(50000000, Math.round(n));
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

  function makeThumbCanvas(imgSource, size, photo) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var tctx = c.getContext('2d');
    var iw = imgSource.width, ih = imgSource.height;
    var scale = Math.min(size / iw, size / ih) * (photo ? 1 : 0.92);
    if (photo) { tctx.fillStyle = '#ECEEEB'; tctx.fillRect(0, 0, size, size); }
    var dw = iw * scale, dh = ih * scale;
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(imgSource, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return c;
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

  addToLibraryBtn.addEventListener('click', function () {
    if (frameCalibPoints.length < 2 || !currentUser || !addTarget.product) return;
    if (addTarget.kind === 'side') { saveSidePhoto(); return; }
    // an extraction with serious problems is never saved without a deliberate yes
    if (effectiveMode() === 'auto' && auto.result && auto.result.ok) {
      var bad = auto.result.warnings.filter(function (wn) { return wn.severity === 'error'; });
      if (bad.length || auto.result.quality < 0.6) {
        confirmAction({
          title: t('add.attn.title'),
          body: (bad.length ? bad.map(fxWarning) : [t('add.attn.some')]).concat([t('add.attn.check')]),
          ok: t('add.attn.ok'), cancel: t('add.attn.cancel')
        }).then(function (yes) { if (yes) saveProductAsset(); });
        return;
      }
    }
    saveProductAsset();
  });
  saveNoTryonBtn.addEventListener('click', function () { savePhotoOnly(); });

  // The original photo as a JPEG (kept privately so the asset can be remade).
  function sourceBlob() {
    if (!pendingSourceCanvas || !pendingSourceIsNew) return Promise.resolve(null);
    return canvasBlob(pendingSourceCanvas, 'image/jpeg', 0.9);
  }

  // Saves the try-on asset for the product: cut-out, thumbnail, fitting data
  // and (if new) the original photo, then points the product at them.
  function saveProductAsset() {
    var p = addTarget.product;
    if (frameCalibPoints.length < 2 || !currentUser || !p) return;
    addToLibraryBtn.disabled = true;
    frameCalibBanner.textContent = t('add.saving');
    var uid = currentUser.uid, v = backend.assetVersion();

    // crop to the frame
    var box = alphaBox(pendingProcessedCanvas);
    var fullCanvas = document.createElement('canvas');
    fullCanvas.width = box.w; fullCanvas.height = box.h;
    fullCanvas.getContext('2d').drawImage(pendingProcessedCanvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    var thumbCanvas = makeThumbCanvas(fullCanvas, THUMB_DIM);
    var sc = function (pt) { return { x: Math.round((pt.x - box.x) * 10) / 10, y: Math.round((pt.y - box.y) * 10) / 10 }; };
    var p1 = sc(frameCalibPoints[0]), p2 = sc(frameCalibPoints[1]);
    if (p1.x > p2.x) { var tmp = p1; p1 = p2; p2 = tmp; }
    var autoOk = effectiveMode() === 'auto' && auto.result && auto.result.ok;
    var fit = autoOk ? buildFitFrom(auto.result, currentLevel(), box.x, box.y, 1, 1, frameCalibPoints) : null;
    var level = fit ? fit.level : (auto.level || '3d');
    var manifest = makeManifest({ imgW: box.w, imgH: box.h, p1: p1, p2: p2, fit: fit, side: null });
    var uploaded = [];
    function up(kind, name, blob, extra) {
      return backend.uploadProductFile(uid, p.id, kind, name, blob, extra).then(function (info) { uploaded.push(info); return info; });
    }
    Promise.all([
      canvasBlob(fullCanvas, 'image/png').then(function (b) { return up('assets', 'cutout-' + v, b, { w: box.w, h: box.h }); }),
      thumbBlob(thumbCanvas).then(function (b) { return up('assets', 'thumb-' + v, b, { w: THUMB_DIM, h: THUMB_DIM }); }),
      up('assets', 'asset-' + v, jsonBlob(manifest)),
      sourceBlob().then(function (b) { return b ? up('source', 'source-' + v, b, { w: pendingSourceCanvas.width, h: pendingSourceCanvas.height }) : null; })
    ]).then(function (r) {
      var old = p.images || {};
      var images = { cutout: r[0], thumb: r[1], manifest: r[2] };
      images.source = r[3] || old.source;
      if (!images.source) delete images.source;
      var tryOn = {
        status: 'ready', level: level, prepared: fit ? 'auto' : 'manual', quality: fit ? fit.quality : null,
        rimType: fit ? fit.rimType : null, translucent: fit ? fit.translucent : null,
        warnings: fit ? fit.warnings.slice(0, 30) : [], hasSide: false, updatedAt: backend.serverTime()
      };
      var changes = { images: images, tryOn: tryOn, assetBytes: assetBytesOf(images) };
      // fill the rim tag from what was detected, if the shop hasn't chosen one
      var tg = Object.assign({ shape: null, color: null, gender: null, rim: null, free: [] }, p.tags || {});
      if (!tg.rim && fit) { tg.rim = { full: 'fullrim', semi: 'semirimless', rimless: 'rimless' }[fit.rimType] || null; changes.tags = tg; }
      var replaced = ['cutout', 'thumb', 'manifest', 'side'].map(function (k) { return old[k]; })
        .concat(r[3] && old.source ? [old.source] : []).filter(Boolean);
      return backend.saveProduct(p, changes, addTarget.shopStatus).then(function (written) {
        backend.deleteFiles(replaced);     // the previous version's files
        return written;
      });
    }).then(function (written) {
      uploaded = [];
      forgetProduct(p.id);
      endDraftPreview(false);
      pendingRawCanvas = null;
      modelPreview.style.display = 'none';
      discardPendingFrame();
      toast(t('add.assetSaved'));
      backToProduct(written);
    }).catch(function (e) {
      console.error('Failed to save the try-on asset', e);
      backend.deleteFiles(uploaded);
      addToLibraryBtn.disabled = false;
      frameCalibBanner.textContent = t('add.saveFail');
      toast(t('add.saveFail'), 'error');
    });
  }

  // When the frame can't be extracted: keep the photo as the product's picture,
  // with virtual try-on marked as unavailable.
  function savePhotoOnly() {
    var p = addTarget.product;
    if (!p || !pendingRawCanvas || !currentUser) return;
    saveNoTryonBtn.disabled = true;
    var uid = currentUser.uid, v = backend.assetVersion();
    var thumbCanvas = makeThumbCanvas(pendingRawCanvas, THUMB_DIM, true);
    var uploaded = [];
    function up(kind, name, blob, extra) {
      return backend.uploadProductFile(uid, p.id, kind, name, blob, extra).then(function (info) { uploaded.push(info); return info; });
    }
    Promise.all([
      thumbBlob(thumbCanvas).then(function (b) { return up('assets', 'thumb-' + v, b, { w: THUMB_DIM, h: THUMB_DIM }); }),
      sourceBlob().then(function (b) { return b ? up('source', 'source-' + v, b, { w: pendingSourceCanvas.width, h: pendingSourceCanvas.height }) : null; })
    ]).then(function (r) {
      var old = p.images || {};
      var images = { thumb: r[0] };
      if (r[1] || old.source) images.source = r[1] || old.source;
      var tryOn = { status: 'none', error: auto.result && auto.result.code ? String(auto.result.code).slice(0, 60) : null, updatedAt: backend.serverTime() };
      if (!tryOn.error) delete tryOn.error;
      var replaced = ['cutout', 'thumb', 'manifest', 'side'].map(function (k) { return old[k]; })
        .concat(r[1] && old.source ? [old.source] : []).filter(Boolean);
      return backend.saveProduct(p, { images: images, tryOn: tryOn, assetBytes: assetBytesOf(images) }, addTarget.shopStatus).then(function (written) {
        backend.deleteFiles(replaced);
        return written;
      });
    }).then(function (written) {
      forgetProduct(p.id);
      discardPendingFrame();
      toast(t('add.photoOnlySaved'));
      backToProduct(written);
    }).catch(function (e) {
      console.error('Failed to save the photo', e);
      backend.deleteFiles(uploaded);
      toast(t('add.saveFail'), 'error');
    }).then(function () { saveNoTryonBtn.disabled = false; });
  }

  // A failed extraction is recorded on the product (unless it already has a
  // working asset), so the shop and the admin can see what needs attention.
  function recordExtractionFailure(res) {
    var p = addTarget.product;
    if (!p || addTarget.kind !== 'product' || !currentUser) return;
    if (p.tryOn && (p.tryOn.status === 'ready' || p.tryOn.status === 'failed')) return;
    backend.saveProduct(p, { tryOn: { status: 'failed', error: String(res.code || 'noFrame').slice(0, 60), updatedAt: backend.serverTime() } }, addTarget.shopStatus)
      .then(function (written) { addTarget.product = written; pendingProducts[p.id] = { product: written, shopStatus: addTarget.shopStatus }; })
      .catch(function (e) { console.warn('Could not record the failed extraction', e); });
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
    syncKiosk();
    refreshTitle();
    if (view.name === 'home') renderHome();
    if (view.name === 'shops') renderShops();
    browseTitle.textContent = sourceTitle();
    renderBrowseIntro();
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
    if (view.name === 'shortlist') renderShortlistPage();
    live.statusText = null;          // the live loop writes its status again in the new language
    // the shop's photo step
    if (pendingTags) { renderAddChips(); renderFreeTagList(); }
    syncAddTargetText();
    syncProductBar();
    if (addTarget.product) renderPhotoGuide(!pendingRawCanvas);
    if (pendingRawCanvas) renderPhotoCheck();
    frameSourcePlaceholder.textContent = addSourceText();
    if (bgRemovalMode === 'twoShot') twoShotStepLabel.textContent = t(twoShotStep === 1 ? 'add.two.step1' : 'add.two.step2');
    if (addedMsgKey) addedMsgText.textContent = t(addedMsgKey);
    if (frameCalibSectionEl.style.display !== 'none') updateFrameCalibBanner();
    if (autoReview.style.display !== 'none') renderAutoReview();
    if (modelHint && modelPreview.style.display !== 'none') modelPreviewHint.textContent = modelHint();
    // the dashboards
    if (partnerApi && view.name === 'partner') partnerApi.rerender();
    if (adminApi && view.name === 'admin') adminApi.rerender();
    if (reportDialog.open) fillReportReasons();
  }
  langBar.addEventListener('click', function (e) {
    var b = e.target.closest('.lang-btn');
    if (!b || b.getAttribute('data-lang') === getLang()) return;
    useLanguage(b.getAttribute('data-lang'), true);
  });
  useLanguage(initialLang(), false);

  // ---------- reporting a listing ----------
  var reportEntry = null;
  function fillReportReasons() {
    var chosen = reportReasons.querySelector('input:checked');
    var keep = chosen ? chosen.value : null;
    reportReasons.querySelectorAll('label').forEach(function (l) { l.parentNode.removeChild(l); });
    REPORT_REASONS.forEach(function (r) {
      var l = document.createElement('label');
      l.className = 'check-row';
      var i = document.createElement('input');
      i.type = 'radio'; i.name = 'reportReason'; i.value = r; i.checked = r === keep;
      l.appendChild(i);
      var sp = document.createElement('span'); sp.textContent = t('report.r.' + r);
      l.appendChild(sp);
      reportReasons.appendChild(l);
    });
  }
  function openReport(entry) {
    reportEntry = entry;
    reportNote.value = '';
    reportError.textContent = ''; reportError.classList.remove('show');
    fillReportReasons();
    if (reportDialog.showModal) reportDialog.showModal(); else reportDialog.setAttribute('open', '');
    var first = reportReasons.querySelector('input');
    if (first) first.focus();
  }
  reportCancel.addEventListener('click', function () { reportDialog.close(); });
  reportForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var chosen = reportReasons.querySelector('input:checked');
    if (!chosen) { reportError.textContent = t('report.pick'); reportError.classList.add('show'); return; }
    reportSend.disabled = true;
    backend.submitReport({ id: reportEntry.id, shopId: reportEntry.shopId }, chosen.value, reportNote.value.trim()).then(function () {
      reportDialog.close();
      toast(t('report.thanks'));
    }).catch(function (err) {
      console.error('Report failed', err);
      reportError.textContent = t(err && err.code === 'permission-denied' ? 'report.tooSoon' : 'report.failed');
      reportError.classList.add('show');
    }).then(function () { reportSend.disabled = false; });
  });

  // ---------- start ----------
  syncKiosk();
  restoreShortlist();
  renderRoute(parseHash(), { initial: true });
})();
