"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

// Node 18+ has global fetch.
// If you're using Node 16 or older, upgrade Node.
if (typeof fetch !== "function") {
  console.error(
    "This server requires Node.js 18 or newer because it uses fetch()."
  );
  process.exit(1);
}

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");

// ============================================================
// ENVIRONMENT
// ============================================================

const GROQ_KEY = process.env.GROQ_KEY || "";

const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  "https://walker-webs.web.app"
).replace(/\/$/, "");

const TRC20_WALLET =
  process.env.TRC20_WALLET ||
  "TQn9Y2khEsLJW1ChVWFGP2XNn9wSy8r1Hk";

const TRONGRID_API_KEY =
  process.env.TRONGRID_API_KEY || "";

const TRONGRID_URL = (
  process.env.TRONGRID_URL ||
  "https://api.trongrid.io"
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
// BASIC CONFIGURATION CHECK
// ============================================================

console.log("==============================================");
console.log("WALKER WEBS SERVER");
console.log("==============================================");

console.log("PORT:", PORT);
console.log("PUBLIC_URL:", PUBLIC_URL);
console.log("PUBLIC_DIR:", PUBLIC_DIR);
console.log("Frontend index:", INDEX_FILE);
console.log("GROQ configured:", Boolean(GROQ_KEY));
console.log("Firebase credentials:", Boolean(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
));
console.log("TRON API configured:", Boolean(TRONGRID_API_KEY));
console.log("Payment wallet:", TRC20_WALLET);

if (!GROQ_KEY) {
  console.warn("WARNING: GROQ_KEY is not configured.");
}

if (!TRONGRID_API_KEY) {
  console.warn("WARNING: TRONGRID_API_KEY is not configured.");
}

// ============================================================
// FIREBASE ADMIN
// ============================================================

function initFirebase() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID;

  const clientEmail =
    process.env.FIREBASE_CLIENT_EMAIL;

  const privateKey =
    process.env.FIREBASE_PRIVATE_KEY;

  if (
    !projectId ||
    !clientEmail ||
    !privateKey
  ) {
    console.warn(
      "Firebase Admin credentials are incomplete."
    );

    return null;
  }

  try {
    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(
          /\\n/g,
          "\n"
        )
      })
    });
  } catch (error) {
    console.error(
      "Firebase initialization failed:",
      error.message
    );

    return null;
  }
}

const firebaseApp = initFirebase();

const db = firebaseApp
  ? admin.firestore()
  : null;

const FieldValue =
  admin.firestore.FieldValue;

// ============================================================
// EXPRESS CONFIGURATION
// ============================================================

app.disable("x-powered-by");

app.set("trust proxy", 1);

// JSON body parser
app.use(
  express.json({
    limit: "10mb"
  })
);

// URL encoded body parser
app.use(
  express.urlencoded({
    extended: true,
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
      // Requests without Origin are allowed.
      // This includes same-origin/server-side requests.
      if (!origin) {
        return callback(null, true);
      }

      const allowed =
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin) ||
        /^https:\/\/([a-z0-9-]+\.)?web\.app$/i.test(origin) ||
        /^https:\/\/([a-z0-9-]+\.)?firebaseapp\.com$/i.test(origin) ||
        /^http:\/\/localhost(:\d+)?$/i.test(origin) ||
        /^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin);

      if (allowed) {
        return callback(null, true);
      }

      console.warn(
        "Blocked CORS origin:",
        origin
      );

      return callback(
        new Error("CORS not allowed")
      );
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
// STATIC FRONTEND FILES
// ============================================================

// IMPORTANT:
// Static files are registered before the SPA fallback.

app.use(
  express.static(PUBLIC_DIR, {
    index: false,

    maxAge:
      process.env.NODE_ENV === "production"
        ? "1h"
        : 0
  })
);

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

async function requireUser(
  req,
  res,
  next
) {
  try {
    requireFirebase();

    const authorization =
      req.headers.authorization || "";

    if (
      !authorization.startsWith(
        "Bearer "
      )
    ) {
      return res.status(401).json({
        error:
          "Authentication required."
      });
    }

    const token =
      authorization
        .substring(7)
        .trim();

    if (!token) {
      return res.status(401).json({
        error:
          "Authentication token is missing."
      });
    }

    const decoded =
      await admin.auth()
        .verifyIdToken(token);

    req.user = decoded;

    next();
  } catch (error) {
    console.error(
      "AUTH ERROR:",
      error.message
    );

    return res.status(
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

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "walker-webs-backend",

      firebase:
        Boolean(db),

      groq:
        Boolean(GROQ_KEY),

      tronVerification:
        Boolean(TRONGRID_API_KEY),

      walletConfigured:
        Boolean(TRC20_WALLET),

      timestamp:
        Date.now()
    });
  }
);

// ============================================================
// AI WEBSITE GENERATION
// ============================================================

app.post(
  "/api/generate",
  generateLimiter,
  async (req, res) => {
    try {
      const prompt =
        typeof req.body?.prompt === "string"
          ? req.body.prompt.trim()
          : "";

      if (!prompt) {
        return res.status(400).json({
          error:
            "Prompt is required."
        });
      }

      if (prompt.length > 6000) {
        return res.status(400).json({
          error:
            "Prompt is too long."
        });
      }

      if (!GROQ_KEY) {
        return res.status(503).json({
          error:
            "AI service is not configured. Add GROQ_KEY to your server environment."
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
13. Include responsive navigation.
14. Include a footer.
15. Do not expose API keys.
16. Do not invent secrets.
17. Keep everything inside one HTML file.
18. Make sure all JavaScript works.
19. Make sure the final HTML is complete.
20. Do not explain the code.
21. Do not wrap the result in markdown.
`;

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
        await response.json()
          .catch(() => ({}));

      if (!response.ok) {
        console.error(
          "GROQ HTTP ERROR:",
          response.status,
          data
        );

        return res.status(
          response.status === 429
            ? 429
            : 502
        ).json({
          error:
            data?.error?.message ||
            "AI generation failed."
        });
      }

      if (data?.error) {
        console.error(
          "GROQ API ERROR:",
          data.error
        );

        return res.status(502).json({
          error:
            data.error.message ||
            "AI generation failed."
        });
      }

      let html =
        data?.choices?.[0]
          ?.message?.content || "";

      html = html
        .replace(
          /^```html\s*/i,
          ""
        )
        .replace(
          /^```\s*/i,
          ""
        )
        .replace(
          /\s*```$/i,
          ""
        )
        .trim();

      if (!html) {
        return res.status(502).json({
          error:
            "AI returned an empty response."
        });
      }

      const lower =
        html.toLowerCase();

      if (
        !lower.includes(
          "<!doctype html"
        ) &&
        !lower.includes(
          "<html"
        )
      ) {
        console.error(
          "Invalid AI HTML:",
          html.substring(0, 500)
        );

        return res.status(502).json({
          error:
            "AI returned invalid HTML."
        });
      }

      return res.json({
        ok: true,
        html
      });

    } catch (error) {
      console.error(
        "GENERATE ERROR:",
        error
      );

      return res.status(500).json({
        error:
          "Website generation failed."
      });
    }
  }
);

// ============================================================
// PLAN HELPERS
// ============================================================

function getPlan(
  type,
  amount
) {
  const plan =
    PLANS[type];

  if (!plan) {
    return null;
  }

  if (
    Number(amount) !==
    Number(plan.amount)
  ) {
    return null;
  }

  return plan;
}

function toTokenUnits(
  usdt
) {
  return BigInt(
    Math.round(
      Number(usdt) *
        10 ** USDT_DECIMALS
    )
  );
}

function sameAddress(
  a,
  b
) {
  return (
    String(a || "")
      .trim()
      .toLowerCase() ===
    String(b || "")
      .trim()
      .toLowerCase()
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

  const age =
    Date.now() -
    Number(timestamp);

  return (
    age >= 0 &&
    age <= maxAgeMs
  );
}

// ============================================================
// TRON API
// ============================================================

async function tronRequest(
  url
) {
  const headers = {
    Accept:
      "application/json"
  };

  if (TRONGRID_API_KEY) {
    headers[
      "TRON-PRO-API-KEY"
    ] = TRONGRID_API_KEY;
  }

  const response =
    await fetch(
      url,
      {
        method: "GET",
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
// USDT TRC20 PAYMENT VERIFICATION
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
    String(txHash || "")
      .trim();

  if (
    !/^[a-fA-F0-9]{64}$/.test(hash)
  ) {
    return {
      status:
        "rejected",

      reason:
        "Invalid transaction hash."
    };
  }

  const url =
    `${TRONGRID_URL}/v1/accounts/` +
    `${encodeURIComponent(
      TRC20_WALLET
    )}` +
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
      status:
        "pending",

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
      status:
        "rejected",

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
      status:
        "rejected",

      reason:
        "The payment was not sent to the Walker Webs payment wallet."
    };
  }

  let actualUnits;

  try {
    actualUnits =
      BigInt(
        String(
          transfer.value || "0"
        )
      );
  } catch {
    return {
      status:
        "rejected",

      reason:
        "Invalid payment amount."
    };
  }

  const requiredUnits =
    toTokenUnits(
      expectedAmount
    );

  if (
    actualUnits <
    requiredUnits
  ) {
    return {
      status:
        "rejected",

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
      status:
        "rejected",

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
      requireFirebase();

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

      const cleanHash =
        txHash.trim();

      // Prevent duplicate transaction use.
      const existing =
        await db
          .collection("payments")
          .where(
            "txHash",
            "==",
            cleanHash
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
          cleanHash,
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
          cleanHash,

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

      return res.status(
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
      requireFirebase();

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

      if (
        payment.status ===
        "pending"
      ) {
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
        } catch (verificationError) {
          console.error(
            "PAYMENT RECHECK ERROR:",
            verificationError.message
          );

          // Don't destroy the pending payment
          // merely because TronGrid temporarily failed.
        }
      }

      const updated =
        await paymentRef.get();

      const data =
        updated.data();

      return res.json({
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

      return res.status(500).json({
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
  requireFirebase();

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

      if (!freshSnapshot.exists) {
        throw new Error(
          "Payment record does not exist."
        );
      }

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

let paymentScanRunning = false;

async function processPendingPayments() {
  if (
    paymentScanRunning
  ) {
    return;
  }

  if (
    !db ||
    !TRONGRID_API_KEY
  ) {
    return;
  }

  paymentScanRunning = true;

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
  } finally {
    paymentScanRunning = false;
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
      requireFirebase();

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

      if (html.length > 10 * 1024 * 1024) {
        return res.status(400).json({
          error:
            "Website HTML is too large."
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

      if (
        ![
          "single",
          "monthly",
          "lifetime"
        ].includes(
          subscription.type
        )
      ) {
        return res.status(402).json({
          error:
            "Invalid publishing subscription."
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

          updatedAt:
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

      return res.json({
        ok: true,

        publishId,

        url
      });

    } catch (error) {
      console.error(
        "PUBLISH ERROR:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Publishing failed."
      });
    }
  }
);

// ============================================================
// SERVE PUBLISHED WEBSITES
// ============================================================
//
// THIS IS IMPORTANT.
//
// /api/* -> API
// /p/:id -> saved website
// everything else -> frontend

app.get(
  "/p/:publishId",
  async (req, res) => {
    try {
      requireFirebase();

      const publishId =
        String(
          req.params.publishId || ""
        ).trim();

      if (
        !publishId ||
        publishId.length > 100
      ) {
        return res.status(400).send(
          "Invalid published website."
        );
      }

      const snapshot =
        await db
          .collection("published")
          .doc(publishId)
          .get();

      if (!snapshot.exists) {
        return res.status(404).send(
          "Published website not found."
        );
      }

      const data =
        snapshot.data();

      const html =
        typeof data.html === "string"
          ? data.html
          : "";

      if (!html) {
        return res.status(404).send(
          "Published website is empty."
        );
      }

      res.setHeader(
        "Content-Type",
        "text/html; charset=utf-8"
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=60"
      );

      return res.send(html);

    } catch (error) {
      console.error(
        "PUBLISHED SITE ERROR:",
        error
      );

      return res.status(500).send(
        "Could not load published website."
      );
    }
  }
);

// ============================================================
// API 404
// ============================================================
//
// This MUST come before the frontend fallback.

app.use(
  "/api",
  (req, res) => {
    return res.status(404).json({
      error:
        "API endpoint not found."
    });
  }
);

// ============================================================
// FRONTEND SPA FALLBACK
// ============================================================
//
// IMPORTANT:
//
// DO NOT use:
//
// app.get("*", ...)
//
// with newer Express versions.
//
// Instead use a final middleware and explicitly
// avoid API/published routes.

app.use(
  (req, res, next) => {
    const acceptsHtml =
      req.headers.accept &&
      req.headers.accept.includes(
        "text/html"
      );

    if (
      req.method !== "GET" &&
      req.method !== "HEAD"
    ) {
      return next();
    }

    if (
      req.path.startsWith("/api/")
    ) {
      return next();
    }

    if (
      req.path.startsWith("/p/")
    ) {
      return next();
    }

    if (!acceptsHtml) {
      return next();
    }

    return res.sendFile(
      INDEX_FILE,
      (error) => {
        if (error) {
          console.error(
            "FRONTEND SEND ERROR:",
            error
          );

          return next(error);
        }
      }
    );
  }
);

// ============================================================
// GENERAL 404
// ============================================================

app.use(
  (req, res) => {
    if (
      req.path.startsWith("/api/")
    ) {
      return res.status(404).json({
        error:
          "Not found."
      });
    }

    return res.status(404).send(
      "Page not found."
    );
  }
);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "UNHANDLED SERVER ERROR:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    if (
      req.path.startsWith("/api/")
    ) {
      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Internal server error."
      });
    }

    return res.status(
      error.status || 500
    ).send(
      "Internal server error."
    );
  }
);

// ============================================================
// START SERVER
// ============================================================

const server =
  app.listen(
    PORT,
    () => {
      console.log("");
      console.log(
        "=============================================="
      );
      console.log(
        `WALKER WEBS running on port ${PORT}`
      );
      console.log(
        `Frontend: ${PUBLIC_URL}`
      );
      console.log(
        `Health: ${PUBLIC_URL}/api/health`
      );
      console.log(
        `Payment wallet: ${TRC20_WALLET}`
      );
      console.log(
        `TRON API: ${TRONGRID_URL}`
      );
      console.log(
        `Firebase Admin: ${Boolean(db)}`
      );
      console.log(
        `Automatic payment verification: ${Boolean(
          TRONGRID_API_KEY
        )}`
      );
      console.log(
        "=============================================="
      );
      console.log("");
    }
  );

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(
  signal
) {
  console.log(
    `${signal} received. Shutting down...`
  );

  server.close(
    () => {
      console.log(
        "Server closed."
      );

      process.exit(0);
    }
  );
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

// ============================================================
// BACKGROUND PAYMENT CHECK
// ============================================================

if (
  db &&
  TRONGRID_API_KEY
) {
  setInterval(
    processPendingPayments,
    30 * 1000
  );

  setTimeout(
    processPendingPayments,
    5000
  );
}