import express from "express";
import cors from "cors";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import UndressAI, { AccountPool } from "./undressai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_VERCEL = !!process.env.VERCEL;

// Vercel-এ ফাইল সিস্টেম read-only, শুধু /tmp লেখা যায়
const ROOT = IS_VERCEL ? "/tmp" : path.join(__dirname, "public");
const ORIG_DIR = path.join(ROOT, "originals");
const RES_DIR = path.join(ROOT, "results");

let dirsReady = false;
function ensureDirs() {
  if (dirsReady) return;
  for (const d of [ORIG_DIR, RES_DIR]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (e) {
      console.error("mkdir failed:", d, e.message);
    }
  }
  dirsReady = true;
}

const PORT = process.env.PORT || 3000;
const OWNER = process.env.API_OWNER || "example";
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);

const pool = new AccountPool(50);

class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.waiters = []; }
  async acquire() {
    if (this.active < this.max) { this.active++; return; }
    await new Promise((r) => this.waiters.push(r));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
const sem = new Semaphore(CONCURRENCY);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

/* ------------------------------------------------------------------ */
/*  MAIN ENDPOINT                                                      */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const imgurl =
    req.query.imgurl || req.query.imageUrl || req.query.url || req.body?.imgurl;

  if (!imgurl) {
    return res.status(400).json({
      success: false,
      api_owner: OWNER,
      error: "Parameter 'imgurl' diperlukan"
    });
  }

  ensureDirs();
  const id = crypto.randomBytes(8).toString("hex");
  const started = Date.now();

  await sem.acquire();
  try {
    const imgRes = await fetch(imgurl);
    if (!imgRes.ok) throw new Error(`Gagal mengambil gambar (HTTP ${imgRes.status})`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const ct = imgRes.headers.get("content-type") || "image/jpeg";
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    const origName = `orig_${id}.${ext}`;
    await fsp.writeFile(path.join(ORIG_DIR, origName), buf);

    const api = new UndressAI({ pool });
    const result = await api.generate({ imageBuffer: buf });

    const resName = `result_${id}.png`;
    await fsp.writeFile(path.join(RES_DIR, resName), result);

    const base = baseUrl(req);
    return res.json({
      success: true,
      api_owner: OWNER,
      original_image: `${base}/files/originals/${origName}`,
      result_image: `${base}/files/results/${resName}`,
      took_ms: Date.now() - started
    });
  } catch (e) {
    console.error("HANDLE ERROR:", e);
    return res.status(500).json({
      success: false,
      api_owner: OWNER,
      error: e.message || "Terjadi kesalahan saat memproses"
    });
  } finally {
    sem.release();
  }
}

app.get("/api/cloth-remove", handle);
app.post("/api/cloth-remove", handle);

/* ------------------------------------------------------------------ */
/*  DEBUG ENDPOINT — কোন ধাপে কী হচ্ছে দেখায়                          */
/* ------------------------------------------------------------------ */

app.get("/api/debug", async (req, res) => {
  const imgurl = req.query.imgurl || null;
  try {
    const api = new UndressAI({ debug: true });
    const report = await api.diagnose({ imageUrl: imgurl });
    return res.json({ api_owner: OWNER, ...report });
  } catch (e) {
    console.error("DEBUG ERROR:", e);
    return res.status(500).json({
      api_owner: OWNER,
      ok: false,
      error: e.message
    });
  }
});

/* ------------------------------------------------------------------ */
/*  HEALTH                                                             */
/* ------------------------------------------------------------------ */

app.get("/api/health", (req, res) => {
  res.json({ ok: true, api_owner: OWNER, pool: pool.stats() });
});

/* ------------------------------------------------------------------ */
/*  FILE SERVING (/tmp থেকে)                                           */
/* ------------------------------------------------------------------ */

app.get("/files/:type/:name", (req, res) => {
  const dir = req.params.type === "results" ? RES_DIR : ORIG_DIR;
  const file = path.join(dir, path.basename(req.params.name));
  if (!fs.existsSync(file)) {
    return res.status(404).json({ success: false, error: "File not found" });
  }
  res.sendFile(file);
});

/* ------------------------------------------------------------------ */
/*  HOME PAGE                                                          */
/* ------------------------------------------------------------------ */

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Cloth Remove API</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;background:#0d1117;color:#e6edf3}
 input,button{font-size:16px;padding:10px;border-radius:8px;border:1px solid #30363d;width:100%;box-sizing:border-box}
 button{margin-top:10px;background:#238636;color:#fff;border:none;cursor:pointer}
 button.dbg{background:#1f6feb}
 img{max-width:100%;border-radius:10px;margin-top:12px;border:1px solid #30363d}
 .row{display:flex;gap:12px;flex-wrap:wrap}.col{flex:1;min-width:220px}
 small{color:#8b949e} pre{background:#161b22;padding:12px;border-radius:8px;overflow:auto;font-size:12px}
 a{color:#58a6ff}
</style></head><body>
<h2>Cloth Remove API</h2>
<small>api_owner: ${OWNER} &nbsp;|&nbsp; <a href="/api/debug">/api/debug</a> &nbsp;|&nbsp; <a href="/api/health">/api/health</a></small>
<p><input id="u" placeholder="Image URL paste koro..." /></p>
<button onclick="go()">Process</button>
<button class="dbg" onclick="dbg()">Run Debug</button>
<div id="out"></div>
<script>
async function go(){
 const u=document.getElementById('u').value.trim();
 const out=document.getElementById('out');
 if(!u)return;
 out.innerHTML='<p>Processing... (20-60s)</p>';
 try{
  const r=await fetch('/api/cloth-remove?imgurl='+encodeURIComponent(u));
  const j=await r.json();
  if(!j.success){out.innerHTML='<pre>'+JSON.stringify(j,null,2)+'</pre>';return;}
  out.innerHTML='<div class="row"><div class="col"><b>Original</b><img src="'+j.original_image+'"></div>'+
                '<div class="col"><b>Result</b><img src="'+j.result_image+'"></div></div>';
 }catch(e){out.innerHTML='Error: '+e.message;}
}
async function dbg(){
 const u=document.getElementById('u').value.trim();
 const out=document.getElementById('out');
 out.innerHTML='<p>Debug running...</p>';
 try{
  const r=await fetch('/api/debug'+(u?'?imgurl='+encodeURIComponent(u):''));
  const j=await r.json();
  out.innerHTML='<pre>'+JSON.stringify(j,null,2)+'</pre>';
 }catch(e){out.innerHTML='Error: '+e.message;}
}
</script></body></html>`);
});

export default app;

// লোকালে listen; Vercel-এ handler হিসেবে export হয়
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`API jalan di http://localhost:${PORT}`);
  });
}
