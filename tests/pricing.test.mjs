import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRupees, paiseToInput, parseRate, splitTax, priceView, pricingProblems, pricingFromForm, formatINR, formatRate
} from '../pricing.js';

test('rupee amounts are read into whole paise', function () {
  assert.equal(parseRupees('2499'), 249900);
  assert.equal(parseRupees('2,499.50'), 249950);
  assert.equal(parseRupees('₹ 2499.5'), 249950);
  assert.equal(parseRupees('Rs. 1,00,000'), 10000000);
  assert.equal(parseRupees('0.99'), 99);
  assert.equal(parseRupees('12.345'), null);
  assert.equal(parseRupees('-50'), null);
  assert.equal(parseRupees('abc'), null);
  assert.equal(parseRupees(''), null);
  assert.equal(paiseToInput(249950), '2499.50');
  assert.equal(paiseToInput(249900), '2499');
  assert.equal(paiseToInput(5), '0.05');
});

test('tax rates are the retailer\'s, 0 to 50 with at most two decimals', function () {
  assert.equal(parseRate('18'), 18);
  assert.equal(parseRate('2.5'), 2.5);
  assert.equal(parseRate('5%'), 5);
  assert.equal(parseRate('0'), 0);
  assert.equal(parseRate('51'), null);
  assert.equal(parseRate('5.125'), null);
  assert.equal(parseRate(''), null);
});

test('tax-exclusive: tax is added on top', function () {
  assert.deepEqual(splitTax(100000, 'exclusive', 18), { basePaise: 100000, taxPaise: 18000, finalPaise: 118000 });
  assert.deepEqual(splitTax(249900, 'exclusive', 5), { basePaise: 249900, taxPaise: 12495, finalPaise: 262395 });
  // rounding to the nearest paisa
  assert.deepEqual(splitTax(999, 'exclusive', 18), { basePaise: 999, taxPaise: 180, finalPaise: 1179 });
  assert.deepEqual(splitTax(100000, 'exclusive', 0), { basePaise: 100000, taxPaise: 0, finalPaise: 100000 });
});

test('tax-inclusive: the tax inside the price is worked out, never added again', function () {
  var r = splitTax(118000, 'inclusive', 18);
  assert.deepEqual(r, { basePaise: 100000, taxPaise: 18000, finalPaise: 118000 });
  var r2 = splitTax(249900, 'inclusive', 18);
  assert.equal(r2.finalPaise, 249900, 'the customer pays the entered price');
  assert.equal(r2.basePaise + r2.taxPaise, 249900, 'parts add up exactly');
  assert.equal(r2.basePaise, 211780);   // 2499 / 1.18 = 2117.796… -> 2117.80
  assert.equal(r2.taxPaise, 38120);
  var r3 = splitTax(105000, 'inclusive', 5);
  assert.deepEqual(r3, { basePaise: 100000, taxPaise: 5000, finalPaise: 105000 });
  var r4 = splitTax(100000, 'inclusive', 2.5);
  assert.equal(r4.basePaise + r4.taxPaise, 100000);
  assert.equal(r4.basePaise, 97561);
});

test('no GST charged: no tax line at all', function () {
  assert.deepEqual(splitTax(150000, 'none', null), { basePaise: 150000, taxPaise: null, finalPaise: 150000 });
});

test('inclusive and exclusive agree when converted', function () {
  for (var base = 100; base < 2000000; base += 7919) {
    for (var rate of [0, 2.5, 5, 12, 18, 28, 40]) {
      var ex = splitTax(base, 'exclusive', rate);
      var inc = splitTax(ex.finalPaise, 'inclusive', rate);
      assert.ok(Math.abs(inc.basePaise - base) <= 1, 'base ' + base + ' @ ' + rate);
      assert.equal(inc.basePaise + inc.taxPaise, ex.finalPaise);
    }
  }
});

test('pricing problems are reported, and the tax treatment must be confirmed to publish', function () {
  var ok = { pricePaise: 249900, currency: 'INR', taxMode: 'inclusive', taxRate: 18, confirmed: true };
  assert.deepEqual(pricingProblems(ok, true), []);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { confirmed: false }), false), []);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { confirmed: false }), true), ['tax.notConfirmed']);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { taxMode: null }), false), ['tax.modeMissing']);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { taxRate: null }), false), ['tax.rateMissing']);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { taxRate: 70 }), false), ['tax.rateInvalid']);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { taxMode: 'none', taxRate: 18 }), false), ['tax.rateWithNone']);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { taxMode: 'none', taxRate: null }), false), []);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { pricePaise: 50 }), false), ['price.tooLow']);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { pricePaise: 2499.5 }), false), ['price.missing']);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { salePaise: 249900 }), false), ['sale.notLower']);
  assert.deepEqual(pricingProblems(Object.assign({}, ok, { salePaise: 199900 }), false), []);
  assert.deepEqual(pricingProblems(null, false), ['price.missing']);
});

test('the price view shows before-tax, tax and final price, with any sale', function () {
  var v = priceView({ pricePaise: 300000, currency: 'INR', taxMode: 'exclusive', taxRate: 5, salePaise: 250000, confirmed: true });
  assert.equal(v.regular.finalPaise, 315000);
  assert.equal(v.sale.basePaise, 250000);
  assert.equal(v.sale.taxPaise, 12500);
  assert.equal(v.pay.finalPaise, 262500);
  assert.equal(v.savingPaise, 52500);
  assert.equal(priceView({ pricePaise: -1, currency: 'INR', taxMode: 'none' }), null, 'an invalid price is never shown');
});

test('form values become a pricing record; unreadable entries are caught, not guessed', function () {
  var rec = pricingFromForm({ price: '2,499', taxMode: 'inclusive', taxRate: '18', salePrice: '', confirmed: true });
  assert.deepEqual(rec, { pricePaise: 249900, currency: 'INR', taxMode: 'inclusive', taxRate: 18, salePaise: null, confirmed: true });
  var bad = pricingFromForm({ price: '2499', taxMode: 'exclusive', taxRate: 'eighteen', salePrice: 'cheap', confirmed: true });
  assert.ok(pricingProblems(bad, true).indexOf('tax.rateMissing') !== -1);
  assert.ok(pricingProblems(bad, true).indexOf('sale.invalid') !== -1);
  var none = pricingFromForm({ price: '999', taxMode: 'none', taxRate: '18', confirmed: true });
  assert.equal(none.taxRate, null, 'a rate typed earlier is dropped when no GST is charged');
  var unset = pricingFromForm({ price: '999', confirmed: false });
  assert.deepEqual(pricingProblems(unset, true), ['tax.modeMissing', 'tax.notConfirmed']);
});

test('prices are formatted in rupees with Indian grouping', function () {
  assert.equal(formatINR(249900, 'en'), '₹2,499');
  assert.equal(formatINR(10000000, 'en'), '₹1,00,000');
  assert.equal(formatINR(249950, 'en'), '₹2,499.50');
  assert.match(formatINR(249900, 'hi'), /2,499/);
  assert.match(formatINR(249900, 'mr'), /2,499/);
  assert.equal(formatRate(18), '18%');
  assert.equal(formatRate(2.5), '2.5%');
});
