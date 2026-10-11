const path = require('path');
const { newPage, check, sleep, OUT, H } = require('./e2e.cjs');
module.exports = async function (browser) {
  const { page, errors } = await newPage(browser, { grant: true });
  // a device without WebGL: three.js can't start, MediaPipe runs on CPU
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) { if (/webgl/.test(type)) return null; return orig.apply(this, arguments); };
    window.__warns = [];
    const w = console.warn; console.warn = function () { window.__warns.push(Array.from(arguments).join(' ')); return w.apply(this, arguments); };
  });
  await page.goto('https://app.test/');
  await page.waitForSelector('.frame-card', { timeout: 20000 });
  await page.click('.frame-card[data-id="f2"] .frame-card-tryon');
  await page.click('#goTryOnBtn');
  await page.setInputFiles('#fileInput', path.join(H.S, 'assets/business-person.png'));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('recalBtn')).display !== 'none', null, { timeout: 60000 });
  await sleep(1500);
  const noAr = await page.evaluate(() => !document.querySelector('.ar-canvas'));
  const warned = await page.evaluate(() => window.__warns.some(w => /3D try-on unavailable/.test(w)));
  check('no WebGL: photo mode falls back to the flat overlay', noAr && warned);
  await (await page.$('#viewport')).screenshot({ path: path.join(OUT, 'e2e-fallback-photo.png') });
  await page.click('#liveStartBtn');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('liveStripWrap')).display !== 'none', null, { timeout: 60000 });
  await page.click('#liveStrip .similar-item[data-id="f2"]');
  await page.waitForFunction(() => document.getElementById('liveStatus').textContent === '', null, { timeout: 30000 });
  await sleep(1500);
  await (await page.$('#liveViewport')).screenshot({ path: path.join(OUT, 'e2e-fallback-live.png') });
  const err = await page.$eval('#liveError', e => getComputedStyle(e).display);
  check('no WebGL: live try-on still runs with the flat overlay', err === 'none' && await page.evaluate(() => !document.querySelector('.ar-canvas')));
  check('no console errors (fallback)', errors.length === 0, errors.slice(0, 3).join(' | '));
};
