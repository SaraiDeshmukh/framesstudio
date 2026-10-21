# Setting up (free Spark plan)

These steps need your Google account, so only you can do them. Nothing needs installing on your computer, and **no billing account is needed**.

- Firebase project used by the site: **frame-studio-ad5ed** (from `firebase-config.js` and `.firebaserc`).
- Live site: **https://saraideshmukh.github.io/framesstudio/** (stays as it is until you merge the pull request in part D).
- Never put a service-account key, password or other secret in the repository. The values in `firebase-config.js` are public identifiers, not secrets; the security rules are what protect the data.

---

## A. Create the Firestore database (Firebase console, about 5 minutes)

Open https://console.firebase.google.com/project/frame-studio-ad5ed and check the bottom of the left sidebar says **Spark**.

1. **Build → Firestore Database → Create database.**
2. **Edition:** choose **Standard**.
3. **Database ID:** leave it as **(default)**. Only one database per project gets the free quota, and the site uses the default one.
4. **Location:** choose **asia-south1 (Mumbai)**. It's the closest to customers in India (asia-south2, Delhi, is similar). The free quota doesn't depend on the location. **The location can't be changed later.** It doesn't tie you to anything for Cloud Storage: if you add Storage on Blaze later, its bucket location is chosen separately (us-central1 for the free Storage tier).
5. **Rules:** choose **Start in production mode** (everything locked). The real rules are deployed in part B.
6. Click **Create** and wait until the empty database appears.

Then, still in the console:

7. **Build → Authentication → Sign-in method:** make sure **Email/Password** is on, and turn on **Anonymous** (used only so one device can send at most one "Report this listing" a minute; it collects nothing about the person).
8. **Authentication → Settings → Authorised domains:** check that `saraideshmukh.github.io` is listed.

Don't turn on Storage: it isn't available on Spark, and the site doesn't need it there.

## B. Deploy the security rules and indexes (Cloud Shell, copy and paste)

Open Cloud Shell, a free terminal in your browser: https://console.cloud.google.com/?cloudshell=true&project=frame-studio-ad5ed

Paste these lines one at a time:

```bash
git clone -b multi-retailer-platform https://github.com/SaraiDeshmukh/framesstudio.git
cd framesstudio
npx -y firebase-tools@15.33.0 deploy --only firestore:rules,firestore:indexes --project frame-studio-ad5ed
```

- If it asks you to log in, run `npx -y firebase-tools@15.33.0 login --no-localhost`, follow the link, then run the deploy line again.
- It ends with **Deploy complete!** The indexes then take a few minutes to build; until they're ready, some lists in the dashboards may show an error.
- Don't add `storage` to the deploy line on Spark: there is no Storage bucket, so that part would fail.

## C. Make yourself the administrator

The rules only treat someone as the administrator if a document for them exists in `admins`, and nobody can create one from the website.

1. Open the preview, **https://saraideshmukh.github.io/framesstudio/preview/**, click **For shops** and sign up (or sign in) with your email; verify the email if asked.
2. In the console: **Authentication → Users**, copy your **User UID**.
3. **Firestore Database → Data → Start collection**. Collection ID `admins`, document ID = your UID, one field `email` (string) = your email. **Save**.

## D. Try the preview, then go live

Merge the pull request **Preview of the free-plan version at /preview/** on GitHub; a minute or two later the new version is at **https://saraideshmukh.github.io/framesstudio/preview/**. It uses the same Firebase project, so once A–C are done everything there is real. (The live site at the root doesn't change.)

1. On the preview, go to **#/admin → Overview → Initialise platform settings** (records the terms and privacy versions and default settings).
2. **Account → Shop dashboard**: apply for your own shop, fill in the profile, accept the terms, submit.
3. **#/admin → Shops → Approve** your shop.
4. **Shop dashboard → Frames → Add a frame**: add one, take or upload its photo, set price and GST, publish. (Or **Import → Copy old frames** if the old site's frames are in this database.)
5. Check it as a customer: **Shops** → your shop → a frame → try it on, on a phone and on the kiosk.
6. **Shop dashboard → Shop profile → QR code for customers → Open link** on your phone (or scan the *test* address shown under it). The printed code points to the main site, so it shows your frames once step 7 is done.
7. When happy: on GitHub, open the pull request **Multi-retailer platform** and click **Merge**. GitHub Pages updates the live site in a minute or two.

## E. Give each shop its QR code

Every approved shop has one, in **Shop dashboard → Shop profile → QR code for customers** (you also see it in **#/admin → Shops → Approved → Details**). Customers scan it with their phone camera: the site opens on that shop's frames, they can search, filter and try them on, and that browser tab stays on that shop (no list of other shops). No app, no sign-in, and their camera stays on their phone.

1. **Print poster** gives an A4 page: shop name, the code, "Scan to try on our frames" in English, Hindi and Marathi, three steps and the privacy line. Print it, or choose "Save as PDF" and send it to a print shop. **Download QR (PNG)** is for stickers, WhatsApp or the shop's own designs.
2. Print the code at least 3 cm wide (5 cm or more scans more easily) and scan it with an Android phone and an iPhone before putting it up.
3. The code never changes: adding, editing or removing frames needs no new print. It stops working only if the shop is suspended (customers then see "This shop isn't available").
4. The in-store screen still uses the kiosk link on the same page (`…?kiosk=1`), which behaves the same way.

Making and printing codes costs nothing. A scan is just a visit to the shop's page: about 10 database reads on a phone the first time, and almost none when the same phone scans again.

## Where things are

| You want to… | Go to |
|---|---|
| Try the demo (no sign-in) | **Demo frames** in the top bar, or `#/demo` |
| Add or edit frames | **For shops** (sign in) → **Shop dashboard → Frames → Add a frame** |
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
