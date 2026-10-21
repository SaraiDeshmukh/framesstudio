// A shop's QR code: customers scan it with their phone camera and the site
// opens on that shop's frames, with try-on (the address ends in ?qr=1, which
// keeps that browser tab on the shop, like the in-store kiosk). The code is
// drawn here in the browser (vendor/qrcode-generator.mjs), so no outside QR
// service ever sees the link, and it costs nothing to make or print.
//
// Scanning costs no more than any visit to the shop's page (about 10 reads on
// a phone the first time, almost none again on the same phone; see COSTS.md).

import qrcode from './vendor/qrcode-generator.mjs';
import { siteUrl } from './firebase-config.js';

// The address the QR code opens. Always the main site (from firebase-config.js),
// so a code printed from a preview or test copy keeps working.
export function siteBase() {
  var s = typeof siteUrl === 'string' && /^https:\/\//.test(siteUrl) ? siteUrl : location.origin + location.pathname;
  return s.replace(/index\.html$/, '').replace(/\/?$/, '/');
}
export function shopQrLink(shopId, base) {
  return (base || siteBase()) + '#/shop/' + encodeURIComponent(shopId) + '?qr=1';
}
// The same address on the copy of the site that's open now (for testing a preview).
export function localShopLink(shopId) {
  return shopQrLink(shopId, (location.origin + location.pathname).replace(/index\.html$/, '').replace(/\/?$/, '/'));
}

// The QR modules (true = dark) for `text`. Error correction level M (15%),
// so a slightly scuffed or creased printout still scans.
export function qrMatrix(text) {
  var q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  var n = q.getModuleCount(), rows = [];
  for (var r = 0; r < n; r++) {
    var row = [];
    for (var c = 0; c < n; c++) row.push(q.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

// An <svg> element: crisp at any size, prints sharply. `quiet` is the white
// margin in modules (4 is the standard).
export function qrSvg(text, label, quiet) {
  var m = qrMatrix(text), n = m.length, qz = quiet == null ? 4 : quiet, size = n + qz * 2;
  var d = '';
  for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (m[r][c]) d += 'M' + (c + qz) + ' ' + (r + qz) + 'h1v1h-1z';
  var ns = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  if (label) svg.setAttribute('aria-label', label);
  var bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);
  var p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d); p.setAttribute('fill', '#000000');
  svg.appendChild(p);
  return svg;
}

// A PNG of the code with the shop's name underneath (for WhatsApp, a print
// shop, or a sticker), about `px` pixels wide.
export function qrPngBlob(text, caption, px) {
  var m = qrMatrix(text), n = m.length, qz = 4;
  var cell = Math.max(4, Math.floor((px || 1200) / (n + qz * 2)));
  var w = (n + qz * 2) * cell, capH = caption ? Math.round(cell * 7) : 0;
  var c = document.createElement('canvas');
  c.width = w; c.height = w + capH;
  var g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000000';
  for (var r = 0; r < n; r++) for (var k = 0; k < n; k++) if (m[r][k]) g.fillRect((k + qz) * cell, (r + qz) * cell, cell, cell);
  if (caption) {
    var fs = Math.round(cell * 3.2);
    g.font = '600 ' + fs + 'px system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans Devanagari", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    var text2 = caption;
    while (g.measureText(text2).width > w - cell * 4 && text2.length > 4) text2 = text2.slice(0, -2);
    if (text2 !== caption) text2 = text2.replace(/.$/, '…');
    g.fillText(text2, w / 2, w + capH / 2 - cell);
  }
  return new Promise(function (resolve, reject) { c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Could not make the picture')); }, 'image/png'); });
}

export function fileSlug(name) {
  return String(name || 'shop').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// The panel for the shop dashboard (and the admin's shop page): the code, its
// address, and Download / Print / Copy. `t` translates; `toast` reports.
export function qrPanel(shop, t, toast) {
  var link = shopQrLink(shop.id);
  var box = el('section', 'panel qr-panel');
  box.appendChild(el('h2', 'panel-title', t('qr.title')));
  box.appendChild(el('p', 'hint', t('qr.text')));
  var row = el('div', 'qr-row');
  var fig = el('figure', 'qr-figure');
  fig.appendChild(qrSvg(link, t('qr.alt', { shop: shop.name })));
  row.appendChild(fig);
  var side = el('div', 'qr-side');
  var code = el('code', 'kiosk-link', link);
  side.appendChild(code);
  var btns = el('div', 'row');
  var dl = el('button', 'btn primary', t('qr.download'));
  dl.type = 'button';
  dl.addEventListener('click', function () {
    dl.disabled = true;
    qrPngBlob(link, shop.name, 1200).then(function (b) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'qr-' + fileSlug(shop.name) + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    }).catch(function (e) { console.error(e); toast(t('common.loadFailed'), 'error'); }).then(function () { dl.disabled = false; });
  });
  var pr = el('button', 'btn secondary', t('qr.print'));
  pr.type = 'button';
  pr.addEventListener('click', function () { printPoster(shop, link, t); });
  var cp = el('button', 'btn secondary', t('qr.copy'));
  cp.type = 'button';
  cp.addEventListener('click', function () {
    var done = function () { toast(t('qr.copied')); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { selectText(code); });
    else selectText(code);
  });
  var open = el('a', 'btn secondary', t('qr.open'));
  open.href = link; open.target = '_blank'; open.rel = 'noopener';
  btns.appendChild(dl); btns.appendChild(pr); btns.appendChild(cp); btns.appendChild(open);
  side.appendChild(btns);
  side.appendChild(el('p', 'hint', t('qr.tips')));
  // on a preview or test copy, the printed code still points to the main site
  var here = localShopLink(shop.id);
  if (here !== link) {
    var test = el('p', 'hint qr-test');
    test.appendChild(document.createTextNode(t('qr.testHere') + ' '));
    var ta = el('a', null, here);
    ta.href = here; ta.target = '_blank'; ta.rel = 'noopener';
    test.appendChild(ta);
    side.appendChild(test);
  }
  row.appendChild(side);
  box.appendChild(row);
  return box;
}

function selectText(node) {
  try { var r = document.createRange(); r.selectNodeContents(node); var s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) { /* ignore */ }
}

// A one-page poster (A4 or A5) for the counter or the window: the shop's name,
// the code, what to do in English, Hindi and Marathi, and the privacy promise.
export function printPoster(shop, link, t) {
  var old = document.getElementById('qrPoster');
  if (old) old.remove();
  var p = el('div', 'qr-poster');
  p.id = 'qrPoster';
  p.appendChild(el('p', 'qr-poster-shop', shop.name));
  if (shop.city) p.appendChild(el('p', 'qr-poster-city', shop.city));
  var heads = el('div', 'qr-poster-heads');
  [['en', 'qr.poster.head.en'], ['hi', 'qr.poster.head.hi'], ['mr', 'qr.poster.head.mr']].forEach(function (x) {
    var hd = el('p', 'qr-poster-head', t(x[1]));
    hd.lang = x[0];
    heads.appendChild(hd);
  });
  p.appendChild(heads);
  var q = el('div', 'qr-poster-code');
  q.appendChild(qrSvg(link, t('qr.alt', { shop: shop.name })));
  p.appendChild(q);
  var steps = el('ol', 'qr-poster-steps');
  ['qr.poster.step1', 'qr.poster.step2', 'qr.poster.step3'].forEach(function (k) { steps.appendChild(el('li', null, t(k))); });
  p.appendChild(steps);
  p.appendChild(el('p', 'qr-poster-privacy', t('qr.poster.privacy')));
  p.appendChild(el('p', 'qr-poster-link', link.replace(/^https:\/\//, '')));
  document.body.appendChild(p);
  document.documentElement.classList.add('printing-poster');
  function done() {
    document.documentElement.classList.remove('printing-poster');
    window.removeEventListener('afterprint', done);
  }
  window.addEventListener('afterprint', done);
  setTimeout(function () { window.print(); }, 50);
}
