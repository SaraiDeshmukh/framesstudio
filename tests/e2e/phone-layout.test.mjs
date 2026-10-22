// Every page fits a small phone (360 px wide): nothing sticks out sideways
// (wide tables scroll inside their own box), and the header shows all its links.
//
//   node --test --test-concurrency=1 tests/e2e/phone-layout.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, openBrowser } from './harness.mjs';
import { buildSeed } from './seed.mjs';

const seed = buildSeed({ s1: { name: 'Deshmukh Eye Hospital (Sarode Opticals Branch)', count: 30 }, s2: { name: 'Beta Eyewear', count: 4 }, s5: { name: 'Pending Optics', count: 2, status: 'pending' } });
const USERS = { guest: null, s1: { uid: 's1', email: 's1@example.com' }, s5: { uid: 's5', email: 's5@example.com' }, newbie: { uid: 'u9', email: 'u9@example.com' }, admin: { uid: 'admin1', email: 'admin@example.com' } };
const PAGES = {
  guest: ['#/', '#/frames', '#/demo', '#/shop/s1', '#/frame/s1p001', '#/try-on/s1p001', '#/shortlist', '#/shops', '#/partner', '#/shop/s1?qr=1', '/legal/privacy.html'],
  s1: ['#/partner/products', '#/partner/shop', '#/partner/import', '#/partner/product/s1p001', '#/add/s1p001'],
  s5: ['#/partner/shop'], newbie: ['#/partner'],
  admin: ['#/admin', '#/admin/shops', '#/admin/products', '#/admin/legal', '#/admin/settings', '#/admin/audit']
};
let server, origin;
before(async () => { ({ server, origin } = await serve()); });
after(() => { if (server) server.close(); });

function sticksOut() {
  const vw = document.documentElement.clientWidth, out = [];
  const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return true; return false; };
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!b.width || !b.height || s.position === 'fixed' || s.visibility === 'hidden') continue;
    if ((b.right > vw + 1 || b.left < -1) && !clipped(el)) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\s+/).join('.')) + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
  }
  return { page: document.documentElement.scrollWidth, vw, out: out.slice(0, 5) };
}

for (const [who, list] of Object.entries(PAGES)) {
  test('fits a 360 px phone: ' + who, async () => {
    const { browser, context } = await openBrowser({ fake: { seed, user: USERS[who] }, viewport: { width: 360, height: 740 } });
    try {
    for (const path of list) {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(origin + (path.startsWith('#') ? '/' + path : path));
      await page.waitForTimeout(1500);
      const r = await page.evaluate(sticksOut);
      assert.ok(r.page <= r.vw && !r.out.length, path + ' is ' + r.page + ' px wide: ' + r.out.join(', '));
      if (path.startsWith('#') && !/qr=1/.test(path)) {
        // the main links are all on screen, each on one line
        for (const id of ['tabTryOnBtn', 'tabBrowseBtn', 'tabShopsBtn', 'tabShortlistBtn']) {
          const b = await page.locator('#' + id).boundingBox();
          assert.ok(b && b.x >= 0 && b.x + b.width <= 360 && b.height <= 48, path + ': ' + id + ' ' + JSON.stringify(b));
        }
      }
      await page.close();
    }
    } finally { await browser.close(); }
  });
}
