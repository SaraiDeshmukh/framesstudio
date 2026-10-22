# Frame Try-On Studio

A website where customers try eyeglass frames on their face in the browser, using the live camera or a photo, and see frames listed by partner optical shops. Shops manage their own frames, prices and GST from a dashboard. The platform owner approves shops and moderates listings from an admin dashboard.

- **Customers** don't need an account. They can try the six **demo frames**, browse shops, try frames on, shortlist them and contact the shop.
- **Partner shops** sign up, accept the shop terms, and are approved by the admin. They then add frames: details, photos (with automatic quality checks and retake guidance), automatic try-on preparation, price and GST, availability, and publishing.
- **Admin** (the owner) approves, rejects, suspends and reactivates shops; suspends or removes listings; handles reports; and manages legal versions, acceptance records, settings and the demo.

All permissions are enforced by Firebase security rules on the server (`firestore.rules`, and `storage.rules` once Cloud Storage is used), not by hiding buttons.

It runs on Firebase's free **Spark** plan: frame pictures are kept in Firestore, and customers' pages read a shop's one-document catalogue index and then only the frames on screen. See `COSTS.md`.

**Customer photos are never uploaded or stored.** Face tracking runs in the browser, and the site has no photo capture, download or sharing. See `legal/privacy.html`.

## Documents

| File | What it's for |
|---|---|
| `SETUP.md` | **Start here.** Firebase steps on the free plan (create Firestore, deploy rules, make yourself admin), going live, and moving to Blaze later |
| `COSTS.md` | Free-plan limits, reads per visit, how far the free plan goes, and when Blaze is worth it |
| `legal/` | Drafts of the customer terms, partner shop terms and privacy policy, all marked for legal review |
| `LEGAL-REVIEW.md` | Blanks to fill in and points for the lawyer (DPDP Act 2023 and Rules 2025, IT Rules, consumer law, GST) |

## Pages

| Address | Who | What |
|---|---|---|
| `#/` | everyone | Home: demo frames, how it works, shops |
| `#/demo` | everyone | The six demo frames (made for the demo, not for sale) |
| `#/shops`, `#/shop/<id>` | everyone | Approved shops and their published frames |
| `#/frame/<id>`, `#/try-on/<id>` | everyone | Frame page (price, GST, availability, shop contact) and try-on |
| `#/shortlist` | everyone | Compare up to 6 frames (kept in that tab only) |
| `#/partner` | shops | Sign in or up, apply, frames, shop profile, CSV import |
| `#/admin` | admin only | Overview, shops (and managing a shop's frames), listings, reports, legal, settings, audit log |
| `#/shop/<id>?kiosk=1` | shop screens | One shop's frames on an in-store screen |
| `#/shop/<id>?qr=1` | customers' phones | Opened by the shop's QR code: that shop's frames and try-on, staying on that shop |

## Files

- `index.html`, `styles.css`: page structure and styling
- `app.js`: customer site, routing, try-on and the photo step
- `partner.js`, `admin.js`: shop and admin dashboards (loaded only when opened)
- `backend.js`, `firebase-init.js`, `firebase-config.js`: Firebase data layer and configuration. The config values are public identifiers, not secrets. `imageStore` in `firebase-config.js` chooses where frame pictures go (`'firestore'` on Spark, `'storage'` on Blaze).
- `catalogue-index.js`: each shop's catalogue index (what customers' pages read first)
- `cache.js`: the browser cache (IndexedDB) that saves repeat reads
- `photo-import.js`, `vendor/fflate.mjs` (MIT): adding many frames at once from a photo package (.zip); `scripts/prep-shop-photos.mjs` prepares one
- `qr.js`, `vendor/qrcode-generator.mjs` (MIT): each shop's QR code, PNG download and printable poster, drawn in the browser (no outside QR service)
- `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `firebase.json`, `cors.json`: backend rules and settings, deployed as described in `SETUP.md`
- `pricing.js`: prices in paise, GST inclusive, exclusive or none, at the shop's own rate (no default rate)
- `validation.js`: the same field checks the rules enforce, so the forms can explain problems
- `photo-quality.js`: blur, darkness, glare and size checks on frame photos, with retake guidance
- `demo/`: the six demo frames (rendered images, prepared by the real extraction pipeline)
- `i18n.js`, `i18n-platform.js`: English, Hindi and Marathi text
- `frame-extract.js`, `asset-build.js`, `glasses-model.js`, `ar-renderer.js`, `headpose.js`, `tracking.js`, `face-geometry.js`, `frame-size.js`: frame extraction and 3D try-on (unchanged in approach, described below)
- `tests/`: unit tests, security-rule tests (run in the Firebase emulators) and a browser test harness

## Data model

```
admins/{uid}                 exists only for the admin (created in the Firebase console)
config/{legal|platform|demo} required legal versions, platform settings, demo visibility (admin writes)
acceptances/{uid_doc_version}  who accepted which terms version, when (append-only)
shops/{uid}                  public shop profile + status: pending | approved | rejected | suspended
shopPrivate/{uid}            owner name, phone, GSTIN (shop and admin only)
products/{id}                shopId, details, tags, size, pricing {pricePaise, taxMode, taxRate, salePaise, confirmed, updatedAt},
                             availability, status draft|published|archived, moderation, tryOn, images, public (true only when
                             published, complete, not suspended and the shop is approved). Each image: {path, w, h, bytes} plus
                             data (inline data: URL: thumbnail, fitting data), fid (a productFiles doc) or url (Storage)
productFiles/{productId__name}  free plan: one larger picture each (cut-out, temple photo, original photo) as a data: URL;
                             never changes (new versions get new names). Customer pictures readable by name, originals private
catalogues/{shopId}          the shop's public frames in short form {items: {productId: {n, t, z, pr, a, r, c, u, ...}}},
                             written with each product change; customers' pages read this first (1 read per shop)
reports/{id}                 "Report this listing" (no personal details), limits/{uid} for the one-a-minute limit
auditLog/{id}                admin actions (append-only)
users/{uid}/...              the original single-shop library, kept so it can be copied into a shop
```

On the free plan, pictures are in Firestore (above). With `imageStore: 'storage'` (Blaze), new files go to Cloud Storage under `shops/{shopId}/products/{productId}/assets/` (cut-out, thumbnail, temple photo, fitting data; publicly viewable) and `.../source/` (the original photo; private to the shop and admin). Frames saved either way keep working.

## Tests

- `npm test`: unit tests (pricing and GST, validation, photo checks, demo frames, extraction, 3D maths)
- `npm run test:rules`: Firestore and Storage rules in the Firebase emulators. Covers tenant isolation, nobody making themselves admin, publishing honesty, price-change stamps, terms re-acceptance, shop review, moderation, reports, "nowhere for a customer photo to go", and the free-plan picture documents and catalogue index.
- Both run on every push (GitHub Actions, workflow "Tests").
- `npm run test:e2e`: the site in headless Chromium against an in-memory Firestore that counts reads like Firestore bills them (`tests/e2e/fake-firebase.mjs`): catalogue paging, search, filters, sorting, shop switching, frame page, live try-on, caching, the dashboard's incremental loading, index upkeep, a frame photographed, cut out, saved to Firestore and tried on, and shops' QR codes (decoded with jsQR from the screen, the PNG and the printed poster; scanning on a phone). Needs Playwright's Chromium (not run in CI).

## Preparing frames from ordinary photos

In the shop dashboard, **Add a frame → Add photo** takes an ordinary phone photo of a frame — on a table or a display stand, against a wall, with shadows, reflections and things visible through the lenses — and prepares the try-on asset from it. No studio photo, no manual background removal.

### Workflow

1. **Upload or take a photo** of the glasses straight on, filling most of the picture.
2. **The frame is found automatically** (about two seconds on a desktop browser, likely longer on an older phone; nothing leaves the device).
3. **Preview** — the cut-out is shown on a checkerboard, with the lens outlines (teal), bridge (blue), hinges (brass) and any area that needs checking (red dashed box) drawn over it. The panel underneath says what was found (e.g. *Frame found — Full-rim · translucent · approximate 3D (looks good)*) and lists what was removed or what to check.
4. **Correct if needed** (optional): rim type (Full-rim / Semi-rimless / Rimless), material (Translucent / Solid) and Sensitivity re-run the extraction; drag a red marker to move a lens centre; Erase / Restore brush for leftover bits; Try-on style switches between approximate 3D and a flat overlay.
5. **Preview on a face** opens the unsaved frame in the real Try On page (photo or live camera); **Back to Add Frames** returns with the work intact.
6. **Add to library** saves the processed cut-out, the fitting metadata and the original photo against a new product id. A result with a serious problem (frame cut off by the photo edge, very lopsided photo) is never saved silently: saving asks first.
7. **Regenerate later** — the shop dashboard → the frame → **Replace photo** → **Re-process the original photo** (with different settings) or upload a better photo of the same frame. It is saved against the same product id; tags and size stay.

The older one-click **Simple removal** (for photos already on a plain light background) is still there, and is used automatically for temple photos.

### What is extracted

- **Frame vs background**: a smooth background model is fitted from the photo's edges (so uneven light, a table edge or a horizon don't count as frame), and the frame is whatever stands out from it.
- **Lens openings**: traced around each lens from the inside of the rim. Things seen *through* a lens — the temples, the stand, printing on demo lenses, a table edge, reflections — are removed, and the opening stays clear.
- **Rim type**: thick all round = full-rim; rim on top only, thin lens edge below = semi-rimless (the thin edge is kept faint, a lower rim is never invented); no rim = rimless.
- **Translucency and colour**: each pixel's opacity is worked out from how much it darkens the background, and the colour behind it is subtracted out, so translucent acetate stays see-through and keeps its colour instead of turning into a dark silhouette.
- **Shadows**: the shadow on the table under and beside the bottom of the rims is removed (it darkens the background evenly in every channel; tinted material doesn't).
- **Display stands**: an acrylic clip over the bridge and the stand's discs and post are removed. Where the clip covered the bridge, that stretch is rebuilt from the bridge either side of it — and **flagged** with a box, because it's a reconstruction.
- **Fitting landmarks**: lens centres (the middle of each lens outline), bridge midpoint and top, hinges, tilt, frame extents and aspect. These feed the try-on directly; staff don't tap lens centres any more unless they want to move them.

### 2D or 3D — decided per photo

Each result is labelled with the most it can honestly support:

- **Approximate 3D** (the default when the frame is complete and reasonably front-on): the front comes from the photo, given depth and a slight wrap; temples are generated from the rim material (or taken from a temple photo). It is not a scanned 3D model and the app never calls it one.
- **Flat overlay**: used when the frame is cut off by the photo edge or the photo is strongly angled. The frame still follows the face, without depth. Staff can also choose it by hand.
- A fuller 3D reconstruction would need several photos from different angles (or a scan). That isn't built; one frontal photo can't show the depth or the hidden surfaces.

### Where it runs, and why

GitHub Pages only serves static files, so there is nowhere on the site to run server code. The options were:

- **In the browser, at preparation time** (chosen): runs on the shop's own phone/tablet/PC when a frame is added, costs nothing, needs no extra service or keys, and works with the existing Firebase setup. The result is stored per product, so customers' devices never redo it.
- **A local script** (e.g. Python/OpenCV on a staff PC): no better results for this kind of image, but an extra tool to install and keep in sync with the catalogue.
- **A separate backend** (e.g. a cloud function with an AI background-removal model): needs a paid plan (Firebase Blaze or similar), secret keys and upkeep. Generic AI background removers also tend to drop thin rims and the see-through parts of translucent frames, which matter most here.

The extraction is classical computer vision (background modelling, evidence thresholds, contour tracing, matting) in plain JavaScript — no model download, no network calls. If a better photo or a better algorithm comes along, frames can be re-processed from their stored originals.

### Results on the reference photos

Run on the three photos in `tests/fixtures/` (in Node and through the real Add Frames page in Chromium):

| Photo | Detected | What happened |
|---|---|---|
| Grey-green translucent acetate, lying on a table | Full-rim · translucent · approximate 3D | Background, horizon, the temples seen through the lenses and the table shadow removed; rims stay see-through grey-green. |
| Navy metal full-rim on a display stand (49□18-138) | Full-rim · solid · approximate 3D | Stand post, discs and lens printing removed; the clip at the bridge removed and the bridge rebuilt — flagged for checking. |
| Brown semi-rimless on a display stand (51□16-135) | Semi-rimless · solid · approximate 3D | Brown browline kept; lower lens edges kept as faint lines (no lower rim added); clip removed and bridge rebuilt — flagged. |

All three load in the try-on, sit on the face from their stored landmarks (photo and live camera), and are saved as three separate products with their own assets.

### Limits (honest version)

- One frontal photo is still one view: depth, the inside of the rims and the temples are approximated, as described above.
- A bridge hidden behind a display clip is rebuilt as a straight, plain stretch. If the bridge has a shape or detail under the clip, photograph the frame off the stand.
- Metal nose pads inside the lens outline are removed along with other things seen through the lens; pads outside it are kept.
- Clear or very light frames on a light background give the extraction little to work with; a darker background (or raising Sensitivity) helps.
- Strong reflections on the lenses, busy backgrounds and steep angles reduce accuracy. These cases are flagged rather than guessed at, but a flag isn't a guarantee — always glance at the preview.
- Size printed inside the temple isn't read automatically; type it in for true-to-size try-on.

## 3D try-on (live camera and photos)

**Start camera** (or **Try on with the camera** on a frame's page) opens the front camera and shows the chosen frame on the customer's face in 3D, following head turns, nods and tilts in real time. Pick or search frames in the picker to swap without restarting the camera. Controls: Stop camera, Switch camera (when there is more than one), Hide/Show frame, Frame details, and under **Adjust size** a size slider and an optional pupil distance (PD) field. A chosen photo gets the same 3D treatment automatically (with Replace photo, Use live camera, Hide/Show frame and Frame details); if no face is found, the customer or staff tap the centre of each eye and the flat overlay is used.

### How it works

1. **Tracking** — MediaPipe Face Landmarker (Google, Apache 2.0, runs on the device) finds 478 face points in every camera frame.
2. **Head pose** (`headpose.js`) — MediaPipe's canonical 3D face model is fitted to the rigid parts of the face (forehead, nose, eye corners, cheekbones — not the mouth or jaw, so expressions don't move the glasses) through a perspective camera model. That gives the real yaw, pitch and roll, and the head's position and size. A One Euro filter removes jitter without adding lag. The tracked camera frame and the glasses are drawn together, so they can't drift apart even on a slow device.
3. **Frame model** (`glasses-model.js`) — built from the frame's cut-out photo and lens points (and, for frames prepared automatically, the stored lens outlines, rim type and translucency): the frame's axis, the hinges (where the temples start), the clear lens openings, the rim thickness and a strip of the real rim material, and metal vs acetate (from the colour tag, else rim thickness).
4. **Rendering** (`ar-renderer.js`, three.js, MIT) — the photo becomes a gently wrapped, tilted front with real depth (stacked layers whose sides show at an angle), glass lenses with reflections and a faint tint, temples running back to the ears in the frame's own material, and a soft contact shadow. The customer's face and head are drawn invisibly so the nose hides the far rim and the head hides the far temple. Frame colours stay as photographed; overall brightness follows the room (measured from the face), so a frame doesn't glow in a dim shop.
5. **Fallback** — no WebGL, or a cut-out that can't be analysed: the flat 2D overlay from `tracking.js` is used for that frame. Nothing breaks.

### What each frame needs (and what makes it better)

- **Required:** the front cut-out and its two lens points. Frames prepared automatically get these (plus lens outlines, rim type and translucency) from the photo; older frames keep working in 3D with no extra work.
- **Recommended: frame size** (eye, bridge, temple — printed inside the temple, e.g. `52□18 140`). Enter it in the frame's details in the shop dashboard. With eye + bridge, and the customer's **PD** entered under Adjust size, the frame is shown at its true size relative to the face, so a 49 mm and a 55 mm frame look different, as they should. Without a size, the lens centres are placed on the pupils (the previous behaviour). Sizes are never guessed.
- **Optional: temple photo.** Once a frame's try-on is ready (shop dashboard → the frame → **Add temple photo**), photograph one temple from the side; tap the hinge, then the far tip. The 3D try-on then uses the real temple (shape, logo, colour) instead of one generated from the rim material.
- **Photo quality matters most:** a sharp, front-on photo with some space around the glasses gives the best result. **Preview on a face** shows the unsaved frame in the real try-on before saving.

### Limits (honest version)

- The frame front is a photo given depth, not a scanned 3D model. At large head turns (beyond ~45–50°) it shows that the front is thin, and the inside faces of the rims are approximations.
- Temples without a temple photo are generated: right position and material, not the exact shape. With a temple photo, its logo reads correctly on one side only (one photo serves both temples).
- Hair over the ears does not hide the temples; they fade out where they reach the ear instead.
- Head shape is a generic adult model scaled to the face, and the camera's field of view is assumed (~72° diagonal); unusual head shapes or very wide-angle cameras reduce accuracy at the sides.
- Real-size display depends on the entered frame size and PD. Without the PD, a 63 mm adult average is used.
- Tracking needs the face reasonably lit and in view; very strong backlight or turning past profile loses it.

### Privacy

Customer camera frames and photos are processed in the browser tab only. Nothing is recorded, captured, uploaded or stored, and there is no photo capture, download or sharing. A chosen photo is held in memory and cleared when it's replaced, when the try-on page is left, and after 20 minutes without use. The camera stops on Stop, when the try-on page is left, and when the tab is hidden or closed. The try-on loads MediaPipe (`cdn.jsdelivr.net`, pinned to 0.10.35), its face model (`storage.googleapis.com`) and three.js (`cdn.jsdelivr.net`, pinned to 0.186.1). There are no analytics. Frame photos (products, not people) are uploaded by shops to the project's Firestore database (or Cloud Storage on Blaze).

### Testing

- `node --test tests/*.test.mjs` — maths tests (pose recovery through real perspective up to 45° turns, smoothing, frame analysis, sizes, temple photos) and the photo extraction, run on the three real photos in `tests/fixtures/` (lens centres against hand-measured positions, clear lens openings, translucency kept, shadows/stand/printing removed, bridge rebuilt and flagged, semi-rimless lower edge kept faint) plus synthetic cases (gradient background with a table edge, printing in the lens, open-bottom lenses, a frame cut off by the edge, a blank photo).
- During development of the earlier single-shop version, the whole site was also driven in headless Chromium (real MediaPipe and three.js, a fake camera, Firebase mocked out) at 360, 390, 820, 1280 and 1600 px wide and in phone landscape: the customer journeys (browse → frame page → live try-on → switch frames → back; photo upload, replace, switch; camera blocked, unsupported or damaged files, a frame with no try-on asset, an unknown frame address), staff mode (lock, wrong/right password, edit, delete with confirmation), keyboard-only use, reduced motion, an axe-core WCAG 2.2 AA scan of every main view (also in Hindi and Marathi, and the shortlist page), switching language on every page, staff screens included (nothing left in English, frame names and search in Devanagari, open panels redrawn on a switch, the choice remembered), shortlist and compare (add/remove from every place, limit, clear, tab-only storage, cleared on idle), the PD panel (single and split numbers, range checks, frame drawn smaller/larger as the PD changes in 3D, photo and flat views, `?pd=` links), and the Add Frames → review → preview → save flow. Those browser scripts aren't part of the repo.
- Real-camera behaviour should be checked by hand on the deployed https site, on the kiosk and on a phone: camera permission prompt, tracking while turning the head, and how each catalogue frame looks.

## Notes

- This was written and syntax-checked but **not tested against a live Firebase project** — I don't have one to test against. The Firebase API calls follow the current documented v9+ modular SDK, so they should work, but budget some time for first-run debugging, and check the browser console (F12) if something doesn't behave — the error messages Firebase throws are usually specific enough to point at the fix (a rule typo, an unauthorized domain, etc.).
- Camera access requires HTTPS (or `localhost`) — GitHub Pages serves over HTTPS automatically, so this isn't something you need to configure.
- To run locally: `python3 -m http.server 8000` in this folder, then open `http://localhost:8000` (opening `index.html` as a file won't work, because the app uses JavaScript modules).
