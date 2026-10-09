# Frame Try-On Studio

A small web app for photographing/uploading eyeglass frames, tagging them, and trying them on a photo. Runs entirely in the browser except for Firebase, which handles accounts and data.

Images are stored directly inside Firestore documents rather than in Firebase Storage, which means this app runs entirely on Firebase's free **Spark** plan — no billing account, no credit card, ever.

## Files

- `index.html` — page structure
- `styles.css` — all styling
- `firebase-config.js` — **the one file you edit** with your own Firebase project's keys
- `app.js` — all the application logic
- `tracking.js` — live try-on maths (smoothing, head pose, frame placement); no DOM, unit-tested
- `tests/tracking.test.mjs` — unit tests for `tracking.js` (`node --test tests/tracking.test.mjs`, no dependencies)
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
2. Click **Add file → Upload files**, drag in all five files from this project (`index.html`, `styles.css`, `app.js`, `firebase-config.js` — with your real values already pasted in — and `README.md`), then **Commit changes**.
3. Go to the repo's **Settings → Pages**. Under **Build and deployment → Source**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, **Save**.
4. Wait a minute, refresh that same settings page — it'll show a live URL like `https://yourusername.github.io/frame-studio/`. That's your site.

If you'd rather use git from the command line, it's the standard `git init`, `git add .`, `git commit`, `git remote add origin <url>`, `git push` — then the same Settings → Pages step.

## 4. Authorize the domain in Firebase

Firebase blocks sign-in from domains it doesn't recognize. In the console: **Authentication → Settings → Authorized domains → Add domain**, and add your `yourusername.github.io` domain. `localhost` is already allowed by default, which is useful if you want to test by opening `index.html` through a local server before deploying.

## Data model

Two collections per user, split so browsing the catalog stays fast without pulling every full-size image at once:

```
users/{uid}/frames/{frameId}       — light doc, loaded upfront for Browse: thumbData, tags
users/{uid}/framesFull/{frameId}   — heavy doc, loaded only when a frame is selected: imageData, p1, p2
users/{uid}/profile/face           — your saved photo: imageData, p1, p2
```

`thumbData` and `imageData` are base64 PNG/JPEG strings, not URLs — the whole point of this setup is that no separate file storage is involved. Each is capped and, if a photo would still come out too large, automatically shrunk further until it comfortably fits inside Firestore's 1MB-per-document limit.

## Live try-on (real-time face tracking)

Try On tab → **Start live try-on** opens the front camera, tracks the face in real time and keeps the selected frame on the customer's eyes. Pick or search frames in the strip under the video to swap without restarting the camera. Controls: Stop camera, Switch camera (when more than one is available), Remove/Show frame, and a fit slider.

How it works: MediaPipe Face Landmarker (the same model already used for photos, run in video mode) gives the two pupil positions each frame. A One Euro filter smooths them (steady when still, quick when moving). The frame's cut-out photo is placed so its two lens-centre calibration points land on the pupils, rotated with head roll and scaled to the pupil spacing. For head turns (yaw, estimated from where the nose sits between the cheeks) the frame's height is compensated, since only its width shrinks when the head turns. It is an affine 2D approximation, not 3D.

Limits: a flat photo cannot show temples or depth, so beyond roughly 30-40 degrees of head turn, or with strong up/down tilt, it will look flat. Frames also don't hide behind the nose or ears. Fixing that properly needs a 3D model per frame. Quality depends on how cleanly each frame's background was removed and how precisely the lens centres were tapped when it was added.

Privacy: video is processed in the browser tab only. Nothing is recorded, captured or uploaded. The camera stops when you press Stop, leave the Try On tab, hide the page or sign out. The model (about 4 MB) loads only when Start is pressed, from jsdelivr and storage.googleapis.com.

Testing: `node --test tests/tracking.test.mjs` runs the maths tests. Real-camera behaviour (tracking accuracy, lighting, devices) can only be checked by hand on the deployed https site.

## Notes

- This was written and syntax-checked but **not tested against a live Firebase project** — I don't have one to test against. The Firebase API calls follow the current documented v9+ modular SDK, so they should work, but budget some time for first-run debugging, and check the browser console (F12) if something doesn't behave — the error messages Firebase throws are usually specific enough to point at the fix (a rule typo, an unauthorized domain, etc.).
- Camera access requires HTTPS (or `localhost`) — GitHub Pages serves over HTTPS automatically, so this isn't something you need to configure.
