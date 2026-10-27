/* Video Editor UI: media bin, preview player, timeline, inspector, captions, export dialog, autosave. */
(function () {
  "use strict";
  var VE = window.VE, M = VE.model, R = VE.render, MD = VE.media, $ = S3.$, $$ = S3.$$, h = S3.h;

  // ---------- state ----------
  var P = M.newProject(), hist = new M.History(), sel = null, selCut = null, t = 0;
  var playing = false, rate = 1, loop = false, clockT = 0, clockAt = 0, pending = null;
  var prefs = Object.assign({ pps: 60, snap: true, tab: "media", res: "1080", fps: "30", q: "std" }, S3.store("veditor") || {});
  function savePrefs() { S3.store("veditor", prefs); }
  var view = $("#view"), vctx = view.getContext("2d", { alpha: false });
  var LANE_H = { video: 62, text: 30, caption: 30, audio: 42 };

  function snapshot() { return JSON.stringify(P); }
  function restore(json) {
    var media = P.media;
    P = JSON.parse(json);
    Object.keys(media).forEach(function (id) { if (!P.media[id]) P.media[id] = media[id]; }); // the bin survives undo
  }
  function edit(fn, opt) {
    var before = snapshot();
    var r = fn(P);
    if (snapshot() !== before) { hist.record(before); changed(opt); }
    return r;
  }
  function changed(opt) {
    opt = opt || {};
    if (sel && !M.findClip(P, sel)) sel = null;
    if (selCut && !M.findClip(P, selCut)) selCut = null;
    renderTimeline(); if (!opt.keepInsp) renderInsp(); renderCapList(opt.keepCaps); renderBar(); requestDraw(); autosave();
  }
  // Sliders and text fields: live preview while dragging/typing, one undo step per gesture.
  function live(el, apply, opt) {
    var ev = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(ev, function () {
      if (pending == null) pending = snapshot();
      apply(el.type === "checkbox" ? el.checked : el.value);
      renderTimeline(); requestDraw(); renderBar(); if (opt && opt.caps) renderCapList(true);
      if (ev === "change") commit();
    });
    if (ev === "input") el.addEventListener("change", commit);
    function commit() { if (pending != null && pending !== snapshot()) hist.record(pending); pending = null; autosave(); renderBar(); if (opt && opt.rebuild) renderInsp(); }
  }

  // ---------- autosave ----------
  var saveTimer = null, saveFailed = false;
  function autosave() {
    $("#saveState").textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      MD.idb.saveState(M.toFile(P)).then(function () { $("#saveState").textContent = "Saved here"; $("#saveState").className = "chip"; },
        function () { $("#saveState").textContent = "Not saved"; $("#saveState").className = "chip warn"; });
    }, 600);
  }
  function storeMedia(m) {
    return MD.idb.putMedia(m).catch(function () {
      if (!saveFailed) { saveFailed = true; S3.toast("This browser's storage is full, so " + m.name + " isn't kept for next time. Save a .s3video file to be safe.", "error"); }
    });
  }

  // ---------- media bin ----------
  var importing = 0;
  S3.drop($("#drop"), importFiles, { accept: "video/*,image/*,audio/*,.mp4,.m4v,.mov,.webm,.mkv,.mp3,.m4a,.wav,.ogg,.opus,.flac,.aac", multiple: true });
  async function importFiles(files, opt) {
    opt = opt || {};
    var wasEmpty = !M.duration(P), added = [];
    importing += files.length; renderBin();
    for (var i = 0; i < files.length; i++) {
      try {
        var m = await MD.probe(files[i]);
        P.media[m.id] = m; added.push(m); storeMedia(m);
      } catch (e) { S3.toast((e && e.message) || "Couldn't open " + files[i].name, "error"); }
      importing--; renderBin();
    }
    if (added.length && (wasEmpty || opt.place)) {
      edit(function (p) {
        added.forEach(function (m) {
          var tr = M.trackFor(p, m.kind);
          var at = m.kind === "audio" ? 0 : tr && tr.clips.length ? M.clipEnd(tr.clips[tr.clips.length - 1]) : 0;
          M.insertMedia(p, m, at + 1e-3);
        });
      });
      if (!opt.quiet) S3.toast(added.length === 1 ? "Added to the timeline" : added.length + " files added to the timeline");
    } else if (added.length) { changed(); if (!opt.quiet) S3.toast(added.length + " added to Media. Drag onto the timeline or press +"); }
    added.forEach(function (m) { if (m.kind === "video") MD.ensureWave(m).then(function () { renderTimeline(); }); });
    return added;
  }
  function usedMedia(id) { return P.tracks.some(function (tr) { return tr.clips.some(function (c) { return c.media === id; }); }); }
  function renderBin() {
    var box = $("#bin"); box.textContent = "";
    var ids = Object.keys(P.media);
    ids.forEach(function (id) {
      var m = P.media[id], rt = MD.lib[id] || {}, img = rt.thumb || rt.wave;
      var item = h("div", { "class": "ve-item k-" + m.kind + (m.missing ? " missing" : ""), draggable: m.missing ? "false" : "true", title: m.name }, [
        img ? h("img", { src: img, alt: "" }) : h("div", { "class": "ve-ph-img", text: m.missing ? "Missing" : m.kind }),
        h("span", { "class": "ve-dur mono", text: m.kind === "image" ? "photo" : M.fmtTime(m.dur) }),
        h("span", { "class": "ve-iname", text: m.name }),
        h("div", { "class": "ve-iact" }, [
          h("button", { "class": "btn small icon", "aria-label": "Add " + m.name + " at the playhead", title: "Add at playhead", html: S3.icon("plus"), disabled: m.missing ? true : null, onclick: function () { addMedia(m); } }),
          h("button", { "class": "btn small icon ghost", "aria-label": "Remove " + m.name, title: "Remove from project", html: S3.icon("x"), onclick: function () { removeMedia(m); } })
        ])
      ]);
      item.addEventListener("dragstart", function (e) { e.dataTransfer.setData("text/ve-media", id); e.dataTransfer.effectAllowed = "copy"; });
      box.appendChild(item);
    });
    for (var i = 0; i < importing; i++) box.appendChild(h("div", { "class": "ve-item loading" }, [h("div", { "class": "ve-ph-img", text: "Reading…" })]));
    $("#binHint").hidden = !ids.length;
  }
  function addMedia(m, trackId, at) {
    edit(function (p) {
      var tr = trackId ? p.tracks.filter(function (x) { return x.id === trackId; })[0] : M.trackFor(p, m.kind);
      if (!tr) return;
      var time = at == null ? t : at, c;
      if (tr.kind === "audio") { c = M.newClip("audio", m, time); if (m.kind === "video") c.out = m.dur; M.addClip(p, tr.id, c); }
      else if (M.magnetic(p, tr)) c = M.insertMedia(p, m, time);
      else { c = M.newClip(m.kind, m, time); M.addClip(p, tr.id, c); }
      if (c) sel = c.id;
    });
  }
  function removeMedia(m) {
    if (usedMedia(m.id) && !confirm("Remove " + m.name + " and its clips from the timeline?")) return;
    edit(function (p) { p.tracks.forEach(function (tr) { tr.clips = tr.clips.filter(function (c) { return c.media !== m.id; }); M.settle(p, tr); }); });
    delete P.media[m.id]; MD.forget(m.id); MD.idb.delMedia(m.id).catch(function () {});
    changed();
  }

  // ---------- preview player ----------
  var pool = {}, actx = null, drawQueued = false;
  function audioCtx() {
    if (actx || !(window.AudioContext || window.webkitAudioContext)) return actx;
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
    return actx;
  }
  function entry(c, m) {
    var e = pool[c.id];
    if (e && e.media === m.id) return e;
    if (e) dropEntry(c.id);
    var rt = MD.lib[m.id];
    if (!rt) return null;
    var el = document.createElement(m.kind === "audio" ? "audio" : "video");
    el.preload = "auto"; el.playsInline = true; el.muted = false; el.src = rt.url;
    if ("preservesPitch" in el) el.preservesPitch = true;
    el.addEventListener("seeked", requestDraw); el.addEventListener("loadeddata", requestDraw);
    e = pool[c.id] = { el: el, media: m.id, gain: null };
    return e;
  }
  function route(e) {
    var ctx = audioCtx();
    if (!ctx || e.gain || e.failed) return;
    try { var src = ctx.createMediaElementSource(e.el), g = ctx.createGain(); src.connect(g); g.connect(ctx.destination); e.gain = g; }
    catch (x) { e.failed = true; }
  }
  function dropEntry(id) { var e = pool[id]; if (!e) return; e.el.pause(); e.el.removeAttribute("src"); e.el.load(); if (e.gain) e.gain.disconnect(); delete pool[id]; }
  function sync() {
    var live = {}, iv = M.duckIntervals(P), moving = playing && rate > 0;
    P.tracks.forEach(function (tr) {
      if (tr.kind !== "video" && tr.kind !== "audio") return;
      tr.clips.forEach(function (c, i) {
        var m = P.media[c.media];
        if (!m || m.kind === "image" || m.missing) return;
        var pre = 0, post = 0;
        if (tr.kind === "video") {
          if (c.tr && c.tr.type !== "none" && M.prevAbutting(tr, i)) pre = M.trDur(M.prevAbutting(tr, i), c) / 2;
          var nx = tr.clips[i + 1]; if (nx && nx.tr && nx.tr.type !== "none" && M.prevAbutting(tr, i + 1) === c) post = M.trDur(c, nx) / 2;
        }
        var near = t >= c.start - pre - 1.5 && t < M.clipEnd(c) + post; // warm up 1.5 s early
        if (!near) return;
        var e = entry(c, m);
        if (!e) return;
        live[c.id] = 1;
        var el = e.el, active = t >= c.start - pre && t < M.clipEnd(c) + post, s = Math.max(0, Math.min(M.srcTime(c, t), (m.dur || 0) - 0.02));
        if (!active) { if (!el.paused) el.pause(); if (Math.abs(el.currentTime - Math.max(0, c.in)) > 0.05 && !el.seeking) el.currentTime = c.in; return; }
        var g = (tr.kind === "video" && tr.hidden) ? 0 : M.clipGain(P, tr, c, Math.max(c.start, Math.min(t, M.clipEnd(c) - 1e-3)), iv);
        if (t < c.start || t >= M.clipEnd(c)) g = 0; // transition handles: picture only
        if (!moving) g = 0;
        if (moving) {
          route(e);
          var pr = Math.max(0.0625, Math.min(16, (c.speed || 1) * rate));
          if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
          if (el.paused) { if (Math.abs(el.currentTime - s) > 0.05) el.currentTime = s; el.play().catch(function () {}); }
          else if (Math.abs(el.currentTime - s) > 0.3) el.currentTime = s;
        } else {
          if (!el.paused) el.pause();
          if (!el.seeking && Math.abs(el.currentTime - s) > 0.02) el.currentTime = s;
        }
        if (e.gain) e.gain.gain.value = g; else el.volume = Math.max(0, Math.min(1, g));
      });
    });
    Object.keys(pool).forEach(function (id) { if (!live[id]) { if (M.findClip(P, id)) { if (!pool[id].el.paused) pool[id].el.pause(); } else dropEntry(id); } });
    var keys = Object.keys(pool);
    if (keys.length > 14) keys.forEach(function (id) { if (!live[id]) dropEntry(id); });
  }
  function provider(c, m) {
    if (m.kind === "image") { var rt = MD.lib[m.id]; return rt && rt.bitmap || null; }
    var e = pool[c.id];
    return e && e.el.readyState >= 2 ? e.el : null;
  }
  function sizeView() {
    var d = M.dims(P.aspect, 540);
    if (view.width !== d.w || view.height !== d.h) { view.width = d.w; view.height = d.h; }
    var wrap = $("#viewWrap"), W = wrap.clientWidth, H = wrap.clientHeight;
    if (W > 0 && H > 0) {
      var k = Math.min(W / d.w, H / d.h), cw = Math.floor(d.w * k) + "px", ch = Math.floor(d.h * k) + "px";
      if (view.style.width !== cw) view.style.width = cw;
      if (view.style.height !== ch) view.style.height = ch;
    }
  }
  function draw() {
    sizeView();
    sync();
    R.paint(vctx, view.width, view.height, P, t, provider);
    var dur = M.duration(P);
    $("#tc").textContent = M.fmtTime(t, true) + " / " + M.fmtTime(dur);
    $("#playhead").style.transform = "translateX(" + (t * prefs.pps) + "px)";
    $("#stageEmpty").hidden = dur > 0;
  }
  function requestDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(function () { drawQueued = false; if (!playing) draw(); }); }
  function setPlayIcon() { $("#playBtn").innerHTML = S3.icon(playing ? "pause" : "play"); $("#playBtn").setAttribute("aria-label", playing ? "Pause (Space)" : "Play (Space)"); }
  function play(r) {
    var dur = M.duration(P);
    if (!dur) return;
    var ctx = audioCtx(); if (ctx && ctx.state === "suspended") ctx.resume();
    rate = r || 1;
    if (rate > 0 && t >= dur - 0.02) t = 0;
    if (!playing) { playing = true; requestAnimationFrame(tick); }
    clockT = t; clockAt = performance.now();
    setPlayIcon();
  }
  function pause() { playing = false; rate = 1; Object.keys(pool).forEach(function (id) { pool[id].el.pause(); }); setPlayIcon(); requestDraw(); }
  function tick() {
    if (!playing) return;
    var dur = M.duration(P);
    t = clockT + (performance.now() - clockAt) / 1000 * rate;
    if (t >= dur) { if (loop && rate > 0) { t = 0; clockT = 0; clockAt = performance.now(); Object.keys(pool).forEach(function (id) { pool[id].el.pause(); }); } else { t = dur; draw(); pause(); return; } }
    if (t <= 0 && rate < 0) { t = 0; draw(); pause(); return; }
    draw(); follow();
    requestAnimationFrame(tick);
  }
  function seek(x) {
    t = Math.max(0, Math.min(x, Math.max(M.duration(P), 0)));
    if (playing) { clockT = t; clockAt = performance.now(); }
    requestDraw();
  }
  function follow() {
    var sc = $("#tlScroll"), x = t * prefs.pps;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - 60);
  }
  $("#playBtn").addEventListener("click", function () { if (playing) pause(); else play(1); });
  $("#toStart").addEventListener("click", function () { seek(0); $("#tlScroll").scrollLeft = 0; });
  $("#toEnd").addEventListener("click", function () { seek(M.duration(P)); follow(); });
  $("#loopBtn").addEventListener("click", function () { loop = !loop; this.setAttribute("aria-pressed", String(loop)); });
  view.addEventListener("click", function () { if (M.duration(P)) { if (playing) pause(); else play(1); } });

  // ---------- timeline ----------
  var tlDrag = null;
  function stepFor(pps) { var st = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]; for (var i = 0; i < st.length; i++) if (st[i] * pps >= 64) return st[i]; return 600; }
  function renderTimeline() {
    var pps = prefs.pps, dur = M.duration(P), span = Math.max(dur + 8, ($("#tlScroll").clientWidth || 800) / pps);
    var inner = $("#tlInner"); inner.style.width = Math.ceil(span * pps) + "px";
    // ruler
    var ruler = $("#ruler"); ruler.textContent = "";
    var step = stepFor(pps), minor = step / 5;
    for (var ti = 0; ti * minor <= span; ti++) {
      var s = Math.round(ti * minor * 1000) / 1000, major = ti % 5 === 0;
      var tk = h("i", { "class": major ? "mj" : "" }); tk.style.left = (s * pps) + "px"; ruler.appendChild(tk);
      if (major) { var lb = h("span", { text: step < 1 ? M.fmtTime(s, true).replace(/0$/, "") : M.fmtTime(s) }); lb.style.left = (s * pps + 3) + "px"; ruler.appendChild(lb); }
    }
    // heads + lanes
    var heads = $("#heads"), lanes = $("#lanes"); heads.textContent = ""; lanes.textContent = "";
    heads.appendChild(h("div", { "class": "ve-head-ruler" }));
    P.tracks.forEach(function (tr) {
      var hh = LANE_H[tr.kind], head = h("div", { "class": "ve-head k-" + tr.kind }), lane = h("div", { "class": "ve-lane k-" + tr.kind, "data-track": tr.id, "data-kind": tr.kind });
      head.style.height = lane.style.height = hh + "px";
      head.appendChild(h("span", { "class": "ve-tname", text: tr.name }));
      if (tr.kind === "video" || tr.kind === "audio") head.appendChild(h("button", { "class": "btn ghost icon small", "aria-label": (tr.muted ? "Unmute " : "Mute ") + tr.name, title: tr.muted ? "Unmute" : "Mute",
        html: '<svg class="i"><use href="#v-' + (tr.muted ? "muted" : "vol") + '"/></svg>', onclick: function () { edit(function () { tr.muted = !tr.muted; }); } }));
      if (tr.kind !== "audio") head.appendChild(h("button", { "class": "btn ghost icon small", "aria-label": (tr.hidden ? "Show " : "Hide ") + tr.name, title: tr.hidden ? "Show" : "Hide",
        html: '<svg class="i"><use href="#v-' + (tr.hidden ? "eyeoff" : "eye") + '"/></svg>', onclick: function () { edit(function () { tr.hidden = !tr.hidden; }); } }));
      if (!/^t-(cap|text|v1|a1)$/.test(tr.id)) head.appendChild(h("button", { "class": "btn ghost icon small", "aria-label": "Remove track " + tr.name, title: "Remove track", html: S3.icon("x"),
        onclick: function () { if (tr.clips.length && !confirm("Remove the track " + tr.name + " and its clips?")) return; edit(function (p) { p.tracks.splice(p.tracks.indexOf(tr), 1); }); } }));
      tr.clips.forEach(function (c, i) {
        var m = c.media ? P.media[c.media] : null, rt = m ? MD.lib[m.id] || {} : {}, w = Math.max(4, M.clipDur(c) * pps);
        var el = h("div", { "class": "ve-clip k-" + (m ? (tr.kind === "audio" ? "audio" : m.kind) : tr.kind) + (c.id === sel ? " sel" : "") + (m && m.missing ? " missing" : ""), "data-id": c.id, tabindex: "0",
          role: "button", "aria-label": clipLabel(c, m) + ", " + M.fmtTime(M.clipDur(c), true) });
        el.style.left = (c.start * pps) + "px"; el.style.width = w + "px";
        var bg = tr.kind === "audio" ? rt.wave : rt.strip;
        if (bg) el.style.backgroundImage = "url(" + bg + ")";
        el.appendChild(h("span", { "class": "ve-clabel", text: clipLabel(c, m) }));
        if (c.speed && c.speed !== 1) el.appendChild(h("span", { "class": "ve-badge", text: c.speed + "×" }));
        if (c.muted) el.appendChild(h("span", { "class": "ve-badge", text: "muted" }));
        if (c.fadeIn > 0) { var fi = h("i", { "class": "ve-fade in" }); fi.style.width = Math.min(w, c.fadeIn / (c.speed || 1) * pps) + "px"; el.appendChild(fi); }
        if (c.fadeOut > 0) { var fo = h("i", { "class": "ve-fade out" }); fo.style.width = Math.min(w, c.fadeOut / (c.speed || 1) * pps) + "px"; el.appendChild(fo); }
        el.appendChild(h("i", { "class": "ve-hl", "data-edge": "start", title: "Trim start" }));
        el.appendChild(h("i", { "class": "ve-hr", "data-edge": "end", title: "Trim end" }));
        lane.appendChild(el);
        if (tr.kind === "video" && M.prevAbutting(tr, i)) {
          var on = c.tr && c.tr.type !== "none";
          var cut = h("button", { "class": "ve-cut" + (on ? " on" : "") + (selCut === c.id ? " sel" : ""), "data-cut": c.id, "aria-label": "Transition: " + (on ? c.tr.type : "none"), title: on ? "Transition: " + c.tr.type : "Add a transition" });
          cut.style.left = (c.start * pps - 7) + "px";
          lane.appendChild(cut);
        }
      });
      heads.appendChild(head); lanes.appendChild(lane);
    });
    $("#playhead").style.transform = "translateX(" + (t * pps) + "px)";
  }
  function clipLabel(c, m) {
    if (c.text != null) return c.text.replace(/\s+/g, " ").slice(0, 80) || "(empty)";
    return m ? m.name : "Missing media";
  }
  var tlQueued = false;
  function queueTimeline() { if (tlQueued) return; tlQueued = true; requestAnimationFrame(function () { tlQueued = false; renderTimeline(); }); }

  function xToTime(clientX) { var r = $("#tlInner").getBoundingClientRect(); return Math.max(0, (clientX - r.left) / prefs.pps); }
  function snapPoints(exceptId) {
    var pts = [0, t];
    P.tracks.forEach(function (tr) { tr.clips.forEach(function (c) { if (c.id !== exceptId) pts.push(c.start, M.clipEnd(c)); }); });
    return pts;
  }
  function showSnap(x) { var sl = $("#snapline"); if (x == null) { sl.hidden = true; return; } sl.hidden = false; sl.style.transform = "translateX(" + (x * prefs.pps) + "px)"; }
  function laneAt(x, y) { var el = document.elementFromPoint(x, y); return el && el.closest ? el.closest(".ve-lane") : null; }

  $("#lanes").addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    var cut = e.target.closest(".ve-cut");
    if (cut) { selCut = cut.dataset.cut; sel = null; renderTimeline(); renderInsp(); showTab("trans"); return; }
    var el = e.target.closest(".ve-clip");
    if (!el) { sel = null; selCut = null; renderTimeline(); renderInsp(); scrubStart(e); return; }
    var id = el.dataset.id, f = M.findClip(P, id);
    if (!f) return;
    sel = id; selCut = null;
    var edge = e.target.dataset.edge;
    tlDrag = { id: id, mode: edge ? "trim-" + edge : "move", x0: e.clientX, y0: e.clientY, before: snapshot(), start: f.clip.start, end: M.clipEnd(f.clip), track: f.track.id, kind: f.track.kind, moved: false };
    el.setPointerCapture(e.pointerId);
    renderTimeline(); renderInsp();
    e.preventDefault();
  });
  document.addEventListener("pointermove", function (e) {
    if (!tlDrag) return;
    var d = tlDrag, dx = (e.clientX - d.x0) / prefs.pps;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 4 && Math.abs(e.clientY - d.y0) < 6) return;
    d.moved = true;
    restore(d.before);
    var pts = prefs.snap ? snapPoints(d.id) : [], tol = 8 / prefs.pps, snapAt = null;
    if (d.mode === "move") {
      var ns = d.start + dx, len = d.end - d.start;
      if (prefs.snap) {
        var a = M.snap(ns, pts, tol), b = M.snap(ns + len, pts, tol);
        if (a != null && (b == null || Math.abs(a - ns) <= Math.abs(b - ns - len))) { ns = a; snapAt = a; } else if (b != null) { ns = b - len; snapAt = b; }
      }
      var lane = laneAt(e.clientX, e.clientY), dest = lane && lane.dataset.kind === d.kind ? lane.dataset.track : d.track;
      M.move(P, d.id, ns, dest);
    } else {
      var edgeT = (d.mode === "trim-start" ? d.start : d.end) + dx, sn = prefs.snap ? M.snap(edgeT, pts, tol) : null;
      if (sn != null) { edgeT = sn; snapAt = sn; }
      M.trim(P, d.id, d.mode === "trim-start" ? "start" : "end", edgeT);
    }
    showSnap(snapAt);
    queueTimeline(); requestDraw();
  });
  document.addEventListener("pointerup", function () {
    if (!tlDrag) return;
    var d = tlDrag; tlDrag = null; showSnap(null);
    if (d.moved && snapshot() !== d.before) { hist.record(d.before); changed(); }
  });
  function scrubStart(e) {
    var move = function (ev) { seek(xToTime(ev.clientX)); };
    move(e);
    var up = function () { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }
  $("#ruler").addEventListener("pointerdown", function (e) { if (e.button === 0) { scrubStart(e); e.preventDefault(); } });
  $("#lanes").addEventListener("keydown", function (e) {
    var el = e.target.closest(".ve-clip");
    if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sel = el.dataset.id; renderTimeline(); renderInsp(); var x = $('.ve-clip[data-id="' + sel + '"]'); if (x) x.focus(); }
  });
  // drag from the bin onto a lane
  $("#lanes").addEventListener("dragover", function (e) { if (Array.prototype.indexOf.call(e.dataTransfer.types, "text/ve-media") >= 0) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  $("#lanes").addEventListener("drop", function (e) {
    var id = e.dataTransfer.getData("text/ve-media"), m = P.media[id];
    if (!m) return;
    e.preventDefault();
    var lane = e.target.closest(".ve-lane"), at = xToTime(e.clientX), tr = lane && P.tracks.filter(function (x) { return x.id === lane.dataset.track; })[0];
    if (tr && tr.kind === "audio" && m.kind !== "image") addMedia(m, tr.id, at);
    else if (tr && tr.kind === "video" && m.kind !== "audio") addMedia(m, tr.id, at);
    else addMedia(m, null, at);
  });
  // files dropped straight on the timeline
  $("#tlScroll").addEventListener("dragover", function (e) { if (Array.prototype.indexOf.call(e.dataTransfer.types, "Files") >= 0) e.preventDefault(); });
  $("#tlScroll").addEventListener("drop", function (e) { if (e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); importFiles(Array.prototype.slice.call(e.dataTransfer.files), { place: true }); } });

  function setZoom(pps, keepT) {
    var sc = $("#tlScroll"), anchor = keepT != null ? keepT : t, off = anchor * prefs.pps - sc.scrollLeft;
    prefs.pps = Math.max(8, Math.min(400, Math.round(pps))); savePrefs(); $("#zoom").value = prefs.pps;
    renderTimeline(); sc.scrollLeft = Math.max(0, anchor * prefs.pps - off);
  }
  $("#zoom").value = prefs.pps;
  $("#zoom").addEventListener("input", function () { setZoom(+this.value); });
  $("#zIn").addEventListener("click", function () { setZoom(prefs.pps * 1.4); });
  $("#zOut").addEventListener("click", function () { setZoom(prefs.pps / 1.4); });
  $("#tlScroll").addEventListener("wheel", function (e) { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(prefs.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), xToTime(e.clientX)); } }, { passive: false });
  function fitZoom() { var d = M.duration(P), w = $("#tlScroll").clientWidth || 800; if (d > 0) setZoom(Math.max(8, Math.min(200, (w - 60) / d))); }

  // ---------- edit commands ----------
  function selected() { return sel ? M.findClip(P, sel) : null; }
  function doSplit() {
    var f = selected();
    var target = f && M.activeAt(f.clip, t) ? f.clip : null;
    if (!target) { // no selection under the playhead: split whatever the main track shows
      var main = P.tracks.filter(function (x) { return x.main; })[0];
      target = main && main.clips.filter(function (c) { return M.activeAt(c, t); })[0];
    }
    if (!target) { S3.toast("Put the playhead over a clip to split it"); return; }
    var b = edit(function (p) { return M.split(p, target.id, t); });
    if (b) { sel = b.id; renderTimeline(); renderInsp(); } else S3.toast("Too close to the clip's edge to split");
  }
  function doDelete(ripple) { var f = selected(); if (!f) return S3.toast("Select a clip first"); edit(function (p) { M.remove(p, f.clip.id, ripple); }); sel = null; changed(); }
  function doDup() { var f = selected(); if (!f) return S3.toast("Select a clip first"); var b = edit(function (p) { return M.duplicate(p, f.clip.id); }); if (b) { sel = b.id; changed(); } }
  function undo() { var s = hist.back(snapshot()); if (s) { restore(s); changed(); } }
  function redo() { var s = hist.fwd(snapshot()); if (s) { restore(s); changed(); } }
  $("#splitBtn").addEventListener("click", doSplit);
  $("#delBtn").addEventListener("click", function () { doDelete(false); });
  $("#rippleBtn").addEventListener("click", function () { doDelete(true); });
  $("#dupBtn").addEventListener("click", doDup);
  $("#undoBtn").addEventListener("click", undo); $("#redoBtn").addEventListener("click", redo);
  function toggleBtn(id, key, onSet) {
    var b = $(id); b.setAttribute("aria-pressed", String(!!onSet()));
    b.addEventListener("click", function () { var v = !onSet(); key(v); b.setAttribute("aria-pressed", String(v)); });
  }
  toggleBtn("#snapBtn", function (v) { prefs.snap = v; savePrefs(); }, function () { return prefs.snap; });
  $("#magBtn").addEventListener("click", function () {
    edit(function (p) { p.magnetic = !p.magnetic; if (p.magnetic) p.tracks.forEach(function (tr) { if (tr.main) M.pack(tr); }); });
  });
  $("#addTrack").addEventListener("click", function () {
    edit(function (p) {
      var n = p.tracks.filter(function (x) { return x.kind === "video"; }).length;
      var i = p.tracks.findIndex(function (x) { return x.kind === "video"; });
      p.tracks.splice(i, 0, { id: M.uid("t"), kind: "video", name: "Overlay " + n, clips: [] });
    });
    S3.toast("Overlay track added. Drag a clip or photo onto it, then size it on the right.");
  });

  // ---------- inspector ----------
  function field(label, input, out) { return h("label", { "class": "field" }, [h("span", { "class": "row between" }, [h("span", { text: label }), out || null]), input]); }
  function range(min, max, step, val) { return h("input", { type: "range", min: min, max: max, step: step, value: val }); }
  function outEl(txt) { return h("span", { "class": "mono faint", text: txt }); }
  function segEl(opts, val, onPick, label) {
    var s = h("div", { "class": "seg ve-iseg", role: "group", "aria-label": label || "" });
    opts.forEach(function (o) {
      var b = h("button", { "aria-pressed": String(o[0] === val), text: o[1] });
      b.addEventListener("click", function () { $$("button", s).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); onPick(o[0]); });
      s.appendChild(b);
    });
    return s;
  }
  function sliderRow(label, min, max, step, get, set, fmt, opt) {
    var o = outEl(fmt(get())), r = range(min, max, step, get());
    live(r, function (v) { set(+v); o.textContent = fmt(+v); }, opt);
    return field(label, r, o);
  }
  function renderInsp() {
    var box = $("#insp"); box.textContent = "";
    if (selCut) return inspCut(box);
    var f = selected();
    if (!f) return inspProject(box);
    var c = f.clip, tr = f.track, m = c.media ? P.media[c.media] : null;
    var kind = tr.kind === "audio" ? "audio" : tr.kind === "video" ? (m && m.kind === "image" ? "image" : "video") : tr.kind;
    var title = { video: "Video clip", image: "Photo", audio: "Audio", text: "Text", caption: "Caption" }[kind];
    box.appendChild(h("div", { "class": "row between" }, [h("h2", { text: title }), h("button", { "class": "btn ghost icon small", "aria-label": "Deselect", html: S3.icon("x"), onclick: function () { sel = null; renderTimeline(); renderInsp(); } })]));
    if (m) box.appendChild(h("p", { "class": "faint ve-mname", text: m.name + (m.w ? " · " + m.w + "×" + m.h : "") }));
    var g = h("div", { "class": "stack" }); box.appendChild(g);
    var at = h("p", { "class": "mono faint", text: "Starts " + M.fmtTime(c.start, true) + " · lasts " + M.fmtTime(M.clipDur(c), true) });
    g.appendChild(at);
    function cur() { return M.findClip(P, sel).clip; }

    if (kind === "text" || kind === "caption") {
      var ta = h("textarea", { "class": "textarea prose", dir: "auto", rows: "3", "aria-label": "Text" }); ta.value = c.text;
      live(ta, function (v) { cur().text = v.slice(0, 2000); }, { caps: true });
      g.appendChild(field(kind === "caption" ? "Caption text" : "Text", ta));
    }
    if (kind === "image" || kind === "text" || kind === "caption") {
      g.appendChild(sliderRow("Duration", 0.3, 20, 0.1, function () { return +M.clipDur(cur()).toFixed(1); },
        function (v) { var k = cur(); k.out = k.in + v * (k.speed || 1); M.settle(P, M.findClip(P, sel).track); }, function (v) { return v.toFixed(1) + " s"; }));
    }
    if (kind === "video" || kind === "audio") {
      var sp = sliderRow("Speed", 0.25, 4, 0.05, function () { return cur().speed; }, function (v) { M.setSpeed(P, sel, v); }, function (v) { return (+v).toFixed(2).replace(/0$/, "") + "×"; }, { rebuild: true });
      g.appendChild(sp);
      g.appendChild(h("div", { "class": "row ve-chips" }, [0.5, 1, 1.5, 2, 3].map(function (s) {
        return h("button", { "class": "btn small ghost", text: s + "×", onclick: function () { edit(function (p) { M.setSpeed(p, sel, s); }); } });
      })));
    }
    if (kind === "video" || kind === "audio") {
      g.appendChild(sliderRow("Volume", 0, 2, 0.05, function () { return cur().volume; }, function (v) { cur().volume = v; }, function (v) { return Math.round(v * 100) + "%"; }));
      var mu = h("input", { type: "checkbox" }); mu.checked = !!c.muted;
      live(mu, function (v) { cur().muted = v; });
      g.appendChild(h("label", { "class": "check" }, [mu, " Mute this clip"]));
    }
    if (kind === "video" || kind === "image" || kind === "audio") {
      g.appendChild(h("div", { "class": "grid-2" }, [
        sliderRow("Fade in", 0, 3, 0.1, function () { return cur().fadeIn; }, function (v) { cur().fadeIn = v; }, function (v) { return (+v).toFixed(1) + " s"; }),
        sliderRow("Fade out", 0, 3, 0.1, function () { return cur().fadeOut; }, function (v) { cur().fadeOut = v; }, function (v) { return (+v).toFixed(1) + " s"; })
      ]));
    }
    if (kind === "video" || kind === "image") {
      g.appendChild(field("Frame", segEl([["fit", "Fit"], ["fill", "Fill"]], c.fit, function (v) { edit(function () { cur().fit = v; }); }, "Fit or fill")));
      if (kind === "image") g.appendChild(field("Motion (Ken Burns)", segEl([["none", "None"], ["in", "Zoom in"], ["out", "Zoom out"]], c.kb, function (v) { edit(function () { cur().kb = v; }); }, "Motion")));
      g.appendChild(sliderRow("Size", 0.1, 3, 0.01, function () { return cur().scale; }, function (v) { cur().scale = v; }, function (v) { return Math.round(v * 100) + "%"; }));
      g.appendChild(h("div", { "class": "grid-2" }, [
        sliderRow("Left / right", -1, 1, 0.01, function () { return cur().x; }, function (v) { cur().x = v; }, function (v) { return Math.round(v * 100); }),
        sliderRow("Up / down", -1, 1, 0.01, function () { return cur().y; }, function (v) { cur().y = v; }, function (v) { return Math.round(v * 100); })
      ]));
      var i = tr.clips.indexOf(c);
      if (M.prevAbutting(tr, i)) g.appendChild(h("button", { "class": "btn small ghost", text: "Transition into this clip: " + (c.tr && c.tr.type !== "none" ? c.tr.type : "none"), onclick: function () { selCut = c.id; sel = null; renderTimeline(); renderInsp(); showTab("trans"); } }));
    }
    if (kind === "text") inspText(g, cur);
    g.appendChild(h("div", { "class": "row ve-iacts" }, [
      h("button", { "class": "btn small", html: '<svg class="i"><use href="#v-split"/></svg>Split', onclick: doSplit }),
      h("button", { "class": "btn small ghost", html: '<svg class="i"><use href="#v-dup"/></svg>Duplicate', onclick: doDup }),
      h("button", { "class": "btn small ghost", html: '<svg class="i"><use href="#v-del"/></svg>Delete', onclick: function () { doDelete(false); } })
    ]));
  }
  function inspText(g, cur) {
    var c = cur();
    var fs = h("select", { "class": "select", "aria-label": "Font" });
    [["system", "Sans (Inter)"], ["arabic", "Arabic sans"], ["serif", "Serif / Naskh"], ["rounded", "Rounded"], ["impact", "Impact"], ["hand", "Handwriting"], ["mono", "Mono"], ["custom", "A font on this device…"]]
      .forEach(function (o) { fs.appendChild(h("option", { value: o[0], text: o[1] })); });
    fs.value = c.font;
    var cf = h("input", { "class": "input", placeholder: "Font name, e.g. Tajawal", dir: "auto", maxlength: "80", "aria-label": "Device font name", list: "veFonts" }); cf.value = c.custom || ""; cf.hidden = c.font !== "custom";
    live(fs, function (v) { cur().font = v; cf.hidden = v !== "custom"; });
    live(cf, function (v) { cur().custom = v.replace(/[^\w \-؀-ۿ]/g, "").slice(0, 80); });
    g.appendChild(field("Font", fs)); g.appendChild(cf);
    g.appendChild(sliderRow("Size", 2, 30, 0.5, function () { return cur().size; }, function (v) { cur().size = v; }, function (v) { return (+v).toFixed(1); }));
    g.appendChild(field("Style", segEl([["plain", "Plain"], ["outline", "Outline"], ["box", "Box"], ["shadow", "Shadow"], ["glow", "Glow"]], c.style, function (v) { edit(function () { cur().style = v; }); }, "Text style")));
    var c1 = h("input", { type: "color", value: c.color, "aria-label": "Text colour" }), c2 = h("input", { type: "color", value: c.color2, "aria-label": "Outline or box colour" });
    live(c1, function (v) { cur().color = v; }); live(c2, function (v) { cur().color2 = v; });
    var bold = h("input", { type: "checkbox" }); bold.checked = !!c.bold; live(bold, function (v) { cur().bold = v; });
    g.appendChild(h("div", { "class": "row" }, [h("label", { "class": "field" }, ["Colour", c1]), h("label", { "class": "field" }, ["Outline / box", c2]), h("label", { "class": "check" }, [bold, " Bold"])]));
    g.appendChild(field("Align", segEl([["left", "Left"], ["center", "Centre"], ["right", "Right"]], c.align, function (v) { edit(function () { cur().align = v; }); }, "Align")));
    g.appendChild(h("div", { "class": "grid-2" }, [
      sliderRow("Across", 0, 1, 0.01, function () { return cur().x; }, function (v) { cur().x = v; }, function (v) { return Math.round(v * 100) + "%"; }),
      sliderRow("Down", 0, 1, 0.01, function () { return cur().y; }, function (v) { cur().y = v; }, function (v) { return Math.round(v * 100) + "%"; })
    ]));
    var an = h("select", { "class": "select", "aria-label": "Animation" });
    [["none", "None"], ["fade", "Fade"], ["pop", "Pop"], ["slide", "Slide up"], ["type", "Typewriter"]].forEach(function (o) { an.appendChild(h("option", { value: o[0], text: o[1] })); });
    an.value = c.anim; live(an, function (v) { cur().anim = v; });
    g.appendChild(field("Animation", an));
  }
  function inspCut(box) {
    var f = M.findClip(P, selCut), c = f.clip, a = M.prevAbutting(f.track, f.index);
    box.appendChild(h("div", { "class": "row between" }, [h("h2", { text: "Transition" }), h("button", { "class": "btn ghost icon small", "aria-label": "Close", html: S3.icon("x"), onclick: function () { selCut = null; renderTimeline(); renderInsp(); } })]));
    box.appendChild(h("p", { "class": "faint", text: a ? clipLabel(a, P.media[a.media]) + " → " + clipLabel(c, P.media[c.media]) : "" }));
    var g = h("div", { "class": "stack" }); box.appendChild(g);
    g.appendChild(segEl([["none", "None"], ["fade", "Crossfade"], ["black", "Dip to black"], ["white", "Flash"], ["slide", "Slide"]], c.tr.type, function (v) { edit(function () { M.findClip(P, selCut).clip.tr.type = v; }); renderTransList(); }, "Transition"));
    g.appendChild(sliderRow("Length", 0.2, 2, 0.1, function () { return M.findClip(P, selCut).clip.tr.dur; }, function (v) { M.findClip(P, selCut).clip.tr.dur = v; }, function (v) { return (+v).toFixed(1) + " s"; }));
    g.appendChild(h("button", { "class": "btn small ghost", text: "Preview it", onclick: function () { var k = M.findClip(P, selCut).clip; seek(Math.max(0, k.start - k.tr.dur / 2 - 0.6)); play(1); } }));
  }
  function inspProject(box) {
    box.appendChild(h("h2", { text: "Project" }));
    var g = h("div", { "class": "stack" }); box.appendChild(g);
    var dur = M.duration(P), d = M.dims(P.aspect, +prefs.res);
    g.appendChild(h("div", { "class": "stats" }, [stat("Length", M.fmtTime(dur, true)), stat("Clips", String(P.tracks.reduce(function (s, tr) { return s + tr.clips.length; }, 0))), stat("Export", d.w + "×" + d.h)]));
    g.appendChild(field("Background", segEl([["blur", "Blurred clip"], ["color", "Colour"]], P.bg, function (v) { edit(function (p) { p.bg = v; }); }, "Background")));
    if (P.bg === "color") { var bc = h("input", { type: "color", value: P.bgColor, "aria-label": "Background colour" }); live(bc, function (v) { P.bgColor = v; }); g.appendChild(bc); }
    var dk = h("input", { type: "checkbox" }); dk.checked = P.duck; live(dk, function (v) { P.duck = v; });
    g.appendChild(h("label", { "class": "check" }, [dk, " Lower the music while clips have sound (ducking)"]));
    g.appendChild(h("p", { "class": "faint", text: "Select a clip to trim, speed up, fade or resize it. Select a ◆ between clips for a transition." }));
  }
  function stat(l, v) { return h("div", { "class": "stat" }, [h("b", { text: v }), h("span", { text: l })]); }

  // ---------- side panels ----------
  function showTab(name) {
    prefs.tab = name; savePrefs();
    $$(".ve-tabs button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.tab === name)); });
    $$(".ve-panel").forEach(function (p) { p.hidden = p.dataset.panel !== name; });
  }
  $$(".ve-tabs button").forEach(function (b) { b.addEventListener("click", function () { showTab(b.dataset.tab); }); });

  var TEXT_PRESETS = [
    { name: "Title", t: "Your title", o: { size: 10, style: "outline", anim: "pop", y: 0.3 } },
    { name: "Box subtitle", t: "Say it in a box", o: { size: 6, style: "box", color: "#ffffff", color2: "#111111", anim: "slide", y: 0.62, bold: true } },
    { name: "Lower third", t: "Name Surname\nWhat they do", o: { size: 5, style: "box", align: "left", x: 0.42, y: 0.84, anim: "slide", color2: "#2563eb" } },
    { name: "Big & bold", t: "WAIT FOR IT", o: { size: 13, style: "outline", font: "impact", color: "#ffe14d", anim: "pop", y: 0.42 } },
    { name: "Neon", t: "Night mode", o: { size: 10, style: "glow", font: "rounded", color: "#ffffff", color2: "#22d3ee", anim: "fade", y: 0.36 } },
    { name: "Typewriter", t: "One more thing…", o: { size: 7, style: "shadow", font: "mono", anim: "type", y: 0.5, bold: false } },
    { name: "عنوان عربي", t: "عنوان جميل", o: { size: 10, style: "outline", font: "arabic", anim: "pop", y: 0.3 } },
    { name: "Quote", t: "“Less, but better.”", o: { size: 8, style: "shadow", font: "serif", anim: "fade", y: 0.45, bold: false } }
  ];
  function addText(pr) {
    edit(function (p) {
      var tr = p.tracks.filter(function (x) { return x.kind === "text"; })[0];
      if (!tr) { tr = { id: "t-text", kind: "text", name: "Text", clips: [] }; p.tracks.unshift(tr); }
      var c = Object.assign(M.newClip("text", null, t), pr.o, { text: pr.t });
      M.addClip(p, tr.id, c); sel = c.id;
    });
  }
  (function () {
    var box = $("#textPresets");
    TEXT_PRESETS.forEach(function (pr) {
      var cnv = h("canvas", { width: "200", height: "84", "aria-hidden": "true" }), g = cnv.getContext("2d");
      g.fillStyle = "#1a1f27"; g.fillRect(0, 0, 200, 84);
      var c = Object.assign(M.newClip("text", null, 0), pr.o, { text: pr.t.split("\n")[0], anim: "none", align: "center" }), o = R.textOpts(c, 200, 84);
      o.size = Math.min(28, o.size * 2.2);
      R.drawTextBlock(g, 200, 84, o, 100, 42, 190);
      box.appendChild(h("button", { "class": "ve-preset", "aria-label": "Add text: " + pr.name, onclick: function () { addText(pr); } }, [cnv, h("span", { text: pr.name })]));
    });
  })();

  // captions
  function capTrack() {
    var tr = P.tracks.filter(function (x) { return x.kind === "caption"; })[0];
    if (!tr) { tr = { id: "t-cap", kind: "caption", name: "Captions", clips: [] }; P.tracks.unshift(tr); }
    return tr;
  }
  var capFont = $("#capFont");
  [["system", "Sans (Inter)"], ["arabic", "Arabic sans"], ["serif", "Serif / Naskh"], ["rounded", "Rounded"], ["impact", "Impact"]].forEach(function (o) { capFont.appendChild(h("option", { value: o[0], text: o[1] })); });
  function syncCapControls() {
    var cs = P.captionStyle;
    $$("#capPreset button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === cs.preset)); });
    $("#capSize").value = cs.size; $("#capY").value = cs.y; capFont.value = cs.font; $("#capPop").checked = cs.pop;
  }
  $$("#capPreset button").forEach(function (b) { b.addEventListener("click", function () { edit(function (p) { p.captionStyle.preset = b.dataset.v; }); syncCapControls(); }); });
  live($("#capSize"), function (v) { P.captionStyle.size = +v; });
  live($("#capY"), function (v) { P.captionStyle.y = +v; });
  live(capFont, function (v) { P.captionStyle.font = v; });
  live($("#capPop"), function (v) { P.captionStyle.pop = v; });
  $("#capAdd").addEventListener("click", function () {
    edit(function (p) {
      var tr = capTrack(), next = tr.clips.filter(function (c) { return c.start > t + 0.05; })[0], d = Math.max(0.5, Math.min(2.5, next ? next.start - t : 2.5));
      var c = M.newClip("caption", null, t); c.out = d; c.text = "Type your caption"; M.addClip(p, tr.id, c); sel = c.id;
    });
    var first = $("#insp textarea"); if (first) { first.focus(); first.select(); }
  });
  function setCaptions(segs, replace) {
    edit(function (p) {
      var tr = capTrack();
      if (replace) tr.clips = [];
      segs.forEach(function (s) { var c = M.newClip("caption", null, s.start); c.out = Math.max(0.2, s.end - s.start); c.text = s.text; tr.clips.push(c); });
      M.sortTrack(tr);
    });
  }
  $("#capSpread").addEventListener("click", function () {
    var txt = $("#capScript").value.trim(), dur = M.duration(P);
    if (!txt) return S3.toast("Type or paste the words first");
    if (!dur) return S3.toast("Add a clip first, so the captions know how long to last");
    var tr = capTrack();
    if (tr.clips.length && !confirm("Replace the " + tr.clips.length + " captions you have?")) return;
    setCaptions(M.autoSegments(txt, 0, dur), true);
    S3.toast("Captions spread over " + M.fmtTime(dur) + ". Drag their edges on the timeline to fine-tune."); S3.done();
  });
  $("#srtFile").addEventListener("change", async function () {
    var f = this.files[0]; this.value = "";
    if (!f) return;
    if (f.size > 2e6) return S3.toast("That subtitle file is too large", "error");
    var segs = M.parseSrt(await S3.readFile(f, "text"));
    if (!segs.length) return S3.toast("No subtitles found in that file", "error");
    setCaptions(segs, !capTrack().clips.length || confirm("Replace the current captions? (Cancel adds them)"));
    S3.toast(segs.length + " captions imported");
  });
  $("#srtSave").addEventListener("click", function () {
    var tr = capTrack();
    if (!tr.clips.length) return S3.toast("No captions yet");
    S3.download(M.toSrt(tr.clips), slugName() + ".srt", "application/x-subrip"); S3.done();
  });
  function renderCapList(keep) {
    if (keep) return;
    var box = $("#capList"); box.textContent = "";
    var tr = P.tracks.filter(function (x) { return x.kind === "caption"; })[0];
    var clips = tr ? tr.clips : [];
    if (!clips.length) { box.appendChild(h("p", { "class": "faint", text: "No captions yet. Add one at the playhead, paste a script, or import an .srt." })); return; }
    clips.forEach(function (c) {
      var inp = h("input", { "class": "input", dir: "auto", value: c.text, "aria-label": "Caption at " + M.fmtTime(c.start, true) });
      live(inp, function (v) { var k = M.findClip(P, c.id); if (k) k.clip.text = v.slice(0, 2000); }, { caps: true });
      inp.addEventListener("focus", function () { seek(c.start + 0.01); });
      box.appendChild(h("div", { "class": "ve-cap" + (c.id === sel ? " sel" : "") }, [
        h("button", { "class": "btn ghost small mono", text: M.fmtTime(c.start, true), title: "Select and jump", onclick: function () { sel = c.id; seek(c.start + 0.01); renderTimeline(); renderInsp(); } }),
        inp,
        h("button", { "class": "btn ghost small icon", "aria-label": "Delete caption", html: S3.icon("x"), onclick: function () { edit(function (p) { M.remove(p, c.id, false); }); } })
      ]));
    });
  }

  // transitions panel
  var TR_INFO = [["fade", "Crossfade", "blend into the next clip"], ["black", "Dip to black", "fade out and in"], ["white", "Flash", "a quick white flash"], ["slide", "Slide", "push the next clip in"], ["none", "None", "a straight cut"]];
  function renderTransList() {
    var box = $("#transList"); box.textContent = "";
    var f = selCut && M.findClip(P, selCut), curT = f ? f.clip.tr.type : null;
    TR_INFO.forEach(function (o) {
      box.appendChild(h("button", { "class": "ve-tr" + (curT === o[0] ? " on" : ""), "aria-pressed": String(curT === o[0]), onclick: function () { applyTr(o[0]); } }, [h("b", { text: o[1] }), h("span", { "class": "faint", text: o[2] })]));
    });
  }
  function applyTr(type) {
    if (!selCut) { S3.toast("Select a ◆ marker between two clips first, or use Apply to every cut"); prefs.trType = type; savePrefs(); return; }
    var d = +$("#trDur").value;
    edit(function (p) { var k = M.findClip(p, selCut).clip; k.tr = { type: type, dur: d }; });
    prefs.trType = type; savePrefs(); renderTransList();
  }
  $("#trDur").addEventListener("input", function () { $("#trDurOut").textContent = (+this.value).toFixed(1) + " s"; });
  $("#trDurOut").textContent = "0.5 s";
  $("#trAll").addEventListener("click", function () {
    var type = prefs.trType && prefs.trType !== "none" ? prefs.trType : "fade", d = +$("#trDur").value, n = 0;
    edit(function (p) { p.tracks.forEach(function (tr) { if (tr.kind !== "video") return; tr.clips.forEach(function (c, i) { if (M.prevAbutting(tr, i)) { c.tr = { type: type, dur: d }; n++; } }); }); });
    S3.toast(n ? n + " cuts now use " + type : "No cuts yet: put two clips next to each other");
  });

  // ---------- top bar ----------
  function renderBar() {
    $("#undoBtn").disabled = !hist.undo.length; $("#redoBtn").disabled = !hist.redo.length;
    if (document.activeElement !== $("#projName")) $("#projName").value = P.name;
    $("#magBtn").setAttribute("aria-pressed", String(P.magnetic));
    $$("#aspect button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === P.aspect)); });
    var any = !!M.duration(P);
    ["#splitBtn", "#dupBtn", "#delBtn", "#rippleBtn"].forEach(function (s) { $(s).disabled = !any; });
    syncCapControls();
  }
  live($("#projName"), function (v) { P.name = v.slice(0, 120) || "My video"; });
  $$("#aspect button").forEach(function (b) { b.addEventListener("click", function () { edit(function (p) { p.aspect = b.dataset.v; }); }); });
  function slugName() { return (P.name || "video").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 60) || "video"; }
  $("#saveBtn").addEventListener("click", saveFile);
  function saveFile() { S3.download(M.toFile(P), slugName() + ".s3video", "application/json"); S3.toast("Project saved. Keep it next to your media files."); S3.done(); }
  $("#newBtn").addEventListener("click", function () {
    if (M.duration(P) && !confirm("Start a new project? Save this one first if you want to keep it (it isn't kept in this browser after this).")) return;
    newProject();
  });
  function newProject() {
    pause(); Object.keys(pool).forEach(dropEntry); Object.keys(MD.lib).forEach(MD.forget);
    P = M.newProject(); hist = new M.History(); sel = selCut = null; t = 0;
    MD.idb.clear().catch(function () {});
    renderBin(); changed();
  }
  $("#openFile").addEventListener("change", async function () {
    var f = this.files[0]; this.value = "";
    if (!f) return;
    try { await openProject(await S3.readFile(f, "text")); S3.toast("Opened " + P.name); }
    catch (e) { S3.toast("Couldn't open that project: " + (e && e.message || e), "error"); }
  });
  async function openProject(text, fromAutosave) {
    var np = M.fromFile(text), stored = [];
    try { stored = await MD.idb.allMedia(); } catch (e) { stored = []; }
    pause(); Object.keys(pool).forEach(dropEntry);
    var keep = {};
    for (var id in np.media) {
      var m = np.media[id];
      if (MD.lib[id] && P.media[id] && P.media[id].name === m.name) { keep[id] = 1; continue; }
      var rec = stored.filter(function (r) { return r.id === id; })[0] || stored.filter(function (r) { return r.meta && r.meta.name === m.name && r.meta.size === m.size; })[0];
      if (rec && rec.blob) {
        try { var mm = await MD.probe(new File([rec.blob], m.name, { type: m.type || rec.blob.type }), id); np.media[id] = Object.assign(mm, { id: id }); keep[id] = 1; if (rec.id !== id) storeMedia(np.media[id]); continue; }
        catch (e) { /* fall through to missing */ }
      }
      m.missing = true;
    }
    Object.keys(MD.lib).forEach(function (k) { if (!keep[k]) MD.forget(k); });
    P = np; hist = new M.History(); sel = selCut = null; t = 0;
    renderBin(); changed(); fitZoom();
    var missing = Object.keys(P.media).filter(function (k) { return P.media[k].missing; });
    if (missing.length && !fromAutosave) showRelink();
    else if (missing.length) S3.toast(missing.length + " media file(s) need to be found again. Click them in Media.", "error");
  }
  function showRelink() {
    var list = $("#rlList"); list.textContent = "";
    Object.keys(P.media).forEach(function (id) { var m = P.media[id]; if (m.missing) list.appendChild(h("li", {}, [h("b", { text: m.name }), h("span", { "class": "faint", text: " · " + m.kind + (m.dur ? " · " + M.fmtTime(m.dur) : "") })])); });
    if (!list.children.length) return;
    var d = $("#relinkDlg"); if (d.showModal && !d.open) d.showModal();
  }
  $("#rlLater").addEventListener("click", function () { $("#relinkDlg").close(); });
  $("#bin").addEventListener("click", function (e) { var it = e.target.closest(".ve-item.missing"); if (it && !e.target.closest("button")) showRelink(); });
  $("#rlFiles").addEventListener("change", async function () {
    var files = Array.prototype.slice.call(this.files); this.value = "";
    var n = await relink(files);
    S3.toast(n ? "Linked " + n + " file(s)" : "None of those files match the missing names", n ? undefined : "error");
    if (!Object.keys(P.media).some(function (k) { return P.media[k].missing; })) $("#relinkDlg").close(); else showRelink();
  });
  async function relink(files) {
    var n = 0;
    for (var id in P.media) {
      var m = P.media[id];
      if (!m.missing) continue;
      var f = files.filter(function (x) { return x.name.toLowerCase() === m.name.toLowerCase(); })[0] ||
        files.filter(function (x) { return MD.kindOf(x) === m.kind && x.size === m.size; })[0];
      if (!f) continue;
      try { var mm = await MD.probe(f, id); mm.id = id; P.media[id] = mm; storeMedia(mm); n++; } catch (e) { S3.toast(e.message, "error"); }
    }
    if (n) { renderBin(); changed(); }
    return n;
  }

  // ---------- export ----------
  var exp = { running: false, cancel: false, blob: null, url: null };
  ["#exRes", "#exFps", "#exQ"].forEach(function (s, i) {
    var key = ["res", "fps", "q"][i];
    $(s).value = prefs[key];
    $(s).addEventListener("change", function () { prefs[key] = this.value; savePrefs(); exInfo(); });
  });
  async function exInfo() {
    var d = M.dims(P.aspect, +prefs.res), info = $("#exInfo");
    info.textContent = "Checking what this browser can encode…";
    var s = await VE.exporter.support(d.w, d.h, +prefs.fps, prefs.q);
    exp.support = s;
    $("#exGo").disabled = !s.ok;
    if (!s.ok) { info.textContent = s.reason; info.className = "ve-warn"; return s; }
    info.className = "muted";
    info.textContent = d.w + "×" + d.h + " · " + prefs.fps + " fps · " + s.video.label + (s.audio ? " + " + s.audio.label : " (no audio encoder: silent video)") + " in MP4 · about " +
      S3.fmtBytes(VE.exporter.bitrate(d.w, d.h, +prefs.fps, prefs.q) / 8 * Math.max(1, M.duration(P)) + (s.audio ? 20000 * M.duration(P) : 0)) + " for " + M.fmtTime(M.duration(P)) + ".";
    if (s.video.mux !== "avc") info.textContent += " This browser has no H.264 encoder, so the file uses " + s.video.label + ": it plays in browsers, VLC and most new phones, but some older apps may refuse it.";
    return s;
  }
  function exShow(which) { ["exSetup", "exRun", "exDone"].forEach(function (id) { $("#" + id).hidden = id !== which; }); }
  $("#exportBtn").addEventListener("click", function () {
    if (!M.duration(P)) return S3.toast("Add some clips first");
    pause();
    if (!exp.running) exShow(exp.blob ? "exDone" : "exSetup");
    exInfo();
    var d = $("#exportDlg"); if (!d.open) d.showModal();
  });
  $("#exClose").addEventListener("click", function () { if (exp.running && !confirm("Stop the export?")) return; exp.cancel = true; $("#exportDlg").close(); });
  $("#exportDlg").addEventListener("cancel", function (e) { if (exp.running) { e.preventDefault(); } });
  $("#exCancel").addEventListener("click", function () { exp.cancel = true; $("#exLabel").textContent = "Stopping…"; });
  $("#exAgain").addEventListener("click", function () { exShow("exSetup"); });
  $("#exSave").addEventListener("click", function () { if (exp.blob) { S3.download(exp.blob, slugName() + ".mp4"); S3.done(); } });
  $("#exGo").addEventListener("click", async function () {
    if (exp.running) return;
    var s = exp.support && exp.support.ok ? exp.support : await exInfo();
    if (!s || !s.ok) return;
    exp.running = true; exp.cancel = false; exShow("exRun"); $("#exBar").style.width = "0%";
    try {
      var r = await VE.exporter.exportVideo(P, { res: +prefs.res, fps: +prefs.fps, quality: prefs.q, support: s,
        onProgress: function (f, label) { $("#exBar").style.width = (f * 100).toFixed(1) + "%"; $("#exLabel").textContent = label; },
        isCancelled: function () { return exp.cancel; } });
      if (exp.url) URL.revokeObjectURL(exp.url);
      exp.blob = r.blob; exp.url = URL.createObjectURL(r.blob);
      $("#exVideo").src = exp.url;
      $("#exStats").textContent = r.w + "×" + r.h + " · " + r.fps + " fps · " + M.fmtTime(r.dur, true) + " · " + r.video + (r.audio ? " + " + r.audio : "") + " · " + S3.fmtBytes(r.blob.size) + " · made in " + r.secs.toFixed(1) + " s";
      exShow("exDone"); S3.done();
    } catch (e) {
      exShow("exSetup");
      if (String(e && e.message) !== "cancelled") { $("#exInfo").textContent = "Export failed: " + (e && e.message || e) + ". Try 720p or another browser."; $("#exInfo").className = "ve-warn"; }
      else S3.toast("Export cancelled");
    }
    exp.running = false;
  });
  (async function codecChip() {
    var d = M.dims("9:16", 1080), s = await VE.exporter.support(d.w, d.h, 30, "std"), chip = $("#codecChip");
    chip.textContent = s.ok ? "Exports " + s.video.label + (s.audio ? " + " + s.audio.label : "") : "Export not available here";
    chip.className = "chip " + (s.ok ? "ok" : "warn");
    chip.title = s.ok ? "This browser encodes MP4 on your device" : s.reason;
  })();

  // ---------- keyboard ----------
  document.addEventListener("keydown", function (e) {
    var tag = e.target.tagName, typing = /INPUT|TEXTAREA|SELECT/.test(tag) && e.target.type !== "range" && e.target.type !== "checkbox";
    if ($("#exportDlg").open || $("#relinkDlg").open) return;
    var k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && (k === "s" || k === "S")) { e.preventDefault(); saveFile(); return; }
    if (typing) return;
    if (mod && (k === "z" || k === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (k === "y" || k === "Y")) { e.preventDefault(); redo(); return; }
    if (mod && (k === "d" || k === "D")) { e.preventDefault(); doDup(); return; }
    if (mod && (k === "b" || k === "B")) { e.preventDefault(); doSplit(); return; }
    if (mod || e.altKey) return;
    var fps = P.fps || 30;
    switch (k) {
      case " ": if (tag === "BUTTON") return; e.preventDefault(); if (playing) pause(); else play(1); break;
      case "k": case "K": pause(); break;
      case "l": case "L": play(playing && rate > 0 ? Math.min(4, rate * 2) : 1); break;
      case "j": case "J": play(playing && rate < 0 ? Math.max(-4, rate * 2) : -1); break;
      case "ArrowLeft": case "ArrowRight":
        if (e.target.type === "range") return;
        e.preventDefault(); pause(); seek(t + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / fps)); follow(); break;
      case "Home": e.preventDefault(); seek(0); follow(); break;
      case "End": e.preventDefault(); seek(M.duration(P)); follow(); break;
      case "s": case "S": doSplit(); break;
      case "Delete": case "Backspace": if (sel) { e.preventDefault(); doDelete(e.shiftKey); } break;
      case "+": case "=": setZoom(prefs.pps * 1.4); break;
      case "-": case "_": setZoom(prefs.pps / 1.4); break;
      case "Escape": sel = selCut = null; renderTimeline(); renderInsp(); break;
    }
  });
  window.addEventListener("resize", S3.debounce(function () { renderTimeline(); requestDraw(); }, 150));
  window.addEventListener("beforeunload", function () { clearTimeout(saveTimer); try { MD.idb.saveState(M.toFile(P)); } catch (e) { /* best effort */ } });

  // ---------- boot ----------
  showTab(prefs.tab || "media");
  renderTransList(); renderBin(); renderTimeline(); renderInsp(); renderCapList(); renderBar(); setPlayIcon(); draw();
  var restored = MD.idb.loadState().then(function (s) {
    if (!s || M.duration(P)) return false;
    return openProject(s, true).then(function () { if (M.duration(P)) S3.toast("Welcome back: your last project was restored"); return true; });
  }).catch(function () { return false; });
  if (document.fonts && document.fonts.load) document.fonts.load("800 40px Inter").then(requestDraw, function () {});

  // Resolve once every visible clip has a decoded frame (used by the demo before the screenshot).
  function settle(ms) {
    var t0 = performance.now();
    return new Promise(function (res) {
      (function check() {
        draw();
        var ok = Object.keys(pool).every(function (id) { var el = pool[id].el; return el.readyState >= 2 && !el.seeking; });
        if (ok || performance.now() - t0 > (ms || 3000)) { draw(); res(ok); } else setTimeout(check, 50);
      })();
    });
  }

  function flushSave() { clearTimeout(saveTimer); return MD.idb.saveState(M.toFile(P)).then(function () { $("#saveState").textContent = "Saved here"; }, function () {}); }

  VE.ui = {
    settle: settle, flushSave: flushSave,
    get project() { return P; }, set project(v) { P = v; },
    importFiles: importFiles, changed: changed, edit: edit, seek: seek, play: play, pause: pause, draw: draw, fitZoom: fitZoom,
    select: function (id) { sel = id; selCut = null; renderTimeline(); renderInsp(); }, showTab: showTab, newProject: newProject, openProject: openProject,
    restored: restored, history: function () { return hist; }, undo: undo, redo: redo, time: function () { return t; }, slugName: slugName, renderBin: renderBin
  };
})();
