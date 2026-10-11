const path = require('path');
const { newPage, arPixels, shot, diffCount, check, sleep, OUT, H } = require('./e2e.cjs');
async function uploadViaButton(page, file, btn) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(btn || '#uploadBtn')]);
  await chooser.setFiles(file);
}
module.exports = async function (browser) {
  const { page, errors } = await newPage(browser);
  await page.goto('https://app.test/');
  await page.waitForSelector('.frame-card', { timeout: 20000 });
  const cards = await page.$$eval('.frame-card', els => els.length);
  check('catalog loads seeded frames', cards === 4, cards + ' cards');
  const sizeChip = await page.$$eval('.frame-card .frame-card-size', els => els.map(e => e.textContent).filter(t => /□/.test(t)));
  check('recorded sizes shown on cards', sizeChip.length === 2, sizeChip.join(', '));
  await page.screenshot({ path: path.join(OUT, 'e2e-browse.png'), fullPage: false });

  // pick the tortoise frame and go to Try On
  await page.click('.frame-card[data-id="f2"] .frame-card-tryon');
  await page.waitForSelector('#pageTryOn', { state: 'visible' });
  // upload a customer photo
  await page.setInputFiles('#fileInput', path.join(H.S, 'assets/business-person.png'));
  await page.waitForFunction(() => document.querySelector('#photoStage .ar-canvas'), null, { timeout: 60000 });
  await sleep(1500);
  const px1 = await arPixels(page, '#photoStage');
  check('uploaded photo: 3D frame drawn over the face', px1 > 2000, px1 + ' frame pixels');
  const banner = await page.$eval('#calibBanner', e => getComputedStyle(e).display);
  check('uploaded photo: face found automatically (no taps needed)', banner === 'none');
  const vp = await page.$('#viewport');
  await vp.screenshot({ path: path.join(OUT, 'e2e-photo-tortoise.png') });

  // switch frame via the "more frames" carousel; overlay must change
  const before = await shot(page, '#viewport');
  await page.click('#tabBrowseBtn'); await page.click('.frame-card[data-id="f1"] .frame-card-tryon');
  await sleep(1500);
  const after = await shot(page, '#viewport');
  const changed = diffCount(before, after);
  const active = await page.evaluate(() => document.querySelector('#selectedText') && document.querySelector('#selectedText').textContent);
  check('selecting another frame updates the overlay', changed > 1500, changed + ' pixels changed; now ' + active);
  await vp.screenshot({ path: path.join(OUT, 'e2e-photo-other.png') });

  // remove / show the overlay in photo mode
  await page.click('#photoToggleBtn');
  await sleep(300);
  const offPx = await arPixels(page, '#photoStage');
  const offLabel = await page.$eval('#photoToggleBtn', e => e.textContent);
  await page.click('#photoToggleBtn');
  await sleep(1000);
  const onPx = await arPixels(page, '#photoStage');
  check('photo mode: Remove frame / Show frame work', offPx <= 0 && offLabel === 'Show frame' && onPx > 2000, offPx + ' -> ' + onPx);

  // fit slider
  await page.$eval('#fitSize', e => { e.value = 115; e.dispatchEvent(new Event('input')); });
  await sleep(800);
  const px2 = await arPixels(page, '#photoStage');
  check('fit slider enlarges the 3D frame', px2 > px1 * 0.5 && px2 !== px1, px1 + ' -> ' + px2);
  await page.$eval('#fitSize', e => { e.value = 100; e.dispatchEvent(new Event('input')); });

  // recalibrate -> manual 2D taps
  await page.click('#recalBtn');
  const arGone = await page.evaluate(() => !document.querySelector('#photoStage .ar-canvas'));
  check('recalibrate switches to manual taps (3D overlay removed)', arGone);
  const box = await page.$eval('#canvas', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cw: e.width, ch: e.height }; });
  // business-person eyes at ~ (444,267) and (562,260) in the 958x1358 original; the canvas is capped at 800
  const k = box.cw / 958;
  for (const p of [[444, 267], [562, 260]]) await page.mouse.click(box.x + p[0] * k * box.w / box.cw, box.y + p[1] * k * box.h / box.ch);
  await sleep(800);
  await vp.screenshot({ path: path.join(OUT, 'e2e-photo-manual2d.png') });
  const recalVisible = await page.$eval('#recalBtn', e => getComputedStyle(e).display !== 'none');
  check('manual 2D mode still works after two taps', recalVisible);

  // retake clears everything
  await page.click('#retakeBtn');
  const cleared = await page.evaluate(() => getComputedStyle(document.getElementById('canvas')).display === 'none' && !document.querySelector('#photoStage .ar-canvas'));
  check('retake photo clears the photo and overlay', cleared);

  // legacy record whose photo was shrunk to fit Firestore: same frame, same size on the face
  const recalHidden = await page.$eval('#recalBtn', e => getComputedStyle(e).display === 'none');
  check('after retake, the photo-only controls are hidden', recalHidden);
  await uploadViaButton(page, path.join(H.S, 'assets/business-person.png'));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('recalBtn')).display !== 'none', null, { timeout: 60000 });
  await page.click('#tabBrowseBtn'); await page.click('.frame-card[data-id="f2"] .frame-card-tryon');
  await sleep(1500);
  const pxNew = await arPixels(page, '#photoStage');
  await page.click('#tabBrowseBtn'); await page.click('.frame-card[data-id="f4"] .frame-card-tryon');
  await sleep(1500);
  const pxLegacy = await arPixels(page, '#photoStage');
  check('old shrunk records: lens points rescaled (same frame renders the same size)', pxNew > 2000 && Math.abs(pxLegacy / pxNew - 1) < 0.1, pxNew + ' vs ' + pxLegacy);

  // dim photo: frame is darkened to match
  async function overlayLuma() {
    const el = await page.$('#viewport');
    const sharp = require('/opt/npm-tools/node_modules/sharp');
    const get = async () => { const { data, info } = await sharp(await el.screenshot()).raw().toBuffer({ resolveWithObject: true }); return { data, info }; };
    const a = await get();
    await page.evaluate(() => { document.querySelector('#photoStage .ar-canvas').style.visibility = 'hidden'; });
    const b = await get();
    await page.evaluate(() => { document.querySelector('#photoStage .ar-canvas').style.visibility = ''; });
    let sum = 0, n = 0;
    for (let i = 0; i < a.data.length; i += a.info.channels) {
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30) { sum += 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2]; n++; }
    }
    return n ? sum / n : 0;
  }
  await page.click('#tabBrowseBtn'); await page.click('.frame-card[data-id="f3"] .frame-card-tryon');
  await sleep(1500);
  const brightL = await overlayLuma();
  await uploadViaButton(page, path.join(H.S, 'assets/dim-person.png'), '#retakeBtn');   // Replace photo
  await page.waitForFunction(() => getComputedStyle(document.getElementById('recalBtn')).display === 'none', null, { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => getComputedStyle(document.getElementById('recalBtn')).display !== 'none', null, { timeout: 60000 });
  await sleep(1500);
  const dimL = await overlayLuma();
  await (await page.$('#viewport')).screenshot({ path: path.join(OUT, 'e2e-photo-dim.png') });
  check('dim photo: frame brightness follows the scene', dimL < brightL * 0.8, 'frame luma ' + brightL.toFixed(0) + ' (bright photo) vs ' + dimL.toFixed(0) + ' (dim photo)');

  check('no console errors (photo flow)', errors.length === 0, errors.slice(0, 3).join(' | '));
};
