require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();

/* ============================================================
   SERVER
============================================================ */

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";

/* ============================================================
   PLANS
============================================================ */

const PLANS = {
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
};

/* ============================================================
   TRON CONFIGURATION
============================================================ */

const TRONGRID_BASE_URL = String(
  process.env.TRONGRID_BASE_URL ||
    "https://api.trongrid.io"
)
  .trim()
  .replace(/\/+$/, "");

const TRONGRID_API_KEY = String(
  process.env.TRONGRID_API_KEY || ""
).trim();

const TRC20_WALLET = String(
  process.env.TRC20_WALLET || ""
).trim();

/*
 * USDT TRC20 contract.
 */
const USDT_TRC20_CONTRACT = String(
  process.env.USDT_TRC20_CONTRACT ||
    "TXLAQ63Xg1NAzckPwKHZzw7CSEmLMEqcdj"
).trim();

const TRON_RETRY_COUNT = Math.max(
  1,
  Math.min(
    5,
    Number(process.env.TRON_RETRY_COUNT || 3)
  )
);

const PAYMENT_SCAN_INTERVAL_MS = Math.max(
  30000,
  Number(process.env.PAYMENT_SCAN_INTERVAL_MS || 60000)
);

const PAYMENT_SCAN_LIMIT = Math.max(
  1,
  Math.min(
    100,
    Number(process.env.PAYMENT_SCAN_LIMIT || 50)
  )
);

/* ============================================================
   ENVIRONMENT
============================================================ */

const requiredEnv = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY"
];

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

const missingEnv = requiredEnv.filter(
  (key) => !String(process.env[key] || "").trim()
);

const aiConfigured = Boolean(
  process.env.GROQ_KEY
);

const tronConfigured = Boolean(
  TRONGRID_API_KEY && TRC20_WALLET
);

/* ============================================================
   FIREBASE
============================================================ */

let db = null;
let firebaseReady = false;

if (missingEnv.length === 0) {
  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:
            process.env.FIREBASE_PROJECT_ID,

          clientEmail:
            process.env.FIREBASE_CLIENT_EMAIL,

          privateKey:
            normalizePrivateKey(
              process.env.FIREBASE_PRIVATE_KEY
            )
        })
      });
    }

    db = admin.firestore();

    db.settings({
      ignoreUndefinedProperties: true
    });

    firebaseReady = true;

    console.log(
      "Firebase Admin initialized."
    );
  } catch (error) {
    firebaseReady = false;

    console.error(
      "Firebase initialization failed:",
      error.message
    );
  }
} else {
  console.warn(
    "Firebase is not configured."
  );

  console.warn(
    "Missing environment variables:",
    missingEnv.join(", ")
  );
}

/* ============================================================
   CORS
============================================================ */

/*
 * IMPORTANT:
 *
 * Do NOT use:
 *
 * app.options("*", cors());
 *
 * Express 5 can throw:
 *
 * PathError [TypeError]:
 * Missing parameter name at index 1: *
 *
 * The normal cors middleware below already handles OPTIONS.
 */

const allowedOrigins = new Set([
  "https://walker-webs.web.app",
  "https://walker-webs.firebaseapp.com",
  "https://walker-webs-ai.onrender.com",

  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
]);

function isAllowedOrigin(origin) {
  /*
   * No Origin:
   * curl, server-to-server requests, Render health checks, etc.
   */
  if (!origin) {
    return true;
  }

  /*
   * Local HTML files can send:
   *
   * Origin: null
   *
   * Allow it so the frontend does not receive:
   *
   * CORS blocked this origin: null
   */
  if (origin === "null") {
    return true;
  }

  if (allowedOrigins.has(origin)) {
    return true;
  }

  try {
    const url = new URL(origin);

    const hostname = url.hostname;

    /*
     * Firebase Hosting domains.
     */
    if (
      hostname.endsWith(".web.app") ||
      hostname.endsWith(".firebaseapp.com")
    ) {
      return true;
    }

    /*
     * Optional custom frontend URL.
     */
    const configuredFrontend =
      String(
        process.env.FRONTEND_URL || ""
      ).trim();

    if (
      configuredFrontend &&
      origin === configuredFrontend
    ) {
      return true;
    }

    return false;
  } catch (_) {
    return false;
  }
}

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      console.warn(
        "CORS blocked origin:",
        origin
      );

      return callback(
        new Error(
          "CORS blocked this origin: " +
            origin
        )
      );
    },

    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin"
    ],

    credentials: false,

    maxAge: 86400
  })
);

/* ============================================================
   BODY PARSING
============================================================ */

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);

/* ============================================================
   REQUEST LOGGING
============================================================ */

app.use(
  (req, res, next) => {
    const started = Date.now();

    res.on(
      "finish",
      () => {
        console.log(
          `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`
        );
      }
    );

    next();
  }
);

/* ============================================================
   HELPERS
============================================================ */

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeNumber(
  value,
  fallback = 0
) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function isNotFoundError(error) {
  if (!error) {
    return false;
  }

  const code = error.code;

  const message = String(
    error.message || ""
  ).toUpperCase();

  return (
    code === 5 ||
    code === "5" ||
    code === "NOT_FOUND" ||
    message.includes("5 NOT_FOUND") ||
    message.includes("NOT_FOUND")
  );
}

function isHTML(value) {
  const html = String(
    value || ""
  ).toLowerCase();

  return (
    html.includes("<!doctype html") ||
    html.includes("<html")
  );
}

function cleanAIHtml(value) {
  return String(value || "")
    .replace(
      /^\s*```html\s*/i,
      ""
    )
    .replace(
      /^\s*```\s*/i,
      ""
    )
    .replace(
      /\s*```\s*$/i,
      ""
    )
    .trim();
}

function validTxHash(txHash) {
  return /^[a-fA-F0-9]{64}$/.test(
    String(txHash || "").trim()
  );
}

/* ============================================================
   HEALTH
============================================================ */

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "walker-webs-backend",
    status: "online",
    health: "/api/health"
  });
});

app.get(
  "/api/health",
  (_req, res) => {
    res.status(200).json({
      ok: true,

      service:
        "walker-webs-backend",

      status:
        "online",

      firebase:
        firebaseReady,

      firestore:
        firebaseReady
          ? "configured"
          : "not_configured",

      groq:
        aiConfigured,

      tronVerification:
        tronConfigured,

      walletConfigured:
        Boolean(TRC20_WALLET),

      wallet:
        TRC20_WALLET
          ? "configured"
          : "missing",

      freeWebsites:
        3,

      freeEdits:
        3,

      paymentScanner:
        firebaseReady &&
        tronConfigured
          ? "enabled"
          : "disabled",

      timestamp:
        Date.now()
    });
  }
);

/* ============================================================
   AUTH
============================================================ */

async function requireAuth(
  req,
  res,
  next
) {
  try {
    if (!firebaseReady) {
      return res.status(503).json({
        error:
          "Firebase authentication is not configured."
      });
    }

    const authorization =
      String(
        req.headers.authorization ||
          ""
      );

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
        .slice(7)
        .trim();

    if (!token) {
      return res.status(401).json({
        error:
          "Authentication token is missing."
      });
    }

    req.user =
      await admin
        .auth()
        .verifyIdToken(
          token
        );

    return next();
  } catch (error) {
    console.error(
      "AUTH ERROR:",
      error.message
    );

    return res.status(401).json({
      error:
        "Invalid or expired authentication token."
    });
  }
}

/* ============================================================
   FIRESTORE USER HELPERS
============================================================ */

function userRef(uid) {
  return db
    .collection("users")
    .doc(uid);
}

async function ensureUser(
  uid,
  email
) {
  if (!firebaseReady || !db) {
    throw new Error(
      "Firestore is not configured."
    );
  }

  const ref =
    userRef(uid);

  const snap =
    await ref.get();

  if (!snap.exists) {
    await ref.set(
      {
        uid,

        email:
          email || null,

        freeWebsitesRemaining:
          3,

        freeEditsRemaining:
          3,

        publishingAccess:
          false,

        paidEditing:
          false,

        createdAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      },
      {
        merge: true
      }
    );
  }

  return ref;
}

async function getUserData(
  uid,
  email
) {
  const ref =
    await ensureUser(
      uid,
      email
    );

  const snap =
    await ref.get();

  return {
    ref,

    data:
      snap.data() || {}
  };
}

/* ============================================================
   GROQ
============================================================ */

async function groqChat(
  messages
) {
  if (!process.env.GROQ_KEY) {
    throw new Error(
      "GROQ_KEY is not configured."
    );
  }

  const response =
    await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${process.env.GROQ_KEY}`
        },

        body:
          JSON.stringify({
            model:
              process.env.GROQ_MODEL ||
              "openai/gpt-oss-120b",

            messages,

            temperature:
              0.7
          })
      }
    );

  const text =
    await response.text();

  let data = {};

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch (_) {
    data = {};
  }

  if (!response.ok) {
    console.error(
      "GROQ ERROR:",
      response.status,
      data
    );

    throw new Error(
      data?.error?.message ||
        `AI provider returned HTTP ${response.status}`
    );
  }

  const content =
    data?.choices?.[0]
      ?.message
      ?.content;

  if (!content) {
    throw new Error(
      "AI provider returned no content."
    );
  }

  return content;
}

/* ============================================================
   GENERATE
============================================================ */

app.post(
  "/api/generate",
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body?.prompt ||
            ""
        ).trim();

      if (!prompt) {
        return res.status(400).json({
          error:
            "Website prompt is required."
        });
      }

      if (prompt.length > 6000) {
        return res.status(400).json({
          error:
            "Prompt cannot exceed 6000 characters."
        });
      }

      const html =
        cleanAIHtml(
          await groqChat([
            {
              role: "system",

              content:
                "You are a professional web developer. Generate a complete standalone HTML document for the requested website. Return ONLY HTML. Include CSS and JavaScript inside the HTML. Do not use Markdown code fences."
            },

            {
              role: "user",

              content:
                prompt
            }
          ])
        );

      if (!isHTML(html)) {
        return res.status(502).json({
          error:
            "The AI returned invalid HTML."
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
          error.message ||
          "Website generation failed."
      });
    }
  }
);

/* ============================================================
   USAGE
============================================================ */

app.get(
  "/api/usage",
  requireAuth,
  async (req, res) => {
    try {
      const {
        data
      } =
        await getUserData(
          req.user.uid,
          req.user.email
        );

      return res.json({
        ok: true,

        freeWebsitesRemaining:
          safeNumber(
            data.freeWebsitesRemaining,
            3
          ),

        freeEditsRemaining:
          safeNumber(
            data.freeEditsRemaining,
            3
          ),

        publishingAccess:
          Boolean(
            data.publishingAccess
          ),

        paidEditing:
          Boolean(
            data.paidEditing
          )
      });
    } catch (error) {
      console.error(
        "USAGE ERROR:",
        error
      );

      if (
        isNotFoundError(
          error
        )
      ) {
        return res.status(503).json({
          error:
            "Firestore database is unavailable. Enable Firestore for this Firebase project."
        });
      }

      return res.status(500).json({
        error:
          "Unable to load usage."
      });
    }
  }
);

/* ============================================================
   EDIT
============================================================ */

app.post(
  "/api/edit",
  requireAuth,
  async (req, res) => {
    try {
      const html =
        String(
          req.body?.html ||
            ""
        );

      const instruction =
        String(
          req.body?.instruction ||
            ""
        ).trim();

      if (!isHTML(html)) {
        return res.status(400).json({
          error:
            "Valid HTML is required."
        });
      }

      if (!instruction) {
        return res.status(400).json({
          error:
            "Edit instruction is required."
        });
      }

      if (
        instruction.length >
        4000
      ) {
        return res.status(400).json({
          error:
            "Edit instruction is too long."
        });
      }

      const {
        ref,
        data
      } =
        await getUserData(
          req.user.uid,
          req.user.email
        );

      const freeEdits =
        safeNumber(
          data.freeEditsRemaining,
          3
        );

      const paidEditing =
        Boolean(
          data.paidEditing
        );

      if (
        freeEdits <= 0 &&
        !paidEditing
      ) {
        return res.status(402).json({
          error:
            "Payment required for additional AI edits."
        });
      }

      const edited =
        cleanAIHtml(
          await groqChat([
            {
              role: "system",

              content:
                "You are an expert web developer. Modify the supplied HTML according to the user's instruction. Preserve existing functionality unless the instruction requires a change. Return ONLY the complete HTML document, with no Markdown fences."
            },

            {
              role: "user",

              content:
                `CURRENT HTML:\n${html}\n\nUSER INSTRUCTION:\n${instruction}`
            }
          ])
        );

      if (!isHTML(edited)) {
        return res.status(502).json({
          error:
            "The AI returned invalid edited HTML."
        });
      }

      if (!paidEditing) {
        await ref.set(
          {
            freeEditsRemaining:
              Math.max(
                0,
                freeEdits - 1
              ),

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );
      }

      const after =
        await ref.get();

      const afterData =
        after.data() || {};

      return res.json({
        ok: true,

        html: edited,

        paid:
          paidEditing,

        freeWebsitesRemaining:
          safeNumber(
            afterData.freeWebsitesRemaining,
            3
          ),

        freeEditsRemaining:
          safeNumber(
            afterData.freeEditsRemaining,
            0
          )
      });
    } catch (error) {
      console.error(
        "EDIT ERROR:",
        error
      );

      if (
        isNotFoundError(
          error
        )
      ) {
        return res.status(503).json({
          error:
            "Firestore database is unavailable. Enable Firestore for this Firebase project."
        });
      }

      return res.status(500).json({
        error:
          error.message ||
          "Website editing failed."
      });
    }
  }
);

/* ============================================================
   PUBLISH
============================================================ */

app.post(
  "/api/publish",
  requireAuth,
  async (req, res) => {
    try {
      const html =
        String(
          req.body?.html ||
            ""
        );

      const prompt =
        String(
          req.body?.prompt ||
            ""
        );

      if (!isHTML(html)) {
        return res.status(400).json({
          error:
            "Valid HTML is required."
        });
      }

      const {
        ref,
        data
      } =
        await getUserData(
          req.user.uid,
          req.user.email
        );

      const freePublishes =
        safeNumber(
          data.freeWebsitesRemaining,
          3
        );

      const publishingAccess =
        Boolean(
          data.publishingAccess
        );

      if (
        freePublishes <= 0 &&
        !publishingAccess
      ) {
        return res.status(402).json({
          error:
            "Payment required for additional publishes."
        });
      }

      const siteId =
        crypto
          .randomBytes(12)
          .toString("hex");

      await db
        .collection(
          "publishedSites"
        )
        .doc(siteId)
        .set({
          siteId,

          ownerUid:
            req.user.uid,

          prompt,

          html,

          createdAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()
        });

      if (
        !publishingAccess
      ) {
        await ref.set(
          {
            freeWebsitesRemaining:
              Math.max(
                0,
                freePublishes - 1
              ),

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );
      }

      const baseURL =
        String(
          process.env.PUBLIC_BASE_URL ||
            `${req.protocol}://${req.get("host")}`
        ).replace(
          /\/+$/,
          ""
        );

      return res.json({
        ok: true,

        url:
          `${baseURL}/p/${siteId}`,

        siteId
      });
    } catch (error) {
      console.error(
        "PUBLISH ERROR:",
        error
      );

      if (
        isNotFoundError(
          error
        )
      ) {
        return res.status(503).json({
          error:
            "Firestore database is unavailable. Enable Firestore for this Firebase project."
        });
      }

      return res.status(500).json({
        error:
          error.message ||
          "Publishing failed."
      });
    }
  }
);

/* ============================================================
   PUBLIC PUBLISHED WEBSITE
============================================================ */

app.get(
  "/p/:siteId",
  async (req, res) => {
    try {
      if (!firebaseReady) {
        return res.status(503).send(
          "Publishing service unavailable."
        );
      }

      const snap =
        await db
          .collection(
            "publishedSites"
          )
          .doc(
            req.params.siteId
          )
          .get();

      if (!snap.exists) {
        return res.status(404).send(
          "Website not found."
        );
      }

      const data =
        snap.data() || {};

      const html =
        String(
          data.html || ""
        );

      if (!isHTML(html)) {
        return res.status(500).send(
          "Published website is invalid."
        );
      }

      res.setHeader(
        "Content-Type",
        "text/html; charset=utf-8"
      );

      res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
      );

      return res.send(html);
    } catch (error) {
      console.error(
        "PUBLIC SITE ERROR:",
        error
      );

      return res.status(500).send(
        "Unable to load published website."
      );
    }
  }
);

/* ============================================================
   TRON HELPERS
============================================================ */

async function tronFetch(
  path
) {
  if (!tronConfigured) {
    throw new Error(
      "TRON verification is not configured."
    );
  }

  const url =
    `${TRONGRID_BASE_URL}${path}`;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= TRON_RETRY_COUNT;
    attempt++
  ) {
    try {
      const response =
        await fetch(
          url,
          {
            method: "GET",

            headers: {
              Accept:
                "application/json",

              "TRON-PRO-API-KEY":
                TRONGRID_API_KEY
            },

            signal:
              AbortSignal.timeout(
                20000
              )
          }
        );

      const text =
        await response.text();

      let data = {};

      try {
        data =
          text
            ? JSON.parse(text)
            : {};
      } catch (_) {
        data = {};
      }

      if (!response.ok) {
        throw new Error(
          `TRON API HTTP ${response.status}: ${
            data?.error ||
            data?.message ||
            text ||
            "Unknown error"
          }`
        );
      }

      return data;
    } catch (error) {
      lastError =
        error;

      console.error(
        `TRON API attempt ${attempt}/${TRON_RETRY_COUNT} failed:`,
        error.message
      );

      if (
        attempt <
        TRON_RETRY_COUNT
      ) {
        await sleep(
          attempt * 1000
        );
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "TRON API request failed."
    )
  );
}

/* ============================================================
   TRON PAYMENT VERIFICATION
============================================================ */

function normalizeTronAmount(
  value
) {
  return (
    Number(value) /
    1000000
  );
}

function amountsMatch(
  actual,
  expected
) {
  return (
    Math.abs(
      Number(actual) -
        Number(expected)
    ) < 0.000001
  );
}

async function verifyTronPayment(
  payment
) {
  const txHash =
    String(
      payment.txHash || ""
    ).trim();

  if (!validTxHash(txHash)) {
    return {
      status: "rejected",

      reason:
        "Invalid TRON transaction hash."
    };
  }

  const expectedPlan =
    PLANS[
      String(
        payment.type || ""
      )
    ];

  if (!expectedPlan) {
    return {
      status: "rejected",

      reason:
        "Invalid payment plan."
    };
  }

  const expectedAmount =
    safeNumber(
      payment.amount,
      expectedPlan.amount
    );

  if (
    expectedAmount !==
    expectedPlan.amount
  ) {
    return {
      status: "rejected",

      reason:
        "Payment amount does not match the selected plan."
    };
  }

  const wallet =
    String(
      TRC20_WALLET
    ).trim();

  const contract =
    encodeURIComponent(
      USDT_TRC20_CONTRACT
    );

  /*
   * We search transfers received by our
   * configured wallet.
   *
   * This avoids depending on a Firestore
   * document existing for the transaction.
   */
  const account =
    encodeURIComponent(
      wallet
    );

  const path =
    `/v1/accounts/${account}/transactions/trc20` +
    `?only_confirmed=true` +
    `&limit=200` +
    `&contract_address=${contract}`;

  let data;

  try {
    data =
      await tronFetch(
        path
      );
  } catch (error) {
    /*
     * A TRON NOT_FOUND response should NOT
     * crash the scanner.
     */
    if (
      isNotFoundError(
        error
      )
    ) {
      return {
        status: "pending",

        reason:
          "TRON transaction has not been found yet."
      };
    }

    throw error;
  }

  const transfers =
    Array.isArray(
      data?.data
    )
      ? data.data
      : [];

  /*
   * Find the exact transaction.
   */
  const matching =
    transfers.find(
      (transfer) =>
        String(
          transfer.transaction_id ||
            ""
        ).toLowerCase() ===
        txHash.toLowerCase()
    );

  if (!matching) {
    return {
      status: "pending",

      reason:
        "Transaction has not appeared on the confirmed TRON USDT transfer list yet."
    };
  }

  /*
   * Confirm destination wallet.
   */
  const to =
    String(
      matching.to || ""
    ).trim();

  if (
    to !== wallet
  ) {
    return {
      status: "rejected",

      reason:
        "Transaction was not sent to the configured payment wallet."
    };
  }

  /*
   * Confirm USDT contract.
   */
  const tokenAddress =
    String(
      matching.token_info?.address ||
        matching.contract_address ||
        ""
    ).trim();

  if (
    tokenAddress &&
    tokenAddress !==
      USDT_TRC20_CONTRACT
  ) {
    return {
      status: "rejected",

      reason:
        "Transaction token is not the configured USDT TRC20 token."
    };
  }

  const actualAmount =
    normalizeTronAmount(
      matching.value
    );

  if (
    !amountsMatch(
      actualAmount,
      expectedAmount
    )
  ) {
    return {
      status: "rejected",

      reason:
        `Incorrect payment amount. Expected ${expectedAmount} USDT but received ${actualAmount} USDT.`
    };
  }

  return {
    status: "confirmed",

    amount:
      actualAmount,

    from:
      matching.from || null,

    to:
      matching.to || null,

    txHash
  };
}

/* ============================================================
   GRANT PAYMENT ACCESS
============================================================ */

async function grantPaymentAccess(
  payment
) {
  if (
    !firebaseReady ||
    !db
  ) {
    return;
  }

  const uid =
    payment.uid;

  if (!uid) {
    return;
  }

  const ref =
    userRef(uid);

  const snap =
    await ref.get();

  const user =
    snap.data() || {};

  const type =
    String(
      payment.type || ""
    );

  const update = {
    updatedAt:
      admin.firestore
        .FieldValue
        .serverTimestamp(),

    lastPaymentId:
      payment.paymentId || null,

    lastPaymentTxHash:
      payment.txHash || null
  };

  if (
    type === "single"
  ) {
    update.freeWebsitesRemaining =
      safeNumber(
        user.freeWebsitesRemaining,
        0
      ) + 1;

    update.freeEditsRemaining =
      safeNumber(
        user.freeEditsRemaining,
        0
      ) + 1;
  }

  if (
    type === "monthly"
  ) {
    update.publishingAccess =
      true;

    update.paidEditing =
      true;

    update.subscription =
      "monthly";
  }

  if (
    type === "lifetime"
  ) {
    update.publishingAccess =
      true;

    update.paidEditing =
      true;

    update.subscription =
      "lifetime";
  }

  await ref.set(
    update,
    {
      merge: true
    }
  );
}

/* ============================================================
   PAYMENT SUBMISSION
============================================================ */

app.post(
  "/api/payments/submit",
  requireAuth,
  async (req, res) => {
    try {
      if (
        !firebaseReady ||
        !db
      ) {
        return res.status(503).json({
          error:
            "Firestore is not configured."
        });
      }

      const type =
        String(
          req.body?.type ||
            ""
        ).trim();

      const txHash =
        String(
          req.body?.txHash ||
            ""
        ).trim();

      const amount =
        Number(
          req.body?.amount
        );

      if (
        !PLANS[type]
      ) {
        return res.status(400).json({
          error:
            "Invalid payment plan."
        });
      }

      if (
        !Number.isFinite(
          amount
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid payment amount."
        });
      }

      /*
       * Do not allow the frontend to choose
       * an arbitrary amount.
       */
      if (
        amount !==
        PLANS[type].amount
      ) {
        return res.status(400).json({
          error:
            `Incorrect amount for ${type} plan. Expected ${PLANS[type].amount} USDT.`
        });
      }

      if (
        !validTxHash(
          txHash
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid TRON transaction hash."
        });
      }

      /*
       * Prevent duplicate submissions.
       */
      const existing =
        await db
          .collection(
            "payments"
          )
          .where(
            "txHash",
            "==",
            txHash
          )
          .limit(1)
          .get();

      if (
        !existing.empty
      ) {
        return res.status(409).json({
          error:
            "This transaction has already been submitted."
        });
      }

      const paymentRef =
        db
          .collection(
            "payments"
          )
          .doc();

      await paymentRef.set({
        paymentId:
          paymentRef.id,

        uid:
          req.user.uid,

        email:
          req.user.email ||
          null,

        amount,

        type,

        txHash,

        status:
          "pending",

        verificationAttempts:
          0,

        createdAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      });

      /*
       * Try verification immediately.
       *
       * If TRON has not indexed the transaction yet,
       * leave it pending for the background scanner.
       */
      let verification;

      try {
        verification =
          await verifyTronPayment({
            amount,
            type,
            txHash
          });
      } catch (verificationError) {
        console.error(
          "IMMEDIATE PAYMENT VERIFICATION ERROR:",
          verificationError
        );

        verification = {
          status: "pending",

          reason:
            "Payment submitted. Blockchain verification is pending."
        };
      }

      if (
        verification.status ===
        "confirmed"
      ) {
        await paymentRef.set(
          {
            status:
              "confirmed",

            verifiedAmount:
              verification.amount,

            from:
              verification.from,

            to:
              verification.to,

            verifiedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );

        await grantPaymentAccess({
          paymentId:
            paymentRef.id,

          uid:
            req.user.uid,

          email:
            req.user.email ||
            null,

          amount,

          type,

          txHash
        });

        return res.status(200).json({
          ok: true,

          paymentId:
            paymentRef.id,

          status:
            "confirmed",

          message:
            "Payment verified successfully."
        });
      }

      if (
        verification.status ===
        "rejected"
      ) {
        await paymentRef.set(
          {
            status:
              "rejected",

            reason:
              verification.reason,

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );

        return res.status(400).json({
          error:
            verification.reason ||
            "Payment could not be verified.",

          paymentId:
            paymentRef.id,

          status:
            "rejected"
        });
      }

      return res.status(202).json({
        ok: true,

        paymentId:
          paymentRef.id,

        status:
          "pending",

        message:
          "Payment submitted. It will be verified automatically once the TRON transaction is available."
      });
    } catch (error) {
      console.error(
        "PAYMENT SUBMIT ERROR:",
        error
      );

      if (
        isNotFoundError(
          error
        )
      ) {
        return res.status(503).json({
          error:
            "Firestore is unavailable. Make sure Firestore Database is enabled for the Firebase project."
        });
      }

      return res.status(500).json({
        error:
          error.message ||
          "Unable to submit payment."
      });
    }
  }
);

/* ============================================================
   PAYMENT STATUS
============================================================ */

app.get(
  "/api/payments/:paymentId",
  requireAuth,
  async (req, res) => {
    try {
      if (
        !firebaseReady ||
        !db
      ) {
        return res.status(503).json({
          error:
            "Firestore is not configured."
        });
      }

      const snap =
        await db
          .collection(
            "payments"
          )
          .doc(
            req.params.paymentId
          )
          .get();

      if (!snap.exists) {
        return res.status(404).json({
          error:
            "Payment not found."
        });
      }

      const payment =
        snap.data();

      if (
        payment.uid !==
        req.user.uid
      ) {
        return res.status(403).json({
          error:
            "You cannot access this payment."
        });
      }

      return res.json({
        ok: true,

        paymentId:
          payment.paymentId ||
          snap.id,

        status:
          payment.status ||
          "pending",

        reason:
          payment.reason ||
          payment.lastVerificationMessage ||
          null
      });
    } catch (error) {
      console.error(
        "PAYMENT STATUS ERROR:",
        error
      );

      if (
        isNotFoundError(
          error
        )
      ) {
        return res.status(503).json({
          error:
            "Firestore is unavailable."
        });
      }

      return res.status(500).json({
        error:
          "Unable to check payment status."
      });
    }
  }
);

/* ============================================================
   PAYMENT SCANNER
============================================================ */

let scannerRunning = false;
let scannerTimer = null;
let scannerBackoff = 0;

async function scanPendingPayments() {
  /*
   * Never allow two scanner cycles to run
   * simultaneously.
   */
  if (scannerRunning) {
    return;
  }

  if (
    !firebaseReady ||
    !db ||
    !tronConfigured
  ) {
    return;
  }

  scannerRunning = true;

  try {
    /*
     * If Firestore previously returned NOT_FOUND,
     * wait before retrying.
     */
    if (
      scannerBackoff >
      0
    ) {
      await sleep(
        scannerBackoff
      );
    }

    let snapshot;

    try {
      snapshot =
        await db
          .collection(
            "payments"
          )
          .where(
            "status",
            "==",
            "pending"
          )
          .limit(
            PAYMENT_SCAN_LIMIT
          )
          .get();
    } catch (error) {
      /*
       * THIS IS THE IMPORTANT PART.
       *
       * Firestore code 5 / NOT_FOUND must
       * NOT kill Render.
       */
      if (
        isNotFoundError(
          error
        )
      ) {
        scannerBackoff =
          Math.min(
            scannerBackoff
              ? scannerBackoff * 2
              : 30000,
            300000
          );

        console.warn(
          `PAYMENT SCANNER: Firestore returned NOT_FOUND (code 5). Scanner paused temporarily. Retry backoff: ${Math.round(scannerBackoff / 1000)} seconds.`
        );

        return;
      }

      throw error;
    }

    /*
     * Firestore recovered.
     */
    scannerBackoff = 0;

    if (
      snapshot.empty
    ) {
      return;
    }

    console.log(
      `PAYMENT SCANNER: checking ${snapshot.size} pending payment(s).`
    );

    for (
      const doc of
        snapshot.docs
    ) {
      const payment =
        doc.data() || {};

      const paymentId =
        payment.paymentId ||
        doc.id;

      try {
        if (
          !payment.uid ||
          !payment.txHash ||
          !payment.type ||
          !payment.amount
        ) {
          await doc.ref.set(
            {
              status:
                "rejected",

              reason:
                "Malformed payment record.",

              updatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp()
            },
            {
              merge: true
            }
          );

          continue;
        }

        const verification =
          await verifyTronPayment(
            payment
          );

        if (
          verification.status ===
          "confirmed"
        ) {
          /*
           * Re-read before granting access.
           */
          const fresh =
            await doc.ref.get();

          if (
            !fresh.exists
          ) {
            continue;
          }

          const freshPayment =
            fresh.data() || {};

          /*
           * Already processed.
           */
          if (
            freshPayment.status ===
            "confirmed"
          ) {
            continue;
          }

          await doc.ref.set(
            {
              status:
                "confirmed",

              verifiedAmount:
                verification.amount,

              from:
                verification.from,

              to:
                verification.to,

              verifiedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              updatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp()
            },
            {
              merge: true
            }
          );

          await grantPaymentAccess({
            ...freshPayment,

            paymentId,

            uid:
              freshPayment.uid,

            email:
              freshPayment.email,

            amount:
              freshPayment.amount,

            type:
              freshPayment.type,

            txHash:
              freshPayment.txHash
          });

          console.log(
            `PAYMENT CONFIRMED: ${paymentId}`
          );

          continue;
        }

        if (
          verification.status ===
          "rejected"
        ) {
          await doc.ref.set(
            {
              status:
                "rejected",

              reason:
                verification.reason ||
                "Payment rejected.",

              updatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp()
            },
            {
              merge: true
            }
          );

          continue;
        }

        /*
         * Pending.
         */
        await doc.ref.set(
          {
            verificationAttempts:
              safeNumber(
                payment.verificationAttempts,
                0
              ) + 1,

            lastVerificationMessage:
              verification.reason ||
              "Payment not found yet.",

            lastCheckedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );
      } catch (paymentError) {
        /*
         * A single payment must never stop
         * the entire scanner.
         */
        console.error(
          `PAYMENT SCAN ERROR for ${paymentId}:`,
          paymentError.message
        );

        if (
          isNotFoundError(
            paymentError
          )
        ) {
          console.warn(
            `PAYMENT ${paymentId}: resource returned NOT_FOUND. Leaving payment pending.`
          );

          continue;
        }

        try {
          await doc.ref.set(
            {
              lastVerificationError:
                String(
                  paymentError.message ||
                    paymentError
                ).slice(
                  0,
                  1000
                ),

              lastCheckedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp()
            },
            {
              merge: true
            }
          );
        } catch (
          updateError
        ) {
          /*
           * Do nothing else.
           * The scanner must continue.
           */
          console.error(
            "Unable to update payment scanner error:",
            updateError.message
          );
        }
      }
    }
  } catch (error) {
    /*
     * ABSOLUTE TOP-LEVEL PROTECTION.
     *
     * The payment scanner can never
     * crash the HTTP server.
     */
    if (
      isNotFoundError(
        error
      )
    ) {
      console.warn(
        "PAYMENT SCANNER: Firestore returned code 5 NOT_FOUND. Scanner remains alive."
      );
    } else {
      console.error(
        "PAYMENT SCANNER ERROR:",
        error
      );
    }
  } finally {
    scannerRunning = false;
  }
}

/* ============================================================
   START PAYMENT SCANNER
============================================================ */

function startPaymentScanner() {
  if (
    !firebaseReady ||
    !db ||
    !tronConfigured
  ) {
    console.warn(
      "Payment scanner disabled:",
      {
        firebaseReady,
        tronConfigured,
        walletConfigured:
          Boolean(
            TRC20_WALLET
          )
      }
    );

    return;
  }

  console.log(
    "Payment scanner enabled."
  );

  console.log(
    `Payment scanner interval: ${PAYMENT_SCAN_INTERVAL_MS}ms`
  );

  /*
   * Initial scan.
   */
  setTimeout(
    () => {
      scanPendingPayments()
        .catch(
          (error) => {
            console.error(
              "INITIAL PAYMENT SCAN ERROR:",
              error
            );
          }
        );
    },
    5000
  );

  scannerTimer =
    setInterval(
      () => {
        scanPendingPayments()
          .catch(
            (error) => {
              /*
               * Final protection.
               */
              console.error(
                "PAYMENT SCANNER LOOP ERROR:",
                error
              );
            }
          );
      },
      PAYMENT_SCAN_INTERVAL_MS
    );
}

/* ============================================================
   404
============================================================ */

app.use(
  (req, res) => {
    res.status(404).json({
      error:
        "Route not found.",

      method:
        req.method,

      path:
        req.originalUrl
    });
  }
);

/* ============================================================
   ERROR HANDLER
============================================================ */

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      "UNHANDLED ERROR:",
      error
    );

    if (
      String(
        error.message || ""
      ).startsWith(
        "CORS blocked"
      )
    ) {
      return res.status(403).json({
        error:
          "This website origin is not allowed by the API."
      });
    }

    if (
      isNotFoundError(
        error
      )
    ) {
      return res.status(503).json({
        error:
          "A required backend resource was not found."
      });
    }

    return res.status(500).json({
      error:
        "Internal server error."
    });
  }
);

/* ============================================================
   PROCESS SAFETY
============================================================ */

/*
 * Background Promise protection.
 */
process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "UNHANDLED PROMISE REJECTION:",
      reason
    );
  }
);

/*
 * Do not intentionally terminate Render
 * because of a background exception.
 */
process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

/* ============================================================
   START
============================================================ */

const server =
  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        "========================================"
      );

      console.log(
        "Walker Webs API"
      );

      console.log(
        `Listening on ${HOST}:${PORT}`
      );

      console.log(
        `Health: /api/health`
      );

      console.log(
        `Firebase: ${
          firebaseReady
            ? "READY"
            : "NOT READY"
        }`
      );

      console.log(
        `Groq: ${
          aiConfigured
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        }`
      );

      console.log(
        `TRON: ${
          tronConfigured
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        }`
      );

      console.log(
        `Wallet: ${
          TRC20_WALLET
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        }`
      );

      console.log(
        `Payment scanner: ${
          firebaseReady &&
          tronConfigured
            ? "ENABLED"
            : "DISABLED"
        }`
      );

      console.log(
        "========================================"
      );

      /*
       * Start scanner only after
       * HTTP server is listening.
       */
      startPaymentScanner();
    }
  );

/*
 * Keep reference to server so shutdown
 * can be handled cleanly.
 */
server.on(
  "error",
  (error) => {
    console.error(
      "HTTP SERVER ERROR:",
      error
    );
  }
);