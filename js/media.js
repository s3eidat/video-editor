/* Video Editor media: import + probe (duration, size, thumbnails, waveform), IndexedDB autosave,
   and frame sources for export (WebCodecs decode of MP4 via MP4Box, or frame-accurate seeking as a fallback).
   Files stay on this device: blobs live in memory and in this browser's IndexedDB only. */
(function () {
  "use strict";
  var VE = window.VE = window.VE || {}, M = VE.model;
  var lib = {}; // media id -> runtime {blob, url, thumb, strip, bitmap, peaks, audio: Promise<AudioBuffer|null>}

  function kindOf(f) {
    var t = (f.type || "").toLowerCase(), n = (f.name || "").toLowerCase();
    if (/^video\//.test(t) || /\.(mp4|m4v|mov|webm|mkv|ogv)$/.test(n)) return "video";
    if (/^image\//.test(t) || /\.(png|jpe?g|webp|gif|bmp|avif)$/.test(n)) return "image";
    if (/^audio\//.test(t) || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/.test(n)) return "audio";
    return null;
  }
  function once(el, ev, ms) {
    return new Promise(function (res) {
      var done = false, tm = setTimeout(function () { if (!done) { done = true; res(false); } }, ms || 8000);
      el.addEventListener(ev, function () { if (!done) { done = true; clearTimeout(tm); res(true); } }, { once: true });
    });
  }
  function seekEl(el, t) {
    return new Promise(function (res) {
      if (Math.abs(el.currentTime - t) < 1e-4 && !el.seeking && el.readyState >= 2) return res();
      var tm = setTimeout(res, 4000);
      el.addEventListener("seeked", function () { clearTimeout(tm); res(); }, { once: true });
      el.currentTime = t;
    });
  }
  function canvasBlob(c, type, q) { return new Promise(function (res) { c.toBlob(res, type || "image/jpeg", q || 0.8); }); }

  async function loadVideoEl(url) {
    var v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    var ok = await Promise.race([once(v, "loadedmetadata", 15000), new Promise(function (r) { v.addEventListener("error", function () { r(false); }, { once: true }); })]);
    if (!ok || !v.videoWidth) throw new Error("This browser can't play that video (codec not supported)");
    if (!isFinite(v.duration)) { // MediaRecorder WebM has no duration until we seek to the end
      v.currentTime = 1e9; await once(v, "durationchange", 6000); await seekEl(v, 0);
    }
    return v;
  }

  async function probe(file, id) {
    var kind = kindOf(file);
    if (!kind) throw new Error("Unsupported file: " + file.name);
    var m = { id: id || M.uid("m"), name: String(file.name || "media").slice(0, 200), kind: kind, size: file.size || 0, type: file.type || "", dur: 0, w: 0, h: 0, hasAudio: kind !== "image" };
    var rt = { blob: file, url: URL.createObjectURL(file) };
    if (kind === "video") {
      var v = await loadVideoEl(rt.url);
      m.dur = v.duration; m.w = v.videoWidth; m.h = v.videoHeight;
      // film strip: 5 frames across the clip
      var n = 5, th = 54, tw = Math.max(30, Math.round(th * m.w / m.h)), c = document.createElement("canvas");
      c.width = tw * n; c.height = th;
      var g = c.getContext("2d");
      for (var i = 0; i < n; i++) { await seekEl(v, Math.min(m.dur - 0.05, (i + 0.5) * m.dur / n)); g.drawImage(v, i * tw, 0, tw, th); }
      rt.strip = URL.createObjectURL(await canvasBlob(c));
      var t1 = document.createElement("canvas"); t1.width = 160; t1.height = Math.round(160 * m.h / m.w);
      t1.getContext("2d").drawImage(c, tw * 1, 0, tw, th, 0, 0, t1.width, t1.height);
      rt.thumb = URL.createObjectURL(await canvasBlob(t1));
      v.removeAttribute("src"); v.load();
    } else if (kind === "image") {
      var bmp = await createImageBitmap(file);
      m.w = bmp.width; m.h = bmp.height; m.dur = 0;
      var big = Math.max(bmp.width, bmp.height);
      if (big > 3840) { var s = 3840 / big; var b2 = await createImageBitmap(file, { resizeWidth: Math.round(bmp.width * s), resizeHeight: Math.round(bmp.height * s), resizeQuality: "high" }); bmp.close(); bmp = b2; }
      rt.bitmap = bmp;
      var tc = document.createElement("canvas"); tc.width = 160; tc.height = Math.max(1, Math.round(160 * m.h / m.w));
      tc.getContext("2d").drawImage(bmp, 0, 0, tc.width, tc.height);
      rt.thumb = rt.strip = URL.createObjectURL(await canvasBlob(tc));
    } else {
      var buf = await decodeAudio(file);
      if (!buf) throw new Error("This browser can't decode that audio file");
      m.dur = buf.duration;
      rt.audio = Promise.resolve(buf); rt.peaks = peaks(buf, 600);
      rt.wave = await waveImage(rt.peaks);
    }
    lib[m.id] = rt;
    return m;
  }

  // ---------- audio ----------
  async function decodeAudio(blob) {
    try {
      var ab = await blob.arrayBuffer(), Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      var ctx = new Ctx(2, 1, 48000);
      return await new Promise(function (res, rej) { var p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
    } catch (e) { return null; }
  }
  function audioOf(m) { // Promise<AudioBuffer|null>
    var rt = lib[m.id];
    if (!rt || m.kind === "image") return Promise.resolve(null);
    if (!rt.audio) rt.audio = decodeAudio(rt.blob).then(function (b) { if (!b) m.hasAudio = false; return b; });
    return rt.audio;
  }
  function peaks(buf, n) {
    var ch = buf.getChannelData(0), step = Math.max(1, Math.floor(ch.length / n)), out = new Float32Array(n);
    for (var i = 0; i < n; i++) { var mx = 0; for (var j = i * step, e = Math.min(ch.length, j + step); j < e; j += 4) { var a = Math.abs(ch[j]); if (a > mx) mx = a; } out[i] = mx; }
    return out;
  }
  async function waveImage(pk) {
    var c = document.createElement("canvas"); c.width = pk.length; c.height = 40;
    var g = c.getContext("2d"), mx = Math.max(0.05, Math.max.apply(null, Array.from(pk)));
    g.fillStyle = "rgba(255,255,255,.75)";
    for (var i = 0; i < pk.length; i++) { var h = Math.max(1, pk[i] / mx * 38); g.fillRect(i, 20 - h / 2, 1, h); }
    return URL.createObjectURL(await canvasBlob(c, "image/png"));
  }
  async function ensureWave(m) {
    var rt = lib[m.id];
    if (!rt || rt.wave || m.kind === "image") return rt && rt.wave;
    var b = await audioOf(m);
    if (!b) return null;
    rt.peaks = peaks(b, Math.min(1200, Math.max(100, Math.round(b.duration * 20))));
    rt.wave = await waveImage(rt.peaks);
    return rt.wave;
  }

  // ---------- IndexedDB autosave ----------
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error("No IndexedDB"));
      var rq = indexedDB.open("s3-video-editor", 1);
      rq.onupgradeneeded = function () { var d = rq.result; d.createObjectStore("media", { keyPath: "id" }); d.createObjectStore("state"); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function req(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(store, mode), st = tx.objectStore(store), out;
        var r = fn(st); if (r) r.onsuccess = function () { out = r.result; };
        tx.oncomplete = function () { res(out); }; tx.onerror = tx.onabort = function () { rej(tx.error); };
      });
    });
  }
  var idb = {
    putMedia: function (m) { var rt = lib[m.id]; return req("media", "readwrite", function (s) { return s.put({ id: m.id, meta: m, blob: rt.blob }); }); },
    allMedia: function () { return req("media", "readonly", function (s) { return s.getAll(); }); },
    delMedia: function (id) { return req("media", "readwrite", function (s) { return s.delete(id); }); },
    saveState: function (json) { return req("state", "readwrite", function (s) { return s.put(json, "current"); }); },
    loadState: function () { return req("state", "readonly", function (s) { return s.get("current"); }); },
    clear: function () { return Promise.all([req("media", "readwrite", function (s) { return s.clear(); }), req("state", "readwrite", function (s) { return s.clear(); })]); }
  };

  function forget(id) {
    var rt = lib[id];
    if (!rt) return;
    [rt.url, rt.thumb, rt.strip, rt.wave].forEach(function (u) { if (u) try { URL.revokeObjectURL(u); } catch (e) { /* already gone */ } });
    if (rt.bitmap && rt.bitmap.close) rt.bitmap.close();
    delete lib[id];
  }

  // ---------- frame sources for export ----------
  // MP4/MOV: demux with MP4Box, decode in order with VideoDecoder. Exact frames, much faster than seeking.
  var parsed = {}; // media id -> Promise<{config, samples, rotation}>
  function parseMp4(m) {
    if (parsed[m.id]) return parsed[m.id];
    parsed[m.id] = (async function () {
      if (!window.MP4Box || !window.VideoDecoder) throw new Error("no webcodecs");
      var buf = await lib[m.id].blob.arrayBuffer(); buf.fileStart = 0;
      var f = MP4Box.createFile(), info = null, samples = [], track = null, err = null;
      f.onError = function (e) { err = e; };
      f.onReady = function (i) {
        info = i; track = i.videoTracks[0];
        if (track) { f.setExtractionOptions(track.id, null, { nbSamples: 1e9 }); f.start(); }
      };
      f.onSamples = function (id, u, s) { for (var i = 0; i < s.length; i++) samples.push(s[i]); };
      f.appendBuffer(buf); f.flush();
      if (err || !info || !track) throw new Error("not demuxable");
      var trak = f.getTrackById(track.id), desc = null;
      (trak.mdia.minf.stbl.stsd.entries || []).forEach(function (e) {
        var box = e.avcC || e.hvcC || e.vpcC || e.av1C;
        if (box && !desc) {
          var DS = window.DataStream || MP4Box.DataStream, st = new DS(undefined, 0, DS.BIG_ENDIAN);
          box.write(st); desc = new Uint8Array(st.buffer, 8);
        }
      });
      var mx = track.matrix || [65536, 0, 0, 0, 65536, 0], rot = Math.round(Math.atan2(mx[1], mx[0]) * 180 / Math.PI);
      var config = { codec: track.codec.startsWith("vp08") ? "vp8" : track.codec, codedWidth: track.video.width, codedHeight: track.video.height };
      if (desc) config.description = desc;
      var sup = await VideoDecoder.isConfigSupported(config);
      if (!sup.supported) throw new Error("decoder unsupported");
      if (!samples.length) throw new Error("no samples");
      samples.forEach(function (s) { s.t = s.cts / s.timescale; s.d = s.duration / s.timescale; });
      return { config: config, samples: samples, rotation: ((rot % 360) + 360) % 360 };
    })();
    return parsed[m.id];
  }
  function Mp4Frames(data) {
    this.d = data; this.frames = []; this.next = 0; this.dec = null; this.last = -1; this.cur = null; this.err = null;
    var pres = data.samples.map(function (s) { return s.t; }).sort(function (a, b) { return a - b; });
    this.fdur = pres.length > 1 ? (pres[pres.length - 1] - pres[0]) / (pres.length - 1) : 1 / 30;
  }
  Mp4Frames.prototype.reset = function (t) {
    var self = this, S = this.d.samples;
    if (this.dec) try { this.dec.close(); } catch (e) { /* closed */ }
    this.frames.forEach(function (f) { f.close(); }); this.frames = [];
    this.dec = new VideoDecoder({ output: function (fr) { self.frames.push(fr); }, error: function (e) { self.err = e; } });
    this.dec.configure(this.d.config);
    var k = 0; for (var i = 0; i < S.length; i++) { if (S[i].is_sync && S[i].t <= t + 1e-4) k = i; if (S[i].t > t + 2) break; }
    this.next = k; this.flushed = false;
  };
  Mp4Frames.prototype.feed = function (n) {
    var S = this.d.samples;
    for (var i = 0; i < n && this.next < S.length; i++, this.next++) {
      var s = S[this.next];
      this.dec.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: Math.round(s.t * 1e6), duration: Math.round(s.d * 1e6), data: s.data }));
    }
  };
  Mp4Frames.prototype.get = async function (t) {
    var S = this.d.samples, tol = this.fdur * 0.5, self = this;
    t = Math.max(S[0].t, t);
    if (this.cur && Math.abs(this.cur.timestamp / 1e6 - t) < tol * 0.98 && !this.frames.length) return this.cur;
    // jump backwards or far ahead: restart from the keyframe before t
    var need = !this.dec || t < this.last - 1e-4 || this.err;
    if (!need) { var kf = -1; for (var i = this.next; i < S.length && S[i].t <= t + 1e-4; i++) if (S[i].is_sync) kf = i; if (kf > this.next + 2) need = true; }
    if (need) { if (this.cur) { this.cur.close(); this.cur = null; } this.err = null; this.reset(t); }
    this.last = t;
    var t0 = performance.now();
    for (;;) {
      if (this.err) throw this.err;
      // newest frame not after t (frames arrive in presentation order)
      while (this.frames.length && this.frames[0].timestamp / 1e6 <= t + tol) {
        if (this.cur) this.cur.close();
        this.cur = this.frames.shift();
      }
      if (this.frames.length) { if (!this.cur) this.cur = this.frames.shift(); return this.cur; } // next frame is already past t
      if (this.next >= S.length) {
        if (!this.flushed) { this.flushed = true; await this.dec.flush(); continue; }
        if (this.cur) return this.cur;
        throw new Error("no frame");
      }
      this.feed(4);
      if (this.dec.decodeQueueSize > 8 || this.frames.length === 0) await new Promise(function (r) { setTimeout(r, 0); });
      if (performance.now() - t0 > 6000) throw new Error("decoder stalled");
    }
  };
  Mp4Frames.prototype.close = function () {
    if (this.cur) this.cur.close(); this.frames.forEach(function (f) { f.close(); }); this.frames = [];
    if (this.dec && this.dec.state !== "closed") try { this.dec.close(); } catch (e) { /* closed */ }
  };

  // Anything else (WebM from recorders, MKV...): seek a hidden <video> and wait for the frame.
  function SeekFrames(m) { this.m = m; this.el = null; }
  SeekFrames.prototype.get = async function (t) {
    if (!this.el) this.el = await loadVideoEl(lib[this.m.id].url);
    var el = this.el;
    t = Math.max(0, Math.min(t, (el.duration || this.m.dur) - 0.001));
    if (Math.abs(el.currentTime - t) > 1e-4 || el.readyState < 2) {
      await seekEl(el, t);
      if (el.requestVideoFrameCallback) await Promise.race([new Promise(function (r) { el.requestVideoFrameCallback(function () { r(); }); }), new Promise(function (r) { setTimeout(r, 120); })]);
    }
    return el;
  };
  SeekFrames.prototype.close = function () { if (this.el) { this.el.removeAttribute("src"); this.el.load(); this.el = null; } };

  async function frameSource(m) {
    var mp4 = /mp4|quicktime|m4v/.test(m.type) || /\.(mp4|m4v|mov)$/i.test(m.name);
    if (mp4) {
      try { var d = await parseMp4(m); if (d.rotation === 0) return new Mp4Frames(d); } catch (e) { /* fall back to seeking */ }
    }
    return new SeekFrames(m);
  }
  function dropParsed() { parsed = {}; }

  VE.media = { lib: lib, kindOf: kindOf, probe: probe, audioOf: audioOf, ensureWave: ensureWave, decodeAudio: decodeAudio, idb: idb, forget: forget,
    frameSource: frameSource, dropParsed: dropParsed, loadVideoEl: loadVideoEl, seekEl: seekEl, Mp4Frames: Mp4Frames, SeekFrames: SeekFrames, parseMp4: parseMp4 };
})();
