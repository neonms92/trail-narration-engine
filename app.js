/* Trail Narration Engine: the narrator's recording booth.
 *
 * Reads an episode's script.trail, manifest.json and the firefly's clips from Google Drive, records the
 * narrator's takes line by line (the lines flagged for one), and saves each take (mono Opus at 160 kbps in an Ogg file, encoded from the raw 48 kHz capture; WAV where the
 * browser can't encode Opus) with a trail-take/1 sidecar
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
  const LEAD_S = 3;            // record lead-up: the last seconds of the line before
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
      keys: s => run(s, "readonly", st => st.getAllKeys()),
    };
  })();

  // ---------- Google Drive ----------

  class AuthError extends Error {}

  const drive = {
    token: null, expires: 0, client: null, email: "",
    valid() { return this.token && Date.now() < this.expires - 60000; },
    /** Seconds of sign-in left (0 when signed out). */
    left() { return this.token ? Math.max(0, (this.expires - Date.now()) / 1000) : 0; },
    restore() {
      const a = local.get("tne.auth", null);
      if (a && a.token && Date.now() < a.expires - 60000) { this.token = a.token; this.expires = a.expires; return true; }
      return false;
    },
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
          // kept so a reload doesn't ask again; Google's tokens last an hour, and there is no refresh token in a browser
          local.set("tne.auth", { token: this.token, expires: this.expires });
          resolve();
        };
        this.client.error_callback = err => reject(new Error(`Google sign-in was closed (${err && err.type || "cancelled"}).`));
        // once you've agreed, a renewal needs no choices: the popup opens and closes by itself
        this.client.requestAccessToken({ prompt: this.token || local.get("tne.auth", null) ? "" : undefined });
      });
    },
    async api(url, opts = {}) {
      if (!this.valid()) throw new AuthError("Your Google sign-in has lapsed.");
      const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${this.token}` } });
      if (r.status === 401) { this.token = null; local.set("tne.auth", { token: null, expires: 0 }); throw new AuthError("Your Google sign-in has lapsed."); }
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
    /** Write a small text file: replace its content when `id` is given, else create it. */
    async putText(parent, name, text, mime, id) {
      if (!id) return this.uploadSmall(parent, name, text, mime);
      const r = await this.api(`${UPLOAD}/files/${id}?uploadType=media&fields=id`, { method: "PATCH", headers: { "Content-Type": mime }, body: text });
      return r.json();
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

  const lineKey = l => l.entry ? l.entry.id : "t:" + norm(l.text);

  /** Lines whose latest take the notebook couldn't use: {line id: {take, message}}. A later take that worked clears it. */
  function notebookFlags(manifest) {
    const flags = {};
    const takes = Object.entries(manifest.takes || {}).sort((a, b) => String(a[1].recorded).localeCompare(String(b[1].recorded)));
    for (const [tid, t] of takes) {
      if (t.kind === "ocarina") continue;
      const issues = t.issues || [];
      const silent = issues.find(i => i.kind === "take_silent");
      const tagged = new Set(t.lines || []);
      for (const i of issues) if (i.detail && i.detail.line) tagged.add(i.detail.line);
      for (const id of tagged) {
        if ((t.used || []).includes(id)) { delete flags[id]; continue; }
        const miss = issues.find(i => i.detail && i.detail.line === id) || silent;
        flags[id] = { take: tid, message: miss ? miss.message : "The notebook couldn't find this line in your take." };
      }
    }
    return flags;
  }

  function lineState(l) {
    if (!l.entry) return "unvoiced";
    const saved = ep.saved[lineKey(l)];
    const processed = saved && ep.manifest.takes && ep.manifest.takes[saved];
    if (saved && !processed) return "saved";
    if (ep.flags[l.entry.id]) return "flagged";
    if (l.entry.source === "recording") return l.entry.needs_review ? "review" : "recorded";
    return "placeholder";
  }
  function cueState(it) {
    const saved = ep.saved[it.key];
    const processed = saved && ep.manifest.takes && ep.manifest.takes[saved];
    if (saved && !processed) return "saved";
    return (ep.manifest.cues || []).some(c => c.cue === it.cue) ? "recorded" : "placeholder";
  }
  const STATE_LABEL = { flagged: "flagged by the notebook: take it again", recorded: "recorded", saved: "saved, not processed yet", review: "needs review", placeholder: "not recorded", unvoiced: "not voiced yet: run the notebook" };

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

  // ---------- which microphone ----------
  // Android names its inputs once the page has mic permission ("USB headset", "Headset microphone", "Speakerphone"...).
  // With no choice saved, a headset is preferred over the phone's own mic, since a browser's default doesn't always follow the plug.
  const MIC_BASE = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: RATE };
  const HEADSET = /usb|headset|headphone|wired|bluetooth|jack|adapter|external/i;
  const BUILT_IN = /built.?in|speakerphone|bottom|top|back|front|internal|phone|earpiece|default/i;
  async function micInputs() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.deviceId); } catch (_) { return []; }
  }
  const gum = id => navigator.mediaDevices.getUserMedia({ audio: id ? { ...MIC_BASE, deviceId: { exact: id } } : MIC_BASE });
  async function openMic(wantId) {
    if (wantId) { try { return await gum(wantId); } catch (e) { if (e && e.name === "NotAllowedError") throw e; } }  // a saved mic that's unplugged: fall back
    const s = await gum("");
    if (wantId) return s;
    const cur = s.getAudioTracks()[0].getSettings().deviceId;
    const head = (await micInputs()).find(d => d.deviceId !== "default" && d.deviceId !== cur && HEADSET.test(d.label) && !/speakerphone/i.test(d.label));
    if (!head || HEADSET.test(s.getAudioTracks()[0].label)) return s;
    try { const h = await gum(head.deviceId); for (const t of s.getTracks()) t.stop(); return h; } catch (_) { return s; }
  }
  /** The input's own name; "Default" is resolved to the device behind it when the browser says which. */
  async function micName(stream) {
    const tr = stream.getAudioTracks()[0], set = tr.getSettings();
    let name = tr.label || "";
    if (!name || /^default/i.test(name)) {
      const ins = await micInputs();
      const real = ins.find(d => d.deviceId !== "default" && d.groupId && d.groupId === set.groupId && !/^default/i.test(d.label));
      if (real) name = real.label;
    }
    return name.replace(/^default\s*-\s*/i, "") || "unnamed microphone";
  }
  async function showMic() {
    const sel = $("mic"), note = $("micNote");
    if (!sel) return;
    const ins = await micInputs();
    const live = audio.stream && audio.stream.getAudioTracks()[0];
    const curId = live ? live.getSettings().deviceId : local.get("tne.mic", "");
    sel.replaceChildren();
    const auto = document.createElement("option"); auto.value = ""; auto.textContent = "Automatic (headset first)"; sel.append(auto);
    for (const d of ins) {
      if (d.deviceId === "default") continue;
      const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || "Microphone (name shown after the first take)"; sel.append(o);
    }
    sel.value = local.get("tne.mic", "") && [...sel.options].some(o => o.value === local.get("tne.mic", "")) ? local.get("tne.mic", "") : "";
    if (live) {
      const name = audio.micLabel, phone = !HEADSET.test(name) && BUILT_IN.test(name);
      note.textContent = `Recording from: ${name}`;
      note.classList.toggle("warn", phone);
      note.title = phone ? "This looks like the phone's own mic. Check the headset is plugged in all the way, or pick it above." : "";
      if (!sel.value) [...sel.options].forEach(o => { if (o.value === curId) o.textContent += " — in use"; });
    } else {
      note.textContent = ins.some(d => d.label) ? "Opens on the next take" : "The mic's name shows once the first take opens it";
      note.classList.remove("warn");
    }
  }

  const audio = {
    ctx: null, stream: null, raw: null, kw: null, cueGain: null, dingGain: null, playing: [],
    chunks: [], recording: false, flushed: null, msWindow: [], peakUntil: 0, recSamples: 0,
    micLabel: "",
    /** Playback only: the firefly, the ding, a take under review. Doesn't touch the mic. */
    async output() {
      if (this.ctx) { if (this.ctx.state === "suspended") await this.ctx.resume(); return; }
      const ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      this.cueGain = ctx.createGain(); this.cueGain.connect(ctx.destination);
      this.dingGain = ctx.createGain(); this.dingGain.connect(ctx.destination);
      this.ctx = ctx;
      applyVolumes();
    },
    /** Playback plus the mic, for a take. The mic is let go again when the take ends. */
    async open() {
      await this.output();
      if (this.stream) return;
      const ctx = this.ctx;
      const stream = await openMic(local.get("tne.mic", ""));
      this.stream = stream;
      this.micLabel = await micName(stream);
      stream.getAudioTracks()[0].onended = () => {
        if (this.stream !== stream) return;
        this.releaseMic(true); showMic(); banner("The microphone went away (unplugged?). The next take opens it again.", true);
      };
      const src = ctx.createMediaStreamSource(stream);
      this.src = src;
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
      this.taps = [src, shelf, hp, this.raw, this.kw, sink];
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
    /** Let go of the mic (the phone's mic light goes off); the next take opens the chosen mic afresh. */
    releaseMic(force = false) {
      if (this.recording && !force) return;
      if (this.stream) for (const t of this.stream.getTracks()) { t.onended = null; t.stop(); }
      for (const n of this.taps || []) { try { n.disconnect(); } catch (_) {} }
      this.stream = this.src = this.raw = this.kw = null; this.taps = [];
      this.micLabel = ""; this.msWindow = []; this.peakUntil = 0;
    },
    stopPlayback() { for (const s of [...this.playing]) { try { s.stop(); } catch (_) {} } },   // their play() promises resolve
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
    /** A short, happy arpeggio, generated: the end of a record run. */
    jingle() {
      if (!this.ctx) return Promise.resolve();
      const ctx = this.ctx, t0 = ctx.currentTime + 0.05, notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      let end = t0;
      notes.forEach((f, i) => {
        const t = t0 + i * 0.09, len = i === notes.length - 1 ? 0.7 : 0.28;
        for (const [type, mult, amp] of [["triangle", 1, 0.32], ["sine", 2, 0.08]]) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = type; o.frequency.setValueAtTime(f * mult, t);
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0005, t + len);
          o.connect(g).connect(this.dingGain); o.start(t); o.stop(t + len + 0.02);
        }
        end = Math.max(end, t + len);
      });
      return sleep((end - ctx.currentTime) * 1000 + 50);
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

  // ---------- Opus in Ogg (RFC 7845), from the browser's own encoder ----------

  const OPUS_BITRATE = 160000;
  const PRE_SKIP = 312;   // libopus's encoder delay at 48 kHz, the usual value; the decoder drops these samples

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); t[i] = r >>> 0; }
    return t;
  })();
  function oggCrc(bytes) {
    let c = 0;
    for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 255]) >>> 0;
    return c >>> 0;
  }

  /** Build one Ogg page holding whole `packets`, ending at `granule`. */
  function oggPage(packets, granule, serial, seq, flags) {
    const lacing = [];
    for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }
    const size = 27 + lacing.length + packets.reduce((n, p) => n + p.length, 0);
    const b = new Uint8Array(size), v = new DataView(b.buffer);
    b.set([0x4f, 0x67, 0x67, 0x53], 0); b[4] = 0; b[5] = flags;
    v.setUint32(6, Number(BigInt.asUintN(64, BigInt(granule)) & 0xffffffffn), true);
    v.setUint32(10, Number(BigInt.asUintN(64, BigInt(granule)) >> 32n), true);
    v.setUint32(14, serial, true); v.setUint32(18, seq, true); v.setUint32(22, 0, true);
    b[26] = lacing.length; b.set(lacing, 27);
    let o = 27 + lacing.length;
    for (const p of packets) { b.set(p, o); o += p.length; }
    v.setUint32(22, oggCrc(b), true);
    return b;
  }

  async function opusSupported(rate) {
    try {
      if (typeof AudioEncoder === "undefined") return false;
      const s = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: rate, numberOfChannels: 1, bitrate: OPUS_BITRATE });
      return !!s.supported;
    } catch (_) { return false; }
  }

  /** Encode mono float samples to an Ogg Opus file. */
  async function oggOpus(samples, rate) {
    const packets = [];
    let err = null;
    const enc = new AudioEncoder({
      output: chunk => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); packets.push({ b, dur: Math.round(chunk.duration * 48000 / 1e6) }); },
      error: e => { err = e; },
    });
    enc.configure({ codec: "opus", sampleRate: rate, numberOfChannels: 1, bitrate: OPUS_BITRATE, opus: { application: "audio", frameDuration: 20000 } });
    const step = rate;   // one second per AudioData
    for (let i = 0; i < samples.length; i += step) {
      const part = samples.subarray(i, Math.min(samples.length, i + step));
      const ad = new AudioData({ format: "f32", sampleRate: rate, numberOfFrames: part.length, numberOfChannels: 1,
        timestamp: Math.round(i / rate * 1e6), data: part.slice(0) });
      enc.encode(ad); ad.close();
    }
    await enc.flush(); enc.close();
    if (err) throw err;

    const serial = crypto.getRandomValues(new Uint32Array(1))[0];
    const head = new Uint8Array(19), hv = new DataView(head.buffer);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);           // "OpusHead"
    head[8] = 1; head[9] = 1; hv.setUint16(10, PRE_SKIP, true); hv.setUint32(12, rate, true); hv.setInt16(16, 0, true); head[18] = 0;
    const vendor = new TextEncoder().encode("Trail Narration Engine");
    const tags = new Uint8Array(8 + 4 + vendor.length + 4), tv = new DataView(tags.buffer);
    tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0);           // "OpusTags"
    tv.setUint32(8, vendor.length, true); tags.set(vendor, 12); tv.setUint32(12 + vendor.length, 0, true);

    const pages = [oggPage([head], 0, serial, 0, 0x02), oggPage([tags], 0, serial, 1, 0)];
    let seq = 2, granule = PRE_SKIP, group = [], segs = 0;
    const total = PRE_SKIP + Math.round(samples.length * 48000 / rate);
    for (let k = 0; k < packets.length; k++) {
      const p = packets[k], need = Math.floor(p.b.length / 255) + 1;
      if (group.length && (segs + need > 255 || group.length >= 50)) {
        pages.push(oggPage(group, granule, serial, seq++, 0)); group = []; segs = 0;
      }
      group.push(p.b); segs += need; granule += p.dur;
      if (k === packets.length - 1) pages.push(oggPage(group, Math.min(granule, total), serial, seq++, 0x04));
    }
    return new Blob(pages, { type: "audio/ogg" });
  }

  /** The take as a file: Opus where the browser can encode it, else 24-bit WAV. */
  async function encodeTake(samples, rate) {
    if (await opusSupported(rate)) {
      try { return { blob: await oggOpus(samples, rate), ext: "opus", mime: "audio/ogg" }; } catch (_) {}
    }
    return { blob: wav24(samples, rate), ext: "wav", mime: "audio/wav" };
  }

  // ---------- state ----------

  let ep = null;          // the open episode
  let sel = 0;            // index into ep.seq: the selected line (firefly or narrator) or ocarina song
  let mode = "idle";      // idle | playing | listening | recording | finishing
  let run = null;         // the play or record run under way: {kind, cancelled, done}
  let take = null;        // the take being recorded: {key, rate, recorded, gain, mic}

  const RENEW_S = 15 * 60;   // renew the Google sign-in at a tap when less than this is left
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
    banner("Your Google sign-in has lapsed. Your takes are safe here.", true, {
      label: "Sign in again", run: async () => { try { await drive.auth(); banner(""); then && then(); } catch (e) { banner(e.message, true); } },
    });
  }

  // ---------- flags ----------
  // A flag marks a line for another take. On a narrator line (or ocarina song) it's yours to record; on a firefly line
  // it asks the notebook for a new Breeze take, with your note as direction. Narrator lines start flagged when they
  // have no take yet or the notebook couldn't use their last one; flags you set or clear yourself live in the
  // episode's flags.json on Drive, so every device sees them and the notebook can act on the firefly's.

  const isClaude = it => it.type === "line" && it.speaker === "claude";
  function autoFlag(it) {
    if (it.type === "ocarina") return cueState(it) === "placeholder";
    return ["placeholder", "unvoiced", "flagged"].includes(lineState(it));
  }
  function isFlagged(it) {
    const u = ep.userFlags[it.key];
    if (isClaude(it)) return !!(u && u.flag);
    if (u && typeof u.flag === "boolean") return u.flag;
    return autoFlag(it);
  }
  const canRecord = it => !!it && !isClaude(it) && isFlagged(it);

  /** Set (val) or clear (null) one line's entry in flags.json: re-read first, so flags set elsewhere survive. */
  function saveFlag(key, val) {
    if (val) ep.userFlags[key] = val; else delete ep.userFlags[key];
    if (ep.demo) { local.set("tne.demoFlags", ep.userFlags); return; }
    const e = ep;
    e.flagWrite = (e.flagWrite || Promise.resolve()).then(async () => {
      const f = await drive.child(e.id, "flags.json");
      let data = { format: "trail-flags/1", lines: {} };
      if (f) { try { const d = JSON.parse(await drive.text(f.id)); if (d && d.format === "trail-flags/1" && d.lines) data = d; } catch (_) {} }
      if (val) data.lines[key] = val; else delete data.lines[key];
      await drive.putText(e.id, "flags.json", JSON.stringify(data, null, 1), "application/json", f && f.id);
    }).catch(err => {
      if (err instanceof AuthError) signInAgain(() => saveFlag(key, val));
      else banner(`Couldn't save the flag to Drive: ${err.message}`, true);
    });
  }

  function askNote(it) {
    return new Promise(res => {
      const d = $("flagDlg");
      $("flagLine").textContent = it.text.replace(/\*/g, "");
      $("flagNote").value = "";
      $("flagOk").onclick = () => { d.close(); res($("flagNote").value.trim()); };
      $("flagCancel").onclick = () => { d.close(); res(null); };
      d.onclose = () => res(null);
      d.showModal();
      $("flagNote").focus();
    });
  }

  async function toggleFlag(it) {
    if (!ep) return;
    if (isClaude(it)) {
      if (isFlagged(it)) saveFlag(it.key, null);
      else {
        const note = await askNote(it);
        if (note === null) return;
        saveFlag(it.key, { flag: true, note, at: isoLocal(new Date()) });
      }
    } else {
      const want = !isFlagged(it);
      saveFlag(it.key, want === autoFlag(it) ? null : { flag: want, at: isoLocal(new Date()) });
    }
    renderRail(); renderTurn(); setMode(mode);
  }

  const FLAG_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>`;
  function flagButton(it, big) {
    const b = document.createElement("button");
    b.type = "button"; b.className = big ? "flag big" : "flag";
    const on = isFlagged(it);
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "Flagged: tap to clear" : "Flag for another take");
    b.title = b.getAttribute("aria-label");
    b.innerHTML = FLAG_SVG + (big ? `<span>${on ? "Flagged" : "Flag"}</span>` : "");
    b.addEventListener("click", e => { e.stopPropagation(); toggleFlag(it); });
    return b;
  }

  // ---------- what each line sounds like now ----------

  /** The audio a line plays: a firefly clip; for the narrator, his newest take (raw, while the notebook hasn't seen it),
      else the clip in use (his recording, or the placeholder voice); an ocarina song's take or clip. */
  function itemSource(it) {
    if (it.type === "ocarina") {
      const saved = ep.saved[it.key], processed = saved && ep.manifest.takes && ep.manifest.takes[saved];
      if (saved && !processed) return { take: saved };
      const c = (ep.manifest.cues || []).find(c => c.cue === it.cue);
      return c && c.clip ? { entry: c } : null;
    }
    if (isClaude(it)) return { entry: it.entry || { text: it.text, clip: "" } };
    if (lineState(it) === "saved") return { take: ep.saved[it.key] };
    if (it.entry && it.entry.clip && !ep.demo) return { entry: it.entry };
    return null;
  }
  async function bufferFor(it) {
    const src = itemSource(it);
    if (!src) return null;
    return src.take ? takeBuffer(src.take) : fireflyBuffer(src.entry);
  }

  // ---------- rendering ----------

  /** The script as one list. The selected line opens in place, large, with its flag. */
  function renderRail() {
    const rail = $("rail"), pool = $("pool");
    pool.append($("lines"));   // keep it in the document while the list is rebuilt
    rail.textContent = "";
    if (!ep) return;
    const cur = ep.seq[sel];
    let panel = null;
    for (const it of ep.items) {
      if (it.type === "section") {
        const h = document.createElement("div"); h.className = "sec"; h.textContent = it.title; rail.append(h); continue;
      }
      if (it.seqIndex === undefined) continue;
      if (it === cur) {
        panel = document.createElement("div"); panel.className = "open-turn" + (isClaude(it) ? " claude" : ""); panel.id = "openTurn";
        panel.append($("lines"));
        rail.append(panel);
        continue;
      }
      const row = document.createElement("div");
      row.tabIndex = 0;
      const t = document.createElement("span"); t.className = "t";
      if (isClaude(it)) {
        row.className = "item claude";
        const m = document.createElement("span"); m.className = "spark"; m.setAttribute("aria-hidden", "true"); m.textContent = "✦";
        t.textContent = it.text.replace(/\*/g, "");
        if (isFlagged(it)) { const s = document.createElement("span"); s.className = "state"; s.textContent = "flagged for a new take"; t.append(s); }
        row.append(m, t);
      } else {
        const st = it.type === "ocarina" ? cueState(it) : lineState(it);
        row.className = "item";
        const dot = document.createElement("span"); dot.className = `dot ${st}`;
        t.textContent = it.type === "ocarina" ? `Ocarina song ${it.cue}` : it.text.replace(/\*/g, "");
        if (st !== "placeholder") { const s = document.createElement("span"); s.className = "state"; s.textContent = STATE_LABEL[st]; t.append(s); }
        row.append(dot, t);
      }
      row.append(flagButton(it, false));
      row.classList.toggle("flagged", isFlagged(it));
      row.addEventListener("click", () => select(it.seqIndex));
      row.addEventListener("keydown", e => { if (e.key === "Enter" && mode === "idle") { e.stopPropagation(); row.click(); } });
      rail.append(row);
    }
    // only when the recorder moved the selection: never in answer to a tap, or to an upload finishing
    if (panel && scrollToSel) { scrollToSel = false; requestAnimationFrame(() => panel.scrollIntoView({ block: "center", behavior: "smooth" })); }
  }

  function note(box, text) { const n = document.createElement("span"); n.className = "note"; n.textContent = text; box.append(n); }

  function renderTurn() {
    const it = ep && ep.seq[sel];
    $("welcome").hidden = !!ep;
    $("lines").hidden = !it;
    if (!it) return;
    const box = $("lines"); box.textContent = "";
    const p = document.createElement("p");
    const lab = document.createElement("span"); lab.className = "st";
    if (isClaude(it)) {
      p.className = "claude-line";
      p.textContent = it.text.replace(/\*/g, "");
      lab.textContent = "Firefly"; p.append(lab);
      const u = ep.userFlags[it.key];
      if (u && u.flag) note(p, u.note ? `Flagged for a new take: “${u.note}”` : "Flagged for a new take (no note: a fresh seed only).");
      else if (it.entry && it.entry.note) { const n = document.createElement("span"); n.className = "st"; n.textContent = `Direction note: “${it.entry.note}”`; p.append(n); }
    } else if (it.type === "ocarina") {
      p.textContent = `Ocarina song ${it.cue}. Play it through, then press Done.`;
      lab.textContent = STATE_LABEL[cueState(it)]; p.append(lab);
    } else {
      p.textContent = it.text.replace(/\*/g, "");
      const st = lineState(it);
      lab.textContent = STATE_LABEL[st]; p.append(lab);
      if (st === "review" && it.entry.spoken) note(p, `Last take said: “${it.entry.spoken}”`);
      if (st === "unvoiced") note(p, "Not in the manifest yet; run the voice notebook so this line gets its id.");
      if (st === "flagged") note(p, ep.flags[it.entry.id].message + (it.entry.source === "recording" ? " An earlier take is still in use." : ""));
    }
    box.append(p);
    const row = document.createElement("div"); row.className = "panel-row"; row.append(flagButton(it, true)); box.append(row);
    const band = cueBand();
    $("band").style.left = `${pct(band.lo)}%`; $("band").style.width = `${pct(band.hi) - pct(band.lo)}%`;
    $("bandInfo").textContent = `firefly ${band.mid.toFixed(0)} LUFS`;
  }

  const LMIN = -45, LMAX = -5;
  const pct = l => Math.max(0, Math.min(100, (l - LMIN) / (LMAX - LMIN) * 100));
  /** The level band: the firefly's loudness at the nearest firefly line before the selection. */
  function cueBand() {
    let e = null;
    if (ep) for (let k = sel; k >= 0; k--) { const it = ep.seq[k]; if (it && isClaude(it) && it.entry) { e = it.entry; break; } }
    const mid = e && typeof e.lufs === "number" ? e.lufs : -20;
    return { mid, lo: mid - 3, hi: mid + 3 };
  }

  function meter() {
    const raw = audio.shortTermLufs();
    const gain = Number($("gain").value);
    const l = raw === null ? null : raw + gain;
    const band = cueBand();
    const lvl = $("lvl");
    lvl.style.width = l === null ? "0" : `${pct(l)}%`;
    lvl.classList.toggle("hot", l !== null && l > band.hi);
    $("lufs").textContent = l === null || l < -70 ? "— LUFS" : `${l.toFixed(1)} LUFS`;
    $("clipLight").classList.toggle("on", performance.now() < audio.peakUntil);
    if (mode === "recording" || mode === "finishing") $("clock").textContent = fmtClock(audio.recSamples / (audio.ctx ? audio.ctx.sampleRate : RATE));
  }

  const ICON = {
    play: `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>`,
    rec: `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="12" r="7.5" fill="currentColor"/></svg>`,
    done: `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v12"/><path d="M6.5 10.5 12 16l5.5-5.5"/><path d="M4.5 20.5h15"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" rx="1.5" fill="currentColor"/></svg>`,
  };

  function setMode(m) {
    mode = m;
    const cur = ep && ep.seq[sel];
    const recBtn = $("rec"), recording = m === "recording";
    $("play").disabled = !ep || m !== "idle";
    recBtn.disabled = !(recording || (m === "idle" && canRecord(cur)));
    recBtn.classList.toggle("recording", recording || m === "finishing");
    recBtn.innerHTML = recording || m === "finishing" ? ICON.done : ICON.rec;
    recBtn.setAttribute("aria-label", recording ? "Done: save this take and go on" : "Record from this line");
    recBtn.title = recBtn.getAttribute("aria-label");
    $("stop").disabled = m === "idle";
    $("tally").classList.toggle("on", recording || m === "finishing");
    $("episode").disabled = !ep || m !== "idle";
    if ($("mic")) $("mic").disabled = m !== "idle";
    document.body.dataset.mode = m;
  }

  let scrollToSel = true;   // set when the recorder moves the selection (play, record, opening an episode, arrow keys)
  function select(i, scroll = false) {
    if (!ep || mode !== "idle" || i < 0 || i >= ep.seq.length) return;
    moveTo(i, scroll);
  }
  function moveTo(i, scroll = true) {
    sel = i;
    scrollToSel = scroll;
    local.set(`tne.sel.${ep.name}`, ep.seq[i].key);
    renderRail(); renderTurn(); setMode(mode);
  }

  // ---------- play and record ----------

  async function ensureHeadphones() {
    try { if (sessionStorage.getItem("tne.phones")) return; } catch (_) {}
    await new Promise(res => {
      const d = $("phones");
      $("phonesOk").onclick = () => { d.close(); res(); };
      d.showModal();
    });
    try { sessionStorage.setItem("tne.phones", "1"); } catch (_) {}
  }

  /** Play one line's audio within a run; false when the run was stopped. A raw take covering several lines plays once. */
  async function playItem(me, it, from = 0) {
    const src = itemSource(it);
    if (src && src.take) { if (me.lastTake === src.take) return !me.cancelled; me.lastTake = src.take; } else me.lastTake = null;
    let b = null;
    try { b = await bufferFor(it); }
    catch (e) { if (e instanceof AuthError) { signInAgain(); me.cancelled = true; return false; } banner(`Couldn't play a line (${e.message || e}); going on.`, true); }
    if (b && !me.cancelled) await audio.play(b, from < 0 ? b.duration + from : from);
    return !me.cancelled;
  }

  /** Play from the selected line on, line after line, until the end or Stop. */
  async function playFrom(i) {
    if (!ep || mode !== "idle") return;
    await audio.output();
    const me = run = { kind: "play", cancelled: false };
    setMode("playing");
    for (let k = i; k < ep.seq.length; k++) {
      moveTo(k);
      if (!(await playItem(me, ep.seq[k]))) break;
    }
    if (run === me) run = null;
    setMode("idle");
  }

  /** Record from the selected flagged line: the last seconds of what comes before it, the ding, the take. Done saves it
      and plays on to the next flagged narrator line; the run ends when none are left, or at Stop. */
  async function recordFrom(i) {
    if (!ep || mode !== "idle" || !canRecord(ep.seq[i])) return;
    await ensureHeadphones();
    // a run of takes can outlast the hour a sign-in lasts: renew it now, from this tap, rather than mid-run
    if (!ep.demo && drive.left() < RENEW_S) { try { await drive.auth(); } catch (_) {} }
    try { await audio.open(); } catch (e) {
      banner(e && e.name === "NotAllowedError" ? "The microphone is blocked. Allow it for this site in the browser, then try again." : `Couldn't open the microphone: ${e.message || e}`, true);
      return;
    }
    banner(""); showMic();
    const me = run = { kind: "record", cancelled: false, done: null, lastTake: null };
    let k = i, takes = 0;
    setMode("listening");
    moveTo(k);
    if (k > 0) await playItem(me, ep.seq[k - 1], -LEAD_S);
    while (!me.cancelled) {
      const it = ep.seq[k];
      moveTo(k); setMode("listening");
      await audio.ding();
      if (me.cancelled) break;
      audio.startRecording();
      take = { key: it.key, rate: audio.ctx.sampleRate, recorded: new Date(), gain: Number($("gain").value), mic: audio.micLabel };
      setMode("recording");
      await new Promise(res => { me.done = res; });
      me.done = null;
      if (me.cancelled) { await audio.stopRecording(); take = null; break; }   // Stop: the take is discarded
      setMode("finishing");
      await sleep(TAIL_S * 1000);
      const t = take; take = null;
      t.samples = await audio.stopRecording();
      t.takeId = newTakeId(t.recorded);
      await queueUpload(t);   // saved to Drive behind the next line; the flag is cleared
      takes++;
      // play on through what's already fine, to the next flagged narrator line
      setMode("listening");
      me.lastTake = null;
      let next = -1;
      for (let j = k + 1; j < ep.seq.length; j++) {
        if (canRecord(ep.seq[j])) { next = j; break; }
        moveTo(j);
        if (!(await playItem(me, ep.seq[j]))) break;
      }
      if (next < 0 || me.cancelled) break;
      k = next;
    }
    audio.releaseMic(); showMic();
    if (run === me) run = null;
    setMode("idle");
    renderRail(); renderTurn(); setMode("idle");
    if (!me.cancelled) banner(takes ? `No flagged lines left. ${takes} take${takes > 1 ? "s" : ""} saved.` : "");
    await audio.jingle();
  }

  function recPressed() {
    if (mode === "recording" && run && run.done) { const d = run.done; d(); return; }
    if (mode === "idle") recordFrom(sel);
  }
  function stopPressed() {
    if (!run) return;
    run.cancelled = true;
    audio.stopPlayback();
    if (run.done) { const d = run.done; d(); }
  }

  // ---------- uploads that run behind the next take ----------
  // Each waiting take is kept in IndexedDB until its sidecar is on Drive, so a reload or a lapsed sign-in loses nothing.

  const uploads = { list: [], busy: false, pct: 0 };
  const turnFor = it => it.type === "ocarina" ? { kind: "ocarina", cueN: it.cue, key: it.key } : { kind: "lines", lines: [it], key: it.key };

  async function queueUpload(t) {
    const it = ep.seq.find(x => x.key === t.key);
    if (!it) return;
    t.ep = ep; t.turn = turnFor(it);
    keepTakeAudio(t);
    ep.saved[it.key] = t.takeId;   // shown as saved now; written to this browser's list once it's on Drive
    if (ep.userFlags[it.key]) saveFlag(it.key, null);   // the take answers the flag
    if (!ep.demo) await idb.put("pending", `q:${t.takeId}`, { samples: t.samples, rate: t.rate, turnKey: t.key, takeId: t.takeId,
      recorded: t.recorded.toISOString(), gain: t.gain, mic: t.mic, episode: ep.name, episodeId: ep.id });
    uploads.list.push(t);
    renderRail();
    pumpUploads();
  }

  function showUploads() {
    const n = uploads.list.length, el = $("uploads");
    el.textContent = !n ? "" : uploads.busy ? `↑${n} ${Math.round(uploads.pct * 100)}%` : `↑${n} waiting`;
    el.title = !n ? "" : `${n} take${n > 1 ? "s" : ""} uploading to Drive`;
  }

  async function pumpUploads() {
    if (uploads.busy || !uploads.list.length) { showUploads(); return; }
    uploads.busy = true;
    while (uploads.list.length) {
      const t = uploads.list[0];
      uploads.pct = 0; showUploads();
      try {
        if (!t.ep.demo && !drive.valid()) throw new AuthError("Your Google sign-in has lapsed.");
        await persistTake(t, t.turn, t.ep, p => { uploads.pct = p; showUploads(); });
      } catch (e) {
        uploads.busy = false; showUploads();
        if (e instanceof AuthError) signInAgain(pumpUploads);
        else banner(`A take didn't upload (${e.message}). It's kept in this browser.`, true, { label: "Try again", run: () => { banner(""); pumpUploads(); } });
        return;
      }
      uploads.list.shift();
      local.set(`tne.saved.${t.ep.name}`, t.ep.saved);
      if (!t.ep.demo) await idb.del("pending", `q:${t.takeId}`);
      if (ep === t.ep && mode === "idle") renderRail();
    }
    uploads.busy = false; showUploads();
  }

  /** Takes left waiting by a reload or a closed tab, for this episode: queue them again. */
  async function resumeUploads() {
    if (!ep || ep.demo) return;
    const keys = ((await idb.keys("pending")) || []).filter(k => typeof k === "string" && k.startsWith("q:"));
    let n = 0;
    for (const k of keys) {
      if (uploads.list.some(t => `q:${t.takeId}` === k)) continue;
      const p = await idb.get("pending", k);
      if (!p || p.episodeId !== ep.id) continue;
      const it = ep.seq.find(x => x.key === p.turnKey);
      if (!it) continue;
      uploads.list.push({ ...p, key: p.turnKey, recorded: new Date(p.recorded), ep, turn: turnFor(it) });
      n++;
    }
    if (n) { banner(`Uploading ${n} take${n > 1 ? "s" : ""} left from last time.`); pumpUploads(); }
  }

  /** Encode a take and put it on Drive (the audio, then its sidecar). The demo keeps it in this page only. */
  async function persistTake(t, turn, e, progress) {
    if (e.demo) { await sleep(150); return; }
    const file = await encodeTake(t.samples, t.rate);
    t.ext = file.ext;
    const side = sidecar(t, turn, e);
    if (!e.recordings) e.recordings = await drive.folder(e.id, "recordings");
    await drive.upload(e.recordings.id, `${t.takeId}.${file.ext}`, file.blob, file.mime, progress);
    // the sidecar last: the notebook treats a sidecar as a finished take
    await drive.uploadSmall(e.recordings.id, `${t.takeId}.json`, JSON.stringify(side, null, 1), "application/json");
  }

  // takes recorded in this page, kept in memory so they play back before (and without) a round trip to Drive
  const takeAudio = new Map();
  function keepTakeAudio(t) {
    takeAudio.set(t.takeId, { samples: t.samples, rate: t.rate });
    while (takeAudio.size > 40) takeAudio.delete(takeAudio.keys().next().value);
  }
  async function takeBuffer(takeId) {
    const m = takeAudio.get(takeId);
    if (m) { const b = audio.ctx.createBuffer(1, m.samples.length, m.rate); b.copyToChannel(m.samples, 0); return b; }
    if (ep.demo) return null;
    if (!ep.recordings) { const files = await drive.children(ep.id); ep.recordings = files.find(f => f.name === "recordings" && f.mimeType === FOLDER) || null; }
    if (!ep.recordings) return null;
    const f = (await drive.children(ep.recordings.id)).find(f => f.name.startsWith(takeId + ".") && !f.name.endsWith(".json"));
    return f ? audio.ctx.decodeAudioData(await drive.bytes(f.id)) : null;
  }

  function sidecar(t, turn, ep) {
    const base = { format: "trail-take/1", take: t.takeId, recorded: isoLocal(t.recorded instanceof Date ? t.recorded : new Date(t.recorded)),
      episode: ep.name, kind: turn.kind, audio: `${t.takeId}.${t.ext || "opus"}` };
    if (turn.kind === "ocarina") base.cue = turn.cueN;
    else base.lines = turn.lines.map(l => l.entry ? { id: l.entry.id, text: l.entry.text } : { text: l.text });
    base.gain_db = t.gain;
    if (t.mic) base.mic = t.mic;
    base.script_sha1 = ep.scriptSha1;
    return base;
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

  /** Takes on Drive the notebook hasn't processed yet, read from their sidecars: {line key: take id}, newest take winning.
      This, not the browser's own memory, is what says a line is saved, so it holds on any device or browser. */
  async function savedOnDrive(recId, manifest) {
    const done = manifest.takes || {};
    const sides = (await drive.children(recId)).filter(f => f.name.endsWith(".json") && !done[f.name.slice(0, -5)]);
    const takes = (await Promise.all(sides.map(f => drive.text(f.id).then(JSON.parse).catch(() => null))))
      .filter(t => t && t.format === "trail-take/1").sort((a, b) => String(a.recorded).localeCompare(String(b.recorded)));
    const out = {};
    for (const t of takes) {
      if (t.kind === "ocarina") out[`cue:${t.cue}`] = t.take;
      else for (const l of t.lines || []) out[l.id || "t:" + norm(l.text)] = t.take;
    }
    return out;
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
    const onDrive = recF ? await savedOnDrive(recF.id, manifest) : {};
    let userFlags = {};
    const flagsF = by("flags.json");
    if (flagsF) { try { const d = JSON.parse(await drive.text(flagsF.id)); if (d && d.format === "trail-flags/1" && d.lines) userFlags = d.lines; } catch (_) {} }
    banner("");
    await setEpisode({ id, name, script, manifest, clips, recordings: recF, demo: false, onDrive, userFlags });
    local.set("tne.episode", id);
    resumeUploads();
  }

  async function setEpisode(e) {
    ep = e;
    ep.items = parseScript(e.script);
    attachManifest(ep.items, e.manifest.lines || []);
    ep.seq = ep.items.filter(it => it.type === "line" || it.type === "ocarina");
    ep.seq.forEach((it, k) => { it.seqIndex = k; it.key = it.type === "ocarina" ? `cue:${it.cue}` : lineKey(it); });
    ep.userFlags = e.userFlags || {};
    // Drive's sidecars, plus this browser's own list for takes still uploading or uploaded a moment ago
    ep.saved = { ...local.get(savedKey(), {}), ...(e.onDrive || {}) };
    ep.flags = notebookFlags(e.manifest);
    ep.scriptSha1 = await sha1Hex(e.script);
    const lastKey = local.get(`tne.sel.${ep.name}`, null);
    let i = ep.seq.findIndex(it => it.key === lastKey);
    if (i < 0) { const n = ep.seq.findIndex(canRecord); i = n >= 0 ? n : 0; }
    sel = i;
    scrollToSel = true;
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
    await setEpisode({ id: "demo", name: "demo", script: DEMO_SCRIPT, manifest: { lines, cues: [], takes: {} }, clips: {}, demo: true,
      userFlags: local.get("tne.demoFlags", {}) });
    const s = $("episode"); s.textContent = ""; const o = document.createElement("option"); o.textContent = "Demo (nothing goes to Drive)"; s.append(o);
    banner("Demo: the firefly is a chirp, and takes stay in this browser. Sign in to record a real episode.");
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
    $("mic").addEventListener("change", () => {
      local.set("tne.mic", $("mic").value);
      audio.releaseMic();   // idle only: the picker is disabled otherwise
      showMic();
    });
    try {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        // plugged in or out between takes: reopen on the next take, so Automatic finds the headset
        if (audio.stream && mode === "idle" && !local.get("tne.mic", "")) audio.releaseMic();
        showMic();
      });
    } catch (_) {}
    showMic();
    const k = local.get("tne.knobs", null);
    if (k) { $("gain").value = k.gain; $("cueVol").value = k.cue; $("dingVol").value = k.ding; }
    for (const id of ["gain", "cueVol", "dingVol"]) $(id).addEventListener("input", () => { applyVolumes(); meter(); });
    applyVolumes();

    $("signin").addEventListener("click", async () => {
      try {
        await drive.auth();
        $("signin").textContent = "Signed in"; $("signin").disabled = true; document.body.classList.add("signed-in");
        await loadEpisodeList();
      } catch (e) { banner(e instanceof AuthError ? e.message : e.message || String(e), true); }
    });
    $("demo").addEventListener("click", () => { if (mode === "idle") demoEpisode(); });
    $("episode").addEventListener("change", async e => {
      if (!ep || ep.demo || mode !== "idle") return;
      const o = e.target.selectedOptions[0];
      try { await openEpisode(o.value, o.textContent); } catch (err) { if (err instanceof AuthError) signInAgain(); else banner(err.message, true); }
    });
    $("play").innerHTML = ICON.play; $("stop").innerHTML = ICON.stop;
    $("play").addEventListener("click", () => playFrom(sel));
    $("rec").addEventListener("click", recPressed);
    $("stop").addEventListener("click", stopPressed);

    document.addEventListener("keydown", e => {
      const tag = e.target.tagName;
      if (tag === "SELECT" || (tag === "INPUT" && e.target.type !== "range" && e.target.type !== "checkbox")) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.code === "Space") {   // Done while recording; otherwise Record where it can, else Play
        e.preventDefault();
        if (e.repeat) return;
        if (mode === "recording") recPressed();
        else if (mode === "idle" && ep) { if (canRecord(ep.seq[sel])) recordFrom(sel); else playFrom(sel); }
      }
      else if (e.key === "Escape") { if (run) { e.preventDefault(); stopPressed(); } }
      else if ((e.key === "f" || e.key === "F") && mode === "idle" && ep && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleFlag(ep.seq[sel]); }
      else if (mode === "idle" && ep && (e.key === "ArrowDown" || e.key === "ArrowUp") && e.target.tagName !== "INPUT") {
        e.preventDefault(); select(sel + (e.key === "ArrowDown" ? 1 : -1), true);
      }
    });
    window.addEventListener("beforeunload", e => { if (mode === "recording" || mode === "finishing" || uploads.list.length) { e.preventDefault(); e.returnValue = ""; } });
    setInterval(meter, 100);
    setMode("idle");
    if (!CFG.clientId) $("signin").title = "Set clientId in config.js to sign in";
    const setOpen = open => {
      $("settings").hidden = !open;
      $("settingsBtn").setAttribute("aria-expanded", String(open));
      local.set("tne.settingsOpen", open);
    };
    setOpen(local.get("tne.settingsOpen", false));
    $("settingsBtn").addEventListener("click", () => setOpen($("settings").hidden));
    idb.del("pending", "current");   // a take waiting for review, from before takes were saved straight away
    if (CFG.clientId && drive.restore()) {
      // signed in within the hour: carry on without asking
      $("signin").textContent = "Signed in"; $("signin").disabled = true; document.body.classList.add("signed-in");
      loadEpisodeList().catch(e => { if (e instanceof AuthError) { $("signin").textContent = "Sign in with Google"; $("signin").disabled = false; document.body.classList.remove("signed-in"); } banner(e.message || String(e), true); });
    }
  }

  /** The date the app was last updated, in the header: the newest commit on the repo serving this page, or failing that, when Pages deployed it. */
  async function showVersion() {
    const el = $("ver");
    const p2 = n => String(n).padStart(2, "0");
    const fmt = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    const m = location.hostname.match(/^([^.]+)\.github\.io$/), repo = m && location.pathname.split("/")[1];
    let info = null;
    try { info = JSON.parse(sessionStorage.getItem("tne.ver") || "null"); } catch (_) {}
    if (!info && m && repo) {
      try {
        const r = await fetch(`https://api.github.com/repos/${m[1]}/${repo}/commits?per_page=1`, { headers: { Accept: "application/vnd.github+json" } });
        if (r.ok) { const c = (await r.json())[0]; info = { date: c.commit.committer.date, sha: c.sha.slice(0, 7), url: c.html_url }; }
      } catch (_) {}
    }
    if (!info) {
      try {
        const r = await fetch("app.js", { method: "HEAD", cache: "no-store" });
        const lm = r.headers.get("Last-Modified");
        if (lm) info = { date: new Date(lm).toISOString() };
      } catch (_) {}
    }
    if (!info) return;
    try { sessionStorage.setItem("tne.ver", JSON.stringify(info)); } catch (_) {}
    el.textContent = fmt(new Date(info.date));   // local time
    if (info.url) el.href = info.url; else el.removeAttribute("href");
    el.title = "App last updated";
    el.hidden = false;
  }

  boot();
  showVersion();
  window.__tne = { parseScript, attachManifest, norm, wav24, encodeTake, state: () => ({ mode, sel, ep, take, run }) };
})();
