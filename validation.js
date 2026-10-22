// What a shop profile and a product must look like, mirrored from
// firestore.rules so the dashboard can say what's wrong before saving (the
// rules still decide). No DOM; unit-tested in tests/validation.test.mjs.

import { pricingProblems } from './pricing.js';
import { cleanSize } from './frame-size.js';

export var PRODUCT_STATUS = ['draft', 'published', 'archived'];
export var AVAILABILITY = ['in_stock', 'low_stock', 'out_of_stock', 'on_request'];
export var FRAME_TYPES = ['eyeglasses', 'sunglasses', 'reading', 'computer', 'sports'];
export var SHOP_STATUS = ['pending', 'approved', 'rejected', 'suspended'];
export var REPORT_REASONS = ['wrong_price', 'wrong_info', 'unavailable', 'inappropriate', 'counterfeit', 'other'];
export var TAG_VALUES = {
  shape: ['round', 'square', 'catseye', 'aviator', 'browline', 'rectangle', 'oval'],
  color: ['black', 'tortoise', 'gold', 'silver', 'clear', 'navy', 'red'],
  gender: ['womens', 'mens', 'unisex', 'kids'],
  rim: ['fullrim', 'semirimless', 'rimless']
};
export var LIMITS = {
  name: 80, sku: 40, brand: 40, colourName: 40, material: 40, description: 1000, link: 300, freeTags: 12,
  shopName: 80, city: 60, address: 200, email: 100, about: 500, ownerName: 80, note: 500, statusReason: 300
};

var GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
var PHONE_RE = /^[+0-9 ()-]{6,20}$/;
var HTTPS_RE = /^https:\/\/[^\s<>"]+$/;
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function tooLong(v, max) { return typeof v === 'string' && v.length > max; }
function blank(v) { return v == null || String(v).trim() === ''; }

export function isHttpsUrl(v) { return typeof v === 'string' && v.length >= 9 && v.length <= 300 && HTTPS_RE.test(v); }
export function isPhone(v) { return typeof v === 'string' && PHONE_RE.test(v); }
export function isGstin(v) { return typeof v === 'string' && GSTIN_RE.test(v); }

// ---------- shops ----------

// Problems with the public profile: [{ field, code }]
export function shopProblems(s) {
  var out = [];
  if (blank(s.name) || String(s.name).trim().length < 2) out.push({ field: 'name', code: 'shop.nameMissing' });
  else if (tooLong(s.name, LIMITS.shopName)) out.push({ field: 'name', code: 'common.tooLong' });
  if (blank(s.city)) out.push({ field: 'city', code: 'shop.cityMissing' });
  else if (tooLong(s.city, LIMITS.city)) out.push({ field: 'city', code: 'common.tooLong' });
  if (tooLong(s.address, LIMITS.address)) out.push({ field: 'address', code: 'common.tooLong' });
  if (tooLong(s.about, LIMITS.about)) out.push({ field: 'about', code: 'common.tooLong' });
  if (!blank(s.email) && (!EMAIL_RE.test(s.email) || tooLong(s.email, LIMITS.email))) out.push({ field: 'email', code: 'shop.emailInvalid' });
  if (!blank(s.phone) && !isPhone(s.phone)) out.push({ field: 'phone', code: 'shop.phoneInvalid' });
  if (!blank(s.whatsapp) && !isPhone(s.whatsapp)) out.push({ field: 'whatsapp', code: 'shop.phoneInvalid' });
  if (!blank(s.website) && !isHttpsUrl(s.website)) out.push({ field: 'website', code: 'common.httpsOnly' });
  return out;
}

export function shopPrivateProblems(p) {
  var out = [];
  if (blank(p.ownerName)) out.push({ field: 'ownerName', code: 'shop.ownerMissing' });
  else if (tooLong(p.ownerName, LIMITS.ownerName)) out.push({ field: 'ownerName', code: 'common.tooLong' });
  if (!blank(p.ownerPhone) && !isPhone(p.ownerPhone)) out.push({ field: 'ownerPhone', code: 'shop.phoneInvalid' });
  if (!blank(p.gstin) && !isGstin(p.gstin)) out.push({ field: 'gstin', code: 'shop.gstinInvalid' });
  if (tooLong(p.note, LIMITS.note)) out.push({ field: 'note', code: 'common.tooLong' });
  return out;
}

// Trims and drops empty optional fields (Firestore gets only what was filled).
export function cleanShop(s) {
  var out = { name: String(s.name || '').trim(), city: String(s.city || '').trim() };
  ['address', 'phone', 'whatsapp', 'email', 'website', 'about'].forEach(function (k) {
    var v = s[k] == null ? '' : String(s[k]).trim();
    out[k] = v;
  });
  return out;
}

// A WhatsApp chat link for a shop number (Indian numbers without a country
// code get +91). null if the number can't be used.
export function whatsappLink(number, text) {
  if (!number) return null;
  var d = String(number).replace(/[^0-9+]/g, '');
  if (d.charAt(0) === '+') d = d.slice(1);
  else if (d.length === 11 && d.charAt(0) === '0') d = '91' + d.slice(1);
  else if (d.length === 10) d = '91' + d;
  if (!/^[0-9]{10,15}$/.test(d)) return null;
  return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '');
}

export function telLink(number) {
  if (!number) return null;
  var d = String(number).replace(/[^0-9+]/g, '');
  return d.length >= 6 ? 'tel:' + d : null;
}

// ---------- products ----------

// Problems that stop a product from being saved at all.
export function productProblems(p) {
  var out = [];
  if (typeof p.name !== 'string') out.push({ field: 'name', code: 'product.nameMissing' });
  else if (tooLong(p.name, LIMITS.name)) out.push({ field: 'name', code: 'common.tooLong' });
  ['sku', 'brand', 'colourName', 'material'].forEach(function (k) { if (tooLong(p[k], LIMITS[k])) out.push({ field: k, code: 'common.tooLong' }); });
  if (tooLong(p.description, LIMITS.description)) out.push({ field: 'description', code: 'common.tooLong' });
  if (p.frameType != null && FRAME_TYPES.indexOf(p.frameType) === -1) out.push({ field: 'frameType', code: 'common.invalid' });
  if (p.availability != null && AVAILABILITY.indexOf(p.availability) === -1) out.push({ field: 'availability', code: 'common.invalid' });
  if (!blank(p.link) && !isHttpsUrl(p.link)) out.push({ field: 'link', code: 'common.httpsOnly' });
  if (PRODUCT_STATUS.indexOf(p.status) === -1) out.push({ field: 'status', code: 'common.invalid' });
  var tg = p.tags || {};
  Object.keys(TAG_VALUES).forEach(function (k) { if (tg[k] != null && TAG_VALUES[k].indexOf(tg[k]) === -1) out.push({ field: 'tags.' + k, code: 'common.invalid' }); });
  if (tg.free && tg.free.length > LIMITS.freeTags) out.push({ field: 'tags.free', code: 'product.tooManyTags' });
  if (p.size && cleanSize(p.size) === null && (p.size.eye || p.size.bridge || p.size.temple)) out.push({ field: 'size', code: 'product.sizeInvalid' });
  if (p.pricing) pricingProblems(p.pricing, false).forEach(function (c) { out.push({ field: 'pricing', code: c }); });
  return out;
}

// What's still missing before a product can be shown to customers. The same
// conditions as `publishable()` in firestore.rules.
export function publishBlockers(p) {
  var out = [];
  if (!p.name || p.name.trim().length < 2) out.push('publish.needName');
  // a price is optional (customers are asked to contact the shop), but one that
  // is set must be valid and have its tax treatment confirmed
  if (p.pricing && pricingProblems(p.pricing, true).length) out.push(p.pricing.confirmed === true ? 'publish.needPrice' : 'publish.needTaxConfirm');
  if (!p.availability) out.push('publish.needAvailability');
  var im = p.images || {};
  if (!im.thumb || !(im.thumb.url || im.thumb.data)) out.push('publish.needPhoto');
  var st = p.tryOn && p.tryOn.status;
  if (st === 'ready' && (!im.cutout || !im.manifest)) out.push('publish.tryOnIncomplete');
  else if (st === 'failed' || st === 'pending') out.push('publish.tryOnUnresolved');
  if (p.moderation && p.moderation.state === 'suspended') out.push('publish.suspended');
  return out;
}

export function isPublishable(p) {
  return p.status === 'published' && (!p.moderation || p.moderation.state === 'ok') && publishBlockers(p).length === 0;
}

// The `public` flag the rules will insist on.
export function shouldBePublic(p, shopStatus) {
  return isPublishable(p) && shopStatus === 'approved';
}

// Free-text tags: trimmed, lower-case, no duplicates, at most 12 of 30 chars.
export function cleanFreeTags(list) {
  var seen = {}, out = [];
  (list || []).forEach(function (t) {
    var v = String(t || '').trim().toLowerCase().slice(0, 30);
    if (v && !seen[v]) { seen[v] = 1; out.push(v); }
  });
  return out.slice(0, LIMITS.freeTags);
}
