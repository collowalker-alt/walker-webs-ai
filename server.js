const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

const GROQ_KEY = process.env.GROQ_KEY;
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://walker-webs.web.app").replace(/\/$/, "");
const TRC20_WALLET = process.env.TRC20_WALLET || "TKRAT57UckeS15pxfkGyaxvyHmdKuupZgD";
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;
const TRONGRID_URL = (process.env.TRONGRID_URL || "https://api.trongrid.io").replace(/\/$/, "");
const USDT_TRC20_CONTRACT = process.env.USDT_TRC20_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_DECIMALS = 6;

const FREE_WEBSITES = 3;
const FREE_EDITS = 3;

const PLANS = Object.freeze({
  single: { amount: 13, type: "single" },
  monthly: { amount: 50, type: "monthly" },
  lifetime: { amount: 120, type: "lifetime" }
});

function initFirebase() {
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.warn("Firebase Admin credentials are incomplete.");
    return null;
  }

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n")
    })
  });
}

const firebaseApp = initFirebase();
const db = firebaseApp ? admin.firestore() : null;
const FieldValue = admin.firestore.FieldValue;

app.set("trust proxy", 1);
app.use(express.json({ limit: "12mb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(x => x.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const allowed =
      allowedOrigins.length === 0 ||
      allowedOrigins.includes(origin) ||
      /^https:\/\/([a-z0-9-]+\.)?web\.app$/i.test(origin) ||
      /^https:\/\/([a-z0-9-]+\.)?firebaseapp\.com$/i.test(origin) ||
      /^https:\/\/([a-z0-9-]+\.)?onrender\.com$/i.test(origin) ||
      /^http:\/\/localhost(:\d+)?$/i.test(origin);
    callback(allowed ? null : new Error("CORS not allowed"), allowed);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit reached. Please wait 15 minutes." }
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment requests. Please wait." }
});

function requireFirebase() {
  if (!db) {
    const e = new Error("Firebase Admin is not configured on the server.");
    e.status = 503;
    throw e;
  }
}

async function requireUser(req, res, next) {
  try {
    requireFirebase();
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required." });
    }
    const token = authorization.substring(7).trim();
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (e) {
    console.error("AUTH ERROR:", e.message);
    res.status(e.status || 401).json({
      error: e.status === 503 ? e.message : "Invalid or expired authentication token."
    });
  }
}

function cleanHTML(html) {
  return String(html || "")
    .replace(/^```html\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function isHTML(html) {
  const x = String(html || "").toLowerCase();
  return x.includes("<!doctype html>") || x.includes("<html");
}

function getPlan(type, amount) {
  const plan = PLANS[type];
  if (!plan || Number(amount) !== plan.amount) return null;
  return plan;
}

function toTokenUnits(usdt) {
  return BigInt(Math.round(Number(usdt) * 10 ** USDT_DECIMALS));
}

function sameAddress(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function transactionIsRecent(timestamp, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!timestamp) return false;
  return Date.now() - Number(timestamp) <= maxAgeMs;
}

async function tronRequest(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`TronGrid ${response.status}: ${data?.error || data?.message || response.statusText}`);
  }
  return data;
}

async function verifyUsdtPayment(txHash, expectedAmount) {
  if (!TRONGRID_API_KEY) throw new Error("TRONGRID_API_KEY is not configured.");

  const hash = String(txHash || "").trim();
  if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
    return { status: "rejected", reason: "Invalid transaction hash." };
  }

  const url =
    `${TRONGRID_URL}/v1/accounts/${encodeURIComponent(TRC20_WALLET)}/transactions/trc20` +
    `?only_confirmed=true&only_to=true&limit=200&contract_address=${encodeURIComponent(USDT_TRC20_CONTRACT)}`;

  const data = await tronRequest(url);
  const transfers = Array.isArray(data?.data) ? data.data : [];
  const transfer = transfers.find(
    item => String(item?.transaction_id || "").toLowerCase() === hash.toLowerCase()
  );

  if (!transfer) {
    return {
      status: "pending",
      reason: "Transaction has not appeared as a confirmed USDT transfer to the Walker Webs wallet yet."
    };
  }

  const tokenAddress = transfer?.token_info?.address || transfer?.contract_address || "";
  if (!sameAddress(tokenAddress, USDT_TRC20_CONTRACT)) {
    return { status: "rejected", reason: "This is not the official USDT TRC20 token." };
  }

  if (!sameAddress(transfer.to, TRC20_WALLET)) {
    return { status: "rejected", reason: "The payment was not sent to the Walker Webs payment wallet." };
  }

  const actualUnits = BigInt(String(transfer.value || "0"));
  const requiredUnits = toTokenUnits(expectedAmount);

  if (actualUnits < requiredUnits) {
    return { status: "rejected", reason: `Insufficient payment. Required ${expectedAmount} USDT.` };
  }

  if (!transactionIsRecent(transfer.block_timestamp)) {
    return { status: "rejected", reason: "This transaction is too old to be used for a new purchase." };
  }

  return {
    status: "confirmed",
    txHash: hash,
    amount: Number(actualUnits) / 10 ** USDT_DECIMALS,
    from: transfer.from,
    to: transfer.to,
    timestamp: Number(transfer.block_timestamp),
    token: "USDT",
    network: "TRC20"
  };
}

/* ---------- Health ---------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "walker-webs-backend",
    firebase: !!db,
    tronVerification: !!TRONGRID_API_KEY,
    walletConfigured: !!TRC20_WALLET,
    freeWebsites: FREE_WEBSITES,
    freeEdits: FREE_EDITS,
    timestamp: Date.now()
  });
});

/* ---------- AI generation ---------- */

async function groqHTML(instruction) {
  if (!GROQ_KEY) throw new Error("AI service is not configured.");

  const prompt = `
You are the expert web developer for WALKER WEBS.

Create or modify a complete production-quality single-file HTML website.

USER INSTRUCTION:
${instruction}

RULES:
1. Return ONLY complete HTML.
2. No markdown code fences.
3. The document must start with <!DOCTYPE html>.
4. Use Tailwind CSS CDN when useful.
5. Mobile-first and responsive.
6. Semantic accessible HTML.
7. Modern typography and polished spacing.
8. Modern cards and sections.
9. Subtle animations.
10. Strong CTA.
11. Responsive navigation.
12. Footer.
13. Never expose API keys or secrets.
14. Keep everything in one HTML file.
15. Preserve existing functionality unless the user requests a change.
16. Make sure all JavaScript works.
17. Return the complete final document.
`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 10000
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(data.error?.message || "AI generation failed.");
  }

  const html = cleanHTML(data?.choices?.[0]?.message?.content || "");
  if (!isHTML(html)) throw new Error("AI returned invalid HTML.");
  return html;
}

app.post("/api/generate", generateLimiter, async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) return res.status(400).json({ error: "Prompt is required." });
    if (prompt.length > 6000) return res.status(400).json({ error: "Prompt is too long." });

    const html = await groqHTML(prompt);
    res.json({ html });
  } catch (e) {
    console.error("GENERATE ERROR:", e);
    res.status(502).json({ error: e.message || "Website generation failed." });
  }
});

/* ---------- User usage ---------- */

async function getUserUsage(uid) {
  requireFirebase();
  const ref = db.collection("usage").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    return {
      websitesPublished: 0,
      websitesCreated: 0,
      edits: 0,
      freeDownloads: 0,
      updatedAt: Date.now()
    };
  }
  return { websitesPublished: 0, websitesCreated: 0, edits: 0, freeDownloads: 0, ...snap.data() };
}

async function incrementUsage(uid, fields) {
  const ref = db.collection("usage").doc(uid);
  const update = { updatedAt: FieldValue.serverTimestamp() };
  for (const [key, value] of Object.entries(fields)) {
    update[key] = FieldValue.increment(value);
  }
  await ref.set(update, { merge: true });
}

async function hasActivePaidPlan(uid) {
  const snap = await db.collection("subscriptions").doc(uid).get();
  if (!snap.exists) return false;
  const s = snap.data();

  if (s.type === "lifetime") return true;
  if (s.type === "monthly") return Number(s.expiresAt || 0) > Date.now();
  if (s.type === "single") return Number(s.credits || 0) > 0;
  return false;
}

async function consumeSingleCredit(uid) {
  const ref = db.collection("subscriptions").doc(uid);
  const result = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const s = snap.data();
    if (s.type !== "single" || Number(s.credits || 0) <= 0) return false;
    tx.update(ref, { credits: FieldValue.increment(-1), updatedAt: Date.now() });
    return true;
  });
  return result;
}

/* ---------- AI edit endpoint ---------- */

app.post("/api/edit", requireUser, async (req, res) => {
  try {
    const html = typeof req.body?.html === "string" ? req.body.html : "";
    const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";

    if (!html || !isHTML(html)) return res.status(400).json({ error: "Valid website HTML is required." });
    if (!instruction) return res.status(400).json({ error: "Edit instruction is required." });
    if (instruction.length > 4000) return res.status(400).json({ error: "Edit instruction is too long." });
    if (html.length > 9000000) return res.status(413).json({ error: "Website HTML is too large." });

    const usage = await getUserUsage(req.user.uid);
    const paid = await hasActivePaidPlan(req.user.uid);

    if (Number(usage.edits || 0) >= FREE_EDITS && !paid) {
      return res.status(402).json({
        error: "Your 3 free edits are finished. Purchase a plan to continue editing.",
        code: "EDIT_PAYMENT_REQUIRED"
      });
    }

    const instructionWithHTML = `
Modify this EXISTING website according to the requested change.

REQUESTED CHANGE:
${instruction}

EXISTING WEBSITE HTML:
${html}
`;

    const updatedHTML = await groqHTML(instructionWithHTML);

    if (!paid) {
      await incrementUsage(req.user.uid, { edits: 1 });
    }

    res.json({
      ok: true,
      html: updatedHTML,
      freeEditsRemaining: paid ? 0 : Math.max(0, FREE_EDITS - Number(usage.edits || 0) - 1),
      paid
    });
  } catch (e) {
    console.error("EDIT ERROR:", e);
    res.status(e.status || 500).json({ error: e.message || "Website edit failed." });
  }
});

/* ---------- Secure publish with 3 free publishes ---------- */

app.post("/api/publish", requireUser, async (req, res) => {
  try {
    const html = typeof req.body?.html === "string" ? req.body.html : "";
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";

    if (!html || !isHTML(html)) {
      return res.status(400).json({ error: "Valid website HTML is required." });
    }

    const uid = req.user.uid;
    const usage = await getUserUsage(uid);
    const paid = await hasActivePaidPlan(uid);

    let mode = "free";

    if (Number(usage.websitesPublished || 0) >= FREE_WEBSITES) {
      if (!paid) {
        return res.status(402).json({
          error: "Your 3 free publishes are finished. Purchase a plan to continue publishing.",
          code: "PUBLISH_PAYMENT_REQUIRED"
        });
      }
      mode = "paid";
    }

    const publishId = crypto.randomUUID();
    const url = `${PUBLIC_URL}/p/${publishId}`;

    await db.collection("published").doc(publishId).set({
      html,
      originalHtml: html,
      prompt,
      userId: uid,
      email: req.user.email || null,
      createdAt: Date.now(),
      url,
      mode
    });

    await incrementUsage(uid, { websitesPublished: 1 });

    if (paid) {
      const sub = await db.collection("subscriptions").doc(uid).get();
      if (sub.exists && sub.data().type === "single") {
        await consumeSingleCredit(uid);
      }
    }

    res.json({ ok: true, publishId, url, mode });
  } catch (e) {
    console.error("PUBLISH ERROR:", e);
    res.status(500).json({ error: "Publishing failed." });
  }
});

/* ---------- Usage ---------- */

app.get("/api/usage", requireUser, async (req, res) => {
  try {
    const usage = await getUserUsage(req.user.uid);
    const paid = await hasActivePaidPlan(req.user.uid);
    res.json({
      ok: true,
      usage,
      freeWebsitesRemaining: Math.max(0, FREE_WEBSITES - Number(usage.websitesPublished || 0)),
      freeEditsRemaining: paid ? 0 : Math.max(0, FREE_EDITS - Number(usage.edits || 0)),
      paid
    });
  } catch (e) {
    res.status(500).json({ error: "Unable to read usage." });
  }
});

/* ---------- Payment activation ---------- */

async function activatePayment(paymentRef, verification) {
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) throw new Error("Payment not found.");

  const payment = paymentSnap.data();
  const uid = payment.userId;
  const now = Date.now();

  const subscriptionRef = db.collection("subscriptions").doc(uid);

  let subscription;

  await db.runTransaction(async tx => {
    const freshPaymentSnap = await tx.get(paymentRef);
    const freshPayment = freshPaymentSnap.data();

    if (freshPayment.status === "approved") return;

    const existingSnap = await tx.get(subscriptionRef);
    const existing = existingSnap.exists ? existingSnap.data() : {};

    if (freshPayment.type === "single") {
      subscription = {
        type: "single",
        amount: freshPayment.amount,
        credits: Number(existing.credits || 0) + 1,
        activatedAt: now,
        updatedAt: now,
        lastTxHash: freshPayment.txHash
      };
    } else if (freshPayment.type === "monthly") {
      subscription = {
        type: "monthly",
        amount: freshPayment.amount,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000,
        activatedAt: now,
        updatedAt: now,
        lastTxHash: freshPayment.txHash
      };
    } else if (freshPayment.type === "lifetime") {
      subscription = {
        type: "lifetime",
        amount: freshPayment.amount,
        expiresAt: null,
        activatedAt: now,
        updatedAt: now,
        lastTxHash: freshPayment.txHash
      };
    } else {
      throw new Error("Unknown payment type.");
    }

    tx.set(subscriptionRef, subscription, { merge: true });
    tx.update(paymentRef, {
      status: "approved",
      verification,
      verificationReason: "Payment confirmed automatically on TRON.",
      approvedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  });

  return subscription;
}

app.post("/api/payments/submit", paymentLimiter, requireUser, async (req, res) => {
  try {
    const { amount, type, txHash, html, prompt } = req.body || {};
    const plan = getPlan(type, amount);

    if (!plan) return res.status(400).json({ error: "Invalid payment plan." });
    if (!txHash || typeof txHash !== "string") return res.status(400).json({ error: "Transaction hash is required." });
    if (typeof html !== "string" || !html.trim()) return res.status(400).json({ error: "Website HTML is required." });

    const existing = await db.collection("payments").where("txHash", "==", txHash.trim()).limit(5).get();
    if (!existing.empty && existing.docs.some(doc => ["pending", "confirmed", "approved"].includes(doc.data().status))) {
      return res.status(409).json({ error: "This transaction hash has already been submitted." });
    }

    const verification = await verifyUsdtPayment(txHash, plan.amount);

    const paymentRef = db.collection("payments").doc();
    await paymentRef.set({
      userId: req.user.uid,
      email: req.user.email || null,
      amount: plan.amount,
      type: plan.type,
      txHash: txHash.trim(),
      wallet: TRC20_WALLET,
      tokenContract: USDT_TRC20_CONTRACT,
      network: "TRC20",
      status: verification.status,
      verificationReason: verification.reason || null,
      verification: verification.status === "confirmed" ? verification : null,
      html,
      prompt: typeof prompt === "string" ? prompt : "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    if (verification.status === "confirmed") {
      const subscription = await activatePayment(paymentRef, verification);
      return res.json({ ok: true, status: "confirmed", paymentId: paymentRef.id, subscription });
    }

    res.status(202).json({
      ok: true,
      status: verification.status,
      paymentId: paymentRef.id,
      message: verification.reason || "Payment submitted. Automatic verification will continue."
    });
  } catch (e) {
    console.error("PAYMENT SUBMIT ERROR:", e);
    res.status(e.status || 500).json({ error: e.message || "Payment submission failed." });
  }
});

app.get("/api/payments/:paymentId", requireUser, async (req, res) => {
  try {
    const paymentRef = db.collection("payments").doc(req.params.paymentId);
    const snap = await paymentRef.get();

    if (!snap.exists) return res.status(404).json({ error: "Payment not found." });

    const payment = snap.data();
    if (payment.userId !== req.user.uid) return res.status(403).json({ error: "Not allowed." });

    if (payment.status === "pending") {
      const verification = await verifyUsdtPayment(payment.txHash, payment.amount);

      if (verification.status === "confirmed") {
        await activatePayment(paymentRef, verification);
        return res.json({ status: "approved", verification });
      }

      if (verification.status === "rejected") {
        await paymentRef.update({
          status: "rejected",
          verificationReason: verification.reason,
          updatedAt: FieldValue.serverTimestamp()
        });
        return res.json({ status: "rejected", reason: verification.reason });
      }
    }

    return res.json({
      status: payment.status,
      reason: payment.verificationReason || null
    });
  } catch (e) {
    console.error("PAYMENT STATUS ERROR:", e);
    res.status(500).json({ error: "Unable to check payment status." });
  }
});

/* ---------- Background payment checker ---------- */

async function processPendingPayments() {
  if (!db || !TRONGRID_API_KEY) return;

  try {
    const snapshot = await db.collection("payments")
      .where("status", "==", "pending")
      .limit(25)
      .get();

    for (const doc of snapshot.docs) {
      try {
        const payment = doc.data();
        const verification = await verifyUsdtPayment(payment.txHash, payment.amount);

        if (verification.status === "confirmed") {
          await activatePayment(doc.ref, verification);
          console.log("PAYMENT CONFIRMED:", doc.id);
        } else if (verification.status === "rejected") {
          await doc.ref.update({
            status: "rejected",
            verificationReason: verification.reason,
            updatedAt: FieldValue.serverTimestamp()
          });
        }
      } catch (e) {
        console.error("PAYMENT CHECK ERROR:", doc.id, e.message);
      }
    }
  } catch (e) {
    console.error("PAYMENT SCAN ERROR:", e.message);
  }
}

/* ---------- Public published pages ---------- */

app.get("/p/:publishId", async (req, res) => {
  try {
    requireFirebase();
    const snap = await db.collection("published").doc(req.params.publishId).get();

    if (!snap.exists) return res.status(404).send("Website not found.");

    const html = snap.data().html;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("PUBLIC PAGE ERROR:", e);
    res.status(500).send("Unable to load website.");
  }
});

/* ---------- Optional frontend serving ---------- */

app.get("/", (req, res) => {
  const index = path.join(__dirname, "public", "index.html");
  if (require("fs").existsSync(index)) return res.sendFile(index);
  res.json({ service: "walker-webs-backend", ok: true });
});

app.listen(PORT, () => {
  console.log(`WALKER WEBS backend running on port ${PORT}`);
  console.log(`Payment wallet: ${TRC20_WALLET}`);
  console.log(`Firebase Admin: ${!!db}`);
  console.log(`Automatic payment verification: ${!!TRONGRID_API_KEY}`);

  if (db && TRONGRID_API_KEY) {
    setInterval(processPendingPayments, 30 * 1000);
    setTimeout(processPendingPayments, 5000);
  }
});
