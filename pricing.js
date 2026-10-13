// Prices and tax for retailer products. No DOM; unit-tested in
// tests/pricing.test.mjs.
//
// Money is kept in paise (whole numbers), so ₹2,499.50 is 249950 and nothing is
// lost to floating-point rounding. The tax rate is whatever the retailer chose
// for the product: there is no built-in GST rate, and a calculated tax amount
// is arithmetic on the retailer's figures, not advice that the rate is right.
//
// Three treatments:
//   'exclusive'  the entered price is before tax; tax is added on top
//   'inclusive'  the entered price already includes tax; the tax inside it is
//                worked out (not added again)
//   'none'       the shop doesn't charge GST on this product (for example a
//                shop that isn't GST-registered); no tax is shown

export var TAX_MODES = ['inclusive', 'exclusive', 'none'];
// Offered as quick choices only; the retailer must still pick and confirm one.
export var COMMON_GST_RATES = [0, 5, 18, 40];
export var MIN_PRICE_PAISE = 100;              // ₹1
export var MAX_PRICE_PAISE = 100000000;        // ₹10,00,000
export var MAX_TAX_RATE = 50;

// "2,499.50", "₹ 2499", "2499.5" -> 249950. null if it isn't a valid amount.
export function parseRupees(text) {
  if (text == null) return null;
  var s = String(text).replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  var parts = s.split('.');
  var paise = parseInt(parts[0], 10) * 100 + (parts[1] ? parseInt((parts[1] + '0').slice(0, 2), 10) : 0);
  return Number.isSafeInteger(paise) ? paise : null;
}

// 249950 -> "2499.50"; 249900 -> "2499" (for filling an input box).
export function paiseToInput(paise) {
  if (paise == null || !Number.isFinite(paise)) return '';
  var r = Math.floor(paise / 100), p = paise % 100;
  return p ? r + '.' + String(p).padStart(2, '0') : String(r);
}

// "18", "2.5" -> 18, 2.5; null if not a rate from 0 to 50 with at most 2 decimals.
export function parseRate(text) {
  if (text == null || text === '') return null;
  var s = String(text).replace('%', '').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
  var v = parseFloat(s);
  return v >= 0 && v <= MAX_TAX_RATE ? v : null;
}

function locale(lang) { return lang === 'hi' ? 'hi-IN' : lang === 'mr' ? 'mr-IN' : 'en-IN'; }

// ₹2,499 or ₹2,499.50 (Indian digit grouping). Western digits in every
// language, as on price tags in shops.
export function formatINR(paise, lang) {
  if (paise == null || !Number.isFinite(paise)) return '';
  var whole = paise % 100 === 0;
  try {
    return new Intl.NumberFormat(locale(lang) + '-u-nu-latn', {
      style: 'currency', currency: 'INR',
      minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2
    }).format(paise / 100);
  } catch (e) {
    return '₹' + (paise / 100).toFixed(whole ? 0 : 2);
  }
}

export function formatRate(rate) {
  if (rate == null) return '';
  return (Math.round(rate * 100) / 100) + '%';
}

// Splits one amount by the treatment. Rounds to the nearest paisa (half up).
export function splitTax(amountPaise, mode, rate) {
  if (mode === 'none') return { basePaise: amountPaise, taxPaise: null, finalPaise: amountPaise };
  if (mode === 'exclusive') {
    var tax = Math.round(amountPaise * rate / 100);
    return { basePaise: amountPaise, taxPaise: tax, finalPaise: amountPaise + tax };
  }
  // inclusive: final = base * (1 + r/100)  =>  base = final * 100 / (100 + r)
  var base = Math.round(amountPaise * 100 / (100 + rate));
  return { basePaise: base, taxPaise: amountPaise - base, finalPaise: amountPaise };
}

// Problems with a pricing record, as codes the interface translates.
// Empty list = valid. `forPublish` also needs the treatment to be confirmed.
export function pricingProblems(pr, forPublish) {
  var out = [];
  if (!pr) return ['price.missing'];
  if (!Number.isInteger(pr.pricePaise)) out.push('price.missing');
  else if (pr.pricePaise < MIN_PRICE_PAISE) out.push('price.tooLow');
  else if (pr.pricePaise > MAX_PRICE_PAISE) out.push('price.tooHigh');
  if (pr.currency !== 'INR') out.push('price.currency');
  if (TAX_MODES.indexOf(pr.taxMode) === -1) out.push('tax.modeMissing');
  else if (pr.taxMode !== 'none') {
    if (typeof pr.taxRate !== 'number' || !Number.isFinite(pr.taxRate)) out.push('tax.rateMissing');
    else if (pr.taxRate < 0 || pr.taxRate > MAX_TAX_RATE || Math.round(pr.taxRate * 100) !== pr.taxRate * 100) out.push('tax.rateInvalid');
  } else if (pr.taxRate != null) out.push('tax.rateWithNone');
  if (pr.salePaise != null) {
    if (!Number.isInteger(pr.salePaise) || pr.salePaise < MIN_PRICE_PAISE) out.push('sale.invalid');
    else if (Number.isInteger(pr.pricePaise) && pr.salePaise >= pr.pricePaise) out.push('sale.notLower');
  }
  if (forPublish && pr.confirmed !== true) out.push('tax.notConfirmed');
  return out;
}

// Everything a product page or card needs to show the price, or null if the
// pricing isn't valid (an invalid price is never shown to customers).
//   regular: the normal price split into before-tax, tax and final
//   sale:    the same for the sale price, if there is one
//   pay:     what the customer pays (sale if there is one, else regular)
export function priceView(pr) {
  if (!pr || pricingProblems(pr, false).length) return null;
  var rate = pr.taxMode === 'none' ? null : pr.taxRate;
  var regular = splitTax(pr.pricePaise, pr.taxMode, rate);
  var sale = pr.salePaise != null ? splitTax(pr.salePaise, pr.taxMode, rate) : null;
  return {
    mode: pr.taxMode, rate: rate, currency: 'INR',
    regular: regular, sale: sale, pay: sale || regular,
    savingPaise: sale ? regular.finalPaise - sale.finalPaise : 0
  };
}

// Builds a pricing record from form values (strings), for saving.
export function pricingFromForm(v) {
  var mode = v.taxMode || null;
  var rate = mode && mode !== 'none' ? parseRate(v.taxRate) : null;
  var sale = v.salePrice != null && String(v.salePrice).trim() !== '' ? parseRupees(v.salePrice) : null;
  var rec = {
    pricePaise: parseRupees(v.price),
    currency: 'INR',
    taxMode: mode,
    taxRate: rate,
    salePaise: sale,
    confirmed: !!v.confirmed
  };
  if (v.salePrice != null && String(v.salePrice).trim() !== '' && sale == null) rec.salePaise = NaN;  // typed but unreadable
  if (mode && mode !== 'none' && String(v.taxRate == null ? '' : v.taxRate).trim() !== '' && rate == null) rec.taxRate = NaN;
  if (v.hsn) rec.hsn = String(v.hsn).trim().slice(0, 10);
  return rec;
}
