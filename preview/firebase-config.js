// Paste your own Firebase project's config here.
// Find it in: Firebase Console -> Project settings (gear icon) -> General tab
// -> scroll to "Your apps" -> click the Web app (</>) -> "SDK setup and configuration"
//
// Until you replace these placeholder values, the app will show a setup message
// instead of trying (and failing) to connect to a fake project.

export const firebaseConfig = {
  apiKey: "AIzaSyAgni5DCp7gzxKOAWuZI55oXHI9kAFg7GQ",
  authDomain: "frame-studio-ad5ed.firebaseapp.com",
  projectId: "frame-studio-ad5ed",
  storageBucket: "frame-studio-ad5ed.firebasestorage.app",
  messagingSenderId: "439341097240",
  appId: "1:439341097240:web:d3c5265e45d0ce8b247e6d",
  measurementId: "G-0VEBTFPSVY"
};

// Where shops' frame pictures are kept:
//   'firestore'  inside the Firestore database. Works on the free Spark plan
//                (Spark has no access to Cloud Storage at all).
//   'storage'    Cloud Storage. Needs the Blaze plan, Storage turned on and
//                storage.rules deployed (see SETUP.md, "Moving to Blaze").
// Frames saved either way keep working after a switch; only new pictures go
// to the new place.
export const imageStore = 'firestore';
