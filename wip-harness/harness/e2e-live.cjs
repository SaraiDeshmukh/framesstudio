const path = require('path');
const { newPage, arPixels, shot, diffCount, check, sleep, OUT } = require('./e2e.cjs');
module.exports = async function (browser) {
  const { page, errors } = await newPage(browser, { grant: true });
  await page.goto('https://app.test/');
  await page.waitForSelector('.frame-card', { timeout: 20000 });
  await page.click('#tabTryOnBtn');
  await page.click('#liveStartBtn');
  // keep a handle on the stream to check it is really stopped later
  await page.waitForFunction(() => { const v = document.getElementById('liveVideo'); if (v.srcObject) window.__stream = v.srcObject; return v.srcObject && v.readyState >= 2; }, null, { timeout: 30000 });
  check('camera preview starts', true);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('liveStripWrap')).display !== 'none', null, { timeout: 60000 });
  check('frame strip shows the real catalog', (await page.$$eval('#liveStrip .similar-item', e => e.length)) === 4);
  await page.waitForFunction(() => /Choose a frame/.test(document.getElementById('liveStatus').textContent), null, { timeout: 60000 }).catch(() => {});
  const status0 = await page.$eval('#liveStatus', e => e.textContent);
  check('prompts to pick a frame', /Choose a frame/.test(status0), status0);

  await page.click('#liveStrip .similar-item[data-id="f1"]');
  await page.waitForFunction(() => document.getElementById('liveStatus').textContent === '', null, { timeout: 30000 });
  await sleep(1500);
  const px = await arPixels(page, '#liveViewport');
  check('live: 3D frame tracks the face', px > 1500, px + ' frame pixels');
  check('Frame details control appears', await page.$eval('#liveCatalogBtn', e => getComputedStyle(e).display !== 'none'));

  // a sequence of frames while the head moves: saved for visual review + alignment
  const align = [];
  for (let i = 0; i < 6; i++) {
    await (await page.$('#liveViewport')).screenshot({ path: path.join(OUT, 'e2e-live-' + i + '.png') });
    const m = await page.evaluate(() => window.__lastAlign && window.__lastAlign());
    if (m) align.push(m);
    await sleep(700);
  }
  const fps = await page.evaluate(async () => { const v = document.getElementById('liveVideo'); const t0 = v.currentTime; await new Promise(r => setTimeout(r, 2000)); return (v.currentTime - t0); });
  check('video keeps playing while tracking', fps > 1.5, 'played ' + fps.toFixed(2) + ' s in 2 s');

  // switch frame without restarting the camera
  const streamIdBefore = await page.evaluate(() => window.__stream.id);
  const a = await shot(page, '#liveViewport');
  await page.click('#liveStrip .similar-item[data-id="f3"]');
  await page.waitForFunction(() => document.getElementById('liveStatus').textContent === '', null, { timeout: 30000 });
  await sleep(800);
  const b = await shot(page, '#liveViewport');
  const sameStream = await page.evaluate(id => document.getElementById('liveVideo').srcObject && document.getElementById('liveVideo').srcObject.id === id, streamIdBefore);
  check('switching frames keeps the same camera stream', sameStream);
  check('switching frames changes the overlay', diffCount(a, b) > 800, diffCount(a, b) + ' px');
  await (await page.$('#liveViewport')).screenshot({ path: path.join(OUT, 'e2e-live-gold.png') });

  // remove / show the overlay without touching the camera
  await page.click('#liveToggleBtn');
  await sleep(600);
  const off = await arPixels(page, '#liveViewport');
  const status1 = await page.$eval('#liveStatus', e => e.textContent);
  const stillLive = await page.evaluate(id => { const s = document.getElementById('liveVideo').srcObject; return !!s && s.id === id && s.getVideoTracks()[0].readyState === 'live'; }, streamIdBefore);
  check('Remove frame hides the overlay', off === 0 || off < 50, off + ' px; status "' + status1 + '"');
  check('Remove frame keeps the camera running', stillLive);
  await page.click('#liveToggleBtn');
  await sleep(800);
  check('Show frame brings it back', (await arPixels(page, '#liveViewport')) > 1000);

  // fit slider + PD
  await page.fill('#pdInput', '58');
  await sleep(600);
  const pdStatusText = await page.$eval('#pdStatus', e => e.textContent);
  check('PD from the eye test is used for the frame', /58 mm/.test(pdStatusText), pdStatusText);

  // switch camera button: only shown with more than one camera
  const nCams = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').length);
  const switchShown = await page.$eval('#liveSwitchBtn', e => getComputedStyle(e).display !== 'none');
  check('Switch camera only offered when there are several cameras', switchShown === (nCams > 1), nCams + ' camera(s), button ' + (switchShown ? 'shown' : 'hidden'));

  // Frame details: back to the product
  await page.click('#liveCatalogBtn');
  await sleep(500);
  const onDetail = await page.evaluate(() => location.hash === '#/frame/f3' && getComputedStyle(document.getElementById('pageDetail')).display !== 'none' && !!document.getElementById('detailTitle'));
  const ended = await page.evaluate(() => window.__stream.getTracks().every(t => t.readyState === 'ended'));
  check('Frame details opens that frame\'s page', onDetail);
  check('leaving Try On stops the camera', ended);

  // start again and stop with the button
  await page.click('#tabTryOnBtn');
  await page.click('#liveStartBtn');
  await page.waitForFunction(() => { const v = document.getElementById('liveVideo'); if (v.srcObject) window.__stream2 = v.srcObject; return v.srcObject && v.readyState >= 2; }, null, { timeout: 30000 });
  await sleep(1000);
  await page.click('#liveStopBtn');
  await sleep(300);
  const ended2 = await page.evaluate(() => window.__stream2.getTracks().every(t => t.readyState === 'ended') && !document.getElementById('liveVideo').srcObject);
  check('Stop camera ends the stream', ended2);
  check('no console errors (live flow)', errors.length === 0, errors.slice(0, 3).join(' | '));

  // the standard error real browsers raise when the customer taps "Block"
  const blocked = await newPage(browser, { grant: true });
  await blocked.page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); });
  await blocked.page.goto('https://app.test/');
  await blocked.page.waitForSelector('.frame-card', { timeout: 20000 });
  await blocked.page.click('#tabTryOnBtn');
  await blocked.page.click('#liveStartBtn');
  await blocked.page.waitForFunction(() => getComputedStyle(document.getElementById('liveError')).display !== 'none', null, { timeout: 20000 });
  const msg2 = await blocked.page.$eval('#liveError', e => e.textContent);
  const uiReset = await blocked.page.$eval('#liveStartBtn', e => getComputedStyle(e).display !== 'none' && !e.disabled);
  check('NotAllowedError shows the unblock instructions and Start is usable again', /blocked/i.test(msg2) && uiReset, msg2.slice(0, 60));
  // no camera at all
  await blocked.page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError')); });
  await blocked.page.click('#liveStartBtn');
  await blocked.page.waitForFunction(() => /No camera/.test(document.getElementById('liveError').textContent), null, { timeout: 20000 });
  check('missing camera shows its own message', true);
  await blocked.ctx.close();

  // phone layout, live
  const phone = await newPage(browser, { grant: true, ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  await phone.page.goto('https://app.test/');
  await phone.page.waitForSelector('.frame-card', { timeout: 20000 });
  await phone.page.click('#tabTryOnBtn');
  await phone.page.click('#liveStartBtn');
  await phone.page.waitForFunction(() => getComputedStyle(document.getElementById('liveStripWrap')).display !== 'none', null, { timeout: 60000 });
  await phone.page.click('#liveStrip .similar-item[data-id="f2"]');
  await phone.page.waitForFunction(() => document.getElementById('liveStatus').textContent === '', null, { timeout: 30000 });
  await sleep(1200);
  await phone.page.screenshot({ path: path.join(OUT, 'e2e-phone.png'), fullPage: true });
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('phone layout: no horizontal scrolling', !overflow);
  check('phone: 3D frame drawn', (await arPixels(phone.page, '#liveViewport')) > 500);
  await phone.ctx.close();
};
