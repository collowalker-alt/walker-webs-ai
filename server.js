const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// ENVIRONMENT
// ============================================================

const GROQ_KEY = process.env.GROQ_KEY;

const PUBLIC_URL = (
  process.env.PUBLIC_URL || "https://walker-webs.web.app"
).replace(/\/$/, "");

const TRC20_WALLET =
  process.env.TRC20_WALLET ||
  "TQn9Y2khEsLJW1ChVWFGP2XNn9wSy8r1Hk";

const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;

const TRONGRID_URL = (
  process.env.TRONGRID_URL || "https://api.trongrid.io"
).replace(/\/$/, "");

// Official USDT TRC20 contract
const USDT_TRC20_CONTRACT =
  process.env.USDT_TRC20_CONTRACT ||
  "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const USDT_DECIMALS = 6;

// ============================================================
// PLANS
// ============================================================

const PLANS = Object.freeze({
  single: {
    amount: 13,
    type: "single"
  },

  monthly: {
    amount: 50,
    type: "monthly"
  },

  lifetime: {
    amount: 120,
    type: "lifetime"
  }
});

// ============================================================
// CONFIG CHECK
// ============================================================

if (!GROQ_KEY) {
  console.warn("WARNING: GROQ_KEY is not configured.");
}

if (!TRONGRID_API_KEY) {
  console.warn("WARNING: TRONGRID_API_KEY is not configured.");
}

if (!TRC20_WALLET) {
  console.warn("WARNING: TRC20_WALLET is not configured.");
}

// ============================================================
// FIREBASE ADMIN
// ============================================================

function initFirebase() {
  if (admin.apps.length) {
    return admin.app();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.warn(
      "Firebase Admin credentials are incomplete."
    );

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

const db = firebaseApp
  ? admin.firestore()
  : null;

const FieldValue = admin.firestore.FieldValue;

// ============================================================
// EXPRESS
// ============================================================

app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "10mb"
  })
);

// ============================================================
// CORS
// ============================================================

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || ""
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      const allowed =
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin) ||
        /^https:\/\/([a-z0-9-]+\.)?web\.app$/i.test(origin) ||
        /^https:\/\/([a-z0-9-]+\.)?firebaseapp\.com$/i.test(origin) ||
        /^http:\/\/localhost(:\d+)?$/i.test(origin);

      if (allowed) {
        callback(null, true);
      } else {
        callback(new Error("CORS not allowed"));
      }
    },

    methods: [
      "GET",
      "POST",
      "DELETE",
      "OPTIONS"
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);

// ============================================================
// RATE LIMITERS
// ============================================================

const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    error:
      "Rate limit reached. Please wait 15 minutes."
  }
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    error:
      "Too many payment requests. Please wait."
  }
});

// ============================================================
// FIREBASE HELPERS
// ============================================================

function requireFirebase() {
  if (!db) {
    const error = new Error(
      "Firebase Admin is not configured on the server."
    );

    error.status = 503;

    throw error;
  }
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

async function requireUser(req, res, next) {
  try {
    requireFirebase();

    const authorization =
      req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required."
      });
    }

    const token =
      authorization.substring(7).trim();

    const decoded =
      await admin.auth().verifyIdToken(token);

    req.user = decoded;

    next();

  } catch (error) {

    console.error(
      "AUTH ERROR:",
      error.message
    );

    res.status(
      error.status || 401
    ).json({
      error:
        error.status === 503
          ? error.message
          : "Invalid or expired authentication token."
    });
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/api/health", (req, res) => {

  res.json({
    ok: true,

    service:
      "walker-webs-backend",

    firebase:
      !!db,

    tronVerification:
      !!TRONGRID_API_KEY,

    walletConfigured:
      !!TRC20_WALLET,

    timestamp:
      Date.now()
  });
});

// ============================================================
// AI WEBSITE GENERATION
// ============================================================

app.post(
  "/api/generate",
  generateLimiter,
  async (req, res) => {

    const prompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.trim()
        : "";

    if (!prompt) {
      return res.status(400).json({
        error: "Prompt is required."
      });
    }

    if (prompt.length > 6000) {
      return res.status(400).json({
        error: "Prompt is too long."
      });
    }

    if (!GROQ_KEY) {
      return res.status(503).json({
        error:
          "AI service is not configured."
      });
    }

    const fullPrompt = `
You are an expert web developer for WALKER WEBS.

Generate a complete production-quality
single-file HTML website based on this request:

"${prompt}"

IMPORTANT RULES:

1. Return ONLY complete HTML.
2. Do NOT use markdown code fences.
3. The document must start with <!DOCTYPE html>.
4. Use Tailwind CSS CDN.
5. Make the website mobile-first.
6. Make it responsive on phones, tablets and desktop.
7. Use semantic accessible HTML.
8. Use modern typography.
9. Use polished spacing.
10. Use modern cards and sections.
11. Add subtle animations.
12. Include a strong CTA.
13. Include a responsive navigation.
14. Include a footer.
15. Do not expose API keys.
16. Do not invent secrets.
17. Keep everything inside one HTML file.
18. Make sure all JavaScript works.
19. Make sure the final HTML is complete.
`;

    try {

      const response =
        await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              Authorization:
                `Bearer ${GROQ_KEY}`
            },

            body: JSON.stringify({
              model:
                "openai/gpt-oss-120b",

              messages: [
                {
                  role: "user",
                  content: fullPrompt
                }
              ],

              temperature: 0.7,

              max_tokens: 6000
            })
          }
        );

      const data =
        await response.json();

      if (!response.ok || data.error) {

        console.error(
          "GROQ ERROR:",
          data.error?.message ||
            response.statusText
        );

        return res.status(
          response.status === 429
            ? 429
            : 502
        ).json({
          error:
            data.error?.message ||
            "AI generation failed."
        });
      }

      let html =
        data?.choices?.[0]?.message?.content ||
        "";

      html = html
        .replace(/^```html\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      if (
        !html
          .toLowerCase()
          .includes("<html") &&
        !html
          .toLowerCase()
          .includes("<!doctype html>")
      ) {

        return res.status(502).json({
          error:
            "AI returned invalid HTML."
        });
      }

      res.json({
        html
      });

    } catch (error) {

      console.error(
        "GENERATE ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Website generation failed."
      });
    }
  }
);

// ============================================================
// PLAN HELPERS
// ============================================================

function getPlan(type, amount) {

  const plan =
    PLANS[type];

  if (!plan) {
    return null;
  }

  if (
    Number(amount) !==
    plan.amount
  ) {
    return null;
  }

  return plan;
}

function toTokenUnits(usdt) {

  return BigInt(
    Math.round(
      Number(usdt) *
        10 ** USDT_DECIMALS
    )
  );
}

function sameAddress(a, b) {

  return (
    String(a || "").trim() ===
    String(b || "").trim()
  );
}

function transactionIsRecent(
  timestamp,
  maxAgeMs =
    24 * 60 * 60 * 1000
) {

  if (!timestamp) {
    return false;
  }

  return (
    Date.now() -
      Number(timestamp) <=
    maxAgeMs
  );
}

// ============================================================
// TRON API
// ============================================================

async function tronRequest(url) {

  const headers = {
    Accept:
      "application/json",

    "TRON-PRO-API-KEY":
      TRONGRID_API_KEY
  };

  const response =
    await fetch(
      url,
      {
        headers
      }
    );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {

    throw new Error(
      `TronGrid ${response.status}: ${
        data?.error ||
        data?.message ||
        response.statusText
      }`
    );
  }

  return data;
}

// ============================================================
// AUTOMATIC USDT TRC20 VERIFICATION
// ============================================================

async function verifyUsdtPayment(
  txHash,
  expectedAmount
) {

  if (!TRONGRID_API_KEY) {

    throw new Error(
      "TRONGRID_API_KEY is not configured."
    );
  }

  const hash =
    String(txHash || "").trim();

  // TRON TX hashes are 64 hexadecimal characters
  if (
    !/^[a-fA-F0-9]{64}$/.test(hash)
  ) {

    return {
      status: "rejected",

      reason:
        "Invalid transaction hash."
    };
  }

  const url =
    `${TRONGRID_URL}/v1/accounts/` +
    `${encodeURIComponent(TRC20_WALLET)}` +
    `/transactions/trc20` +
    `?only_confirmed=true` +
    `&only_to=true` +
    `&limit=200` +
    `&contract_address=` +
    `${encodeURIComponent(
      USDT_TRC20_CONTRACT
    )}`;

  const data =
    await tronRequest(url);

  const transfers =
    Array.isArray(data?.data)
      ? data.data
      : [];

  const transfer =
    transfers.find(
      (item) =>
        String(
          item?.transaction_id || ""
        ).toLowerCase() ===
        hash.toLowerCase()
    );

  if (!transfer) {

    return {
      status: "pending",

      reason:
        "Transaction has not appeared as a confirmed USDT transfer to the Walker Webs wallet yet."
    };
  }

  const tokenAddress =
    transfer?.token_info?.address ||
    transfer?.contract_address ||
    "";

  if (
    !sameAddress(
      tokenAddress,
      USDT_TRC20_CONTRACT
    )
  ) {

    return {
      status: "rejected",

      reason:
        "This is not the official USDT TRC20 token."
    };
  }

  if (
    !sameAddress(
      transfer.to,
      TRC20_WALLET
    )
  ) {

    return {
      status: "rejected",

      reason:
        "The payment was not sent to the Walker Webs payment wallet."
    };
  }

  const actualUnits =
    BigInt(
      String(
        transfer.value || "0"
      )
    );

  const requiredUnits =
    toTokenUnits(
      expectedAmount
    );

  if (
    actualUnits <
    requiredUnits
  ) {

    return {
      status: "rejected",

      reason:
        `Insufficient payment. Required ${expectedAmount} USDT.`
    };
  }

  if (
    !transactionIsRecent(
      transfer.block_timestamp
    )
  ) {

    return {
      status: "rejected",

      reason:
        "This transaction is too old to be used for a new purchase."
    };
  }

  return {

    status:
      "confirmed",

    txHash:
      hash,

    amount:
      Number(actualUnits) /
      10 ** USDT_DECIMALS,

    from:
      transfer.from,

    to:
      transfer.to,

    timestamp:
      Number(
        transfer.block_timestamp
      ),

    token:
      "USDT",

    network:
      "TRC20"
  };
}

// ============================================================
// SUBMIT PAYMENT
// ============================================================

app.post(
  "/api/payments/submit",
  paymentLimiter,
  requireUser,
  async (req, res) => {

    try {

      const {
        amount,
        type,
        txHash,
        html,
        prompt
      } = req.body || {};

      const plan =
        getPlan(
          type,
          amount
        );

      if (!plan) {

        return res.status(400).json({
          error:
            "Invalid payment plan."
        });
      }

      if (
        !txHash ||
        typeof txHash !==
          "string"
      ) {

        return res.status(400).json({
          error:
            "Transaction hash is required."
        });
      }

      if (
        typeof html !== "string" ||
        !html.trim()
      ) {

        return res.status(400).json({
          error:
            "Website HTML is required."
        });
      }

      // Prevent duplicate transaction use
      const existing =
        await db
          .collection("payments")
          .where(
            "txHash",
            "==",
            txHash.trim()
          )
          .limit(5)
          .get();

      if (!existing.empty) {

        const used =
          existing.docs.some(
            (doc) => {

              const data =
                doc.data();

              return [
                "pending",
                "confirmed",
                "approved"
              ].includes(
                data.status
              );
            }
          );

        if (used) {

          return res.status(409).json({
            error:
              "This transaction hash has already been submitted."
          });
        }
      }

      const verification =
        await verifyUsdtPayment(
          txHash,
          plan.amount
        );

      const paymentRef =
        db
          .collection("payments")
          .doc();

      await paymentRef.set({

        userId:
          req.user.uid,

        email:
          req.user.email || null,

        amount:
          plan.amount,

        type:
          plan.type,

        txHash:
          txHash.trim(),

        wallet:
          TRC20_WALLET,

        tokenContract:
          USDT_TRC20_CONTRACT,

        network:
          "TRC20",

        status:
          verification.status,

        verificationReason:
          verification.reason || null,

        verification:
          verification.status ===
          "confirmed"
            ? verification
            : null,

        html,

        prompt:
          typeof prompt ===
          "string"
            ? prompt
            : "",

        createdAt:
          FieldValue.serverTimestamp(),

        updatedAt:
          FieldValue.serverTimestamp()
      });

      if (
        verification.status ===
        "confirmed"
      ) {

        const subscription =
          await activatePayment(
            paymentRef,
            verification
          );

        return res.json({

          ok: true,

          status:
            "confirmed",

          paymentId:
            paymentRef.id,

          subscription
        });
      }

      return res.status(202).json({

        ok: true,

        status:
          verification.status,

        paymentId:
          paymentRef.id,

        message:
          verification.reason ||
          "Payment submitted. Automatic verification will continue."
      });

    } catch (error) {

      console.error(
        "PAYMENT SUBMIT ERROR:",
        error
      );

      res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Payment submission failed."
      });
    }
  }
);

// ============================================================
// PAYMENT STATUS
// ============================================================

app.get(
  "/api/payments/:paymentId",
  requireUser,
  async (req, res) => {

    try {

      const paymentRef =
        db
          .collection("payments")
          .doc(
            req.params.paymentId
          );

      const snapshot =
        await paymentRef.get();

      if (!snapshot.exists) {

        return res.status(404).json({
          error:
            "Payment not found."
        });
      }

      const payment =
        snapshot.data();

      if (
        payment.userId !==
        req.user.uid
      ) {

        return res.status(403).json({
          error:
            "Not allowed."
        });
      }

      // Automatically re-check pending payments
      if (
        payment.status ===
        "pending"
      ) {

        const verification =
          await verifyUsdtPayment(
            payment.txHash,
            payment.amount
          );

        if (
          verification.status ===
          "confirmed"
        ) {

          const subscription =
            await activatePayment(
              paymentRef,
              verification
            );

          return res.json({

            ok: true,

            status:
              "confirmed",

            paymentId:
              paymentRef.id,

            subscription
          });
        }

        if (
          verification.status ===
          "rejected"
        ) {

          await paymentRef.update({

            status:
              "rejected",

            verificationReason:
              verification.reason,

            updatedAt:
              FieldValue.serverTimestamp()
          });

          return res.json({

            ok: true,

            status:
              "rejected",

            paymentId:
              paymentRef.id,

            reason:
              verification.reason
          });
        }
      }

      const updated =
        await paymentRef.get();

      const data =
        updated.data();

      res.json({

        ok: true,

        status:
          data.status,

        paymentId:
          paymentRef.id,

        reason:
          data.verificationReason ||
          null
      });

    } catch (error) {

      console.error(
        "PAYMENT STATUS ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not check payment status."
      });
    }
  }
);

// ============================================================
// ACTIVATE PAYMENT
// ============================================================

async function activatePayment(
  paymentRef,
  verification
) {

  const paymentSnapshot =
    await paymentRef.get();

  if (
    !paymentSnapshot.exists
  ) {

    throw new Error(
      "Payment record does not exist."
    );
  }

  const payment =
    paymentSnapshot.data();

  const subscriptionRef =
    db
      .collection("subscriptions")
      .doc(
        payment.userId
      );

  let result;

  await db.runTransaction(
    async (transaction) => {

      const freshSnapshot =
        await transaction.get(
          paymentRef
        );

      const freshPayment =
        freshSnapshot.data();

      // Idempotency protection
      if (
        freshPayment.status ===
        "approved"
      ) {

        result = {
          type:
            freshPayment.type,

          amount:
            freshPayment.amount,

          alreadyActivated:
            true
        };

        return;
      }

      const now =
        Date.now();

      let subscription;

      if (
        freshPayment.type ===
        "single"
      ) {

        const existingSnapshot =
          await transaction.get(
            subscriptionRef
          );

        const existing =
          existingSnapshot.exists
            ? existingSnapshot.data()
            : {};

        subscription = {

          type:
            "single",

          amount:
            freshPayment.amount,

          credits:
            Number(
              existing.credits || 0
            ) + 1,

          activatedAt:
            now,

          updatedAt:
            now,

          lastTxHash:
            freshPayment.txHash
        };

      } else if (
        freshPayment.type ===
        "monthly"
      ) {

        subscription = {

          type:
            "monthly",

          amount:
            freshPayment.amount,

          expiresAt:
            now +
            30 *
              24 *
              60 *
              60 *
              1000,

          activatedAt:
            now,

          updatedAt:
            now,

          lastTxHash:
            freshPayment.txHash
        };

      } else if (
        freshPayment.type ===
        "lifetime"
      ) {

        subscription = {

          type:
            "lifetime",

          amount:
            freshPayment.amount,

          expiresAt:
            null,

          activatedAt:
            now,

          updatedAt:
            now,

          lastTxHash:
            freshPayment.txHash
        };

      } else {

        throw new Error(
          "Unknown payment type."
        );
      }

      transaction.set(
        subscriptionRef,
        subscription,
        {
          merge: true
        }
      );

      transaction.update(
        paymentRef,
        {

          status:
            "approved",

          verification,

          verificationReason:
            "Payment confirmed automatically on TRON.",

          approvedAt:
            FieldValue.serverTimestamp(),

          updatedAt:
            FieldValue.serverTimestamp()
        }
      );

      result =
        subscription;
    }
  );

  return result;
}

// ============================================================
// AUTOMATIC BACKGROUND PAYMENT CHECK
// ============================================================

async function processPendingPayments() {

  if (
    !db ||
    !TRONGRID_API_KEY
  ) {
    return;
  }

  try {

    const snapshot =
      await db
        .collection("payments")
        .where(
          "status",
          "==",
          "pending"
        )
        .limit(25)
        .get();

    for (
      const doc of snapshot.docs
    ) {

      const payment =
        doc.data();

      try {

        const verification =
          await verifyUsdtPayment(
            payment.txHash,
            payment.amount
          );

        if (
          verification.status ===
          "confirmed"
        ) {

          await activatePayment(
            doc.ref,
            verification
          );

          console.log(
            "PAYMENT CONFIRMED:",
            doc.id
          );

        } else if (
          verification.status ===
          "rejected"
        ) {

          await doc.ref.update({

            status:
              "rejected",

            verificationReason:
              verification.reason,

            updatedAt:
              FieldValue.serverTimestamp()
          });

          console.log(
            "PAYMENT REJECTED:",
            doc.id
          );
        }

      } catch (error) {

        console.error(
          "PAYMENT CHECK ERROR:",
          doc.id,
          error.message
        );
      }
    }

  } catch (error) {

    console.error(
      "PAYMENT SCAN ERROR:",
      error.message
    );
  }
}

// ============================================================
// SECURE PUBLISH
// ============================================================

app.post(
  "/api/publish",
  requireUser,
  async (req, res) => {

    try {

      const {
        html,
        prompt
      } = req.body || {};

      if (
        !html ||
        typeof html !==
          "string"
      ) {

        return res.status(400).json({
          error:
            "HTML is required."
        });
      }

      const subscriptionRef =
        db
          .collection("subscriptions")
          .doc(
            req.user.uid
          );

      const subscriptionSnapshot =
        await subscriptionRef.get();

      if (
        !subscriptionSnapshot.exists
      ) {

        return res.status(402).json({
          error:
            "No active publishing plan."
        });
      }

      const subscription =
        subscriptionSnapshot.data();

      const now =
        Date.now();

      if (
        subscription.type ===
          "monthly" &&
        (
          !subscription.expiresAt ||
          Number(
            subscription.expiresAt
          ) <= now
        )
      ) {

        return res.status(402).json({
          error:
            "Your monthly plan has expired."
        });
      }

      if (
        subscription.type ===
          "single" &&
        Number(
          subscription.credits || 0
        ) <= 0
      ) {

        return res.status(402).json({
          error:
            "No publishing credits remaining."
        });
      }

      const publishId =
        crypto.randomUUID();

      const url =
        `${PUBLIC_URL}/p/${publishId}`;

      await db
        .collection("published")
        .doc(publishId)
        .set({

          html,

          originalHtml:
            html,

          prompt:
            typeof prompt ===
            "string"
              ? prompt
              : "",

          userId:
            req.user.uid,

          email:
            req.user.email ||
            null,

          createdAt:
            now,

          url,

          subType:
            subscription.type
        });

      if (
        subscription.type ===
        "single"
      ) {

        await subscriptionRef.update({

          credits:
            FieldValue.increment(-1),

          updatedAt:
            now
        });
      }

      res.json({

        ok: true,

        publishId,

        url
      });

    } catch (error) {

      console.error(
        "PUBLISH ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Publishing failed."
      });
    }
  }
);

// ============================================================
// SERVE FRONTEND
// ============================================================

app.get("*", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      `WALKER WEBS backend running on port ${PORT}`
    );

    console.log(
      `Payment wallet: ${TRC20_WALLET}`
    );

    console.log(
      `TRON API: ${TRONGRID_URL}`
    );

    console.log(
      `Firebase Admin: ${!!db}`
    );

    console.log(
      `Automatic payment verification: ${
        !!TRONGRID_API_KEY
      }`
    );

    if (
      db &&
      TRONGRID_API_KEY
    ) {

      // Check every 30 seconds
      setInterval(
        processPendingPayments,
        30 * 1000
      );

      // Initial check
      setTimeout(
        processPendingPayments,
        5000
      );
    }
  }
);