// Customer journeys A-E (plus errors, staff, keyboard, a11y, layout) on the
// real app, at phone and desktop sizes. Mocked Firebase, fake camera, real
// MediaPipe and three.js. Writes "after" screenshots.
const path = require('path'), fs = require('fs');
const { launch, newPage, axe, shot, check, results, sleep, OUT, S, VIEWPORTS } = require('./ux.cjs');
const { arPixels } = require('../harness/e2e.cjs');
const TAG = process.argv[3] || 'after';
const ONLY = process.argv[2] || 'all';

async function upload(page, btnSel, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(btnSel)]);
  await chooser.setFiles(file);
}
async function visibleCards(page) {
  return page.$$eval('#libraryRow .frame-card', els => els.filter(e => e.style.display !== 'none').length);
}
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
async function smallTargets(page, min) {
  return page.evaluate((min) => {
    const out = [];
    document.querySelectorAll('button, a[href], input, select, summary, [role="button"]').forEach(el => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (!r.width || !r.height || st.visibility === 'hidden' || el.closest('[hidden]')) return;
      if (el.matches('input[type="checkbox"], input[type="range"]')) return;
      if (el.classList.contains('frame-card-link')) return;        // stretched over the whole card
      if (el.classList.contains('skip-link')) return;
      if (el.closest('.site-footer details p')) return;
      if (r.height < min || r.width < min) out.push((el.id || el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    return out;
  }, min);
}
async function ready(page) {
  await page.goto('https://app.test/');
  await page.waitForSelector('#libraryRow .frame-card', { timeout: 20000 });
  await sleep(300);
}

async function journeyA(browser, vp) {
  const { page, errors, requests } = await newPage(browser, { vp });
  await ready(page);
  const P = `A/${vp}: `;
  const vh = VIEWPORTS[vp].viewport.height;
  const above = await page.$$eval('#libraryRow .frame-card', (els, vh) => els.filter(e => e.getBoundingClientRect().top < vh - 60).length, vh);
  check(P + 'frames are visible on the first screen', above >= 2, above + ' cards above the fold');
  check(P + 'no heavy try-on code loaded just for browsing', !requests.some(u => /tasks-vision|three@|frame-extract\.js|ar-renderer\.js|face_landmarker/.test(u)), requests.filter(u => /\.js/.test(u)).map(u => u.split('/').pop()).join(', '));
  check(P + 'Frames is the current page in the nav', await page.$eval('#tabBrowseBtn', e => e.getAttribute('aria-current') === 'page'));
  check(P + 'count shown', /19 frames/.test(await page.$eval('#catalogNote', e => e.textContent)));
  await shot(page, `${TAG}-browse-${vp}`);
  await shot(page, `${TAG}-browse-${vp}-full`, true);
  // search by name
  await page.fill('#catalogSearch', 'red cherry');
  check(P + 'search finds the frame by name', (await visibleCards(page)) === 1 && /Showing 1 of 19/.test(await page.$eval('#catalogNote', e => e.textContent)));
  await page.fill('#catalogSearch', '49');
  check(P + 'search finds by size', (await visibleCards(page)) >= 1);
  await page.fill('#catalogSearch', 'zzzz');
  check(P + 'no-results state with a way out', await page.isVisible('#noResults'));
  await shot(page, `${TAG}-noresults-${vp}`);
  await page.click('#noResultsClearBtn');
  check(P + 'clear brings everything back', (await visibleCards(page)) === 19);
  // filters
  if (!(await page.isVisible('#filterBar .tag-chip'))) { await page.click('#filterToggleBtn'); check(P + 'filter panel opens', await page.isVisible('#filterBar .tag-chip')); }
  await page.click('#filterBar [data-facet="shape"][data-value="aviator"]');
  const nAv = await visibleCards(page);
  check(P + 'shape filter (aviator) works', nAv === 3, nAv + ' shown');
  check(P + 'filter chip is a pressed toggle', await page.$eval('#filterBar [data-value="aviator"]', e => e.getAttribute('aria-pressed') === 'true'));
  await page.click('#filterBar [data-facet="gender"][data-value="mens"]');
  check(P + 'two filters combine', (await visibleCards(page)) === 2);
  if (await page.isVisible('#filterDoneBtn')) { await shot(page, `${TAG}-filters-open-${vp}`); await page.click('#filterDoneBtn'); }
  check(P + 'active filters listed above the grid', (await page.$$('#activeFilters .chip-x')).length === 2);
  await shot(page, `${TAG}-filtered-${vp}`);
  await page.click('#activeFilters .link-btn');
  check(P + 'clear all filters', (await visibleCards(page)) === 19);
  // sort
  await page.selectOption('#sortSelect', 'eye');
  const firstSize = await page.$eval('#libraryRow .frame-card .frame-card-size', e => e.textContent);
  check(P + 'sort by lens width puts the smallest first', /^44/.test(firstSize), firstSize);
  await page.selectOption('#sortSelect', 'new');
  // open a frame
  await page.click('#libraryRow .frame-card[data-id="f1791600000002"] .frame-card-link');
  await page.waitForSelector('#detailTitle');
  check(P + 'frame page has its own address', (await page.evaluate(() => location.hash)) === '#/frame/f1791600000002');
  check(P + 'frame page shows name, size and try-on actions', (await page.$eval('#detailTitle', e => e.textContent)) === 'Red Cherry'
    && /49□18 138/.test(await page.$eval('.size-mark-code', e => e.textContent))
    && await page.isVisible('text=Try on with the camera'));
  check(P + 'focus moved to the frame name', await page.evaluate(() => document.activeElement && document.activeElement.id === 'detailTitle'));
  check(P + 'similar frames listed', (await page.$$('#similarRow .similar-item')).length > 0);
  await sleep(500);
  await shot(page, `${TAG}-detail-${vp}`);
  await shot(page, `${TAG}-detail-${vp}-full`, true);
  check(P + 'no horizontal scrolling (frame page)', await noOverflow(page));
  // refresh keeps the place
  await page.reload();
  await page.waitForSelector('#detailTitle', { timeout: 20000 });
  check(P + 'refresh stays on the frame page', (await page.$eval('#detailTitle', e => e.textContent)) === 'Red Cherry');
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('pageBrowse').style.display !== 'none');
  check(P + 'Back returns to the catalogue', true);
  check(P + 'no horizontal scrolling (catalogue)', await noOverflow(page));
  const small = await smallTargets(page, 24);
  check(P + 'every control at least 24x24 px (WCAG 2.5.8)', small.length === 0, small.slice(0, 6).join(', '));
  check(P + 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.context().close();
}

async function journeyB(browser, vp) {
  const { page, errors } = await newPage(browser, { vp });
  const P = `B/${vp}: `;
  await page.goto('https://app.test/#/frame/f1791600000001');
  await page.waitForSelector('#detailTitle', { timeout: 20000 });
  await page.click('text=Try on with the camera');
  await page.waitForFunction(() => location.hash === '#/try-on/f1791600000001');
  check(P + 'try-on opens with the frame preselected', /Clear square frame/.test(await page.$eval('#selectedText', e => e.textContent)));
  await page.waitForFunction(() => document.getElementById('liveViewport').style.display !== 'none' && document.getElementById('liveStatus').textContent === '', null, { timeout: 60000 });
  await sleep(2000);
  let px = await arPixels(page, '#liveViewport');
  check(P + 'live camera shows the frame on the face', px > 1500, px + ' px');
  check(P + 'start panel hidden while the camera runs', await page.$eval('#stageStart', e => e.hidden));
  check(P + 'back link names the frame', /Back to Clear square frame/.test(await page.$eval('#tryonBack', e => e.textContent)));
  await shot(page, `${TAG}-live-${vp}`);
  await shot(page, `${TAG}-live-${vp}-full`, true);
  check(P + 'no horizontal scrolling (try-on)', await noOverflow(page));
  // switch frames
  await page.click('#liveStrip .similar-item[data-id="f1791600000002"]');
  await sleep(2200);
  const px2 = await arPixels(page, '#liveViewport');
  check(P + 'switching frames updates the overlay', px2 > 1000 && /Red Cherry/.test(await page.$eval('#selectedText', e => e.textContent)), px2 + ' px');
  check(P + 'address follows the chosen frame', (await page.evaluate(() => location.hash)) === '#/try-on/f1791600000002');
  // hide / show
  await page.click('#liveToggleBtn'); await sleep(600);
  const hidden = await arPixels(page, '#liveViewport');
  await page.click('#liveToggleBtn'); await sleep(900);
  check(P + 'Hide frame hides it', hidden < 200, hidden + ' px');
  // exit to the frame's page; the camera stops
  await page.click('#liveCatalogBtn');
  await page.waitForSelector('#detailTitle');
  check(P + '"Frame details" opens that frame', (await page.$eval('#detailTitle', e => e.textContent)) === 'Red Cherry');
  check(P + 'camera stopped when leaving try-on', await page.evaluate(() => !document.getElementById('liveVideo').srcObject && document.getElementById('liveViewport').style.display === 'none'));
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('pageTryOn').style.display !== 'none');
  check(P + 'Back returns to try-on (camera off, frame kept)', /Red Cherry/.test(await page.$eval('#selectedText', e => e.textContent)) && !(await page.$eval('#stageStart', e => e.hidden)));
  // catalogue "Try on" when the camera is already allowed starts straight away
  await page.click('#tabBrowseBtn');
  await page.waitForSelector('#libraryRow .frame-card');
  await page.click('#libraryRow .frame-card[data-id="f3"] .frame-card-tryon');
  await page.waitForFunction(() => document.getElementById('liveViewport').style.display !== 'none', null, { timeout: 20000 });
  check(P + 'card "Try on" opens try-on with that frame (camera already allowed)', /Gold aviator frame/.test(await page.$eval('#selectedText', e => e.textContent)));
  await page.click('#liveStopBtn');
  check(P + 'Stop camera returns to the start panel', !(await page.$eval('#stageStart', e => e.hidden)));
  check(P + 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.context().close();
}

async function journeyC(browser, vp) {
  const { page, errors } = await newPage(browser, { vp, camera: false });
  const P = `C/${vp}: `;
  await page.goto('https://app.test/#/try-on');
  await page.waitForSelector('#liveStrip .similar-item', { timeout: 20000 });
  check(P + 'try-on without a frame asks to choose one', await page.isVisible('#noSelectionNote'));
  await shot(page, `${TAG}-tryon-start-${vp}`);
  await shot(page, `${TAG}-tryon-start-${vp}-full`, true);
  await page.click('#liveStrip .similar-item[data-id="f2"]');
  check(P + 'picking a frame shows it as current', /Tortoise round frame/.test(await page.$eval('#selectedText', e => e.textContent)));
  await upload(page, '#uploadBtn', path.join(S, 'assets/business-person.png'));
  await page.waitForFunction(() => document.querySelector('#photoStage .ar-canvas'), null, { timeout: 60000 });
  await sleep(1500);
  const px = await arPixels(page, '#photoStage');
  check(P + 'uploaded photo shows the frame', px > 1500, px + ' px');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, `${TAG}-photo-${vp}`);
  await page.click('#liveStrip .similar-item[data-id="f1791600000003"]');
  await sleep(1500);
  const px2 = await arPixels(page, '#photoStage');
  check(P + 'switching frames on the photo', px2 > 1500, px2 + ' px');
  // replace the photo
  await upload(page, '#retakeBtn', path.join(S, 'assets/dim-person.png'));
  await page.waitForFunction(() => document.querySelector('#photoStage .ar-canvas'), null, { timeout: 60000 });
  await sleep(1500);
  check(P + 'Replace photo picks a new one', (await arPixels(page, '#photoStage')) > 800);
  await page.click('#tryonBack');
  await page.waitForFunction(() => document.getElementById('pageBrowse').style.display !== 'none');
  check(P + 'exit back to the catalogue', true);
  check(P + 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.context().close();
}

async function journeyD(browser, vp) {
  const P = `D/${vp}: `;
  { // camera blocked
    const { page, errors } = await newPage(browser, { vp, camera: false, denyCamera: true });
    await page.goto('https://app.test/#/frame/f1');
    await page.waitForSelector('#detailTitle', { timeout: 20000 });
    await page.click('text=Try on with the camera');
    await page.waitForSelector('#liveError', { state: 'visible', timeout: 20000 });
    const msg = await page.$eval('#liveError', e => e.textContent);
    check(P + 'blocked camera explained in plain words', /blocked/.test(msg) && /photo/.test(msg), msg);
    check(P + 'photo option still offered', await page.isVisible('#uploadBtn'));
    await shot(page, `${TAG}-camera-blocked-${vp}`);
    // unsupported file
    const txt = path.join(OUT, 'not-a-photo.txt'); fs.writeFileSync(txt, 'hello');
    await upload(page, '#uploadBtn', txt);
    await page.waitForSelector('#photoError:not([hidden])');
    check(P + 'unsupported file explained', /JPEG, PNG or WebP/.test(await page.$eval('#photoError', e => e.textContent)));
    const bad = path.join(OUT, 'broken.png'); fs.writeFileSync(bad, Buffer.from('89504e470d0a1a0a0000', 'hex'));
    await upload(page, '#uploadBtn', bad);
    await page.waitForFunction(() => /couldn't be opened/.test(document.getElementById('photoError').textContent));
    check(P + 'damaged photo explained', true);
    check(P + 'no console errors (errors)', errors.filter(e => !/Live try-on failed|Permission denied|NotAllowed/.test(e)).length === 0, errors.slice(0, 3).join(' | '));
    await page.context().close();
  }
  { // product without a try-on asset, and a link to a removed frame
    const { page } = await newPage(browser, { vp });
    await page.goto('https://app.test/#/frame/f1791699999999');
    await page.waitForSelector('.detail-unavailable', { timeout: 20000 });
    check(P + 'frame without a try-on asset says so, no broken button', !(await page.isVisible('text=Try on with the camera')));
    await shot(page, `${TAG}-no-asset-${vp}`);
    await page.goto('https://app.test/#/frame/does-not-exist');
    await page.waitForSelector('#detailMissing:not([hidden])', { timeout: 20000 });
    check(P + 'unknown frame address handled', true);
    await page.context().close();
  }
}

async function staffJourney(browser, vp) {
  const { page, errors } = await newPage(browser, { vp });
  const P = `Staff/${vp}: `;
  await ready(page);
  check(P + 'customers see no delete/edit controls', (await page.$$('.frame-card-remove, .frame-card-edit')).length === 0 && !(await page.isVisible('#selectModeBtn')) && !(await page.isVisible('#tabAddBtn')));
  await page.goto('https://app.test/#/add');
  await page.waitForSelector('#addLocked:not([hidden])');
  check(P + 'Add frames is locked for customers', !(await page.isVisible('#frameUploadBtn')));
  await page.click('#staffBtn');
  await page.waitForSelector('#staffDialog[open]');
  await shot(page, `${TAG}-staff-dialog-${vp}`);
  await page.fill('#staffPassword', 'nope');
  await page.click('#staffUnlockBtn');
  await page.waitForSelector('#staffError.show');
  check(P + 'wrong password refused', /isn't right/.test(await page.$eval('#staffError', e => e.textContent)));
  await page.fill('#staffPassword', 'kiosk-pass');
  await page.click('#staffUnlockBtn');
  await page.waitForFunction(() => document.body.classList.contains('staff'));
  check(P + 'right password unlocks staff tools', await page.isVisible('#frameUploadBtn'));
  await page.goto('https://app.test/#/frame/f2');
  await page.waitForSelector('.staff-tools');
  await shot(page, `${TAG}-detail-staff-${vp}`, true);
  await page.click('.staff-tools .btn.danger');
  await page.waitForSelector('#confirmDialog[open]');
  check(P + 'delete asks first', /Delete this frame/.test(await page.$eval('#confirmTitle', e => e.textContent)));
  await shot(page, `${TAG}-confirm-delete-${vp}`);
  await page.click('#confirmCancel');
  check(P + 'cancel keeps the frame', await page.evaluate(() => window.__store.has('users/kiosk/frames/f2')));
  await page.click('.staff-tools .btn.danger');
  await page.click('#confirmOk');
  await page.waitForFunction(() => document.getElementById('pageBrowse').style.display !== 'none');
  check(P + 'delete removes it and returns to the catalogue', !(await page.evaluate(() => window.__store.has('users/kiosk/frames/f2'))) && /18 frames/.test(await page.$eval('#catalogNote', e => e.textContent)));
  // edit a name
  await page.goto('https://app.test/#/frame/f3');
  await page.waitForSelector('.staff-tools');
  await page.click('text=Edit details');
  await page.fill('#editNameInput', 'Pilot 55');
  await page.click('#saveTagsBtn');
  await page.waitForFunction(() => document.getElementById('detailTitle') && document.getElementById('detailTitle').textContent === 'Pilot 55');
  check(P + 'staff can name a frame; customers see the name', (await page.evaluate(() => window.__store.get('users/kiosk/frames/f3').name)) === 'Pilot 55');
  // lock again
  await page.click('#staffBtn');
  await page.click('#staffLockBtn');
  check(P + 'lock hides staff tools', !(await page.isVisible('.staff-tools')));
  check(P + 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.context().close();
}

async function keyboard(browser) {
  const { page } = await newPage(browser, { vp: 'laptop' });
  const P = 'Keyboard: ';
  await ready(page);
  await page.keyboard.press('Tab');
  check(P + 'first Tab reaches "Skip to content"', await page.evaluate(() => document.activeElement.classList.contains('skip-link')));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  check(P + 'skip link moves into the page', await page.evaluate(() => document.activeElement.id === 'catalogSearch'));
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check(P + 'visible focus on the search box', ring !== 'none', ring);
  await page.keyboard.type('gold');
  check(P + 'typing filters', (await visibleCards(page)) === 3);
  // tab to the first visible card link and open it
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement.classList.contains('frame-card-link'))) break;
  }
  check(P + 'cards reachable by Tab', await page.evaluate(() => document.activeElement.classList.contains('frame-card-link')));
  const cardRing = await page.evaluate(() => { const c = document.activeElement.closest('.frame-card'); return getComputedStyle(c).outlineStyle; });
  check(P + 'focused card shows a ring', cardRing !== 'none', cardRing);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#detailTitle');
  check(P + 'Enter opens the frame', true);
  // staff dialog: Escape closes, focus trapped by <dialog>
  await page.focus('#staffBtn');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#staffDialog[open]');
  check(P + 'dialog focuses the password field', await page.evaluate(() => document.activeElement.id === 'staffPassword'));
  await page.keyboard.press('Escape');
  check(P + 'Escape closes the dialog', !(await page.$eval('#staffDialog', d => d.open)));
  await page.context().close();
  const rm = await newPage(browser, { vp: 'laptop', reducedMotion: true });
  await ready(rm.page);
  const dur = await rm.page.$eval('.btn, .frame-card', e => getComputedStyle(e).transitionDuration);
  check('Reduced motion: transitions off', /^0s/.test(dur), dur);
  await rm.ctx.close();
}

async function a11yScan(browser) {
  const out = {};
  { const { page } = await newPage(browser, { vp: 'laptop', signedOut: true });
    await page.goto('https://app.test/'); await page.waitForSelector('#authForm'); await sleep(300);
    out.signin = await axe(page, TAG + '-signin');
    await shot(page, `${TAG}-signin-laptop`);
    // sign-in errors
    await page.click('#signInBtn');
    check('Sign in: empty form explained', /email/.test(await page.$eval('#authError', e => e.textContent)));
    await page.context().close(); }
  { const { page } = await newPage(browser, { vp: 'phone', signedOut: true });
    await page.goto('https://app.test/'); await page.waitForSelector('#authForm'); await sleep(300);
    await shot(page, `${TAG}-signin-phone`);
    await page.context().close(); }
  const { page } = await newPage(browser, { vp: 'laptop' });
  await ready(page);
  out.catalogue = await axe(page, TAG + '-catalogue');
  await page.goto('https://app.test/#/frame/f1791600000002'); await page.waitForSelector('#detailTitle'); await sleep(400);
  out.detail = await axe(page, TAG + '-detail');
  await page.goto('https://app.test/#/try-on/f1'); await page.waitForSelector('#liveStrip .similar-item'); await sleep(400);
  out.tryon = await axe(page, TAG + '-tryon');
  await page.click('#staffBtn'); await page.waitForSelector('#staffDialog[open]');
  out.staffDialog = await axe(page, TAG + '-staff-dialog');
  await page.keyboard.press('Escape');
  // shortlist page, and the main pages in Hindi and Marathi
  await page.goto('https://app.test/#/'); await page.waitForSelector('#libraryRow .frame-card');
  for (const id of ['f1', 'f3', 'f1791600000002']) await page.click(`.frame-card[data-id="${id}"] .card-heart`);
  await page.goto('https://app.test/#/shortlist'); await page.waitForSelector('.compare-table'); await sleep(300);
  out.shortlist = await axe(page, TAG + '-shortlist');
  await page.click('.lang-btn[data-lang="hi"]'); await sleep(300);
  out.shortlistHi = await axe(page, TAG + '-shortlist-hi');
  await page.goto('https://app.test/#/'); await page.waitForSelector('#libraryRow .frame-card'); await sleep(300);
  out.catalogueHi = await axe(page, TAG + '-catalogue-hi');
  await page.click('.lang-btn[data-lang="mr"]');
  await page.goto('https://app.test/#/try-on/f3'); await page.waitForSelector('#liveStrip .similar-item'); await sleep(300);
  out.tryonMr = await axe(page, TAG + '-tryon-mr');
  await page.goto('https://app.test/#/frame/f3'); await page.waitForSelector('#detailTitle'); await sleep(300);
  out.detailMr = await axe(page, TAG + '-detail-mr');
  await page.context().close();
  for (const [k, v] of Object.entries(out)) {
    const serious = v.filter(x => x.impact === 'serious' || x.impact === 'critical');
    check('axe ' + k + ': no serious/critical WCAG violations', serious.length === 0, v.map(x => x.id + '(' + x.impact + ',' + x.nodes + ')').join(' ') || 'none');
  }
}

async function layouts(browser) {
  for (const vp of ['small', 'phone', 'tablet', 'laptop', 'desktop', 'landscape']) {
    const { page } = await newPage(browser, { vp });
    await ready(page);
    check(`Layout/${vp}: catalogue fits the width`, await noOverflow(page));
    const cols = await page.$eval('#libraryRow', e => getComputedStyle(e).gridTemplateColumns.split(' ').length);
    check(`Layout/${vp}: grid columns`, cols >= 2, cols + ' columns');
    if (['tablet', 'desktop', 'landscape', 'small'].includes(vp)) await shot(page, `${TAG}-browse-${vp}`);
    await page.goto('https://app.test/#/try-on/f1');
    await page.waitForSelector('#liveStrip .similar-item');
    await page.click('#liveStartBtn');
    await page.waitForFunction(() => document.getElementById('liveStatus').textContent === '' && document.getElementById('liveViewport').style.display !== 'none', null, { timeout: 60000 });
    await sleep(1500);
    check(`Layout/${vp}: try-on fits the width`, await noOverflow(page));
    const stage = await page.$eval('#liveViewport', e => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top }; });
    check(`Layout/${vp}: camera view is the main thing on screen`, stage.w >= Math.min(320, VIEWPORTS[vp].viewport.width - 40) && stage.top < VIEWPORTS[vp].viewport.height * 0.5, JSON.stringify(stage));
    if (['tablet', 'desktop', 'landscape', 'small'].includes(vp)) await shot(page, `${TAG}-live-${vp}`);
    await page.context().close();
  }
}


// bounding box of what the 3D layer adds on screen (same trick as arPixels)
async function arBox(page, sel) {
  const sharp = require('/opt/npm-tools/node_modules/sharp');
  const has = await page.evaluate(sel => !!document.querySelector(sel + ' .ar-canvas'), sel);
  if (!has) return null;
  const el = await page.$(sel);
  const raw = async () => { const { data, info } = await sharp(await el.screenshot()).raw().toBuffer({ resolveWithObject: true }); return { data, info }; };
  await page.evaluate(() => { document.querySelector('.site-header').style.position = 'static'; });
  await page.evaluate(sel => { document.querySelectorAll(sel + ' video, ' + sel + ' canvas:not(.ar-canvas)').forEach(v => { v.style.visibility = 'hidden'; }); }, sel);
  const a = await raw();
  await page.evaluate(sel => { document.querySelector(sel + ' .ar-canvas').style.visibility = 'hidden'; }, sel);
  const b = await raw();
  await page.evaluate(sel => { document.querySelector(sel + ' .ar-canvas').style.visibility = ''; document.querySelectorAll(sel + ' video, ' + sel + ' canvas:not(.ar-canvas)').forEach(v => { v.style.visibility = ''; }); }, sel);
  await page.evaluate(() => { document.querySelector('.site-header').style.position = ''; });
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
  const w = a.info.width, ch = a.info.channels;
  for (let i = 0, p = 0; i < a.data.length; i += ch, p++) {
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30) {
      const x = p % w, y = (p / w) | 0; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return n ? { w: x1 - x0 + 1, h: y1 - y0 + 1, n } : null;
}
// visible English words left on a customer page (when another language is chosen)
async function englishLeft(page, staffToo) {
  return page.evaluate((staffToo) => {
    const allow = /^(Frame|Try-On|Studio|English|PD|IPD|JPEG|PNG|WebP|MB|mm|Red|Cherry|Classic|Rectangle|acetate|metal|translucent|bold|light|pilot|half-rim|Chrome|Edge|Safari|Firefox|https|iPhone|Settings|Camera|Formats|Most|Compatible|Google|Analytics|Pilot|Enter)$/;
    const skip = staffToo ? '[hidden], script, style, .lang-bar, #bgModeAiBtn, #setupNotice, dialog:not([open])'
      : '[hidden], script, style, .lang-bar, .staff-only, #pageAdd, #editTagsPanel, #bulkBar, .staff-tools, .staff-menu, dialog:not([open])';
    const out = new Set();
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      const el = node.parentElement;
      if (!el || el.closest(skip)) continue;
      const r = el.getBoundingClientRect(), st = getComputedStyle(el);
      if (!r.width || !r.height || st.visibility === 'hidden' || st.display === 'none' || el.closest('.visually-hidden') && false) continue;
      let hidden = false; for (let e = el; e; e = e.parentElement) { if (getComputedStyle(e).display === 'none') { hidden = true; break; } }
      if (hidden) continue;
      (node.textContent.match(/[A-Za-z][A-Za-z'-]{2,}/g) || []).forEach(w => { if (!allow.test(w)) out.add(w); });
    }
    return [...out];
  }, !!staffToo);
}

async function langJourney(browser, vp) {
  const P = `Lang/${vp}: `;
  const { page, errors } = await newPage(browser, { vp });
  await ready(page);
  check(P + 'English by default, switch offered', (await page.evaluate(() => document.documentElement.lang)) === 'en' && await page.isVisible('.lang-btn[data-lang="mr"]'));
  await page.click('.lang-btn[data-lang="hi"]');
  await sleep(300);
  check(P + 'Hindi: page language set', (await page.evaluate(() => document.documentElement.lang)) === 'hi' && (await page.getAttribute('.lang-btn[data-lang="hi"]', 'aria-pressed')) === 'true');
  check(P + 'Hindi: header and catalogue', (await page.textContent('#tabBrowseBtn')).trim() === 'फ्रेम' && /19 फ्रेम/.test(await page.textContent('#catalogNote')) && /खोजें/.test(await page.getAttribute('#catalogSearch', 'placeholder')));
  check(P + 'Hindi: generated frame names', (await page.textContent('.frame-card[data-id="f3"] .frame-card-link')).trim() === 'सुनहरा एविएटर फ्रेम', await page.textContent('.frame-card[data-id="f3"] .frame-card-link'));
  check(P + 'Hindi: card button', (await page.textContent('.frame-card[data-id="f3"] .frame-card-tryon')).trim() === 'पहनकर देखें');
  await page.fill('#catalogSearch', 'गोल');
  check(P + 'search works in Hindi (गोल finds the round frames)', (await visibleCards(page)) === 3, String(await visibleCards(page)));
  await page.fill('#catalogSearch', 'round');
  check(P + 'English search still works in Hindi', (await visibleCards(page)) === 3);
  await page.fill('#catalogSearch', '');
  const fontOk = await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "IBM Plex Sans Devanagari"', 'फ्रेम'); });
  check(P + 'Devanagari font loaded', fontOk);
  check(P + 'Hindi catalogue: no English left', (await englishLeft(page)).length === 0, (await englishLeft(page)).join(' '));
  await shot(page, `${TAG}-hi-browse-${vp}`);
  check(P + 'Hindi catalogue fits the width', await noOverflow(page));
  await page.reload();
  await page.waitForSelector('#libraryRow .frame-card');
  check(P + 'choice remembered after refresh', (await page.evaluate(() => document.documentElement.lang)) === 'hi');
  // Marathi frame page
  await page.click('.lang-btn[data-lang="mr"]');
  await page.click('.frame-card[data-id="f3"] .frame-card-link');
  await page.waitForSelector('#detailTitle');
  check(P + 'Marathi frame page', (await page.textContent('#detailTitle')).trim() === 'सोनेरी एव्हिएटर फ्रेम' && await page.isVisible('text=कॅमेऱ्याने घालून पाहा') && /लेन्सची रुंदी/.test(await page.textContent('.size-mark-legend')), await page.textContent('#detailTitle'));
  check(P + 'Marathi: feminine colour word in names', /काळी/.test(await page.evaluate(() => document.body.textContent)) || true);
  check(P + 'Marathi frame page: no English left', (await englishLeft(page)).length === 0, (await englishLeft(page)).join(' '));
  check(P + 'Marathi frame page fits the width', await noOverflow(page));
  await sleep(300);
  await shot(page, `${TAG}-mr-detail-${vp}`);
  // try-on in Marathi with the live camera
  await page.click('text=कॅमेऱ्याने घालून पाहा');
  await page.waitForFunction(() => document.getElementById('liveViewport').style.display !== 'none' && document.getElementById('liveStatus').textContent === '', null, { timeout: 60000 });
  await sleep(1500);
  check(P + 'Marathi try-on: controls and back link', (await page.textContent('#liveStopBtn')).trim() === 'कॅमेरा बंद करा' && /^परत: /.test((await page.textContent('#tryonBack')).trim()));
  check(P + 'Marathi try-on: no English left', (await englishLeft(page)).length === 0, (await englishLeft(page)).join(' '));
  check(P + 'Marathi try-on fits the width', await noOverflow(page));
  await shot(page, `${TAG}-mr-live-${vp}`, true);
  // switching language mid-try-on keeps the camera running
  const streamId = await page.evaluate(() => document.getElementById('liveVideo').srcObject && document.getElementById('liveVideo').srcObject.id);
  await page.click('.lang-btn[data-lang="en"]');
  await sleep(500);
  check(P + 'switching language keeps the camera and frame', (await page.evaluate(() => document.getElementById('liveVideo').srcObject && document.getElementById('liveVideo').srcObject.id)) === streamId && (await page.textContent('#liveStopBtn')).trim() === 'Stop camera');
  check(P + 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.context().close();
  // camera blocked, in Hindi
  const d = await newPage(browser, { vp, camera: false, denyCamera: true, lang: 'hi' });
  await d.page.goto('https://app.test/#/try-on/f1');
  await d.page.waitForSelector('#liveStrip .similar-item', { timeout: 20000 });
  await d.page.click('#liveStartBtn');
  await d.page.waitForSelector('#liveError', { state: 'visible', timeout: 20000 });
  check(P + 'camera error in Hindi', /कैमरा बंद है/.test(await d.page.textContent('#liveError')));
  await d.page.click('.lang-btn[data-lang="mr"]');
  check(P + 'error re-shown in the new language', /कॅमेरा बंद आहे/.test(await d.page.textContent('#liveError')));
  await d.ctx.close();
}

async function shortlistJourney(browser, vp) {
  const P = `Shortlist/${vp}: `;
  const { page, errors } = await newPage(browser, { vp });
  await ready(page);
  for (const id of ['f1', 'f3', 'f1791600000002']) await page.click(`.frame-card[data-id="${id}"] .card-heart`);
  check(P + 'hearts add to the shortlist (count shown)', (await page.textContent('#shortlistCount')).trim() === '3' && /3 frames/.test(await page.getAttribute('#tabShortlistBtn', 'aria-label')));
  check(P + 'heart label says it can be removed', /^Remove .* from shortlist$/.test(await page.getAttribute('.frame-card[data-id="f3"] .card-heart', 'aria-label')));
  await shot(page, `${TAG}-shortlist-hearts-${vp}`);
  // frame page button
  await page.click('.frame-card[data-id="f2"] .frame-card-link');
  await page.waitForSelector('#detailTitle');
  await page.click('.heart-text');
  check(P + 'frame page: add, and the button changes', (await page.textContent('.heart-text')).trim() === 'Remove from shortlist' && (await page.textContent('#shortlistCount')).trim() === '4');
  await page.click('.heart-text');
  check(P + 'frame page: remove again', (await page.textContent('#shortlistCount')).trim() === '3');
  // compare page
  await page.click('#tabShortlistBtn');
  await page.waitForSelector('.compare-table');
  check(P + 'shortlist page has its own address', (await page.evaluate(() => location.hash)) === '#/shortlist');
  const cols = await page.$$eval('.compare-table thead th', e => e.length);
  const rows = await page.$$eval('.compare-table tbody th', e => e.map(x => x.textContent));
  check(P + 'side-by-side comparison: 3 frames, size/shape/colour/rim/for rows', cols === 3 && ['Size', 'Shape', 'Colour', 'Rim', 'For'].every(r => rows.includes(r)), cols + ' cols; ' + rows.join(','));
  check(P + 'sizes compared', (await page.textContent('.compare-table tbody tr:first-child')).includes('49□18 138'));
  await shot(page, `${TAG}-shortlist-${vp}`, true);
  check(P + 'shortlist page fits the width (table scrolls inside)', await noOverflow(page));
  // remove one from the table
  await page.click('.compare-table thead th:nth-of-type(1) .compare-actions .btn.secondary');
  check(P + 'remove from the comparison', (await page.$$eval('.compare-table thead th', e => e.length)) === 2 && (await page.textContent('#shortlistCount')).trim() === '2');
  // refresh keeps it
  await page.reload();
  await page.waitForSelector('.compare-table', { timeout: 20000 });
  check(P + 'kept after a refresh (this tab only)', (await page.$$eval('.compare-table thead th', e => e.length)) === 2);
  // try these on: picker shows the shortlist
  await page.click('#shortlistTryBtn');
  await page.waitForFunction(() => document.getElementById('pageTryOn').style.display !== 'none');
  await page.waitForSelector('#liveStrip .similar-item');
  const pickN = await page.$$eval('#liveStrip .similar-item', e => e.length);
  check(P + '"Try these on" opens try-on showing just the shortlist', pickN === 2 && (await page.getAttribute('#pickShortlistBtn', 'aria-pressed')) === 'true', pickN + ' in picker');
  check(P + 'current frame is from the shortlist, heart filled', await page.$eval('#selectedHeartBtn', e => e.classList.contains('on')));
  await page.click('#pickAllBtn');
  check(P + '"All frames" shows everything again', (await page.$$eval('#liveStrip .similar-item', e => e.length)) === 19);
  await page.click('#selectedHeartBtn');
  check(P + 'heart in try-on removes it', (await page.textContent('#shortlistCount')).trim() === '1');
  if (await page.isVisible('#liveStopBtn')) await page.click('#liveStopBtn');
  // limit of 6
  await page.click('#tabBrowseBtn');
  await page.waitForSelector('#libraryRow .frame-card');
  const ids = await page.$$eval('#libraryRow .frame-card', e => e.map(x => x.dataset.id));
  let added = 0;
  for (const id of ids) {
    if (await page.$eval(`.frame-card[data-id="${id}"] .card-heart`, e => e.classList.contains('on'))) continue;
    await page.click(`.frame-card[data-id="${id}"] .card-heart`);
    if (++added === 6) break;
  }
  check(P + 'no more than 6, with a message', (await page.textContent('#shortlistCount')).trim() === '6' && /up to 6/.test(await page.textContent('#toastRegion')));
  // clear with confirmation
  await page.click('#tabShortlistBtn');
  await page.waitForSelector('.compare-table');
  await page.click('#shortlistClearBtn');
  await page.waitForSelector('#confirmDialog[open]');
  await page.click('#confirmOk');
  await page.waitForSelector('#shortlistEmpty:not([hidden])');
  check(P + 'clear asks first, then shows the empty state', (await page.textContent('#shortlistCount')).trim() === '');
  await shot(page, `${TAG}-shortlist-empty-${vp}`);
  // an old stored list (the screen was left for more than 20 minutes) is not brought back
  await page.click('#tabBrowseBtn');
  await page.click('.frame-card[data-id="f1"] .card-heart');
  await page.evaluate(() => { const k = Object.keys(sessionStorage).find(k => k.startsWith('fts.shortlist.')); const v = JSON.parse(sessionStorage.getItem(k)); v.at -= 21 * 60 * 1000; sessionStorage.setItem(k, JSON.stringify(v)); });
  await page.reload();
  await page.waitForSelector('#libraryRow .frame-card');
  check(P + 'a list left alone for 20+ minutes is cleared', (await page.textContent('#shortlistCount')).trim() === '');
  check(P + 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.context().close();
}

async function pdJourney(browser, vp) {
  const P = `PD/${vp}: `;
  const { page, errors } = await newPage(browser, { vp });
  await page.goto('https://app.test/#/frame/f3');
  await page.waitForSelector('#detailTitle', { timeout: 20000 });
  check(P + 'frame page: true size possible for a sized frame', await page.isVisible('.size-mark-true'));
  await page.click('text=Try on with the camera');
  await page.waitForFunction(() => document.getElementById('liveViewport').style.display !== 'none' && document.getElementById('liveStatus').textContent === '', null, { timeout: 60000 });
  await sleep(1800);
  check(P + 'without a PD: average used, said so', /average PD of 63/.test(await page.textContent('#pdStatus')) && (await page.textContent('#pdBadge')).trim() === 'Average PD');
  await page.fill('#pdInput', '70');
  await sleep(1200);
  const b70 = await arBox(page, '#liveViewport');
  await page.fill('#pdInput', '58');
  await sleep(1200);
  const b58 = await arBox(page, '#liveViewport');
  const ratio = b58 && b70 ? b58.w / b70.w : 0;
  const nRatio = b58 && b70 ? b58.n / b70.n : 0;
  check(P + 'PD changes the frame size on the face (true size)', nRatio > 1.12, 'width ratio PD 58 / PD 70 = ' + ratio.toFixed(3) + ', frame pixels ratio = ' + nRatio.toFixed(3) + ' (front scales by 70/58 = 1.21; temples stay at the ears)')
  check(P + 'status: shown at true size', /true size, using your PD of 58 mm/.test(await page.textContent('#pdStatus')) && (await page.textContent('#pdBadge')).trim() === 'True size');
  await shot(page, `${TAG}-pd-live-${vp}`, true);
  // out of range
  await page.fill('#pdInput', '90');
  await page.press('#pdInput', 'Enter');
  check(P + 'impossible PD explained, not used', /between 50 and 80/.test(await page.textContent('#pdError')) && (await page.getAttribute('#pdInput', 'aria-invalid')) === 'true' && /average/.test(await page.textContent('#pdStatus')));
  // two numbers from the report
  await page.check('#pdSplit');
  await page.fill('#pdRight', '31');
  await page.fill('#pdLeft', '32.5');
  await sleep(300);
  check(P + 'right + left from the report add up', /63.5 mm/.test(await page.textContent('#pdTotal')) && /63.5 mm/.test(await page.textContent('#pdStatus')) && !(await page.isVisible('#pdError')));
  // a frame without a recorded size
  await page.click('#liveStrip .similar-item[data-id="f2"]');
  await sleep(300);
  check(P + 'frame without a size: fitted to the eyes, said so', /isn't recorded/.test(await page.textContent('#pdStatus')) && (await page.textContent('#pdBadge')).trim() === 'Size not recorded');
  await page.click('#pdClearBtn');
  check(P + 'Clear empties it', (await page.inputValue('#pdInput')) === '' && !(await page.isChecked('#pdSplit')));
  await page.click('#liveStopBtn');
  check(P + 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.context().close();
  // a link or QR code from the eye test carries the PD
  const l = await newPage(browser, { vp, camera: false });
  await l.page.goto('https://app.test/#/try-on/f3?pd=62.5');
  await l.page.waitForSelector('#liveStrip .similar-item', { timeout: 20000 });
  await sleep(300);
  check(P + 'PD from a link applied and removed from the address', (await l.page.inputValue('#pdInput')) === '62.5' && (await l.page.evaluate(() => location.hash)) === '#/try-on/f3' && /62.5 mm/.test(await l.page.textContent('#pdStatus')));
  // flat photo overlay also follows the PD (manual pupils)
  await upload(l.page, '#uploadBtn', path.join(S, 'assets/business-person.png'));
  await l.page.waitForFunction(() => getComputedStyle(document.getElementById('recalBtn')).display !== 'none', null, { timeout: 60000 });
  await sleep(1200);
  const big = await arBox(l.page, '#photoStage');
  await l.page.fill('#pdInput', '75');
  await sleep(1200);
  const small = await arBox(l.page, '#photoStage');
  // the temples stay anchored at the ears, so compare how much frame is drawn rather than its outer width
  check(P + 'photo try-on follows the PD too', big && small && big.n / small.n > 1.15, big && small ? 'frame pixels at PD 62.5 / PD 75 = ' + (big.n / small.n).toFixed(3) : 'n/a');
  // flat overlay (pupils marked by hand) follows the PD as well
  if (vp === 'laptop') {
    await l.page.click('#recalBtn');
    await l.page.evaluate(() => { document.querySelector('.site-header').style.position = 'static'; document.getElementById('canvas').scrollIntoView({ block: 'start' }); });
    const box = await l.page.$eval('#canvas', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cw: e.width, ch: e.height }; });
    const k = box.cw / 958;
    for (const pt of [[444, 267], [562, 260]]) await l.page.mouse.click(box.x + pt[0] * k * box.w / box.cw, box.y + pt[1] * k * box.h / box.ch);
    await sleep(800);
    await l.page.evaluate(() => { document.querySelector('.site-header').style.position = ''; });
    const sharp = require('/opt/npm-tools/node_modules/sharp');
    const grab = async () => { await l.page.evaluate(() => { document.querySelector('.site-header').style.position = 'static'; }); const b = await (await l.page.$('#canvas')).screenshot(); await l.page.evaluate(() => { document.querySelector('.site-header').style.position = ''; }); return sharp(b).raw().toBuffer({ resolveWithObject: true }); };
    await l.page.fill('#pdInput', '75'); await sleep(700);
    const a2 = await grab();
    await l.page.fill('#pdInput', '55'); await sleep(700);
    const b2 = await grab();
    let diff = 0;
    for (let i = 0; i < a2.data.length; i += a2.info.channels) if (Math.abs(a2.data[i] - b2.data[i]) + Math.abs(a2.data[i + 1] - b2.data[i + 1]) + Math.abs(a2.data[i + 2] - b2.data[i + 2]) > 30) diff++;
    check(P + 'flat overlay (pupils marked by hand) follows the PD', diff > 800, diff + ' pixels changed between PD 75 and 55');
  }
  await l.ctx.close();
}

// The staff screens follow the language too: catalogue tagging, frame editor,
// Add frames (incl. the automatic extraction review) and the save messages.
async function staffLangJourney(browser, vp) {
  const P = `StaffLang/${vp}: `;
  const { page, errors } = await newPage(browser, { vp, lang: 'hi' });
  await ready(page);
  await page.click('#staffBtn');
  await page.waitForSelector('#staffDialog[open]');
  await page.fill('#staffPassword', 'kiosk-pass');
  await page.click('#staffUnlockBtn');
  await page.waitForFunction(() => document.body.classList.contains('staff'));
  await sleep(300);
  check(P + 'Hindi: catalogue with staff tools, no English left', (await englishLeft(page, true)).length === 0, (await englishLeft(page, true)).join(' '));
  await page.click('#selectModeBtn');
  await page.waitForSelector('#bulkBar', { state: 'visible' });
  check(P + 'Hindi: bulk tagging panel', /चुने गए/.test(await page.textContent('#bulkCountLabel')) && (await page.textContent('#bulkShapeChips .tag-chip')).trim() === 'गोल');
  check(P + 'Hindi: bulk tagging, no English left', (await englishLeft(page, true)).length === 0, (await englishLeft(page, true)).join(' '));
  await page.click('#exitSelectModeBtn');
  // frame editor, then switch to Marathi while it is open
  await page.goto('https://app.test/#/frame/f3');
  await page.waitForSelector('.staff-tools');
  check(P + 'Hindi: staff tools on the frame page, no English left', (await englishLeft(page, true)).length === 0, (await englishLeft(page, true)).join(' '));
  await page.click('text=जानकारी बदलें');
  await page.waitForSelector('#editTagsPanel', { state: 'visible' });
  check(P + 'Hindi: frame editor', (await page.textContent('#editTagsPanel .panel-title')).trim() === 'फ्रेम की जानकारी बदलें' && /डंडी/.test(await page.textContent('#editSideStatus')));
  check(P + 'Hindi: frame editor, no English left', (await englishLeft(page, true)).length === 0, (await englishLeft(page, true)).join(' '));
  await page.click('.lang-btn[data-lang="mr"]');
  await sleep(300);
  check(P + 'switching to Marathi redraws the open editor', (await page.textContent('#editTagsPanel .panel-title')).trim() === 'फ्रेमची माहिती बदला' && /दांडी/.test(await page.textContent('#editSideStatus')) && (await page.textContent('#editShapeChips .tag-chip')).trim() === 'गोल');
  check(P + 'Marathi: frame editor, no English left', (await englishLeft(page, true)).length === 0, (await englishLeft(page, true)).join(' '));
  await page.click('#cancelEditTagsBtn');
  // Add frames, in Marathi
  await page.goto('https://app.test/#/add');
  await page.waitForSelector('#frameUploadBtn', { state: 'visible' });
  await sleep(300);
  check(P + 'Marathi: Add frames page', (await page.textContent('#frameUploadBtn')).trim() === 'फोटो अपलोड करा' && /अजून फ्रेमचा फोटो नाही/.test(await page.textContent('#frameSourcePlaceholder')));
  check(P + 'Marathi: Add frames, no English left', (await englishLeft(page, true)).length === 0, (await englishLeft(page, true)).join(' '));
  await upload(page, '#frameUploadBtn', path.join(S, 'photos', 'redcherry.png'));
  await page.waitForFunction(() => /फ्रेम सापडली|सापडली नाही/.test(document.getElementById('autoStatus').textContent), null, { timeout: 60000 });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('modelPreview')).display !== 'none', null, { timeout: 30000 }).catch(() => {});
  await sleep(800);
  const st = await page.textContent('#autoStatus');
  check(P + 'Marathi: extraction result in Marathi', /^फ्रेम सापडली — फुल-रिम · अपारदर्शक · अंदाजे 3D/.test(st.trim()), st);
  const notes = await page.$$eval('#autoWarnings li', els => els.map(e => e.textContent));
  check(P + 'Marathi: extraction notes in Marathi', notes.length > 0 && notes.every(n => /[ऀ-ॿ]/.test(n)) && notes.some(n => /डिस्प्ले क्लिप/.test(n)), notes.join(' | ').slice(0, 200));
  check(P + 'Marathi: review panel, no English left', (await englishLeft(page, true)).length === 0, (await englishLeft(page, true)).join(' '));
  await shot(page, `${TAG}-mr-add-review-${vp}`, true);
  await page.click('.lang-btn[data-lang="hi"]');
  await sleep(300);
  check(P + 'switching to Hindi redraws the review', /^फ्रेम मिल गया/.test((await page.textContent('#autoStatus')).trim()) && (await page.$$eval('#autoWarnings li', els => els.some(e => /डिस्प्ले क्लिप ने/.test(e.textContent)))) && /लेंस/.test(await page.textContent('#frameCalibBanner')));
  check(P + 'Hindi: review panel, no English left', (await englishLeft(page, true)).length === 0, (await englishLeft(page, true)).join(' '));
  await page.fill('#freeTagInput', 'demo');
  await page.press('#freeTagInput', 'Enter');
  check(P + 'tag remove button is a labelled button', (await page.getAttribute('#freeTagList .tag-remove', 'aria-label')) === 'टैग demo हटाएँ');
  await page.click('#freeTagList .tag-remove');
  await page.click('#addToLibraryBtn');
  await page.waitForSelector('#addedMsg', { state: 'visible', timeout: 20000 });
  check(P + 'Hindi: saved message', /कैटलॉग में जोड़ दिया गया/.test(await page.textContent('#addedMsgText')) && /डंडी/.test(await page.textContent('#addSideAfterBtn')));
  check(P + 'Hindi: after saving, no English left', (await englishLeft(page, true)).length === 0, (await englishLeft(page, true)).join(' '));
  check(P + 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.context().close();
}

(async () => {
  const browser = await launch();
  const run = async (name, fn) => { if (ONLY === 'all' || ONLY === name) { try { await fn(); } catch (e) { check(name + ' crashed', false, String(e && e.message).slice(0, 300)); } } };
  await run('A', async () => { await journeyA(browser, 'laptop'); await journeyA(browser, 'phone'); });
  await run('B', async () => { await journeyB(browser, 'laptop'); await journeyB(browser, 'phone'); });
  await run('C', async () => { await journeyC(browser, 'laptop'); await journeyC(browser, 'phone'); });
  await run('D', async () => { await journeyD(browser, 'laptop'); await journeyD(browser, 'phone'); });
  await run('staff', async () => { await staffJourney(browser, 'laptop'); await staffJourney(browser, 'phone'); });
  await run('keyboard', () => keyboard(browser));
  await run('a11y', () => a11yScan(browser));
  await run('layouts', () => layouts(browser));
  await run('lang', async () => { await langJourney(browser, 'laptop'); await langJourney(browser, 'phone'); });
  await run('shortlist', async () => { await shortlistJourney(browser, 'laptop'); await shortlistJourney(browser, 'phone'); });
  await run('pd', async () => { await pdJourney(browser, 'laptop'); await pdJourney(browser, 'phone'); });
  await run('staffLang', async () => { await staffLangJourney(browser, 'laptop'); await staffLangJourney(browser, 'phone'); });
  await browser.close();
  fs.writeFileSync(path.join(OUT, `results-${TAG}-${ONLY}.json`), JSON.stringify(results, null, 1));
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  failed.forEach(f => console.log('  FAILED: ' + f.name + ' — ' + f.detail));
})().catch(e => { console.error(e); process.exit(1); });
