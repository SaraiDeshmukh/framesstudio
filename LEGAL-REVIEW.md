# Legal review checklist (before commercial launch)

The three documents in `legal/` (terms of use, partner shop terms, privacy
policy) were drafted to match what the code actually does. **They are not legal
advice and have not been reviewed by a lawyer.** This list is what a lawyer
should look at, plus the blanks that still have to be filled in.

## Blanks to fill in (highlighted in the pages)

- Operator: the legal name and address of whoever runs the platform. It must be
  a person or entity that can enter contracts — an adult or a registered
  business. (Under the Indian Contract Act, 1872, an agreement with a person
  under 18 is void, so the partner terms must be in the name of an adult or a
  company/firm.)
- Support email, grievance officer (name, designation, contact), privacy contact.
- Firestore location (and Cloud Storage's, if turned on later) from the Firebase console, for the privacy policy.
- Retention periods (accounts after closure, acceptance records, audit log, reports, anonymous reporter accounts).
- Complaint acknowledgement and resolution times; appeal time for shops.
- City for courts / choice of arbitration; any liability cap; scope of indemnity.

## Digital Personal Data Protection Act, 2023 and DPDP Rules, 2025

The Rules were notified in November 2025 with a phased start: most
obligations (notice, security, breach intimation, retention, rights,
children) apply 18 months after notification (around May 2027). Building to
them now is still the right call.

- **Notice (s.5, Rule 3).** The privacy policy is meant to be the standalone
  notice for partner shops. Check it itemises the data and purposes clearly
  enough, links to withdrawing consent, exercising rights and complaining to the
  Board. s.5(3): the notice must be available in English or any Eighth Schedule
  language on request — Hindi and Marathi versions should be **professionally
  translated** (the site's interface translations were AI-written).
- **Grounds (s.6 consent / s.7 legitimate uses).** Decide the ground for each
  purpose (account, public listing, acceptance records, audit log, reports).
- **Customers' camera images.** The platform supplies code that processes the
  image on the user's own device and never receives it. Confirm the view that
  the platform is not processing customers' personal data through try-on (and so
  needs no consent or verifiable parental consent for it), and whether the
  in-browser processing still warrants a short notice (the site shows one on
  every page and before the camera starts).
- **Children (s.9, Rule 10).** No customer data is collected; partner accounts
  are for adults. Confirm nothing else is needed.
- **Security safeguards (s.8(5), Rule 6)** and the one-year log retention in
  the Rules: the platform relies on Firebase's logs. Decide whether to enable
  Cloud Audit Logs / longer log retention.
- **Breach intimation (s.8(6), Rule 7):** write an internal procedure (who
  decides, who tells the Board within 72 hours, how shops are told).
- **Retention and erasure (s.8(7), Rule 8):** fill in periods; set up a yearly
  clean-up of anonymous reporter accounts and resolved reports.
- **Cross-border transfer (s.16):** on the free plan everything (frame photos
  included) is in Firestore, recommended in asia-south1 (Mumbai). If Cloud
  Storage is turned on later, its free tier is US-only, so photos would be
  stored outside India. Fine unless the Government restricts that country;
  record it in the notice (done, with a blank to fill).
- **Rights (ss.11–14, Rule 14):** access, correction, erasure, nomination,
  grievance redressal within 90 days. Account closure is manual (by email) —
  consider a "close my account" button later.
- **Processors (s.8(2)):** Google (Firebase) and GitHub act as processors /
  service providers; check their data processing terms are accepted in the
  Firebase/Google Cloud console.

## Information Technology Act, 2000 and Intermediary Guidelines, 2021

Partner shops' listings are third-party content, so the platform is likely an
**intermediary**. Check the due-diligence duties: publishing rules, privacy
policy and user agreement (done in draft), informing users of prohibited
content (done in the terms), a grievance officer with published contact,
acknowledging complaints within 24 hours and resolving within 15 days, and
removing content on a court or government order within the required time. The
"Report this listing" button and the admin Reports tab support this; the
response times are a process question.

## Consumer protection

- Consumer Protection Act, 2019 and the Consumer Protection (E-Commerce)
  Rules, 2020: no sales or payments happen on the platform, but it lists goods
  from multiple sellers. Ask whether it counts as a "marketplace e-commerce
  entity"; if so, seller details, a grievance officer, price display and other
  duties apply (seller name and contact are already shown on every listing).
- Legal Metrology (Packaged Commodities) Rules: duties for online listings of
  packaged goods (MRP, origin, etc.). Check whether they apply to frames listed
  by shops, and whether listing fields are needed.
- Advertising and "virtual try-on" claims: the site always says it's a
  preview, not a fitting; check the wording.

## GST

The platform does not set or check tax. Shops choose inclusive / exclusive /
no GST and the rate, and confirm it per product; no rate is hard-coded (common
rates are offered as choices only). Check the wording that the calculation is
not tax advice, and whether the platform itself has any GST obligation (it
charges no fees today).

## Intellectual property

- Demo frames are original computer renders made for this project (no brand,
  no third-party image).
- Shops warrant rights in their photos and that branded frames are genuine.
- Open-source components: MediaPipe (Apache-2.0), three.js (MIT), Firebase JS
  SDK (Apache-2.0), IBM Plex fonts (OFL). Consider an attributions page.
