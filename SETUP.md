# Setting up (free Spark plan)

These steps need your Google account, so only you can do them. Nothing needs installing on your computer, and **no billing account is needed**.

- Live site: **https://saraideshmukh.github.io/framesstudio/** (the multi-shop version has been live since 21 Oct 2026). Until parts A–C are done, the demo frames work but shops, sign-in and the dashboards can't load.
- Firebase project the site is connected to: **frame-studio-ad5ed** (set in `firebase-config.js` and `.firebaserc`).
- Never put a service-account key, password or other secret in the repository. The values in `firebase-config.js` are public identifiers, not secrets; the security rules are what protect the data.

---

## A. Check the connection, then create the Firestore database (Firebase console, about 10 minutes)

Open https://console.firebase.google.com/project/frame-studio-ad5ed and check the bottom of the left sidebar says **Spark** (free).

**Check the site points at this project.** Click the gear → **Project settings → General → Your apps**. There should be a web app (`</>`). Under **SDK setup and configuration → Config**, the `apiKey`, `projectId` and `appId` should match `firebase-config.js` (`AIzaSyAgni5…`, `frame-studio-ad5ed`, `1:439341097240:web:d3c5265e…`). If there's no web app, or the values differ, add one with **Add app → Web**, and send me the new config (it's safe to share) so I can update `firebase-config.js`.

**The database:** the project already has a **(default)** Firestore database from the earlier single-shop site (with `users/<uid>/frames` and `framesFull` inside). Keep it: don't create a second one or delete anything. Only the (default) database gets the free quota, and the old frames can be copied into your shop later (**Shop dashboard → Import → Copy old frames**). Its location is shown under **Firestore Database → (default) → database details**; note it for the privacy policy. Then go straight to step 7.

If a project ever has no database yet:

1. **Build → Firestore Database → Create database.**
2. **Edition:** choose **Standard**.
3. **Database ID:** leave it as **(default)**. Only one database per project gets the free quota, and the site uses the default one.
4. **Location:** choose **asia-south1 (Mumbai)**. It's the closest to customers in India (asia-south2, Delhi, is similar). The free quota doesn't depend on the location. **The location can't be changed later.** It doesn't tie you to anything for Cloud Storage: if you add Storage on Blaze later, its bucket location is chosen separately.
5. **Rules:** choose **Start in production mode** (everything locked). The real rules are deployed in part B.
6. Click **Create** and wait until the empty database appears.

**Sign-in:**

7. **Build → Authentication → Get started** (if shown) **→ Sign-in method:** turn on **Email/Password** (only the first switch, not "Email link"), and turn on **Anonymous** (used only so one device can send at most one "Report this listing" a minute; it collects nothing about the person).
8. **Authentication → Settings → Authorised domains:** check that `saraideshmukh.github.io` is listed; if not, **Add domain** and enter it.

Don't turn on Storage: it isn't available on Spark, and the site doesn't need it there.

## B. Deploy the security rules and indexes (Cloud Shell, copy and paste)

Open Cloud Shell, a free terminal in your browser: https://console.cloud.google.com/?cloudshell=true&project=frame-studio-ad5ed

Paste these lines one at a time:

```bash
git clone https://github.com/SaraiDeshmukh/framesstudio.git
cd framesstudio
npx -y firebase-tools@15.33.0 deploy --only firestore:rules,firestore:indexes --project frame-studio-ad5ed
```

- If it asks you to log in, run `npx -y firebase-tools@15.33.0 login --no-localhost`, follow the link, sign in with the same Google account, paste the code back, then run the deploy line again.
- If it asks whether to delete indexes that aren't in the file, answer **N**.
- It ends with **Deploy complete!** The indexes then take a few minutes to build (Firestore Database → **Indexes** shows "Building" then "Enabled"); until they're ready, some lists in the dashboards may show an error.
- Don't add `storage` to the deploy line on Spark: there is no Storage bucket, so that part would fail.
- Run the same three lines again whenever the rules change in the repository (`git pull` instead of `git clone` the second time).

## C. Make yourself the administrator

The rules only treat someone as the administrator if a document for them exists in `admins`, and nobody can create one from the website.

1. Open **https://saraideshmukh.github.io/framesstudio/**, click **For shops**, and **sign up** with your email and a password. Open the verification email and click the link, then go back to the site and press **I’ve confirmed it**.
2. In the Firebase console: **Authentication → Users**, find your email and copy its **User UID**. (If you used the old site, your account is already there; its UID is also the document name under `users` in Firestore.)
3. **Firestore Database → Data → Start collection**. Collection ID `admins` → **Next**. Document ID: paste your UID. Add one field: `email`, type string, value your email. **Save**.
4. Reload the site. **Account** (top right) now shows **Admin**.

## D. First run on the live site

1. **Account → Admin → Overview → Initialise platform settings** (records the terms and privacy versions and default settings; shops can't apply before this).
2. **Account → Shop dashboard**: apply for your own shop, fill in the profile, accept the terms, submit.
3. **Admin → Shops → Waiting for review → Approve** your shop.
4. **Shop dashboard → Frames → Add a frame**: fill in the details, take or upload its photo, set price and GST, tick the confirmation, publish. (Or **Import → Copy old frames** if old-site frames exist in this database.)
5. Check it as a customer, on your phone: **Shops** → your shop → a frame → **Try on**.
6. **Shop dashboard → Shop profile → QR code for customers**: scan it with your phone, then **Print poster** (part E).
7. **Admin → Overview**: the "Free plan" bar should show a tiny amount used.

If something doesn't load, see "If something goes wrong" at the end.

## E. Give each shop its QR code

Every approved shop has one, in **Shop dashboard → Shop profile → QR code for customers** (you also see it in **#/admin → Shops → Approved → Details**). Customers scan it with their phone camera: the site opens on that shop's frames, they can search, filter and try them on, and that browser tab stays on that shop (no list of other shops). No app, no sign-in, and their camera stays on their phone.

1. **Print poster** gives an A4 page: shop name, the code, "Scan to try on our frames" in English, Hindi and Marathi, three steps and the privacy line. Print it, or choose "Save as PDF" and send it to a print shop. **Download QR (PNG)** is for stickers, WhatsApp or the shop's own designs.
2. Print the code at least 3 cm wide (5 cm or more scans more easily) and scan it with an Android phone and an iPhone before putting it up.
3. The code never changes: adding, editing or removing frames needs no new print. It stops working only if the shop is suspended (customers then see "This shop isn't available").
4. The in-store screen still uses the kiosk link on the same page (`…?kiosk=1`), which behaves the same way.

Making and printing codes costs nothing. A scan is just a visit to the shop's page: about 10 database reads on a phone the first time, and almost none when the same phone scans again.

## F. Adding many frames at once (photo package)

A photo package is a `.zip` of frame photos with a `frames.json` listing each frame's name, brand, model, size and tags, and, where prepared, a try-on cut-out. Claude can prepare one from photos of a shop's display (`scripts/prep-shop-photos.mjs` makes the cut-outs with the site's own extraction).

1. Sign in. As the **admin**: **Account → Admin → Shops → Approved → Manage frames** on the shop (a banner says which shop you're managing). As the **shop**: just open the Shop dashboard.
2. Go to **Import → Add many frames from a photo package → Choose package**, pick the `.zip`, check the preview, and press **Add N frames**.
3. "Publish them straight away" is ticked by default. Frames go live without a price ("Ask the shop for the price"); add prices and GST later in **Frames → a frame → 3. Price and GST**. Untick it to add them as drafts.
4. Running the same package again only adds frames that are missing.

Frames without a try-on cut-out are listed with their photo. To give one a try-on later: open the frame → **Replace or re-process photo** → use the original photo (kept privately) or take a new one.

## G. Try-on counts

Every time a customer tries a frame on (camera or photo), it's counted for that shop: once per frame per visit, not the shop's own previews or yours. **Admin → Overview → Try-ons per shop** shows today, 7 days, 30 days and the total for each shop; **Admin → Shops → Details** shows a shop's most-tried frames and has a box for try-ons counted before this counter existed (for example from the old site's analytics), which is added to the total. Shops see their own numbers on their frames list and can sort by "most tried on". The counts need the rules from step B (deploy them again after updating).

## Where things are

| You want to… | Go to |
|---|---|
| Try the demo (no sign-in) | **Demo frames** in the top bar, or `#/demo` |
| Add or edit frames | **For shops** (sign in) → **Shop dashboard → Frames → Add a frame** (the admin: **Admin → Shops → Manage frames**) |
| Add many frames from photos | **Shop dashboard → Import → Add many frames from a photo package** (part F) |
| Approve shops, moderate listings, see reports and acceptance records | **Account → Admin** (`#/admin`), shown only to you |
| Get a shop's QR code or poster for customers | Shop dashboard → **Shop profile** → **QR code for customers** (or Admin → Shops → Details) |
| Put a shop's frames on a kiosk | Shop dashboard → **Shop profile** → kiosk link (`#/shop/<id>?kiosk=1`) |
| See reads, writes and stored data | Firebase console → **Firestore Database → Usage** |

## How you'll know it's time to upgrade

Check these once a week (Monday morning is enough):

1. **Admin → Overview → "Free plan (Spark): when to upgrade".** A bar shows how much of the free 1 GB the frames and photos use, and roughly how many more frames fit. Green: fine. Amber (60%): plan the move in the next few weeks. Red (80%): move now, before shops can't add frames.
2. **Firebase console → Firestore Database → Usage** (the admin page links to it). Look at the busiest day of the week:
   - **Reads** over about **35,000 a day** (free limit 50,000) on ordinary days → upgrade. Roughly: each customer who scans a QR code and browses uses 10–35 reads.
   - **Downloaded data** over about **7 GB in a month** (free limit 10 GB) → upgrade.
   - Writes are very unlikely to matter (saving a frame is 2–5 of the 20,000 a day).
3. **Warning signs from people:** shops or customers saying frames "couldn't load" in the afternoon or evening, or the admin page saying a free daily limit is used up. On Spark nothing is charged: Firestore just refuses until the limit resets (reads daily at about 13:30 IST, downloads monthly). Once that happens on ordinary days, upgrade.

As a rough guide, the free plan covers about **1,000–1,400 customer visits a day**, about **10,000 new phones a month**, and about **1,200–2,500 frames** with their photos (details in `COSTS.md`). Ten busy shops with a QR poster each are likely fine; 25 shops with 300 frames each won't fit the 1 GB, so that's when to move.

## Moving to Blaze later

Do this when the checks above say it's time.

1. Firebase console → **Upgrade** (bottom of the sidebar) → link a billing account.
2. Google Cloud Billing → **Budgets & alerts** → a budget (e.g. ₹500/month) with alerts at 50/90/100%. It only emails you; it does not stop spending.
3. **Build → Storage → Get started**, location **us-central1** (the free Storage tier is only in us-central1, us-east1 and us-west1).
4. In Cloud Shell (in the `framesstudio` folder, after `git pull`):
   ```bash
   npx -y firebase-tools@15.33.0 deploy --only storage --project frame-studio-ad5ed
   gcloud storage buckets update gs://frame-studio-ad5ed.firebasestorage.app --cors-file=cors.json
   ```
   If asked whether Storage rules may read Firestore, answer **Y**.
5. In `firebase-config.js`, change `imageStore = 'firestore'` to `imageStore = 'storage'` and commit. New pictures then go to Storage; frames saved before keep loading from Firestore. Moving the existing pictures over is a separate step, only with your go-ahead.

## Before inviting other shops

- Have a lawyer review `legal/*.html` and fill in the highlighted blanks (operator name, grievance officer, city, and the Firestore location you chose in part A). `LEGAL-REVIEW.md` lists what to check.
- Have a native speaker read the Hindi and Marathi text.
- Try the live camera on a real phone and on the kiosk.

## If something goes wrong

| What you see | Usually means | Fix |
|---|---|---|
| Shops page says shops couldn't load; sign-up works but nothing else | Rules not deployed yet, or the database isn't created | Parts A and B |
| "Missing or insufficient permissions" in a dashboard | Rules not deployed, or you're not in `admins` | Part B; part C step 3 (document ID must be exactly your UID) |
| A list shows an error that mentions an index | Indexes still building | Wait 5–10 minutes (Firestore → Indexes) |
| Sign-up says the operation isn't allowed | Email/Password sign-in is off | Part A step 7 |
| Sign-in fails with "unauthorised domain" | `saraideshmukh.github.io` missing | Part A step 8 |
| "Report this listing" fails | Anonymous sign-in is off | Part A step 7 |
| Frames "couldn't load" in the afternoon/evening on a busy day | A free daily limit was reached | Resets about 13:30 IST; see "How you'll know it's time to upgrade" |

