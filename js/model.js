/* Video Editor model: the project, timeline operations, time maths, envelopes, history and the .s3video format.
   Pure functions only (no DOM), so the self-test can check them against known answers. */
(function () {
  "use strict";
  var VE = window.VE = window.VE || {};
  var EPS = 1e-6, MIN_DUR = 0.1, MAX_T = 4 * 3600;

  var ASPECTS = { "9:16": [9, 16], "1:1": [1, 1], "4:5": [4, 5], "16:9": [16, 9] };
  // res = the short side (720 or 1080). Encoders want even sizes.
  function dims(aspect, res) {
    var a = ASPECTS[aspect] || ASPECTS["9:16"], s = res || 720, w, h;
    if (a[0] <= a[1]) { w = s; h = Math.round(s * a[1] / a[0]); } else { h = s; w = Math.round(s * a[0] / a[1]); }
    return { w: w - (w % 2), h: h - (h % 2) };
  }

  var n = 0;
  function uid(p) { n = (n + 1) % 1e6; return (p || "c") + Date.now().toString(36).slice(-5) + n.toString(36) + Math.random().toString(36).slice(2, 6); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var CAPTION_PRESETS = ["bold", "box", "yellow", "minimal"];
  var TEXT_STYLES = ["plain", "outline", "box", "shadow", "glow"];
  var ANIMS = ["none", "fade", "pop", "slide", "type"];
  var TRANSITIONS = ["none", "fade", "black", "white", "slide"];
  var FONTS = ["system", "arabic", "serif", "rounded", "impact", "hand", "mono", "custom"];

  function newProject() {
    return {
      v: 1, name: "My video", aspect: "9:16", bg: "blur", bgColor: "#000000", fps: 30, duck: true, magnetic: true,
      captionStyle: { preset: "bold", size: 6.5, y: 0.76, font: "system", pop: true },
      media: {},
      tracks: [
        { id: "t-cap", kind: "caption", name: "Captions", clips: [] },
        { id: "t-text", kind: "text", name: "Text", clips: [] },
        { id: "t-v1", kind: "video", name: "Main", main: true, clips: [] },
        { id: "t-a1", kind: "audio", name: "Music", clips: [] }
      ]
    };
  }

  // ---------- clip time maths ----------
  function clipDur(c) { return (c.out - c.in) / (c.speed || 1); }
  function clipEnd(c) { return c.start + clipDur(c); }
  function srcTime(c, t) { return c.in + (t - c.start) * (c.speed || 1); }
  function tlTime(c, s) { return c.start + (s - c.in) / (c.speed || 1); }
  function activeAt(c, t) { return t >= c.start - EPS && t < clipEnd(c) - EPS; }

  function newClip(kind, m, start) {
    var c = { id: uid("c"), start: Math.max(0, start || 0), in: 0, out: 3, speed: 1 };
    if (kind === "video" || kind === "image" || kind === "audio") {
      c.media = m.id; c.out = kind === "image" ? 3 : Math.max(MIN_DUR, m.dur || 3);
      c.volume = 1; c.muted = false; c.fadeIn = 0; c.fadeOut = 0;
      if (kind !== "audio") { c.fit = "fit"; c.scale = 1; c.x = 0; c.y = 0; c.kb = kind === "image" ? "in" : "none"; c.tr = { type: "none", dur: 0.5 }; }
    } else if (kind === "text") {
      Object.assign(c, { text: "Your title", font: "system", custom: "", size: 9, color: "#ffffff", color2: "#000000", style: "outline",
        bold: true, align: "center", x: 0.5, y: 0.3, anim: "pop" });
    } else if (kind === "caption") { c.text = "Caption"; c.out = 2; }
    return c;
  }
  function trackFor(p, kind) { // the track a new item of this media kind goes to
    var want = kind === "image" ? "video" : kind;
    var main = p.tracks.filter(function (t) { return t.kind === want && (want !== "video" || t.main); })[0];
    return main || p.tracks.filter(function (t) { return t.kind === want; })[0];
  }
  function findClip(p, id) {
    for (var i = 0; i < p.tracks.length; i++) {
      var tr = p.tracks[i];
      for (var j = 0; j < tr.clips.length; j++) if (tr.clips[j].id === id) return { track: tr, clip: tr.clips[j], index: j };
    }
    return null;
  }
  function sortTrack(tr) { tr.clips.sort(function (a, b) { return a.start - b.start; }); }
  // Magnetic main track: no gaps, order by start (a moved clip is ordered by its centre).
  function pack(tr, moved, at) {
    // a moved clip swaps with a neighbour once its leading edge passes the neighbour's centre
    var key = function (c) { return c === moved ? (at < c.start ? at : at + clipDur(c)) : c.start + clipDur(c) / 2; };
    tr.clips.sort(function (a, b) { return key(a) - key(b); });
    chain(tr);
  }
  function chain(tr) { var t = 0; tr.clips.forEach(function (c) { c.start = t; t += clipDur(c); }); }
  function magnetic(p, tr) { return p.magnetic && tr.kind === "video" && tr.main; }
  function settle(p, tr, moved, at) { if (magnetic(p, tr)) pack(tr, moved, at); else sortTrack(tr); }

  function addClip(p, trackId, c) {
    var tr = p.tracks.filter(function (t) { return t.id === trackId; })[0];
    if (!tr) return null;
    if (magnetic(p, tr)) { tr.clips.push(c); pack(tr, c, c.start); } else { tr.clips.push(c); sortTrack(tr); }
    return c;
  }
  // Insert a media clip at time t: on the magnetic track it goes into the nearest cut.
  function insertMedia(p, m, t) {
    var tr = trackFor(p, m.kind);
    if (!tr) return null;
    var c = newClip(m.kind, m, t);
    if (magnetic(p, tr)) {
      var idx = tr.clips.filter(function (x) { return x.start + clipDur(x) / 2 < t; }).length;
      tr.clips.splice(idx, 0, c); chain(tr);
    } else { c.start = Math.max(0, t); tr.clips.push(c); sortTrack(tr); }
    return c;
  }

  function split(p, id, t) {
    var f = findClip(p, id);
    if (!f) return null;
    var c = f.clip;
    if (t <= c.start + MIN_DUR / 2 || t >= clipEnd(c) - MIN_DUR / 2) return null;
    var s = srcTime(c, t), b = clone(c);
    b.id = uid("c"); b.in = s; b.start = t;
    c.out = s;
    if (b.tr) b.tr = { type: "none", dur: c.tr ? c.tr.dur : 0.5 };
    if ("fadeOut" in c) { b.fadeIn = 0; c.fadeOut = 0; }
    f.track.clips.splice(f.index + 1, 0, b);
    return b;
  }
  function maxOut(p, c) {
    var m = c.media && p.media[c.media];
    return m && m.kind !== "image" ? m.dur : MAX_T;
  }
  // edge: "start" | "end"; t: the timeline time the edge should move to.
  function trim(p, id, edge, t) {
    var f = findClip(p, id);
    if (!f) return false;
    var c = f.clip, sp = c.speed || 1;
    if (edge === "start") {
      var ni = c.in + (t - c.start) * sp;
      ni = Math.max(0, Math.min(ni, c.out - MIN_DUR * sp));
      if (c.media && p.media[c.media] && p.media[c.media].kind === "image") { // photos have no source offset: keep in = 0
        var d = clipDur(c) - (ni - c.in) / sp; c.start = Math.max(0, c.start + (ni - c.in) / sp); c.out = c.in + d * sp;
      } else { c.start = Math.max(0, tlTime(c, ni)); c.in = ni; }
    } else {
      var no = c.in + (t - c.start) * sp;
      c.out = Math.max(c.in + MIN_DUR * sp, Math.min(no, maxOut(p, c)));
    }
    settle(p, f.track);
    return true;
  }
  function move(p, id, start, trackId) {
    var f = findClip(p, id);
    if (!f) return false;
    var dest = f.track;
    if (trackId && trackId !== f.track.id) {
      var d = p.tracks.filter(function (t) { return t.id === trackId; })[0];
      if (d && d.kind === f.track.kind) {
        f.track.clips.splice(f.index, 1); d.clips.push(f.clip); settle(p, f.track); dest = d;
      }
    }
    start = Math.max(0, start);
    if (magnetic(p, dest)) pack(dest, f.clip, start);
    else { f.clip.start = start; sortTrack(dest); }
    return true;
  }
  function remove(p, id, ripple) {
    var f = findClip(p, id);
    if (!f) return false;
    var c = f.clip, d = clipDur(c);
    f.track.clips.splice(f.index, 1);
    if (ripple && !magnetic(p, f.track)) f.track.clips.forEach(function (x) { if (x.start >= c.start - EPS) x.start = Math.max(0, x.start - d); });
    settle(p, f.track);
    return true;
  }
  function duplicate(p, id) {
    var f = findClip(p, id);
    if (!f) return null;
    var b = clone(f.clip); b.id = uid("c"); b.start = clipEnd(f.clip);
    if (b.tr) b.tr = { type: "none", dur: b.tr.dur };
    f.track.clips.splice(f.index + 1, 0, b);
    if (magnetic(p, f.track)) chain(f.track); else sortTrack(f.track);
    return b;
  }
  function setSpeed(p, id, speed) {
    var f = findClip(p, id);
    if (!f) return false;
    speed = Math.max(0.25, Math.min(4, +speed || 1));
    f.clip.speed = speed;
    settle(p, f.track);
    return true;
  }
  function duration(p) {
    var d = 0;
    p.tracks.forEach(function (tr) { tr.clips.forEach(function (c) { d = Math.max(d, clipEnd(c)); }); });
    return d;
  }
  function cuts(p) { // every time where a clip starts or ends, for snapping
    var s = [0];
    p.tracks.forEach(function (tr) { tr.clips.forEach(function (c) { s.push(c.start, clipEnd(c)); }); });
    return s;
  }
  function snap(t, points, tol) {
    var best = null, bd = tol;
    points.forEach(function (x) { var d = Math.abs(x - t); if (d <= bd) { bd = d; best = x; } });
    return best;
  }

  // ---------- transitions ----------
  function smooth(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
  function prevAbutting(tr, i) {
    var a = tr.clips[i - 1], b = tr.clips[i];
    return a && Math.abs(clipEnd(a) - b.start) < 1e-3 ? a : null;
  }
  function trDur(a, b) { return Math.max(0, Math.min(b.tr.dur || 0, clipDur(a), clipDur(b), 3)); }
  // What a video track shows at time t: [{clip, src, alpha, dx, cover:{color,alpha}}], drawn in order.
  function videoLayers(tr, t) {
    var cl = tr.clips;
    for (var i = 1; i < cl.length; i++) {
      var b = cl[i];
      if (!b.tr || b.tr.type === "none") continue;
      var a = prevAbutting(tr, i);
      if (!a) continue;
      var d = trDur(a, b);
      if (d <= 0) continue;
      if (Math.abs(t - b.start) < d / 2) return transLayers(a, b, (t - (b.start - d / 2)) / d, b.tr.type, t);
    }
    for (var j = 0; j < cl.length; j++) if (activeAt(cl[j], t)) return [{ clip: cl[j], src: srcTime(cl[j], t), alpha: 1, dx: 0 }];
    return [];
  }
  function transLayers(a, b, p, type, t) {
    var e = smooth(p), A = { clip: a, src: srcTime(a, t), alpha: 1, dx: 0 }, B = { clip: b, src: srcTime(b, t), alpha: 1, dx: 0 };
    if (type === "fade") { B.alpha = e; return [A, B]; }
    if (type === "slide") { A.dx = -e; B.dx = 1 - e; return [A, B]; }
    var k = p < 0.5 ? smooth(p * 2) : smooth((1 - p) * 2), L = p < 0.5 ? A : B; // black / white: dip through a colour
    L.cover = { color: type === "white" ? "#ffffff" : "#000000", alpha: k };
    return [L];
  }

  // ---------- envelopes (shared by preview and export so they sound the same) ----------
  function fadeGain(c, t) {
    var local = t - c.start, d = clipDur(c), g = 1;
    if (local < 0 || local > d) return 0;
    if (c.fadeIn > 0 && local < c.fadeIn) g *= local / c.fadeIn;
    if (c.fadeOut > 0 && d - local < c.fadeOut) g *= (d - local) / c.fadeOut;
    return Math.max(0, Math.min(1, g));
  }
  var DUCK_LEVEL = 0.3, DUCK_RAMP = 0.25;
  function duckIntervals(p) {
    var iv = [];
    p.tracks.forEach(function (tr) {
      if (tr.kind !== "video" || tr.muted) return;
      tr.clips.forEach(function (c) {
        var m = p.media[c.media];
        if (m && m.kind === "video" && m.hasAudio !== false && !c.muted && c.volume > 0.01) iv.push([c.start, clipEnd(c)]);
      });
    });
    return iv;
  }
  function duckFactor(iv, t) {
    var w = 0;
    iv.forEach(function (r) { var dist = t < r[0] ? r[0] - t : t > r[1] ? t - r[1] : 0; w = Math.max(w, 1 - dist / DUCK_RAMP); });
    return 1 - (1 - DUCK_LEVEL) * Math.max(0, Math.min(1, w));
  }
  function clipGain(p, tr, c, t, iv) {
    if (c.muted || tr.muted) return 0;
    var g = (c.volume == null ? 1 : c.volume) * fadeGain(c, t);
    if (tr.kind === "audio" && p.duck) g *= duckFactor(iv || duckIntervals(p), t);
    return g;
  }
  // Visual fade of a video/photo clip (fades to the background).
  function fadeAlpha(c, t) { return (c.fadeIn > 0 || c.fadeOut > 0) ? fadeGain(c, t) : 1; }

  // Text in/out animation state at time t.
  function textAnim(c, t) {
    var local = t - c.start, d = clipDur(c), inD = Math.min(0.45, d / 3), outD = Math.min(0.3, d / 4);
    var pin = inD > 0 ? Math.max(0, Math.min(1, local / inD)) : 1, pout = outD > 0 ? Math.max(0, Math.min(1, (d - local) / outD)) : 1;
    var r = { alpha: 1, scale: 1, dy: 0, chars: 1 };
    switch (c.anim) {
      case "fade": r.alpha = smooth(pin) * smooth(pout); break;
      case "pop": var e = pin < 1 ? 1 - Math.pow(1 - pin, 3) : 1; r.scale = 0.6 + 0.4 * e + Math.sin(Math.PI * pin) * 0.08; r.alpha = Math.min(1, pin * 3) * smooth(pout); break;
      case "slide": r.dy = (1 - smooth(pin)) * 0.06; r.alpha = smooth(pin) * smooth(pout); break;
      case "type": r.chars = Math.max(0, Math.min(1, local / Math.max(0.2, Math.min(1.6, d * 0.5)))); r.alpha = smooth(pout); break;
    }
    return r;
  }

  // ---------- history (snapshots of the project JSON) ----------
  function History(limit) { this.undo = []; this.redo = []; this.limit = limit || 120; }
  History.prototype.record = function (before) {
    this.undo.push(before); if (this.undo.length > this.limit) this.undo.shift(); this.redo = [];
  };
  History.prototype.back = function (current) { if (!this.undo.length) return null; this.redo.push(current); return this.undo.pop(); };
  History.prototype.fwd = function (current) { if (!this.redo.length) return null; this.undo.push(current); return this.redo.pop(); };

  // ---------- .s3video files: strict validation; anything unexpected is dropped or rejected ----------
  var ID = { test: function (s) { return /^[A-Za-z0-9_-]{1,48}$/.test(s) && !/^(__proto__|constructor|prototype|hasOwnProperty)$/.test(s); } }, LIMITS = { bytes: 5e6, media: 500, tracks: 16, clips: 4000, text: 2000 };
  function num(v, lo, hi, def) { v = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? +v : NaN; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; }
  function str(v, max, def) { return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max) : def; }
  function pick(v, list, def) { return list.indexOf(v) >= 0 ? v : def; }
  function color(v, def) { return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : def; }
  function bool(v, def) { return typeof v === "boolean" ? v : def; }
  function cleanName(v) { return str(v, 200, "media").replace(/[\\/:*?"<>|]+/g, "_") || "media"; }

  function sanitize(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Not a project");
    var src = data.project, def = newProject();
    if (!src || typeof src !== "object" || Array.isArray(src)) throw new Error("Project data is missing");
    var p = { v: 1, name: str(src.name, 120, def.name) || def.name, aspect: pick(src.aspect, Object.keys(ASPECTS), "9:16"),
      bg: pick(src.bg, ["blur", "color"], "blur"), bgColor: color(src.bgColor, "#000000"), fps: pick(src.fps, [24, 25, 30, 60], 30),
      duck: bool(src.duck, true), magnetic: bool(src.magnetic, true), media: {}, tracks: [] };
    var cs = src.captionStyle && typeof src.captionStyle === "object" ? src.captionStyle : {};
    p.captionStyle = { preset: pick(cs.preset, CAPTION_PRESETS, "bold"), size: num(cs.size, 2, 20, 6.5), y: num(cs.y, 0.05, 0.95, 0.76),
      font: pick(cs.font, FONTS, "system"), pop: bool(cs.pop, true) };
    var media = Array.isArray(data.media) ? data.media : [];
    if (media.length > LIMITS.media) throw new Error("Too many media files");
    media.forEach(function (m) {
      if (!m || typeof m !== "object" || typeof m.id !== "string" || !ID.test(m.id)) return;
      var kind = pick(m.kind, ["video", "image", "audio"], null);
      if (!kind) return;
      p.media[m.id] = { id: m.id, name: cleanName(m.name), kind: kind, dur: num(m.dur, 0, MAX_T, kind === "image" ? 0 : 1),
        w: num(m.w, 0, 16384, 0), h: num(m.h, 0, 16384, 0), size: num(m.size, 0, 1e12, 0), type: str(m.type, 100, "").replace(/[^a-z0-9/.+;=, -]/gi, ""),
        hasAudio: bool(m.hasAudio, kind !== "image") };
    });
    if (!Array.isArray(src.tracks) || !src.tracks.length) throw new Error("Project has no tracks");
    if (src.tracks.length > LIMITS.tracks) throw new Error("Too many tracks");
    var total = 0, seen = {};
    src.tracks.forEach(function (t) {
      if (!t || typeof t !== "object") throw new Error("Invalid track");
      var kind = pick(t.kind, ["video", "text", "caption", "audio"], null);
      if (!kind) throw new Error("Invalid track kind");
      var id = typeof t.id === "string" && ID.test(t.id) && !seen[t.id] ? t.id : uid("t"); seen[id] = 1;
      var tr = { id: id, kind: kind, name: str(t.name, 40, kind) || kind, clips: [] };
      if (kind === "video" && t.main === true && !p.tracks.some(function (x) { return x.main; })) tr.main = true;
      if (t.muted === true) tr.muted = true;
      if (t.hidden === true) tr.hidden = true;
      var clips = Array.isArray(t.clips) ? t.clips : [];
      total += clips.length;
      if (total > LIMITS.clips) throw new Error("Too many clips");
      clips.forEach(function (c) {
        var k = cleanClip(c, kind, p);
        if (k && !seen[k.id]) { seen[k.id] = 1; tr.clips.push(k); }
      });
      sortTrack(tr);
      p.tracks.push(tr);
    });
    if (!p.tracks.some(function (x) { return x.main; })) {
      var v = p.tracks.filter(function (x) { return x.kind === "video"; });
      if (v.length) v[v.length - 1].main = true;
    }
    return p;
  }
  function cleanClip(c, kind, p) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return null;
    var k = { id: typeof c.id === "string" && ID.test(c.id) ? c.id : uid("c"), start: num(c.start, 0, MAX_T, 0), in: num(c.in, 0, MAX_T, 0) };
    k.out = num(c.out, k.in + MIN_DUR, MAX_T + 1, k.in + 3); k.speed = 1;
    if (kind === "video" || kind === "audio") {
      if (typeof c.media !== "string" || !p.media[c.media]) return null;
      var m = p.media[c.media];
      if (kind === "audio" ? m.kind !== "audio" && m.kind !== "video" : m.kind === "audio") return null;
      k.media = c.media; k.speed = m.kind === "image" ? 1 : num(c.speed, 0.25, 4, 1);
      k.volume = num(c.volume, 0, 2, 1); k.muted = bool(c.muted, false); k.fadeIn = num(c.fadeIn, 0, 10, 0); k.fadeOut = num(c.fadeOut, 0, 10, 0);
      if (kind === "video") {
        k.fit = pick(c.fit, ["fit", "fill"], "fit"); k.scale = num(c.scale, 0.1, 4, 1); k.x = num(c.x, -1, 1, 0); k.y = num(c.y, -1, 1, 0);
        k.kb = pick(c.kb, ["none", "in", "out"], "none");
        var tr = c.tr && typeof c.tr === "object" ? c.tr : {};
        k.tr = { type: pick(tr.type, TRANSITIONS, "none"), dur: num(tr.dur, 0.1, 3, 0.5) };
      }
    } else if (kind === "text") {
      k.text = str(c.text, LIMITS.text, "Text"); k.font = pick(c.font, FONTS, "system"); k.custom = str(c.custom, 80, "").replace(/[^\w \-؀-ۿ]/g, "");
      k.size = num(c.size, 1, 40, 9); k.color = color(c.color, "#ffffff"); k.color2 = color(c.color2, "#000000");
      k.style = pick(c.style, TEXT_STYLES, "outline"); k.bold = bool(c.bold, true); k.align = pick(c.align, ["left", "center", "right"], "center");
      k.x = num(c.x, 0, 1, 0.5); k.y = num(c.y, 0, 1, 0.3); k.anim = pick(c.anim, ANIMS, "none");
    } else {
      k.text = str(c.text, LIMITS.text, "");
    }
    return k;
  }
  function toFile(p) {
    var copy = clone(p), media = Object.keys(copy.media).map(function (id) { return copy.media[id]; });
    delete copy.media;
    return JSON.stringify({ format: "s3video", v: 1, app: "S3eidat Video Editor", saved: new Date().toISOString(), media: media, project: copy }, null, 1);
  }
  function fromFile(text) {
    if (typeof text !== "string" || text.length > LIMITS.bytes) throw new Error("File is too large to be a project");
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("This file isn't valid JSON"); }
    if (!data || data.format !== "s3video") throw new Error("Not a .s3video project file");
    if (data.v !== 1) throw new Error("This project was made by a newer version");
    return sanitize(data);
  }

  // ---------- SRT ----------
  function fmtSrt(t) {
    var ms = Math.round(Math.max(0, t) * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return [h, m, s].map(function (x) { return String(x).padStart(2, "0"); }).join(":") + "," + String(ms % 1000).padStart(3, "0");
  }
  function toSrt(clips) {
    return clips.slice().sort(function (a, b) { return a.start - b.start; }).map(function (c, i) {
      return (i + 1) + "\n" + fmtSrt(c.start) + " --> " + fmtSrt(clipEnd(c)) + "\n" + (c.text || "").trim() + "\n";
    }).join("\n");
  }
  function parseSrt(text) {
    var out = [], rx = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;
    String(text || "").replace(/\r/g, "").split(/\n\s*\n/).forEach(function (block) {
      var lines = block.split("\n"), i = lines.findIndex(function (l) { return rx.test(l); });
      if (i < 0) return;
      var m = rx.exec(lines[i]), ts = function (a) { return +m[a] * 3600 + +m[a + 1] * 60 + +m[a + 2] + +(m[a + 3] + "00").slice(0, 3) / 1000; };
      var s = ts(1), e = ts(5), txt = lines.slice(i + 1).join("\n").replace(/<[^>]*>/g, "").trim();
      if (e > s && txt) out.push({ start: s, end: e, text: txt.slice(0, LIMITS.text) });
    });
    return out.slice(0, 3000);
  }
  // Spread typed text over [t0, t1]: one segment per sentence/line, time proportional to its length.
  function autoSegments(text, t0, t1, maxWords) {
    maxWords = maxWords || 7;
    var parts = [];
    String(text || "").split(/\n+/).forEach(function (line) {
      line.replace(/([.!?؟…])\s+/g, "$1\n").split("\n").forEach(function (s) {
        var w = s.trim().split(/\s+/).filter(Boolean);
        for (var i = 0; i < w.length; i += maxWords) parts.push(w.slice(i, i + maxWords).join(" "));
      });
    });
    if (!parts.length || t1 <= t0) return [];
    var weight = parts.map(function (s) { return Math.max(4, s.length); }), sum = weight.reduce(function (a, b) { return a + b; }, 0), t = t0;
    return parts.map(function (s, i) { var d = (t1 - t0) * weight[i] / sum, seg = { start: t, end: t + d, text: s }; t += d; return seg; });
  }

  function fmtTime(t, ms) {
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * 100);
    return m + ":" + String(s).padStart(2, "0") + (ms ? "." + String(f).padStart(2, "0") : "");
  }

  VE.model = {
    EPS: EPS, MIN_DUR: MIN_DUR, ASPECTS: ASPECTS, TEXT_STYLES: TEXT_STYLES, ANIMS: ANIMS, TRANSITIONS: TRANSITIONS, FONTS: FONTS, CAPTION_PRESETS: CAPTION_PRESETS,
    dims: dims, uid: uid, clone: clone, newProject: newProject, newClip: newClip, trackFor: trackFor, findClip: findClip,
    clipDur: clipDur, clipEnd: clipEnd, srcTime: srcTime, tlTime: tlTime, activeAt: activeAt,
    addClip: addClip, insertMedia: insertMedia, split: split, trim: trim, move: move, remove: remove, duplicate: duplicate, setSpeed: setSpeed,
    pack: pack, chain: chain, sortTrack: sortTrack, settle: settle, magnetic: magnetic, duration: duration, cuts: cuts, snap: snap,
    smooth: smooth, videoLayers: videoLayers, trDur: trDur, prevAbutting: prevAbutting, fadeGain: fadeGain, fadeAlpha: fadeAlpha,
    duckIntervals: duckIntervals, duckFactor: duckFactor, clipGain: clipGain, DUCK_LEVEL: DUCK_LEVEL, textAnim: textAnim,
    History: History, sanitize: sanitize, toFile: toFile, fromFile: fromFile, toSrt: toSrt, parseSrt: parseSrt, autoSegments: autoSegments,
    fmtTime: fmtTime, fmtSrt: fmtSrt
  };
})();
