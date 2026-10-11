// Shared routing for headless tests: serves the repo + local copies of CDN files.
const fs = require('fs'), path = require('path');
const S = '/tmp/claude-0/-home-claude-framesstudio/7f645946-6658-5275-9df6-0c8bac7c2301/scratchpad';
const REPO = '/home/claude/framesstudio';
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.task': 'application/octet-stream' };
const log = [];
async function route(r, extra) {
  const u = new URL(r.request().url());
  let file = null;
  if (extra) { const res = await extra(u, r); if (res === true) return; if (typeof res === 'string') file = res; }
  if (!file) {
    if (u.host === 'app.test') {
      const p = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
      for (const base of [REPO, path.join(S, 'harness'), path.join(S, 'frames'), path.join(S, 'assets')]) {
        if (fs.existsSync(path.join(base, p)) && fs.statSync(path.join(base, p)).isFile()) { file = path.join(base, p); break; }
      }
    } else if (u.host === 'cdn.jsdelivr.net' && u.pathname.includes('@mediapipe/tasks-vision')) {
      const rest = u.pathname.split(/tasks-vision(@[^/]*)?/).pop() || '/vision_bundle.mjs';
      file = path.join(S, 'vendor', 'tv01035', 'package', rest === '/' ? '/vision_bundle.mjs' : rest);
    } else if (u.host === 'cdn.jsdelivr.net' && u.pathname.startsWith('/npm/three@')) {
      file = path.join(S, 'vendor', 'three-0.186.1', 'package', u.pathname.replace(/^\/npm\/three@[^/]+/, ''));
    } else if (u.host === 'storage.googleapis.com') {
      file = path.join(S, 'assets', 'face_landmarker.task');
    } else if (u.host === 'fonts.googleapis.com') {
      return r.fulfill({ contentType: 'text/css', body: '' });
    }
  }
  if (file && fs.existsSync(file)) {
    log.push('200 ' + u.href.slice(0, 120));
    return r.fulfill({ body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'application/octet-stream', headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
  }
  log.push('ABORT ' + u.href.slice(0, 160));
  return r.abort();
}
function launchArgs(extra) {
  return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'].concat(extra || []);
}
module.exports = { route, log, S, REPO, launchArgs };
