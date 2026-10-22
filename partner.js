// The shop dashboard (retail partners): sign in or create an account, apply,
// accept the partner terms, manage the shop profile and the catalogue —
// products, prices and GST, availability, photos and try-on, publishing,
// CSV import. Loaded by app.js on first visit to #/partner.
//
// Everything here goes through backend.js, and the server rules decide what
// is allowed: this page only offers what a shop may do.

import { pricingFromForm, pricingProblems, priceView, formatINR, formatRate, paiseToInput, parseRupees, COMMON_GST_RATES } from './pricing.js';
import {
  productProblems, publishBlockers, shouldBePublic, shopProblems, shopPrivateProblems, cleanShop, cleanFreeTags,
  AVAILABILITY, FRAME_TYPES, TAG_VALUES, LIMITS, isGstin
} from './validation.js';
import { cleanSize, sizeLabel } from './frame-size.js';
import { LEGAL_DOCS } from './legal/versions.js';
import { qrPanel, siteBase } from './qr.js';
import { readPackage, parsePackage, importPackage } from './photo-import.js';

var MATERIALS = ['Acetate', 'Metal', 'Stainless steel', 'Titanium', 'TR90', 'Aluminium', 'Wood', 'Mixed'];

// ---------- tiny DOM helpers ----------
function h(tag, attrs, kids) {
  var el = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v == null || v === false) return;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  });
  (kids || []).forEach(function (c) { if (c == null || c === false) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return el;
}
function field(id, label, input, hint, optional, T) {
  return h('div', { class: 'field' }, [
    h('label', { for: id }, [label, optional ? h('span', { class: 'optional', text: T('common.optional') }) : null]),
    input,
    hint ? h('p', { class: 'hint', id: id + 'Hint', text: hint }) : null,
    h('p', { class: 'field-error', id: id + 'Err', role: 'alert' })
  ]);
}
function inputEl(id, value, attrs) {
  return h('input', Object.assign({ id: id, type: 'text', value: value == null ? '' : String(value), autocomplete: 'off' }, attrs || {}));
}
function fmtDate(ms, lang) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleDateString(lang === 'en' ? 'en-IN' : lang + '-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (e) { return new Date(ms).toDateString(); }
}

export function initPartner(root, ctx) {
  var T = ctx.t, B = ctx.backend;
  var st = {
    uid: null, shop: null, priv: null, legal: null, platform: null, accepted: {}, loaded: false, loading: null,
    products: null, productsLoading: null, tab: 'products', route: null,
    filter: { q: '', status: 'all', tryon: 'all', avail: 'all', sort: 'updated' }, shown: 50, selected: {},
    editing: null, editIsNew: false, csv: null
  };

  function lang() { return ctx.getLang(); }
  function user() { return ctx.currentUser(); }

  // ---------- loading ----------
  function reset() {
    st.uid = null; st.shop = null; st.priv = null; st.accepted = {}; st.loaded = false; st.loading = null;
    st.products = null; st.productsLoading = null; st.selected = {}; st.editing = null; st.csv = null; st.acting = false;
  }
  // The admin can manage any shop's frames from this same dashboard (Admin →
  // Shops → Manage frames). st.uid is then that shop's id; the server rules
  // check that the signed-in account really is the admin.
  function actingShopId() {
    var id = ctx.actingShop ? ctx.actingShop() : null;
    return id && ctx.isAdmin() ? id : null;
  }
  function loadAccount(force) {
    var u = user();
    if (!u) return Promise.resolve();
    var acting = actingShopId();
    var target = acting || u.uid;
    if (st.uid !== target) reset();
    if (st.loaded && !force) return Promise.resolve();
    if (st.loading && !force) return st.loading;
    st.uid = target;
    if (acting) {
      st.acting = true;
      st.loading = Promise.all([
        B.getConfig('legal').catch(function () { return null; }),
        B.getConfig('platform').catch(function () { return null; }),
        B.getShop(acting)
      ]).then(function (r) {
        st.legal = r[0]; st.platform = r[1]; st.shop = r[2]; st.priv = null; st.accepted = null;
        if (!st.shop) throw Object.assign(new Error('No such shop'), { code: 'not-found' });
        st.loaded = true; st.loading = null;
      }).catch(function (e) { st.loading = null; throw e; });
      return st.loading;
    }
    st.loading = Promise.all([
      B.getConfig('legal').catch(function () { return null; }),
      B.getConfig('platform').catch(function () { return null; }),
      B.getShop(u.uid).catch(function () { return null; }),
      B.getShopPrivate(u.uid).catch(function () { return null; }),
      B.myAcceptances(u.uid).catch(function () { return {}; })
    ]).then(function (r) {
      st.legal = r[0]; st.platform = r[1]; st.shop = r[2]; st.priv = r[3]; st.accepted = r[4] || {};
      st.loaded = true; st.loading = null;
    }).catch(function (e) { st.loading = null; throw e; });
    return st.loading;
  }
  function loadProducts(force) {
    if (st.products && !force) return Promise.resolve(st.products);
    if (st.productsLoading && !force) return st.productsLoading;
    st.productsLoading = Promise.all([B.loadAllMyProducts(st.uid, 5000), B.getTryOnStats(st.uid).catch(function () { return null; })]).then(function (r) {
      var list = r[0];
      st.tryons = r[1];
      st.products = list; st.productsLoading = null;
      checkIndex(list);
      return list;
    }).catch(function (e) { st.productsLoading = null; throw e; });
    return st.productsLoading;
  }
  // Once per visit: make sure the shop's catalogue index (what customers'
  // pages read first) lists exactly the frames that are public.
  var indexChecked = {};
  function checkIndex(list) {
    if (!st.shop || indexChecked[st.uid]) return;
    indexChecked[st.uid] = true;
    B.syncCatalogueIndex(st.uid, list).catch(function (e) { console.warn('Could not check the catalogue index', e); indexChecked[st.uid] = false; });
  }
  function shopStatus() { return st.shop ? st.shop.status : null; }
  function canEdit() { return st.shop && (st.shop.status === 'pending' || st.shop.status === 'approved'); }

  // ---------- page frame ----------
  function page(title, kids, opts) {
    root.innerHTML = '';
    var host = root;
    if (opts && opts.narrow) { host = h('div', { class: 'auth-wrap' }); root.appendChild(host); }
    var head = h('div', { class: 'page-head dash-head' }, [
      h('h1', { id: 'partnerTitle', text: title }),
      opts && opts.sub ? h('p', { class: 'page-count', text: opts.sub }) : null
    ]);
    host.appendChild(head);
    if (st.acting && st.shop) host.appendChild(actingBanner());
    if (opts && opts.tabs) host.appendChild(tabs());
    kids.forEach(function (k) { if (k) host.appendChild(k); });
  }
  function tabs() {
    var items = [['products', 'p.tab.products'], ['shop', 'p.tab.shop'], ['import', 'p.tab.import']];
    var nav = h('nav', { class: 'dash-tabs', 'aria-label': T('p.tabs') });
    items.forEach(function (it) {
      var on = st.tab === it[0] || (it[0] === 'products' && st.tab === 'product');
      nav.appendChild(h('a', { class: 'dash-tab' + (on ? ' active' : ''), href: ctx.hashFor({ name: 'partner', id: it[0] }), 'aria-current': on ? 'page' : null, text: T(it[1]) }));
    });
    return nav;
  }
  function loadingPage() { page(T('partner.title'), [h('p', { class: 'page-count', role: 'status', text: T('cat.loading') })]); }
  function errorPage(e) {
    console.error(e);
    page(T('partner.title'), [h('div', { class: 'message error', role: 'alert', text: T('p.loadError') }),
      h('button', { class: 'btn secondary', type: 'button', text: T('cat.error.retry'), onclick: function () { reset(); show(st.route || {}); } })]);
  }

  // ---------- routing ----------
  function show(r) {
    st.route = r || {};
    var u = user();
    if (!u) { renderSignIn(); return; }
    loadingPage();
    if (ctx.actingShop && ctx.actingShop() && !ctx.adminChecked()) { setTimeout(function () { show(r); }, 300); return; }
    loadAccount().then(function () {
      if (!st.acting) {
        if (!st.shop && !u.emailVerified) { renderVerify(); return; }
        if (!st.shop) { renderApply(); return; }
        var missing = st.legal ? B.missingAcceptances(st.accepted, st.legal) : [];
        if (missing.length) { renderAccept(missing); return; }
      }
      var id = st.route.id || 'products';
      if (id === 'product') { st.tab = 'product'; renderProduct(st.route.sub); return; }
      st.tab = id === 'shop' || id === 'import' ? id : 'products';
      if (st.tab === 'shop') renderShop();
      else if (st.tab === 'import') renderImport();
      else renderProducts();
    }).catch(errorPage);
  }

  // ---------- signing in / creating an account ----------
  function legalLinks() {
    return h('p', { class: 'fine' }, [
      T('p.auth.legal1') + ' ',
      h('a', { href: 'legal/retailer-terms.html', target: '_blank', rel: 'noopener', text: T('footer.retailerTerms') }),
      ' ' + T('common.and') + ' ',
      h('a', { href: 'legal/privacy.html', target: '_blank', rel: 'noopener', text: T('footer.privacyPolicy') }), '.'
    ]);
  }
  function authErrorKey(err) {
    var map = {
      'auth/email-already-in-use': 'auth.err.inUse', 'auth/wrong-password': 'auth.err.wrong', 'auth/invalid-credential': 'auth.err.invalid',
      'auth/invalid-login-credentials': 'auth.err.invalid', 'auth/weak-password': 'auth.err.weak', 'auth/invalid-email': 'auth.err.email',
      'auth/missing-email': 'auth.err.noEmail', 'auth/user-not-found': 'auth.err.noUser', 'auth/missing-password': 'auth.err.noPass',
      'auth/too-many-requests': 'auth.err.many', 'auth/network-request-failed': 'auth.err.network'
    };
    return map[err && err.code] || 'auth.err.other';
  }
  function renderSignIn(mode) {
    mode = mode || 'signin';
    var email = inputEl('pEmail', '', { type: 'email', autocomplete: 'email', required: true });
    var pass = inputEl('pPass', '', { type: 'password', autocomplete: mode === 'signin' ? 'current-password' : 'new-password', required: true, minlength: '8' });
    var keep = h('input', { type: 'checkbox', id: 'pKeep' });
    var err = h('p', { class: 'form-error', id: 'pAuthErr', role: 'alert' });
    function fail(key) { err.textContent = T(key); err.classList.add('show'); }
    var submit = h('button', { type: 'submit', class: 'btn primary block', text: T(mode === 'signin' ? 'auth.signIn' : 'p.auth.create') });
    var form = h('form', { class: 'auth-form', novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      err.classList.remove('show');
      if (!email.value.trim()) { fail('auth.err.noEmail'); email.focus(); return; }
      if (!pass.value) { fail('auth.err.noPass'); pass.focus(); return; }
      if (mode === 'signup' && pass.value.length < 8) { fail('p.auth.weak'); pass.focus(); return; }
      submit.disabled = true;
      var op = mode === 'signin' ? B.signIn(email.value.trim(), pass.value, keep.checked) : B.signUp(email.value.trim(), pass.value, keep.checked);
      op.then(function () { pass.value = ''; /* onAuth re-renders */ }).catch(function (e2) { fail(authErrorKey(e2)); }).then(function () { submit.disabled = false; });
    } }, [
      field('pEmail', T('auth.email'), email, null, false, T),
      field('pPass', T('auth.password'), pass, mode === 'signup' ? T('p.auth.passHint') : null, false, T),
      h('label', { class: 'check-row' }, [keep, h('span', { text: T('p.auth.keep') })]),
      h('p', { class: 'hint', text: T('p.auth.keepHint') }),
      err, submit
    ]);
    var alt = mode === 'signin'
      ? h('p', { class: 'auth-alt' }, [T('p.auth.newShop') + ' ', h('button', { type: 'button', class: 'link-btn', text: T('p.auth.createLink'), onclick: function () { renderSignIn('signup'); } })])
      : h('p', { class: 'auth-alt' }, [T('p.auth.haveAccount') + ' ', h('button', { type: 'button', class: 'link-btn', text: T('auth.signIn'), onclick: function () { renderSignIn('signin'); } })]);
    var forgot = mode === 'signin' ? h('p', { class: 'auth-alt' }, [h('button', { type: 'button', class: 'link-btn', text: T('p.auth.forgot'), onclick: function () {
      if (!email.value.trim()) { fail('p.auth.forgotEmail'); email.focus(); return; }
      B.resetPassword(email.value.trim()).then(function () { ctx.toast(T('p.auth.resetSent')); }).catch(function (e2) { fail(authErrorKey(e2)); });
    } })]) : null;
    page(T(mode === 'signin' ? 'p.auth.title' : 'p.auth.createTitle'), [
      h('p', { class: 'lede', text: T(mode === 'signin' ? 'p.auth.lede' : 'p.auth.createLede') }),
      form, alt, forgot, legalLinks(),
      h('p', { class: 'fine', text: T('p.auth.customersNote') })
    ], { narrow: true });
  }

  function renderVerify() {
    var u = user();
    var msg = h('p', { class: 'hint', role: 'status' });
    page(T('p.verify.title'), [h('div', null, [
      h('p', { class: 'lede', text: T('p.verify.text', { email: u.email }) }),
      h('div', { class: 'row' }, [
        h('button', { type: 'button', class: 'btn primary', text: T('p.verify.done'), onclick: function () {
          B.refreshUser().then(function (nu) {
            if (nu && nu.emailVerified) { reset(); show(st.route); }
            else msg.textContent = T('p.verify.notYet');
          });
        } }),
        h('button', { type: 'button', class: 'btn secondary', text: T('p.verify.resend'), onclick: function () {
          B.resendVerification().then(function () { msg.textContent = T('p.verify.sent'); }).catch(function () { msg.textContent = T('auth.err.many'); });
        } })
      ]),
      msg
    ])], { narrow: true });
  }

  // ---------- applying ----------
  function shopFields(shop, priv, opts) {
    shop = shop || {}; priv = priv || {};
    var wrap = h('div', { class: 'form-grid' });
    function add(id, key, label, value, attrs, hint, optional) {
      var el = attrs && attrs.textarea ? h('textarea', { id: id, rows: '3', maxlength: attrs.maxlength }, [value || '']) : inputEl(id, value, attrs);
      wrap.appendChild(field(id, label, el, hint, optional, T));
    }
    var pub = h('fieldset', { class: 'form-section' }, [h('legend', { text: T('p.shop.public') }), h('p', { class: 'hint', text: T('p.shop.publicHint') })]);
    var g1 = h('div', { class: 'form-grid' });
    [['sName', 'name', 'p.shop.name', shop.name, { maxlength: '80', required: true }],
     ['sCity', 'city', 'p.shop.city', shop.city, { maxlength: '60', required: true }],
     ['sAddress', 'address', 'p.shop.address', shop.address, { maxlength: '200' }, null, true],
     ['sPhone', 'phone', 'p.shop.phone', shop.phone, { type: 'tel', maxlength: '20', inputmode: 'tel' }, null, true],
     ['sWhatsapp', 'whatsapp', 'p.shop.whatsapp', shop.whatsapp, { type: 'tel', maxlength: '20', inputmode: 'tel' }, T('p.shop.whatsappHint'), true],
     ['sEmail', 'email', 'p.shop.email', shop.email, { type: 'email', maxlength: '100' }, null, true],
     ['sWebsite', 'website', 'p.shop.website', shop.website, { type: 'url', maxlength: '300', placeholder: 'https://' }, null, true]
    ].forEach(function (f) { g1.appendChild(field(f[0], T(f[2]), inputEl(f[0], f[3], f[4]), f[5], f[6], T)); });
    g1.appendChild(field('sAbout', T('p.shop.about'), h('textarea', { id: 'sAbout', rows: '3', maxlength: '500' }, [shop.about || '']), null, true, T));
    pub.appendChild(g1);
    var prv = h('fieldset', { class: 'form-section' }, [h('legend', { text: T('p.shop.private') }), h('p', { class: 'hint', text: T('p.shop.privateHint') })]);
    var g2 = h('div', { class: 'form-grid' });
    g2.appendChild(field('sOwner', T('p.shop.owner'), inputEl('sOwner', priv.ownerName, { maxlength: '80', autocomplete: 'name' }), null, false, T));
    g2.appendChild(field('sOwnerPhone', T('p.shop.ownerPhone'), inputEl('sOwnerPhone', priv.ownerPhone, { type: 'tel', maxlength: '20' }), null, true, T));
    g2.appendChild(field('sGstin', T('p.shop.gstin'), inputEl('sGstin', priv.gstin, { maxlength: '15', autocapitalize: 'characters' }), T('p.shop.gstinHint'), true, T));
    if (opts && opts.note) g2.appendChild(field('sNote', T('p.shop.note'), h('textarea', { id: 'sNote', rows: '3', maxlength: '500' }, [priv.note || '']), T('p.shop.noteHint'), true, T));
    prv.appendChild(g2);
    void add;
    return h('div', null, [pub, prv]);
  }
  function readShop() {
    function v(id) { var el = document.getElementById(id); return el ? el.value : ''; }
    var profile = cleanShop({ name: v('sName'), city: v('sCity'), address: v('sAddress'), phone: v('sPhone'), whatsapp: v('sWhatsapp'), email: v('sEmail'), website: v('sWebsite'), about: v('sAbout') });
    var priv = { ownerName: v('sOwner').trim(), ownerPhone: v('sOwnerPhone').trim(), gstin: v('sGstin').trim().toUpperCase() };
    if (document.getElementById('sNote')) priv.note = v('sNote').trim();
    return { profile: profile, priv: priv };
  }
  var SHOP_FIELD_IDS = { name: 'sName', city: 'sCity', address: 'sAddress', phone: 'sPhone', whatsapp: 'sWhatsapp', email: 'sEmail', website: 'sWebsite', about: 'sAbout', ownerName: 'sOwner', ownerPhone: 'sOwnerPhone', gstin: 'sGstin', note: 'sNote' };
  function showFieldErrors(problems, ids) {
    root.querySelectorAll('.field-error').forEach(function (e) { e.textContent = ''; });
    root.querySelectorAll('[aria-invalid]').forEach(function (e) { e.removeAttribute('aria-invalid'); });
    var first = null;
    problems.forEach(function (p) {
      var id = ids[p.field]; if (!id) return;
      var el = document.getElementById(id), er = document.getElementById(id + 'Err');
      if (er) er.textContent = T(p.code);
      if (el) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', id + 'Err'); if (!first) first = el; }
    });
    if (first) first.focus();
    return problems.length > 0;
  }
  function stripEmpty(o) { var out = {}; Object.keys(o).forEach(function (k) { if (o[k] !== '' && o[k] != null) out[k] = o[k]; }); return out; }

  function legalCheckboxes() {
    var L = st.legal;
    var a = h('input', { type: 'checkbox', id: 'accTerms' }), b = h('input', { type: 'checkbox', id: 'accPrivacy' });
    var box = h('fieldset', { class: 'form-section legal-accept' }, [
      h('legend', { text: T('p.apply.legal') }),
      h('label', { class: 'check-row' }, [a, h('span', null, [T('p.apply.acceptTerms') + ' ', h('a', { href: 'legal/retailer-terms.html', target: '_blank', rel: 'noopener', text: T('footer.retailerTerms') + ' (' + T('legal.version', { v: L.retailerTerms.version }) + ')' })])]),
      h('label', { class: 'check-row' }, [b, h('span', null, [T('p.apply.acceptPrivacy') + ' ', h('a', { href: 'legal/privacy.html', target: '_blank', rel: 'noopener', text: T('footer.privacyPolicy') + ' (' + T('legal.version', { v: L.privacy.version }) + ')' })])]),
      h('p', { class: 'hint', text: T('p.apply.legalHint') })
    ]);
    box.ok = function () { return a.checked && b.checked; };
    return box;
  }
  function legalReady() {
    var L = st.legal;
    if (!L || !L.retailerTerms || !L.privacy) return false;
    // the version the platform requires must be the one this site shows
    return L.retailerTerms.version === LEGAL_DOCS.retailerTerms.version && L.privacy.version === LEGAL_DOCS.privacy.version;
  }

  function renderApply() {
    if (!legalReady()) { page(T('p.apply.title'), [h('div', { class: 'message', role: 'status', text: T('p.apply.notReady') })]); return; }
    if (st.platform && st.platform.applicationsOpen === false) { page(T('p.apply.title'), [h('div', { class: 'message', role: 'status', text: T('p.apply.closed') })]); return; }
    var legal = legalCheckboxes();
    var err = h('p', { class: 'form-error', role: 'alert' });
    var btn = h('button', { type: 'submit', class: 'btn primary', text: T('p.apply.submit') });
    var form = h('form', { novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      err.classList.remove('show');
      var v = readShop();
      var probs = shopProblems(v.profile).concat(shopPrivateProblems(v.priv));
      if (showFieldErrors(probs, SHOP_FIELD_IDS)) return;
      if (!legal.ok()) { err.textContent = T('p.apply.mustAccept'); err.classList.add('show'); return; }
      btn.disabled = true;
      B.applyForShop(st.uid, v.profile, stripEmpty(v.priv), st.legal, st.accepted).then(function () {
        ctx.toast(T('p.apply.sent'));
        reset(); show({});
      }).catch(function (e2) {
        console.error(e2);
        err.textContent = T(e2 && e2.code === 'permission-denied' ? 'p.apply.denied' : 'p.saveFailed');
        err.classList.add('show');
      }).then(function () { btn.disabled = false; });
    } }, [shopFields(null, null, { note: true }), legal, err, h('div', { class: 'row' }, [btn])]);
    page(T('p.apply.title'), [h('p', { class: 'lede', text: T('p.apply.lede') }), form]);
  }

  // ---------- accepting updated terms ----------
  function renderAccept(missing) {
    var legal = legalCheckboxes();
    var err = h('p', { class: 'form-error', role: 'alert' });
    page(T('p.accept.title'), [
      h('p', { class: 'lede', text: T('p.accept.text') }),
      legal, err,
      h('div', { class: 'row' }, [h('button', { type: 'button', class: 'btn primary', text: T('p.accept.btn'), onclick: function () {
        if (!legalReady()) { err.textContent = T('p.apply.notReady'); err.classList.add('show'); return; }
        if (!legal.ok()) { err.textContent = T('p.apply.mustAccept'); err.classList.add('show'); return; }
        B.acceptDocuments(st.uid, missing, st.legal).then(function () { reset(); show(st.route); }).catch(function (e) { console.error(e); err.textContent = T('p.saveFailed'); err.classList.add('show'); });
      } })])
    ]);
  }

  // ---------- status banner ----------
  function actingBanner() {
    return h('div', { class: 'notice acting-banner', role: 'status' }, [
      h('strong', { text: T('p.acting.title', { shop: st.shop.name }) + ' ' }), T('p.acting.text') + ' ',
      h('button', { type: 'button', class: 'btn secondary small', text: T('p.acting.stop'), onclick: function () {
        ctx.setActingShop(null); reset(); ctx.navigate({ name: 'admin', id: 'shops' });
      } })
    ]);
  }
  function statusBanner() {
    var s = st.shop;
    if (!s) return null;
    if (s.status === 'approved') return null;
    var cls = s.status === 'pending' ? 'notice' : 'message error';
    var kids = [h('strong', { text: T('p.status.' + s.status) + ' ' }), T('p.status.' + s.status + 'Text')];
    if (s.statusReason) kids.push(h('span', { class: 'status-reason', text: ' ' + T('p.status.reason', { reason: s.statusReason }) }));
    return h('div', { class: cls + ' status-banner', role: 'status' }, kids);
  }

  // ---------- products ----------
  function productState(p) {
    if (p.moderation && p.moderation.state === 'suspended') return { key: 'suspended', cls: 'bad' };
    if (p.public) return { key: 'live', cls: 'ok' };
    if (p.status === 'archived') return { key: 'archived', cls: 'muted' };
    if (p.status === 'published') return { key: shopStatus() === 'approved' ? 'incomplete' : 'waitingApproval', cls: 'warn' };
    return { key: 'draft', cls: 'muted' };
  }
  function triedOn(p) { return (st.tryons && st.tryons.frames && st.tryons.frames[p.id]) || 0; }
  function tryOnLabel(p) {
    var s = (p.tryOn && p.tryOn.status) || 'none';
    var hasPhoto = p.images && p.images.thumb;
    if (s === 'none' && !hasPhoto) return T('p.tryon.noPhoto');
    return T('p.tryon.' + s);
  }
  function payText(p) {
    var v = p.pricing ? priceView(p.pricing) : null;
    return v ? formatINR(v.pay.finalPaise, lang()) : '—';
  }
  function searchHay(p) {
    var tg = p.tags || {};
    return [p.name, p.sku, p.brand, p.colourName, p.material, tg.shape, tg.color, tg.rim, tg.gender].concat(tg.free || []).filter(Boolean).join(' ').toLowerCase();
  }
  function filtered() {
    var f = st.filter, q = f.q.trim().toLowerCase();
    var list = (st.products || []).filter(function (p) {
      if (f.status !== 'all') {
        var ps = productState(p).key;
        if (f.status === 'live' ? ps !== 'live' : f.status === 'notLive' ? ps === 'live' : p.status !== f.status) return false;
      }
      if (f.tryon !== 'all' && ((p.tryOn && p.tryOn.status) || 'none') !== f.tryon) return false;
      if (f.avail !== 'all' && p.availability !== f.avail) return false;
      if (q && q.split(/\s+/).some(function (w) { return searchHay(p).indexOf(w) === -1; })) return false;
      return true;
    });
    var by = f.sort;
    list.sort(function (a, b) {
      if (by === 'name') return (a.name || '').localeCompare(b.name || '');
      if (by === 'tryons') return triedOn(b) - triedOn(a);
      if (by === 'price') { var x = a.pricing ? priceView(a.pricing) : null, y = b.pricing ? priceView(b.pricing) : null; return (x ? x.pay.finalPaise : Infinity) - (y ? y.pay.finalPaise : Infinity); }
      return (b.updatedMs || 0) - (a.updatedMs || 0);
    });
    return list;
  }

  function renderProducts() {
    page(st.shop.name, [statusBanner(), h('p', { class: 'page-count', role: 'status', text: T('cat.loading') })], { tabs: true, sub: T('p.dashboard') });
    // (only if the products page is still the one showing when they arrive)
    loadProducts().then(function () { if (st.tab === 'products') drawProducts(); }).catch(function (e) { if (st.tab === 'products') errorPage(e); });
  }

  function selectEl(id, options, value, onchange, label) {
    var s = h('select', { id: id, onchange: onchange, 'aria-label': label });
    options.forEach(function (o) { s.appendChild(h('option', { value: o[0], selected: o[0] === value ? true : null, text: o[1] })); });
    return s;
  }

  function drawProducts() {
    var list = filtered();
    var total = (st.products || []).length;
    var counts = { live: 0, draft: 0, issues: 0 };
    (st.products || []).forEach(function (p) {
      var k = productState(p).key;
      if (k === 'live') counts.live++; else if (k === 'draft') counts.draft++;
      if (p.tryOn && p.tryOn.status === 'failed') counts.issues++;
    });
    var max = st.platform && st.platform.maxProductsPerShop;
    var addBtn = h('button', { type: 'button', class: 'btn primary', text: T('p.products.add'), disabled: !canEdit() || (max && total >= max) ? true : null,
      onclick: function () { ctx.navigate({ name: 'partner', id: 'product', sub: 'new' }); } });
    var summary = h('p', { class: 'dash-summary' }, [T('p.products.summary', { total: total, live: counts.live, draft: counts.draft }),
      counts.issues ? h('span', { class: 'issue-count', text: ' ' + T('p.products.issues', { n: counts.issues }) }) : null,
      st.tryons ? h('span', { class: 'tryon-count', text: ' · ' + T('p.tryons.summary', { today: st.tryons.today, d30: st.tryons.last30, total: st.tryons.total }) }) : null]);
    var search = inputEl('pSearch', st.filter.q, { type: 'search', placeholder: T('p.products.search'), 'aria-label': T('p.products.search') });
    search.addEventListener('input', function () { st.filter.q = search.value; st.shown = 50; redrawList(); });
    var tools = h('div', { class: 'dash-tools' }, [
      h('div', { class: 'search-field compact' }, [search]),
      selectEl('pFStatus', [['all', T('p.f.allStatus')], ['live', T('p.state.live')], ['notLive', T('p.f.notLive')], ['draft', T('p.state.draft')], ['published', T('p.f.published')], ['archived', T('p.state.archived')]], st.filter.status, function (e) { st.filter.status = e.target.value; redrawList(); }, T('p.f.status')),
      selectEl('pFTry', [['all', T('p.f.allTryon')], ['ready', T('p.tryon.ready')], ['none', T('p.tryon.none')], ['failed', T('p.tryon.failed')], ['pending', T('p.tryon.pending')]], st.filter.tryon, function (e) { st.filter.tryon = e.target.value; redrawList(); }, T('p.f.tryon')),
      selectEl('pFAvail', [['all', T('p.f.allAvail')]].concat(AVAILABILITY.map(function (a) { return [a, T('avail.' + a)]; })), st.filter.avail, function (e) { st.filter.avail = e.target.value; redrawList(); }, T('p.f.avail')),
      selectEl('pFSort', [['updated', T('p.sort.updated')], ['name', T('p.sort.name')], ['price', T('p.sort.price')], ['tryons', T('p.sort.tryons')]], st.filter.sort, function (e) { st.filter.sort = e.target.value; redrawList(); }, T('cat.sort'))
    ]);
    var listWrap = h('div', { id: 'pList' });
    page(st.shop.name, [statusBanner(), h('div', { class: 'dash-bar' }, [summary, addBtn]), tools, bulkBar(), listWrap], { tabs: true, sub: T('p.dashboard') });
    redrawList();
  }

  function bulkBar() {
    var n = Object.keys(st.selected).length;
    var bar = h('div', { class: 'bulk-actions', id: 'pBulk', hidden: n ? null : true });
    bar.appendChild(h('span', { class: 'bulk-count', text: T('p.bulk.selected', { n: n }) }));
    [['publish', 'p.bulk.publish'], ['draft', 'p.bulk.draft'], ['archive', 'p.bulk.archive'], ['confirmTax', 'p.bulk.confirmTax'], ['delete', 'p.bulk.delete']].forEach(function (a) {
      bar.appendChild(h('button', { type: 'button', class: 'btn small ' + (a[0] === 'delete' ? 'danger' : 'secondary'), text: T(a[1]), disabled: canEdit() || a[0] === 'delete' ? null : true, onclick: function () { bulk(a[0]); } }));
    });
    var av = selectEl('pBulkAvail', [['', T('p.bulk.setAvail')]].concat(AVAILABILITY.map(function (x) { return [x, T('avail.' + x)]; })), '', function (e) { if (e.target.value) bulk('avail', e.target.value); }, T('p.bulk.setAvail'));
    if (!canEdit()) av.disabled = true;
    bar.appendChild(av);
    bar.appendChild(h('button', { type: 'button', class: 'link-btn', text: T('p.bulk.clear'), onclick: function () { st.selected = {}; redrawList(); } }));
    return bar;
  }

  function redrawList() {
    var wrap = document.getElementById('pList');
    if (!wrap) return;
    var old = document.getElementById('pBulk');
    if (old) old.parentNode.replaceChild(bulkBar(), old);
    wrap.innerHTML = '';
    var list = filtered();
    if (!(st.products || []).length) {
      wrap.appendChild(h('div', { class: 'empty-state' }, [
        h('h2', { text: T('p.products.emptyTitle') }), h('p', { text: T('p.products.emptyText') }),
        h('div', { class: 'row center' }, [
          h('a', { class: 'btn primary', href: ctx.hashFor({ name: 'partner', id: 'product', sub: 'new' }), text: T('p.products.add') }),
          h('a', { class: 'btn secondary', href: ctx.hashFor({ name: 'partner', id: 'import' }), text: T('p.tab.import') })
        ])
      ]));
      return;
    }
    if (!list.length) { wrap.appendChild(h('p', { class: 'hint', text: T('p.products.noMatch') })); return; }
    var table = h('table', { class: 'dash-table' });
    var all = h('input', { type: 'checkbox', 'aria-label': T('p.bulk.selectAll'), onchange: function (e) {
      list.slice(0, st.shown).forEach(function (p) { if (e.target.checked) st.selected[p.id] = true; else delete st.selected[p.id]; });
      redrawList();
    } });
    all.checked = list.slice(0, st.shown).every(function (p) { return st.selected[p.id]; });
    table.appendChild(h('thead', null, [h('tr', null, [
      h('th', { scope: 'col', class: 'col-check' }, [all]), h('th', { scope: 'col', text: T('p.col.frame') }), h('th', { scope: 'col', text: T('p.col.price') }),
      h('th', { scope: 'col', text: T('p.col.state') }), h('th', { scope: 'col', text: T('p.col.tryon') }), h('th', { scope: 'col', text: T('p.col.avail') }), h('th', { scope: 'col', class: 'visually-hidden', text: T('p.col.actions') })
    ])]));
    var tb = h('tbody');
    list.slice(0, st.shown).forEach(function (p) {
      var stt = productState(p);
      var cb = h('input', { type: 'checkbox', 'aria-label': T('p.bulk.selectOne', { name: p.name || T('partner.untitled') }), onchange: function (e) { if (e.target.checked) st.selected[p.id] = true; else delete st.selected[p.id]; var b = document.getElementById('pBulk'); if (b) b.parentNode.replaceChild(bulkBar(), b); } });
      cb.checked = !!st.selected[p.id];
      var thumb = p.images && B.imgSrc(p.images.thumb) ? h('img', { src: B.imgSrc(p.images.thumb), alt: '', loading: 'lazy', width: '64', height: '64' }) : h('span', { class: 'no-thumb', 'aria-hidden': 'true' });
      tb.appendChild(h('tr', null, [
        h('td', { class: 'col-check' }, [cb]),
        h('td', null, [h('a', { class: 'dash-frame', href: ctx.hashFor({ name: 'partner', id: 'product', sub: p.id }) }, [thumb, h('span', null, [h('strong', { text: p.name || T('partner.untitled') }), p.sku ? h('span', { class: 'mono muted', text: ' ' + p.sku }) : null])])]),
        h('td', { class: 'mono', text: payText(p) }),
        h('td', null, [h('span', { class: 'pill ' + stt.cls, text: T('p.state.' + stt.key) })]),
        h('td', null, [tryOnLabel(p), triedOn(p) ? h('span', { class: 'hint block', text: T('p.tryons.frame', { n: triedOn(p) }) }) : null]),
        h('td', { text: p.availability ? T('avail.' + p.availability) : '—' }),
        h('td', null, [h('a', { class: 'btn secondary small', href: ctx.hashFor({ name: 'partner', id: 'product', sub: p.id }), text: T('p.edit'), 'aria-label': T('p.editAria', { name: p.name || T('partner.untitled') }) })])
      ]));
    });
    table.appendChild(tb);
    wrap.appendChild(h('div', { class: 'table-wrap' }, [table]));
    if (list.length > st.shown) wrap.appendChild(h('button', { type: 'button', class: 'btn secondary', text: T('p.products.more', { n: list.length - st.shown }), onclick: function () { st.shown += 100; redrawList(); } }));
  }

  function bulk(action, value) {
    var ids = Object.keys(st.selected);
    var items = (st.products || []).filter(function (p) { return ids.indexOf(p.id) !== -1; });
    if (!items.length) return;
    var go = Promise.resolve(true);
    if (action === 'delete') go = ctx.confirmAction({ title: T('p.bulk.deleteTitle', { n: items.length }), body: T('p.bulk.deleteBody'), ok: T('p.bulk.delete'), cancel: T('common.cancel'), danger: true });
    if (action === 'confirmTax') go = ctx.confirmAction({ title: T('p.bulk.confirmTaxTitle', { n: items.length }), body: [T('p.bulk.confirmTaxBody'), T('p.price.responsibility')], ok: T('p.bulk.confirmTax'), cancel: T('common.cancel') });
    go.then(function (yes) {
      if (!yes) return;
      var ok = 0, skipped = 0, failed = 0;
      return items.reduce(function (chain, p) {
        return chain.then(function () {
          var ch = null;
          if (action === 'publish') ch = publishBlockers(p).length ? null : { status: 'published' };
          else if (action === 'draft') ch = { status: 'draft' };
          else if (action === 'archive') ch = { status: 'archived' };
          else if (action === 'avail') ch = { availability: value };
          else if (action === 'confirmTax') ch = p.pricing && !pricingProblems(p.pricing, false).length ? { pricing: Object.assign({}, stripStamp(p.pricing), { confirmed: true }) } : null;
          if (action === 'delete') return B.deleteProduct(p).then(function () { ok++; ctx.forgetProduct(p.id); st.products = st.products.filter(function (x) { return x.id !== p.id; }); delete st.selected[p.id]; }).catch(function () { failed++; });
          if (!ch) { skipped++; return; }
          return B.saveProduct(p, ch, shopStatus()).then(function (w) { ok++; replaceProduct(w); }).catch(function (e) { console.error(e); failed++; });
        });
      }, Promise.resolve()).then(function () {
        ctx.toast(T('p.bulk.done', { ok: ok, skipped: skipped, failed: failed }), failed ? 'error' : null);
        drawProducts();
      });
    });
  }
  function stripStamp(pr) { var o = Object.assign({}, pr); delete o.updatedAt; return o; }
  function replaceProduct(w) {
    if (!st.products) return;
    var i = st.products.findIndex(function (x) { return x.id === w.id; });
    w.updatedMs = Date.now();
    if (i >= 0) st.products[i] = w; else st.products.unshift(w);
  }

  // ---------- one product: details, photo and try-on, price and GST, publishing ----------
  function renderProduct(id) {
    if (id === 'new') {
      if (!canEdit()) { ctx.navigate({ name: 'partner', id: 'products' }, { replace: true }); return; }
      st.editing = { id: B.newProductId(), shopId: st.uid, name: '', status: 'draft', moderation: { state: 'ok' }, tryOn: { status: 'none' }, tags: { shape: null, color: null, gender: null, rim: null, free: [] } };
      st.editIsNew = true;
      drawProduct();
      return;
    }
    var known = st.products && st.products.find(function (x) { return x.id === id; });
    var load = B.getProduct(id);
    if (known) { st.editing = known; st.editIsNew = false; drawProduct(); }
    load.then(function (p) {
      if (!p || p.shopId !== st.uid) { page(T('p.product.missing'), [h('a', { class: 'btn secondary', href: ctx.hashFor({ name: 'partner', id: 'products' }), text: T('p.backToList') })], { tabs: true }); return; }
      replaceProduct(p);
      if (st.route.id === 'product' && st.route.sub === id && (!known || (p.updatedMs || 0) !== (known.updatedMs || 0))) { st.editing = p; st.editIsNew = false; drawProduct(); }
    }).catch(errorPage);
  }

  function chips(facet, value, onchange) {
    var row = h('div', { class: 'chip-row', role: 'group', 'aria-label': T('facet.' + facet) });
    (ctx.FACETS[facet] ? ctx.FACETS[facet].options : TAG_VALUES[facet]).forEach(function (v) {
      var b = h('button', { type: 'button', class: 'tag-chip' + (value === v ? ' active' : ''), 'aria-pressed': value === v ? 'true' : 'false', text: ctx.tagLabel(v) });
      b.addEventListener('click', function () {
        var on = b.classList.contains('active');
        row.querySelectorAll('.tag-chip').forEach(function (c) { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
        if (!on) { b.classList.add('active'); b.setAttribute('aria-pressed', 'true'); }
        onchange(on ? null : v);
      });
      row.appendChild(b);
    });
    return row;
  }

  var PFIELDS = { name: 'fName', sku: 'fSku', brand: 'fBrand', colourName: 'fColourName', material: 'fMaterial', description: 'fDesc', link: 'fLink', size: 'fEye', pricing: 'fPrice', frameType: 'fType', availability: 'fAvail' };

  function drawProduct() {
    var p = st.editing, locked = !canEdit() || (p.moderation && p.moderation.state === 'suspended');
    var tags = Object.assign({ shape: null, color: null, gender: null, rim: null, free: [] }, p.tags || {});
    var free = (tags.free || []).slice();
    var pr = p.pricing || {};
    var form = h('form', { class: 'product-form', novalidate: true, onsubmit: function (e) { e.preventDefault(); save(false); } });

    // 1. details
    var s1 = h('fieldset', { class: 'form-section', disabled: locked ? true : null }, [h('legend', { text: '1. ' + T('p.step.details') })]);
    var g = h('div', { class: 'form-grid' });
    g.appendChild(field('fName', T('p.f.name'), inputEl('fName', p.name, { maxlength: String(LIMITS.name) }), T('p.f.nameHint'), false, T));
    g.appendChild(field('fSku', T('p.f.sku'), inputEl('fSku', p.sku, { maxlength: String(LIMITS.sku) }), T('p.f.skuHint'), true, T));
    g.appendChild(field('fBrand', T('p.f.brand'), inputEl('fBrand', p.brand, { maxlength: String(LIMITS.brand) }), null, true, T));
    g.appendChild(field('fType', T('attr.type'), selectEl('fType', [['', T('p.f.choose')]].concat(FRAME_TYPES.map(function (x) { return [x, T('ftype.' + x)]; })), p.frameType || '', null, T('attr.type')), null, true, T));
    var mat = inputEl('fMaterial', p.material, { maxlength: String(LIMITS.material), list: 'fMaterialList' });
    g.appendChild(field('fMaterial', T('attr.material'), mat, null, true, T));
    g.appendChild(h('datalist', { id: 'fMaterialList' }, MATERIALS.map(function (m) { return h('option', { value: m }); })));
    g.appendChild(field('fColourName', T('p.f.colourName'), inputEl('fColourName', p.colourName, { maxlength: String(LIMITS.colourName), placeholder: T('p.f.colourNamePh') }), null, true, T));
    s1.appendChild(g);
    [['shape', 'facet.shape'], ['color', 'facet.color'], ['gender', 'facet.gender'], ['rim', 'facet.rim']].forEach(function (f) {
      s1.appendChild(h('div', { class: 'field-label' }, [T(f[1]) + ' ', h('span', { class: 'optional', text: T('common.optional') })]));
      s1.appendChild(chips(f[0], tags[f[0]], function (v) { tags[f[0]] = v; }));
    });
    var size = cleanSize(p.size) || {};
    s1.appendChild(h('fieldset', { class: 'size-set' }, [
      h('legend', null, [T('edit.sizeLegend') + ' ', h('span', { class: 'optional', text: T('add.sizeHint') })]),
      h('div', { class: 'size-row' }, [
        h('label', null, [T('size.input.eye'), inputEl('fEye', size.eye, { type: 'number', min: '30', max: '75', step: '0.5', inputmode: 'decimal', placeholder: '52' })]),
        h('label', null, [T('size.input.bridge'), inputEl('fBridge', size.bridge, { type: 'number', min: '10', max: '30', step: '0.5', inputmode: 'decimal', placeholder: '18' })]),
        h('label', null, [T('size.input.temple'), inputEl('fTemple', size.temple, { type: 'number', min: '100', max: '170', step: '1', inputmode: 'numeric', placeholder: '140' })])
      ]),
      h('p', { class: 'field-error', id: 'fEyeErr', role: 'alert' })
    ]));
    s1.appendChild(h('p', { class: 'hint', text: T('p.f.sizeNote') }));
    s1.appendChild(field('fDesc', T('p.f.desc'), h('textarea', { id: 'fDesc', rows: '3', maxlength: String(LIMITS.description) }, [p.description || '']), null, true, T));
    var freeInput = inputEl('fFree', '', { maxlength: '30' });
    var freeList = h('div', { class: 'tag-chip-list' });
    function drawFree() {
      freeList.innerHTML = '';
      free.forEach(function (tg, i) {
        freeList.appendChild(h('span', { class: 'tag-chip removable' }, [tg, h('button', { type: 'button', class: 'chip-x', 'aria-label': T('edit.removeTag', { tag: tg }), text: '×', onclick: function () { free.splice(i, 1); drawFree(); } })]));
      });
    }
    freeInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      free = cleanFreeTags(free.concat([freeInput.value]));
      freeInput.value = '';
      drawFree();
    });
    drawFree();
    s1.appendChild(field('fFree', T('edit.otherTags'), freeInput, T('add.otherHint'), true, T));
    s1.appendChild(freeList);
    s1.appendChild(field('fLink', T('p.f.link'), inputEl('fLink', p.link, { type: 'url', maxlength: '300', placeholder: 'https://' }), T('p.f.linkHint'), true, T));
    form.appendChild(s1);

    // 2. photo and try-on
    var s2 = h('fieldset', { class: 'form-section', disabled: locked ? true : null }, [h('legend', { text: '2. ' + T('p.step.photo') })]);
    var im = p.images || {}, tr = p.tryOn || {};
    var media = h('div', { class: 'photo-status' });
    if (im.thumb && im.thumb.url) media.appendChild(h('img', { src: im.thumb.url, alt: '', width: '140', height: '140' }));
    else media.appendChild(h('span', { class: 'no-thumb big', 'aria-hidden': 'true' }));
    var stText = h('div', null, [
      h('p', null, [h('strong', { text: tryOnLabel(p) })]),
      h('p', { class: 'hint', text: T('p.tryon.' + ((tr.status || 'none') === 'none' && !im.thumb ? 'noPhoto' : (tr.status || 'none')) + 'Text') }),
      tr.status === 'ready' ? h('p', { class: 'hint', text: T('p.tryon.detail', { level: T(tr.level === '2d' ? 'prep.2d' : 'prep.3d'), quality: tr.quality != null ? Math.round(tr.quality * 100) + '%' : '—' }) + (tr.hasSide ? ' ' + T('p.tryon.withTemple') : '') }) : null,
      tr.status === 'failed' && tr.error ? h('p', { class: 'hint', text: T('p.tryon.errorCode', { code: T('fx.fail.' + tr.error) === 'fx.fail.' + tr.error ? tr.error : T('fx.fail.' + tr.error) }) }) : null
    ]);
    media.appendChild(stText);
    s2.appendChild(media);
    var photoRow = h('div', { class: 'row' });
    photoRow.appendChild(h('button', { type: 'button', class: 'btn primary', text: T(im.thumb ? 'p.photo.replace' : 'p.photo.add'), onclick: function () { saveThen(function (w) { ctx.openPhotoStep(w, shopStatus(), 'front'); }); } }));
    if (tr.status === 'ready') photoRow.appendChild(h('button', { type: 'button', class: 'btn secondary', text: T(tr.hasSide ? 'p.photo.replaceTemple' : 'p.photo.addTemple'), onclick: function () { saveThen(function (w) { ctx.openPhotoStep(w, shopStatus(), 'side'); }); } }));
    if (im.thumb && tr.status !== 'none') photoRow.appendChild(h('button', { type: 'button', class: 'btn secondary', text: T('p.photo.noTryon'), onclick: function () {
      ctx.confirmAction({ title: T('p.photo.noTryonTitle'), body: T('p.photo.noTryonBody'), ok: T('p.photo.noTryon'), cancel: T('common.cancel') }).then(function (yes) {
        if (!yes) return;
        var images = Object.assign({}, im);
        var drop = ['cutout', 'manifest', 'side'].map(function (k) { return images[k]; }).filter(Boolean);
        delete images.cutout; delete images.manifest; delete images.side;
        save(false, { images: images, tryOn: { status: 'none', updatedAt: B.serverTime() } }, function () { B.deleteFiles(drop); });
      });
    } }));
    s2.appendChild(photoRow);
    s2.appendChild(h('p', { class: 'hint', text: T('p.photo.hint') }));
    form.appendChild(s2);

    // 3. price and GST
    var s3 = h('fieldset', { class: 'form-section', disabled: locked ? true : null }, [h('legend', { text: '3. ' + T('p.step.price') })]);
    var price = inputEl('fPrice', pr.pricePaise != null ? paiseToInput(pr.pricePaise) : '', { inputmode: 'decimal', placeholder: '2499' });
    var priceWrap = h('div', { class: 'money' }, [h('span', { class: 'money-sym', 'aria-hidden': 'true', text: '₹' }), price]);
    s3.appendChild(field('fPrice', T('p.price.price'), priceWrap, T('p.price.priceHint'), false, T));
    var modeName = 'fTaxMode';
    var modes = h('div', { class: 'radio-set', role: 'radiogroup', 'aria-labelledby': 'fTaxModeLabel' });
    ['inclusive', 'exclusive', 'none'].forEach(function (m) {
      var r = h('input', { type: 'radio', name: modeName, value: m, id: 'fTax_' + m, checked: pr.taxMode === m ? true : null });
      modes.appendChild(h('label', { class: 'check-row', for: 'fTax_' + m }, [r, h('span', null, [h('strong', { text: T('p.tax.' + m) }), h('span', { class: 'hint block', text: T('p.tax.' + m + 'Hint') })])]));
    });
    s3.appendChild(h('div', { class: 'field' }, [h('span', { class: 'field-label', id: 'fTaxModeLabel', text: T('p.tax.treatment') }), modes, h('p', { class: 'field-error', id: 'fTaxModeErr', role: 'alert' })]));
    var rateSel = selectEl('fRateSel', [['', T('p.f.choose')]].concat(COMMON_GST_RATES.map(function (r) { return [String(r), formatRate(r)]; })).concat([['other', T('p.tax.otherRate')]]),
      pr.taxRate == null ? '' : COMMON_GST_RATES.indexOf(pr.taxRate) !== -1 ? String(pr.taxRate) : 'other', null, T('p.tax.rate'));
    var rateOther = inputEl('fRate', pr.taxRate != null && COMMON_GST_RATES.indexOf(pr.taxRate) === -1 ? String(pr.taxRate) : '', { inputmode: 'decimal', placeholder: '12', 'aria-label': T('p.tax.otherRate') });
    var rateBox = h('div', { class: 'field', id: 'fRateBox' }, [
      h('label', { for: 'fRateSel', text: T('p.tax.rate') }),
      h('div', { class: 'row' }, [rateSel, h('span', { class: 'rate-other' }, [rateOther, ' %'])]),
      h('p', { class: 'hint', text: T('p.tax.rateHint') }),
      h('p', { class: 'field-error', id: 'fRateErr', role: 'alert' })
    ]);
    s3.appendChild(rateBox);
    s3.appendChild(field('fHsn', T('p.tax.hsn'), inputEl('fHsn', pr.hsn, { maxlength: '10', inputmode: 'numeric', placeholder: '9003' }), T('p.tax.hsnHint'), true, T));
    var sale = inputEl('fSale', pr.salePaise != null ? paiseToInput(pr.salePaise) : '', { inputmode: 'decimal' });
    s3.appendChild(field('fSale', T('p.price.sale'), h('div', { class: 'money' }, [h('span', { class: 'money-sym', 'aria-hidden': 'true', text: '₹' }), sale]), T('p.price.saleHint'), true, T));
    var breakdown = h('div', { class: 'price-preview', 'aria-live': 'polite' });
    s3.appendChild(breakdown);
    var confirm = h('input', { type: 'checkbox', id: 'fConfirm', checked: pr.confirmed ? true : null });
    s3.appendChild(h('label', { class: 'check-row confirm-row' }, [confirm, h('span', { text: T('p.price.confirm') })]));
    s3.appendChild(h('p', { class: 'hint', text: T('p.price.responsibility') }));
    s3.appendChild(h('p', { class: 'field-error', id: 'fConfirmErr', role: 'alert' }));
    if (p.priceUpdatedMs) s3.appendChild(h('p', { class: 'fine', text: T('p.price.updated', { date: fmtDate(p.priceUpdatedMs, lang()) }) }));
    var avail = selectEl('fAvail', [['', T('p.f.choose')]].concat(AVAILABILITY.map(function (a) { return [a, T('avail.' + a)]; })), p.availability || '', null, T('p.f.avail'));
    s3.appendChild(field('fAvail', T('p.f.avail'), avail, null, false, T));
    form.appendChild(s3);

    function readPricing() {
      var mode = (form.querySelector('input[name="' + modeName + '"]:checked') || {}).value || null;
      var rateVal = rateSel.value === 'other' ? rateOther.value : rateSel.value;
      return pricingFromForm({ price: price.value, taxMode: mode, taxRate: rateVal, salePrice: sale.value, confirmed: confirm.checked, hsn: document.getElementById('fHsn').value });
    }
    function drawBreakdown() {
      var mode = (form.querySelector('input[name="' + modeName + '"]:checked') || {}).value;
      rateBox.hidden = !mode || mode === 'none';
      rateOther.parentNode.hidden = rateSel.value !== 'other';
      breakdown.innerHTML = '';
      var rec = readPricing();
      if (!price.value.trim()) return;
      var v = priceView(rec);
      if (!v) { breakdown.appendChild(h('p', { class: 'hint', text: T('p.price.incomplete') })); return; }
      var dl = h('dl', { class: 'price-lines' });
      function line(a, b) { dl.appendChild(h('dt', { text: a })); dl.appendChild(h('dd', { text: b })); }
      if (v.mode === 'none') { line(T('price.final'), formatINR(v.pay.finalPaise, lang())); line(T('price.gst'), T('price.noGstLong')); }
      else {
        line(T('price.before'), formatINR(v.pay.basePaise, lang()));
        line(T('price.gstRate', { rate: formatRate(v.rate) }), formatINR(v.pay.taxPaise, lang()));
        line(T('price.final'), formatINR(v.pay.finalPaise, lang()));
      }
      if (v.sale) line(T('p.price.regularFinal'), formatINR(v.regular.finalPaise, lang()));
      breakdown.appendChild(h('p', { class: 'field-label', text: T('p.price.preview') }));
      breakdown.appendChild(dl);
      if (v.mode === 'inclusive') breakdown.appendChild(h('p', { class: 'hint', text: T('p.price.inclNote') }));
    }
    [price, sale, rateOther, rateSel, confirm].forEach(function (el) { el.addEventListener('input', drawBreakdown); el.addEventListener('change', drawBreakdown); });
    modes.addEventListener('change', drawBreakdown);
    setTimeout(drawBreakdown, 0);

    // 4. publish
    var s4 = h('fieldset', { class: 'form-section', disabled: locked ? true : null }, [h('legend', { text: '4. ' + T('p.step.publish') })]);
    var statusSel = h('div', { class: 'radio-set' });
    ['draft', 'published', 'archived'].forEach(function (s) {
      statusSel.appendChild(h('label', { class: 'check-row' }, [h('input', { type: 'radio', name: 'fStatus', value: s, checked: (p.status || 'draft') === s ? true : null }), h('span', null, [h('strong', { text: T('p.status.opt.' + s) }), h('span', { class: 'hint block', text: T('p.status.opt.' + s + 'Hint') })])]));
    });
    s4.appendChild(statusSel);
    var checklist = h('ul', { class: 'checklist' });
    s4.appendChild(h('p', { class: 'field-label', text: T('p.publish.checklist') }));
    s4.appendChild(checklist);
    var vis = h('p', { class: 'visibility' });
    s4.appendChild(vis);
    form.appendChild(s4);

    function current() {
      var rec = readPricing();
      var eye = document.getElementById('fEye').value, br = document.getElementById('fBridge').value, tm = document.getElementById('fTemple').value;
      var sz = cleanSize({ eye: eye, bridge: br, temple: tm });
      return {
        name: document.getElementById('fName').value.trim(),
        sku: document.getElementById('fSku').value.trim(),
        brand: document.getElementById('fBrand').value.trim(),
        frameType: document.getElementById('fType').value || null,
        material: document.getElementById('fMaterial').value.trim(),
        colourName: document.getElementById('fColourName').value.trim(),
        description: document.getElementById('fDesc').value.trim(),
        link: document.getElementById('fLink').value.trim(),
        tags: { shape: tags.shape, color: tags.color, gender: tags.gender, rim: tags.rim, free: cleanFreeTags(free) },
        size: sz,
        sizeTyped: !!(eye || br || tm),
        pricing: price.value.trim() || rec.taxMode ? rec : null,
        availability: document.getElementById('fAvail').value || null,
        status: (form.querySelector('input[name="fStatus"]:checked') || {}).value || 'draft'
      };
    }
    function drawChecklist() {
      var c = current();
      var probe = Object.assign({}, p, c, { status: 'published' });
      var blockers = publishBlockers(probe);
      checklist.innerHTML = '';
      [['publish.needName', 'p.chk.name'], ['publish.needPrice', 'p.chk.price'], ['publish.needTaxConfirm', 'p.chk.tax'], ['publish.needAvailability', 'p.chk.avail'], ['publish.needPhoto', 'p.chk.photo'], ['publish.tryOnUnresolved', 'p.chk.tryon']].forEach(function (pair) {
        var bad = blockers.indexOf(pair[0]) !== -1 || (pair[0] === 'publish.tryOnUnresolved' && blockers.indexOf('publish.tryOnIncomplete') !== -1);
        var optional = pair[0] === 'publish.needPrice' && !bad && !c.pricing;
        checklist.appendChild(h('li', { class: bad ? 'todo' : optional ? 'optional' : 'done' }, [h('span', { class: 'visually-hidden', text: bad ? T('p.chk.todo') : optional ? T('p.chk.optional') : T('p.chk.done') }), T(pair[1]) + (optional ? ' ' + T('p.chk.priceLater') : '')]));
      });
      if (blockers.indexOf('publish.suspended') !== -1) checklist.appendChild(h('li', { class: 'todo', text: T('p.chk.suspended') }));
      var want = c.status === 'published';
      var pub = shouldBePublic(Object.assign({}, p, c), shopStatus());
      vis.className = 'visibility ' + (pub ? 'ok' : 'muted');
      vis.textContent = pub ? T('p.vis.live') : !want ? T('p.vis.' + c.status) : blockers.length ? T('p.vis.blocked') : T('p.vis.waiting');
    }
    form.addEventListener('input', drawChecklist);
    form.addEventListener('change', drawChecklist);
    form.addEventListener('click', function () { setTimeout(drawChecklist, 0); });
    setTimeout(drawChecklist, 0);

    var err = h('p', { class: 'form-error', role: 'alert', id: 'fFormErr' });
    var saveBtn = h('button', { type: 'submit', class: 'btn primary', text: T('p.save'), disabled: locked ? true : null });
    var bar = h('div', { class: 'save-bar' }, [
      saveBtn,
      h('button', { type: 'button', class: 'btn secondary', text: T('p.preview'), disabled: st.editIsNew ? true : null, onclick: function () { ctx.previewProduct(st.editing); } }),
      st.editIsNew ? null : h('button', { type: 'button', class: 'btn danger', text: T('p.delete'), onclick: removeProduct }),
      h('a', { class: 'btn secondary', href: ctx.hashFor({ name: 'partner', id: 'products' }), text: T('p.backToList') })
    ]);
    form.appendChild(err);
    form.appendChild(bar);

    var title = st.editIsNew ? T('p.product.new') : (p.name || T('partner.untitled'));
    var head = [statusBanner()];
    if (p.moderation && p.moderation.state === 'suspended') head.push(h('div', { class: 'message error', role: 'status', text: T('p.product.suspended', { reason: p.moderation.reason || T('p.product.noReason') }) }));
    page(title, head.concat([form]), { tabs: true });

    function save(thenNavigate, extra, after) {
      err.classList.remove('show');
      var c = current();
      var problems = productProblems(Object.assign({}, c, { status: c.status }));
      if (c.sizeTyped && !c.size) problems.push({ field: 'size', code: 'product.sizeInvalid' });
      var pp = c.pricing ? pricingProblems(c.pricing, false) : [];
      if (c.pricing && pp.length) {
        pp.forEach(function (code) {
          var fieldId = code.indexOf('tax.mode') === 0 ? 'taxMode' : code.indexOf('tax.rate') === 0 ? 'rate' : code.indexOf('sale') === 0 ? 'sale' : 'pricing';
          problems.push({ field: fieldId, code: code });
        });
      }
      problems = problems.filter(function (x, i, a) { return a.findIndex(function (y) { return y.field === x.field; }) === i; });
      if (showFieldErrors(problems, Object.assign({}, PFIELDS, { taxMode: 'fTaxMode', rate: 'fRate', sale: 'fSale' }))) { if (after && after.fail) after.fail(); return Promise.resolve(null); }
      if (c.status === 'published') {
        var blockers = publishBlockers(Object.assign({}, p, c));
        if (blockers.length) {
          err.textContent = T('p.publish.blocked') + ' ' + blockers.map(function (b) { return T(b); }).join(' ');
          err.classList.add('show');
          if (after && after.fail) after.fail();
          return Promise.resolve(null);
        }
      }
      var changes = {
        name: c.name, sku: c.sku, brand: c.brand, frameType: c.frameType, material: c.material, colourName: c.colourName,
        description: c.description, link: c.link, tags: c.tags, size: c.size, availability: c.availability, status: c.status
      };
      if (c.pricing) changes.pricing = c.pricing;
      if (extra) Object.keys(extra).forEach(function (k) { changes[k] = extra[k]; });
      saveBtn.disabled = true;
      var op = st.editIsNew ? B.createProduct(st.uid, p.id, Object.assign({}, changes), shopStatus()).then(function () { return B.getProduct(p.id); })
        : B.saveProduct(p, changes, shopStatus()).then(function () { return B.getProduct(p.id); });
      return op.then(function (w) {
        st.editing = w; st.editIsNew = false;
        replaceProduct(w);
        ctx.forgetProduct(w.id);
        if (typeof after === 'function') after(w);
        if (thenNavigate) { thenNavigate(w); return w; }
        ctx.toast(w.public ? T('p.savedLive') : T('p.saved'));
        if (st.route.sub === 'new') ctx.navigate({ name: 'partner', id: 'product', sub: w.id }, { replace: true });
        else drawProduct();
        return w;
      }).catch(function (e) {
        console.error('Save failed', e);
        err.textContent = T(e && e.code === 'permission-denied' ? 'p.saveDenied' : 'p.saveFailed');
        err.classList.add('show');
        return null;
      }).then(function (w) { saveBtn.disabled = false; return w; });
    }
    // Saves first (a new product must exist before photos can be stored), then continues.
    function saveThen(fn) { save(fn); }
    function removeProduct() {
      ctx.confirmAction({ title: T('p.deleteTitle'), body: T('p.deleteBody', { name: p.name || T('partner.untitled') }), ok: T('p.delete'), cancel: T('common.cancel'), danger: true }).then(function (yes) {
        if (!yes) return;
        B.deleteProduct(p).then(function () {
          ctx.forgetProduct(p.id);
          if (st.products) st.products = st.products.filter(function (x) { return x.id !== p.id; });
          ctx.toast(T('p.deleted'));
          ctx.navigate({ name: 'partner', id: 'products' }, { replace: true });
        }).catch(function (e) { console.error(e); ctx.toast(T('p.saveFailed'), 'error'); });
      });
    }
  }

  // ---------- shop profile ----------
  function renderShop() {
    var s = st.shop, rejected = s.status === 'rejected', suspended = s.status === 'suspended';
    if (st.acting) {
      page(T('p.tab.shop'), [statusBanner(), s.status === 'approved' ? qrPanel(s, T, ctx.toast) : null,
        h('p', { class: 'hint', text: T('p.acting.profile') })], { tabs: true, sub: s.name });
      return;
    }
    var err = h('p', { class: 'form-error', role: 'alert' });
    var btn = h('button', { type: 'submit', class: 'btn primary', text: T(rejected ? 'p.shop.reapply' : 'p.save'), disabled: suspended ? true : null });
    var form = h('form', { novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      err.classList.remove('show');
      var v = readShop();
      if (showFieldErrors(shopProblems(v.profile).concat(shopPrivateProblems(v.priv)), SHOP_FIELD_IDS)) return;
      btn.disabled = true;
      B.updateShop(st.uid, v.profile, stripEmpty(v.priv), !!st.priv, rejected).then(function () {
        ctx.toast(T(rejected ? 'p.apply.sent' : 'p.saved'));
        reset(); show({ id: 'shop' });
      }).catch(function (e2) { console.error(e2); err.textContent = T('p.saveFailed'); err.classList.add('show'); }).then(function () { btn.disabled = false; });
    } }, [shopFields(s, st.priv, { note: true }), err, h('div', { class: 'row' }, [btn,
      s.status === 'approved' ? h('a', { class: 'btn secondary', href: ctx.hashFor({ name: 'browse', source: 'shop:' + s.id }), text: T('p.shop.view') }) : null])]);
    var qr = s.status === 'approved' ? qrPanel(s, T, ctx.toast)
      : h('section', { class: 'panel' }, [h('h2', { class: 'panel-title', text: T('qr.title') }), h('p', { class: 'hint', text: T('qr.afterApproval') })]);
    var kiosk = s.status === 'approved' ? h('div', { class: 'panel' }, [
      h('h2', { class: 'panel-title', text: T('p.kiosk.title') }),
      h('p', { class: 'hint', text: T('p.kiosk.text') }),
      h('p', null, [h('code', { class: 'kiosk-link', text: siteBase() + '#/shop/' + encodeURIComponent(s.id) + '?kiosk=1' })])
    ]) : null;
    var acc = h('div', { class: 'panel' }, [
      h('h2', { class: 'panel-title', text: T('p.legal.title') }),
      h('p', { class: 'hint', text: T('p.legal.accepted', { terms: (st.accepted.retailerTerms || []).join(', ') || '—', privacy: (st.accepted.privacy || []).join(', ') || '—' }) }),
      h('p', null, [h('a', { href: 'legal/retailer-terms.html', target: '_blank', rel: 'noopener', text: T('footer.retailerTerms') }), ' · ', h('a', { href: 'legal/privacy.html', target: '_blank', rel: 'noopener', text: T('footer.privacyPolicy') })]),
      h('p', { class: 'hint', text: T('p.legal.deletion') })
    ]);
    page(T('p.tab.shop'), [statusBanner(), qr, form, kiosk, acc], { tabs: true, sub: s.name });
  }

  // ---------- import: a spreadsheet (CSV), or the old single-shop library ----------
  var CSV_COLUMNS = ['name', 'sku', 'brand', 'frame_type', 'shape', 'colour', 'colour_name', 'for', 'rim', 'material', 'eye', 'bridge', 'temple', 'price', 'tax_mode', 'gst_rate', 'tax_confirmed', 'sale_price', 'hsn', 'availability', 'link', 'description'];
  var CSV_EXAMPLE = ['Matte black rectangle', 'BLK-5218', 'House brand', 'eyeglasses', 'rectangle', 'black', 'Matte black', 'unisex', 'fullrim', 'Acetate', '52', '18', '140', '2499', 'inclusive', '', 'no', '', '9003', 'in_stock', '', 'Light everyday frame'];
  function csvTemplate() {
    var esc = function (v) { return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return CSV_COLUMNS.join(',') + '\n' + CSV_EXAMPLE.map(esc).join(',') + '\n';
  }
  function parseCsv(text) {
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
  }
  var ALIASES = { colour: 'color', color: 'color', for: 'gender', gender: 'gender' };
  function rowToProduct(o) {
    function enumv(v, list) { v = (v || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); return list.indexOf(v) !== -1 ? v : (v ? undefined : null); }
    function tag(k, v) { v = (v || '').trim().toLowerCase().replace(/[\s-]+/g, ''); if (!v) return null; return TAG_VALUES[k].indexOf(v) !== -1 ? v : undefined; }
    var errors = [];
    var tags = { shape: tag('shape', o.shape), color: tag('color', o.colour || o.color), gender: tag('gender', o['for'] || o.gender), rim: tag('rim', o.rim), free: [] };
    Object.keys(tags).forEach(function (k) { if (tags[k] === undefined) { errors.push(T('p.csv.badValue', { col: k })); tags[k] = null; } });
    var frameType = enumv(o.frame_type, FRAME_TYPES); if (frameType === undefined) { errors.push(T('p.csv.badValue', { col: 'frame_type' })); frameType = null; }
    var availability = enumv(o.availability, AVAILABILITY); if (availability === undefined) { errors.push(T('p.csv.badValue', { col: 'availability' })); availability = null; }
    var size = cleanSize({ eye: o.eye, bridge: o.bridge, temple: o.temple });
    if ((o.eye || o.bridge || o.temple) && !size) errors.push(T('product.sizeInvalid'));
    var pricing = null;
    if ((o.price || '').trim()) {
      var mode = (o.tax_mode || '').trim().toLowerCase() || null;
      if (mode && ['inclusive', 'exclusive', 'none'].indexOf(mode) === -1) { errors.push(T('p.csv.badValue', { col: 'tax_mode' })); mode = null; }
      pricing = pricingFromForm({ price: o.price, taxMode: mode, taxRate: o.gst_rate, salePrice: o.sale_price, hsn: o.hsn, confirmed: /^(yes|y|true|1)$/i.test((o.tax_confirmed || '').trim()) });
      if (!mode) pricing.confirmed = false;
      var pp = pricingProblems(pricing, false).filter(function (c) { return c !== 'tax.modeMissing' && c !== 'tax.rateMissing'; });
      pp.forEach(function (c) { errors.push(T(c)); });
      if (!mode) delete pricing.taxMode;
      if (pricingProblems(pricing, false).length) pricing = null;     // incomplete tax info: imported without a price
    }
    var link = (o.link || '').trim();
    var prod = {
      name: (o.name || '').trim().slice(0, LIMITS.name), sku: (o.sku || '').trim().slice(0, LIMITS.sku), brand: (o.brand || '').trim().slice(0, LIMITS.brand),
      frameType: frameType, tags: tags, colourName: (o.colour_name || '').trim().slice(0, LIMITS.colourName), material: (o.material || '').trim().slice(0, LIMITS.material),
      size: size, description: (o.description || '').trim().slice(0, LIMITS.description), link: link, availability: availability, status: 'draft'
    };
    if (pricing) prod.pricing = pricing;
    productProblems(prod).forEach(function (p) { errors.push(T(p.code) + ' (' + p.field + ')'); });
    if (!prod.name) errors.push(T('p.csv.noName'));
    return { product: prod, errors: errors, priceSkipped: !!(o.price || '').trim() && !pricing };
  }
  function renderImport() {
    var file = h('input', { type: 'file', id: 'csvFile', accept: '.csv,text/csv' });
    var out = h('div', { id: 'csvOut' });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { out.textContent = T('p.csv.tooBig'); return; }
      var reader = new FileReader();
      reader.onload = function () { st.csv = analyseCsv(String(reader.result || '')); drawCsv(out); };
      reader.readAsText(f);
    });
    var tmpl = h('a', { class: 'btn secondary small', download: 'frames-template.csv', href: 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvTemplate()), text: T('p.csv.template') });
    var csvPanel = h('section', { class: 'panel' }, [
      h('h2', { class: 'panel-title', text: T('p.csv.title') }),
      h('p', { class: 'hint', text: T('p.csv.text') }),
      h('p', { class: 'hint mono small', text: CSV_COLUMNS.join(', ') }),
      h('p', { class: 'hint', text: T('p.csv.taxNote') }),
      h('div', { class: 'row' }, [tmpl, h('label', { class: 'btn primary small file-btn' }, [T('p.csv.choose'), file])]),
      out
    ]);
    var legacyOut = h('p', { class: 'hint', role: 'status' });
    var legacyBtn = h('button', { type: 'button', class: 'btn secondary', text: T('p.legacy.btn'), disabled: canEdit() ? null : true, onclick: function () {
      legacyBtn.disabled = true;
      legacyOut.textContent = T('p.legacy.working', { done: 0, total: '…' });
      ctx.legacyImport(function (done, total) { legacyOut.textContent = T('p.legacy.working', { done: done, total: total }); }).then(function (r) {
        legacyOut.textContent = r.total ? T('p.legacy.done', r) : T('p.legacy.none');
        st.products = null;
      }).catch(function (e) { console.error(e); legacyOut.textContent = T('p.saveFailed'); }).then(function () { legacyBtn.disabled = false; });
    } });
    var legacyPanel = h('section', { class: 'panel' }, [
      h('h2', { class: 'panel-title', text: T('p.legacy.title') }),
      h('p', { class: 'hint', text: T('p.legacy.text') }),
      legacyBtn, legacyOut
    ]);
    page(T('p.tab.import'), [statusBanner(), photoPackagePanel(), csvPanel, st.acting ? null : legacyPanel], { tabs: true, sub: st.shop.name });
    if (st.csv) drawCsv(out);
  }
  // Many frames at once from a photo package (a .zip of photos with their
  // details, e.g. prepared from photos of the shop's display; see photo-import.js).
  function photoPackagePanel() {
    var out = h('div', { class: 'pkg-out', role: 'status' });
    var publish = h('input', { type: 'checkbox', id: 'pkgPublish', checked: true });
    var file = h('input', { type: 'file', id: 'pkgFile', multiple: true, accept: '.zip,application/zip,.json,.jpg,.jpeg,.png,.webp' });
    file.addEventListener('change', function () {
      if (!file.files || !file.files.length) return;
      out.innerHTML = '';
      out.appendChild(h('p', { class: 'hint', text: T('p.pkg.reading') }));
      readPackage(file.files).then(parsePackage).then(function (pack) {
        out.innerHTML = '';
        var withTry = pack.frames.filter(function (f) { return f.tryOn; }).length;
        var bad = pack.frames.filter(function (f) { return !f.ok; }).length;
        out.appendChild(h('p', null, [h('strong', { text: T('p.pkg.found', { n: pack.frames.length, t: withTry }) })]));
        if (bad) out.appendChild(h('p', { class: 'form-error show', text: T('p.pkg.bad', { n: bad }) }));
        var grid = h('div', { class: 'pkg-grid' });
        pack.frames.slice(0, 120).forEach(function (f) {
          var url = pack.files[f.fid + '.thumb.webp'] ? URL.createObjectURL(pack.files[f.fid + '.thumb.webp']) : '';
          grid.appendChild(h('figure', { class: 'pkg-item' }, [url ? h('img', { src: url, alt: '', width: '96', height: '96', loading: 'lazy' }) : null,
            h('figcaption', { text: (f.meta.name || f.fid) + (f.tryOn ? ' ✓' : '') })]));
        });
        out.appendChild(grid);
        var go = h('button', { type: 'button', class: 'btn primary', text: T('p.pkg.go', { n: pack.frames.length }), disabled: canEdit() ? null : true });
        var prog = h('p', { class: 'hint', role: 'status' });
        go.addEventListener('click', function () {
          go.disabled = true; file.disabled = true;
          importPackage(B, st.uid, pack, {
            publish: publish.checked, availability: 'in_stock', shopStatus: shopStatus(),
            onProgress: function (d, t) { prog.textContent = T('p.pkg.working', { done: d, total: t }); }
          }).then(function (r) {
            prog.textContent = T('p.pkg.done', r) + (r.errors.length ? ' ' + r.errors.slice(0, 5).join('; ') : '');
            st.products = null;
            ctx.toast(T('p.pkg.doneShort', r));
          }).catch(function (e) { console.error(e); prog.textContent = T('p.saveFailed'); }).then(function () { file.disabled = false; });
        });
        out.appendChild(h('div', { class: 'row' }, [go]));
        out.appendChild(prog);
      }).catch(function (e) {
        console.error(e); out.innerHTML = '';
        out.appendChild(h('p', { class: 'form-error show', text: T(e && e.code === 'no-index' ? 'p.pkg.noIndex' : 'p.pkg.unreadable') }));
      });
    });
    return h('section', { class: 'panel' }, [
      h('h2', { class: 'panel-title', text: T('p.pkg.title') }),
      h('p', { class: 'hint', text: T('p.pkg.text') }),
      h('label', { class: 'check' }, [publish, ' ' + T('p.pkg.publish')]),
      h('div', { class: 'row' }, [h('label', { class: 'btn primary small file-btn' }, [T('p.pkg.choose'), file])]),
      out
    ]);
  }
  function analyseCsv(text) {
    var rows = parseCsv(text.replace(/^﻿/, ''));
    if (!rows.length) return { error: T('p.csv.empty') };
    var head = rows[0].map(function (x) { return x.trim().toLowerCase().replace(/\s+/g, '_'); });
    if (head.indexOf('name') === -1) return { error: T('p.csv.needName') };
    var items = rows.slice(1, 501).map(function (r, i) {
      var o = {};
      head.forEach(function (k, j) { o[k] = r[j] == null ? '' : r[j]; });
      var res = rowToProduct(o);
      res.line = i + 2;
      return res;
    });
    return { items: items, truncated: rows.length - 1 > 500 };
  }
  function drawCsv(out) {
    out.innerHTML = '';
    var c = st.csv;
    if (c.error) { out.appendChild(h('p', { class: 'form-error show', role: 'alert', text: c.error })); return; }
    var good = c.items.filter(function (x) { return !x.errors.length; });
    out.appendChild(h('p', { class: 'dash-summary', text: T('p.csv.summary', { ok: good.length, bad: c.items.length - good.length }) }));
    if (c.truncated) out.appendChild(h('p', { class: 'hint', text: T('p.csv.truncated') }));
    var table = h('table', { class: 'dash-table' }, [h('thead', null, [h('tr', null, [h('th', { text: T('p.csv.line') }), h('th', { text: T('p.f.name') }), h('th', { text: T('p.f.sku') }), h('th', { text: T('p.col.price') }), h('th', { text: T('p.csv.check') })])])]);
    var tb = h('tbody');
    c.items.slice(0, 200).forEach(function (x) {
      var v = x.product.pricing ? priceView(x.product.pricing) : null;
      tb.appendChild(h('tr', { class: x.errors.length ? 'row-bad' : '' }, [
        h('td', { class: 'mono', text: String(x.line) }), h('td', { text: x.product.name || '—' }), h('td', { class: 'mono', text: x.product.sku || '' }),
        h('td', { class: 'mono', text: v ? formatINR(v.pay.finalPaise, lang()) + (x.product.pricing.confirmed ? '' : ' *') : (x.priceSkipped ? T('p.csv.priceSkipped') : '—') }),
        h('td', { text: x.errors.length ? x.errors.join('; ') : T('p.csv.ok') })
      ]));
    });
    table.appendChild(tb);
    out.appendChild(h('div', { class: 'table-wrap' }, [table]));
    out.appendChild(h('p', { class: 'hint', text: T('p.csv.starNote') }));
    var status = h('p', { class: 'hint', role: 'status' });
    var go = h('button', { type: 'button', class: 'btn primary', text: T('p.csv.import', { n: good.length }), disabled: !good.length || !canEdit() ? true : null, onclick: function () {
      go.disabled = true;
      var done = 0, failed = 0;
      good.reduce(function (chain, x) {
        return chain.then(function () {
          return B.createProduct(st.uid, B.newProductId(), x.product, shopStatus()).then(function () { done++; }).catch(function (e) { console.error(e); failed++; }).then(function () { status.textContent = T('p.csv.progress', { done: done + failed, total: good.length }); });
        });
      }, Promise.resolve()).then(function () {
        ctx.toast(T('p.csv.finished', { done: done, failed: failed }), failed ? 'error' : null);
        st.csv = null; st.products = null;
        ctx.navigate({ name: 'partner', id: 'products' });
      });
    } });
    out.appendChild(h('div', { class: 'row' }, [go]));
    out.appendChild(status);
  }

  // ---------- API for app.js ----------
  return {
    show: show,
    rerender: function () { if (st.route) show(st.route); },
    productChanged: function (p) { replaceProduct(p); if (st.editing && st.editing.id === p.id) st.editing = p; }
  };
}
