var cb = null, user = { uid: 'kiosk', email: 'kiosk@optical.test' };
// test password for the mocked account; anything else is "wrong"
var PASSWORD = 'kiosk-pass';
export function getAuth() { return { get currentUser() { return window.__signedOut ? null : user; } }; }
export function onAuthStateChanged(auth, f) { cb = f; setTimeout(function () { f(window.__signedOut ? null : user); }, 0); return function () {}; }
export function signInWithEmailAndPassword(auth, email, pass) {
  if (pass !== PASSWORD) return Promise.reject(Object.assign(new Error('bad'), { code: 'auth/invalid-credential' }));
  window.__signedOut = false; setTimeout(function () { cb(user); }, 0); return Promise.resolve({ user: user });
}
export function createUserWithEmailAndPassword() { window.__signedOut = false; setTimeout(function () { cb(user); }, 0); return Promise.resolve({ user: user }); }
export function signOut() { window.__signedOut = true; setTimeout(function () { cb(null); }, 0); return Promise.resolve(); }
export var EmailAuthProvider = { credential: function (email, password) { return { email: email, password: password }; } };
export function reauthenticateWithCredential(u, cred) {
  window.__reauths = (window.__reauths || 0) + 1;
  return new Promise(function (res, rej) {
    setTimeout(function () {
      if (cred && cred.password === PASSWORD) res({ user: user });
      else rej(Object.assign(new Error('wrong'), { code: 'auth/wrong-password' }));
    }, 50);
  });
}
