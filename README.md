# Frame Try-On Studio

A small web app for photographing/uploading eyeglass frames, tagging them, and trying them on a photo. Runs entirely in the browser except for Firebase, which handles accounts and data.

Images are stored directly inside Firestore documents rather than in Firebase Storage, which means this app runs entirely on Firebase's free **Spark** plan — no billing account, no credit card, ever.

## Files

- `index.html` — page structure
- `styles.css` — all styling
- `firebase-config.js` — **the one file you edit** with your own Firebase project's keys
- `app.js` — all the application logic
- `i18n.js` — every customer-facing word in English, Hindi and Marathi (one dictionary per language); no DOM
- `headpose.js` — 3D head pose from the face landmarks (fits a 3D face model, smoothing); no DOM, unit-tested
- `frame-extract.js` — turns an ordinary phone photo of a frame into a transparent cut-out plus fitting metadata (lens outlines, bridge, hinges, rim type, translucency, warnings); no DOM, unit-tested
- `frame-size.js` — frame size helpers (52□18 140), shared by the catalogue and the 3D model; no DOM
- `glasses-model.js` — turns a frame's cut-out photo into a 3D model description (hinges, lens openings, rim material, real size); no DOM, unit-tested
- `ar-renderer.js` — draws the 3D frame on the face with WebGL (three.js)
- `face-geometry.js` — MediaPipe's canonical 3D face model (data, Apache 2.0)
- `tracking.js` — the original flat (2D) overlay maths, still used as the fallback on devices without WebGL; unit-tested
- `tests/*.test.mjs` — unit tests (`node --test tests/*.test.mjs`, Node 18+, no dependencies); `tests/png.mjs` is a tiny PNG reader for them
- `tests/fixtures/` — three real phone photos of frames (reduced to 900 px) that the extraction is tested against
- `README.md` — this file

## 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with a Google account.
2. Click **Add project**, name it (e.g. `frame-studio`), and finish the wizard (you can decline Google Analytics, and skip "Gemini in Firebase" if it's offered).
3. In the left sidebar, click **Build → Authentication → Get started**. Under **Sign-in method**, enable **Email/Password**.
4. Click **Build → Firestore Database → Create database**. Choose a region close to you, and start in **production mode** (you'll paste in real rules below, so this is safe).
5. Click the gear icon → **Project settings**, scroll to **Your apps**, click the **`</>`** (Web) icon, give it a nickname, and register it. Firebase will show you a config object that looks like:
   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "frame-studio-xxxxx.firebaseapp.com",
     projectId: "frame-studio-xxxxx",
     storageBucket: "frame-studio-xxxxx.appspot.com",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
   You won't use `storageBucket` for anything — Firebase includes it automatically, and it's fine to leave in place unused.
6. Copy those six values into `firebase-config.js` in this project, replacing the placeholders.

These values are meant to be public — they identify your project, they aren't secret keys. What actually protects your data is the security rule below, so don't skip step 2.

That's the whole Firebase side. No Storage bucket, no Blaze plan, no card on file.

## 2. Lock down the security rule

Without this, anyone could read or write anyone else's data. In the Firebase console, go to **Firestore → Rules**, and replace the contents with:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```
This says you can only read or write documents inside your own `users/{your-uid}/...` path. Click **Publish**.

## 3. Put it on GitHub Pages

Simplest path, no command line needed:

1. Go to [github.com](https://github.com), sign in (or create an account), click **New repository**. Name it anything (e.g. `frame-studio`), keep it public, create it.
2. Click **Add file → Upload files**, drag in all the files from this project (the `.html`, `.css` and `.js` files — `firebase-config.js` with your real values already pasted in — plus `README.md` and the `tests` folder), then **Commit changes**.
3. Go to the repo's **Settings → Pages**. Under **Build and deployment → Source**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, **Save**.
4. Wait a minute, refresh that same settings page — it'll show a live URL like `https://yourusername.github.io/frame-studio/`. That's your site.

If you'd rather use git from the command line, it's the standard `git init`, `git add .`, `git commit`, `git remote add origin <url>`, `git push` — then the same Settings → Pages step.

## 4. Authorize the domain in Firebase

Firebase blocks sign-in from domains it doesn't recognize. In the console: **Authentication → Settings → Authorized domains → Add domain**, and add your `yourusername.github.io` domain. `localhost` is already allowed by default, which is useful if you want to test by opening `index.html` through a local server before deploying.

## Data model

A few collections per user, split so browsing the catalog stays fast without pulling every full-size image at once:

```
users/{uid}/frames/{frameId}       — light doc, loaded upfront for the catalogue: thumbData, tags,
                                     name (optional, shown to customers),
                                     size {eye, bridge, temple} (mm, optional), hasSide,
                                     level ('3d' | '2d'), rimType, translucent,
                                     prepared ('auto' | 'manual'), hasSource
users/{uid}/framesFull/{frameId}   — heavy doc, loaded only when a frame is selected:
                                     imageData (the processed cut-out), p1, p2 (lens centres),
                                     imgW, imgH, fit (fitting metadata, see below)
users/{uid}/framesSource/{frameId} — the original photo the cut-out was made from (JPEG,
                                     up to 1600 px), kept so the asset can be regenerated
users/{uid}/framesSide/{frameId}   — optional temple (side) photo for the 3D try-on:
                                     imageData, hinge, tip, imgW, imgH
users/{uid}/stats/customerPhotos   — a plain counter, no images
```

`imgW`/`imgH` record the pixel size the points refer to, so they stay correct when a photo is shrunk to fit. Frames saved before this existed still work (the app detects the old shrink and rescales their points). No Firestore rule change is needed: everything is under `users/{uid}/`.

`thumbData` and `imageData` are base64 PNG/JPEG strings, not URLs — the whole point of this setup is that no separate file storage is involved. Each is capped and, if a photo would still come out too large, automatically shrunk further until it comfortably fits inside Firestore's 1MB-per-document limit.

`fit` (on frames prepared automatically; `null` for the simple removal) is stored in the saved cut-out's pixels:

```
{ v: 1, source: 'auto', rimType: 'full' | 'semi' | 'rimless', translucent, level: '3d' | '2d', quality: 0–1,
  lenses: [{ side, poly: [{x,y}…] (lens opening outline), centre }],
  landmarks: { lensL, lensR, bridge, bridgeTop, hingeL, hingeR, angle },
  measurements: { frameWidthPx, frameHeightPx, lensWidthPx, lensHeightPx, bridgePx, lensDistPx, aspect },
  warnings: ['shadow', 'bridgeRepaired', …], repaired: [{minX,minY,maxX,maxY}] (areas rebuilt) }
```

Measurements are relative (pixels of the photo). Real millimetres only ever come from the size printed on the frame, typed in by staff; nothing is estimated in mm.

## Using the site

The same address serves customers at the shop screen and staff.

**Customers** see these pages, each with its own address so Refresh and Back work:

- **Frames** (`#/`) — the catalogue. Search by name, shape, colour or size; filter by the tags your frames actually have (shape, colour, who it's for, rim type — side panel on a computer, a Filters button on a phone); sort by newest, oldest or lens width.
- **A frame's page** (`#/frame/<id>`) — big photo, name, **Try on with the camera** / **Try on with a photo**, the size drawn as an optician would (52□18 140), its details, and similar frames. A frame with no usable try-on picture says so instead of offering a button that wouldn't work.
- **Try on** (`#/try-on/<id>`) — opens with that frame already chosen. A short start panel explains what happens and that the browser will ask for the camera; or upload / take a photo (JPEG, PNG or WebP). Frames can be switched without stopping the camera. **Back to <frame>** returns to the frame's page; the camera always stops when leaving the page. On a phone the camera view comes first, its controls in one row under it, and the frame picker right after.
- **Shortlist** (`#/shortlist`, heart in the header with a count) — tap the heart on any frame card, frame page or in Try on to keep it. The page shows the shortlisted frames side by side (size, shape, colour, rim, who it's for, material when recorded), each with **Try on** and **Remove**; **Try these on** opens Try on with the picker narrowed to the shortlist, and **Clear shortlist** asks first. Up to 6 frames.

**Language** — the bar at the very top switches the whole site between English, हिंदी and मराठी: every customer page, sign-in, and the staff screens (Add frames, the automatic extraction review and its notes, editing, tagging, messages). The choice is remembered on that device; the first visit follows the browser's language. Frame names are built from the tags in the chosen language (e.g. *काला गोल फ्रेम*, Marathi *काळी गोल फ्रेम*), and search understands tag words in any of the three languages. Staff-typed data (a frame's own name, extra tags) is shown as typed. The Hindi and Marathi text was written by an AI assistant and should be checked by a native speaker: all of it is in `i18n.js` — change the wording there, keep the `{name}`-style placeholders, and to add a sentence add the same key to all three dictionaries.

**True size from the eye test** — in Try on, the panel *True size from your eye test* takes the customer's PD (pupil distance) in mm, or the right- and left-eye numbers if the report shows two (they are added up). Numbers outside 50–80 mm (25–40 mm per eye) are queried rather than used. With a PD entered, a frame whose size is recorded (lens width and bridge) is drawn at its real width relative to the customer's eyes — in the live 3D view, on photos and in the flat overlay — and a badge says *True size*; otherwise an average PD of 63 mm is used and the badge says so, and a frame with no recorded size says *Size not recorded*. The size sliders still work on top of it.

To fill the PD in from an eye-test system or a printed QR code, add it to a try-on address: `https://<your-site>/#/try-on/<frame id>?pd=62.5`. The value is put into the panel and removed from the address bar straight away.

Every page carries the reminder that try-on is a visual preview, not a fitting, and a short note on how camera and photos are used.

The shortlist is kept in that browser tab only (session storage) and the PD only in memory; both are cleared after 20 minutes without use, on sign-out, or when the tab is closed, so the next customer at a shop screen starts fresh. Only the language choice is remembered on the device.

**Staff tools** — adding, editing and deleting frames — are hidden from customers. Tap **Staff** (padlock, top right) and enter the shop account's password. On a shared shop screen leave "Keep staff tools unlocked on this device" off: the tools lock again after 15 minutes without use (or straight away with **Lock staff tools**). On your own phone you can keep them unlocked. Once unlocked:

- **Add frames** appears in the header (and in the Staff menu).
- Each frame's page gets **Staff tools**: Edit details (name, tags, size), Update photo, Add/replace temple photo, Delete frame (asks first), plus a line saying how its try-on asset was prepared.
- **Tag several frames** on the catalogue applies the same tags to many frames at once.

This lock keeps the customer screen tidy and stops accidental deletes; it isn't a security boundary against someone who has the account password (Firebase rules still protect the data from everyone else).

## Preparing frames from ordinary photos

Add Frames → **Automatic (recommended)** takes an ordinary phone photo of a frame — on a table or a display stand, against a wall, with shadows, reflections and things visible through the lenses — and prepares the try-on asset from it. No studio photo, no manual background removal.

### Workflow

1. **Upload or take a photo** of the glasses straight on, filling most of the picture.
2. **The frame is found automatically** (about two seconds on a desktop browser, likely longer on an older phone; nothing leaves the device).
3. **Preview** — the cut-out is shown on a checkerboard, with the lens outlines (teal), bridge (blue), hinges (brass) and any area that needs checking (red dashed box) drawn over it. The panel underneath says what was found (e.g. *Frame found — Full-rim · translucent · approximate 3D (looks good)*) and lists what was removed or what to check.
4. **Correct if needed** (optional): rim type (Full-rim / Semi-rimless / Rimless), material (Translucent / Solid) and Sensitivity re-run the extraction; drag a red marker to move a lens centre; Erase / Restore brush for leftover bits; Try-on style switches between approximate 3D and a flat overlay.
5. **Preview on a face** opens the unsaved frame in the real Try On page (photo or live camera); **Back to Add Frames** returns with the work intact.
6. **Add to library** saves the processed cut-out, the fitting metadata and the original photo against a new product id. A result with a serious problem (frame cut off by the photo edge, very lopsided photo) is never saved silently: saving asks first.
7. **Regenerate later** — the frame's page → Staff tools → **Update photo** → **Re-process the original photo** (with different settings) or upload a better photo of the same frame. It is saved against the same product id; tags and size stay.

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

**Start camera** (or **Try on with the camera** on a frame's page) opens the front camera and shows the chosen frame on the customer's face in 3D, following head turns, nods and tilts in real time. Pick or search frames in the picker to swap without restarting the camera. Controls: Stop camera, Switch camera (when there is more than one), Hide/Show frame, Frame details, and under **Adjust size** a size slider and an optional pupil distance (PD) field. An uploaded or captured photo gets the same 3D treatment automatically (with Replace photo, Use live camera, Hide/Show frame and Frame details); if no face is found, the customer or staff tap the centre of each eye and the flat overlay is used.

### How it works

1. **Tracking** — MediaPipe Face Landmarker (Google, Apache 2.0, runs on the device) finds 478 face points in every camera frame.
2. **Head pose** (`headpose.js`) — MediaPipe's canonical 3D face model is fitted to the rigid parts of the face (forehead, nose, eye corners, cheekbones — not the mouth or jaw, so expressions don't move the glasses) through a perspective camera model. That gives the real yaw, pitch and roll, and the head's position and size. A One Euro filter removes jitter without adding lag. The tracked camera frame and the glasses are drawn together, so they can't drift apart even on a slow device.
3. **Frame model** (`glasses-model.js`) — built from the frame's cut-out photo and lens points (and, for frames prepared automatically, the stored lens outlines, rim type and translucency): the frame's axis, the hinges (where the temples start), the clear lens openings, the rim thickness and a strip of the real rim material, and metal vs acetate (from the colour tag, else rim thickness).
4. **Rendering** (`ar-renderer.js`, three.js, MIT) — the photo becomes a gently wrapped, tilted front with real depth (stacked layers whose sides show at an angle), glass lenses with reflections and a faint tint, temples running back to the ears in the frame's own material, and a soft contact shadow. The customer's face and head are drawn invisibly so the nose hides the far rim and the head hides the far temple. Frame colours stay as photographed; overall brightness follows the room (measured from the face), so a frame doesn't glow in a dim shop.
5. **Fallback** — no WebGL, or a cut-out that can't be analysed: the flat 2D overlay from `tracking.js` is used for that frame. Nothing breaks.

### What each frame needs (and what makes it better)

- **Required:** the front cut-out and its two lens points. Frames prepared automatically get these (plus lens outlines, rim type and translucency) from the photo; older frames keep working in 3D with no extra work.
- **Recommended: frame size** (eye, bridge, temple — printed inside the temple, e.g. `52□18 140`). Enter it when adding a frame, or later via Staff tools → **Edit details**. With eye + bridge, and the customer's **PD** entered under Adjust size, the frame is shown at its true size relative to the face, so a 49 mm and a 55 mm frame look different, as they should. Without a size, the lens centres are placed on the pupils (the previous behaviour). Sizes are never guessed.
- **Optional: temple photo.** After adding a frame (or from Staff tools → **Add temple photo**), photograph one temple from the side; tap the hinge, then the far tip. The 3D try-on then uses the real temple (shape, logo, colour) instead of one generated from the rim material.
- **Photo quality matters most:** a sharp, front-on photo with some space around the glasses gives the best result. **Preview on a face** shows the unsaved frame in the real try-on before saving.

### Limits (honest version)

- The frame front is a photo given depth, not a scanned 3D model. At large head turns (beyond ~45–50°) it shows that the front is thin, and the inside faces of the rims are approximations.
- Temples without a temple photo are generated: right position and material, not the exact shape. With a temple photo, its logo reads correctly on one side only (one photo serves both temples).
- Hair over the ears does not hide the temples; they fade out where they reach the ear instead.
- Head shape is a generic adult model scaled to the face, and the camera's field of view is assumed (~72° diagonal); unusual head shapes or very wide-angle cameras reduce accuracy at the sides.
- Real-size display depends on the entered frame size and PD. Without the PD, a 63 mm adult average is used.
- Tracking needs the face reasonably lit and in view; very strong backlight or turning past profile loses it.

### Privacy

Customer camera frames and photos are processed in the browser tab only. Nothing is recorded, captured, uploaded or stored; an uploaded photo is held in memory for the session and discarded on retake, sign-out or page close. The camera stops on Stop, when leaving the try-on page, when the page is hidden or closed, and on sign-out. The only network requests the try-on adds are the libraries and model, loaded the first time it's used: MediaPipe (`cdn.jsdelivr.net`, pinned to 0.10.35) and its face model (`storage.googleapis.com`, ~4 MB), and three.js (`cdn.jsdelivr.net`, pinned to 0.186.1). No API keys or paid services. The shortlist (frame ids only) stays in the browser tab and the PD in memory; neither is sent anywhere, and both are cleared after 20 minutes without use or on sign-out. The existing Google Analytics (Firebase Analytics) setup counts usage events such as "frame tried on" with the frame's tags; no photos, video or face data are sent. Frame photos (products, not people) are processed in the browser too; the original and the processed cut-out are stored in your own Firestore account, nowhere else.

### Testing

- `node --test tests/*.test.mjs` — maths tests (pose recovery through real perspective up to 45° turns, smoothing, frame analysis, sizes, temple photos) and the photo extraction, run on the three real photos in `tests/fixtures/` (lens centres against hand-measured positions, clear lens openings, translucency kept, shadows/stand/printing removed, bridge rebuilt and flagged, semi-rimless lower edge kept faint) plus synthetic cases (gradient background with a table edge, printing in the lens, open-bottom lenses, a frame cut off by the edge, a blank photo).
- During development the whole site was also driven in headless Chromium (real MediaPipe and three.js, a fake camera, Firebase mocked out) at 360, 390, 820, 1280 and 1600 px wide and in phone landscape: the customer journeys (browse → frame page → live try-on → switch frames → back; photo upload, replace, switch; camera blocked, unsupported or damaged files, a frame with no try-on asset, an unknown frame address), staff mode (lock, wrong/right password, edit, delete with confirmation), keyboard-only use, reduced motion, an axe-core WCAG 2.2 AA scan of every main view (also in Hindi and Marathi, and the shortlist page), switching language on every page, staff screens included (nothing left in English, frame names and search in Devanagari, open panels redrawn on a switch, the choice remembered), shortlist and compare (add/remove from every place, limit, clear, tab-only storage, cleared on idle), the PD panel (single and split numbers, range checks, frame drawn smaller/larger as the PD changes in 3D, photo and flat views, `?pd=` links), and the Add Frames → review → preview → save flow. Those browser scripts aren't part of the repo.
- Real-camera behaviour should be checked by hand on the deployed https site, on the kiosk and on a phone: camera permission prompt, tracking while turning the head, and how each catalogue frame looks.

## Notes

- This was written and syntax-checked but **not tested against a live Firebase project** — I don't have one to test against. The Firebase API calls follow the current documented v9+ modular SDK, so they should work, but budget some time for first-run debugging, and check the browser console (F12) if something doesn't behave — the error messages Firebase throws are usually specific enough to point at the fix (a rule typo, an unauthorized domain, etc.).
- Camera access requires HTTPS (or `localhost`) — GitHub Pages serves over HTTPS automatically, so this isn't something you need to configure.
- To run locally: `python3 -m http.server 8000` in this folder, then open `http://localhost:8000` (opening `index.html` as a file won't work, because the app uses JavaScript modules).
