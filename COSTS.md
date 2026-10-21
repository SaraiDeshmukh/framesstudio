# What it costs to run

Checked on 18 Oct 2026 against Firebase's own pages (quotas: firebase.google.com/docs/firestore/quotas; Storage on Spark: firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024; Auth limits: firebase.google.com/docs/auth/limits). Prices and limits change, so check again before relying on this.

## Short version

The site runs on the free **Spark** plan. Nothing here costs money on Spark: if a daily limit is reached, Firestore refuses further requests until the quota resets (midnight Pacific time, about 13:30 IST), and the site shows what the browser saved earlier (or a "couldn't load" message with a retry). The demo frames always work, because they ship with the site.

Move to **Blaze** when one of these happens, not before:

- the database passes about **0.8 GiB** (roughly 1,200–2,500 frames, see below), or
- the Firestore usage page shows reads or downloaded data near the daily/monthly limits on ordinary days.

## The free plan's limits

| What | Free on Spark |
|---|---|
| Firestore stored data | 1 GiB (one free database per project) |
| Firestore document reads | 50,000 a day |
| Firestore document writes | 20,000 a day |
| Firestore document deletes | 20,000 a day |
| Data downloaded from Firestore | 10 GiB a month |
| Cloud Storage | **Not available at all** on Spark (requests fail with 402/403). This is why frame pictures are kept in Firestore. |
| Authentication | Email/password and anonymous sign-in work. Limits: 1,000 verification emails and 150 password-reset emails a day; 100 new accounts per hour per IP address. |
| Hosting | GitHub Pages, at no cost |

## Reads per visit, before and after

Measured in the browser tests (`tests/e2e/`), which count reads the way Firestore bills them: one per document returned, at least one per query. "Before" is the `multi-retailer-platform` branch as it was on 13 Oct, run on the same test data.

| A customer… | Before | Now |
|---|---|---|
| opens the home page | 2 settings + 1 per approved shop (25 shops: 27) | 2 settings + 6 shops = **8**; again within 15 minutes: **0** |
| opens a shop with 300 frames (laptop screen) | **304** | **16** (index 1, shop 1, settings 2, the ~12 cards on screen) |
| scans a shop's QR code on a phone (40-frame shop) | (every frame of the shop) | **10**; scanning again on the same phone: **0–2** |
| …the same on a phone | 304 | **10** |
| scrolls through the first 24 cards | 0 more | up to 12 more (each card's frame is read when it comes into view) |
| presses "Show 24 more frames" | 0 (already all read) | up to 24 |
| searches, filters (including Hindi/Marathi words) or sorts | 0 | 0 for the search itself; only cards not shown before |
| opens a frame's page | 0 | 0 (already read for its card) + 1 for the full-size picture |
| tries a frame on | 0 Firestore reads (pictures came from Storage) | 1 the first time (its cut-out; temple photo +1); then 0 |
| home → shop A → shop B → back to shop A | 636 | 30 |
| comes back on the same device (a kiosk all day) | 304 again | **0** within 10 minutes; later 1 (the index) + only frames that changed |

A shop opening its dashboard: before, every product each time (300 frames = 300 reads); now all of them the first time on a device, then about **2** (products changed since, plus one count).

### What that means for the 50,000 daily reads

A new visitor who opens the home page, one shop, scrolls its first 24 frames, and opens and tries on 2 frames uses about **35 reads** (before: about 330). That's room for roughly **1,400 such visits a day** (before: about 150). Repeat visits on the same phone, laptop or kiosk use almost nothing.

## The other limits to watch

**Downloaded data (10 GiB a month).** Pictures now come from Firestore, so they count here. A new visitor's catalogue page downloads about 0.5 MB (24 products with their small inline thumbnails, plus the index), and each frame tried on adds its cut-out (about 100–250 KB). So about **1 MB per new visitor**, which is roughly **10,000 new visitors a month** before this limit; repeat visitors download almost nothing because the browser keeps what it has seen. For a busy public site this is likely the first limit you meet.

**Stored data (1 GiB).** Per frame, roughly:

| Part | Size in Firestore |
|---|---|
| Cut-out (the try-on picture) | 100–300 KB |
| Original photo (kept privately so the shop can re-process the frame; scaled down on the free plan) | up to 600 KB |
| Product details, thumbnail and fitting data | about 20 KB |
| Catalogue index entry | under 0.5 KB |

So about 0.4–0.9 MB per frame: **roughly 1,200–2,500 frames fit in the free 1 GiB**. 25 shops × 300 frames (7,500) does not fit; that is the point to move to Blaze and Cloud Storage. The admin dashboard's Overview shows the total size of stored frame pictures.

**Writes.** Saving a product is 2 writes (the product and the shop's index); adding a photographed frame is about 4–5. Far below 20,000 a day.

## What still needs Blaze, and why

| Feature | Works on Spark? |
|---|---|
| Customers: demo, shops, catalogue, search, filters, sorting, frame pages, live and photo try-on, shortlist, reports | Yes |
| Shops: sign-up, approval, adding frames from photos (automatic cut-out), prices and GST, CSV import, copying old frames | Yes, pictures stored in Firestore |
| Admin dashboard | Yes |
| Pictures in Cloud Storage (served from Google's CDN, cached by browsers for a year, 5 GB free) | **No**: Spark has no Storage access. Needs Blaze. |
| More than ~1 GiB of frames and photos | **No**: the free database is 1 GiB. Needs Blaze (with pictures moved to Storage, or Firestore storage billed). |
| More than 50,000 reads a day or 10 GiB downloaded a month | Stops for the day/month on Spark; continues (billed) on Blaze |
| Backups, point-in-time recovery, TTL deletes | Not part of the free usage |

## After moving to Blaze

Blaze keeps the same free allowances; you pay only above them. At Firestore's listed rates (about $0.03 per 100,000 reads, $0.09 per 100,000 writes, $0.01 per 100,000 deletes, plus stored data and downloads; check the rate for your database's location) even several times the free reads cost a few rupees a day. With pictures moved to Cloud Storage (`imageStore: 'storage'`, see `SETUP.md`), the 5 GB free Storage tier only applies to buckets in us-central1, us-east1 or us-west1; a bucket in Mumbai (asia-south1) has no free tier.

- **Budget alert.** In Google Cloud Billing, set a budget (say ₹500 a month) with alerts at 50%, 90% and 100%. It only emails you; it does **not** stop spending.
- **Watch the Firestore usage page** in the Firebase console for the first weeks.
- **Product limit per shop**: Admin → Settings.
