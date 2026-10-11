const path = require('path');
const { launch, newPage, axe, shot, sleep, OUT, S } = require('./ux.cjs');
(async () => {
  const browser = await launch();
  const tag = process.argv[2] || 'before';
  // sign-in
  for (const vp of ['phone', 'laptop']) {
    const { page } = await newPage(browser, { vp, signedOut: true });
    await page.goto('https://app.test/'); await sleep(800);
    await shot(page, `${tag}-signin-${vp}`);
    if (vp === 'laptop') console.log('axe signin', JSON.stringify(await axe(page, tag + '-signin')));
    await page.context().close();
  }
  for (const vp of ['phone', 'tablet', 'laptop']) {
    const { page, errors } = await newPage(browser, { vp });
    await page.goto('https://app.test/');
    await page.waitForSelector('.frame-card', { timeout: 20000 }); await sleep(600);
    await shot(page, `${tag}-browse-${vp}`, false);
    await shot(page, `${tag}-browse-${vp}-full`, true);
    if (vp === 'laptop') console.log('axe browse', JSON.stringify(await axe(page, tag + '-browse')));
    // try on tab, nothing selected
    await page.click('#tabTryOnBtn'); await sleep(400);
    await shot(page, `${tag}-tryon-empty-${vp}`, true);
    if (vp === 'laptop') console.log('axe tryon', JSON.stringify(await axe(page, tag + '-tryon')));
    console.log(vp, 'errors', errors.slice(0, 3));
    await page.context().close();
  }
  // live try-on from a frame on the phone + laptop
  for (const vp of ['phone', 'laptop']) {
    const { page } = await newPage(browser, { vp });
    await page.goto('https://app.test/');
    await page.waitForSelector('.frame-card', { timeout: 20000 });
    await page.click('.frame-card[data-id="f1791600000001"] .frame-card-tryon');
    await sleep(300);
    await shot(page, `${tag}-after-tap-tryon-${vp}`);
    await page.click('#goTryOnBtn');
    await page.click('#liveStartBtn');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('liveStripWrap')).display !== 'none', null, { timeout: 60000 });
    await sleep(2500);
    await shot(page, `${tag}-live-${vp}`);
    await shot(page, `${tag}-live-${vp}-full`, true);
    await page.click('#liveStopBtn');
    // photo
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#uploadBtn')]);
    await chooser.setFiles(path.join(S, 'assets/business-person.png'));
    await page.waitForFunction(() => document.querySelector('#photoStage .ar-canvas'), null, { timeout: 60000 }); await sleep(1500);
    await page.evaluate(() => document.getElementById('viewport').scrollIntoView());
    await shot(page, `${tag}-photo-${vp}`);
    await page.context().close();
  }
  // add frames
  { const { page } = await newPage(browser, { vp: 'laptop' });
    await page.goto('https://app.test/'); await page.waitForSelector('.frame-card', { timeout: 20000 });
    await page.click('#tabAddBtn'); await sleep(300);
    await shot(page, `${tag}-add-laptop`, true);
    await page.context().close(); }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
