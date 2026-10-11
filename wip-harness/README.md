# Work-in-progress browser test harness (not part of the site)

Saved here on the `ux-redesign-wip` branch so the test work isn't lost if the
cloud session ends. **Remove this folder before merging to main.**

It runs the real app (index.html + app.js) in headless Chromium with:
- Firebase mocked (`harness/mocks/*.js`, test password `kiosk-pass`, user `kiosk`),
- a fake camera (`--use-file-for-fake-video-capture=<a .y4m video of a face>`),
- real MediaPipe and three.js,
- a seeded catalogue (`frames/seed.json`; `ux/make-seed.mjs` builds the 19-frame
  `seed-ux.json` from it plus the three reference photos).

The scripts expect everything under one scratch folder `S` (set at the top of
`harness/serve.cjs`) laid out as: `S/harness`, `S/ux`, `S/frames`, `S/photos`
(the three reference photos), `S/assets` (face videos + portrait photos:
`face_motion.y4m`, `business-person.png`, `dim-person.png` — not committed:
large and contain a face; recreate with any front-facing portrait, e.g.
`ffmpeg -loop 1 -i portrait.png -t 10 -pix_fmt yuv420p face_motion.y4m`), and
`S/uxdeps` (`npm install axe-core@4.10.2 @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono`).

Suites:
- `node harness/e2e.cjs photo|live|fallback|add|auto` — try-on and Add Frames functionality.
- `node ux/journeys.cjs A|B|C|D|staff|keyboard|a11y|layouts` — customer journeys
  A–E, staff mode, keyboard, axe-core WCAG scan, phone/tablet/desktop layouts.
- `node ux/before.cjs before` — screenshots of the site (used for before/after).
