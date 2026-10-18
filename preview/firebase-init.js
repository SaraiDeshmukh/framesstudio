// One Firebase app for the whole site: customer pages, the shop dashboard and
// the admin dashboard all import from here.
//
// Customers never sign in. Shops and the admin sign in with email and password;
// by default the sign-in lasts only for this browser tab (a shared shop screen
// forgets it when the tab closes), unless "Keep me signed in on this device"
// is ticked.
//
// Local testing against the Firebase emulators: open the site on localhost with
// ?emulators=1 once (remembered for the tab). Production never connects to them.

import { firebaseConfig, imageStore } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getAuth, connectAuthEmulator, setPersistence, browserLocalPersistence, browserSessionPersistence
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { getStorage, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js';

export var CONFIGURED = !!(firebaseConfig.apiKey && firebaseConfig.apiKey.indexOf('YOUR_') !== 0);

function wantsEmulators() {
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (!local) return false;
  try {
    if (/[?&]emulators=1\b/.test(location.search)) sessionStorage.setItem('fts.emulators', '1');
    if (/[?&]emulators=0\b/.test(location.search)) sessionStorage.removeItem('fts.emulators');
    return sessionStorage.getItem('fts.emulators') === '1';
  } catch (e) { return false; }
}

export var USING_EMULATORS = CONFIGURED && wantsEmulators();
export var IMAGE_STORE = imageStore === 'storage' ? 'storage' : 'firestore';

export var app = CONFIGURED ? initializeApp(firebaseConfig) : null;
export var auth = app ? getAuth(app) : null;
export var db = app ? getFirestore(app) : null;
export var storage = app ? getStorage(app) : null;

if (USING_EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}

var KEEP_KEY = 'fts.keepSignedIn';
export function keepSignedIn() {
  try { return localStorage.getItem(KEEP_KEY) === '1'; } catch (e) { return false; }
}
// Called just before signing in: where the sign-in is kept.
export function setKeepSignedIn(keep) {
  try { if (keep) localStorage.setItem(KEEP_KEY, '1'); else localStorage.removeItem(KEEP_KEY); } catch (e) { /* storage blocked: tab only */ }
  if (!auth) return Promise.resolve();
  return setPersistence(auth, keep ? browserLocalPersistence : browserSessionPersistence);
}
if (auth && !keepSignedIn()) setPersistence(auth, browserSessionPersistence).catch(function () {});
