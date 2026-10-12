// Browser test harness: serves the site from this folder and opens it in
// headless Chromium (Playwright), with the external libraries served from
// local copies so the tests run offline and deterministically:
//   - Firebase JS SDK (gstatic)       -> node_modules/firebase
//   - three.js (jsdelivr)             -> node_modules/three
//   - MediaPipe Face Landmarker       -> a stub returning a synthetic face
//                                        (no real face video is needed)
// The camera is Chromium's fake device. Network requests are recorded so tests
// can check that no image data leaves the page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

function findPkg(name) {
  const tries = [path.join(ROOT, 'node_modules', name), process.env.EXTRA_NODE_MODULES ? path.join(process.env.EXTRA_NODE_MODULES, name) : null].filter(Boolean);
  for (const t of tries) if (fs.existsSync(t)) return t;
  return path.dirname(require.resolve(name + '/package.json'));
}

export function loadPlaywright() {
  try { return require('playwright'); } catch (e) { return require('/opt/npm-tools/node_modules/playwright'); }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

export function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: 'http://127.0.0.1:' + server.address().port }));
  });
}

// A face for the stub: MediaPipe's canonical face model, placed in the image
// and turned by `yaw` (radians), as normalised landmarks (478 with irises).
function stubSource() {
  const geo = fs.readFileSync(path.join(ROOT, 'face-geometry.js'), 'utf8');
  const verts = geo.match(/CANONICAL_VERTICES = (\[[^\]]*\])/)[1];
  return `
const V = ${verts};
let t0 = Date.now();
function face(yaw) {
  const pts = [];
  const s = 0.024, cx = 0.5, cy = 0.46, c = Math.cos(yaw), sn = Math.sin(yaw);
  for (let i = 0; i < V.length / 3; i++) {
    const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
    const xr = x * c + z * sn, zr = -x * sn + z * c;
    pts.push({ x: cx + xr * s * 0.75, y: cy - y * s, z: -zr * s * 0.75 });
  }
  const mid = (a, b) => ({ x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2, z: (pts[a].z + pts[b].z) / 2 });
  const l = mid(33, 133), r = mid(362, 263);
  for (let k = 0; k < 5; k++) pts.push(l);
  for (let k = 0; k < 5; k++) pts.push(r);
  return pts;
}
window.__stubFaceCalls = 0;
class Landmarker {
  detect() { window.__stubFaceCalls++; return { faceLandmarks: window.__stubNoFace ? [] : [face(0)] }; }
  detectForVideo() { window.__stubFaceCalls++; const a = Math.sin((Date.now() - t0) / 900) * 0.25; return { faceLandmarks: window.__stubNoFace ? [] : [face(a)] }; }
  close() {}
}
export const FilesetResolver = { forVisionTasks: async () => ({}) };
export const FaceLandmarker = { createFromOptions: async () => new Landmarker() };
`;
}

export async function openBrowser(opts = {}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist']
  });
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, locale: opts.locale || 'en-IN', permissions: ['camera'] });
  const firebaseDir = findPkg('firebase');
  const threeDir = findPkg('three');
  const stub = stubSource();
  const requests = [];
  context.on('request', (r) => requests.push({ url: r.url(), method: r.method(), postSize: (r.postDataBuffer() || Buffer.alloc(0)).length, type: r.resourceType(), headers: r.headers() }));
  await context.route('https://www.gstatic.com/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop();
    const file = path.join(firebaseDir, name);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing ' + name });
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file) });
  });
  await context.route('https://cdn.jsdelivr.net/npm/three@*/build/**', (route) => {
    const name = route.request().url().split('/').pop();
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(threeDir, 'build', name)) });
  });
  await context.route(/https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@[^/]+(\/.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: stub, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  if (!opts.allowFirebaseNetwork) {
    // no real Firebase project in tests: those calls fail fast (as if offline),
    // unless the emulators are used
    await context.route(/https:\/\/(firestore|identitytoolkit|securetoken|firebasestorage|firebaseinstallations|firebase)\.googleapis\.com\/.*/, (route) => route.abort('internetdisconnected'));
  }
  // instrument the camera: every track the page opens is remembered
  await context.addInitScript(() => {
    window.__tracks = [];
    const orig = navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null;
    if (orig) navigator.mediaDevices.getUserMedia = async (c) => { const s = await orig(c); s.getTracks().forEach((t) => window.__tracks.push(t)); return s; };
  });
  return { browser, context, requests };
}

export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

export { ROOT };
