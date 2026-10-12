// The current version of each legal document on this site. When a document's
// text changes in a way people should agree to again, bump its version here
// and in the page itself, deploy, then use Admin → Legal → "Require these
// versions": partner shops are then asked to accept the new version before
// they can change their catalogue (firestore.rules checks it).
export var LEGAL_DOCS = {
  customerTerms: { version: '1.0', date: '2026-10-12', url: 'legal/customer-terms.html' },
  retailerTerms: { version: '1.0', date: '2026-10-12', url: 'legal/retailer-terms.html' },
  privacy: { version: '1.0', date: '2026-10-12', url: 'legal/privacy.html' }
};
