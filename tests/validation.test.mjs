import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shopProblems, shopPrivateProblems, productProblems, publishBlockers, shouldBePublic, isPublishable,
  whatsappLink, telLink, cleanFreeTags, isGstin, isHttpsUrl
} from '../validation.js';

var price = { pricePaise: 249900, currency: 'INR', taxMode: 'inclusive', taxRate: 18, confirmed: true };
function complete(over) {
  return Object.assign({
    name: 'Black rectangle', status: 'published', moderation: { state: 'ok' }, availability: 'in_stock', pricing: price,
    tryOn: { status: 'none' }, images: { thumb: { url: 'https://firebasestorage.googleapis.com/x', path: 'p' } }
  }, over || {});
}

test('shop profiles need a name and city; contact details must be usable', function () {
  assert.deepEqual(shopProblems({ name: 'Deshmukh Opticals', city: 'Amravati' }), []);
  var codes = shopProblems({ name: 'D', city: '', website: 'http://x.com', phone: 'call me', email: 'nope' }).map(function (p) { return p.field + ':' + p.code; });
  assert.deepEqual(codes.sort(), ['city:shop.cityMissing', 'email:shop.emailInvalid', 'name:shop.nameMissing', 'phone:shop.phoneInvalid', 'website:common.httpsOnly']);
  assert.deepEqual(shopPrivateProblems({ ownerName: 'A. Owner', gstin: '27ABCDE1234F1Z5' }), []);
  assert.equal(shopPrivateProblems({ ownerName: '', gstin: '27ABCDE1234F1Z' }).length, 2);
  assert.ok(isGstin('27ABCDE1234F1Z5'));
  assert.ok(!isGstin('27abcde1234f1z5'));
});

test('product fields are checked like the server does', function () {
  assert.deepEqual(productProblems({ name: '', status: 'draft' }), []);
  var p = productProblems({ name: 'x'.repeat(81), status: 'live', link: 'javascript:alert(1)', availability: 'soon', tags: { shape: 'hexagon' } });
  assert.deepEqual(p.map(function (x) { return x.field; }).sort(), ['availability', 'link', 'name', 'status', 'tags.shape']);
  assert.ok(isHttpsUrl('https://wa.me/919800000000'));
  assert.ok(!isHttpsUrl('http://example.com'));
});

test('publishing needs a name, a confirmed price, availability, a photo and a settled try-on', function () {
  assert.deepEqual(publishBlockers(complete()), []);
  assert.deepEqual(publishBlockers(complete({ name: '' })), ['publish.needName']);
  assert.deepEqual(publishBlockers(complete({ pricing: null })), ['publish.needPrice']);
  assert.deepEqual(publishBlockers(complete({ pricing: Object.assign({}, price, { confirmed: false }) })), ['publish.needTaxConfirm']);
  assert.deepEqual(publishBlockers(complete({ availability: null })), ['publish.needAvailability']);
  assert.deepEqual(publishBlockers(complete({ images: {} })), ['publish.needPhoto']);
  assert.deepEqual(publishBlockers(complete({ tryOn: { status: 'failed' } })), ['publish.tryOnUnresolved']);
  assert.deepEqual(publishBlockers(complete({ tryOn: { status: 'ready' } })), ['publish.tryOnIncomplete']);
  assert.deepEqual(publishBlockers(complete({ moderation: { state: 'suspended' } })), ['publish.suspended']);
});

test('the public flag matches the server rule', function () {
  assert.equal(shouldBePublic(complete(), 'approved'), true);
  assert.equal(shouldBePublic(complete(), 'pending'), false);
  assert.equal(shouldBePublic(complete(), 'suspended'), false);
  assert.equal(shouldBePublic(complete({ status: 'draft' }), 'approved'), false);
  assert.equal(shouldBePublic(complete({ status: 'archived' }), 'approved'), false);
  assert.equal(shouldBePublic(complete({ moderation: { state: 'suspended' } }), 'approved'), false);
  assert.equal(isPublishable(complete({ tryOn: { status: 'ready' }, images: { thumb: { url: 'u' }, cutout: { url: 'c' }, manifest: { url: 'm' } } })), true);
});

test('contact links for customers', function () {
  assert.equal(whatsappLink('98220 12345'), 'https://wa.me/919822012345');
  assert.equal(whatsappLink('+91 98220-12345', 'Hi'), 'https://wa.me/919822012345?text=Hi');
  assert.equal(whatsappLink('09822012345'), 'https://wa.me/919822012345');
  assert.equal(whatsappLink('123'), null);
  assert.equal(telLink('0721 255 0000'), 'tel:07212550000');
  assert.deepEqual(cleanFreeTags([' Titanium ', 'titanium', '', 'Lightweight']), ['titanium', 'lightweight']);
});
