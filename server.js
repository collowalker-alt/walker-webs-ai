require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";

/* ------------------------------------------------------------
   ENVIRONMENT
------------------------------------------------------------ */

const requiredEnv = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY"
];

const optionalEnv = {
  GROQ_KEY: "AI generation/editing",
  TRONGRID_API_KEY: "TRON payment verification",
  TRC20_WALLET: "TRON payment destination"
};

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

function missingRequiredEnv() {
  return requiredEnv.filter((key) => !String(process.env[key] || "").trim());
}

const missing = missingRequiredEnv();

/* ------------------------------------------------------------
   FIREBASE ADMIN
------------------------------------------------------------ */

let db = null;
let firebaseReady = false;

if (!missing.length) {
  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
        })
      });
    }

    db = admin.firestore();
    firebaseReady = true;

    console.log("Firebase Admin initialized.");
  } catch (error) {
    console.error("Firebase initialization failed:", error);
  }
} else {
  console.warn(
    "Firebase Admin is not initialized. Missing:",
    missing.join(", ")
  );
}

/* ------------------------------------------------------------
   CORS
------------------------------------------------------------ */

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

  /*
   * Firebase Hosting preview channels/custom domains can vary.
   * Allow Firebase/Google hosting origins, while keeping arbitrary
   * third-party origins blocked.
   */
  try {
    const url = new URL(origin);
    const hostname = url.hostname;

    if (
      hostname.endsWith(".web.app") ||
      hostname.endsWith(".firebaseapp.com")
    ) {
      return true;
    }
  } catch (_) {}

  return false;
}

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("CORS blocked this origin: " + origin)
      );
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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

app.options("*", cors());

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

/* ------------------------------------------------------------
   REQUEST LOGGING
------------------------------------------------------------ */

app.use((req, res, next) => {
  const started = Date.now();

  res.on("finish", () => {
    console.log(
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`
    );
  });

  next();
});

/* ------------------------------------------------------------
   HEALTH
------------------------------------------------------------ */

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Walker Webs API",
    status: "online",
    health: "/api/health"
  });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "Walker Webs API",
    status: "online",
    firebase: firebaseReady,
    aiConfigured: Boolean(process.env.GROQ_KEY),
    tronConfigured: Boolean(
      process.env.TRONGRID_API_KEY && process.env.TRC20_WALLET
    ),
    timestamp: new Date().toISOString()
  });
});

/* ------------------------------------------------------------
   AUTH
------------------------------------------------------------ */

async function requireAuth(req, res, next) {
  try {
    if (!firebaseReady) {
      return res.status(503).json({
        error: "Authentication service is not configured on the backend."
      });
    }

    const header = String(req.headers.authorization || "");

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required."
      });
    }

    const token = header.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        error: "Authentication token is missing."
      });
    }

    req.user = await admin.auth().verifyIdToken(token);

    return next();
  } catch (error) {
    console.error("AUTH ERROR:", error);

    return res.status(401).json({
      error: "Invalid or expired authentication token."
    });
  }
}

/* ------------------------------------------------------------
   FIRESTORE HELPERS
------------------------------------------------------------ */

function userRef(uid) {
  return db.collection("users").doc(uid);
}

async function ensureUser(uid, email) {
  if (!firebaseReady) {
    throw new Error("Firebase is not configured.");
  }

  const ref = userRef(uid);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set(
      {
        uid,
        email: email || null,
        freeWebsitesRemaining: 3,
        freeEditsRemaining: 3,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }

  return ref;
}

async function getUserData(uid, email) {
  const ref = await ensureUser(uid, email);
  const snap = await ref.get();

  return {
    ref,
    data: snap.data() || {}
  };
}

/* ------------------------------------------------------------
   AI
------------------------------------------------------------ */

async function groqChat(messages) {
  if (!process.env.GROQ_KEY) {
    throw new Error("GROQ_KEY is not configured on the backend.");
  }

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_KEY}`
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages,
        temperature: 0.7
      })
    }
  );

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = {};
  }

  if (!response.ok) {
    console.error("GROQ ERROR:", response.status, data);

    throw new Error(
      data?.error?.message ||
        `AI provider returned HTTP ${response.status}`
    );
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("AI provider returned no content.");
  }

  return content;
}

function cleanAIHtml(value) {
  return String(value || "")
    .replace(/^\s*```html\s*/i, "")
    .replace(/^\s*```\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function isHTML(value) {
  const lower = String(value || "").toLowerCase();

  return (
    lower.includes("<!doctype html") ||
    lower.includes("<html")
  );
}

/* ------------------------------------------------------------
   GENERATE
------------------------------------------------------------ */

app.post("/api/generate", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim();

    if (!prompt) {
      return res.status(400).json({
        error: "Website prompt is required."
      });
    }

    if (prompt.length > 6000) {
      return res.status(400).json({
        error: "Prompt cannot exceed 6000 characters."
      });
    }

    const html = cleanAIHtml(
      await groqChat([
        {
          role: "system",
          content:
            "You are a professional web developer. Generate a complete standalone HTML document for the requested website. Return ONLY HTML. Include CSS and JavaScript inside the HTML. Do not use Markdown code fences."
        },
        {
          role: "user",
          content: prompt
        }
      ])
    );

    if (!isHTML(html)) {
      return res.status(502).json({
        error: "The AI returned invalid HTML."
      });
    }

    return res.json({
      ok: true,
      html
    });
  } catch (error) {
    console.error("GENERATE ERROR:", error);

    return res.status(500).json({
      error: error.message || "Website generation failed."
    });
  }
});

/* ------------------------------------------------------------
   USAGE
------------------------------------------------------------ */

app.get("/api/usage", requireAuth, async (req, res) => {
  try {
    const { data } = await getUserData(
      req.user.uid,
      req.user.email
    );

    return res.json({
      ok: true,
      freeWebsitesRemaining:
        Number(data.freeWebsitesRemaining ?? 3),
      freeEditsRemaining:
        Number(data.freeEditsRemaining ?? 3)
    });
  } catch (error) {
    console.error("USAGE ERROR:", error);

    return res.status(500).json({
      error: "Unable to load usage."
    });
  }
});

/* ------------------------------------------------------------
   EDIT
------------------------------------------------------------ */

app.post("/api/edit", requireAuth, async (req, res) => {
  try {
    const html = String(req.body?.html || "");
    const instruction = String(
      req.body?.instruction || ""
    ).trim();

    if (!isHTML(html)) {
      return res.status(400).json({
        error: "Valid HTML is required."
      });
    }

    if (!instruction) {
      return res.status(400).json({
        error: "Edit instruction is required."
      });
    }

    if (instruction.length > 4000) {
      return res.status(400).json({
        error: "Edit instruction is too long."
      });
    }

    const { ref, data } = await getUserData(
      req.user.uid,
      req.user.email
    );

    const freeEdits = Number(
      data.freeEditsRemaining ?? 3
    );

    if (freeEdits <= 0 && !data.paidEditing) {
      return res.status(402).json({
        error: "Payment required for additional AI edits."
      });
    }

    const edited = cleanAIHtml(
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
        error: "The AI returned invalid edited HTML."
      });
    }

    if (!data.paidEditing) {
      await ref.set(
        {
          freeEditsRemaining: Math.max(
            0,
            freeEdits - 1
          ),
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    const after = await ref.get();
    const afterData = after.data() || {};

    return res.json({
      ok: true,
      html: edited,
      paid: Boolean(data.paidEditing),
      freeWebsitesRemaining:
        Number(afterData.freeWebsitesRemaining ?? 3),
      freeEditsRemaining:
        Number(afterData.freeEditsRemaining ?? 0)
    });
  } catch (error) {
    console.error("EDIT ERROR:", error);

    return res.status(500).json({
      error: error.message || "Website editing failed."
    });
  }
});

/* ------------------------------------------------------------
   PUBLISH
------------------------------------------------------------ */

app.post("/api/publish", requireAuth, async (req, res) => {
  try {
    const html = String(req.body?.html || "");
    const prompt = String(req.body?.prompt || "");

    if (!isHTML(html)) {
      return res.status(400).json({
        error: "Valid HTML is required."
      });
    }

    const { ref, data } = await getUserData(
      req.user.uid,
      req.user.email
    );

    const freePublishes = Number(
      data.freeWebsitesRemaining ?? 3
    );

    if (freePublishes <= 0 && !data.publishingAccess) {
      return res.status(402).json({
        error: "Payment required for additional publishes."
      });
    }

    /*
     * The original frontend expects a public URL.
     * This backend stores the HTML document in Firestore.
     *
     * A separate public-rendering layer is required to turn that
     * stored HTML into a browsable URL. If your previous backend
     * already had a publishing implementation, keep that provider's
     * credentials/configuration and replace this block with it.
     */

    const siteId = crypto.randomBytes(12).toString("hex");

    await db.collection("publishedSites").doc(siteId).set({
      siteId,
      ownerUid: req.user.uid,
      prompt,
      html,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (!data.publishingAccess) {
      await ref.set(
        {
          freeWebsitesRemaining: Math.max(
            0,
            freePublishes - 1
          ),
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    /*
     * This URL requires the backend's public site route below.
     * It is usable immediately when this server is publicly reachable.
     */
    const baseURL =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;

    return res.json({
      ok: true,
      url: `${baseURL}/p/${siteId}`,
      siteId
    });
  } catch (error) {
    console.error("PUBLISH ERROR:", error);

    return res.status(500).json({
      error: error.message || "Publishing failed."
    });
  }
});

/* ------------------------------------------------------------
   PUBLIC PUBLISHED SITE
------------------------------------------------------------ */

app.get("/p/:siteId", async (req, res) => {
  try {
    if (!firebaseReady) {
      return res.status(503).send("Publishing service unavailable.");
    }

    const snap = await db
      .collection("publishedSites")
      .doc(req.params.siteId)
      .get();

    if (!snap.exists) {
      return res.status(404).send("Website not found.");
    }

    const data = snap.data() || {};
    const html = String(data.html || "");

    if (!isHTML(html)) {
      return res.status(500).send("Published website is invalid.");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");

    return res.send(html);
  } catch (error) {
    console.error("PUBLIC SITE ERROR:", error);

    return res.status(500).send(
      "Unable to load published website."
    );
  }
});

/* ------------------------------------------------------------
   PAYMENTS
------------------------------------------------------------ */

function validTxHash(txHash) {
  return /^[a-fA-F0-9]{64}$/.test(
    String(txHash || "").trim()
  );
}

app.post(
  "/api/payments/submit",
  requireAuth,
  async (req, res) => {
    try {
      const amount = Number(req.body?.amount);
      const type = String(req.body?.type || "");
      const txHash = String(
        req.body?.txHash || ""
      ).trim();

      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          error: "Invalid payment amount."
        });
      }

      if (!["single", "monthly", "lifetime"].includes(type)) {
        return res.status(400).json({
          error: "Invalid payment plan."
        });
      }

      if (!validTxHash(txHash)) {
        return res.status(400).json({
          error: "Invalid TRON transaction hash."
        });
      }

      if (!firebaseReady) {
        return res.status(503).json({
          error: "Payment database is not configured."
        });
      }

      const existing = await db
        .collection("payments")
        .where("txHash", "==", txHash)
        .limit(1)
        .get();

      if (!existing.empty) {
        return res.status(409).json({
          error: "This transaction has already been submitted."
        });
      }

      const paymentRef = db.collection("payments").doc();

      await paymentRef.set({
        paymentId: paymentRef.id,
        uid: req.user.uid,
        email: req.user.email || null,
        amount,
        type,
        txHash,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      /*
       * Do not falsely claim blockchain confirmation here.
       * A real payment verifier should update the payment after
       * checking the TRON transaction against TRONGRID.
       */
      return res.status(202).json({
        ok: true,
        paymentId: paymentRef.id,
        status: "pending",
        message:
          "Payment submitted and is awaiting blockchain verification."
      });
    } catch (error) {
      console.error("PAYMENT SUBMIT ERROR:", error);

      return res.status(500).json({
        error: error.message || "Unable to submit payment."
      });
    }
  }
);

app.get(
  "/api/payments/:paymentId",
  requireAuth,
  async (req, res) => {
    try {
      const snap = await db
        .collection("payments")
        .doc(req.params.paymentId)
        .get();

      if (!snap.exists) {
        return res.status(404).json({
          error: "Payment not found."
        });
      }

      const payment = snap.data();

      if (payment.uid !== req.user.uid) {
        return res.status(403).json({
          error: "You cannot access this payment."
        });
      }

      return res.json({
        ok: true,
        paymentId: payment.paymentId,
        status: payment.status || "pending",
        reason: payment.reason || null
      });
    } catch (error) {
      console.error("PAYMENT STATUS ERROR:", error);

      return res.status(500).json({
        error: "Unable to check payment status."
      });
    }
  }
);

/* ------------------------------------------------------------
   404
------------------------------------------------------------ */

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found.",
    method: req.method,
    path: req.originalUrl
  });
});

/* ------------------------------------------------------------
   ERROR HANDLER
------------------------------------------------------------ */

app.use((error, _req, res, _next) => {
  console.error("UNHANDLED ERROR:", error);

  if (String(error.message || "").startsWith("CORS blocked")) {
    return res.status(403).json({
      error: "This website origin is not allowed by the API."
    });
  }

  return res.status(500).json({
    error: "Internal server error."
  });
});

/* ------------------------------------------------------------
   START
------------------------------------------------------------ */

app.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log("Walker Webs API");
  console.log(`Listening on ${HOST}:${PORT}`);
  console.log(`Health: /api/health`);
  console.log(`Firebase: ${firebaseReady ? "READY" : "NOT READY"}`);
  console.log(
    `AI: ${process.env.GROQ_KEY ? "CONFIGURED" : "NOT CONFIGURED"}`
  );
  console.log("========================================");
});
