require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";

/* ============================================================
   CONFIGURATION
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

/*
 * Official TRON USDT contract.
 */
const USDT_TRC20_CONTRACT =
  String(
    process.env.USDT_TRC20_CONTRACT ||
      "TXLAQ63Xg1NAzckPwKHZzw7CSEmLMEqcdj"
  ).trim();

/*
 * TRON Grid base URL.
 */
const TRONGRID_BASE_URL =
  String(
    process.env.TRONGRID_BASE_URL ||
      "https://api.trongrid.io"
  )
    .trim()
    .replace(/\/+$/, "");

/*
 * How often the payment scanner runs.
 */
const PAYMENT_SCAN_INTERVAL_MS = Math.max(
  15000,
  Number(process.env.PAYMENT_SCAN_INTERVAL_MS || 30000)
);

/*
 * Maximum pending payments checked during one scan.
 */
const PAYMENT_SCAN_LIMIT = Math.max(
  1,
  Math.min(
    200,
    Number(process.env.PAYMENT_SCAN_LIMIT || 50)
  )
);

/*
 * Maximum number of TRON API retries.
 */
const TRON_RETRY_COUNT = Math.max(
  1,
  Math.min(
    5,
    Number(process.env.TRON_RETRY_COUNT || 3)
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

function missingRequiredEnv() {
  return requiredEnv.filter(
    (key) =>
      !String(process.env[key] || "").trim()
  );
}

const missing = missingRequiredEnv();

const firebaseConfigured =
  missing.length === 0;

const tronConfigured =
  Boolean(
    process.env.TRONGRID_API_KEY &&
    process.env.TRC20_WALLET
  );

const aiConfigured =
  Boolean(process.env.GROQ_KEY);


/* ============================================================
   FIREBASE ADMIN
============================================================ */

let db = null;
let firebaseReady = false;

if (firebaseConfigured) {
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

    /*
     * Firestore gRPC retry settings.
     */
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
      error
    );
  }
} else {
  console.warn(
    "Firebase Admin is not initialized."
  );

  console.warn(
    "Missing:",
    missing.join(", ")
  );
}


/* ============================================================
   CORS
============================================================ */

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
  if (!origin) return true;

  if (allowedOrigins.has(origin)) return true;

  try {
    const url = new URL(origin);
    const hostname = url.hostname;

    if (
      hostname.endsWith(".web.app") ||
      hostname.endsWith(".firebaseapp.com")
    ) {
      return true;
    }
  } catch (_) {
    return false;
  }

  /*
   * Allow an explicitly configured frontend origin. This is useful
   * when Walker Webs is later moved to a custom domain.
   */
  const configuredFrontend = String(
    process.env.FRONTEND_URL || ""
  ).trim().replace(/\/+$/, "");

  if (configuredFrontend && origin === configuredFrontend) {
    return true;
  }

  return false;
}

/*
 * CORS is handled here for every request, including browser OPTIONS
 * preflight requests. Do NOT add app.options("*", ...) because newer
 * Express/router versions reject the wildcard route.
 */
app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      console.warn("CORS blocked origin:", origin);
      return callback(null, false);
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
    maxAge: 86400,
    optionsSuccessStatus: 204
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
    const started =
      Date.now();

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
   GENERAL HELPERS
============================================================ */

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function isNotFoundError(error) {
  if (!error) {
    return false;
  }

  const code =
    error.code;

  const message =
    String(
      error.message || ""
    ).toUpperCase();

  return (
    code === 5 ||
    code === "5" ||
    code === "NOT_FOUND" ||
    message.includes(
      "5 NOT_FOUND"
    ) ||
    message.includes(
      "NOT_FOUND"
    )
  );
}

function isFirestoreError(error) {
  if (!error) {
    return false;
  }

  return (
    typeof error.code ===
      "number" ||
    typeof error.code ===
      "string"
  );
}

function safeNumber(value, fallback = 0) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function validTxHash(txHash) {
  return /^[a-fA-F0-9]{64}$/.test(
    String(txHash || "").trim()
  );
}

function isHTML(value) {
  const lower =
    String(value || "")
      .toLowerCase();

  return (
    lower.includes(
      "<!doctype html"
    ) ||
    lower.includes("<html")
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


/* ============================================================
   HEALTH
============================================================ */

app.get(
  "/",
  (_req, res) => {
    res.json({
      ok: true,
      service:
        "walker-webs-backend",
      status: "online",
      health:
        "/api/health"
    });
  }
);

app.get(
  "/api/health",
  async (_req, res) => {
    let firestoreStatus =
      firebaseReady
        ? "configured"
        : "not_configured";

    /*
     * We don't make health depend on Firestore being readable.
     * This prevents Render health checks from failing simply
     * because Firestore is temporarily unavailable.
     */
    res.status(200).json({
      ok: true,

      service:
        "walker-webs-backend",

      status:
        "online",

      firebase:
        firebaseReady,

      firestore:
        firestoreStatus,

      groq:
        aiConfigured,

      tronVerification:
        tronConfigured,

      walletConfigured:
        Boolean(
          process.env.TRC20_WALLET
        ),

      wallet:
        process.env.TRC20_WALLET
          ? "configured"
          : "missing",

      freeWebsites:
        3,

      freeEdits:
        3,

      paymentScanner:
        tronConfigured &&
        firebaseReady
          ? "enabled"
          : "disabled",

      timestamp:
        Date.now()
    });
  }
);


/* ============================================================
   FIREBASE AUTH
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
          "Authentication service is not configured on the backend."
      });
    }

    const header =
      String(
        req.headers.authorization ||
          ""
      );

    if (
      !header.startsWith(
        "Bearer "
      )
    ) {
      return res.status(401).json({
        error:
          "Authentication required."
      });
    }

    const token =
      header
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
      error
    );

    return res.status(401).json({
      error:
        "Invalid or expired authentication token."
    });
  }
}


/* ============================================================
   FIRESTORE HELPERS
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
  if (!firebaseReady) {
    throw new Error(
      "Firebase is not configured."
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
   AI / GROQ
============================================================ */

async function groqChat(
  messages
) {
  if (!process.env.GROQ_KEY) {
    throw new Error(
      "GROQ_KEY is not configured on the backend."
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
              "llama-3.3-70b-versatile",

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
   GENERATE WEBSITE
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
              role:
                "system",

              content:
                "You are a professional web developer. Generate a complete standalone HTML document for the requested website. Return ONLY HTML. Include CSS and JavaScript inside the HTML. Do not use Markdown code fences."
            },

            {
              role:
                "user",

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
      const { data } =
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
            "Firestore database is unavailable or has not been created yet."
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
   EDIT WEBSITE
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

      const { ref, data } =
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
              role:
                "system",

              content:
                "You are an expert web developer. Modify the supplied HTML according to the user's instruction. Preserve existing functionality unless the instruction requires a change. Return ONLY the complete HTML document, with no Markdown fences."
            },

            {
              role:
                "user",

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
            "Firestore database is unavailable or has not been created yet."
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

      const { ref, data } =
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
            "Firestore database is unavailable or has not been created yet."
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
   TRON API HELPER
============================================================ */

async function tronFetch(
  path,
  options = {}
) {
  if (!tronConfigured) {
    throw new Error(
      "TRON verification is not configured."
    );
  }

  const url =
    `${TRONGRID_BASE_URL}${path}`;

  let lastError =
    null;

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
            method:
              options.method ||
              "GET",

            headers: {
              Accept:
                "application/json",

              "TRON-PRO-API-KEY":
                process.env
                  .TRONGRID_API_KEY,

              ...(options.headers ||
                {})
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
          1000 * attempt
        );
      }
    }
  }

  throw lastError ||
    new Error(
      "TRON API request failed."
    );
}


/* ============================================================
   TRON PAYMENT VERIFICATION
============================================================ */

function normalizeTronAmount(
  value
) {
  /*
   * USDT uses 6 decimals.
   */
  return (
    Number(value) /
    1000000
  );
}

function amountsMatch(
  actual,
  expected
) {
  /*
   * Small tolerance for decimal
   * conversion.
   */
  return (
    Math.abs(
      Number(actual) -
        Number(expected)
    ) < 0.000001
  );
}

async function getTrc20TransfersForTx(
  txHash
) {
  const contract =
    encodeURIComponent(
      USDT_TRC20_CONTRACT
    );

  const path =
    `/v1/transactions/${encodeURIComponent(
      txHash
    )}/internal-transactions`;

  /*
   * This endpoint is not sufficient for TRC20 transfers
   * on all Grid versions, so we use the account transfer
   * endpoint below as the primary verifier.
   */

  const wallet =
    encodeURIComponent(
      String(
        process.env.TRC20_WALLET
      ).trim()
    );

  const accountPath =
    `/v1/accounts/${wallet}/transactions/trc20?only_confirmed=true&limit=200&contract_address=${contract}`;

  const data =
    await tronFetch(
      accountPath
    );

  return Array.isArray(
    data?.data
  )
    ? data.data
    : [];
}

async function verifyTronPayment(
  payment
) {
  const expectedWallet =
    String(
      process.env.TRC20_WALLET ||
        ""
    ).trim();

  if (!expectedWallet) {
    return {
      ok: false,
      status:
        "rejected",
      reason:
        "TRC20_WALLET is not configured."
    };
  }

  if (!validTxHash(payment.txHash)) {
    return {
      ok: false,
      status:
        "rejected",
      reason:
        "Invalid transaction hash."
    };
  }

  const transfers =
    await getTrc20TransfersForTx(
      payment.txHash
    );

  /*
   * Find a confirmed USDT transfer with:
   *
   * - matching transaction
   * - destination = our wallet
   * - USDT contract = official contract
   * - amount >= requested amount
   */
  const match =
    transfers.find(
      (transfer) => {
        const transferTx =
          String(
            transfer.transaction_id ||
              transfer.txID ||
              transfer.txid ||
              ""
          ).toLowerCase();

        const toAddress =
          String(
            transfer.to ||
              transfer.to_address ||
              ""
          ).trim();

        const tokenAddress =
          String(
            transfer.token_info?.address ||
              transfer.contract_address ||
              ""
          ).trim();

        const actualAmount =
          normalizeTronAmount(
            transfer.value
          );

        const sameTx =
          transferTx ===
          payment.txHash.toLowerCase();

        const sameWallet =
          toAddress ===
          expectedWallet;

        const sameToken =
          !tokenAddress ||
          tokenAddress ===
            USDT_TRC20_CONTRACT;

        const sufficientAmount =
          amountsMatch(
            actualAmount,
            payment.amount
          ) ||
          actualAmount >
            Number(payment.amount);

        return (
          sameTx &&
          sameWallet &&
          sameToken &&
          sufficientAmount
        );
      }
    );

  if (!match) {
    return {
      ok: false,
      status:
        "pending",
      reason:
        "No matching confirmed USDT TRC20 transfer was found yet."
    };
  }

  const actualAmount =
    normalizeTronAmount(
      match.value
    );

  return {
    ok: true,

    status:
      "confirmed",

    amount:
      actualAmount,

    from:
      match.from ||
      null,

    to:
      match.to ||
      expectedWallet,

    txHash:
      payment.txHash
  };
}


/* ============================================================
   PAYMENT ACCESS GRANT
============================================================ */

async function grantPaymentAccess(
  payment
) {
  if (!firebaseReady) {
    throw new Error(
      "Firebase is not available."
    );
  }

  const ref =
    userRef(
      payment.uid
    );

  const snap =
    await ref.get();

  if (!snap.exists) {
    await ref.set(
      {
        uid:
          payment.uid,

        email:
          payment.email ||
          null,

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
            .serverTimestamp()
      },
      {
        merge: true
      }
    );
  }

  const update = {
    updatedAt:
      admin.firestore
        .FieldValue
        .serverTimestamp(),

    lastPaymentId:
      payment.paymentId,

    lastPaymentTxHash:
      payment.txHash,

    lastPaymentAmount:
      payment.amount,

    lastPaymentType:
      payment.type,

    lastPaymentAt:
      admin.firestore
        .FieldValue
        .serverTimestamp()
  };

  /*
   * Single:
   *
   * Give one publishing credit and one editing credit.
   */
  if (
    payment.type ===
    "single"
  ) {
    update.publishingAccess =
      true;

    update.paidEditing =
      true;
  }

  /*
   * Monthly:
   *
   * Enable access.
   *
   * Store expiry if configured.
   */
  if (
    payment.type ===
    "monthly"
  ) {
    update.publishingAccess =
      true;

    update.paidEditing =
      true;

    update.subscriptionType =
      "monthly";

    update.subscriptionExpiresAt =
      admin.firestore.Timestamp.fromDate(
        new Date(
          Date.now() +
            30 *
              24 *
              60 *
              60 *
              1000
        )
      );
  }

  /*
   * Lifetime:
   */
  if (
    payment.type ===
    "lifetime"
  ) {
    update.publishingAccess =
      true;

    update.paidEditing =
      true;

    update.subscriptionType =
      "lifetime";

    update.subscriptionExpiresAt =
      null;
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
      const amount =
        Number(
          req.body?.amount
        );

      const type =
        String(
          req.body?.type ||
            ""
        );

      const txHash =
        String(
          req.body?.txHash ||
            ""
        ).trim();

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid payment amount."
        });
      }

      if (
        !PLANS[type]
      ) {
        return res.status(400).json({
          error:
            "Invalid payment plan."
        });
      }

      /*
       * Do not trust amount supplied by frontend.
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

      if (!firebaseReady) {
        return res.status(503).json({
          error:
            "Payment database is not configured."
        });
      }

      /*
       * Check whether transaction was already submitted.
       *
       * IMPORTANT:
       * A missing Firestore database should not crash Node.
       */
      let existing;

      try {
        existing =
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
      } catch (error) {
        console.error(
          "PAYMENT DUPLICATE CHECK ERROR:",
          error
        );

        if (
          isNotFoundError(
            error
          )
        ) {
          return res.status(503).json({
            error:
              "Firestore returned NOT_FOUND. Make sure the Firestore database exists in the Firebase project."
          });
        }

        throw error;
      }

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
       * Try immediately.
       *
       * The background scanner will continue if it is
       * not confirmed yet.
       */
      try {
        const payment =
          {
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
          };

        const verification =
          await verifyTronPayment(
            payment
          );

        if (
          verification.status ===
          "confirmed"
        ) {
          await paymentRef.set(
            {
              status:
                "confirmed",

              verifiedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              verifiedAmount:
                verification.amount,

              from:
                verification.from,

              to:
                verification.to,

              updatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp()
            },
            {
              merge: true
            }
          );

          await grantPaymentAccess(
            payment
          );

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
      } catch (scanError) {
        /*
         * Never reject the payment submission just because the
         * immediate scanner had a temporary error.
         */
        console.error(
          "IMMEDIATE PAYMENT VERIFICATION WARNING:",
          scanError
        );
      }

      return res.status(202).json({
        ok: true,

        paymentId:
          paymentRef.id,

        status:
          "pending",

        message:
          "Payment submitted and is awaiting blockchain verification."
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
            "Firestore returned NOT_FOUND. Check that Firestore Database is enabled for this Firebase project."
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
      if (!firebaseReady) {
        return res.status(503).json({
          error:
            "Payment database is not configured."
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
          payment.paymentId,

        status:
          payment.status ||
          "pending",

        reason:
          payment.reason ||
          null,

        amount:
          payment.amount ||
          null,

        type:
          payment.type ||
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
            "Firestore database is currently unavailable."
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

let scannerRunning =
  false;

let scannerTimer =
  null;

let scannerBackoff =
  0;

async function scanPendingPayments() {
  if (scannerRunning) {
    return;
  }

  if (
    !firebaseReady ||
    !tronConfigured
  ) {
    return;
  }

  scannerRunning =
    true;

  try {
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
       * THIS is the important hardening for:
       *
       * PAYMENT SCAN ERROR: 5 NOT_FOUND
       *
       * Do not allow it to terminate the Node process.
       */
      if (
        isNotFoundError(
          error
        )
      ) {
        scannerBackoff =
          Math.min(
            scannerBackoff +
              1,
            6
          );

        const retrySeconds =
          Math.min(
            300,
            15 *
              Math.pow(
                2,
                scannerBackoff -
                  1
              )
          );

        console.error(
          `PAYMENT SCAN: Firestore returned NOT_FOUND (code 5). Scanner paused for ${retrySeconds}s.`
        );

        console.error(
          "Make sure Firestore Database is enabled in Firebase Console for project:",
          process.env.FIREBASE_PROJECT_ID
        );

        return;
      }

      throw error;
    }

    /*
     * Successful Firestore query resets backoff.
     */
    scannerBackoff =
      0;

    if (
      snapshot.empty
    ) {
      return;
    }

    console.log(
      `PAYMENT SCAN: checking ${snapshot.size} pending payment(s).`
    );

    for (
      const doc of
        snapshot.docs
    ) {
      const payment =
        doc.data();

      const paymentId =
        payment.paymentId ||
        doc.id;

      try {
        /*
         * Prevent malformed documents from breaking scanner.
         */
        if (
          !payment.uid ||
          !payment.txHash ||
          !payment.type ||
          !payment.amount
        ) {
          console.warn(
            "PAYMENT SCAN: skipping malformed payment:",
            paymentId
          );

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
           * Re-read payment immediately before granting access.
           * This prevents duplicate credits if multiple scanner
           * cycles overlap or the process restarts.
           */
          const fresh =
            await doc.ref.get();

          const freshPayment =
            fresh.data() ||
            {};

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

              verifiedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              verifiedAmount:
                verification.amount,

              from:
                verification.from,

              to:
                verification.to,

              verificationAttempts:
                safeNumber(
                  freshPayment.verificationAttempts,
                  0
                ) + 1,

              updatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp()
            },
            {
              merge: true
            }
          );

          await grantPaymentAccess(
            {
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
            }
          );

          console.log(
            `PAYMENT CONFIRMED: ${paymentId}`
          );

          continue;
        }

        /*
         * Still pending.
         */
        const attempts =
          safeNumber(
            payment.verificationAttempts,
            0
          ) + 1;

        await doc.ref.set(
          {
            verificationAttempts:
              attempts,

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
         * A single bad payment must NEVER kill the entire scanner.
         */
        console.error(
          `PAYMENT SCAN ERROR for ${paymentId}:`,
          paymentError
        );

        if (
          isNotFoundError(
            paymentError
          )
        ) {
          console.error(
            `PAYMENT ${paymentId}: Firestore/TRON returned NOT_FOUND. Leaving payment pending.`
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
          console.error(
            "PAYMENT SCAN: unable to record scanner error:",
            updateError
          );
        }
      }
    }
  } catch (error) {
    /*
     * TOP LEVEL SCANNER PROTECTION.
     *
     * Nothing from this function is allowed to crash Node.
     */
    if (
      isNotFoundError(
        error
      )
    ) {
      console.error(
        "PAYMENT SCAN: Firestore NOT_FOUND (code 5). Scanner will retry later."
      );
    } else {
      console.error(
        "PAYMENT SCAN UNHANDLED ERROR:",
        error
      );
    }
  } finally {
    scannerRunning =
      false;
  }
}


/* ============================================================
   START PAYMENT SCANNER
============================================================ */

function startPaymentScanner() {
  if (
    !firebaseReady ||
    !tronConfigured
  ) {
    console.warn(
      "Payment scanner disabled:",
      {
        firebaseReady,
        tronConfigured
      }
    );

    return;
  }

  if (scannerTimer) {
    clearInterval(
      scannerTimer
    );
  }

  console.log(
    "Payment scanner enabled."
  );

  console.log(
    `Payment scan interval: ${PAYMENT_SCAN_INTERVAL_MS}ms`
  );

  /*
   * Do one scan shortly after startup.
   */
  setTimeout(
    () => {
      scanPendingPayments()
        .catch((error) => {
          console.error(
            "INITIAL PAYMENT SCAN ERROR:",
            error
          );
        });
    },
    5000
  );

  scannerTimer =
    setInterval(
      () => {
        scanPendingPayments()
          .catch((error) => {
            /*
             * Absolute last-resort protection.
             */
            console.error(
              "PAYMENT SCANNER LOOP ERROR:",
              error
            );
          });
      },
      PAYMENT_SCAN_INTERVAL_MS
    );
}


/* ============================================================
   404 HANDLER
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
 * Do not let an unhandled rejected promise from an asynchronous
 * background task take down the Render process.
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

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );

    /*
     * We intentionally do not call process.exit().
     *
     * This gives the server a chance to continue serving health
     * checks and API requests.
     */
  }
);


/* ============================================================
   START SERVER
============================================================ */

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
        process.env.TRC20_WALLET
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
     * Start scanner only after HTTP server is listening.
     */
    startPaymentScanner();
  }
);