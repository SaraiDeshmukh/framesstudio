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
  await browser.close();
  fs.writeFileSync(path.join(OUT, `results-${TAG}-${ONLY}.json`), JSON.stringify(results, null, 1));
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  failed.forEach(f => console.log('  FAILED: ' + f.name + ' — ' + f.detail));
})().catch(e => { console.error(e); process.exit(1); });
