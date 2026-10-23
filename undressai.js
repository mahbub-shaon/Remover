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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** একবার বানানো অ্যাকাউন্ট বারবার ব্যবহার করে Firebase signup কমায় */
export class AccountPool {
  constructor(max = 40) {
    this.max = max;
    this.accounts = [];
  }
  take() {
    const acc = this.accounts.find((a) => a.credits > 0);
    if (acc) {
      acc.credits -= 1;
      return acc;
    }
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
    this.backendHosts = opts.backendHosts || [
      "https://awh5tmpjds.us-east-1.awsapprunner.com"
    ];
    this.activeBackend = null;
    this.maskHost = "https://mkv2.undressaitools.net";
    this.genHost = "https://igv2.undressaitools.net";
    this.authUrl = "https://identitytoolkit.googleapis.com/v1/accounts";
    this.basicAuth = "Basic cG9ybmdlbjpwb3JuZ2Vu";
    this.timeout = opts.timeout || 150000;
    this.pool = opts.pool || null;
    this.debug = opts.debug || false;
    this.ua = UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
    this.commonHeaders = {
      "User-Agent": this.ua,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "id-ID",
      Origin: "https://undressaitools.net",
      Referer: "https://undressaitools.net/",
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

  randHex(len) {
    return crypto.randomBytes(len).toString("hex");
  }
  md5(str) {
    return crypto.createHash("md5").update(str).digest("hex");
  }
  genBaseFingerprint() {
    let result = "";
    for (let i = 0; i < 16; i++) result += Math.floor(Math.random() * 10);
    return result;
  }

  /** timeout সহ fetch */
  async req(url, options = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** exponential backoff সহ retry */
  async retry(fn, times = 3, label = "task") {
    let lastErr;
    for (let i = 0; i < times; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        this.log(`retry ${i + 1}/${times} [${label}] -> ${e.message}`);
        await sleep(400 * (i + 1) + Math.floor(Math.random() * 300));
      }
    }
    throw lastErr;
  }

  async stepGuest(baseFp) {
    return this.retry(async () => {
      for (const host of this.backendHosts) {
        try {
          const res = await this.req(`${host}/guest?fingerprint=${baseFp}`, {
            method: "GET",
            headers: {
              ...this.commonHeaders,
              Authorization: this.basicAuth,
              Accept: "*/*"
            }
          });
          if (res.ok) {
            const text = await res.text();
            this.activeBackend = host;
            this.log(`guest ok @ ${host}`);
            return text;
          }
        } catch (e) {
          this.log(`guest fail @ ${host}: ${e.message}`);
        }
      }
      throw new Error("Backend Init Failed");
    }, 3, "guest");
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
    if (!res.ok) throw new Error(`Mask Error: ${res.status}`);
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
    if (!res.ok) throw new Error(`Auth Error: ${res.status}`);
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
      const txt = await res.text();
      throw new Error(`Reg Error ${res.status}: ${txt}`);
    }
    const data = await res.json();
    return data.user_id;
  }

  async stepCheckBalance(userId) {
    try {
      const res = await this.req(
        `${this.activeBackend}/balance?user_id=${userId}`,
        {
          method: "GET",
          headers: {
            ...this.commonHeaders,
            Authorization: this.basicAuth,
            "X-Client": "fantasy-new"
          }
        }
      );
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
    });
    if (!res.ok) throw new Error(`Exec Error: ${res.status}`);
    const data = await res.json();
    if (data.code === 6100) return data.data;
    throw new Error(data.msg || "Generation Failed");
  }

  async processImg(input) {
    if (Buffer.isBuffer(input)) return input.toString("base64");
    if (typeof input === "string") {
      if (input.startsWith("http")) {
        const r = await this.req(input);
        if (!r.ok) throw new Error("Failed to fetch image");
        const ab = await r.arrayBuffer();
        return Buffer.from(ab).toString("base64");
      }
      return input.replace(/^data:image\/\w+;base64,/, "");
    }
    throw new Error("Invalid Image");
  }

  /** pool থেকে অ্যাকাউন্ট নেয়, না থাকলে নতুন বানায় */
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
        const acc = { uid, email, backendId, credits: Math.max(credits - 1, 0), backend: this.activeBackend };
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

    let finalB64;
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

    const clean = finalB64.replace(/^data:image\/\w+;base64,/, "");
    return Buffer.from(clean, "base64");
  }
}
