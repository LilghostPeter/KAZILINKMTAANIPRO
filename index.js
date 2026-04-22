/**
 * KaziLink Mtaani — Firebase Cloud Functions
 * Complete backend: M-Pesa STK Push, Auto-Withdrawal, Gifts, Fraud Detection
 *
 * SETUP:
 *   npm install firebase-admin firebase-functions axios
 *   firebase functions:config:set mpesa.key="CONSUMER_KEY" mpesa.secret="CONSUMER_SECRET"
 *   firebase functions:config:set mpesa.shortcode="YOUR_SHORTCODE" mpesa.passkey="YOUR_PASSKEY"
 *   firebase functions:config:set mpesa.env="production"   (or "sandbox" for testing)
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");
const axios     = require("axios");

admin.initializeApp();
const db = admin.firestore();

// ── CONFIG ───────────────────────────────────────────────────
const cfg = functions.config();

const MPESA_KEY       = cfg.mpesa?.key       || "YOUR_CONSUMER_KEY";
const MPESA_SECRET    = cfg.mpesa?.secret    || "YOUR_CONSUMER_SECRET";
const MPESA_SHORTCODE = cfg.mpesa?.shortcode || "YOUR_SHORTCODE";
const MPESA_PASSKEY   = cfg.mpesa?.passkey   || "YOUR_PASSKEY";
const IS_SANDBOX      = (cfg.mpesa?.env || "sandbox") === "sandbox";

const MPESA_BASE = IS_SANDBOX
  ? "https://sandbox.safaricom.co.ke"
  : "https://api.safaricom.co.ke";

const CALLBACK_URL = IS_SANDBOX
  ? "https://us-central1-YOUR_PROJECT.cloudfunctions.net/mpesaCallback"
  : "https://us-central1-YOUR_PROJECT.cloudfunctions.net/mpesaCallback";

const TILL_NAME       = "KAZILINK MTAANI";
const CREATOR_SHARE   = 0.70;
const PLATFORM_SHARE  = 0.30;
const MAX_AUTO_PAYOUT = 5000;   // Max KES for auto-processing
const MAX_FRAUD_SCORE = 79;     // Fraud score above this = manual review

// ── RATE LIMIT HELPER ────────────────────────────────────────
const rateLimits = new Map();
function checkRateLimit(uid, action, limitMs) {
  const key = `${uid}_${action}`;
  const last = rateLimits.get(key) || 0;
  if (Date.now() - last < limitMs) return false;
  rateLimits.set(key, Date.now());
  return true;
}

// ── M-PESA TOKEN ─────────────────────────────────────────────
async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_KEY}:${MPESA_SECRET}`).toString("base64");
  const res = await axios.get(
    `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

// ── STK PUSH PASSWORD ────────────────────────────────────────
function getStkPassword() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const password = Buffer.from(
    `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
  ).toString("base64");
  return { password, timestamp };
}

// ── STK PUSH (Callable) ──────────────────────────────────────
exports.stkPush = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid   = context.auth.uid;
  const phone = String(data.phone || "").replace(/^0/, "254").replace(/\+/,"");
  const amount = parseInt(data.amount);
  const type   = data.type; // "subscription" | "coins"

  // Rate limit: max 1 STK push per 10 seconds
  if (!checkRateLimit(uid, "stk", 10000)) {
    throw new functions.https.HttpsError("resource-exhausted", "Please wait before retrying");
  }

  // Validate
  if (!phone.match(/^254[0-9]{9}$/)) throw new functions.https.HttpsError("invalid-argument", "Invalid phone number");
  if (!amount || amount < 10 || amount > 100000) throw new functions.https.HttpsError("invalid-argument", "Invalid amount");
  if (!["subscription","coins"].includes(type)) throw new functions.https.HttpsError("invalid-argument", "Invalid type");

  // Fraud check
  const userDoc = await db.collection("users").doc(uid).get();
  if (userDoc.exists && userDoc.data().frozen) {
    throw new functions.https.HttpsError("permission-denied", "Account is suspended");
  }

  try {
    const token = await getMpesaToken();
    const { password, timestamp } = getStkPassword();

    const res = await axios.post(
      `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   "CustomerBuyGoodsOnline",
        Amount:            amount,
        PartyA:            phone,
        PartyB:            MPESA_SHORTCODE,
        PhoneNumber:       phone,
        CallBackURL:       CALLBACK_URL,
        AccountReference:  TILL_NAME,
        TransactionDesc:   `KaziLink ${type}`
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Log the pending payment
    await db.collection("pendingPayments").add({
      uid, phone, amount, type,
      checkoutId: res.data.CheckoutRequestID,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: "Check your phone for M-Pesa prompt" };
  } catch (err) {
    console.error("STK Push error:", err.response?.data || err.message);
    throw new functions.https.HttpsError("internal", "M-Pesa push failed. Try again.");
  }
});

// ── M-PESA CALLBACK (HTTP) ───────────────────────────────────
exports.mpesaCallback = functions.https.onRequest(async (req, res) => {
  const callback = req.body?.Body?.stkCallback;
  if (!callback) return res.send("OK");

  const checkoutId  = callback.CheckoutRequestID;
  const resultCode  = callback.ResultCode;
  const meta        = callback.CallbackMetadata?.Item || [];

  if (resultCode === 0) {
    // Payment confirmed
    const amount = meta.find(i => i.Name === "Amount")?.Value || 0;
    const phone  = String(meta.find(i => i.Name === "PhoneNumber")?.Value || "");
    const mpesaRef = meta.find(i => i.Name === "MpesaReceiptNumber")?.Value || "";

    // Find the pending payment
    const pendSnap = await db.collection("pendingPayments")
      .where("checkoutId", "==", checkoutId)
      .where("status", "==", "pending")
      .get();

    if (pendSnap.empty) return res.send("OK");

    const pendDoc = pendSnap.docs[0];
    const pend    = pendDoc.data();

    const batch = db.batch();

    // Mark pending payment done
    batch.update(pendDoc.ref, { status: "confirmed", mpesaRef, confirmedAt: admin.firestore.FieldValue.serverTimestamp() });

    // Record transaction
    const txRef = db.collection("transactions").doc();
    const userDoc = await db.collection("users").doc(pend.uid).get();
    batch.set(txRef, {
      uid: pend.uid,
      userEmail: userDoc.data()?.email || "",
      phone, amount, type: pend.type,
      mpesaRef, status: "confirmed",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update user record
    const userRef = db.collection("users").doc(pend.uid);
    if (pend.type === "subscription") {
      batch.update(userRef, { subscribed: true, subscribedAt: admin.firestore.FieldValue.serverTimestamp() });
    } else if (pend.type === "coins") {
      batch.update(userRef, { coins: admin.firestore.FieldValue.increment(amount) });
    }

    // Update admin revenue
    const adminRef = db.collection("admin").doc("main");
    batch.set(adminRef, {
      totalRevenue:   admin.firestore.FieldValue.increment(amount),
      totalCoinsSold: pend.type === "coins" ? admin.firestore.FieldValue.increment(amount) : admin.firestore.FieldValue.increment(0),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await batch.commit();
    console.log(`Payment confirmed: ${pend.type} | KES ${amount} | ${phone}`);
  } else {
    // Payment failed or cancelled
    const pendSnap = await db.collection("pendingPayments")
      .where("checkoutId", "==", checkoutId)
      .get();
    if (!pendSnap.empty) {
      await pendSnap.docs[0].ref.update({ status: "failed" });
    }
  }

  res.send("OK");
});

// ── SEND GIFT (Callable) ─────────────────────────────────────
exports.sendGift = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const senderUid     = context.auth.uid;
  const { emoji, name, cost, creatorHandle } = data;

  if (!cost || cost < 1) throw new functions.https.HttpsError("invalid-argument", "Invalid gift cost");

  // Rate limit: max 1 gift per second
  if (!checkRateLimit(senderUid, "gift", 1000)) {
    throw new functions.https.HttpsError("resource-exhausted", "Sending too fast");
  }

  const senderRef = db.collection("users").doc(senderUid);

  // Find creator by handle
  const creatorSnap = await db.collection("users")
    .where("handle", "==", creatorHandle)
    .limit(1).get();

  return db.runTransaction(async (t) => {
    const senderDoc = await t.get(senderRef);
    if (!senderDoc.exists) throw new Error("User not found");

    const senderData = senderDoc.data();

    // Fraud: self-gifting detection
    if (senderData.handle === creatorHandle) {
      // Log fraud attempt
      await db.collection("fraudAlerts").add({
        userId: senderUid, reason: "Self-gifting attempt",
        resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      t.update(senderRef, { selfGiftAttempts: admin.firestore.FieldValue.increment(1) });
      throw new Error("Self-gifting is not allowed");
    }

    // Fraud: velocity check
    const giftsLastHour = (senderData.giftsInLastHour || 0);
    if (giftsLastHour >= 50) {
      await db.collection("fraudAlerts").add({
        userId: senderUid, reason: "Velocity: >50 gifts/hr",
        resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      throw new Error("Unusual activity detected. Account flagged for review.");
    }

    const coins = senderData.coins || 0;
    if (coins < cost) throw new Error("Insufficient coins");

    const creatorEarnings = Math.floor(cost * CREATOR_SHARE);
    const platformEarnings = cost - creatorEarnings;

    // Deduct coins from sender
    t.update(senderRef, {
      coins: admin.firestore.FieldValue.increment(-cost),
      giftsInLastHour: admin.firestore.FieldValue.increment(1)
    });

    // Credit creator
    if (!creatorSnap.empty) {
      const creatorRef = creatorSnap.docs[0].ref;
      t.update(creatorRef, {
        balance:         admin.firestore.FieldValue.increment(creatorEarnings),
        coinsEarned:     admin.firestore.FieldValue.increment(creatorEarnings),
        giftsReceived:   admin.firestore.FieldValue.increment(1)
      });
    }

    // Record gift
    const giftRef = db.collection("gifts").doc();
    t.set(giftRef, {
      senderUid, creatorHandle, emoji, name, cost,
      creatorEarnings, platformEarnings,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update admin balance
    const adminRef = db.collection("admin").doc("main");
    t.set(adminRef, {
      giftRevenue: admin.firestore.FieldValue.increment(platformEarnings),
      totalRevenue: admin.firestore.FieldValue.increment(platformEarnings)
    }, { merge: true });

    return { success: true, emoji, name, cost };
  });
});

// ── BUY COINS (Callable) ─────────────────────────────────────
exports.buyCoins = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  const uid   = context.auth.uid;
  const coins = parseInt(data.coins);
  const kes   = parseInt(data.kes);
  if (!coins || coins < 1) throw new functions.https.HttpsError("invalid-argument", "Invalid coins");
  await db.collection("users").doc(uid).update({
    coins: admin.firestore.FieldValue.increment(coins)
  });
  await db.collection("transactions").add({
    uid, type: "coins", amount: kes, coinsAdded: coins,
    status: "confirmed", createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await db.collection("admin").doc("main").set({
    totalRevenue:   admin.firestore.FieldValue.increment(kes),
    totalCoinsSold: admin.firestore.FieldValue.increment(coins)
  }, { merge: true });
  return { success: true };
});

// ── REQUEST WITHDRAWAL (Callable) ────────────────────────────
exports.requestWithdrawal = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid   = context.auth.uid;
  const phone = String(data.phone || "").replace(/^0/, "254");
  const amount = parseInt(data.amount);

  if (!phone.match(/^254[0-9]{9}$/)) throw new functions.https.HttpsError("invalid-argument", "Invalid phone");
  if (!amount || amount < 50) throw new functions.https.HttpsError("invalid-argument", "Min withdrawal KES 50");
  if (!checkRateLimit(uid, "withdraw", 60000)) throw new functions.https.HttpsError("resource-exhausted", "Wait 1 min between requests");

  // Fraud check
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data() || {};
  if (userData.frozen) throw new functions.https.HttpsError("permission-denied", "Account suspended");

  const fraudScore = calcFraudScore(userData);
  const withdrawable = Math.floor((userData.coinsEarned || 0) * CREATOR_SHARE);

  if (amount > withdrawable) throw new functions.https.HttpsError("invalid-argument", "Insufficient earned balance");

  const withdrawRef = await db.collection("withdrawals").add({
    userId: uid,
    userName: userData.name || "",
    userEmail: userData.email || "",
    phone, amount, fraudScore,
    status: fraudScore > MAX_FRAUD_SCORE ? "held_fraud_review" : "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Auto-process if low fraud score and under limit
  if (fraudScore <= MAX_FRAUD_SCORE && amount <= MAX_AUTO_PAYOUT) {
    await processB2C(phone, amount, withdrawRef.id, uid);
  }

  return { success: true, held: fraudScore > MAX_FRAUD_SCORE };
});

// ── PROCESS WITHDRAWAL — B2C (Internal) ──────────────────────
async function processB2C(phone, amount, withdrawalId, uid) {
  try {
    const token = await getMpesaToken();
    const { timestamp } = getStkPassword();

    await axios.post(
      `${MPESA_BASE}/mpesa/b2c/v1/paymentrequest`,
      {
        InitiatorName:      "KaziLinkAPI",
        SecurityCredential: "YOUR_ENCRYPTED_INITIATOR_PASSWORD",
        CommandID:          "BusinessPayment",
        Amount:             amount,
        PartyA:             MPESA_SHORTCODE,
        PartyB:             phone,
        Remarks:            "KaziLink Earnings",
        QueueTimeOutURL:    `${CALLBACK_URL}Timeout`,
        ResultURL:          `${CALLBACK_URL}B2C`,
        Occassion:          "Creator withdrawal"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    await db.collection("withdrawals").doc(withdrawalId).update({
      status: "processing", processedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Deduct from user balance
    await db.collection("users").doc(uid).update({
      balance: admin.firestore.FieldValue.increment(-amount),
      coinsEarned: admin.firestore.FieldValue.increment(-Math.ceil(amount / CREATOR_SHARE))
    });

  } catch (err) {
    console.error("B2C error:", err.response?.data || err.message);
    await db.collection("withdrawals").doc(withdrawalId).update({ status: "failed" });
  }
}

// ── ADMIN: PROCESS WITHDRAWAL (Callable) ─────────────────────
exports.processWithdrawal = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const { withdrawalId, phone, amount } = data;
  await processB2C(phone, amount, withdrawalId, data.userId || "admin");

  return { success: true };
});

// ── ADMIN: AUTO-PROCESS ALL PENDING (Callable) ───────────────
exports.autoProcessWithdrawals = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const snap = await db.collection("withdrawals")
    .where("status", "==", "pending")
    .where("fraudScore", "<=", MAX_FRAUD_SCORE)
    .get();

  let processed = 0;
  const promises = [];

  snap.forEach(doc => {
    const d = doc.data();
    if (d.amount <= MAX_AUTO_PAYOUT) {
      promises.push(
        processB2C(d.phone, d.amount, doc.id, d.userId)
          .then(() => processed++)
          .catch(e => console.error(`B2C failed for ${doc.id}:`, e))
      );
    }
  });

  await Promise.all(promises);
  return { success: true, processed };
});

// ── FRAUD SCORE HELPER ───────────────────────────────────────
function calcFraudScore(userData) {
  let score = 0;
  if ((userData.giftsInLastHour   || 0) > 20) score += 40;
  if ((userData.withdrawalAttempts24h || 0) > 3) score += 25;
  if ((userData.selfGiftAttempts  || 0) > 0)  score += 30;
  if ((userData.coins || 0) > 10000 && (userData.coinsEarned || 0) === 0) score += 20;
  return Math.min(score, 100);
}

// ── SCHEDULED: RESET HOURLY COUNTERS ─────────────────────────
exports.resetHourlyCounters = functions.pubsub
  .schedule("every 60 minutes")
  .onRun(async () => {
    const snap = await db.collection("users").where("giftsInLastHour", ">", 0).get();
    const batch = db.batch();
    snap.forEach(doc => batch.update(doc.ref, { giftsInLastHour: 0 }));
    await batch.commit();
    console.log(`Reset hourly counters for ${snap.size} users`);
  });

// ── SCHEDULED: DAILY FRAUD AUDIT ─────────────────────────────
exports.dailyFraudAudit = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    const users = await db.collection("users").get();
    const batch = db.batch();
    let flagged = 0;

    users.forEach(doc => {
      const d = doc.data();
      const score = calcFraudScore(d);
      if (score >= 80 && !d.frozen) {
        batch.update(doc.ref, { frozen: true, frozenAt: admin.firestore.FieldValue.serverTimestamp() });
        const alertRef = db.collection("fraudAlerts").doc();
        batch.set(alertRef, {
          userId: doc.id, reason: `Daily audit: score ${score}`,
          resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        flagged++;
      }
    });

    await batch.commit();
    console.log(`Daily fraud audit: ${flagged} accounts flagged`);
  });

// ── B2C RESULT CALLBACK ───────────────────────────────────────
exports.mpesaCallbackB2C = functions.https.onRequest(async (req, res) => {
  const result = req.body?.Result;
  if (!result) return res.send("OK");

  const convId = result.ConversationID;
  const code   = result.ResultCode;

  const snap = await db.collection("withdrawals")
    .where("mpesaConvId", "==", convId).get();

  if (!snap.empty) {
    await snap.docs[0].ref.update({
      status: code === 0 ? "paid" : "failed",
      resultDesc: result.ResultDesc || ""
    });
  }

  res.send("OK");
});

module.exports.calcFraudScore = calcFraudScore;
