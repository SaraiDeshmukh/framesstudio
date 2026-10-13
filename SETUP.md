# Setting up the multi-shop version

These are the steps only the project owner can do: they need your Google account and, for Storage, a billing account. Nothing here needs anything installed on your computer.

Until the last part ("Go live"), the current live site keeps working as it does today. The new security rules still let the old site read and write its own frames.

Firebase project: **frame-studio-ad5ed**. Live site: **https://saraideshmukh.github.io/framesstudio/**

---

## A. In the Firebase console (about 10 minutes of clicking)

Open https://console.firebase.google.com/project/frame-studio-ad5ed

1. **Switch to the Blaze (pay as you go) plan.** Click **Upgrade** at the bottom of the left sidebar and link a billing account. Cloud Storage, where shops' frame photos are kept, is not available on the free Spark plan. Small projects like this one usually stay within the free allowance or cost very little (see `COSTS.md`).
2. **Set a budget alert.** Go to https://console.cloud.google.com/billing → your billing account → **Budgets & alerts** → **Create budget**. Choose project frame-studio-ad5ed, an amount such as ₹500 a month, and alerts at 50%, 90% and 100%. A budget alert only **emails you**. It does **not** stop spending.
3. **Turn on Storage.** Go to **Build → Storage → Get started**. Pick a location. `us-central1` is included in Google's free Storage allowance. `asia-south1` (Mumbai) is a little faster in India but has no free allowance. Either is fine at this size.
4. **Sign-in methods.** Go to **Build → Authentication → Sign-in method**:
   - **Email/Password** must be on. It already is, because the current site uses it.
   - Turn on **Anonymous**. It's used only so that one device can send at most one "Report this listing" a minute. It collects no personal details.
5. **Authorised domains.** Go to **Authentication → Settings → Authorised domains** and check that `saraideshmukh.github.io` is listed. It already should be.

## B. Deploy the rules (Cloud Shell, copy and paste)

Open Cloud Shell, a free terminal in your browser: https://console.cloud.google.com/?cloudshell=true&project=frame-studio-ad5ed

Paste these lines one at a time:

```bash
git clone -b multi-retailer-platform https://github.com/SaraiDeshmukh/framesstudio.git
cd framesstudio
npx -y firebase-tools@15.33.0 deploy --only firestore:rules,firestore:indexes,storage --project frame-studio-ad5ed
gcloud storage buckets update gs://frame-studio-ad5ed.firebasestorage.app --cors-file=cors.json
```

- If the deploy asks you to log in, run `npx -y firebase-tools@15.33.0 login --no-localhost`, follow the link, then run the deploy line again.
- If it asks whether to let Storage rules read Firestore, answer **Y**. The Storage rules check in Firestore that a shop is active and owns the product before accepting an upload.
- The last line lets the site load the try-on images into the 3D view.
- The database indexes can take a few minutes to build. Until then, some lists may show an error.

## C. Make yourself the administrator

The rules only treat someone as the administrator if a document for them exists in `admins`. No one can create that document from the website, so it has to be done here in the console.

1. Go to **Authentication → Users** and copy the **User UID** of your account.
2. Go to **Firestore Database → Data → Start collection**. Name the collection `admins` and use your UID as the document ID. Add a field `email` (string) with your email address, then click **Save**.

Never put a service-account key or admin password in the repository.

## D. Go live

1. On GitHub, open the pull request **Multi-retailer platform** and click **Merge**. GitHub Pages updates the live site within a minute or two.
2. Open the site and click **For shops** (top right) to sign in. Use your existing email and password, and verify your email if you're asked to.
3. Go to **…/framesstudio/#/admin → Overview → Initialise platform settings**. This records the current versions of the terms and privacy policy and the default settings.
4. Open **Account → Shop dashboard** and apply for your own shop. Fill in the profile, accept the terms, and submit.
5. Go to **#/admin → Shops** and **Approve** your shop.
6. Go to **Shop dashboard → Import → Copy old frames**. Your existing frames come in as drafts. For each one, set the price and GST, tick the confirmation, and publish.
7. Check **Demo frames**, **Shops** and your shop's page as a customer would, ideally on a phone and on the kiosk.

## Where things are now

| You want to… | Go to |
|---|---|
| Try the demo (no sign-in) | **Demo frames** in the top bar, or `#/demo` |
| Add or edit frames | **For shops** (sign in) **→ Shop dashboard → Frames → Add a frame** |
| Approve shops, moderate listings, see reports and acceptance records | **Account → Admin** (`#/admin`), shown only to you |
| Put a shop's frames on a kiosk | Shop dashboard → **Shop profile** → kiosk link (`#/shop/<id>?kiosk=1`) |

## Before inviting other shops

- Have a lawyer review `legal/*.html`, and fill in the highlighted blanks such as the operator's name, grievance officer and city. `LEGAL-REVIEW.md` lists what to check.
- Have a native speaker read the Hindi and Marathi text.
- Try the live camera on a real phone and on the kiosk.
