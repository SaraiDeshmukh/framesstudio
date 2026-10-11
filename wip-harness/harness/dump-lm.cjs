const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const H = require('./serve.cjs');
(async () => {
  const browser = await chromium.launch({ args: H.launchArgs() });
  const page = await browser.newPage();
  await page.route('**/*', r => H.route(r));
  await page.goto('https://app.test/render-test.html');
  await page.waitForFunction(() => window.ready);
  for (const f of ['business-person.png', 'testImg.jpeg']) {
    const r = await page.evaluate(async (src) => {
      const { FaceLandmarker, FilesetResolver } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35');
      const fsr = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm');
      const lmk = window._l2 || (window._l2 = await FaceLandmarker.createFromOptions(fsr, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 2, outputFacialTransformationMatrixes: true }));
      const img = new Image(); img.src = '/' + src; await img.decode();
      const res = lmk.detect(img);
      return { w: img.naturalWidth, h: img.naturalHeight, faces: res.faceLandmarks.map(l => l.map(p => [p.x, p.y, p.z])), mats: res.facialTransformationMatrixes.map(m => Array.from(m.data)) };
    }, f);
    fs.writeFileSync(path.join(H.S, 'harness', f + '.lm.json'), JSON.stringify(r));
    console.log(f, r.w, r.h, r.faces.length);
  }
  await browser.close();
})();
