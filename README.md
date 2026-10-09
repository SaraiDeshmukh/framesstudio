# Frame Try-On Studio

A small web app for photographing/uploading eyeglass frames, tagging them, and trying them on a photo. Runs entirely in the browser except for Firebase, which handles accounts and data.

Images are stored directly inside Firestore documents rather than in Firebase Storage, which means this app runs entirely on Firebase's free **Spark** plan — no billing account, no credit card, ever.

## Files

- `index.html` — page structure
- `styles.css` — all styling
- `firebase-config.js` — **the one file you edit** with your own Firebase project's keys
- `app.js` — all the application logic
- `headpose.js` — 3D head pose from the face landmarks (fits a 3D face model, smoothing); no DOM, unit-tested
- `glasses-model.js` — turns a frame's cut-out photo into a 3D model description (hinges, lens openings, rim material, real size); no DOM, unit-tested
- `ar-renderer.js` — draws the 3D frame on the face with WebGL (three.js)
- `face-geometry.js` — MediaPipe's canonical 3D face model (data, Apache 2.0)
- `tracking.js` — the original flat (2D) overlay maths, still used as the fallback on devices without WebGL; unit-tested
- `tests/*.test.mjs` — unit tests (`node --test tests/*.test.mjs`, Node 18+, no dependencies)
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

Two collections per user, split so browsing the catalog stays fast without pulling every full-size image at once:

```
users/{uid}/frames/{frameId}       — light doc, loaded upfront for Browse: thumbData, tags,
                                     size {eye, bridge, temple} (mm, optional), hasSide
users/{uid}/framesFull/{frameId}   — heavy doc, loaded only when a frame is selected:
                                     imageData, p1, p2 (lens centres), imgW, imgH
users/{uid}/framesSide/{frameId}   — optional temple (side) photo for the 3D try-on:
                                     imageData, hinge, tip, imgW, imgH
users/{uid}/stats/customerPhotos   — a plain counter, no images
```

`imgW`/`imgH` record the pixel size the tapped points refer to, so they stay correct when a photo is shrunk to fit. Frames saved before this existed still work (the app detects the old shrink and rescales their points). No Firestore rule change is needed: everything is under `users/{uid}/`.

`thumbData` and `imageData` are base64 PNG/JPEG strings, not URLs — the whole point of this setup is that no separate file storage is involved. Each is capped and, if a photo would still come out too large, automatically shrunk further until it comfortably fits inside Firestore's 1MB-per-document limit.

## 3D try-on (live camera and photos)

Try On tab → **Start live try-on** opens the front camera and shows the selected frame on the customer's face in 3D, following head turns, nods and tilts in real time. Pick or search frames in the strip under the video to swap without restarting the camera. Controls: Stop camera, Switch camera (when there is more than one), Remove/Show frame, View in catalog, a fit slider and an optional **Customer PD** field. An uploaded or captured photo gets the same 3D treatment automatically (with Remove/Show frame and View in catalog); if no face is found, staff tap the two pupils and the flat overlay is used.

### How it works

1. **Tracking** — MediaPipe Face Landmarker (Google, Apache 2.0, runs on the device) finds 478 face points in every camera frame.
2. **Head pose** (`headpose.js`) — MediaPipe's canonical 3D face model is fitted to the rigid parts of the face (forehead, nose, eye corners, cheekbones — not the mouth or jaw, so expressions don't move the glasses) through a perspective camera model. That gives the real yaw, pitch and roll, and the head's position and size. A One Euro filter removes jitter without adding lag. The tracked camera frame and the glasses are drawn together, so they can't drift apart even on a slow device.
3. **Frame model** (`glasses-model.js`) — built from the frame's existing cut-out photo and lens points: the frame's axis, the hinges (where the temples start), the clear lens openings, the rim thickness and a strip of the real rim material, and metal vs acetate (from the colour tag, else rim thickness).
4. **Rendering** (`ar-renderer.js`, three.js, MIT) — the photo becomes a gently wrapped, tilted front with real depth (stacked layers whose sides show at an angle), glass lenses with reflections and a faint tint, temples running back to the ears in the frame's own material, and a soft contact shadow. The customer's face and head are drawn invisibly so the nose hides the far rim and the head hides the far temple. Frame colours stay as photographed; overall brightness follows the room (measured from the face), so a frame doesn't glow in a dim shop.
5. **Fallback** — no WebGL, or a cut-out that can't be analysed: the flat 2D overlay from `tracking.js` is used for that frame. Nothing breaks.

### What each frame needs (and what makes it better)

- **Required, already in the catalog:** the front cut-out and its two lens points. Every existing frame works in 3D with no extra work.
- **Recommended: frame size** (eye, bridge, temple — printed inside the temple, e.g. `52□18 140`). Enter it when adding a frame, or later via **Edit**. With eye + bridge, and the customer's **PD** entered on the Try On tab, the frame is shown at its true size relative to the face, so a 49 mm and a 55 mm frame look different, as they should. Without a size, the lens centres are placed on the pupils (the previous behaviour). Sizes are never guessed.
- **Optional: temple photo.** After adding a frame (or from **Edit → Add temple photo**), photograph one temple from the side; tap the hinge, then the far tip. The 3D try-on then uses the real temple (shape, logo, colour) instead of one generated from the rim material.
- **Photo quality matters most:** a sharp, front-on photo with a clean cut-out gives the best result. The 3D preview on the Add Frames page shows the generated model before saving — slide it to turn it.

### Limits (honest version)

- The frame front is a photo given depth, not a scanned 3D model. At large head turns (beyond ~45–50°) it shows that the front is thin, and the inside faces of the rims are approximations.
- Temples without a temple photo are generated: right position and material, not the exact shape. With a temple photo, its logo reads correctly on one side only (one photo serves both temples).
- Hair over the ears does not hide the temples; they fade out where they reach the ear instead.
- Head shape is a generic adult model scaled to the face, and the camera's field of view is assumed (~72° diagonal); unusual head shapes or very wide-angle cameras reduce accuracy at the sides.
- Real-size display depends on the entered frame size and PD. Without the PD, a 63 mm adult average is used.
- Tracking needs the face reasonably lit and in view; very strong backlight or turning past profile loses it.

### Privacy

Camera frames and photos are processed in the browser tab only. Nothing is recorded, captured, uploaded or stored; an uploaded photo is held in memory for the session and discarded on retake, sign-out or page close. The camera stops on Stop, when leaving the Try On tab, when the page is hidden or closed, and on sign-out. The only network requests the try-on adds are the libraries and model, loaded the first time it's used: MediaPipe (`cdn.jsdelivr.net`, pinned to 0.10.35) and its face model (`storage.googleapis.com`, ~4 MB), and three.js (`cdn.jsdelivr.net`, pinned to 0.186.1). No API keys or paid services.

### Testing

- `node --test tests/*.test.mjs` — maths tests (pose recovery through real perspective up to 45° turns, smoothing, frame analysis, sizes, temple photos).
- Real-camera behaviour should be checked by hand on the deployed https site, on the kiosk and on a phone: camera permission prompt, tracking while turning the head, and how each catalogue frame looks.

## Notes

- This was written and syntax-checked but **not tested against a live Firebase project** — I don't have one to test against. The Firebase API calls follow the current documented v9+ modular SDK, so they should work, but budget some time for first-run debugging, and check the browser console (F12) if something doesn't behave — the error messages Firebase throws are usually specific enough to point at the fix (a rule typo, an unauthorized domain, etc.).
- Camera access requires HTTPS (or `localhost`) — GitHub Pages serves over HTTPS automatically, so this isn't something you need to configure.
- To run locally: `python3 -m http.server 8000` in this folder, then open `http://localhost:8000` (opening `index.html` as a file won't work, because the app uses JavaScript modules).
