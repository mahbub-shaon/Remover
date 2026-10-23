import fetch from "node-fetch";
import crypto from "crypto";

const UA_LIST = [
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
];

const DEFAULT_BACKEND_HOSTS = [
  "https://awh5tmpjds.us-east-1.awsapprunner.com"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AccountPool {
  constructor(max = 40) {
    this.max = max;
    this.accounts = [];
  }
  take() {
    const acc = this.accounts.find((a) => a.credits > 0);
    if (acc) { acc.credits -= 1; return acc; }
    return null;
  }
  put(acc) {
    if (!acc) return;
    this.accounts.push(acc);
    while (this.accounts.length > this.max) this.accounts.shift();
  }
  stats() {
    return {
      size: this.accounts.length,
      available: this.accounts.filter((a) => a.credits > 0).length
    };
  }
}

export default class UndressAI {
  constructor(opts = {}) {
    const envHosts = (process.env.BACKEND_HOSTS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);

    this.apiKey = opts.apiKey || "AIzaSyD_omM03MyUQdBNAQ3lW0RzjRS5x29GDnM";
    this.backendHosts = [...new Set([
      ...(opts.backendHosts || []),
      ...envHosts,
      ...DEFAULT_BACKEND_HOSTS
    ])];
    this.activeBackend = null;
    this.maskHost = opts.maskHost || process.env.MASK_HOST || "https://mkv2.undressaitools.net";
    this.genHost = opts.genHost || process.env.GEN_HOST || "https://igv2.undressaitools.net";
    this.siteOrigin = "https://undressaitools.net";
    this.authUrl = "https://identitytoolkit.googleapis.com/v1/accounts";
    this.basicAuth = "Basic cG9ybmdlbjpwb3JuZ2Vu";
    this.timeout = opts.timeout || 60000;
    this.pool = opts.pool || null;
    this.debug = opts.debug || process.env.DEBUG === "1";
    this.lastGuestError = null;
    this.candidates = [];
    this.ua = UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

    this.commonHeaders = {
      "User-Agent": this.ua,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "id-ID",
      Origin: this.siteOrigin,
      Referer: `${this.siteOrigin}/`,
      "sec-ch-ua": '"Chromium";v="127", "Not)A;Brand";v="99"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site"
    };
  }

  log(msg) {
    if (this.debug) console.log(`[UndressAI] ${new Date().toISOString()} -> ${msg}`);
  }

  randHex(len) { return crypto.randomBytes(len).toString("hex"); }
  md5(str) { return crypto.createHash("md5").update(str).digest("hex"); }
  genBaseFingerprint() {
    let s = "";
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 10);
    return s;
  }

  async req(url, options = {}, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs || this.timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (i < items.length) {
          const idx = i++;
          try { out[idx] = await fn(items[idx]); }
          catch (e) { out[idx] = { error: e.message }; }
        }
      }
    );
    await Promise.all(workers);
    return out;
  }

  async fetchText(url, timeoutMs = 12000) {
    const r = await this.req(url, { headers: { "User-Agent": this.ua } }, timeoutMs);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }

  /* ---------------------------------------------------------------- */
  /*  CANDIDATE COLLECTION — সাইটের সব JS স্ক্যান করে origin বের করে  */
  /* ---------------------------------------------------------------- */

  async collectCandidateOrigins() {
    const origins = new Set();

    const add = (raw) => {
      try {
        const u = new URL(raw);
        if (!/\.(png|jpe?g|webp|gif|svg|css|woff2?|ico|map)$/i.test(u.pathname)) {
          origins.add(u.origin);
        }
      } catch { /* ignore */ }
    };

    const scan = (text) => {
      const re = /https?:\/\/[a-z0-9.-]+(?::\d+)?/gi;
      let m;
      while ((m = re.exec(text))) add(m[0]);
    };

    let html = "";
    try {
      html = await this.fetchText(this.siteOrigin + "/");
      scan(html);
    } catch (e) {
      this.log(`homepage fetch failed: ${e.message}`);
    }

    // সব <script src> এবং _next chunk
    const scripts = new Set();
    for (const m of html.matchAll(/(?:src|href)="([^"]+\.m?js(?:\?[^"]*)?)"/g)) {
      scripts.add(m[1]);
    }
    // Next.js webpack runtime থেকে chunk নাম
    try {
      const wp = await this.fetchText(this.siteOrigin + "/_next/static/chunks/webpack.js")
        .catch(() => "");
      for (const m of wp.matchAll(/"static\/chunks\/([^"]+\.js)"/g)) {
        scripts.add(`/_next/static/chunks/${m[1]}`);
      }
    } catch { /* ignore */ }

    const scriptList = [...scripts].slice(0, 40);
    await this.mapLimit(scriptList, 8, async (s) => {
      try {
        const u = s.startsWith("http") ? s : new URL(s, this.siteOrigin + "/").href;
        scan(await this.fetchText(u, 12000));
      } catch { /* ignore */ }
    });

    // heuristic candidate
    for (const p of ["", "api.", "backend.", "app.", "api2.", "ut.", "b."]) {
      origins.add(`https://${p}undressaitools.net`);
    }

    // prioritize সম্ভাব্য backend
    const score = (o) =>
      (/awsapprunner\.com/.test(o) ? 100 : 0) +
      (/undressaitools\.net/.test(o) ? 40 : 0) +
      (/onrender|railway|fly\.dev|herokuapp/.test(o) ? 20 : 0);

    const list = [...origins].sort((a, b) => score(b) - score(a));
    this.candidates = list;
    this.log(`candidates (${list.length}): ${list.slice(0, 15).join(", ")}`);
    return list;
  }

  /* ---------------------------------------------------------------- */
  /*  PROBE — সত্যিকারের /guest কল দিয়ে জীবিত host খুঁজে বের করে     */
  /* ---------------------------------------------------------------- */

  async probeGuest(origin, timeoutMs = 6000) {
    try {
      const res = await this.req(
        `${origin}/guest?fingerprint=${this.genBaseFingerprint()}`,
        {
          method: "GET",
          headers: { "User-Agent": this.ua, Authorization: this.basicAuth, Accept: "*/*" }
        },
        timeoutMs
      );
      const text = res.ok ? (await res.text()).trim() : "";
      return {
        origin,
        ok: res.ok && !!text,
        status: res.status,
        sample: text.slice(0, 60)
      };
    } catch (e) {
      return { origin, ok: false, error: e.message };
    }
  }

  async probeAll(timeoutMs = 6000) {
    const list = this.candidates.length
      ? this.candidates
      : await this.collectCandidateOrigins();
    return this.mapLimit(list, 10, (o) => this.probeGuest(o, timeoutMs));
  }

  /* ---------------------------------------------------------------- */
  /*  GUEST                                                           */
  /* ---------------------------------------------------------------- */

  async tryGuest(hosts, mode, baseFp) {
    for (const host of hosts) {
      try {
        const headers = mode === "minimal"
          ? { "User-Agent": this.ua, Authorization: this.basicAuth, Accept: "*/*" }
          : { ...this.commonHeaders, Authorization: this.basicAuth, Accept: "*/*" };

        const res = await this.req(`${host}/guest?fingerprint=${baseFp}`,
          { method: "GET", headers }, 15000);

        if (res.ok) {
          const text = (await res.text()).trim();
          if (!text) { this.lastGuestError = `${host} -> 200 কিন্তু খালি body`; continue; }
          this.activeBackend = host;
          this.backendHosts = [host, ...this.backendHosts.filter((h) => h !== host)];
          this.log(`guest ok @ ${host} (${mode})`);
          return text;
        }

        const body = (await res.text().catch(() => "")).slice(0, 140).replace(/\s+/g, " ");
        this.lastGuestError = `${host} [${mode}] -> HTTP ${res.status} ${body}`;
      } catch (e) {
        this.lastGuestError = `${host} [${mode}] -> ${e.name}: ${e.message}`;
      }
      this.log(this.lastGuestError);
    }
    return null;
  }

  async stepGuest(baseFp) {
    // ১. পরিচিত host — full header
    let id = await this.tryGuest(this.backendHosts, "full", baseFp);
    if (id) return id;

    // ২. পরিচিত host — minimal header
    id = await this.tryGuest(this.backendHosts, "minimal", baseFp);
    if (id) return id;

    // ৩. সাইট স্ক্যান করে সব candidate জোগাড়
    const candidates = await this.collectCandidateOrigins();

    // ৪. প্রতিটা candidate-কে সত্যিকারের guest কল দিয়ে probe
    const results = await this.mapLimit(candidates, 10, (o) => this.probeGuest(o, 8000));
    const alive = results.filter((r) => r && r.ok).map((r) => r.origin);

    if (alive.length) {
      this.log(`alive backends: ${alive.join(", ")}`);
      this.backendHosts = [...new Set([...alive, ...this.backendHosts])];
      id = await this.tryGuest(alive, "full", baseFp);
      if (id) return id;
      id = await this.tryGuest(alive, "minimal", baseFp);
      if (id) return id;
    }

    throw new Error(
      `Backend Init Failed :: ${this.lastGuestError || "কোনো host reachable নয়"} ` +
      `| candidates=${candidates.length} alive=${alive.length}`
    );
  }

  /* ---------------------------------------------------------------- */
  /*  বাকি ধাপ                                                        */
  /* ---------------------------------------------------------------- */

  async stepMask(guestId, b64) {
    const taskId = this.randHex(16);
    const res = await this.req(`${this.maskHost}/mask`, {
      method: "POST",
      headers: {
        ...this.commonHeaders,
        Authorization: this.basicAuth,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-site"
      },
      body: JSON.stringify({
        task_id: taskId,
        image_base64: `data:image/jpeg;base64,${b64}`,
        user_id: guestId,
        operation: "undress",
        continent: "NA",
        country: "US"
      })
    });
    if (!res.ok) throw new Error(`Mask Error: HTTP ${res.status} @ ${this.maskHost}`);
    const data = await res.json();
    return { tid: data.task_id, mask: data.mask_base64, orig: data.image_base64 };
  }

  async stepFirebaseAuth() {
    const email = `${this.randHex(8)}-${this.randHex(4)}@emailhook.site`;
    const password = `${this.randHex(10)}Aa1`;
    const res = await this.req(`${this.authUrl}:signUp?key=${this.apiKey}`, {
      method: "POST",
      headers: {
        ...this.commonHeaders,
        "Content-Type": "application/json",
        "x-client-version": "Chrome/JsCore/10.12.1/FirebaseCore-web",
        "x-firebase-gmpid": "1:786150664182:web:f2c1c95933d234095a09d7",
        Accept: "*/*"
      },
      body: JSON.stringify({
        returnSecureToken: true, email, password, clientType: "CLIENT_TYPE_WEB"
      })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Auth Error: HTTP ${res.status} ${t.slice(0, 140)}`);
    }
    const data = await res.json();
    this.req(`${this.authUrl}:lookup?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: data.idToken })
    }).catch(() => {});
    return { uid: data.localId, email: data.email };
  }

  async stepBackendReg(firebaseUid, email, baseFp) {
    if (!this.activeBackend) throw new Error("No active backend");
    const complexFp = `${baseFp}_${this.md5(firebaseUid + baseFp)}`;
    const res = await this.req(`${this.activeBackend}/users`, {
      method: "POST",
      headers: {
        ...this.commonHeaders,
        Authorization: this.basicAuth,
        "Content-Type": "application/json",
        Accept: "*/*"
      },
      body: JSON.stringify({
        user: {
          firebase_id: firebaseUid,
          email,
          product_enum: "UT",
          browser_fingerprint: complexFp,
          metadata: { utm_source: "porndude", utm_content: "aiundress" }
        }
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Reg Error HTTP ${res.status}: ${txt.slice(0, 180)}`);
    }
    const data = await res.json();
    return data.user_id;
  }

  async stepCheckBalance(userId) {
    try {
      const res = await this.req(`${this.activeBackend}/balance?user_id=${userId}`, {
        method: "GET",
        headers: {
          ...this.commonHeaders, Authorization: this.basicAuth, "X-Client": "fantasy-new"
        }
      });
      const data = await res.json();
      this.req(`${this.activeBackend}/users?user_id=${userId}`, {
        method: "GET",
        headers: {
          ...this.commonHeaders, Authorization: this.basicAuth, "X-Client": "fantasy-new"
        }
      }).catch(() => {});
      const gem = Array.isArray(data) ? data.find((x) => x.amount >= 0) : null;
      return gem ? gem.amount : -1;
    } catch { return -1; }
  }

  async stepExec(p) {
    const res = await this.req(`${this.genHost}/undress_get_resuls`, {
      method: "POST",
      headers: {
        ...this.commonHeaders,
        Authorization: this.basicAuth,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-site"
      },
      body: JSON.stringify({
        uiid: p.tid, uid: p.uid, masks: p.mask, original: p.orig,
        operation: "undress",
        breast_size: p.breast_size ?? 0,
        pubic_hair: p.pubic_hair ?? 0,
        body_size: p.body_size ?? 0,
        product: "UT", image_format: "base64",
        prompt: p.prompt || "", watermark: "ai1",
        quality: p.quality || "low"
      })
    }, 120000);
    if (!res.ok) throw new Error(`Exec Error: HTTP ${res.status} @ ${this.genHost}`);
    const data = await res.json();
    if (data.code === 6100) return data.data;
    throw new Error(data.msg || "Generation Failed");
  }

  async processImg(input) {
    if (Buffer.isBuffer(input)) return input.toString("base64");
    if (typeof input === "string") {
      if (input.startsWith("http")) {
        const r = await this.req(input, {}, 30000);
        if (!r.ok) throw new Error("Failed to fetch image");
        return Buffer.from(await r.arrayBuffer()).toString("base64");
      }
      return input.replace(/^data:image\/\w+;base64,/, "");
    }
    throw new Error("Invalid Image");
  }

  async getAccount(baseFp) {
    if (this.pool) {
      const pooled = this.pool.take();
      if (pooled) {
        this.activeBackend = pooled.backend;
        return pooled;
      }
    }
    for (let i = 0; i < 4; i++) {
      try {
        if (!this.activeBackend) await this.stepGuest(baseFp);
        const { uid, email } = await this.stepFirebaseAuth();
        const backendId = await this.stepBackendReg(uid, email, baseFp);
        const credits = await this.stepCheckBalance(backendId);
        if (credits < 0) continue;
        const acc = {
          uid, email, backendId,
          credits: Math.max(credits - 1, 0),
          backend: this.activeBackend
        };
        if (this.pool) this.pool.put(acc);
        return acc;
      } catch (e) {
        this.log(`account retry ${i + 1}: ${e.message}`);
        await sleep(300);
      }
    }
    throw new Error("Failed to create valid account");
  }

  async generate({ prompt = "", imageUrl, imageBuffer, ...rest }) {
    const baseFp = this.genBaseFingerprint();
    const guestId = await this.stepGuest(baseFp);
    const b64 = await this.processImg(imageBuffer || imageUrl);
    const maskData = await this.stepMask(guestId, b64);

    let account = await this.getAccount(baseFp);
    let finalB64 = null;

    for (let i = 0; i < 3; i++) {
      try {
        finalB64 = await this.stepExec({
          tid: maskData.tid, uid: account.backendId,
          mask: maskData.mask, orig: maskData.orig,
          prompt, ...rest
        });
        break;
      } catch (e) {
        this.log(`exec fail (${e.message}), new account...`);
        account = await this.getAccount(baseFp);
      }
    }
    if (!finalB64) throw new Error("Generation Failed after retries");
    return Buffer.from(finalB64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  }

  async diagnose({ imageUrl, imageBuffer } = {}) {
    const report = {
      ok: false, vercel: !!process.env.VERCEL,
      knownHosts: [...this.backendHosts],
      maskHost: this.maskHost, genHost: this.genHost,
      steps: {}
    };
    const baseFp = this.genBaseFingerprint();

    try {
      const cands = await this.collectCandidateOrigins();
      report.steps.discovery = { ok: true, count: cands.length, sample: cands.slice(0, 25) };
    } catch (e) {
      report.steps.discovery = { ok: false, error: e.message };
    }

    try {
      const probes = await this.probeAll(8000);
      report.steps.probe = {
        ok: true,
        alive: probes.filter((p) => p && p.ok).map((p) => p.origin),
        tried: probes.length
      };
    } catch (e) {
      report.steps.probe = { ok: false, error: e.message };
    }

    let guestId;
    try {
      guestId = await this.stepGuest(baseFp);
      report.steps.guest = { ok: true, host: this.activeBackend, id: guestId };
    } catch (e) {
      report.steps.guest = { ok: false, error: e.message, lastError: this.lastGuestError };
      return report;
    }

    let b64 = null;
    if (imageUrl || imageBuffer) {
      try {
        b64 = await this.processImg(imageBuffer || imageUrl);
        report.steps.image = { ok: true, bytes: b64.length };
      } catch (e) {
        report.steps.image = { ok: false, error: e.message };
      }
    }
    if (b64) {
      try {
        const m = await this.stepMask(guestId, b64);
        report.steps.mask = { ok: true, taskId: m.tid };
      } catch (e) {
        report.steps.mask = { ok: false, error: e.message };
      }
    }

    try {
      const { uid, email } = await this.stepFirebaseAuth();
      report.steps.firebase = { ok: true, uid };
      try {
        const backendId = await this.stepBackendReg(uid, email, baseFp);
        const bal = await this.stepCheckBalance(backendId);
        report.steps.backend = { ok: true, backendId, credits: bal };
        report.ok = true;
      } catch (e) {
        report.steps.backend = { ok: false, error: e.message };
      }
    } catch (e) {
      report.steps.firebase = { ok: false, error: e.message };
    }

    return report;
  }
}
