// Asset generation from ordinary phone photos (the three reference photos),
// through the real Add Frames UI, into the try-on.
const path = require('path');
const { newPage, arPixels, check, sleep, OUT, H } = require('./e2e.cjs');
const PHOTOS = [
  { name: 'greygreen', file: 'greygreen.png', rim: 'Full-rim', translucent: true, size: null, tags: ['Square', 'Clear'] },
  { name: 'redcherry', file: 'redcherry.png', rim: 'Full-rim', translucent: false, size: [49, 18, 138], tags: ['Rectangle', 'Navy'], repaired: true },
  { name: 'semirimless', file: 'semirimless.png', rim: 'Semi-rimless', translucent: false, size: [51, 16, 135], tags: ['Rectangle', 'Tortoise'], repaired: true }
];
async function upload(page, btn, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(btn)]);
  await chooser.setFiles(file);
}
async function chip(page, container, label) {
  await page.click(`${container} .tag-chip >> text="${label}"`);
}
module.exports = async function (browser) {
  const { page, errors } = await newPage(browser, { grant: true });
  await page.goto('https://app.test/');
  await page.waitForSelector('.frame-card', { timeout: 20000 });
  const autoActive = await page.$eval('#bgModeAutoBtn', e => e.classList.contains('active'));
  check('Automatic is the default mode', autoActive);
  const saved = {};
  for (const ph of PHOTOS) {
    await page.click('#tabAddBtn');
    await page.evaluate(() => { document.getElementById('autoStatus').textContent = ''; });
    await upload(page, '#frameUploadBtn', path.join(H.S, 'photos', ph.file));
    const t0 = Date.now();
    await page.waitForFunction(() => /Frame found|Couldn't find/.test(document.getElementById('autoStatus').textContent), null, { timeout: 60000 });
    const ms = Date.now() - t0;
    const status = await page.$eval('#autoStatus', e => e.textContent);
    check(ph.name + ': frame found automatically (' + ms + ' ms in this browser)', /Frame found/.test(status), status);
    check(ph.name + ': rim type ' + ph.rim, status.includes(ph.rim));
    check(ph.name + ': ' + (ph.translucent ? 'translucent' : 'solid') + ' material', status.includes(ph.translucent ? 'translucent' : 'solid'));
    check(ph.name + ': approximate 3D chosen', status.includes('approximate 3D'));
    const notes = await page.$$eval('#autoWarnings li', els => els.map(e => e.className + ': ' + e.textContent.slice(0, 60)));
    const rimTag = await page.$eval('#rimChips .tag-chip.active', e => e.textContent).catch(() => '');
    check(ph.name + ': rim tag filled from the detection', rimTag === { 'Full-rim': 'Full-Rim', 'Semi-rimless': 'Semi-Rimless' }[ph.rim], rimTag);
    if (ph.repaired) check(ph.name + ': rebuilt bridge flagged for review', notes.some(n => /^warn: The display clip hid/.test(n)), notes.join(' | '));
    const ready = await page.$eval('#addToLibraryBtn', e => !e.disabled);
    check(ph.name + ': lens centres placed automatically (ready to save)', ready);
    await (await page.$('#frameCalibSection')).screenshot({ path: path.join(OUT, 'auto-review-' + ph.name + '.png') });
    // material override re-runs and is reflected
    await chip(page, '#autoMaterialChips', ph.translucent ? 'Solid' : 'Translucent');
    await page.waitForFunction(t => document.getElementById('autoStatus').textContent.includes(t), ph.translucent ? 'solid' : 'translucent', { timeout: 60000 });
    await chip(page, '#autoMaterialChips', ph.translucent ? 'Translucent' : 'Solid');
    await page.waitForFunction(t => document.getElementById('autoStatus').textContent.includes(t), ph.translucent ? 'translucent' : 'solid', { timeout: 60000 });
    check(ph.name + ': material override works both ways', true);
    // drag a lens marker
    const before = await page.evaluate(() => document.getElementById('frameCalibBanner').textContent);
    // preview on a face in the real try-on (unsaved)
    await page.click('#autoPreviewBtn');
    await page.waitForSelector('#draftBanner', { state: 'visible' });
    await upload(page, '#uploadBtn', path.join(H.S, 'assets/business-person.png'));
    await page.waitForFunction(() => document.querySelector('#photoStage .ar-canvas'), null, { timeout: 60000 });
    await sleep(1500);
    const px = await arPixels(page, '#photoStage');
    check(ph.name + ': unsaved frame previewed on a face in 3D', px > 1500, px + ' px');
    const vp = await page.$('#viewport');
    const box = await vp.boundingBox();
    await page.screenshot({ path: path.join(OUT, 'auto-tryon-' + ph.name + '.png'), clip: { x: box.x + box.width * 0.22, y: box.y + box.height * 0.08, width: box.width * 0.56, height: box.height * 0.26 } });
    await page.click('#draftBackBtn');
    await page.waitForSelector('#pageAdd', { state: 'visible' });
    const stillThere = await page.$eval('#frameCalibSection', e => getComputedStyle(e).display !== 'none');
    check(ph.name + ': back from preview keeps the work in progress', stillThere);
    // size + tags, then save
    if (ph.size) { await page.fill('#sizeEye', String(ph.size[0])); await page.fill('#sizeBridge', String(ph.size[1])); await page.fill('#sizeTemple', String(ph.size[2])); }
    await page.click(`#shapeChips .tag-chip >> text="${ph.tags[0]}"`);
    await page.click(`#colorChips .tag-chip >> text="${ph.tags[1]}"`);
    const nBefore = await page.evaluate(() => [...window.__store.keys()].filter(k => /\/frames\//.test(k)).length);
    await page.click('#addToLibraryBtn');
    await page.waitForFunction(n => [...window.__store.keys()].filter(k => /\/frames\//.test(k)).length > n, nBefore, { timeout: 20000 });
    await sleep(300);
    const rec = await page.evaluate(() => {
      const ids = [...window.__store.keys()].filter(k => /\/frames\/f\d{8,}/.test(k)).map(k => k.split('/').pop()).sort();
      const id = ids[ids.length - 1];
      const L = window.__store.get('users/kiosk/frames/' + id), F = window.__store.get('users/kiosk/framesFull/' + id), Src = window.__store.get('users/kiosk/framesSource/' + id);
      return { id, light: { level: L.level, rimType: L.rimType, translucent: L.translucent, prepared: L.prepared, hasSource: L.hasSource, size: L.size },
        full: { imgW: F.imgW, imgH: F.imgH, p1: F.p1, p2: F.p2, fit: F.fit && { lenses: F.fit.lenses.length, poly: F.fit.lenses[0].poly.length, rimType: F.fit.rimType, level: F.fit.level, unmixed: F.fit.unmixed, lensL: F.fit.landmarks.lensL, quality: F.fit.quality, warnings: F.fit.warnings } },
        source: Src && { type: Src.imageData.slice(0, 15), kb: Math.round(Src.imageData.length / 1024), w: Src.w, h: Src.h } };
    });
    saved[ph.name] = rec;
    check(ph.name + ': saved with fitting metadata against its own product id', rec.full.fit && rec.full.fit.lenses === 2 && rec.full.fit.poly >= 40 && rec.light.prepared === 'auto' && rec.light.level === '3d', JSON.stringify({ id: rec.id, fit: rec.full.fit && { rim: rec.full.fit.rimType, q: rec.full.fit.quality, warn: rec.full.fit.warnings } }));
    check(ph.name + ': original photo kept separately', rec.source && rec.source.type === 'data:image/jpeg' && rec.light.hasSource === true, JSON.stringify(rec.source));
    check(ph.name + ': processed asset cropped to the frame', rec.full.imgW < 1000 && rec.full.imgW > 500, rec.full.imgW + 'x' + rec.full.imgH);
    check(ph.name + ': lens centres stored = fitting landmarks', Math.abs(rec.full.p1.x - rec.full.fit.lensL.x) < 1.5 && Math.abs(rec.full.p1.y - rec.full.fit.lensL.y) < 1.5);
  }
  // all three are different products with different assets
  const ids = Object.values(saved).map(r => r.id);
  check('three different product ids', new Set(ids).size === 3);
  const aspects = Object.values(saved).map(r => (r.full.imgW / r.full.imgH).toFixed(2));
  check('each product has its own asset (different shapes)', new Set(aspects).size === 3, aspects.join(', '));

  // try each saved product on the same face from the catalog
  await page.click('#tabTryOnBtn');
  await upload(page, '#uploadBtn', path.join(H.S, 'assets/business-person.png'));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('recalBtn')).display !== 'none', null, { timeout: 60000 });
  for (const ph of PHOTOS) {
    await page.click('#tabBrowseBtn');
    await page.click(`.frame-card[data-id="${saved[ph.name].id}"] .frame-card-tryon`);
    await page.click('#goTryOnBtn');
    await sleep(1800);
    const px = await arPixels(page, '#photoStage');
    check(ph.name + ': saved frame tries on from the catalog', px > 1500, px + ' px');
    const vp = await page.$('#viewport'); const b = await vp.boundingBox();
    await page.screenshot({ path: path.join(OUT, 'auto-saved-' + ph.name + '.png'), clip: { x: b.x + b.width * 0.22, y: b.y + b.height * 0.08, width: b.width * 0.56, height: b.height * 0.26 } });
  }
  // live camera with a saved auto frame
  await page.click('#liveStartBtn');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('liveStripWrap')).display !== 'none', null, { timeout: 60000 });
  await page.click(`#liveStrip .similar-item[data-id="${saved.greygreen.id}"]`);
  await page.waitForFunction(() => document.getElementById('liveStatus').textContent === '', null, { timeout: 30000 });
  await sleep(1500);
  const lpx = await arPixels(page, '#liveViewport');
  check('live camera: auto-prepared translucent frame tracks the face', lpx > 1500, lpx + ' px');
  await (await page.$('#liveViewport')).screenshot({ path: path.join(OUT, 'auto-live-greygreen.png') });
  await page.click('#liveStopBtn');

  // re-process from the stored original (Edit -> Update photo)
  await page.click('#tabBrowseBtn');
  const rid = saved.redcherry.id;
  await page.click(`.frame-card[data-id="${rid}"] .frame-card-edit`);
  const photoStatus = await page.$eval('#editPhotoStatus', e => e.textContent);
  check('edit panel shows how the frame was prepared', /Prepared automatically: Full-rim, solid, approximate 3D\. Original photo kept\./.test(photoStatus), photoStatus);
  await page.click('#editPhotoBtn');
  await page.waitForSelector('#reprocessBtn', { state: 'visible' });
  const writesBefore = await page.evaluate(() => window.__writes.length);
  await page.evaluate(() => { document.getElementById('autoStatus').textContent = ''; });
  await page.click('#reprocessBtn');
  await page.waitForFunction(() => /Frame found/.test(document.getElementById('autoStatus').textContent), null, { timeout: 60000 });
  const keptSize = await page.$eval('#sizeEye', e => e.value);
  check('re-processing keeps the frame\'s size and tags', keptSize === '49');
  await page.$eval('#autoSens', e => { e.value = 130; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => /Frame found/.test(document.getElementById('autoStatus').textContent) && !document.getElementById('addToLibraryBtn').disabled, null, { timeout: 60000 });
  await page.click('#addToLibraryBtn');
  await page.waitForFunction(() => /updated/.test(document.getElementById('addedMsgText').textContent), null, { timeout: 20000 });
  const w2 = await page.evaluate(n => window.__writes.slice(n).map(w => w.join(' ')), writesBefore);
  check('re-processed asset saved against the same product id', w2.some(w => w === 'set users/kiosk/framesFull/' + rid) && w2.some(w => w === 'update users/kiosk/frames/' + rid), w2.join(', '));
  check('the original photo is not re-uploaded when re-processing', !w2.some(w => /framesSource/.test(w)));

  // a product kept as a flat overlay
  await page.click('#tabAddBtn');
  await page.evaluate(() => { document.getElementById('autoStatus').textContent = ''; });
  await upload(page, '#frameUploadBtn', path.join(H.S, 'photos', 'semirimless.png'));
  await page.waitForFunction(() => /Frame found/.test(document.getElementById('autoStatus').textContent), null, { timeout: 60000 });
  await chip(page, '#autoLevelChips', 'Flat overlay');
  await page.click('#addToLibraryBtn');
  await page.waitForFunction(() => /Added/.test(document.getElementById('addedMsgText').textContent), null, { timeout: 20000 });
  const flatId = await page.evaluate(() => { const ids = [...window.__store.keys()].filter(k => /\/frames\/f\d{8,}/.test(k)).map(k => k.split('/').pop()).sort(); return ids[ids.length - 1]; });
  const flatLevel = await page.evaluate(id => window.__store.get('users/kiosk/frames/' + id).level, flatId);
  check('flat-overlay choice is saved per product', flatLevel === '2d');
  await page.click('#tabBrowseBtn');
  const chipShown = await page.$eval(`.frame-card[data-id="${flatId}"]`, e => e.textContent.includes('Flat try-on'));
  check('catalog marks flat-only frames', chipShown);
  await page.click(`.frame-card[data-id="${flatId}"] .frame-card-tryon`);
  await page.click('#goTryOnBtn');
  await sleep(1500);
  const noAr = await page.evaluate(() => !document.querySelector('#photoStage .ar-canvas'));
  check('flat-overlay product uses the flat try-on', noAr);

  // a photo with the frame cut off: flagged, flat only, and never saved without a deliberate yes
  await page.click('#tabAddBtn');
  await page.evaluate(() => { document.getElementById('autoStatus').textContent = ''; });
  await upload(page, '#frameUploadBtn', path.join(H.S, 'photos', 'greygreen-cropped.png'));
  await page.waitForFunction(() => /Frame found|Couldn't find/.test(document.getElementById('autoStatus').textContent), null, { timeout: 60000 });
  const cStatus = await page.$eval('#autoStatus', e => e.textContent);
  const cNotes = await page.$$eval('#autoWarnings li', els => els.map(e => e.className + ': ' + e.textContent));
  check('cropped photo: falls back to a flat overlay', /flat overlay/.test(cStatus) && /needs attention|check the notes/.test(cStatus), cStatus);
  check('cropped photo: the problem is named', cNotes.some(n => /^error: .*cut off/i.test(n)), cNotes.join(' | '));
  const nC = await page.evaluate(() => [...window.__store.keys()].filter(k => /\/frames\//.test(k)).length);
  let dlg = '';
  page.once('dialog', d => { dlg = d.message(); d.dismiss(); });
  await page.click('#addToLibraryBtn');
  await sleep(800);
  const nC2 = await page.evaluate(() => [...window.__store.keys()].filter(k => /\/frames\//.test(k)).length);
  check('cropped photo: saving asks first, and "no" saves nothing', /needs attention/.test(dlg) && nC2 === nC, JSON.stringify({ dlg: dlg.slice(0, 80), nC, nC2 }));
  page.once('dialog', d => d.accept());
  await page.click('#addToLibraryBtn');
  await page.waitForFunction(n => [...window.__store.keys()].filter(k => /\/frames\//.test(k)).length > n, nC, { timeout: 20000 });
  check('cropped photo: "yes" saves it (as a flat overlay)', true);
  check('no console errors (asset workflow)', errors.length === 0, errors.slice(0, 3).join(' | '));
};
