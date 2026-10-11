const path = require('path');
const { newPage, check, sleep, OUT, H } = require('./e2e.cjs');
async function tapOnCanvas(page, sel, pts, srcW) {
  const b = await page.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cw: e.width, ch: e.height }; });
  const k = b.cw / srcW;                       // the app caps photos at 700 px
  for (const p of pts) { await page.mouse.click(b.x + p[0] * k * b.w / b.cw, b.y + p[1] * k * b.h / b.ch); await sleep(250); }
}
module.exports = async function (browser) {
  const { page, errors } = await newPage(browser);
  await page.goto('https://app.test/');
  await page.waitForSelector('.frame-card', { timeout: 20000 });
  await page.click('#tabAddBtn');
  await page.setInputFiles('#frameFileInputEl', path.join(H.S, 'frames/photo_tortoise.jpg'));
  await page.waitForSelector('#frameCalibSection', { state: 'visible' });
  await sleep(500);
  // lens centres in the 860x440 photo: (282,220) and (578,220)
  await tapOnCanvas(page, '#frameCalibCanvas', [[282, 220], [578, 220]], 860);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('modelPreview')).display !== 'none', null, { timeout: 30000 });
  await sleep(1200);
  const hint = await page.$eval('#modelPreviewHint', e => e.textContent);
  check('3D preview appears after tapping the lens centres', /Generated from this photo/.test(hint), hint);
  check('preview detects the clear lenses', /glass lenses/.test(hint));
  await page.$eval('#modelPreviewYaw', e => { e.value = 40; e.dispatchEvent(new Event('input')); });
  await sleep(500);
  await (await page.$('#frameCalibSection')).screenshot({ path: path.join(OUT, 'e2e-add-preview.png') });
  await page.fill('#sizeEye', '49'); await page.fill('#sizeBridge', '21'); await page.fill('#sizeTemple', '145');
  await page.click('.chip-row#shapeChips .tag-chip:nth-child(1)');
  await page.click('#addToLibraryBtn');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('addedMsg')).display !== 'none', null, { timeout: 15000 });
  const saved = await page.evaluate(() => {
    const ids = [...window.__store.keys()].filter(k => /\/frames\/f\d{6,}/.test(k));
    const id = ids[0].split('/').pop();
    return { id, light: window.__store.get('users/kiosk/frames/' + id), full: window.__store.get('users/kiosk/framesFull/' + id) };
  });
  check('new frame saved with its size', saved.light.size && saved.light.size.eye === 49 && saved.light.size.bridge === 21 && saved.light.size.temple === 145, JSON.stringify(saved.light.size));
  check('lens points saved with the image size they refer to', saved.full.imgW > 0 && saved.full.imgH > 0 && saved.full.p1.x < saved.full.imgW, JSON.stringify({ p1: saved.full.p1, w: saved.full.imgW, h: saved.full.imgH }));
  check('catalog shows the new frame', (await page.$$eval('.frame-card', e => e.length)) === 5);

  // temple photo for the frame just added
  await page.click('#addSideAfterBtn');
  check('temple photo mode shows which frame it is for', await page.$eval('#sideTarget', e => getComputedStyle(e).display === 'flex'));
  await page.setInputFiles('#frameFileInputEl', path.join(H.S, 'frames/photo_acetate_side.jpg'));
  await page.waitForSelector('#frameCalibSection', { state: 'visible' });
  check('size/tags are hidden for the temple photo', await page.$eval('#frontOnlySection', e => getComputedStyle(e).display === 'none'));
  // hinge (150,150), tip (770,271) in the 920x400 photo
  await tapOnCanvas(page, '#frameCalibCanvas', [[150, 150], [770, 271]], 920);
  await page.waitForFunction(() => /temple/.test(document.getElementById('modelPreviewHint').textContent), null, { timeout: 30000 });
  await page.$eval('#modelPreviewYaw', e => { e.value = 55; e.dispatchEvent(new Event('input')); });
  await sleep(600);
  await (await page.$('#modelPreview')).screenshot({ path: path.join(OUT, 'e2e-add-side-preview.png') });
  await page.click('#addToLibraryBtn');
  await page.waitForFunction(() => /Temple photo saved/.test(document.getElementById('addedMsgText').textContent), null, { timeout: 15000 });
  const side = await page.evaluate(id => ({ side: window.__store.get('users/kiosk/framesSide/' + id), light: window.__store.get('users/kiosk/frames/' + id) }), saved.id);
  check('temple photo saved and linked to the frame', side.side && side.side.hinge && side.side.imgW && side.light.hasSide === true);
  check('Add page returns to normal frame mode', await page.$eval('#addToLibraryBtn', e => e.textContent === 'Add to library'));

  // edit an existing frame's size from Browse
  await page.click('#tabBrowseBtn');
  await page.click('.frame-card[data-id="f2"] .frame-card-edit');
  await page.fill('#editSizeEye', '47'); await page.fill('#editSizeBridge', '22'); await page.fill('#editSizeTemple', '140');
  await page.click('#saveTagsBtn');
  await sleep(500);
  const f2 = await page.evaluate(() => window.__store.get('users/kiosk/frames/f2').size);
  check('editing saves the size', f2 && f2.eye === 47 && f2.bridge === 22, JSON.stringify(f2));
  check('card shows the edited size', (await page.$eval('.frame-card[data-id="f2"]', e => e.textContent)).includes('47□22 140'));
  await page.click('.frame-card[data-id="f2"] .frame-card-edit');
  const sideBtn = await page.$eval('#editSideBtn', e => e.textContent);
  check('edit panel offers a temple photo', sideBtn === 'Add temple photo');
  await page.click('#editSideBtn');
  check('it opens temple photo mode for that frame', await page.$eval('#sideTargetText', e => e.textContent.includes('Temple photo for')));
  await page.click('#sideTargetCancel');

  // deleting a frame removes its temple photo too
  await page.click('#tabBrowseBtn');
  page.once('dialog', d => d.accept());
  await page.click('.frame-card[data-id="f1"] .frame-card-remove');
  await sleep(400);
  const gone = await page.evaluate(() => !window.__store.has('users/kiosk/framesSide/f1') && !window.__store.has('users/kiosk/frames/f1'));
  check('removing a frame also removes its temple photo', gone);
  check('no console errors (add/edit flow)', errors.length === 0, errors.slice(0, 3).join(' | '));
};
