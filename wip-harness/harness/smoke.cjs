const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const S = process.env.S;
const VER = process.argv[2] || '1.1.0';
const dir = VER === '1.1.0' ? 'mediapipe-tasks-vision-1.1.0' : 'tv01035';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  page.on('console', m => console.log('[console]', m.type(), m.text().slice(0, 300)));
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    const mime = f => f.endsWith('.js') || f.endsWith('.mjs') ? 'text/javascript' : f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.png') ? 'image/png' : 'text/html';
    let file = null;
    if (u.host === 'app.test') {
      if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body>hi</body></html>' });
      file = path.join(S, 'assets', u.pathname.slice(1));
    } else if (u.host === 'cdn.jsdelivr.net' && u.pathname.includes('tasks-vision')) {
      const rest = u.pathname.split(/tasks-vision(@[^/]*)?/).pop();
      file = path.join(S, 'vendor', dir, 'package', rest || '/vision_bundle.mjs');
    } else if (u.host === 'storage.googleapis.com') file = path.join(S, 'assets', 'face_landmarker.task');
    if (file && fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file), contentType: mime(file), headers: { 'access-control-allow-origin': '*' } });
    console.log('ABORT', u.href); return route.abort();
  });
  await page.goto('https://app.test/');
  const r = await page.evaluate(async () => {
    const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
    const out = { webgl2: !!gl, renderer: gl && gl.getParameter(gl.RENDERER), secure: window.isSecureContext };
    const { FaceLandmarker, FilesetResolver } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision');
    const fs = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm');
    const t0 = performance.now();
    const lm = await FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 1, outputFacialTransformationMatrixes: true });
    out.loadMs = Math.round(performance.now() - t0);
    const img = new Image(); img.src = '/business-person.png'; await img.decode();
    const t1 = performance.now();
    const res = lm.detect(img);
    out.detectMs = Math.round(performance.now() - t1);
    const L = res.faceLandmarks[0];
    out.n = L && L.length;
    out.pts = L && [33, 133, 362, 263, 468, 473, 1, 168, 234, 454].map(i => [i, +(L[i].x * img.naturalWidth).toFixed(1), +(L[i].y * img.naturalHeight).toFixed(1), +(L[i].z * img.naturalWidth).toFixed(1)]);
    out.mat = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0] && Array.from(res.facialTransformationMatrixes[0].data).map(v => +v.toFixed(3));
    return out;
  });
  fs.writeFileSync(path.join(S, "harness", "smoke-" + VER + ".json"), JSON.stringify(r));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
