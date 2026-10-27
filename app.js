/* Video Editor: synthetic media (made in the browser, nothing downloaded), the self-test and the sample project. */
(function () {
  "use strict";
  var VE = window.VE, M = VE.model, R = VE.render, MD = VE.media, A = VE.audio, X = VE.exporter;

  // ---------- synthetic media ----------
  // Encode a short MP4 from a draw(g, t, W, H) function with WebCodecs (+ optional tone). Falls back to MediaRecorder WebM.
  async function makeClip(drawFn, dur, W, H, opt) {
    opt = opt || {};
    var fps = opt.fps || 30, c = document.createElement("canvas"); c.width = W; c.height = H;
    var g = c.getContext("2d"), sup = await X.support(W, H, fps, "std");
    if (!sup.ok) return recordClip(drawFn, dur, W, H);
    var target = new Mp4Muxer.ArrayBufferTarget(), withAudio = opt.tone && sup.audio;
    var mux = new Mp4Muxer.Muxer({ target: target, fastStart: "in-memory", firstTimestampBehavior: "offset",
      video: { codec: sup.video.mux, width: W, height: H, frameRate: fps },
      audio: withAudio ? { codec: sup.audio.mux, numberOfChannels: 2, sampleRate: 48000 } : undefined });
    var err = null, enc = new VideoEncoder({ output: function (ch, meta) { mux.addVideoChunk(ch, meta); }, error: function (e) { err = e; } });
    enc.configure(Object.assign({}, sup.video.config, { width: W, height: H, framerate: fps, bitrate: 2e6 }));
    var n = Math.round(dur * fps);
    for (var i = 0; i < n; i++) {
      drawFn(g, i / fps, W, H);
      var vf = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % fps === 0 }); vf.close();
      if (enc.encodeQueueSize > 8) await new Promise(function (r) { setTimeout(r, 0); });
    }
    await enc.flush(); enc.close();
    if (withAudio) {
      var ae = new AudioEncoder({ output: function (ch, meta) { mux.addAudioChunk(ch, meta); }, error: function (e) { err = e; } });
      ae.configure(sup.audio.config);
      var tone = toneData(opt.tone, dur, 48000, 0.4), N = 4096;
      for (var o = 0; o < tone.length; o += N) {
        var k = Math.min(N, tone.length - o), d = new Float32Array(k * 2); d.set(tone.subarray(o, o + k), 0); d.set(tone.subarray(o, o + k), k);
        var ad = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: k, numberOfChannels: 2, timestamp: Math.round(o / 48 * 1000), data: d });
        ae.encode(ad); ad.close();
      }
      await ae.flush(); ae.close();
    }
    if (err) throw err;
    mux.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  }
  async function recordClip(drawFn, dur, W, H) {
    if (typeof MediaRecorder !== "function") return null;
    var c = document.createElement("canvas"); c.width = W; c.height = H;
    var g = c.getContext("2d"), t0 = performance.now(), raf, stream = c.captureStream(30), chunks = [];
    (function loop() { drawFn(g, Math.min(dur, (performance.now() - t0) / 1000), W, H); raf = requestAnimationFrame(loop); })();
    var rec = new MediaRecorder(stream);
    rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
    await new Promise(function (res) { rec.onstop = res; rec.start(); setTimeout(function () { rec.stop(); }, dur * 1000 + 100); });
    cancelAnimationFrame(raf); stream.getTracks().forEach(function (tr) { tr.stop(); });
    return new Blob(chunks, { type: "video/webm" });
  }
  function toneData(freq, dur, sr, amp) {
    var n = Math.round(dur * sr), d = new Float32Array(n);
    for (var i = 0; i < n; i++) d[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
    return d;
  }
  function toneBuffer(freq, dur, amp, sr) {
    sr = sr || 48000;
    var ctx = new OfflineAudioContext(2, 1, sr), b = ctx.createBuffer(2, Math.round(dur * sr), sr), d = toneData(freq, dur, sr, amp);
    b.copyToChannel(d, 0); b.copyToChannel(d, 1);
    return b;
  }
  // A gentle chord loop (C - G - Am - F) with a soft pulse, as WAV.
  function music(dur) {
    var sr = 44100, n = Math.round(dur * sr), L = new Float32Array(n), Rr = new Float32Array(n);
    var chords = [[261.6, 329.6, 392], [196, 246.9, 392], [220, 261.6, 329.6], [174.6, 220, 349.2]], bar = 2;
    for (var i = 0; i < n; i++) {
      var t = i / sr, ch = chords[Math.floor(t / bar) % 4], ph = (t % 0.5) / 0.5, env = Math.exp(-ph * 3.2) * 0.8 + 0.2, s = 0;
      for (var k = 0; k < 3; k++) s += Math.sin(2 * Math.PI * ch[k] * t) * (k === 0 ? 0.5 : 0.33);
      s += Math.sin(2 * Math.PI * ch[0] / 2 * t) * 0.35 * Math.exp(-((t % 1) / 1) * 4);
      var v = s * env * 0.16, fade = Math.min(1, t / 0.4, (dur - t) / 0.6);
      L[i] = v * fade * (1 + 0.15 * Math.sin(t * 1.7)); Rr[i] = v * fade * (1 - 0.15 * Math.sin(t * 1.7));
    }
    return A.wav([L, Rr], sr);
  }
  function sunset(g, t, W, H) {
    var gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, "hsl(" + (265 - t * 12) + ",55%," + (22 + t * 4) + "%)"); gr.addColorStop(0.6, "hsl(" + (18 + t * 5) + ",85%,58%)"); gr.addColorStop(1, "hsl(35,90%,62%)");
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = "#ffd36b"; g.beginPath(); g.arc(W * 0.5, H * (0.58 + t * 0.03), Math.min(W, H) * 0.16, 0, 7); g.fill();
    g.fillStyle = "#2a1838";
    g.beginPath(); g.moveTo(0, H); for (var x = 0; x <= W; x += W / 12) g.lineTo(x, H * 0.7 - Math.sin(x / W * 7 + 1) * H * 0.05 - (x % (W / 6) < W / 12 ? H * 0.04 : 0)); g.lineTo(W, H); g.fill();
    g.fillStyle = "#170c22"; g.fillRect(0, H * 0.86, W, H * 0.14);
  }
  function city(g, t, W, H) {
    g.fillStyle = "#0b1426"; g.fillRect(0, 0, W, H);
    var gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, "#14234a"); gr.addColorStop(1, "#3a2a5e"); g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.75);
    for (var i = 0; i < 18; i++) {
      var bw = W / 14, x = ((i * bw * 1.1 - t * 60) % (W + bw * 2) + W + bw * 2) % (W + bw * 2) - bw, bh = H * (0.25 + ((i * 37) % 10) / 22);
      g.fillStyle = i % 2 ? "#18203a" : "#202b4d"; g.fillRect(x, H * 0.82 - bh, bw, bh);
      g.fillStyle = "rgba(255,214,120,.85)";
      for (var y = H * 0.82 - bh + 8; y < H * 0.8; y += 16) for (var wx = x + 6; wx < x + bw - 8; wx += 12) if ((Math.floor(wx + y) + i) % 3) g.fillRect(wx, y, 5, 7);
    }
    g.fillStyle = "#060a14"; g.fillRect(0, H * 0.82, W, H * 0.18);
    g.fillStyle = "rgba(61,214,208,.9)"; g.fillRect((t * W / 3) % W, H * 0.9, W * 0.12, 4);
  }
  async function photo() {
    var c = document.createElement("canvas"); c.width = 1200; c.height = 800;
    var g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 800);
    gr.addColorStop(0, "#7cc3f2"); gr.addColorStop(1, "#d8eefc"); g.fillStyle = gr; g.fillRect(0, 0, 1200, 800);
    g.fillStyle = "#6d7f99"; g.beginPath(); g.moveTo(0, 560); g.lineTo(260, 260); g.lineTo(470, 520); g.lineTo(700, 200); g.lineTo(1000, 540); g.lineTo(1200, 380); g.lineTo(1200, 800); g.lineTo(0, 800); g.fill();
    g.fillStyle = "#fff"; g.beginPath(); g.moveTo(700, 200); g.lineTo(640, 270); g.lineTo(680, 262); g.lineTo(705, 290); g.lineTo(735, 255); g.lineTo(762, 270); g.fill();
    g.fillStyle = "#3f7d4f"; g.fillRect(0, 610, 1200, 190);
    g.fillStyle = "#2f6140"; for (var i = 0; i < 26; i++) { var x = i * 48 + (i % 3) * 9, y = 640 + (i % 4) * 10; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 22, y - 70); g.lineTo(x + 44, y); g.fill(); }
    return new Promise(function (r) { c.toBlob(function (b) { r(new File([b], "mountains.png", { type: "image/png" })); }, "image/png"); });
  }

  // ---------- sample project ----------
  window.S3_DEMO = async function () {
    try { await VE.ui.restored; } catch (e) { /* nothing restored */ }
    VE.ui.newProject();
    var a = await makeClip(sunset, 3, 540, 960), b = await makeClip(city, 3, 960, 540), pic = await photo(), mus = music(9);
    var ext = a && a.type === "video/webm" ? ".webm" : ".mp4", files = [];
    if (a) files.push(new File([a], "golden-hour" + ext, { type: a.type }));
    if (b) files.push(new File([b], "city-lights" + ext, { type: b.type }));
    files.push(pic, new File([mus], "soft-chords.wav", { type: "audio/wav" }));
    var added = await VE.ui.importFiles(files, { place: true, quiet: true });
    VE.ui.edit(function (p) {
      p.name = "Weekend in Amman";
      var main = p.tracks.filter(function (x) { return x.main; })[0], cl = main.clips;
      if (cl[1]) cl[1].tr = { type: "fade", dur: 0.6 };
      if (cl[2]) { cl[2].tr = { type: "slide", dur: 0.5 }; cl[2].fadeOut = 0.6; }
      var music = p.tracks.filter(function (x) { return x.kind === "audio"; })[0].clips[0];
      if (music) { music.out = Math.min(music.out, M.duration(p)); music.fadeOut = 1.5; music.volume = 0.8; }
      var txt = p.tracks.filter(function (x) { return x.kind === "text"; })[0];
      M.addClip(p, txt.id, Object.assign(M.newClip("text", null, 0.2), { text: "Weekend in Amman", out: 2.6, size: 10, y: 0.24, anim: "pop" }));
      var cap = p.tracks.filter(function (x) { return x.kind === "caption"; })[0];
      [[0.3, 2.6, "Golden hour on the hill"], [3.1, 5.6, "Then the city lights up"], [6.1, 8.4, "نراكم في الرحلة القادمة"]].forEach(function (s) {
        var c = M.newClip("caption", null, s[0]); c.out = s[1] - s[0]; c.text = s[2]; M.addClip(p, cap.id, c);
      });
    });
    VE.ui.fitZoom();
    var main = VE.ui.project.tracks.filter(function (x) { return x.main; })[0];
    if (main.clips[1]) VE.ui.select(main.clips[1].id);
    VE.ui.seek(1.1);
    await VE.ui.settle(4000);
    await VE.ui.flushSave();
    return added.length;
  };

  // ---------- self-test ----------
  function canon(o) { return JSON.stringify(o, function (k, v) { return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().reduce(function (r, x) { r[x] = v[x]; return r; }, {}) : v; }); }
  function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }
  function px(canvas, x, y) { return canvas.getContext("2d").getImageData(x, y, 1, 1).data; }
  window.S3_SELFTEST = async function () {
    var fail = [];
    function ok(cond, what) { if (!cond) fail.push(what); }

    // 1. timeline model
    var p = M.newProject();
    p.media = { m1: { id: "m1", name: "a.mp4", kind: "video", dur: 10, w: 640, h: 360, hasAudio: true }, m2: { id: "m2", name: "b.mp4", kind: "video", dur: 4, w: 640, h: 360, hasAudio: true },
      im: { id: "im", name: "p.png", kind: "image", dur: 0, w: 100, h: 100 }, mu: { id: "mu", name: "m.wav", kind: "audio", dur: 30 } };
    var c1 = M.insertMedia(p, p.media.m1, 0), c2 = M.insertMedia(p, p.media.m2, 99), main = p.tracks[2];
    ok(c1.start === 0 && c2.start === 10 && M.duration(p) === 14, "insert");
    var b = M.split(p, c1.id, 4);
    ok(b && c1.out === 4 && b.in === 4 && b.start === 4 && main.clips.length === 3 && main.clips[1] === b, "split");
    ok(M.split(p, c1.id, 0.01) === null, "split at edge refused");
    M.trim(p, b.id, "start", 5);
    ok(near(b.in, 5) && near(b.start, 4) && near(c2.start, 9), "trim start (magnetic close gap)");
    M.trim(p, b.id, "end", 100);
    ok(near(b.out, 10), "trim end clamps to source length");
    M.trim(p, c1.id, "end", 3);
    ok(near(c1.out, 3) && near(b.start, 3), "trim end ripples magnetic track");
    M.move(p, c2.id, 0);
    ok(main.clips[0] === c2 && near(c1.start, 4) && near(b.start, 7), "move reorders magnetic track");
    M.setSpeed(p, c1.id, 2);
    ok(near(M.clipDur(c1), 1.5) && near(M.srcTime(c1, c1.start + 1), 2) && near(M.tlTime(c1, 2), c1.start + 1) && near(b.start, 5.5), "speed time mapping");
    M.setSpeed(p, c1.id, 99); ok(c1.speed === 4, "speed clamp");
    var dup = M.duplicate(p, c2.id); ok(main.clips[1] === dup && near(dup.start, 4) && dup.id !== c2.id, "duplicate");
    M.remove(p, dup.id, false); ok(main.clips.length === 3 && near(c1.start, 4), "delete closes gap on magnetic");
    // ripple on a free track
    var au = p.tracks[3];
    [[0, 3], [3, 5], [6, 8]].forEach(function (r) { var c = M.newClip("audio", p.media.mu, r[0]); c.out = r[1] - r[0]; M.addClip(p, au.id, c); });
    var a0 = au.clips[0], a2 = au.clips[2];
    M.remove(p, au.clips[1].id, true);
    ok(au.clips.length === 2 && near(a2.start, 4) && a0.start === 0, "ripple delete");
    M.move(p, a2.id, 7.5); ok(near(a2.start, 7.5), "free move");
    var img = M.insertMedia(p, p.media.im, 0); ok(main.clips[0] === img && near(M.clipDur(img), 3) && near(main.clips[1].start, 3), "photo inserted at start");
    M.trim(p, img.id, "end", 5); ok(near(M.clipDur(img), 5), "photo duration by trimming");
    // history
    var H = new M.History(), s0 = JSON.stringify(p); H.record(s0); M.remove(p, img.id, false);
    var s1 = JSON.stringify(p), back = H.back(s1); ok(back === s0 && H.fwd(back) === s1 && H.back(s1) === s0, "undo / redo");

    // 2. transitions maths
    var q = M.newProject(); q.media = p.media;
    var A1 = M.insertMedia(q, q.media.m2, 0), B1 = M.insertMedia(q, q.media.m2, 9), tr = q.tracks[2];
    B1.tr = { type: "fade", dur: 1 };
    var L = M.videoLayers(tr, 4);
    ok(L.length === 2 && L[0].clip === A1 && near(L[1].alpha, 0.5) && near(L[0].src, 4) && near(L[1].src, 0), "crossfade midpoint");
    ok(near(M.videoLayers(tr, 4.25)[1].alpha, 0.84375) && near(M.videoLayers(tr, 3.6)[1].alpha, 0.028) && M.videoLayers(tr, 3.5).length === 1, "crossfade curve");
    ok(M.videoLayers(tr, 3)[0].clip === A1 && M.videoLayers(tr, 3).length === 1 && M.videoLayers(tr, 6)[0].clip === B1, "outside the window");
    B1.tr.type = "black";
    var Lb = M.videoLayers(tr, 4), Lb2 = M.videoLayers(tr, 3.75);
    ok(Lb.length === 1 && near(Lb[0].cover.alpha, 1) && Lb2[0].clip === A1 && near(Lb2[0].cover.alpha, 0.5), "dip to black");
    B1.tr.type = "slide";
    var Ls = M.videoLayers(tr, 4); ok(near(Ls[0].dx, -0.5) && near(Ls[1].dx, 0.5), "slide offsets");
    B1.tr.dur = 30; ok(near(M.trDur(A1, B1), 3), "transition length clamp");

    // 3. envelopes
    var fc = { start: 2, in: 0, out: 4, speed: 1, fadeIn: 1, fadeOut: 2, volume: 1 };
    ok(near(M.fadeGain(fc, 2.5), 0.5) && near(M.fadeGain(fc, 3.5), 1) && near(M.fadeGain(fc, 5), 0.5) && M.fadeGain(fc, 7) === 0, "fade gains");
    ok(near(M.duckFactor([[2, 4]], 3), M.DUCK_LEVEL) && near(M.duckFactor([[2, 4]], 1), 1) && near(M.duckFactor([[2, 4]], 4.125), 0.65), "duck factor");
    var ta = M.textAnim({ start: 0, in: 0, out: 3, speed: 1, anim: "type" }, 0.75); ok(near(ta.chars, 0.5), "typewriter");

    // 4. compositor with synthetic canvas sources (red clip, blue clip, crossfade)
    var red = document.createElement("canvas"); red.width = 64; red.height = 64; red.getContext("2d").fillStyle = "#ff0000"; red.getContext("2d").fillRect(0, 0, 64, 64);
    var blue = document.createElement("canvas"); blue.width = 64; blue.height = 64; blue.getContext("2d").fillStyle = "#0000ff"; blue.getContext("2d").fillRect(0, 0, 64, 64);
    var redW = document.createElement("canvas"); redW.width = 64; redW.height = 32; redW.getContext("2d").fillStyle = "#ff0000"; redW.getContext("2d").fillRect(0, 0, 64, 32);
    var cp = M.newProject(); cp.aspect = "1:1"; cp.bg = "color"; cp.bgColor = "#00ff00";
    cp.media = { r: { id: "r", name: "r", kind: "video", dur: 5, w: 64, h: 64 }, bl: { id: "bl", name: "b", kind: "video", dur: 5, w: 64, h: 64 }, w: { id: "w", name: "w", kind: "video", dur: 5, w: 64, h: 32 } };
    var cr = M.insertMedia(cp, cp.media.r, 0), cb = M.insertMedia(cp, cp.media.bl, 9); cb.tr = { type: "fade", dur: 1 };
    var prov = function (c) { return c.media === "r" ? red : c.media === "bl" ? blue : redW; };
    var cv = document.createElement("canvas"); cv.width = 64; cv.height = 64; var g = cv.getContext("2d");
    R.paint(g, 64, 64, cp, 1, prov); var p1 = px(cv, 32, 32);
    ok(p1[0] > 250 && p1[2] < 5, "compositor draws clip");
    R.paint(g, 64, 64, cp, 5, prov); var p2 = px(cv, 32, 32);
    ok(near(p2[0], 128, 6) && near(p2[2], 128, 6), "compositor crossfade 50%");
    cp.tracks[2].clips[0].fadeIn = 0; R.paint(g, 64, 64, cp, 20, prov); var p3 = px(cv, 32, 32);
    ok(p3[1] > 250 && p3[0] < 5, "background colour after the end");
    var wide = M.newClip("video", cp.media.w, 0); cp.tracks[2].clips = [wide]; // 2:1 source in 1:1 with fit -> bars show background
    R.paint(g, 64, 64, cp, 1, prov); ok(px(cv, 32, 4)[1] > 250 && px(cv, 32, 32)[0] > 250, "fit leaves bars");
    wide.fit = "fill"; R.paint(g, 64, 64, cp, 1, prov); ok(px(cv, 32, 4)[0] > 250, "fill covers");
    var tx = M.newProject(); tx.aspect = "1:1"; tx.bg = "color"; tx.bgColor = "#000000";
    M.addClip(tx, "t-text", Object.assign(M.newClip("text", null, 0), { text: "مرحبا", style: "box", color: "#ffffff", color2: "#ff0000", anim: "none", y: 0.5, size: 20 }));
    var info = R.paint(g, 64, 64, tx, 1, prov), hasRed = false;
    var dd = g.getImageData(0, 0, 64, 64).data; for (var i = 0; i < dd.length; i += 4) if (dd[i] > 200 && dd[i + 1] < 40) { hasRed = true; break; }
    ok(info.texts.length === 1 && hasRed && R.textDir("مرحبا") === "rtl" && R.textDir("Hi مرحبا") === "ltr", "Arabic text box");

    // 5. audio mix on synthetic tones
    var ap = M.newProject();
    ap.media = { t1: { id: "t1", name: "t", kind: "audio", dur: 4 }, v1: { id: "v1", name: "v", kind: "video", dur: 4, hasAudio: true } };
    var mc = M.newClip("audio", ap.media.t1, 0); mc.out = 4; mc.volume = 0.5; mc.fadeIn = 1; M.addClip(ap, "t-a1", mc);
    var tone = toneBuffer(440, 4, 0.5), silent = toneBuffer(440, 4, 0);
    var getBuf = function (m) { return Promise.resolve(m.id === "t1" ? tone : silent); };
    ap.duck = false;
    var mx = await A.mix(ap, 4, getBuf, 48000), full = 0.5 * 0.5 / Math.SQRT2;
    ok(A.rms(mx, 0, 0.1) < full * 0.15 && near(A.rms(mx, 1.5, 2.5), full, full * 0.03), "mix gain + fade in");
    var vc = M.newClip("video", ap.media.v1, 0); vc.in = 0; vc.out = 1; M.addClip(ap, "t-v1", vc); vc.start = 2; // voice at 2..3
    ap.magnetic = false; ap.duck = true;
    var md = await A.mix(ap, 4, getBuf, 48000);
    ok(near(A.rms(md, 2.3, 2.7) / A.rms(md, 1.3, 1.6), M.DUCK_LEVEL, 0.03) && near(A.rms(md, 3.5, 3.9), full, full * 0.04), "ducking");
    var src1 = toneData(440, 1, 48000, 0.5), st = A.stretch(src1, 2, 48000), zc = 0;
    for (var z = 1; z < st.length; z++) if ((st[z - 1] < 0) !== (st[z] < 0)) zc++;
    ok(st.length === 24000 && near(zc, 440, 25), "time-stretch keeps pitch");

    // 6. .s3video round trip + hostile files
    var file = M.toFile(p), back2 = M.fromFile(file);
    ok(canon(back2.tracks) === canon(p.tracks) && back2.media.m1.name === "a.mp4" && back2.aspect === p.aspect, "project round trip");
    function rejects(txt) { try { M.fromFile(txt); return false; } catch (e) { return true; } }
    ok(rejects("{nope") && rejects('{"format":"other","v":1}') && rejects('{"format":"s3video","v":9,"project":{}}') && rejects(JSON.stringify({ format: "s3video", v: 1, project: { tracks: [{ kind: "<img src=x onerror=alert(1)>" }] } })) &&
      rejects('{"format":"s3video","v":1,"project":{"tracks":"x"}}') && rejects('{"format":"s3video","v":1,"x":"' + "a".repeat(5e6) + '"}'), "hostile files rejected");
    var evil = M.fromFile('{"format":"s3video","v":1,"media":[{"id":"ok1","name":"../../etc/<b>x</b>.mp4","kind":"video","dur":5},{"id":"bad id!","kind":"video"},{"id":"__proto__","kind":"video"}],' +
      '"project":{"__proto__":{"polluted":1},"name":"<script>","aspect":"99:1","fps":1e9,"tracks":[{"id":"t","kind":"video","main":true,"clips":[{"id":"c1","media":"ok1","start":-5,"in":0,"out":5,"speed":1000,"volume":1e9,"__proto__":{"polluted":2}},' +
      '{"id":"c2","media":"nope","start":0,"in":0,"out":1}]},{"kind":"text","clips":[{"text":"' + "x".repeat(3000) + '","color":"red;background:url(x)","size":"1e9"}]}]}}');
    var ec = evil.tracks[0].clips;
    ok(!({}).polluted && !Object.prototype.hasOwnProperty.call(evil, "polluted") && ec.length === 1 && ec[0].speed === 4 && ec[0].volume === 2 && ec[0].start === 0 && evil.aspect === "9:16" && evil.fps === 30 &&
      !evil.media["bad id!"] && evil.media.ok1.name.indexOf("/") < 0 && evil.tracks[1].clips[0].text.length === 2000 && evil.tracks[1].clips[0].color === "#ffffff" && evil.tracks[1].clips[0].size === 40, "hostile values cleaned");
    var srt = M.toSrt([{ start: 1.5, in: 0, out: 2, speed: 1, text: "Hello" }, { start: 61, in: 0, out: 1.25, speed: 1, text: "مرحبا" }]), ps = M.parseSrt(srt);
    ok(srt.indexOf("00:00:01,500 --> 00:00:03,500") >= 0 && ps.length === 2 && near(ps[1].end, 62.25) && ps[1].text === "مرحبا", "srt round trip");
    var segs = M.autoSegments("One two three. Four five six seven eight nine ten eleven", 0, 10, 7);
    ok(segs.length === 3 && near(segs[2].end, 10) && segs[0].text === "One two three.", "auto segments");

    // 7. real media: encode a known clip, decode a known frame, export 2 s and read it back with MP4Box
    var sup = await X.support(256, 144, 30, "std");
    if (sup.ok) {
      var known = function (gg, tt, W, H) { var v = Math.min(255, Math.round(tt * 100)); gg.fillStyle = "rgb(" + v + ",40," + (255 - v) + ")"; gg.fillRect(0, 0, W, H); };
      var clip = await makeClip(known, 2, 256, 144, { tone: 330 });
      var mm = await MD.probe(new File([clip], "selftest.mp4", { type: "video/mp4" }));
      ok(near(mm.dur, 2, 0.08) && mm.w === 256 && mm.h === 144, "probe synthetic clip");
      var src = await MD.frameSource(mm), fr = await src.get(1.0), fc2 = document.createElement("canvas"); fc2.width = 32; fc2.height = 18;
      fc2.getContext("2d").drawImage(fr, 0, 0, 32, 18); var kp = px(fc2, 16, 9); src.close();
      ok(near(kp[0], 100, 14) && near(kp[2], 155, 14), "decoded frame at 1.0 s has the known colour (" + kp[0] + "," + kp[2] + ")");
      var sk = new MD.SeekFrames(mm), fr2 = await sk.get(1.5), fc3 = document.createElement("canvas"); fc3.width = 32; fc3.height = 18;
      fc3.getContext("2d").drawImage(fr2, 0, 0, 32, 18); var kp2 = px(fc3, 16, 9); sk.close();
      ok(near(kp2[0], 150, 16), "seeked frame at 1.5 s (" + kp2[0] + ")");
      var mb = await MD.audioOf(mm); ok(mb && near(mb.duration, 2, 0.1), "clip audio decodes");
      var ep = M.newProject(); ep.aspect = "16:9"; ep.media[mm.id] = mm;
      M.insertMedia(ep, mm, 0);
      M.addClip(ep, "t-text", Object.assign(M.newClip("text", null, 0), { text: "Test", out: 2 }));
      var r = await X.exportVideo(ep, { res: 144, fps: 30, support: sup });
      var ins = await X.inspect(r.blob);
      ok(near(ins.duration, 2, 0.1) && ins.width === 256 && ins.height === 144 && ins.tracks === (sup.audio ? 2 : 1) && ins.videoFrames === 60,
        "export read back: " + JSON.stringify(ins));
      window.__veExport = { codecs: ins.codecs, video: r.video, audio: r.audio, bytes: r.blob.size, secs: r.secs };
      MD.forget(mm.id); MD.dropParsed();
    } else {
      window.__veExport = { unsupported: sup.reason };
    }
    if (fail.length) { window.__veFail = fail; return fail; }
    return true;
  };
})();
