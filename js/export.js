/* Video Editor export: render every frame with the compositor, encode with WebCodecs (H.264 when the browser has it,
   otherwise VP9 or AV1), mix audio offline and encode it (AAC, otherwise Opus), mux into MP4 with mp4-muxer. All local. */
(function () {
  "use strict";
  var VE = window.VE = window.VE || {}, M = VE.model;

  var VIDEO = [
    { codec: "avc1.640028", mux: "avc", label: "H.264" }, { codec: "avc1.64002a", mux: "avc", label: "H.264" },
    { codec: "avc1.4d0028", mux: "avc", label: "H.264" }, { codec: "avc1.42002a", mux: "avc", label: "H.264" },
    { codec: "vp09.00.40.08", mux: "vp9", label: "VP9" }, { codec: "av01.0.08M.08", mux: "av1", label: "AV1" }
  ];
  var AUDIO = [{ codec: "mp4a.40.2", mux: "aac", label: "AAC" }, { codec: "opus", mux: "opus", label: "Opus" }];

  function bitrate(w, h, fps, q) { return Math.round(w * h * fps * (q === "high" ? 0.2 : 0.12)); } // ~7.5 / 12 Mbps at 1080p30
  // What this browser can do for (w, h, fps). Never throws.
  async function support(w, h, fps, q) {
    var r = { ok: false, video: null, audio: null, reason: "" };
    if (!window.VideoEncoder || !window.VideoFrame) {
      r.reason = "This browser can't encode video in the page (no WebCodecs). Use a current Chrome, Edge, Opera or Samsung Internet, " +
        "Firefox 130+ on a computer, or Safari 26+. Your project is saved here, so you can open it in another browser with a .s3video file.";
      return r;
    }
    if (!window.Mp4Muxer) { r.reason = "The MP4 writer failed to load. Reload the page."; return r; }
    for (var i = 0; i < VIDEO.length && !r.video; i++) {
      var cfg = { codec: VIDEO[i].codec, width: w, height: h, bitrate: bitrate(w, h, fps, q), framerate: fps };
      try { var s = await VideoEncoder.isConfigSupported(cfg); if (s && s.supported) r.video = Object.assign({}, VIDEO[i], { config: cfg }); } catch (e) { /* try next */ }
    }
    if (!r.video) { r.reason = "This browser has WebCodecs but no H.264, VP9 or AV1 encoder at " + w + "×" + h + ". Try 720p, or another browser."; return r; }
    if (window.AudioEncoder && window.AudioData) {
      var order = r.video.mux === "avc" ? AUDIO : AUDIO.slice().reverse(); // VP9/AV1 pair best with Opus
      for (var j = 0; j < order.length && !r.audio; j++) {
        var ac = { codec: order[j].codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 };
        try { var sa = await AudioEncoder.isConfigSupported(ac); if (sa && sa.supported) r.audio = Object.assign({}, order[j], { config: ac }); } catch (e) { /* next */ }
      }
    }
    r.ok = true;
    return r;
  }

  // Frame provider for export: exact frames for every clip visible at t.
  function ExportFrames(p) { this.p = p; this.src = {}; }
  ExportFrames.prototype.prepare = async function (t) {
    var p = this.p, need = {}, out = {}, self = this;
    var tasks = [];
    p.tracks.forEach(function (tr) {
      if (tr.kind !== "video" || tr.hidden) return;
      M.videoLayers(tr, t).forEach(function (L) {
        var m = p.media[L.clip.media];
        if (!m) return;
        need[L.clip.id] = 1;
        var rt = VE.media.lib[m.id];
        if (!rt || m.missing) { out[L.clip.id] = null; return; }
        if (m.kind === "image") { out[L.clip.id] = rt.bitmap || null; return; }
        var dur = m.dur || 0, s = Math.max(0, Math.min(L.src, dur - 0.001));
        tasks.push((async function () {
          if (!self.src[L.clip.id]) self.src[L.clip.id] = await VE.media.frameSource(m);
          try { out[L.clip.id] = await self.src[L.clip.id].get(s); }
          catch (e) { // decoder trouble: switch this clip to seeking
            try { self.src[L.clip.id].close(); } catch (x) { /* closed */ }
            self.src[L.clip.id] = new VE.media.SeekFrames(m);
            out[L.clip.id] = await self.src[L.clip.id].get(s);
          }
        })());
      });
    });
    await Promise.all(tasks);
    Object.keys(this.src).forEach(function (id) { if (!need[id]) { self.src[id].close(); delete self.src[id]; } }); // clip is over
    return function (clip) { return out[clip.id] || null; };
  };
  ExportFrames.prototype.close = function () { var s = this.src; Object.keys(s).forEach(function (id) { s[id].close(); }); this.src = {}; VE.media.dropParsed(); };

  function yieldUi() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // opts: {res, fps, quality, onProgress(frac, label), isCancelled(), duration (optional override)}
  async function exportVideo(p, opts) {
    opts = opts || {};
    var fps = opts.fps || 30, D = M.dims(p.aspect, opts.res || 1080), W = D.w, H = D.h;
    var dur = opts.duration || M.duration(p);
    if (!(dur > 0)) throw new Error("The timeline is empty");
    var sup = opts.support || await support(W, H, fps, opts.quality);
    if (!sup.ok) throw new Error(sup.reason);
    var progress = opts.onProgress || function () {}, cancelled = opts.isCancelled || function () { return false; };
    var nFrames = Math.max(1, Math.round(dur * fps)), err = null;

    // audio first (fast), so the muxer knows whether there is an audio track
    progress(0, "Mixing audio…");
    var mixBuf = null;
    if (sup.audio) {
      mixBuf = await VE.audio.mix(p, nFrames / fps, VE.media.audioOf);
      if (mixBuf.silent && !opts.keepSilent) mixBuf = opts.forceAudio ? mixBuf : null;
    }
    var target = new Mp4Muxer.ArrayBufferTarget();
    var mux = new Mp4Muxer.Muxer({
      target: target, fastStart: "in-memory", firstTimestampBehavior: "offset",
      video: { codec: sup.video.mux, width: W, height: H, frameRate: fps },
      audio: mixBuf ? { codec: sup.audio.mux, numberOfChannels: 2, sampleRate: 48000 } : undefined
    });
    var venc = new VideoEncoder({ output: function (ch, meta) { mux.addVideoChunk(ch, meta); }, error: function (e) { err = e; } });
    venc.configure(Object.assign({}, sup.video.config, { width: W, height: H, framerate: fps, bitrate: bitrate(W, H, fps, opts.quality) }));
    var aenc = null;
    if (mixBuf) {
      aenc = new AudioEncoder({ output: function (ch, meta) { mux.addAudioChunk(ch, meta); }, error: function (e) { err = e; } });
      aenc.configure(sup.audio.config);
      var L = mixBuf.getChannelData(0), R = mixBuf.getChannelData(1), N = 1024 * 4;
      for (var off = 0; off < mixBuf.length; off += N) {
        var n = Math.min(N, mixBuf.length - off), data = new Float32Array(n * 2);
        data.set(L.subarray(off, off + n), 0); data.set(R.subarray(off, off + n), n);
        var ad = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(off / 48000 * 1e6), data: data });
        aenc.encode(ad); ad.close();
      }
    }

    var canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d", { alpha: false }), frames = new ExportFrames(p), started = performance.now();
    try {
      for (var i = 0; i < nFrames; i++) {
        if (cancelled()) throw new Error("cancelled");
        if (err) throw err;
        var t = i / fps, prov = await frames.prepare(t);
        VE.render.paint(ctx, W, H, p, t, prov);
        var vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
        vf.close();
        while (venc.encodeQueueSize > 6) await yieldUi();
        if (i % 3 === 0) {
          var el = (performance.now() - started) / 1000, left = i > 5 ? el / (i + 1) * (nFrames - i - 1) : 0;
          progress((i + 1) / nFrames, "Frame " + (i + 1) + " / " + nFrames + (left > 2 ? " · about " + Math.ceil(left) + " s left" : ""));
          await yieldUi();
        }
      }
      progress(1, "Finishing…");
      await venc.flush();
      if (aenc) await aenc.flush();
      if (err) throw err;
      mux.finalize();
    } finally {
      frames.close();
      try { if (venc.state !== "closed") venc.close(); } catch (e) { /* closed */ }
      try { if (aenc && aenc.state !== "closed") aenc.close(); } catch (e) { /* closed */ }
      canvas.width = canvas.height = 1;
    }
    var blob = new Blob([target.buffer], { type: "video/mp4" });
    return { blob: blob, w: W, h: H, fps: fps, frames: nFrames, dur: nFrames / fps, video: sup.video.label, audio: mixBuf ? sup.audio.label : null, secs: (performance.now() - started) / 1000 };
  }

  // Read back an MP4 with MP4Box (used by the self-test and to show what was written).
  async function inspect(blob) {
    var buf = await blob.arrayBuffer(); buf.fileStart = 0;
    var f = MP4Box.createFile(), info = null;
    f.onReady = function (i) { info = i; };
    f.appendBuffer(buf); f.flush();
    if (!info) throw new Error("Not a readable MP4");
    var v = info.videoTracks[0];
    return { duration: info.duration / info.timescale, tracks: info.tracks.length, width: v && v.video.width, height: v && v.video.height,
      codecs: info.tracks.map(function (t) { return t.codec; }), videoFrames: v ? v.nb_samples : 0 };
  }

  VE.exporter = { support: support, exportVideo: exportVideo, inspect: inspect, bitrate: bitrate, ExportFrames: ExportFrames };
})();
