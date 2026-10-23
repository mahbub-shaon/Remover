import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import UndressAI, { AccountPool } from "./undressai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OWNER = process.env.API_OWNER || "example";
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);

const ORIG_DIR = path.join(__dirname, "public", "originals");
const RES_DIR = path.join(__dirname, "public", "results");
await fs.mkdir(ORIG_DIR, { recursive: true });
await fs.mkdir(RES_DIR, { recursive: true });

// সার্ভার লাইফটাইমে শেয়ারড পুল — Firebase signup কমায়
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
app.use("/files", express.static(path.join(__dirname, "public")));

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

  const id = crypto.randomBytes(8).toString("hex");
  const started = Date.now();

  await sem.acquire();
  try {
    // original image নামিয়ে সেভ করা
    const imgRes = await fetch(imgurl);
    if (!imgRes.ok) throw new Error(`Gagal mengambil gambar (${imgRes.status})`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const ct = imgRes.headers.get("content-type") || "image/jpeg";
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    const origName = `orig_${id}.${ext}`;
    await fs.writeFile(path.join(ORIG_DIR, origName), buf);

    // প্রসেস
    const api = new UndressAI({ pool });
    const result = await api.generate({ imageBuffer: buf });

    const resName = `result_${id}.png`;
    await fs.writeFile(path.join(RES_DIR, resName), result);

    const base = `${req.protocol}://${req.get("host")}`;
    return res.json({
      success: true,
      api_owner: OWNER,
      original_image: `${base}/files/originals/${origName}`,
      result_image: `${base}/files/results/${resName}`,
      took_ms: Date.now() - started
    });
  } catch (e) {
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

app.get("/", (req, res) => {
  res.json({
    name: "Cloth Remove API",
    api_owner: OWNER,
    endpoint: "/api/cloth-remove?imgurl={image_url}",
    pool: pool.stats()
  });
});

app.listen(PORT, () => {
  console.log(`✅ Cloth Remove API jalan di http://localhost:${PORT}`);
  console.log(`   GET /api/cloth-remove?imgurl=<url>`);
});
