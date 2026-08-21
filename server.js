"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

const app = express();

/*
============================================================
WALKER WEBS SERVER
============================================================

Recommended Node version:
Node 20+

This server provides:

- /api/health
- /api/generate
- /api/edit
- /api/usage
- /api/publish
- /api/payments/submit
- /api/payments/:paymentId
- /p/:publishId
- frontend serving
============================================================
*/

// ============================================================
// SERVER CONFIG
// ============================================================

const PORT = Number(process.env.PORT) || 3000;

const PUBLIC_DIR = path.join(
  __dirname,
  "public"
);

const INDEX_FILE = path.join(
  PUBLIC_DIR,
  "index.html"
);

// ============================================================
// ENVIRONMENT
// ============================================================

const GROQ_KEY =
  process.env.GROQ_KEY || "";

const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  "https://walker-webs.web.app"
).replace(/\/$/, "");

const TRC20_WALLET =
  process.env.TRC20_WALLET ||
  "TKRAT57UckeS15pxfkGyaxvyHmdKuupZgD";

const TRONGRID_API_KEY =
  process.env.TRONGRID_API_KEY || "";

const TRONGRID_URL = (
  process.env.TRONGRID_URL ||
  "https://api.trongrid.io"
).replace(/\/$/, "");

const USDT_TRC20_CONTRACT =
  process.env.USDT_TRC20_CONTRACT ||
  "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const USDT_DECIMALS = 6;

// ============================================================
// FREE LIMITS
// ============================================================

const FREE_WEBSITES = 3;
const FREE_EDITS = 3;

// ============================================================
// PAID PLANS
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
// STARTUP LOG
// ============================================================

console.log("");
console.log("==========================================");
console.log("WALKER WEBS SERVER STARTING");
console.log("==========================================");
console.log("Node:", process.version);
console.log("Port:", PORT);
console.log("Public URL:", PUBLIC_URL);
console.log("Frontend directory:", PUBLIC_DIR);
console.log("Frontend exists:", fs.existsSync(INDEX_FILE));
console.log("GROQ configured:", Boolean(GROQ_KEY));
console.log("TRON configured:", Boolean(TRONGRID_API_KEY));
console.log("Firebase environment configured:",
  Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  )
);
console.log("==========================================");
console.log("");

// ============================================================
// NODE FETCH CHECK
// ============================================================

if (typeof fetch !== "function") {
  console.error("");
  console.error(
    "ERROR: fetch() is unavailable."
  );
  console.error(
    "Use Node.js 18 or newer. Node 20/22 is recommended."
  );
  console.error("");
  process.exit(1);
}

// ============================================================
// FIREBASE
// ============================================================

function initFirebase() {
  try {
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
        "Firebase Admin credentials are not configured."
      );

      return null;
    }

    return admin.initializeApp({
      credential:
        admin.credential.cert({
          projectId,
          clientEmail,
          privateKey:
            privateKey.replace(
              /\\n/g,
              "\n"
            )
        })
    });

  } catch (error) {
    console.error(
      "Firebase initialization error:",
      error.message
    );

    return null;
  }
}

const firebaseApp =
  initFirebase();

const db =
  firebaseApp
    ? admin.firestore()
    : null;

const FieldValue =
  admin.firestore.FieldValue;

// ============================================================
// EXPRESS
// ============================================================

app.disable(
  "x-powered-by"
);

app.set(
  "trust proxy",
  1
);

// ============================================================
// BODY PARSING
// ============================================================

app.use(
  express.json({
    limit: "12mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "12mb"
  })
);

// ============================================================
// CORS
// ============================================================

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  ""
)
  .split(",")
  .map(
    x => x.trim()
  )
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {

      // Non-browser/server request
      if (!origin) {
        return callback(
          null,
          true
        );
      }

      const allowed =
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(
          origin
        ) ||

        /^https:\/\/([a-z0-9-]+\.)?web\.app$/i
          .test(origin) ||

        /^https:\/\/([a-z0-9-]+\.)?firebaseapp\.com$/i
          .test(origin) ||

        /^https:\/\/([a-z0-9-]+\.)?onrender\.com$/i
          .test(origin) ||

        /^https?:\/\/localhost(:\d+)?$/i
          .test(origin) ||

        /^https?:\/\/127\.0\.0\.1(:\d+)?$/i
          .test(origin);

      if (allowed) {
        return callback(
          null,
          true
        );
      }

      console.warn(
        "CORS blocked:",
        origin
      );

      return callback(
        new Error(
          "CORS not allowed"
        )
      );
    },

    methods: [
      "GET",
      "POST",
      "OPTIONS"
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ],

    credentials: true
  })
);

// Explicit OPTIONS handling
app.options(
  "*",
  cors()
);

// ============================================================
// RATE LIMITERS
// ============================================================

const generateLimiter =
  rateLimit({
    windowMs:
      15 * 60 * 1000,

    max: 100,

    standardHeaders:
      true,

    legacyHeaders:
      false,

    message: {
      error:
        "Rate limit reached. Please wait 15 minutes."
    }
  });

const paymentLimiter =
  rateLimit({
    windowMs:
      15 * 60 * 1000,

    max: 30,

    standardHeaders:
      true,

    legacyHeaders:
      false,

    message: {
      error:
        "Too many payment requests. Please wait."
    }
  });

// ============================================================
// FIREBASE REQUIREMENT
// ============================================================

function requireFirebase() {

  if (!db) {

    const error =
      new Error(
        "Firebase Admin is not configured on the server."
      );

    error.status =
      503;

    throw error;
  }
}

// ============================================================
// AUTHENTICATION
// ============================================================

async function requireUser(
  req,
  res,
  next
) {

  try {

    requireFirebase();

    const authorization =
      req.headers.authorization ||
      "";

    if (
      !authorization.startsWith(
        "Bearer "
      )
    ) {

      return res.status(
        401
      ).json({
        error:
          "Authentication required."
      });
    }

    const token =
      authorization
        .substring(7)
        .trim();

    if (!token) {

      return res.status(
        401
      ).json({
        error:
          "Authentication token is missing."
      });
    }

    const decoded =
      await admin
        .auth()
        .verifyIdToken(
          token
        );

    req.user =
      decoded;

    return next();

  } catch (error) {

    console.error(
      "AUTH ERROR:",
      error.message
    );

    return res.status(
      error.status ||
      401
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
//
// IMPORTANT:
// This endpoint does NOT require Firebase.
// This endpoint does NOT require GROQ.
// This endpoint does NOT require TRON.
//
// Therefore the frontend can always determine whether
// the Node server itself is alive.
//

app.get(
  "/api/health",
  (req, res) => {

    return res.status(
      200
    ).json({

      ok: true,

      service:
        "walker-webs-backend",

      status:
        "online",

      firebase:
        Boolean(db),

      groq:
        Boolean(GROQ_KEY),

      tronVerification:
        Boolean(
          TRONGRID_API_KEY
        ),

      walletConfigured:
        Boolean(
          TRC20_WALLET
        ),

      freeWebsites:
        FREE_WEBSITES,

      freeEdits:
        FREE_EDITS,

      timestamp:
        Date.now()
    });
  }
);

// ============================================================
// FRONTEND STATIC FILES
// ============================================================

if (
  fs.existsSync(
    PUBLIC_DIR
  )
) {

  app.use(
    express.static(
      PUBLIC_DIR,
      {
        index: false,
        maxAge:
          process.env.NODE_ENV ===
          "production"
            ? "1h"
            : 0
      }
    )
  );

} else {

  console.warn(
    "WARNING: public directory does not exist:",
    PUBLIC_DIR
  );
}

// ============================================================
// HTML HELPERS
// ============================================================

function cleanHTML(
  html
) {

  return String(
    html || ""
  )
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
}

function isHTML(
  html
) {

  const value =
    String(
      html || ""
    ).toLowerCase();

  return (
    value.includes(
      "<!doctype html"
    ) ||
    value.includes(
      "<html"
    )
  );
}

// ============================================================
// GROQ AI
// ============================================================

async function groqHTML(
  instruction
) {

  if (!GROQ_KEY) {

    const error =
      new Error(
        "AI service is not configured. GROQ_KEY is missing."
      );

    error.status =
      503;

    throw error;
  }

  const prompt = `
You are the expert web developer for WALKER WEBS.

Create or modify a complete production-quality
single-file HTML website.

USER INSTRUCTION:

${instruction}

RULES:

1. Return ONLY complete HTML.
2. No markdown code fences.
3. The document must start with <!DOCTYPE html>.
4. Use Tailwind CSS CDN when useful.
5. Mobile-first.
6. Responsive on phones, tablets and desktop.
7. Semantic accessible HTML.
8. Modern typography.
9. Polished spacing.
10. Modern cards and sections.
11. Subtle animations.
12. Strong CTA.
13. Responsive navigation.
14. Footer.
15. Never expose API keys.
16. Never expose secrets.
17. Keep everything inside one HTML file.
18. Preserve existing functionality unless requested otherwise.
19. Make sure JavaScript works.
20. Return the COMPLETE final HTML document.
`;

  const response =
    await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${GROQ_KEY}`
        },

        body:
          JSON.stringify({
            model:
              "openai/gpt-oss-120b",

            messages: [
              {
                role:
                  "user",

                content:
                  prompt
              }
            ],

            temperature:
              0.7,

            max_tokens:
              10000
          })
      }
    );

  const data =
    await response
      .json()
      .catch(
        () => ({})
      );

  if (
    !response.ok ||
    data.error
  ) {

    console.error(
      "GROQ ERROR:",
      data.error ||
        response.statusText
    );

    const error =
      new Error(
        data?.error?.message ||
        "AI generation failed."
      );

    error.status =
      response.status ===
      429
        ? 429
        : 502;

    throw error;
  }

  const html =
    cleanHTML(
      data
        ?.choices?.[0]
        ?.message
        ?.content ||
        ""
    );

  if (
    !isHTML(html)
  ) {

    throw new Error(
      "AI returned invalid HTML."
    );
  }

  return html;
}

// ============================================================
// GENERATE WEBSITE
// ============================================================

app.post(
  "/api/generate",
  generateLimiter,
  async (
    req,
    res
  ) => {

    try {

      const prompt =
        typeof req.body?.prompt ===
        "string"
          ? req.body.prompt.trim()
          : "";

      if (!prompt) {

        return res.status(
          400
        ).json({
          error:
            "Prompt is required."
        });
      }

      if (
        prompt.length >
        6000
      ) {

        return res.status(
          400
        ).json({
          error:
            "Prompt is too long."
        });
      }

      const html =
        await groqHTML(
          prompt
        );

      return res.json({
        ok: true,
        html
      });

    } catch (error) {

      console.error(
        "GENERATE ERROR:",
        error
      );

      return res.status(
        error.status ||
        500
      ).json({
        error:
          error.message ||
          "Website generation failed."
      });
    }
  }
);

// ============================================================
// USAGE
// ============================================================

async function getUserUsage(
  uid
) {

  requireFirebase();

  const ref =
    db
      .collection(
        "usage"
      )
      .doc(uid);

  const snap =
    await ref.get();

  if (
    !snap.exists
  ) {

    return {
      websitesPublished:
        0,

      websitesCreated:
        0,

      edits:
        0,

      freeDownloads:
        0,

      updatedAt:
        Date.now()
    };
  }

  return {
    websitesPublished:
      0,

    websitesCreated:
      0,

    edits:
      0,

    freeDownloads:
      0,

    ...snap.data()
  };
}

// ============================================================
// INCREMENT USAGE
// ============================================================

async function incrementUsage(
  uid,
  fields
) {

  requireFirebase();

  const ref =
    db
      .collection(
        "usage"
      )
      .doc(uid);

  const update = {
    updatedAt:
      FieldValue.serverTimestamp()
  };

  for (
    const [
      key,
      value
    ] of Object.entries(
      fields
    )
  ) {

    update[key] =
      FieldValue.increment(
        Number(value)
      );
  }

  await ref.set(
    update,
    {
      merge: true
    }
  );
}

// ============================================================
// ACTIVE PAID PLAN
// ============================================================

async function hasActivePaidPlan(
  uid
) {

  requireFirebase();

  const snap =
    await db
      .collection(
        "subscriptions"
      )
      .doc(uid)
      .get();

  if (
    !snap.exists
  ) {
    return false;
  }

  const subscription =
    snap.data();

  if (
    subscription.type ===
    "lifetime"
  ) {
    return true;
  }

  if (
    subscription.type ===
    "monthly"
  ) {

    return (
      Number(
        subscription.expiresAt ||
        0
      ) >
      Date.now()
    );
  }

  if (
    subscription.type ===
    "single"
  ) {

    return (
      Number(
        subscription.credits ||
        0
      ) > 0
    );
  }

  return false;
}

// ============================================================
// SINGLE CREDIT
// ============================================================

async function consumeSingleCredit(
  uid
) {

  requireFirebase();

  const ref =
    db
      .collection(
        "subscriptions"
      )
      .doc(uid);

  return db.runTransaction(
    async transaction => {

      const snap =
        await transaction.get(
          ref
        );

      if (
        !snap.exists
      ) {
        return false;
      }

      const subscription =
        snap.data();

      if (
        subscription.type !==
        "single"
      ) {
        return false;
      }

      if (
        Number(
          subscription.credits ||
          0
        ) <= 0
      ) {
        return false;
      }

      transaction.update(
        ref,
        {
          credits:
            FieldValue.increment(
              -1
            ),

          updatedAt:
            Date.now()
        }
      );

      return true;
    }
  );
}

// ============================================================
// EDIT WEBSITE
// ============================================================

app.post(
  "/api/edit",
  requireUser,
  async (
    req,
    res
  ) => {

    try {

      const html =
        typeof req.body?.html ===
        "string"
          ? req.body.html
          : "";

      const instruction =
        typeof req.body?.instruction ===
        "string"
          ? req.body.instruction.trim()
          : "";

      if (
        !html ||
        !isHTML(html)
      ) {

        return res.status(
          400
        ).json({
          error:
            "Valid website HTML is required."
        });
      }

      if (
        !instruction
      ) {

        return res.status(
          400
        ).json({
          error:
            "Edit instruction is required."
        });
      }

      if (
        instruction.length >
        4000
      ) {

        return res.status(
          400
        ).json({
          error:
            "Edit instruction is too long."
        });
      }

      if (
        html.length >
        9000000
      ) {

        return res.status(
          413
        ).json({
          error:
            "Website HTML is too large."
        });
      }

      const uid =
        req.user.uid;

      const usage =
        await getUserUsage(
          uid
        );

      const paid =
        await hasActivePaidPlan(
          uid
        );

      const editsUsed =
        Number(
          usage.edits || 0
        );

      if (
        editsUsed >=
        FREE_EDITS &&
        !paid
      ) {

        return res.status(
          402
        ).json({

          error:
            "Your 3 free edits are finished. Purchase a plan to continue editing.",

          code:
            "EDIT_PAYMENT_REQUIRED"
        });
      }

      const instructionWithHTML = `
Modify this EXISTING website.

REQUESTED CHANGE:
${instruction}

EXISTING WEBSITE:
${html}
`;

      const updatedHTML =
        await groqHTML(
          instructionWithHTML
        );

      /*
       * Free edits are counted only
       * after successful AI generation.
       */
      if (!paid) {

        await incrementUsage(
          uid,
          {
            edits:
              1
          }
        );
      }

      return res.json({

        ok:
          true,

        html:
          updatedHTML,

        paid,

        freeEditsRemaining:
          paid
            ? 0
            : Math.max(
                0,
                FREE_EDITS -
                editsUsed -
                1
              )
      });

    } catch (error) {

      console.error(
        "EDIT ERROR:",
        error
      );

      return res.status(
        error.status ||
        500
      ).json({
        error:
          error.message ||
          "Website edit failed."
      });
    }
  }
);

// ============================================================
// USDT HELPERS
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
    Number(
      plan.amount
    )
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
      10 **
      USDT_DECIMALS
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
    24 *
    60 *
    60 *
    1000
) {

  if (!timestamp) {
    return false;
  }

  const age =
    Date.now() -
    Number(timestamp);

  return (
    age >= 0 &&
    age <=
    maxAgeMs
  );
}

// ============================================================
// TRONGRID
// ============================================================

async function tronRequest(
  url
) {

  const headers = {
    Accept:
      "application/json"
  };

  if (
    TRONGRID_API_KEY
  ) {

    headers[
      "TRON-PRO-API-KEY"
    ] =
      TRONGRID_API_KEY;
  }

  const response =
    await fetch(
      url,
      {
        method:
          "GET",

        headers
      }
    );

  const data =
    await response
      .json()
      .catch(
        () => ({})
      );

  if (
    !response.ok
  ) {

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
// VERIFY USDT
// ============================================================

async function verifyUsdtPayment(
  txHash,
  expectedAmount
) {

  if (
    !TRONGRID_API_KEY
  ) {

    throw new Error(
      "TRONGRID_API_KEY is not configured."
    );
  }

  const hash =
    String(
      txHash || ""
    ).trim();

  if (
    !/^[a-fA-F0-9]{64}$/.test(
      hash
    )
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
    await tronRequest(
      url
    );

  const transfers =
    Array.isArray(
      data?.data
    )
      ? data.data
      : [];

  const transfer =
    transfers.find(
      item =>
        String(
          item?.transaction_id ||
          ""
        ).toLowerCase() ===
        hash.toLowerCase()
    );

  if (
    !transfer
  ) {

    return {
      status:
        "pending",

      reason:
        "Transaction has not appeared as a confirmed USDT transfer to the Walker Webs wallet yet."
    };
  }

  const tokenAddress =
    transfer?.token_info
      ?.address ||
    transfer
      ?.contract_address ||
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
          transfer.value ||
          "0"
        )
      );

  } catch {

    return {
      status:
        "rejected",

      reason:
        "Invalid transaction amount."
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
      Number(
        actualUnits
      ) /
      10 **
      USDT_DECIMALS,

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
// PUBLISH
// ============================================================

app.post(
  "/api/publish",
  requireUser,
  async (
    req,
    res
  ) => {

    try {

      const html =
        typeof req.body?.html ===
        "string"
          ? req.body.html
          : "";

      const prompt =
        typeof req.body?.prompt ===
        "string"
          ? req.body.prompt
          : "";

      if (
        !html ||
        !isHTML(html)
      ) {

        return res.status(
          400
        ).json({
          error:
            "Valid website HTML is required."
        });
      }

      if (
        html.length >
        9000000
      ) {

        return res.status(
          413
        ).json({
          error:
            "Website HTML is too large."
        });
      }

      const uid =
        req.user.uid;

      const usage =
        await getUserUsage(
          uid
        );

      const published =
        Number(
          usage.websitesPublished ||
          0
        );

      const paid =
        await hasActivePaidPlan(
          uid
        );

      /*
       * First 3 publications are free.
       */
      if (
        published >=
        FREE_WEBSITES &&
        !paid
      ) {

        return res.status(
          402
        ).json({

          error:
            "Your 3 free websites have been published. Purchase a plan to publish more.",

          code:
            "PUBLISH_PAYMENT_REQUIRED"
        });
      }

      const publishId =
        crypto.randomUUID();

      const url =
        `${PUBLIC_URL}/p/${publishId}`;

      await db
        .collection(
          "published"
        )
        .doc(
          publishId
        )
        .set({

          html,

          originalHtml:
            html,

          prompt,

          userId:
            uid,

          email:
            req.user.email ||
            null,

          createdAt:
            Date.now(),

          updatedAt:
            Date.now(),

          url,

          mode:
            published <
            FREE_WEBSITES
              ? "free"
              : "paid"
        });

      await incrementUsage(
        uid,
        {
          websitesPublished:
            1
        }
      );

      /*
       * A single paid plan gives one
       * publishing credit.
       */
      if (
        published >=
        FREE_WEBSITES &&
        paid
      ) {

        const subSnap =
          await db
            .collection(
              "subscriptions"
            )
            .doc(uid)
            .get();

        if (
          subSnap.exists &&
          subSnap.data()
            .type ===
            "single"
        ) {

          await consumeSingleCredit(
            uid
          );
        }
      }

      return res.json({

        ok:
          true,

        publishId,

        url,

        mode:
          published <
          FREE_WEBSITES
            ? "free"
            : "paid"
      });

    } catch (error) {

      console.error(
        "PUBLISH ERROR:",
        error
      );

      return res.status(
        error.status ||
        500
      ).json({
        error:
          error.message ||
          "Publishing failed."
      });
    }
  }
);

// ============================================================
// USAGE API
// ============================================================

app.get(
  "/api/usage",
  requireUser,
  async (
    req,
    res
  ) => {

    try {

      const usage =
        await getUserUsage(
          req.user.uid
        );

      const paid =
        await hasActivePaidPlan(
          req.user.uid
        );

      return res.json({

        ok:
          true,

        usage,

        freeWebsitesRemaining:
          paid
            ? 0
            : Math.max(
                0,
                FREE_WEBSITES -
                Number(
                  usage.websitesPublished ||
                  0
                )
              ),

        freeEditsRemaining:
          paid
            ? 0
            : Math.max(
                0,
                FREE_EDITS -
                Number(
                  usage.edits ||
                  0
                )
              ),

        paid
      });

    } catch (error) {

      console.error(
        "USAGE ERROR:",
        error
      );

      return res.status(
        500
      ).json({
        error:
          "Unable to read usage."
      });
    }
  }
);

// ============================================================
// PAYMENT ACTIVATION
// ============================================================

async function activatePayment(
  paymentRef,
  verification
) {

  requireFirebase();

  const paymentSnap =
    await paymentRef.get();

  if (
    !paymentSnap.exists
  ) {

    throw new Error(
      "Payment not found."
    );
  }

  const payment =
    paymentSnap.data();

  const uid =
    payment.userId;

  const now =
    Date.now();

  const subscriptionRef =
    db
      .collection(
        "subscriptions"
      )
      .doc(uid);

  let result;

  await db.runTransaction(
    async transaction => {

      const freshPaymentSnap =
        await transaction.get(
          paymentRef
        );

      if (
        !freshPaymentSnap.exists
      ) {

        throw new Error(
          "Payment not found."
        );
      }

      const freshPayment =
        freshPaymentSnap.data();

      /*
       * Already activated.
       */
      if (
        freshPayment.status ===
        "approved"
      ) {

        result = {
          alreadyActivated:
            true,

          type:
            freshPayment.type,

          amount:
            freshPayment.amount
        };

        return;
      }

      const existingSnap =
        await transaction.get(
          subscriptionRef
        );

      const existing =
        existingSnap.exists
          ? existingSnap.data()
          : {};

      let subscription;

      if (
        freshPayment.type ===
        "single"
      ) {

        subscription = {

          type:
            "single",

          amount:
            freshPayment.amount,

          credits:
            Number(
              existing.credits ||
              0
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
          merge:
            true
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
// PAYMENT SUBMISSION
// ============================================================

app.post(
  "/api/payments/submit",
  paymentLimiter,
  requireUser,
  async (
    req,
    res
  ) => {

    try {

      const {
        amount,
        type,
        txHash,
        html,
        prompt
      } =
        req.body || {};

      const plan =
        getPlan(
          type,
          amount
        );

      if (!plan) {

        return res.status(
          400
        ).json({
          error:
            "Invalid payment plan."
        });
      }

      if (
        !txHash ||
        typeof txHash !==
        "string"
      ) {

        return res.status(
          400
        ).json({
          error:
            "Transaction hash is required."
        });
      }

      if (
        !html ||
        typeof html !==
        "string"
      ) {

        return res.status(
          400
        ).json({
          error:
            "Website HTML is required."
        });
      }

      const cleanHash =
        txHash.trim();

      const existing =
        await db
          .collection(
            "payments"
          )
          .where(
            "txHash",
            "==",
            cleanHash
          )
          .limit(5)
          .get();

      if (
        !existing.empty
      ) {

        const alreadyUsed =
          existing.docs.some(
            doc =>
              [
                "pending",
                "confirmed",
                "approved"
              ].includes(
                doc.data()
                  .status
              )
          );

        if (
          alreadyUsed
        ) {

          return res.status(
            409
          ).json({
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
          .collection(
            "payments"
          )
          .doc();

      await paymentRef.set({

        userId:
          req.user.uid,

        email:
          req.user.email ||
          null,

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
          verification.reason ||
          null,

        verification:
          verification.status ===
          "confirmed"
            ? verification
            : null,

        html,

        prompt,

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

          ok:
            true,

          status:
            "confirmed",

          paymentId:
            paymentRef.id,

          subscription
        });
      }

      return res.status(
        202
      ).json({

        ok:
          true,

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
        error.status ||
        500
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
  async (
    req,
    res
  ) => {

    try {

      const paymentRef =
        db
          .collection(
            "payments"
          )
          .doc(
            req.params
              .paymentId
          );

      const snap =
        await paymentRef.get();

      if (
        !snap.exists
      ) {

        return res.status(
          404
        ).json({
          error:
            "Payment not found."
        });
      }

      const payment =
        snap.data();

      if (
        payment.userId !==
        req.user.uid
      ) {

        return res.status(
          403
        ).json({
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

              ok:
                true,

              status:
                "approved",

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

              ok:
                true,

              status:
                "rejected",

              reason:
                verification.reason
            });
          }

        } catch (
          verificationError
        ) {

          console.error(
            "PAYMENT VERIFY ERROR:",
            verificationError.message
          );
        }
      }

      return res.json({

        ok:
          true,

        status:
          payment.status,

        reason:
          payment.verificationReason ||
          null
      });

    } catch (error) {

      console.error(
        "PAYMENT STATUS ERROR:",
        error
      );

      return res.status(
        500
      ).json({
        error:
          "Unable to check payment status."
      });
    }
  }
);

// ============================================================
// BACKGROUND PAYMENT CHECK
// ============================================================

let paymentCheckRunning =
  false;

async function processPendingPayments() {

  if (
    paymentCheckRunning
  ) {
    return;
  }

  if (
    !db ||
    !TRONGRID_API_KEY
  ) {
    return;
  }

  paymentCheckRunning =
    true;

  try {

    const snapshot =
      await db
        .collection(
          "payments"
        )
        .where(
          "status",
          "==",
          "pending"
        )
        .limit(25)
        .get();

    for (
      const doc
      of snapshot.docs
    ) {

      try {

        const payment =
          doc.data();

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

    paymentCheckRunning =
      false;
  }
}

// ============================================================
// PUBLIC PUBLISHED WEBSITE
// ============================================================

app.get(
  "/p/:publishId",
  async (
    req,
    res
  ) => {

    try {

      requireFirebase();

      const publishId =
        String(
          req.params
            .publishId ||
          ""
        ).trim();

      if (
        !publishId
      ) {

        return res.status(
          400
        ).send(
          "Invalid website."
        );
      }

      const snap =
        await db
          .collection(
            "published"
          )
          .doc(
            publishId
          )
          .get();

      if (
        !snap.exists
      ) {

        return res.status(
          404
        ).send(
          "Website not found."
        );
      }

      const data =
        snap.data();

      const html =
        typeof data.html ===
        "string"
          ? data.html
          : "";

      if (
        !html
      ) {

        return res.status(
          404
        ).send(
          "Website is empty."
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

      return res.send(
        html
      );

    } catch (error) {

      console.error(
        "PUBLIC WEBSITE ERROR:",
        error
      );

      return res.status(
        500
      ).send(
        "Unable to load website."
      );
    }
  }
);

// ============================================================
// API 404
// ============================================================

app.use(
  "/api",
  (
    req,
    res
  ) => {

    return res.status(
      404
    ).json({
      error:
        "API endpoint not found.",
      path:
        req.originalUrl
    });
  }
);

// ============================================================
// FRONTEND FALLBACK
// ============================================================
//
// Only browser HTML requests reach this.
//
// API requests and /p/ requests are excluded.
//

app.use(
  (
    req,
    res,
    next
  ) => {

    if (
      req.method !==
      "GET" &&
      req.method !==
      "HEAD"
    ) {

      return next();
    }

    if (
      req.path.startsWith(
        "/api"
      )
    ) {

      return next();
    }

    if (
      req.path.startsWith(
        "/p/"
      )
    ) {

      return next();
    }

    const accept =
      String(
        req.headers.accept ||
        ""
      );

    if (
      !accept.includes(
        "text/html"
      )
    ) {

      return next();
    }

    if (
      !fs.existsSync(
        INDEX_FILE
      )
    ) {

      return res.status(
        404
      ).send(
        "Frontend index.html was not found."
      );
    }

    return res.sendFile(
      INDEX_FILE
    );
  }
);

// ============================================================
// FINAL 404
// ============================================================

app.use(
  (
    req,
    res
  ) => {

    return res.status(
      404
    ).json({
      error:
        "Route not found."
    });
  }
);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "UNHANDLED ERROR:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    return res.status(
      error.status ||
      500
    ).json({
      error:
        error.message ||
        "Internal server error."
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log("");
      console.log(
        "=========================================="
      );
      console.log(
        "WALKER WEBS SERVER ONLINE"
      );
      console.log(
        "=========================================="
      );
      console.log(
        `Listening on port ${PORT}`
      );
      console.log(
        `Health endpoint: /api/health`
      );
      console.log(
        `Frontend: ${PUBLIC_URL}`
      );
      console.log(
        `Firebase: ${Boolean(db)}`
      );
      console.log(
        `Groq: ${Boolean(GROQ_KEY)}`
      );
      console.log(
        `TRON verification: ${Boolean(
          TRONGRID_API_KEY
        )}`
      );
      console.log(
        `Payment wallet: ${TRC20_WALLET}`
      );
      console.log(
        "=========================================="
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
    `${signal} received.`
  );

  server.close(
    () => {

      console.log(
        "Server stopped."
      );

      process.exit(
        0
      );
    }
  );
}

process.on(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);

// ============================================================
// BACKGROUND PAYMENT MONITOR
// ============================================================

if (
  db &&
  TRONGRID_API_KEY
) {

  setTimeout(
    processPendingPayments,
    5000
  );

  setInterval(
    processPendingPayments,
    30 * 1000
  );
}