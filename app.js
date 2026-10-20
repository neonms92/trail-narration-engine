/* Trail Narration Engine: the narrator's recording booth.
 *
 * Reads an episode's script.trail, manifest.json and the firefly's clips from Google Drive, records the
 * narrator's takes turn by turn, and saves each take raw (48 kHz, 24-bit mono WAV) with a trail-take/1 sidecar
 * into the episode's recordings/ folder, for the voice notebook. Spec: "Trail Narration Engine Spec" (Claude Doc).
 */
(() => {
  "use strict";

  const CFG = window.TNE_CONFIG || {};
  const SCOPE = "https://www.googleapis.com/auth/drive";
  const FOLDER = "application/vnd.google-apps.folder";
  const API = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const RATE = 48000;
  const TAIL_S = 0.4;          // keep recording this long after Done
  const LEAD_S = 3;            // retake lead-up: the last seconds of the firefly's cue
  const CLIP_PEAK = 0.891;     // -1 dBFS
  const $ = id => document.getElementById(id);

  // ---------- small helpers ----------

  const norm = t => String(t).toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean).join(" ");
  const fmtClock = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const local = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };
  async function sha1Hex(text) {
    const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function isoLocal(d) {
    const p = n => String(n).padStart(2, "0");
    const off = -d.getTimezoneOffset();
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
      `${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  }
  function newTakeId(d) {
    const p = n => String(n).padStart(2, "0");
    const hex = [...crypto.getRandomValues(new Uint8Array(2))].map(b => b.toString(16).padStart(2, "0")).join("");
    return `take-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${hex}`;
  }

  // ---------- IndexedDB: the unsaved take, and cached firefly clips ----------

  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open("tne", 1); } catch (e) { rej(e); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore("pending"); req.result.createObjectStore("clips"); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }));
    const run = async (store, mode, fn) => {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const tx = db.transaction(store, mode);
          const r = fn(tx.objectStore(store));
          tx.oncomplete = () => res(r && r.result);
          tx.onerror = () => rej(tx.error);
        });
      } catch (_) { return undefined; }
    };
    return {
      get: (s, k) => run(s, "readonly", st => st.get(k)),
      put: (s, k, v) => run(s, "readwrite", st => st.put(v, k)),
      del: (s, k) => run(s, "readwrite", st => st.delete(k)),
    };
  })();

  // ---------- Google Drive ----------

  class AuthError extends Error {}

  const drive = {
    token: null, expires: 0, client: null, email: "",
    valid() { return this.token && Date.now() < this.expires - 60000; },
    /** Ask Google for a token. Call from a click: it may open a popup. */
    auth() {
      return new Promise((resolve, reject) => {
        if (!CFG.clientId) { reject(new Error("No Google client ID is set in config.js (see README.md).")); return; }
        if (!(window.google && google.accounts && google.accounts.oauth2)) { reject(new Error("Google sign-in hasn't loaded yet. Try again in a moment.")); return; }
        if (!this.client) {
          this.client = google.accounts.oauth2.initTokenClient({ client_id: CFG.clientId, scope: SCOPE, callback: () => {} });
        }
        this.client.callback = resp => {
          if (resp.error) { reject(new Error(`Google sign-in failed: ${resp.error}`)); return; }
          this.token = resp.access_token;
          this.expires = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
          resolve();
        };
        this.client.error_callback = err => reject(new Error(`Google sign-in was closed (${err && err.type || "cancelled"}).`));
        this.client.requestAccessToken({ prompt: this.token ? "" : undefined });
      });
    },
    async api(url, opts = {}) {
      if (!this.valid()) throw new AuthError("Your Google sign-in has lapsed.");
      const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${this.token}` } });
      if (r.status === 401) { this.token = null; throw new AuthError("Your Google sign-in has lapsed."); }
      if (!r.ok) {
        let msg = `${r.status}`;
        try { const j = await r.json(); msg = j.error && j.error.message || msg; } catch (_) {}
        throw new Error(`Google Drive said: ${msg}`);
      }
      return r;
    },
    async list(q) {
      const out = [];
      let page = "";
      do {
        const u = `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType,modifiedTime,size)")}&pageSize=1000&spaces=drive${page ? "&pageToken=" + page : ""}`;
        const j = await (await this.api(u)).json();
        out.push(...j.files);
        page = j.nextPageToken || "";
      } while (page);
      return out;
    },
    children(parent) { return this.list(`'${parent}' in parents and trashed = false`); },
    async child(parent, name, folder) {
      const q = `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and '${parent}' in parents and trashed = false` +
        (folder ? ` and mimeType = '${FOLDER}'` : "");
      const f = await this.list(q);
      f.sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""));
      return f[0] || null;
    },
    async text(id) { return (await this.api(`${API}/files/${id}?alt=media`)).text(); },
    async bytes(id) { return (await this.api(`${API}/files/${id}?alt=media`)).arrayBuffer(); },
    async folder(parent, name) {
      const f = await this.child(parent, name, true);
      if (f) return f;
      const r = await this.api(`${API}/files?fields=id,name`, {
        method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      });
      return r.json();
    },
    /** Upload a file, reporting progress 0..1. Resumable, so a long take can run to tens of MB. */
    async upload(parent, name, blob, mime, onProgress) {
      const init = await this.api(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(blob.size) },
        body: JSON.stringify({ name, parents: [parent] }),
      });
      const loc = init.headers.get("Location");
      if (!loc) return this.uploadSmall(parent, name, blob, mime);
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open("PUT", loc);
        x.setRequestHeader("Content-Type", mime);
        x.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
        x.onload = () => (x.status >= 200 && x.status < 300) ? resolve(JSON.parse(x.responseText || "{}")) : reject(new Error(`Upload failed (${x.status}).`));
        x.onerror = () => reject(new Error("Upload failed: the connection dropped."));
        x.send(blob);
      });
    },
    async uploadSmall(parent, name, data, mime) {
      const b = "tne" + Math.random().toString(16).slice(2);
      const head = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`;
      const body = new Blob([head, data, `\r\n--${b}--`]);
      const r = await this.api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body,
      });
      return r.json();
    },
  };

  // ---------- the script ----------

  /** Script items in order: sections, spoken lines, and ocarina songs (`> ocarina: play`). */
  function parseScript(text) {
    const items = [];
    let cue = 0;
    for (const raw of text.split(/\r?\n/)) {
      const s = raw.trim();
      if (!s || s.startsWith("#")) continue;
      let m;
      if ((m = s.match(/^==\s*(.*?)\s*==$/))) items.push({ type: "section", title: m[1] });
      else if ((m = s.match(/^(NARRATOR|CLAUDE)\s*:\s*(.+)$/i))) items.push({ type: "line", speaker: m[1].toLowerCase() === "claude" ? "claude" : "narrator", text: m[2].trim() });
      else if ((m = s.match(/^>\s*ocarina\s*:\s*(play|playing)\b/i))) items.push({ type: "ocarina", cue: ++cue });
    }
    return items;
  }

  /** Attach each script line to its manifest entry: a longest common subsequence on speaker and words. */
  function attachManifest(items, mlines) {
    const lines = items.filter(i => i.type === "line");
    const key = (sp, t) => sp + "|" + norm(t);
    const a = lines.map(l => key(l.speaker, l.text)), b = mlines.map(e => key(e.speaker, e.text));
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    lines.forEach(l => { l.entry = null; });
    while (i < n && j < m) {
      if (a[i] === b[j]) { lines[i].entry = mlines[j]; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
  }

  /** Turns: runs of narrator lines between the firefly's lines, section headers and ocarina songs. */
  function buildTurns(items) {
    const turns = [];
    let cur = null, prevSpoken = null;
    const close = () => { if (cur) { turns.push(cur); cur = null; } };
    for (const it of items) {
      if (it.type === "section") { close(); continue; }
      if (it.type === "ocarina") {
        close();
        turns.push({ kind: "ocarina", cueN: it.cue, lines: [], cue: prevSpoken && prevSpoken.speaker === "claude" ? prevSpoken : null, key: `cue:${it.cue}`, item: it });
        it.turn = turns[turns.length - 1];
        prevSpoken = null;
        continue;
      }
      if (it.speaker === "claude") { close(); prevSpoken = it; continue; }
      if (!cur) cur = { kind: "lines", lines: [], cue: prevSpoken && prevSpoken.speaker === "claude" ? prevSpoken : null };
      cur.lines.push(it);
      it.turn = cur;
      prevSpoken = it;
    }
    close();
    for (const t of turns) if (t.kind === "lines") t.key = t.lines[0].entry ? t.lines[0].entry.id : "t:" + norm(t.lines[0].text);
    return turns;
  }

  const lineKey = l => l.entry ? l.entry.id : "t:" + norm(l.text);

  function lineState(l) {
    if (!l.entry) return "unvoiced";
    const saved = ep.saved[lineKey(l)];
    const processed = saved && ep.manifest.takes && ep.manifest.takes[saved];
    if (saved && !processed) return "saved";
    if (l.entry.source === "recording") return l.entry.needs_review ? "review" : "recorded";
    return "placeholder";
  }
  function cueState(t) {
    const saved = ep.saved[t.key];
    const processed = saved && ep.manifest.takes && ep.manifest.takes[saved];
    if (saved && !processed) return "saved";
    return (ep.manifest.cues || []).some(c => c.cue === t.cueN) ? "recorded" : "placeholder";
  }
  const STATE_LABEL = { recorded: "recorded", saved: "saved, not processed yet", review: "needs review", placeholder: "not recorded", unvoiced: "not voiced yet: run the notebook" };
  const needsTake = t => t.kind === "ocarina" ? cueState(t) === "placeholder" : t.lines.some(l => ["placeholder", "unvoiced"].includes(lineState(l)));

  // ---------- audio ----------

  const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.keep = o.processorOptions.keep; this.rec = false; this.buf = []; this.len = 0; this.s = 0; this.n = 0; this.p = 0;
    this.port.onmessage = e => {
      if (e.data.rec === true) { this.rec = true; this.port.postMessage({ started: currentTime }); }
      else if (e.data.rec === false) { this.rec = false; this.flush(true); }
    };
  }
  flush(last) {
    if (this.len) {
      const out = new Float32Array(this.len); let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; }
      this.port.postMessage({ samples: out }, [out.buffer]); this.buf = []; this.len = 0;
    }
    if (last) this.port.postMessage({ flushed: true });
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let s = 0, p = this.p;
    for (let i = 0; i < ch.length; i++) { const v = ch[i]; s += v * v; const a = v < 0 ? -v : v; if (a > p) p = a; }
    this.s += s; this.n += ch.length; this.p = p;
    if (this.keep && this.rec) { this.buf.push(ch.slice(0)); this.len += ch.length; if (this.len >= sampleRate / 2) this.flush(false); }
    if (this.n >= sampleRate / 10) { this.port.postMessage({ ms: this.s / this.n, peak: this.p }); this.s = 0; this.n = 0; this.p = 0; }
    return true;
  }
}
registerProcessor("tne-tap", Tap);`;

  const audio = {
    ctx: null, stream: null, raw: null, kw: null, cueGain: null, dingGain: null, playing: [],
    chunks: [], recording: false, flushed: null, msWindow: [], peakUntil: 0, recSamples: 0,
    async open() {
      if (this.ctx) { if (this.ctx.state === "suspended") await this.ctx.resume(); return; }
      const ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: RATE },
      });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      const src = ctx.createMediaStreamSource(this.stream);
      const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
      // raw tap: the take itself, and the peak light
      this.raw = new AudioWorkletNode(ctx, "tne-tap", { processorOptions: { keep: true }, numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      src.connect(this.raw).connect(sink);
      // K-weighted tap: short-term loudness (ITU-R BS.1770 pre-filter: high shelf, then high pass)
      const shelf = ctx.createBiquadFilter(); shelf.type = "highshelf"; shelf.frequency.value = 1681.97; shelf.gain.value = 4.0;
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 38.13; hp.Q.value = 0.5003;
      this.kw = new AudioWorkletNode(ctx, "tne-tap", { processorOptions: { keep: false }, numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      src.connect(shelf).connect(hp).connect(this.kw).connect(sink);
      this.raw.port.onmessage = e => this.onRaw(e.data);
      this.kw.port.onmessage = e => this.onK(e.data);
      this.cueGain = ctx.createGain(); this.cueGain.connect(ctx.destination);
      this.dingGain = ctx.createGain(); this.dingGain.connect(ctx.destination);
      this.ctx = ctx;
      applyVolumes();
    },
    onRaw(d) {
      if (d.samples) { this.chunks.push(d.samples); this.recSamples += d.samples.length; }
      if (d.flushed && this.flushed) { this.flushed(); this.flushed = null; }
      if (d.peak !== undefined) { if (d.peak >= CLIP_PEAK) this.peakUntil = performance.now() + 1500; meter(); }
    },
    onK(d) {
      if (d.ms === undefined) return;
      this.msWindow.push(d.ms);
      if (this.msWindow.length > 30) this.msWindow.shift();   // 30 x 100 ms = 3 s
    },
    shortTermLufs() {
      if (!this.msWindow.length) return null;
      const ms = this.msWindow.reduce((a, b) => a + b, 0) / this.msWindow.length;
      return -0.691 + 10 * Math.log10(ms + 1e-12);
    },
    stopPlayback() { for (const s of this.playing) { try { s.onended = null; s.stop(); } catch (_) {} } this.playing = []; },
    play(buffer, offset = 0, gain = this.cueGain) {
      return new Promise(res => {
        const s = this.ctx.createBufferSource();
        s.buffer = buffer; s.connect(gain);
        s.onended = () => { this.playing = this.playing.filter(x => x !== s); res(); };
        this.playing.push(s);
        s.start(0, Math.max(0, Math.min(offset, buffer.duration - 0.01)));
      });
    },
    ding() {
      const ctx = this.ctx, t = ctx.currentTime + 0.03, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(1318.5, t);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.6, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.32);
      o.connect(g).connect(this.dingGain); o.start(t); o.stop(t + 0.34);
      return new Promise(res => { o.onended = res; });
    },
    startRecording() {
      this.chunks = []; this.recSamples = 0; this.recording = true;
      this.raw.port.postMessage({ rec: true });
    },
    stopRecording() {
      return new Promise(res => {
        this.flushed = () => {
          this.recording = false;
          const out = new Float32Array(this.chunks.reduce((n, c) => n + c.length, 0));
          let o = 0; for (const c of this.chunks) { out.set(c, o); o += c.length; }
          this.chunks = [];
          res(out);
        };
        this.raw.port.postMessage({ rec: false });
      });
    },
  };

  async function fireflyBuffer(entry) {
    if (!entry) return null;
    if (ep.demo) return demoCueBuffer(entry.text);
    const name = entry.clip.split("/").pop();
    const f = ep.clips[name];
    if (!f) return null;
    const key = `${f.id}:${f.modifiedTime}`;
    let bytes = await idb.get("clips", key);
    if (!bytes) { bytes = await drive.bytes(f.id); idb.put("clips", key, bytes.slice(0)); }
    return audio.ctx.decodeAudioData(bytes.slice(0));
  }

  /** The demo has no firefly voice: a soft chirp the length of the line stands in. */
  function demoCueBuffer(text) {
    const words = text.split(/\s+/).length, dur = Math.max(1, words * 0.33);
    const b = audio.ctx.createBuffer(1, Math.floor(dur * RATE), RATE), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / RATE, syl = (t * 3.1) % 1;
      d[i] = 0.12 * Math.sin(2 * Math.PI * (520 + 90 * Math.sin(t * 2.3)) * t) * Math.sin(Math.PI * syl) * Math.min(1, (dur - t) * 4, t * 8);
    }
    return b;
  }

  function wav24(samples, rate) {
    const n = samples.length, buf = new ArrayBuffer(44 + n * 3), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + n * 3, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 3, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true); str(36, "data"); v.setUint32(40, n * 3, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      const s = Math.round(x < 0 ? x * 8388608 : x * 8388607);
      v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3;
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  // ---------- state ----------

  let ep = null;          // the open episode
  let sel = 0;            // selected turn index
  let mode = "idle";      // idle | listening | recording | finishing | review | saving
  let take = null;        // the take under review: {samples, rate, turnKey, takeId, recorded, gain}
  let cancelListen = null;
  let reviewPlayback = false;

  const savedKey = () => `tne.saved.${ep.name}`;

  function banner(text, bad, action) {
    const b = $("banner");
    if (!text) { b.hidden = true; return; }
    b.hidden = false; b.className = "banner" + (bad ? " bad" : ""); b.textContent = text;
    if (action) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.textContent = action.label; btn.style.marginLeft = "10px";
      btn.addEventListener("click", action.run);
      b.append(btn);
    }
  }

  function signInAgain(then) {
    banner("Your Google sign-in has lapsed. Your take is safe here.", true, {
      label: "Sign in again", run: async () => { try { await drive.auth(); banner(""); then && then(); } catch (e) { banner(e.message, true); } },
    });
  }

  // ---------- rendering ----------

  function renderRail() {
    const rail = $("rail");
    rail.textContent = "";
    if (!ep) return;
    for (const it of ep.items) {
      if (it.type === "section") {
        const h = document.createElement("div"); h.className = "sec"; h.textContent = it.title; rail.append(h); continue;
      }
      const row = document.createElement("div");
      if (it.type === "ocarina") {
        const t = it.turn, st = cueState(t);
        row.className = "item" + (ep.turns[sel] === t ? " sel" : "");
        row.tabIndex = 0;
        row.innerHTML = `<span class="dot ${st}"></span><span class="t"></span>`;
        row.querySelector(".t").textContent = `Ocarina song ${t.cueN}`;
        const s = document.createElement("span"); s.className = "state"; s.textContent = STATE_LABEL[st]; row.querySelector(".t").append(s);
        row.addEventListener("click", () => select(ep.turns.indexOf(t)));
      } else if (it.speaker === "claude") {
        row.className = "item claude";
        const b = document.createElement("button"); b.className = "play"; b.type = "button"; b.textContent = "▶";
        b.setAttribute("aria-label", "Play the firefly's line");
        b.addEventListener("click", async e => { e.stopPropagation(); await playCueOnly(it); });
        const t = document.createElement("span"); t.className = "t"; t.textContent = it.text.replace(/\*/g, "");
        row.append(b, t);
      } else {
        const st = lineState(it);
        row.className = "item" + (ep.turns[sel] === it.turn ? " sel" : "");
        row.tabIndex = 0;
        row.innerHTML = `<span class="dot ${st}"></span><span class="t"></span>`;
        row.querySelector(".t").textContent = it.text.replace(/\*/g, "");
        if (st !== "placeholder") { const s = document.createElement("span"); s.className = "state"; s.textContent = STATE_LABEL[st]; row.querySelector(".t").append(s); }
        row.addEventListener("click", () => select(ep.turns.indexOf(it.turn)));
      }
      row.addEventListener("keydown", e => { if (e.key === "Enter" && row.tabIndex === 0 && mode === "idle") { e.stopPropagation(); row.click(); } });
      rail.append(row);
    }
    const s = rail.querySelector(".item.sel");
    if (s) s.scrollIntoView({ block: "nearest" });
  }

  function renderTurn() {
    const t = ep && ep.turns[sel];
    $("welcome").hidden = !!ep;
    $("turn").hidden = $("lines").hidden = !t;
    if (!t) return;
    $("cue").hidden = !t.cue;
    if (t.cue) $("cueText").textContent = t.cue.text;
    const box = $("lines"); box.textContent = "";
    if (t.kind === "ocarina") {
      const p = document.createElement("p"); p.textContent = `Ocarina song ${t.cueN}. Play it through, then press Done.`; box.append(p);
    }
    for (const l of t.lines) {
      const p = document.createElement("p");
      p.textContent = l.text.replace(/\*/g, "");
      const st = lineState(l);
      if (st === "review" && l.entry.spoken) { const n = document.createElement("span"); n.className = "note"; n.textContent = `Last take said: “${l.entry.spoken}”`; p.append(n); }
      if (st === "unvoiced") { const n = document.createElement("span"); n.className = "note"; n.textContent = "Not in the manifest yet; run the voice notebook so this line gets its id."; p.append(n); }
      box.append(p);
    }
    const band = cueBand(t);
    $("band").style.left = `${pct(band.lo)}%`; $("band").style.width = `${pct(band.hi) - pct(band.lo)}%`;
    $("bandInfo").textContent = `firefly ${band.mid.toFixed(0)} LUFS`;
  }

  const LMIN = -45, LMAX = -5;
  const pct = l => Math.max(0, Math.min(100, (l - LMIN) / (LMAX - LMIN) * 100));
  function cueBand(t) {
    const e = t && t.cue && t.cue.entry;
    const mid = e && typeof e.lufs === "number" ? e.lufs : -20;
    return { mid, lo: mid - 3, hi: mid + 3 };
  }

  function meter() {
    const raw = audio.shortTermLufs();
    const gain = Number($("gain").value);
    const l = raw === null ? null : raw + gain;
    const t = ep && ep.turns[sel], band = cueBand(t);
    const lvl = $("lvl");
    lvl.style.width = l === null ? "0" : `${pct(l)}%`;
    lvl.classList.toggle("hot", l !== null && l > band.hi);
    $("lufs").textContent = l === null || l < -70 ? "— LUFS" : `${l.toFixed(1)} LUFS`;
    $("clipLight").classList.toggle("on", performance.now() < audio.peakUntil);
    if (mode === "recording" || mode === "finishing") $("clock").textContent = fmtClock(audio.recSamples / (audio.ctx ? audio.ctx.sampleRate : RATE));
  }

  function setMode(m) {
    mode = m;
    const big = $("big");
    big.classList.toggle("recording", m === "recording");
    big.classList.toggle("listening", m === "listening");
    big.textContent = { idle: "Take", listening: "Listen…", recording: "Done", finishing: "Done", review: "Take", saving: "Saving…" }[m];
    big.disabled = !ep || m === "finishing" || m === "saving" || m === "review";
    $("retake").disabled = !ep || m === "finishing" || m === "saving";
    $("tally").classList.toggle("on", m === "recording" || m === "finishing");
    $("review").hidden = !(m === "review" || m === "saving");
    $("save").disabled = m === "saving";
    $("discard").disabled = m === "saving";
    $("episode").disabled = !ep || m !== "idle";
  }

  function select(i) {
    if (!ep || mode !== "idle" || i < 0 || i >= ep.turns.length) return;
    sel = i;
    local.set(`tne.turn.${ep.name}`, ep.turns[i].key);
    renderRail(); renderTurn();
  }

  // ---------- taking ----------

  async function ensureHeadphones() {
    try { if (sessionStorage.getItem("tne.phones")) return; } catch (_) {}
    await new Promise(res => {
      const d = $("phones");
      $("phonesOk").onclick = () => { d.close(); res(); };
      d.showModal();
    });
    try { sessionStorage.setItem("tne.phones", "1"); } catch (_) {}
  }

  async function startTake(lead) {
    if (!ep) return;
    await ensureHeadphones();
    try { await audio.open(); } catch (e) {
      banner(e && e.name === "NotAllowedError" ? "The microphone is blocked. Allow it for this site in the browser, then try again." : `Couldn't open the microphone: ${e.message || e}`, true);
      return;
    }
    banner("");
    const t = ep.turns[sel];
    setMode("listening");
    let cancelled = false;
    cancelListen = () => { cancelled = true; audio.stopPlayback(); };
    try {
      if (t.cue) {
        const buf = await fireflyBuffer(t.cue.entry || { text: t.cue.text, clip: "" });
        if (buf && !cancelled) await audio.play(buf, lead ? buf.duration - LEAD_S : 0);
      }
    } catch (e) {
      if (e instanceof AuthError) { setMode("idle"); signInAgain(); return; }
      banner(`Couldn't play the firefly's line (${e.message}); recording without it.`);
    }
    cancelListen = null;
    await audio.ding();
    audio.startRecording();
    take = { turnKey: t.key, rate: audio.ctx.sampleRate, recorded: new Date(), gain: Number($("gain").value) };
    setMode("recording");
  }

  async function done() {
    if (mode !== "recording") return;
    setMode("finishing");
    await sleep(TAIL_S * 1000);
    take.samples = await audio.stopRecording();
    take.takeId = newTakeId(take.recorded);
    await idb.put("pending", "current", { ...take, episode: ep.name, episodeId: ep.id, recorded: take.recorded.toISOString() });
    enterReview();
  }

  function enterReview() {
    setMode("review");
    $("clock").textContent = fmtClock(take.samples.length / take.rate);
    $("takeInfo").textContent = `${(take.samples.length / take.rate).toFixed(1)} s · ${take.rate / 1000} kHz · peak ${peakDb(take.samples)} dBFS`;
    $("download").hidden = true;
    drawWave(take.samples);
  }

  const peakDb = s => { let p = 0; for (let i = 0; i < s.length; i++) { const a = Math.abs(s[i]); if (a > p) p = a; } return p ? (20 * Math.log10(p)).toFixed(1) : "−∞"; };

  function drawWave(s) {
    const c = $("wave"), g = c.getContext("2d"), w = c.width, h = c.height;
    const css = getComputedStyle(document.documentElement);
    g.clearRect(0, 0, w, h);
    g.fillStyle = css.getPropertyValue("--moss").trim() || "#3E6A49";
    const per = Math.max(1, Math.floor(s.length / w));
    for (let x = 0; x < w; x++) {
      let lo = 0, hi = 0;
      for (let i = x * per; i < Math.min(s.length, (x + 1) * per); i++) { if (s[i] < lo) lo = s[i]; if (s[i] > hi) hi = s[i]; }
      g.fillRect(x, h / 2 - hi * h / 2, 1, Math.max(1, (hi - lo) * h / 2));
    }
  }

  async function playReview() {
    if (!take) return;
    if (reviewPlayback) { audio.stopPlayback(); reviewPlayback = false; $("playTake").textContent = "Play take"; return; }
    await audio.open();
    reviewPlayback = true; $("playTake").textContent = "Stop";
    const t = ep.turns.find(x => x.key === take.turnKey);
    try {
      if ($("withCue").checked && t && t.cue) {
        const cb = await fireflyBuffer(t.cue.entry || { text: t.cue.text, clip: "" });
        if (cb && reviewPlayback) await audio.play(cb);
      }
      if (reviewPlayback) {
        const b = audio.ctx.createBuffer(1, take.samples.length, take.rate);
        b.copyToChannel(take.samples, 0);
        await audio.play(b);
      }
    } catch (e) { if (e instanceof AuthError) signInAgain(); }
    reviewPlayback = false; $("playTake").textContent = "Play take";
  }

  async function playCueOnly(item) {
    if (mode !== "idle" && mode !== "review") return;
    try {
      await audio.open();
      audio.stopPlayback();
      const b = await fireflyBuffer(item.entry || { text: item.text, clip: "" });
      if (b) await audio.play(b);
    } catch (e) { if (e instanceof AuthError) signInAgain(); else banner(`Couldn't play that line: ${e.message || e}`, true); }
  }

  function sidecar(t, turn) {
    const base = { format: "trail-take/1", take: t.takeId, recorded: isoLocal(t.recorded instanceof Date ? t.recorded : new Date(t.recorded)),
      episode: ep.name, kind: turn.kind, audio: `${t.takeId}.wav` };
    if (turn.kind === "ocarina") base.cue = turn.cueN;
    else base.lines = turn.lines.map(l => l.entry ? { id: l.entry.id, text: l.entry.text } : { text: l.text });
    base.gain_db = t.gain;
    base.script_sha1 = ep.scriptSha1;
    return base;
  }

  async function save(advance = true) {
    if (!take) return false;
    const turn = ep.turns.find(x => x.key === take.turnKey);
    if (!turn) { banner("This take's turn is no longer in the script. Discard it, or reopen the episode it belongs to.", true); return false; }
    if (!ep.demo && !drive.valid()) { signInAgain(() => save(advance)); return false; }
    setMode("saving");
    const wav = wav24(take.samples, take.rate);
    const side = sidecar(take, turn);
    try {
      if (ep.demo) {
        const a = $("download"); a.href = URL.createObjectURL(wav); a.download = `${take.takeId}.wav`; a.hidden = false;
        await sleep(200);
      } else {
        if (!ep.recordings) ep.recordings = await drive.folder(ep.id, "recordings");
        $("save").textContent = "Uploading 0%";
        await drive.upload(ep.recordings.id, `${take.takeId}.wav`, wav, "audio/wav", p => { $("save").textContent = `Uploading ${Math.round(p * 100)}%`; });
        // the sidecar last: the notebook treats a sidecar as a finished take
        await drive.uploadSmall(ep.recordings.id, `${take.takeId}.json`, JSON.stringify(side, null, 1), "application/json");
      }
    } catch (e) {
      $("save").innerHTML = "Save to Drive <kbd>Enter</kbd>";
      setMode("review");
      if (e instanceof AuthError) signInAgain(() => save(advance)); else banner(`${e.message} Your take is still here; try Save again.`, true);
      return false;
    }
    $("save").innerHTML = "Save to Drive <kbd>Enter</kbd>";
    const keys = turn.kind === "ocarina" ? [turn.key] : turn.lines.map(lineKey);
    for (const k of keys) ep.saved[k] = take.takeId;
    local.set(savedKey(), ep.saved);
    await idb.del("pending", "current");
    const demoLink = ep.demo;
    take = null;
    setMode("idle");
    if (demoLink) { $("review").hidden = false; $("save").disabled = true; $("discard").disabled = true; }
    banner(ep.demo ? "Saved in the demo (not to Drive). Download the WAV above to check it." : "Saved to Drive. The notebook picks it up on its next run.");
    if (advance) {
      const next = ep.turns.findIndex((t, i) => i > sel && needsTake(t));
      select(next >= 0 ? next : sel);
    } else { renderRail(); renderTurn(); }
    return true;
  }

  async function discard() {
    if (mode !== "review") return;
    audio.stopPlayback(); reviewPlayback = false;
    take = null;
    await idb.del("pending", "current");
    setMode("idle");
  }

  async function retake() {
    if (!ep) return;
    if (mode === "listening") { cancelListen && cancelListen(); return; }
    if (mode === "recording") { setMode("finishing"); await audio.stopRecording(); take = null; setMode("idle"); return startTake(true); }
    if (mode === "review") {
      audio.stopPlayback(); reviewPlayback = false;
      if ($("keepBoth").checked) { if (!(await save(false))) return; }
      else { take = null; await idb.del("pending", "current"); setMode("idle"); }
      $("keepBoth").checked = false;
    }
    if (mode === "idle") return startTake(true);
  }

  function bigPressed() {
    if (mode === "idle") startTake(false);
    else if (mode === "listening") { cancelListen && cancelListen(); }
    else if (mode === "recording") done();
  }

  // ---------- episodes ----------

  async function loadEpisodeList() {
    const sel = $("episode");
    sel.textContent = "";
    const root = await drive.child("root", CFG.driveRoot || "hiker-engine", true);
    const eps = root && await drive.child(root.id, "episodes", true);
    if (!eps) { banner(`No ${CFG.driveRoot || "hiker-engine"}/episodes folder in your Drive yet. Run the voice notebook on an episode first.`, true); return; }
    const folders = (await drive.children(eps.id)).filter(f => f.mimeType === FOLDER).sort((a, b) => a.name.localeCompare(b.name));
    if (!folders.length) { banner("No episodes on Drive yet. Run the voice notebook on an episode first.", true); return; }
    for (const f of folders) { const o = document.createElement("option"); o.value = f.id; o.textContent = f.name; sel.append(o); }
    const last = local.get("tne.episode", null);
    const pick = folders.find(f => f.id === last) || folders[0];
    sel.value = pick.id;
    sel.disabled = false;
    await openEpisode(pick.id, pick.name);
  }

  async function openEpisode(id, name) {
    banner("Opening the episode…");
    const files = await drive.children(id);
    const by = n => files.find(f => f.name === n);
    const scriptF = by("script.trail"), manF = by("manifest.json");
    if (!scriptF || !manF) { ep = null; renderRail(); renderTurn(); setMode("idle"); banner(`${name} has no script.trail and manifest.json yet. Run the voice notebook on it first.`, true); return; }
    const [script, manifest] = await Promise.all([drive.text(scriptF.id), drive.text(manF.id).then(JSON.parse)]);
    const clipsF = files.find(f => f.name === "clips" && f.mimeType === FOLDER);
    const clips = {};
    if (clipsF) for (const f of await drive.children(clipsF.id)) clips[f.name] = f;
    const recF = files.find(f => f.name === "recordings" && f.mimeType === FOLDER) || null;
    banner("");
    await setEpisode({ id, name, script, manifest, clips, recordings: recF, demo: false });
    local.set("tne.episode", id);
  }

  async function setEpisode(e) {
    ep = e;
    ep.items = parseScript(e.script);
    attachManifest(ep.items, e.manifest.lines || []);
    ep.turns = buildTurns(ep.items);
    ep.saved = local.get(savedKey(), {});
    ep.scriptSha1 = await sha1Hex(e.script);
    const lastKey = local.get(`tne.turn.${ep.name}`, null);
    let i = ep.turns.findIndex(t => t.key === lastKey);
    if (i < 0 || !needsTake(ep.turns[i])) { const n = ep.turns.findIndex(needsTake); i = n >= 0 ? n : Math.max(0, i); }
    sel = i;
    const unvoiced = ep.items.filter(it => it.type === "line" && it.speaker === "narrator" && !it.entry).length;
    renderRail(); renderTurn(); setMode("idle");
    if (unvoiced) banner(`${unvoiced} narrator line(s) were added after the last notebook run. Run it so they get their ids; you can still record them now.`);
  }

  const DEMO_SCRIPT = `# Demo: the test episode, with an ocarina song.
title: The map is not the territory
== trailhead ==
NARRATOR: Welcome back to the trail. Today we're walking with a map in hand.
CLAUDE: And a question about how much to trust it.
== walk ==
NARRATOR: Every map leaves things out. That's what makes it *useful*.
NARRATOR: A map of everything would be as big as the woods, and about as much help.
CLAUDE: The trick is knowing what it left out, and whether that matters for where you're going.
NARRATOR: A trail map won't show you every root, but it shows you the switchbacks.
CLAUDE: Until the trail moves and the map doesn't.
== poi s1 informational ==
NARRATOR: Here's a sign that says the overlook is half a mile ahead.
CLAUDE: It was probably right when someone painted it.
NARRATOR: So how would we know if it still is?
> ocarina: play
> pause 20s
> ocarina: side
NARRATOR: That one always helps me think.
== end ==
`;

  async function demoEpisode() {
    const lines = parseScript(DEMO_SCRIPT).filter(i => i.type === "line").map((l, k) => ({
      index: k, id: norm(l.text).replace(/'/g, "").split(" ").slice(0, 5).join("-") + "-demo", speaker: l.speaker, text: l.text,
      clip: "", source: l.speaker === "claude" ? "tts" : "placeholder", lufs: -20,
    }));
    await setEpisode({ id: "demo", name: "demo", script: DEMO_SCRIPT, manifest: { lines, cues: [], takes: {} }, clips: {}, demo: true });
    const s = $("episode"); s.textContent = ""; const o = document.createElement("option"); o.textContent = "Demo (nothing goes to Drive)"; s.append(o);
    banner("Demo: the firefly is a chirp, and takes stay in this browser. Sign in to record a real episode.");
  }

  // ---------- recovery ----------

  async function checkPending() {
    const p = await idb.get("pending", "current");
    if (!p || !p.samples) return;
    $("restoreText").textContent = `A ${(p.samples.length / p.rate).toFixed(1)} s take for ${p.episode} wasn't saved. Open that episode and review it, or discard it.`;
    const d = $("restore");
    $("restoreDrop").onclick = async () => { await idb.del("pending", "current"); d.close(); };
    $("restoreOpen").onclick = async () => {
      d.close();
      if (!ep || ep.name !== p.episode) {
        if (p.episode === "demo") await demoEpisode();
        else if (!drive.valid()) { banner(`Sign in to review the unsaved take for ${p.episode}.`); window.__tnePending = p; return; }
        else { $("episode").value = p.episodeId; await openEpisode(p.episodeId, p.episode); }
      }
      restoreTake(p);
    };
    d.showModal();
  }

  function restoreTake(p) {
    take = { samples: p.samples, rate: p.rate, turnKey: p.turnKey, takeId: p.takeId, recorded: new Date(p.recorded), gain: p.gain };
    const i = ep.turns.findIndex(t => t.key === p.turnKey);
    if (i >= 0) { sel = i; renderRail(); renderTurn(); }
    enterReview();
  }

  // ---------- wiring ----------

  function applyVolumes() {
    $("gainOut").textContent = `${Number($("gain").value) >= 0 ? "+" : ""}${Number($("gain").value).toFixed(1)} dB`;
    $("cueOut").textContent = `${Math.round($("cueVol").value * 100)}%`;
    $("dingOut").textContent = `${Math.round($("dingVol").value * 100)}%`;
    if (audio.cueGain) audio.cueGain.gain.value = Number($("cueVol").value);
    if (audio.dingGain) audio.dingGain.gain.value = Number($("dingVol").value);
    local.set("tne.knobs", { gain: $("gain").value, cue: $("cueVol").value, ding: $("dingVol").value });
  }

  function boot() {
    const k = local.get("tne.knobs", null);
    if (k) { $("gain").value = k.gain; $("cueVol").value = k.cue; $("dingVol").value = k.ding; }
    for (const id of ["gain", "cueVol", "dingVol"]) $(id).addEventListener("input", () => { applyVolumes(); meter(); });
    applyVolumes();

    $("signin").addEventListener("click", async () => {
      try {
        await drive.auth();
        $("signin").textContent = "Signed in"; $("signin").disabled = true;
        await loadEpisodeList();
        if (window.__tnePending && ep && ep.name !== window.__tnePending.episode) {
          const p = window.__tnePending; window.__tnePending = null;
          $("episode").value = p.episodeId; await openEpisode(p.episodeId, p.episode); restoreTake(p);
        }
      } catch (e) { banner(e instanceof AuthError ? e.message : e.message || String(e), true); }
    });
    $("demo").addEventListener("click", () => { if (mode === "idle") demoEpisode(); });
    $("episode").addEventListener("change", async e => {
      if (!ep || ep.demo || mode !== "idle") return;
      const o = e.target.selectedOptions[0];
      try { await openEpisode(o.value, o.textContent); } catch (err) { if (err instanceof AuthError) signInAgain(); else banner(err.message, true); }
    });
    $("big").addEventListener("click", bigPressed);
    $("retake").addEventListener("click", retake);
    $("save").addEventListener("click", () => save(true));
    $("discard").addEventListener("click", discard);
    $("playTake").addEventListener("click", playReview);

    document.addEventListener("keydown", e => {
      const tag = e.target.tagName;
      if (tag === "SELECT" || (tag === "INPUT" && e.target.type !== "range" && e.target.type !== "checkbox")) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.code === "Space") { e.preventDefault(); if (!e.repeat) bigPressed(); }
      else if (e.key === "r" || e.key === "R") { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); retake(); } }
      else if (e.key === "Enter" && mode === "review") { e.preventDefault(); save(true); }
      else if (e.key === "Backspace" && mode === "review") { e.preventDefault(); discard(); }
      else if (mode === "idle" && ep && (e.key === "ArrowDown" || e.key === "ArrowUp") && e.target.tagName !== "INPUT") {
        e.preventDefault(); select(sel + (e.key === "ArrowDown" ? 1 : -1));
      }
    });
    window.addEventListener("beforeunload", e => { if (mode === "recording" || mode === "saving") { e.preventDefault(); e.returnValue = ""; } });
    setInterval(meter, 100);
    setMode("idle");
    if (!CFG.clientId) $("signin").title = "Set clientId in config.js to sign in";
    checkPending();
  }

  boot();
  window.__tne = { parseScript, attachManifest, buildTurns, norm, wav24, state: () => ({ mode, sel, ep, take }) };
})();
