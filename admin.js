// The admin dashboard (platform owner only): shops to review, approve,
// suspend; listings to moderate; reports; legal versions and acceptance
// records; platform and demo settings; usage; the audit log. English only.
// Loaded by app.js on first visit to #/admin.
//
// Being shown this page proves nothing: every action here is checked by the
// server rules (isAdmin() in firestore.rules), and an admin account can only
// be created in the Firebase console.

import { firebaseConfig } from './firebase-config.js';
import { priceView, formatINR } from './pricing.js';
import { LEGAL_DOCS } from './legal/versions.js';
import { qrPanel } from './qr.js';

function h(tag, attrs, kids) {
  var el = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v == null || v === false) return;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  });
  (kids || []).forEach(function (c) { if (c == null || c === false) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return el;
}
function when(ms) { return ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

var TABS = [['overview', 'Overview'], ['shops', 'Shops'], ['products', 'Listings'], ['reports', 'Reports'], ['legal', 'Legal'], ['settings', 'Settings'], ['audit', 'Audit log']];

export function initAdmin(root, ctx) {
  var B = ctx.backend;
  var st = { tab: 'overview', route: null, shops: {}, shopFilter: 'pending', prodFilter: '', prodPage: null, reportStatus: 'open' };

  function frame(kids) {
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'page-head dash-head' }, [h('h1', { id: 'adminTitle', text: 'Admin' }), h('p', { class: 'page-count', text: 'Platform owner tools. Every action is checked by the server and logged.' })]));
    var nav = h('nav', { class: 'dash-tabs', 'aria-label': 'Admin sections' });
    TABS.forEach(function (tb) { nav.appendChild(h('a', { class: 'dash-tab' + (st.tab === tb[0] ? ' active' : ''), href: ctx.hashFor({ name: 'admin', id: tb[0] }), 'aria-current': st.tab === tb[0] ? 'page' : null, text: tb[1] })); });
    root.appendChild(nav);
    kids.forEach(function (k) { if (k) root.appendChild(k); });
  }
  function msg(text, cls) { return h('div', { class: cls || 'message', role: 'status', text: text }); }
  function fail(e) { console.error(e); ctx.toast(e && e.code === 'permission-denied' ? 'The server refused that (permission denied).' : 'Something went wrong. Check the connection and try again.', 'error'); }
  function ask(title, body, okText, danger, needReason) {
    if (!needReason) return ctx.confirmAction({ title: title, body: body, ok: okText, cancel: 'Cancel', danger: danger }).then(function (yes) { return yes ? '' : null; });
    var reason = window.prompt(title + '\n\n' + body + '\n\nReason (shown to the shop):', '');
    if (reason == null) return Promise.resolve(null);
    reason = reason.trim().slice(0, 300);
    if (!reason) { ctx.toast('A reason is needed.', 'error'); return Promise.resolve(null); }
    return Promise.resolve(reason);
  }

  function show(r) {
    st.route = r || {};
    st.tab = TABS.some(function (tb) { return tb[0] === st.route.id; }) ? st.route.id : 'overview';
    var u = ctx.currentUser();
    root.innerHTML = '';
    if (!u) {
      root.appendChild(h('div', { class: 'auth-wrap' }, [h('h1', { id: 'adminTitle', text: 'Admin' }), h('p', { class: 'lede', text: 'Sign in with the administrator account.' }), h('a', { class: 'btn primary', href: '#/partner', text: 'Sign in' })]));
      return;
    }
    if (!ctx.adminChecked()) { root.appendChild(h('p', { class: 'page-count', role: 'status', text: 'Checking access…' })); return; }
    if (!ctx.isAdmin()) {
      root.appendChild(h('div', { class: 'auth-wrap' }, [h('h1', { id: 'adminTitle', text: 'Admin' }), h('p', { class: 'lede', text: 'This page is for the platform administrator. Your account doesn’t have admin access.' }), h('a', { class: 'btn secondary', href: '#/', text: 'Back to the site' })]));
      return;
    }
    ({ overview: overview, shops: shops, products: products, reports: reports, legal: legal, settings: settings, audit: audit })[st.tab]();
  }

  // ---------- overview ----------
  function overview() {
    frame([msg('Loading…')]);
    Promise.all([B.adminCounts(), B.getConfig('legal'), B.getConfig('platform')]).then(function (r) {
      var c = r[0], legalCfg = r[1];
      var kids = [];
      if (!legalCfg) {
        kids.push(h('div', { class: 'notice' }, [
          h('strong', { text: 'Finish setting up the platform. ' }),
          'Shops can’t apply until the legal document versions are recorded. ',
          h('button', { type: 'button', class: 'btn primary small', text: 'Initialise platform settings', onclick: function () {
            Promise.all([
              B.saveConfig('legal', { retailerTerms: pick(LEGAL_DOCS.retailerTerms), customerTerms: pick(LEGAL_DOCS.customerTerms), privacy: pick(LEGAL_DOCS.privacy) }),
              r[2] ? Promise.resolve() : B.saveConfig('platform', { applicationsOpen: true, announcement: '', maxProductsPerShop: 1000 })
            ]).then(function () { B.adminAudit('platform.init', 'config', 'legal'); ctx.toast('Platform settings created.'); overview(); }).catch(fail);
          } })
        ]));
      }
      function tile(label, value, href, sub) {
        return h(href ? 'a' : 'div', { class: 'stat-tile', href: href || null }, [h('span', { class: 'stat-value', text: value == null ? '—' : String(value) }), h('span', { class: 'stat-label', text: label }), sub ? h('span', { class: 'stat-sub', text: sub }) : null]);
      }
      kids.push(h('div', { class: 'stat-grid' }, [
        tile('Shops waiting for review', c.shopsPending, '#/admin/shops'),
        tile('Approved shops', c.shopsApproved, '#/admin/shops'),
        tile('Suspended shops', c.shopsSuspended, '#/admin/shops'),
        tile('Products (all shops)', c.products, '#/admin/products'),
        tile('Shown to customers', c.productsPublic),
        tile('Try-on ready', c.tryOnReady),
        tile('Try-on failed (processing errors)', c.tryOnFailed, '#/admin/products', 'needs the shop’s attention'),
        tile('Suspended listings', c.productsSuspended, '#/admin/products'),
        tile('Open reports', c.reportsOpen, '#/admin/reports'),
        tile('Stored frame images', bytes(c.storageBytes), null, 'as recorded on products')
      ]));
      var pid = firebaseConfig.projectId;
      kids.push(tryOnPanel());
      kids.push(freePlanPanel(c));
      kids.push(h('section', { class: 'panel' }, [
        h('h2', { class: 'panel-title', text: 'Usage and costs' }),
        h('p', { class: 'hint', text: 'Exact database reads, writes, stored data and downloads are in the Firebase console’s Firestore Usage page (this page can’t see them). On Blaze, also set a budget alert: it emails you when spending passes an amount, but it does not stop spending.' }),
        h('ul', { class: 'link-list' }, [
          h('li', null, [h('a', { href: 'https://console.firebase.google.com/project/' + pid + '/usage', target: '_blank', rel: 'noopener', text: 'Firebase: Usage and billing' })]),
          h('li', null, [h('a', { href: 'https://console.firebase.google.com/project/' + pid + '/firestore/usage', target: '_blank', rel: 'noopener', text: 'Firestore usage (reads, writes, storage)' })]),
          h('li', null, [h('a', { href: 'https://console.firebase.google.com/project/' + pid + '/storage', target: '_blank', rel: 'noopener', text: 'Cloud Storage (files and usage)' })]),
          h('li', null, [h('a', { href: 'https://console.cloud.google.com/billing/budgets', target: '_blank', rel: 'noopener', text: 'Google Cloud: Budgets and alerts' })])
        ]),
        h('p', { class: 'hint', text: 'See COSTS.md in the repository for what each service costs at 25 shops.' })
      ]));
      frame(kids);
    }).catch(function (e) {
      var why = e && e.code === 'permission-denied' ? 'Permission denied: is this account in the admins collection, and are the rules deployed?'
        : e && e.code === 'resource-exhausted' ? QUOTA_OUT : '';
      frame([msg('Could not load the numbers. ' + why, 'message error')]); console.error(e);
    });
  }
  function pick(d) { return { version: d.version, date: d.date }; }

  // ---------- try-ons per shop ----------
  function shopName(id) {
    if (id === 'demo') return Promise.resolve('Demo frames');
    if (st.shops[id]) return Promise.resolve(st.shops[id].name);
    return B.getShop(id).then(function (s) { if (s) st.shops[id] = s; return s ? s.name : id; }).catch(function () { return id; });
  }
  function tryOnPanel() {
    var box = h('section', { class: 'panel' }, [h('h2', { class: 'panel-title', text: 'Try-ons per shop' }), msg('Loading…')]);
    B.adminListTryOns().then(function (list) {
      return Promise.all(list.map(function (t) { return shopName(t.shopId).then(function (n) { t.name = n; return t; }); }));
    }).then(function (list) {
      box.innerHTML = '';
      box.appendChild(h('h2', { class: 'panel-title', text: 'Try-ons per shop' }));
      box.appendChild(h('p', { class: 'hint', text: 'A try-on is counted once per frame per visit, when the frame is first shown on a customer’s face (camera or photo). Shops’ own previews and yours aren’t counted. Days are India time.' }));
      if (!list.length) { box.appendChild(h('p', { class: 'hint', text: 'No try-ons counted yet.' })); return; }
      list.sort(function (a, b) { return b.last30 - a.last30 || b.total - a.total; });
      var sum = { today: 0, last7: 0, last30: 0, total: 0 };
      var tb = h('tbody');
      list.forEach(function (t) {
        ['today', 'last7', 'last30', 'total'].forEach(function (k) { sum[k] += t[k]; });
        tb.appendChild(h('tr', null, [h('th', { scope: 'row', text: t.name }), h('td', { class: 'num', text: String(t.today) }), h('td', { class: 'num', text: String(t.last7) }),
          h('td', { class: 'num', text: String(t.last30) }), h('td', { class: 'num', text: String(t.total) + (t.before ? ' (incl. ' + t.before + ' earlier)' : '') })]));
      });
      tb.appendChild(h('tr', { class: 'sum-row' }, [h('th', { scope: 'row', text: 'All' }), h('td', { class: 'num', text: String(sum.today) }), h('td', { class: 'num', text: String(sum.last7) }), h('td', { class: 'num', text: String(sum.last30) }), h('td', { class: 'num', text: String(sum.total) })]));
      box.appendChild(h('div', { class: 'table-wrap' }, [h('table', { class: 'data-table tryon-table' }, [
        h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: 'Shop' }), h('th', { scope: 'col', class: 'num', text: 'Today' }), h('th', { scope: 'col', class: 'num', text: '7 days' }), h('th', { scope: 'col', class: 'num', text: '30 days' }), h('th', { scope: 'col', class: 'num', text: 'Total' })])]),
        tb])]));
      box.appendChild(h('p', { class: 'hint', text: 'Most-tried frames and earlier counts: Shops → Details.' }));
    }).catch(function (e) { console.error(e); box.innerHTML = ''; box.appendChild(h('h2', { class: 'panel-title', text: 'Try-ons per shop' })); box.appendChild(msg('Couldn’t load try-on counts (are the latest rules deployed?).', 'message error')); });
    return box;
  }
  // On a shop's details: its numbers, its most-tried frames, and try-ons counted before.
  function shopTryOns(s) {
    var box = h('div', { class: 'shop-tryons' }, [msg('Loading try-ons…')]);
    Promise.all([B.getTryOnStats(s.id), B.getCatalogueIndex(s.id).catch(function () { return null; })]).then(function (r) {
      var t = r[0], idx = r[1];
      box.innerHTML = '';
      box.appendChild(h('h3', { text: 'Try-ons' }));
      box.appendChild(h('p', null, ['Today ' + t.today + ' · 7 days ' + t.last7 + ' · 30 days ' + t.last30 + ' · total ' + t.total + (t.before ? ' (incl. ' + t.before + ' counted earlier)' : '')]));
      var top = Object.keys(t.frames).map(function (id) { return { id: id, n: t.frames[id] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 10);
      if (top.length) {
        var ol = h('ol', { class: 'top-frames' });
        top.forEach(function (f) {
          var name = idx && idx.items && idx.items[f.id] ? idx.items[f.id].n : (ctx.demoName && /^demo-/.test(f.id) ? ctx.demoName(f.id) : f.id);
          ol.appendChild(h('li', null, [h('a', { href: ctx.hashFor({ name: 'detail', id: f.id }), text: name || f.id }), ' — ' + f.n]));
        });
        box.appendChild(h('p', { class: 'hint', text: 'Most tried on:' }));
        box.appendChild(ol);
      }
      var inp = h('input', { type: 'number', min: '0', max: '1000000', step: '1', value: String(t.before || 0), id: 'before-' + s.id, class: 'num-input' });
      box.appendChild(h('div', { class: 'row' }, [
        h('label', { for: 'before-' + s.id, text: 'Try-ons counted before this counter (e.g. from the old site’s analytics): ' }), inp,
        h('button', { type: 'button', class: 'btn secondary small', text: 'Save', onclick: function () {
          var n = parseInt(inp.value, 10);
          if (!(n >= 0)) { ctx.toast('Enter a number.', 'error'); return; }
          B.adminSetEarlierTryOns(s.id, n).then(function () { ctx.toast('Saved.'); }).catch(fail);
        } })
      ]));
    }).catch(function (e) { console.error(e); box.innerHTML = ''; box.appendChild(msg('Couldn’t load try-ons.', 'message error')); });
    return box;
  }

  // ---------- the free plan: how full it is, and when to move to Blaze ----------
  // Firestore's free (Spark) limits, checked 18 Oct 2026 (see COSTS.md).
  var FREE = { storedBytes: 1073741824, readsPerDay: 50000, writesPerDay: 20000, downloadBytesPerMonth: 10 * 1073741824 };
  var QUOTA_OUT = 'Firestore refused because a free daily limit is used up (it resets at about 13:30 IST). If this happens on ordinary days, it’s time to move to Blaze (SETUP.md, “Moving to Blaze later”).';
  function freePlanPanel(c) {
    var pid = firebaseConfig.projectId;
    // Pictures are stored as text (base64, about 4/3 of their size) plus each
    // product's details and its index entry: roughly 1.37 × picture bytes + 3 KB a product.
    var est = c.storageBytes == null ? null : Math.round(c.storageBytes * 1.37 + (c.products || 0) * 3000);
    var pct = est == null ? null : Math.min(100, Math.round(est / FREE.storedBytes * 100));
    var level = pct == null ? 'unknown' : pct >= 80 ? 'red' : pct >= 60 ? 'amber' : 'green';
    var verdict = { green: 'Fine on the free plan.', amber: 'Plan the move to Blaze in the next few weeks.', red: 'Move to Blaze now: shops will soon be unable to add frames.', unknown: 'Couldn’t estimate.' }[level];
    var perFrame = c.products ? (est / c.products) : null;
    var room = perFrame ? Math.max(0, Math.floor((FREE.storedBytes * 0.8 - est) / perFrame)) : null;
    var bar = h('div', { class: 'meter meter-' + level, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct == null ? null : String(pct), 'aria-label': 'Database storage used' }, [h('span', { class: 'meter-fill', style: 'width:' + (pct || 0) + '%' })]);
    return h('section', { class: 'panel free-plan' }, [
      h('h2', { class: 'panel-title', text: 'Free plan (Spark): when to upgrade' }),
      h('p', null, [h('strong', { text: 'Stored data: about ' + bytes(est) + ' of 1 GB' + (pct == null ? '' : ' (' + pct + '%)') + '. ' }), verdict]),
      bar,
      room != null ? h('p', { class: 'hint', text: 'At the current average of ' + bytes(Math.round(perFrame)) + ' per frame, about ' + room.toLocaleString('en-IN') + ' more frames fit before the 80% mark.' }) : null,
      h('p', { class: 'hint', text: 'This page can only see stored data. Check the other limits on the Firestore Usage page once a week:' }),
      h('ul', { class: 'link-list' }, [
        h('li', { text: 'Reads: 50,000 a day. Upgrade when the busiest days pass about 35,000.' }),
        h('li', { text: 'Writes: 20,000 a day (far away: saving a frame is 2–5).' }),
        h('li', { text: 'Downloads: 10 GB a month (about 1 MB per new visitor). Upgrade when a month passes about 7 GB.' }),
        h('li', null, [h('a', { href: 'https://console.firebase.google.com/project/' + pid + '/firestore/databases/-default-/usage', target: '_blank', rel: 'noopener', text: 'Open Firestore Usage' })])
      ]),
      h('p', { class: 'hint', text: 'On the free plan nothing is ever charged: if a limit is reached, Firestore refuses until it resets (reads and writes daily at about 13:30 IST, downloads monthly), and customers see frames their phone saved earlier, or a “couldn’t load” message.' })
    ]);
  }

  // ---------- shops ----------
  function shops() {
    var filt = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Show shops' });
    [['pending', 'Waiting for review'], ['approved', 'Approved'], ['suspended', 'Suspended'], ['rejected', 'Rejected'], ['', 'All']].forEach(function (f) {
      filt.appendChild(h('button', { type: 'button', class: 'tag-chip' + (st.shopFilter === f[0] ? ' active' : ''), 'aria-pressed': st.shopFilter === f[0] ? 'true' : 'false', text: f[1], onclick: function () { st.shopFilter = f[0]; shops(); } }));
    });
    var list = h('div', { class: 'admin-list' }, [msg('Loading…')]);
    frame([filt, list]);
    B.adminListShops(st.shopFilter || null).then(function (items) {
      list.innerHTML = '';
      if (!items.length) { list.appendChild(h('p', { class: 'hint', text: 'No shops here.' })); return; }
      items.forEach(function (s) { st.shops[s.id] = s; list.appendChild(shopRow(s)); });
    }).catch(function (e) { list.innerHTML = ''; list.appendChild(msg('Could not load shops.', 'message error')); console.error(e); });
  }
  function shopRow(s) {
    var details = h('div', { class: 'admin-details', hidden: true });
    var row = h('article', { class: 'admin-item' }, [
      h('div', { class: 'admin-item-head' }, [
        h('div', null, [h('h3', { text: s.name }), h('p', { class: 'hint', text: [s.city, 'applied ' + when(s.createdMs)].filter(Boolean).join(' · ') })]),
        h('span', { class: 'pill ' + ({ approved: 'ok', pending: 'warn', suspended: 'bad', rejected: 'bad' }[s.status] || ''), text: s.status })
      ]),
      s.statusReason ? h('p', { class: 'hint', text: 'Reason: ' + s.statusReason }) : null,
      h('div', { class: 'row' }, actionsFor(s).concat([
        h('button', { type: 'button', class: 'btn secondary small', text: 'Details', onclick: function () {
          details.hidden = !details.hidden;
          if (!details.hidden && !details.dataset.loaded) loadShopDetails(s, details);
        } }),
        h('a', { class: 'btn secondary small', href: '#/admin/products', onclick: function () { st.prodFilter = 'shop:' + s.id; }, text: 'Listings' }),
        s.status === 'approved' || s.status === 'pending' ? h('button', { type: 'button', class: 'btn primary small', text: 'Manage frames', onclick: function () {
          ctx.setActingShop(s.id); ctx.navigate({ name: 'partner', id: 'products' });
        } }) : null,
        s.status === 'approved' ? h('a', { class: 'btn secondary small', href: '#/shop/' + encodeURIComponent(s.id), text: 'Public page' }) : null
      ])),
      details
    ]);
    return row;
  }
  function actionsFor(s) {
    var out = [];
    function btn(label, status, cls, needReason, body) {
      out.push(h('button', { type: 'button', class: 'btn small ' + cls, text: label, onclick: function () {
        ask(label + ': ' + s.name, body, label, cls === 'danger', needReason).then(function (reason) {
          if (reason == null) return;
          B.adminSetShopStatus(s, status, reason).then(function (res) {
            ctx.toast(s.name + ': ' + status + (res.changed ? ' (' + res.changed + ' listings updated)' : ''));
            shops();
          }).catch(fail);
        });
      } }));
    }
    if (s.status === 'pending') { btn('Approve', 'approved', 'primary', false, 'The shop can publish, and its ready published products appear to customers.'); btn('Reject', 'rejected', 'danger', true, 'The shop sees the reason and can correct and re-apply.'); }
    if (s.status === 'approved') btn('Suspend', 'suspended', 'danger', true, 'All its listings disappear from the site at once, and the shop can’t change its catalogue.');
    if (s.status === 'suspended') btn('Reactivate', 'approved', 'primary', false, 'Its ready published listings appear again.');
    if (s.status === 'rejected') btn('Approve anyway', 'approved', 'secondary', false, 'Approve without waiting for a new application.');
    return out;
  }
  function loadShopDetails(s, el) {
    el.dataset.loaded = '1';
    el.appendChild(msg('Loading…'));
    Promise.all([B.getShopPrivate(s.id).catch(function () { return null; }), B.adminShopUsage(s.id), B.adminListAcceptances(null).catch(function () { return []; })]).then(function (r) {
      el.innerHTML = '';
      var p = r[0] || {}, u = r[1] || {};
      var acc = r[2].filter(function (a) { return a.uid === s.id; });
      var dl = h('dl', { class: 'attr-list' });
      function row(k, v) { if (!v && v !== 0) return; dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', { text: String(v) })); }
      row('Owner', p.ownerName); row('Owner phone', p.ownerPhone); row('GSTIN', p.gstin); row('Note to admin', p.note);
      row('Public phone', s.phone); row('WhatsApp', s.whatsapp); row('Email', s.email); row('Website', s.website); row('Address', s.address);
      row('Products', u.n); row('Stored images', bytes(u.bytes));
      row('Accepted', acc.map(function (a) { return a.doc + ' v' + a.version + ' (' + when(a.acceptedMs) + ')'; }).join('; ') || 'none on record');
      row('Shop id', s.id);
      el.appendChild(dl);
      el.appendChild(shopTryOns(s));
      if (s.status === 'approved') el.appendChild(qrPanel(s, ctx.t, ctx.toast));
    }).catch(function (e) { el.innerHTML = ''; el.appendChild(msg('Could not load details.', 'message error')); console.error(e); });
  }

  // ---------- listings ----------
  function products(after) {
    var filt = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Show listings' });
    [['', 'Recently changed'], ['suspended', 'Suspended'], ['failed', 'Try-on failed']].forEach(function (f) {
      filt.appendChild(h('button', { type: 'button', class: 'tag-chip' + (st.prodFilter === f[0] ? ' active' : ''), 'aria-pressed': st.prodFilter === f[0] ? 'true' : 'false', text: f[1], onclick: function () { st.prodFilter = f[0]; products(); } }));
    });
    if (st.prodFilter.indexOf('shop:') === 0) filt.appendChild(h('button', { type: 'button', class: 'tag-chip active', text: 'Shop: ' + ((st.shops[st.prodFilter.slice(5)] || {}).name || st.prodFilter.slice(5)) + ' ×', onclick: function () { st.prodFilter = ''; products(); } }));
    var list = h('div', { class: 'admin-list' }, [msg('Loading…')]);
    frame([filt, list]);
    B.adminListProducts(st.prodFilter, after || null).then(function (pg) {
      list.innerHTML = '';
      if (!pg.items.length) { list.appendChild(h('p', { class: 'hint', text: 'No listings here.' })); return; }
      var shopIds = {};
      pg.items.forEach(function (p) { shopIds[p.shopId] = true; });
      Promise.all(Object.keys(shopIds).map(function (id) { return st.shops[id] ? Promise.resolve(st.shops[id]) : B.getShop(id).then(function (s) { if (s) st.shops[id] = s; return s; }).catch(function () { return null; }); })).then(function () {
        pg.items.forEach(function (p) { list.appendChild(productRow(p)); });
        if (pg.more) list.appendChild(h('button', { type: 'button', class: 'btn secondary', text: 'Next page', onclick: function () { products(pg.last); } }));
      });
    }).catch(function (e) { list.innerHTML = ''; list.appendChild(msg('Could not load listings. (A new filter may need its index; firebase deploy --only firestore:indexes.)', 'message error')); console.error(e); });
  }
  function productRow(p) {
    var shop = st.shops[p.shopId];
    var v = p.pricing ? priceView(p.pricing) : null;
    var state = p.moderation && p.moderation.state === 'suspended' ? ['suspended', 'bad'] : p.public ? ['live', 'ok'] : [p.status, 'muted'];
    var thumb = p.images && B.imgSrc(p.images.thumb) ? h('img', { src: B.imgSrc(p.images.thumb), alt: '', width: '64', height: '64', loading: 'lazy' }) : h('span', { class: 'no-thumb', 'aria-hidden': 'true' });
    var acts = [];
    if (p.moderation && p.moderation.state === 'suspended') {
      acts.push(h('button', { type: 'button', class: 'btn primary small', text: 'Restore', onclick: function () {
        B.adminModerateProduct(p, 'ok', '', shop ? shop.status : null).then(function () { ctx.toast('Listing restored.'); products(); }).catch(fail);
      } }));
    } else {
      acts.push(h('button', { type: 'button', class: 'btn secondary small', text: 'Suspend', onclick: function () {
        ask('Suspend this listing', 'It disappears from the site. The shop sees the reason and can fix the listing; only you can restore it.', 'Suspend', true, true).then(function (reason) {
          if (reason == null) return;
          B.adminModerateProduct(p, 'suspended', reason, shop ? shop.status : null).then(function () { ctx.toast('Listing suspended.'); products(); }).catch(fail);
        });
      } }));
    }
    acts.push(h('button', { type: 'button', class: 'btn danger small', text: 'Remove', onclick: function () {
      ask('Remove this listing permanently', 'The product and its stored photos are deleted. This can’t be undone.', 'Remove', true, true).then(function (reason) {
        if (reason == null) return;
        B.adminDeleteProduct(p, reason).then(function () { ctx.forgetProduct(p.id); ctx.toast('Listing removed.'); products(); }).catch(fail);
      });
    } }));
    acts.push(h('button', { type: 'button', class: 'btn secondary small', text: 'View', onclick: function () { ctx.previewProduct(p); } }));
    return h('article', { class: 'admin-item' }, [
      h('div', { class: 'admin-item-head' }, [
        h('div', { class: 'dash-frame' }, [thumb, h('span', null, [h('strong', { text: p.name || '(untitled)' }), h('span', { class: 'hint block', text: (shop ? shop.name : p.shopId) + (p.sku ? ' · ' + p.sku : '') + ' · ' + (v ? formatINR(v.pay.finalPaise, 'en') : 'no price') })])]),
        h('span', { class: 'pill ' + state[1], text: state[0] })
      ]),
      h('p', { class: 'hint', text: 'Try-on: ' + ((p.tryOn && p.tryOn.status) || 'none') + (p.tryOn && p.tryOn.error ? ' (' + p.tryOn.error + ')' : '') + ' · changed ' + when(p.updatedMs) + (p.moderation && p.moderation.reason ? ' · reason: ' + p.moderation.reason : '') }),
      h('div', { class: 'row' }, acts)
    ]);
  }

  // ---------- reports ----------
  var REASONS = { wrong_price: 'Wrong price', wrong_info: 'Wrong details', unavailable: 'Not available', inappropriate: 'Inappropriate', counterfeit: 'Counterfeit or infringing', other: 'Other' };
  function reports() {
    var filt = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Show reports' });
    [['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']].forEach(function (f) {
      filt.appendChild(h('button', { type: 'button', class: 'tag-chip' + (st.reportStatus === f[0] ? ' active' : ''), 'aria-pressed': st.reportStatus === f[0] ? 'true' : 'false', text: f[1], onclick: function () { st.reportStatus = f[0]; reports(); } }));
    });
    var list = h('div', { class: 'admin-list' }, [msg('Loading…')]);
    frame([filt, h('p', { class: 'hint', text: 'Reports are anonymous: they carry no name or contact details, only a random device id used to limit them to one a minute.' }), list]);
    B.adminListReports(st.reportStatus).then(function (items) {
      list.innerHTML = '';
      if (!items.length) { list.appendChild(h('p', { class: 'hint', text: 'Nothing here.' })); return; }
      items.forEach(function (r) {
        var acts = [];
        if (r.status === 'open') {
          ['resolved', 'dismissed'].forEach(function (s) {
            acts.push(h('button', { type: 'button', class: 'btn small ' + (s === 'resolved' ? 'primary' : 'secondary'), text: s === 'resolved' ? 'Mark resolved' : 'Dismiss', onclick: function () {
              var note = window.prompt('Note for the record (optional):', '') || '';
              B.adminResolveReport(r, s, note.trim().slice(0, 300)).then(function () { ctx.toast('Report ' + s + '.'); reports(); }).catch(fail);
            } }));
          });
        }
        acts.push(h('button', { type: 'button', class: 'btn secondary small', text: 'Open listing', onclick: function () {
          B.getProduct(r.productId).then(function (p) { if (p) ctx.previewProduct(p); else ctx.toast('That listing no longer exists.'); }).catch(fail);
        } }));
        list.appendChild(h('article', { class: 'admin-item' }, [
          h('div', { class: 'admin-item-head' }, [h('div', null, [h('h3', { text: REASONS[r.reason] || r.reason }), h('p', { class: 'hint', text: when(r.createdMs) + ' · listing ' + r.productId + ' · shop ' + ((st.shops[r.shopId] || {}).name || r.shopId) })]), h('span', { class: 'pill ' + (r.status === 'open' ? 'warn' : 'muted'), text: r.status })]),
          r.note ? h('p', { class: 'report-note', text: '“' + r.note + '”' }) : null,
          r.resolution ? h('p', { class: 'hint', text: 'Note: ' + r.resolution }) : null,
          h('div', { class: 'row' }, acts)
        ]));
      });
    }).catch(function (e) { list.innerHTML = ''; list.appendChild(msg('Could not load reports.', 'message error')); console.error(e); });
  }

  // ---------- legal ----------
  function legal() {
    var body = h('div', null, [msg('Loading…')]);
    frame([body]);
    B.getConfig('legal').then(function (cfg) {
      body.innerHTML = '';
      var t = h('table', { class: 'dash-table' }, [h('thead', null, [h('tr', null, [h('th', { text: 'Document' }), h('th', { text: 'On this site' }), h('th', { text: 'Required now' }), h('th', { text: 'Page' })])])]);
      var tb = h('tbody');
      var differs = false;
      [['retailerTerms', 'Partner shop terms'], ['privacy', 'Privacy policy'], ['customerTerms', 'Customer terms (no acceptance needed)']].forEach(function (d) {
        var site = LEGAL_DOCS[d[0]], req = cfg && cfg[d[0]];
        if (d[0] !== 'customerTerms' && (!req || req.version !== site.version)) differs = true;
        tb.appendChild(h('tr', null, [h('td', { text: d[1] }), h('td', { class: 'mono', text: 'v' + site.version + ' (' + site.date + ')' }), h('td', { class: 'mono', text: req ? 'v' + req.version + ' (' + req.date + ')' : 'not set' }), h('td', null, [h('a', { href: site.url, target: '_blank', rel: 'noopener', text: 'Open' })])]));
      });
      t.appendChild(tb);
      body.appendChild(h('section', { class: 'panel' }, [
        h('h2', { class: 'panel-title', text: 'Document versions' }),
        h('p', { class: 'hint', text: 'The text lives in the repository (legal/*.html, versions in legal/versions.js). After publishing a new version, require it here: partner shops must then accept it before changing their catalogue. Acceptance records are kept per version and can’t be edited or deleted.' }),
        h('div', { class: 'table-wrap' }, [t]),
        differs ? h('button', { type: 'button', class: 'btn primary', text: 'Require the versions on this site', onclick: function () {
          ask('Require new versions', 'Every partner shop will be asked to accept the new versions before they can change their catalogue.', 'Require', false, false).then(function (ok) {
            if (ok == null) return;
            B.saveConfig('legal', { retailerTerms: pick(LEGAL_DOCS.retailerTerms), customerTerms: pick(LEGAL_DOCS.customerTerms), privacy: pick(LEGAL_DOCS.privacy) })
              .then(function () { return B.adminAudit('legal.require', 'config', 'legal', 'retailerTerms v' + LEGAL_DOCS.retailerTerms.version + ', privacy v' + LEGAL_DOCS.privacy.version); })
              .then(function () { ctx.toast('New versions required.'); legal(); }).catch(fail);
          });
        } }) : h('p', { class: 'hint', text: 'The required versions match the site.' })
      ]));
      var recWrap = h('section', { class: 'panel' }, [h('h2', { class: 'panel-title', text: 'Acceptance records (latest 300)' }), msg('Loading…')]);
      body.appendChild(recWrap);
      B.adminListAcceptances(null).then(function (items) {
        recWrap.lastChild.remove();
        if (!items.length) { recWrap.appendChild(h('p', { class: 'hint', text: 'None yet.' })); return; }
        var tt = h('table', { class: 'dash-table' }, [h('thead', null, [h('tr', null, [h('th', { text: 'Account (shop id)' }), h('th', { text: 'Document' }), h('th', { text: 'Version' }), h('th', { text: 'Accepted' })])])]);
        var b = h('tbody');
        items.forEach(function (a) { b.appendChild(h('tr', null, [h('td', { class: 'mono', text: ((st.shops[a.uid] || {}).name ? st.shops[a.uid].name + ' · ' : '') + a.uid }), h('td', { text: a.doc }), h('td', { class: 'mono', text: a.version }), h('td', { text: when(a.acceptedMs) })])); });
        tt.appendChild(b);
        recWrap.appendChild(h('div', { class: 'table-wrap' }, [tt]));
      }).catch(function (e) { recWrap.lastChild.remove(); recWrap.appendChild(msg('Could not load records.', 'message error')); console.error(e); });
    }).catch(function (e) { body.innerHTML = ''; body.appendChild(msg('Could not load.', 'message error')); console.error(e); });
  }

  // ---------- settings ----------
  function settings() {
    var body = h('div', null, [msg('Loading…')]);
    frame([body]);
    Promise.all([B.getConfig('platform'), B.getConfig('demo')]).then(function (r) {
      var p = r[0] || {}, d = r[1] || {};
      body.innerHTML = '';
      var open = h('input', { type: 'checkbox', id: 'cfgOpen', checked: p.applicationsOpen !== false ? true : null });
      var ann = h('textarea', { id: 'cfgAnn', rows: '2', maxlength: '300' }, [p.announcement || '']);
      var max = h('input', { id: 'cfgMax', type: 'number', min: '1', max: '5000', value: String(p.maxProductsPerShop || 1000) });
      var mail = h('input', { id: 'cfgMail', type: 'email', maxlength: '100', value: p.supportEmail || '' });
      body.appendChild(h('form', { class: 'panel', onsubmit: function (e) {
        e.preventDefault();
        var m = parseInt(max.value, 10);
        if (!(m >= 1 && m <= 5000)) { ctx.toast('The product limit must be 1–5000.', 'error'); return; }
        B.saveConfig('platform', { applicationsOpen: open.checked, announcement: ann.value.trim().slice(0, 300), maxProductsPerShop: m, supportEmail: mail.value.trim().slice(0, 100) })
          .then(function () { return B.adminAudit('platform.settings', 'config', 'platform'); })
          .then(function () { ctx.toast('Settings saved.'); }).catch(fail);
      } }, [
        h('h2', { class: 'panel-title', text: 'Platform' }),
        h('label', { class: 'check-row' }, [open, h('span', { text: 'Accept new shop applications' })]),
        h('div', { class: 'field' }, [h('label', { for: 'cfgAnn', text: 'Announcement shown at the top of every page (leave empty for none)' }), ann]),
        h('div', { class: 'field' }, [h('label', { for: 'cfgMax', text: 'Product limit per shop (the dashboard stops new products at this number)' }), max]),
        h('div', { class: 'field' }, [h('label', { for: 'cfgMail', text: 'Support email (for your records; the legal pages have their own contact details)' }), mail]),
        h('button', { type: 'submit', class: 'btn primary', text: 'Save' })
      ]));
      var hidden = {};
      (d.hidden || []).forEach(function (id) { hidden[id] = true; });
      var boxes = ctx.demoFrames.map(function (f) {
        var cb = h('input', { type: 'checkbox', checked: hidden[f.id] ? null : true });
        cb.dataset.id = f.id;
        return h('label', { class: 'check-row demo-toggle' }, [cb, h('img', { src: f.thumb, alt: '', width: '64', height: '64' }), h('span', { text: ctx.demoName(f.id) })]);
      });
      body.appendChild(h('form', { class: 'panel', onsubmit: function (e) {
        e.preventDefault();
        var off = boxes.map(function (b) { return b.querySelector('input'); }).filter(function (i) { return !i.checked; }).map(function (i) { return i.dataset.id; });
        if (off.length === boxes.length) { ctx.toast('Keep at least one demo frame.', 'error'); return; }
        B.saveConfig('demo', { hidden: off }).then(function () { return B.adminAudit('demo.settings', 'config', 'demo', off.join(',')); }).then(function () { ctx.toast('Demo frames saved.'); }).catch(fail);
      } }, [h('h2', { class: 'panel-title', text: 'Demo frames' }), h('p', { class: 'hint', text: 'The six demo frames ship with the site (demo/). Choose which ones the public demo shows.' })].concat(boxes).concat([h('button', { type: 'submit', class: 'btn primary', text: 'Save' })])));
    }).catch(function (e) { body.innerHTML = ''; body.appendChild(msg('Could not load settings.', 'message error')); console.error(e); });
  }

  // ---------- audit log ----------
  function audit() {
    var body = h('div', null, [msg('Loading…')]);
    frame([h('p', { class: 'hint', text: 'Admin actions, newest first. Entries can’t be edited or deleted. No customer data is ever logged.' }), body]);
    B.adminListAudit().then(function (items) {
      body.innerHTML = '';
      if (!items.length) { body.appendChild(h('p', { class: 'hint', text: 'Nothing yet.' })); return; }
      var tt = h('table', { class: 'dash-table' }, [h('thead', null, [h('tr', null, [h('th', { text: 'When' }), h('th', { text: 'Action' }), h('th', { text: 'Target' }), h('th', { text: 'Note' })])])]);
      var b = h('tbody');
      items.forEach(function (a) { b.appendChild(h('tr', null, [h('td', { text: when(a.atMs) }), h('td', { class: 'mono', text: a.action }), h('td', { class: 'mono', text: a.targetType + ' ' + a.targetId }), h('td', { text: a.note || '' })])); });
      tt.appendChild(b);
      body.appendChild(h('div', { class: 'table-wrap' }, [tt]));
    }).catch(function (e) { body.innerHTML = ''; body.appendChild(msg('Could not load the log.', 'message error')); console.error(e); });
  }

  return { show: show, rerender: function () { if (st.route) show(st.route); } };
}
