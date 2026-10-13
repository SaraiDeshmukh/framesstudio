# What it costs to run

These are estimates for about 25 shops with about 300 frames each (roughly 7,500 frames). Prices were checked on 13 Oct 2026 at firebase.google.com/pricing and cloud.google.com/firestore/pricing. Prices change, so check them again before relying on this. Prices are in US dollars, and ₹ figures are approximate.

## You need the Blaze (pay as you go) plan

Cloud Storage, where shops' frame photos and try-on images are kept, isn't available on the free Spark plan. Blaze still includes a free allowance every month. You pay only for usage above it.

## Free allowance on Blaze

| Service | Free each month (or day) |
|---|---|
| Firestore (listings, shops, settings) | 1 GiB stored; 50,000 reads, 20,000 writes and 20,000 deletes **per day**; 10 GiB outbound per month |
| Storage (bucket `…firebasestorage.app` in `us-central1`, `us-east1` or `us-west1`) | 5 GB stored, 100 GB downloaded, 5,000 uploads, 50,000 downloads **per month** |
| Authentication (email/password, anonymous) | Covered for this use |
| Hosting | GitHub Pages hosts the site, at no cost to you |

A Storage bucket in Mumbai (`asia-south1`) gets **no** free allowance.

## Estimate at 25 shops × 300 frames

| What | Rough amount | Likely cost per month |
|---|---|---|
| Stored photos (original photo up to a few MB, plus cut-out, thumbnail and fitting data per frame) | 5–15 GB | $0–0.20 (≈ ₹0–20) |
| One-time upload of all frames (about 4 files each) | ~30,000 uploads, once | ≈ $0.15 once |
| Customers viewing images (images are cached by browsers for a year) | Well under 100 GB | $0 |
| Image download count above 50,000 a month | e.g. 150,000 | ≈ $0.05 |
| Firestore reads (each listing shown = 1 read) | e.g. 150,000 a day | ≈ $1–2 (≈ ₹100–170) |
| Firestore writes (shops editing, imports) | Far below 20,000 a day | $0 |

**Total: from free to roughly ₹200–300 a month.** The cost depends mostly on how many customers browse, not on how many frames there are. A large import, or a bug or bot that reloads catalogues in a loop, could cost more. That's why the budget alert matters.

## Keeping it under control

- **Budget alert.** In Google Cloud Billing, set a budget of, say, ₹500 a month with alerts at 50%, 90% and 100%. It sends you email. It does **not** stop or cap spending.
- **Usage pages.** For usage, see Firebase console → Usage and billing. The admin dashboard's Overview and Shops tabs show product counts and each shop's stored image size.
- **Product limit per shop.** You can set a maximum in Admin → Settings.
- **Watch the daily read count** in the Firestore usage tab during the first weeks.
