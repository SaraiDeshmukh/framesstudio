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

The new version is published as a preview at **https://saraideshmukh.github.io/framesstudio/preview/**. It uses the same Firebase project, so once A–C are done everything there is real.

1. On the preview, go to **#/admin → Overview → Initialise platform settings** (records the terms and privacy versions and default settings).
2. **Account → Shop dashboard**: apply for your own shop, fill in the profile, accept the terms, submit.
3. **#/admin → Shops → Approve** your shop.
4. **Shop dashboard → Frames → Add a frame**: add one, take or upload its photo, set price and GST, publish. (Or **Import → Copy old frames** if the old site's frames are in this database.)
5. Check it as a customer: **Shops** → your shop → a frame → try it on, on a phone and on the kiosk.
6. When happy: on GitHub, open the pull request **Multi-retailer platform** and click **Merge**. GitHub Pages updates the live site in a minute or two.

## Where things are

| You want to… | Go to |
|---|---|
| Try the demo (no sign-in) | **Demo frames** in the top bar, or `#/demo` |
| Add or edit frames | **For shops** (sign in) → **Shop dashboard → Frames → Add a frame** |
| Approve shops, moderate listings, see reports and acceptance records | **Account → Admin** (`#/admin`), shown only to you |
| Put a shop's frames on a kiosk | Shop dashboard → **Shop profile** → kiosk link (`#/shop/<id>?kiosk=1`) |
| See reads, writes and stored data | Firebase console → **Firestore Database → Usage** |

## Moving to Blaze later

Do this when `COSTS.md` says it's time (the database nears 1 GiB, or reads/downloads keep hitting the daily or monthly limits).

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
