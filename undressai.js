import fetch from "node-fetch";
import crypto from "crypto";

const UA_LIST = [
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
];

// সম্ভাব্য backend host। প্রথমটা verified; বাকিগুলো fallback।
// discovery ফিচার নতুন host পেলে নিজে যোগ করে নেবে।
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
    this.apiKey = opts.apiKey || "AIzaSyD_omM03MyUQdBNAQ3lW0RzjRS5x29GDnM";
    this.backendHosts = [...(opts.backendHosts || DEFAULT_BACKEND_HOSTS)];
    this.activeBackend = null;
    this.maskHost = opts.maskHost || "https://mkv2.undressaitools.net";
    this.genHost = opts.genHost || "https://igv2.undressaitools.net";
    this.siteOrigin = "https://undressaitools.net";
    this.authUrl = "https://identitytoolkit.googleapis.com/v1/accounts";
    this.basicAuth = "Basic cG9ybmdlbjpwb3JuZ2Vu";
    this.timeout = opts.timeout || 60000;
    this.pool = opts.pool || null;
    this.debug = opts.debug || process.env.DEBUG === "1";
    this.lastGuestError = null;
    this.discoveredHosts = [];
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

  async retry(fn, times = 3, label = "task") {
    let lastErr;
    for (let i = 0; i < times; i++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        this.log(`retry ${i + 1}/${times} [${label}] -> ${e.message}`);
        await sleep(300 * (i + 1) + Math.floor(Math.random() * 250));
      }
    }
    throw lastErr;
  }

  /** সাইটের JS bundle থেকে live backend host খুঁজে বের করে (self-healing) */
  async discoverBackendHosts() {
    const found = new Set();
    const re = /https:\/\/[a-z0-9-]+\.(?:us|eu|ap|sa|ca|me|af)-[a-z]+-\d\.awsapprunner\.com/gi;
    const scan = (text) => {
      let m;
      while ((m = re.exec(text))) found.add(m[0]);
    };
    try {
      const r = await this.req(this.siteOrigin + "/", {
        headers: { "User-Agent": this.ua }
      }, 12000);
      const html = await r.text();
      scan(html);

      const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)]
        .map((m) => m[1])
        .slice(0, 15);

      await Promise.all(scripts.map(async (s) => {
        try {
          const u = s.startsWith("http") ? s : new URL(s, this.siteOrigin + "/").href;
          const rr = await this.req(u, { headers: { "User-Agent": this.ua } }, 12000);
          scan(await rr.text());
        } catch { /* ignore */ }
      }));
    } catch (e) {
      this.log(`discovery failed: ${e.message}`);
    }
    this.discoveredHosts = [...found];
    this.log(`discovered hosts: ${this.discoveredHosts.join(", ") || "(none)"}`);
    return this.discoveredHosts;
  }

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
          if (!this.backendHosts.includes(host)) this.backendHosts.unshift(host);
          this.log(`guest ok @ ${host} (${mode})`);
          return text;
        }

        const body = (await res.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
        this.lastGuestError = `${host} [${mode}] -> HTTP ${res.status} ${body}`;
        this.log(this.lastGuestError);
      } catch (e) {
        this.lastGuestError = `${host} [${mode}] -> ${e.name}: ${e.message}`;
        this.log(this.lastGuestError);
      }
    }
    return null;
  }

  async stepGuest(baseFp) {
    // ১. পরিচিত host, পূর্ণ header
    let id = await this.tryGuest(this.backendHosts, "full", baseFp);
    if (id) return id;

    // ২. পরিচিত host, minimal header (WAF-এ আটকালে কাজে দেয়)
    id = await this.tryGuest(this.backendHosts, "minimal", baseFp);
    if (id) return id;

    // ৩. live discovery
    const hosts = await this.discoverBackendHosts();
    const fresh = hosts.filter((h) => !this.backendHosts.includes(h));
    if (fresh.length) {
      id = await this.tryGuest(fresh, "full", baseFp);
      if (id) return id;
      id = await this.tryGuest(fresh, "minimal", baseFp);
      if (id) return id;
    }

    throw new Error(
      `Backend Init Failed :: ${this.lastGuestError || "কোনো host reachable নয়"}`
    );
  }

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
    if (!res.ok) throw new Error(`Mask Error: HTTP ${res.status}`);
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
        returnSecureToken: true,
        email,
        password,
        clientType: "CLIENT_TYPE_WEB"
      })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Auth Error: HTTP ${res.status} ${t.slice(0, 160)}`);
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
    const hash = this.md5(firebaseUid + baseFp);
    const complexFp = `${baseFp}_${hash}`;
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
      throw new Error(`Reg Error HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.user_id;
  }

  async stepCheckBalance(userId) {
    try {
      const res = await this.req(`${this.activeBackend}/balance?user_id=${userId}`, {
        method: "GET",
        headers: {
          ...this.commonHeaders,
          Authorization: this.basicAuth,
          "X-Client": "fantasy-new"
        }
      });
      const data = await res.json();
      this.req(`${this.activeBackend}/users?user_id=${userId}`, {
        method: "GET",
        headers: {
          ...this.commonHeaders,
          Authorization: this.basicAuth,
          "X-Client": "fantasy-new"
        }
      }).catch(() => {});
      const gem = Array.isArray(data) ? data.find((x) => x.amount >= 0) : null;
      return gem ? gem.amount : -1;
    } catch {
      return -1;
    }
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
        uiid: p.tid,
        uid: p.uid,
        masks: p.mask,
        original: p.orig,
        operation: "undress",
        breast_size: p.breast_size ?? 0,
        pubic_hair: p.pubic_hair ?? 0,
        body_size: p.body_size ?? 0,
        product: "UT",
        image_format: "base64",
        prompt: p.prompt || "",
        watermark: "ai1",
        quality: p.quality || "low"
      })
    }, 120000);
    if (!res.ok) throw new Error(`Exec Error: HTTP ${res.status}`);
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
        this.log(`reuse account credits=${pooled.credits}`);
        return pooled;
      }
    }
    for (let i = 0; i < 4; i++) {
      try {
        if (!this.activeBackend) await this.stepGuest(baseFp);
        const { uid, email } = await this.stepFirebaseAuth();
        const backendId = await this.stepBackendReg(uid, email, baseFp);
        const credits = await this.stepCheckBalance(backendId);
        this.log(`new account credits=${credits}`);
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
          tid: maskData.tid,
          uid: account.backendId,
          mask: maskData.mask,
          orig: maskData.orig,
          prompt,
          ...rest
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

  /** প্রতিটি ধাপ আলাদা করে টেস্ট করে রিপোর্ট দেয় */
  async diagnose({ imageUrl, imageBuffer } = {}) {
    const report = {
      ok: false,
      vercel: !!process.env.VERCEL,
      knownHosts: [...this.backendHosts],
      steps: {}
    };
    const baseFp = this.genBaseFingerprint();

    try {
      report.steps.discovery = {
        ok: true,
        hosts: await this.discoverBackendHosts()
      };
    } catch (e) {
      report.steps.discovery = { ok: false, error: e.message };
    }

    let guestId;
    try {
      guestId = await this.stepGuest(baseFp);
      report.steps.guest = { ok: true, host: this.activeBackend, id: guestId };
    } catch (e) {
      report.steps.guest = {
        ok: false,
        error: e.message,
        lastError: this.lastGuestError
      };
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
        report.steps.mask = { ok: true, taskId: m.tid, maskLen: m.mask?.length };
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
