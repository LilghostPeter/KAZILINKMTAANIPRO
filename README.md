# ⚡ KaziLink Mtaani — Full Deployment Guide

## Files in this package

```
kazilink/
├── public/
│   ├── index.html        ← Main app (PWA, installable on Android)
│   ├── admin.html        ← Admin dashboard (restricted)
│   ├── manifest.json     ← PWA manifest (needed for Play Store)
│   └── sw.js            ← Service worker (offline support)
├── functions/
│   └── index.js         ← All backend logic (M-Pesa, gifts, withdrawals, fraud)
└── firestore.rules      ← Database security rules
```

---

## STEP 1 — Create Firebase Project

1. Go to https://console.firebase.google.com
2. Click **Add project** → name it `kazilink-mtaani`
3. Enable **Google Analytics** (optional but useful)
4. Click **Create project**

### Enable services:
- **Authentication** → Email/Password → Enable
- **Firestore Database** → Create database → Start in Production mode → Region: `europe-west1` (closest to Kenya)
- **Cloud Functions** → Upgrade to Blaze (pay-as-you-go, required for M-Pesa calls)
- **Hosting** → Set up

---

## STEP 2 — Add Firebase Config to index.html and admin.html

Go to **Project Settings → Your apps → Web app → Config** and replace:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",            // ← replace
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

Do this in **both** `index.html` AND `admin.html`.

---

## STEP 3 — Set M-Pesa Credentials in Functions

### Get Safaricom Daraja credentials:
1. Register at https://developer.safaricom.co.ke
2. Create an app → Get Consumer Key + Consumer Secret
3. Get your Shortcode and Passkey from Daraja portal
4. For the Till number **073000054983**, use it as your Shortcode

```bash
firebase functions:config:set \
  mpesa.key="YOUR_CONSUMER_KEY" \
  mpesa.secret="YOUR_CONSUMER_SECRET" \
  mpesa.shortcode="073000054983" \
  mpesa.passkey="YOUR_PASSKEY" \
  mpesa.env="sandbox"
```

Change `sandbox` to `production` when you go live.

---

## STEP 4 — Deploy

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login
firebase login

# Init project (run from kazilink/ folder)
firebase init

# Select:
# ✓ Firestore
# ✓ Functions (Node.js 18)
# ✓ Hosting (public directory: public)

# Install function dependencies
cd functions
npm install firebase-admin firebase-functions axios
cd ..

# Deploy everything
firebase deploy
```

Your app will be live at: `https://YOUR_PROJECT.web.app`

---

## STEP 5 — Deploy Firestore Rules

```bash
firebase deploy --only firestore:rules
```

---

## STEP 6 — Set Admin Email in admin.html

In `admin.html`, find this line and update with your real email:

```javascript
const ADMIN_EMAILS = ['admin@kazilink.com', 'pitahwambuajr@gmail.com'];
```

Access admin at: `https://YOUR_PROJECT.web.app/admin.html`

---

## STEP 7 — Get on Play Store (TWA Method — Free)

### Option A: PWA → Play Store via Bubblewrap (Recommended, FREE)

**Requirements:** Node.js installed on your computer

```bash
# Install Bubblewrap
npm install -g @bubblewrap/cli

# Init the TWA project
bubblewrap init --manifest https://YOUR_PROJECT.web.app/manifest.json

# Answer the prompts:
# Package name: com.kazilink.mtaani
# App name: KaziLink Mtaani
# Signing key: (generate a new one)

# Build the APK
bubblewrap build
```

This creates `app-release-signed.apk` — upload this to Play Store.

### Option B: Use PWABuilder (Even Easier — browser tool)

1. Go to https://www.pwabuilder.com
2. Enter: `https://YOUR_PROJECT.web.app`
3. Click **Package for stores → Android**
4. Download the `.aab` file
5. Upload to Play Store

---

## STEP 8 — Play Store Submission

1. Go to https://play.google.com/console
2. Pay **$25** one-time developer fee
3. Create app → **KaziLink Mtaani**
4. Upload the `.aab` file from Step 7
5. Fill in:
   - **Title:** KaziLink Mtaani
   - **Category:** Business / Finance
   - **Description:** Kenya's #1 skills platform. Find jobs, watch live skills, send gifts, earn money.
   - **Content Rating:** Everyone
6. Add screenshots (3+ required)
7. Submit for review (usually 3–7 days)

---

## M-Pesa Till Number Setup

Your till number **073000054983** will show as **KAZILINK MTAANI** on every M-Pesa transaction.

The real account owner name is **hidden from buyers** — they only see KAZILINK MTAANI for privacy.

### Revenue flows:
```
Subscription → KES hits your Safaricom till → Platform revenue
Coin purchase → KES hits your till → Credited as coins in app
Gift sent → Coins deducted → 70% to creator balance → 30% to you
Withdrawal → Creator requests → Auto-processed via M-Pesa B2C API
```

---

## Auto-Withdrawal Logic

Auto-withdrawal fires when:
- Fraud score ≤ 79 (low risk)
- Amount ≤ KES 5,000
- Request passes rate limit check

For amounts > KES 5,000 or high fraud score → manual review in admin dashboard.

---

## Security Checklist (Before Going Live)

- [ ] Replace all `YOUR_API_KEY` / `YOUR_PROJECT` placeholders
- [ ] Set `mpesa.env` to `production`
- [ ] Change admin email in `admin.html`
- [ ] Deploy Firestore rules (`firebase deploy --only firestore:rules`)
- [ ] Enable Firebase App Check for extra protection
- [ ] Set up Firebase Alerts for unusual spend
- [ ] Test STK Push in sandbox before going live
- [ ] Add your domain to Firebase Authorized Domains

---

## Support

WhatsApp: **073000054983** (shows as KAZILINK MTAANI)  
Email: pitahwambuajr@gmail.com
