// Live alignment in steady state (static feed) and under slow motion, plus the
// tracking loop rate in this (software-rendered, CPU-only) headless browser.
const path = require('path');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { newPage, check, sleep, OUT, H } = require('./e2e.cjs');
module.exports = async function () {
  for (const feed of ['static', 'slow']) {
    const browser = await chromium.launch({ args: H.launchArgs(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(H.S, 'assets/face_' + feed + '.y4m')]) });
    const { page, errors } = await newPage(browser, { grant: true });
    await page.addInitScript(() => {
      window.__draws = 0; window.__mpCalls = 0;
      const orig = WebGL2RenderingContext.prototype.drawElements;
      WebGL2RenderingContext.prototype.drawElements = function () { window.__draws++; return orig.apply(this, arguments); };
    });
    await page.goto('https://app.test/');
    await page.waitForSelector('.frame-card', { timeout: 20000 });
    await page.click('#tabTryOnBtn');
    await page.click('#liveStartBtn');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('liveStripWrap')).display !== 'none', null, { timeout: 60000 });
    await page.click('#liveStrip .similar-item[data-id="f2"]');
    await page.waitForFunction(() => document.getElementById('liveStatus').textContent === '', null, { timeout: 30000 });
    await sleep(2500);
    const rate = await page.evaluate(async () => {
      const d0 = window.__draws, t0 = performance.now(), v = document.getElementById('liveVideo'), vt0 = v.currentTime;
      await new Promise(r => setTimeout(r, 3000));
      return { drawsPerSec: (window.__draws - d0) / ((performance.now() - t0) / 1000), videoSec: v.currentTime - vt0 };
    });
    console.log(feed, 'draw calls/s', rate.drawsPerSec.toFixed(1), 'video advanced', rate.videoSec.toFixed(2), 's in 3 s');
    for (let i = 0; i < (feed === 'static' ? 1 : 4); i++) {
      await (await page.$('#liveViewport')).screenshot({ path: path.join(OUT, 'align-' + feed + '-' + i + '.png') });
      await sleep(1800);
    }
    check(feed + ' feed: no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await browser.close();
  }
};
