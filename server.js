require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";

const PLAN_AMOUNTS = { single: 13, monthly: 50, lifetime: 120 };
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_BASE = String(process.env.TRONGRID_BASE_URL || "https://api.trongrid.io").replace(/\/$/, "");
const TRC20_WALLET = String(process.env.TRC20_WALLET || "").trim();

function normalizePrivateKey(v) { return String(v || "").replace(/\\n/g, "\n"); }
const required = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"];
const missing = required.filter(k => !String(process.env[k] || "").trim());

let db = null;
let firebaseReady = false;
if (!missing.length) {
  try {
    if (!admin.apps.length) admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
      })
    });
    db = admin.firestore();
    firebaseReady = true;
    console.log("Firebase Admin initialized.");
  } catch (e) { console.error("Firebase initialization failed:", e); }
} else console.warn("Missing Firebase env:", missing.join(", "));

const allowedOrigins = new Set([
  "https://walker-webs.web.app", "https://walker-webs.firebaseapp.com",
  "https://walker-webs-ai.onrender.com", "http://localhost:3000",
  "http://localhost:5173", "http://localhost:5500", "http://127.0.0.1:5500"
]);
function isAllowedOrigin(origin) {
  if (!origin || allowedOrigins.has(origin)) return true;
  try { const h = new URL(origin).hostname; return h.endsWith(".web.app") || h.endsWith(".firebaseapp.com"); }
  catch (_) { return false; }
}
app.use(cors({ origin(o, cb) { cb(null, isAllowedOrigin(o)); }, methods:["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders:["Content-Type","Authorization","Accept","Origin"], credentials:false, maxAge:86400 }));
app.options("*", cors());
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true,limit:"2mb"}));
app.use((req,res,next)=>{ const s=Date.now(); res.on("finish",()=>console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-s}ms)`)); next(); });

app.get("/", (_req,res)=>res.json({ok:true,service:"Walker Webs API",status:"online",health:"/api/health"}));

app.get("/api/health", async (_req,res)=>{
  let firestore = false, firestoreError = null;
  if (firebaseReady && db) {
    try { await db.collection("_system").doc("health").get(); firestore = true; }
    catch(e) { firestoreError = e.code || e.message; }
  }
  res.json({ok:true,service:"Walker Webs API",status:"online",firebase:firebaseReady,firestore,firestoreError,aiConfigured:Boolean(process.env.GROQ_KEY),tronConfigured:Boolean(process.env.TRONGRID_API_KEY && TRC20_WALLET),tronBase:TRON_BASE,timestamp:new Date().toISOString()});
});

async function requireAuth(req,res,next){
  try {
    if(!firebaseReady) return res.status(503).json({error:"Firebase Authentication is not configured on the backend."});
    const h=String(req.headers.authorization||"");
    if(!h.startsWith("Bearer ")) return res.status(401).json({error:"Authentication required."});
    req.user=await admin.auth().verifyIdToken(h.slice(7).trim());
    next();
  } catch(e){ console.error("AUTH ERROR:",e); res.status(401).json({error:"Invalid or expired authentication token."}); }
}
function userRef(uid){ return db.collection("users").doc(uid); }
async function ensureUser(uid,email){
  const ref=userRef(uid), snap=await ref.get();
  if(!snap.exists) await ref.set({uid,email:email||null,freeWebsitesRemaining:3,freeEditsRemaining:3,createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  return ref;
}
async function getUserData(uid,email){ const ref=await ensureUser(uid,email); const snap=await ref.get(); return {ref,data:snap.data()||{}}; }

async function groqChat(messages){
  if(!process.env.GROQ_KEY) throw new Error("GROQ_KEY is not configured on the backend.");
  const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${process.env.GROQ_KEY}`},body:JSON.stringify({model:process.env.GROQ_MODEL||"llama-3.3-70b-versatile",messages,temperature:.7})});
  const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{}}catch(_){ }
  if(!r.ok) throw new Error(d?.error?.message||`AI provider returned HTTP ${r.status}`);
  const c=d?.choices?.[0]?.message?.content; if(!c) throw new Error("AI provider returned no content."); return c;
}
function cleanHTML(v){return String(v||"").replace(/^\s*```html\s*/i,"").replace(/^\s*```\s*/i,"").replace(/\s*```\s*$/i,"").trim();}
function isHTML(v){const s=String(v||"").toLowerCase();return s.includes("<!doctype html")||s.includes("<html");}

app.post("/api/generate",async(req,res)=>{try{const prompt=String(req.body?.prompt||"").trim();if(!prompt)return res.status(400).json({error:"Website prompt is required."});if(prompt.length>6000)return res.status(400).json({error:"Prompt cannot exceed 6000 characters."});const html=cleanHTML(await groqChat([{role:"system",content:"You are a professional web developer. Generate a complete standalone HTML document. Return ONLY HTML, with CSS and JavaScript included. No Markdown fences."},{role:"user",content:prompt}]));if(!isHTML(html))return res.status(502).json({error:"The AI returned invalid HTML."});res.json({ok:true,html});}catch(e){console.error("GENERATE ERROR:",e);res.status(500).json({error:e.message||"Website generation failed."});}});

app.get("/api/usage",requireAuth,async(req,res)=>{try{const {data}=await getUserData(req.user.uid,req.user.email);res.json({ok:true,freeWebsitesRemaining:Number(data.freeWebsitesRemaining??3),freeEditsRemaining:Number(data.freeEditsRemaining??3)});}catch(e){console.error("USAGE ERROR:",e);res.status(500).json({error:"Unable to load usage."});}});

app.post("/api/edit",requireAuth,async(req,res)=>{try{const html=String(req.body?.html||""),instruction=String(req.body?.instruction||"").trim();if(!isHTML(html))return res.status(400).json({error:"Valid HTML is required."});if(!instruction)return res.status(400).json({error:"Edit instruction is required."});const {ref,data}=await getUserData(req.user.uid,req.user.email);const free=Number(data.freeEditsRemaining??3);if(free<=0&&!data.paidEditing)return res.status(402).json({error:"Payment required for additional AI edits."});const edited=cleanHTML(await groqChat([{role:"system",content:"Modify the supplied HTML according to the user's instruction. Preserve existing functionality. Return ONLY the complete HTML document."},{role:"user",content:`CURRENT HTML:\n${html}\n\nUSER INSTRUCTION:\n${instruction}`}]));if(!isHTML(edited))return res.status(502).json({error:"The AI returned invalid edited HTML."});if(!data.paidEditing)await ref.set({freeEditsRemaining:Math.max(0,free-1),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});const after=(await ref.get()).data()||{};res.json({ok:true,html:edited,paid:Boolean(data.paidEditing),freeWebsitesRemaining:Number(after.freeWebsitesRemaining??3),freeEditsRemaining:Number(after.freeEditsRemaining??0)});}catch(e){console.error("EDIT ERROR:",e);res.status(500).json({error:e.message||"Website editing failed."});}});

app.post("/api/publish",requireAuth,async(req,res)=>{try{const html=String(req.body?.html||""),prompt=String(req.body?.prompt||"");if(!isHTML(html))return res.status(400).json({error:"Valid HTML is required."});const {ref,data}=await getUserData(req.user.uid,req.user.email);const free=Number(data.freeWebsitesRemaining??3);if(free<=0&&!data.publishingAccess)return res.status(402).json({error:"Payment required for additional publishes."});const siteId=crypto.randomBytes(12).toString("hex");await db.collection("publishedSites").doc(siteId).set({siteId,ownerUid:req.user.uid,prompt,html,createdAt:admin.firestore.FieldValue.serverTimestamp()});if(!data.publishingAccess)await ref.set({freeWebsitesRemaining:Math.max(0,free-1),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});const base=process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`;res.json({ok:true,url:`${base}/p/${siteId}`,siteId});}catch(e){console.error("PUBLISH ERROR:",e);res.status(500).json({error:e.message||"Publishing failed."});}});
app.get("/p/:siteId",async(req,res)=>{try{if(!firebaseReady)return res.status(503).send("Publishing service unavailable.");const s=await db.collection("publishedSites").doc(req.params.siteId).get();if(!s.exists)return res.status(404).send("Website not found.");const html=String(s.data()?.html||"");if(!isHTML(html))return res.status(500).send("Published website is invalid.");res.type("html").send(html);}catch(e){console.error("PUBLIC SITE ERROR:",e);res.status(500).send("Unable to load published website.");}});

function validTxHash(v){return /^[a-fA-F0-9]{64}$/.test(String(v||"").trim());}
function planAmount(type){return PLAN_AMOUNTS[type];}
function tronHeaders(){const h={Accept:"application/json"};if(process.env.TRONGRID_API_KEY)h["TRON-PRO-API-KEY"]=process.env.TRONGRID_API_KEY;return h;}
async function tronGet(path){const r=await fetch(`${TRON_BASE}${path}`,{headers:tronHeaders()});const text=await r.text();let d={};try{d=text?JSON.parse(text):{}}catch(_){d={};}if(!r.ok)throw new Error(`TronGrid HTTP ${r.status}: ${d?.error||text||"request failed"}`);return d;}

/* Verify a specific transaction by looking at confirmed TRC20 transfers for the destination wallet. */
async function verifyUSDTTransfer(txHash,expectedAmount){
  if(!TRC20_WALLET) throw new Error("TRC20_WALLET is not configured.");
  const qs=new URLSearchParams({limit:"200",only_confirmed:"true",contract_address:USDT_CONTRACT,only_to:"true",order_by:"block_timestamp,desc"});
  const data=await tronGet(`/v1/accounts/${encodeURIComponent(TRC20_WALLET)}/transactions/trc20?${qs}`);
  const tx=(data?.data||[]).find(t=>String(t.transaction_id||t.txID||t.transactionId||"").toLowerCase()===txHash.toLowerCase());
  if(!tx) return {ok:false,reason:"Confirmed USDT transfer was not found for the configured wallet."};
  const decimals=Number(tx.token_info?.decimals ?? 6);
  const raw=String(tx.value??tx.amount??"0");
  const actual=Number(raw)/10**decimals;
  if(String(tx.token_info?.address||tx.contract_address||USDT_CONTRACT)!==USDT_CONTRACT){return {ok:false,reason:"Transaction is not the official USDT TRC20 token."};}
  if(Math.abs(actual-expectedAmount)>0.000001)return {ok:false,reason:`Payment amount is ${actual} USDT; expected ${expectedAmount} USDT.`};
  return {ok:true,from:tx.from,to:tx.to,amount:actual,timestamp:tx.block_timestamp||null};
}

async function creditPayment(paymentId){
  const pRef=db.collection("payments").doc(paymentId);
  return db.runTransaction(async t=>{
    const pSnap=await t.get(pRef);if(!pSnap.exists)throw new Error("Payment record not found.");const p=pSnap.data();
    if(p.status==="approved")return p;
    const uRef=userRef(p.uid),uSnap=await t.get(uRef);const u=uSnap.exists?uSnap.data():{};
    const update={updatedAt:admin.firestore.FieldValue.serverTimestamp()};
    if(p.type==="single"){update.publishingAccess=true;update.paidEditing=true;update.publishingCredits=admin.firestore.FieldValue.increment(1);update.editingCredits=admin.firestore.FieldValue.increment(1);}
    if(p.type==="monthly"){update.publishingAccess=true;update.paidEditing=true;update.subscriptionType="monthly";update.subscriptionExpiresAt=admin.firestore.Timestamp.fromMillis(Date.now()+30*24*60*60*1000);}
    if(p.type==="lifetime"){update.publishingAccess=true;update.paidEditing=true;update.subscriptionType="lifetime";update.subscriptionExpiresAt=null;}
    t.set(uRef,update,{merge:true});t.update(pRef,{status:"approved",approvedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});return {...p,status:"approved"};
  });
}

app.post("/api/payments/submit",requireAuth,async(req,res)=>{try{if(!firebaseReady)return res.status(503).json({error:"Payment database is not configured."});const type=String(req.body?.type||"");const amount=Number(req.body?.amount);const txHash=String(req.body?.txHash||"").trim();if(!(type in PLAN_AMOUNTS))return res.status(400).json({error:"Invalid payment plan."});if(amount!==planAmount(type))return res.status(400).json({error:`Invalid amount for ${type} plan. Expected ${planAmount(type)} USDT.`});if(!validTxHash(txHash))return res.status(400).json({error:"Invalid TRON transaction hash."});const duplicate=await db.collection("payments").where("txHash","==",txHash).limit(1).get();if(!duplicate.empty)return res.status(409).json({error:"This transaction has already been submitted."});const ref=db.collection("payments").doc();await ref.set({paymentId:ref.id,uid:req.user.uid,email:req.user.email||null,amount,type,txHash,status:"pending",createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  try{const result=await verifyUSDTTransfer(txHash,amount);if(result.ok){await creditPayment(ref.id);return res.status(200).json({ok:true,paymentId:ref.id,status:"confirmed",message:"Payment confirmed and access activated."});}await ref.update({lastCheckReason:result.reason,updatedAt:admin.firestore.FieldValue.serverTimestamp()});return res.status(202).json({ok:true,paymentId:ref.id,status:"pending",message:result.reason||"Payment is awaiting confirmation."});}
  catch(e){console.error("PAYMENT VERIFICATION ERROR:",e);await ref.update({lastCheckError:e.message,updatedAt:admin.firestore.FieldValue.serverTimestamp()});return res.status(202).json({ok:true,paymentId:ref.id,status:"pending",message:"Payment was recorded. Blockchain verification is temporarily unavailable; the server will retry automatically."});}
}catch(e){console.error("PAYMENT SUBMIT ERROR:",e);res.status(500).json({error:e.message||"Unable to submit payment."});}});

app.get("/api/payments/:paymentId",requireAuth,async(req,res)=>{try{if(!firebaseReady)return res.status(503).json({error:"Payment database is not configured."});const s=await db.collection("payments").doc(req.params.paymentId).get();if(!s.exists)return res.status(404).json({error:"Payment not found."});const p=s.data();if(p.uid!==req.user.uid)return res.status(403).json({error:"You cannot access this payment."});if(p.status==="pending"){try{const v=await verifyUSDTTransfer(p.txHash,Number(p.amount));if(v.ok)await creditPayment(req.params.paymentId);else await s.ref.update({lastCheckReason:v.reason,updatedAt:admin.firestore.FieldValue.serverTimestamp()});}catch(e){console.error("PAYMENT CHECK ERROR:",e.message);}}
  const latest=await s.ref.get();const p2=latest.data()||p;res.json({ok:true,paymentId:p2.paymentId,status:p2.status||"pending",reason:p2.lastCheckReason||p2.reason||null});}catch(e){console.error("PAYMENT STATUS ERROR:",e);res.status(500).json({error:"Unable to check payment status."});}});

/* Background scanner: errors are logged but NEVER crash the server. */
let scanBusy=false;
async function scanPendingPayments(){
  if(scanBusy||!firebaseReady||!TRC20_WALLET)return;scanBusy=true;
  try{
    const snap=await db.collection("payments").where("status","==","pending").limit(25).get();
    for(const doc of snap.docs){
      const p=doc.data();
      try{const v=await verifyUSDTTransfer(p.txHash,Number(p.amount));if(v.ok){await creditPayment(doc.id);console.log(`PAYMENT APPROVED ${doc.id} ${p.txHash}`);}else await doc.ref.update({lastCheckReason:v.reason,updatedAt:admin.firestore.FieldValue.serverTimestamp()});}
      catch(e){console.error(`PAYMENT CHECK FAILED ${doc.id}:`,e.message);}
    }
  }catch(e){console.error("PAYMENT SCAN ERROR:",e.code||e.message||e);}
  finally{scanBusy=false;}
}
setInterval(scanPendingPayments,30000);
setTimeout(scanPendingPayments,5000);

app.use((req,res)=>res.status(404).json({error:"Route not found.",method:req.method,path:req.originalUrl}));
app.use((err,_req,res,_next)=>{console.error("UNHANDLED ERROR:",err);res.status(500).json({error:"Internal server error."});});

app.listen(PORT,HOST,()=>{console.log("========================================");console.log("Walker Webs API");console.log(`Listening on ${HOST}:${PORT}`);console.log(`Firebase: ${firebaseReady?"READY":"NOT READY"}`);console.log(`Firestore: ${firebaseReady?"CHECKING":"NOT READY"}`);console.log(`AI: ${process.env.GROQ_KEY?"CONFIGURED":"NOT CONFIGURED"}`);console.log(`TRON: ${TRC20_WALLET?"CONFIGURED":"NOT CONFIGURED"}`);console.log(`TRON base: ${TRON_BASE}`);console.log("========================================");});
