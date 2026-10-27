/* Video Editor compositor: draws the project at any time t onto a 2D canvas.
   The same code paints the preview and every exported frame. A "provider" hands it the pixels for a clip:
   provider(clip, media, srcTime) -> CanvasImageSource | null (null = not ready, draw a placeholder). */
(function () {
  "use strict";
  var VE = window.VE = window.VE || {}, M = VE.model;

  var FONT_STACKS = {
    system: 'Inter, "Segoe UI", Tahoma, "Noto Sans Arabic", "Geeza Pro", system-ui, sans-serif',
    arabic: '"Noto Kufi Arabic", "Noto Sans Arabic", "Segoe UI", Tahoma, "Geeza Pro", "Arabic Typesetting", sans-serif',
    serif: 'Georgia, "Times New Roman", "Noto Naskh Arabic", "Traditional Arabic", serif',
    rounded: '"Arial Rounded MT Bold", Nunito, "Segoe UI", "Noto Sans Arabic", system-ui, sans-serif',
    impact: 'Impact, "Arial Black", "Segoe UI Black", "Noto Sans Arabic", sans-serif',
    hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Noto Sans Arabic", cursive',
    mono: 'ui-monospace, Consolas, "Courier New", "Noto Sans Arabic", monospace'
  };
  function fontStack(c) {
    if (c.font === "custom" && c.custom) return '"' + String(c.custom).replace(/["\\]/g, "") + '", ' + FONT_STACKS.system;
    return FONT_STACKS[c.font] || FONT_STACKS.system;
  }
  var RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/, LTR = /[A-Za-z\u00c0-\u024f]/;
  function textDir(s) { s = String(s || ""); for (var i = 0; i < s.length; i++) { var ch = s.charAt(i); if (RTL.test(ch)) return "rtl"; if (LTR.test(ch)) return "ltr"; } return "ltr"; }

  // Fit rectangle of a source (sw x sh) into the frame, "fit" (contain) or "fill" (cover).
  function fitRect(sw, sh, W, H, mode) {
    var k = mode === "fill" ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh), w = sw * k, h = sh * k;
    return { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h };
  }
  function srcSize(src, m) {
    if (!src) return { w: (m && m.w) || 16, h: (m && m.h) || 9 };
    return { w: src.displayWidth || src.videoWidth || src.naturalWidth || src.width || 16, h: src.displayHeight || src.videoHeight || src.naturalHeight || src.height || 9 };
  }

  var tiny = null;
  function blurFill(ctx, src, sz, W, H, alpha) {
    if (!tiny) { tiny = document.createElement("canvas"); }
    var tw = 36, th = Math.max(2, Math.round(36 * H / W));
    tiny.width = tw; tiny.height = th;
    var g = tiny.getContext("2d"), r = fitRect(sz.w, sz.h, tw, th, "fill");
    g.drawImage(src, r.x, r.y, r.w, r.h);
    ctx.save(); ctx.globalAlpha = alpha; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tiny, -W * 0.04, -H * 0.04, W * 1.08, H * 1.08);
    ctx.fillStyle = "rgba(0,0,0,.28)"; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function placeholder(ctx, r, label) {
    ctx.save();
    ctx.fillStyle = "#1d2129"; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.lineWidth = Math.max(2, r.w / 60);
    ctx.beginPath();
    for (var i = -r.h; i < r.w; i += r.w / 8) { ctx.moveTo(r.x + i, r.y + r.h); ctx.lineTo(r.x + i + r.h, r.y); }
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip(); ctx.stroke(); ctx.restore();
    if (label) {
      ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.font = "600 " + Math.max(10, Math.round(r.w / 22)) + "px " + FONT_STACKS.system;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2, r.w * 0.9);
    }
    ctx.restore();
  }

  // Ken Burns: slow zoom (and a little drift) over the clip's life.
  function kenBurns(c, t) {
    if (!c.kb || c.kb === "none") return { k: 1, dx: 0, dy: 0 };
    var d = M.clipDur(c), p = d > 0 ? Math.max(0, Math.min(1, (t - c.start) / d)) : 0;
    if (c.kb === "out") p = 1 - p;
    return { k: 1 + 0.16 * p, dx: 0.025 * p, dy: -0.015 * p };
  }

  function drawLayer(ctx, W, H, p, layer, src, isBase, t) {
    var c = layer.clip, m = p.media[c.media], sz = srcSize(src, m);
    var a = layer.alpha * M.fadeAlpha(c, t);
    if (a <= 0.001) return;
    var r = fitRect(sz.w, sz.h, W, H, c.fit), kb = m && m.kind === "image" ? kenBurns(c, t) : { k: 1, dx: 0, dy: 0 };
    var k = (c.scale || 1) * kb.k, w = r.w * k, h = r.h * k;
    var x = (W - w) / 2 + ((c.x || 0) + kb.dx) * W + (layer.dx || 0) * W, y = (H - h) / 2 + ((c.y || 0) + kb.dy) * H;
    ctx.save();
    if (isBase && p.bg === "blur" && src && (w < W - 1 || h < H - 1 || x > 0.5 || y > 0.5)) {
      ctx.save(); ctx.translate((layer.dx || 0) * W, 0); blurFill(ctx, src, sz, W, H, a); ctx.restore();
    }
    ctx.globalAlpha = a;
    if (src) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(src, x, y, w, h); }
    else placeholder(ctx, { x: x, y: y, w: w, h: h }, m ? (layer.missing ? "Missing: " : "") + m.name : "Missing media");
    ctx.restore();
    if (layer.cover) { ctx.save(); ctx.globalAlpha = layer.cover.alpha; ctx.fillStyle = layer.cover.color; ctx.fillRect(0, 0, W, H); ctx.restore(); }
  }

  // ---------- text ----------
  function wrap(ctx, text, maxW) {
    var out = [];
    String(text).split("\n").forEach(function (para) {
      var words = para.split(/(\s+)/), line = "";
      words.forEach(function (w) {
        var test = line + w;
        if (line && ctx.measureText(test.trim()).width > maxW && w.trim()) { out.push(line.trim()); line = w.trimStart(); }
        else line = test;
      });
      out.push(line.trim());
    });
    return out;
  }
  // Draw a text block centred on (cx, cy). o: {text, size(px), font, bold, color, color2, style, align}
  function drawTextBlock(ctx, W, H, o, cx, cy, maxW, anim) {
    anim = anim || { alpha: 1, scale: 1, dy: 0, chars: 1 };
    if (anim.alpha <= 0.001) return null;
    var text = String(o.text || "");
    if (anim.chars < 1) { var ch = Array.from(text); text = ch.slice(0, Math.round(ch.length * anim.chars)).join(""); }
    var dir = textDir(o.text), size = o.size;
    ctx.save();
    ctx.font = (o.bold ? "800 " : "500 ") + size + "px " + o.stack;
    ctx.direction = dir; ctx.textBaseline = "middle";
    var full = wrap(ctx, o.text, maxW), lines = anim.chars < 1 ? wrap(ctx, text, maxW) : full;
    var lh = size * 1.22, bh = full.length * lh, widths = full.map(function (l) { return ctx.measureText(l).width; });
    var bw = Math.max.apply(null, widths.concat([1]));
    cy += anim.dy * H;
    ctx.translate(cx, cy); ctx.scale(anim.scale, anim.scale); ctx.globalAlpha = anim.alpha;
    var align = o.align || "center", ax = align === "left" ? -bw / 2 : align === "right" ? bw / 2 : 0;
    ctx.textAlign = align; // "left"/"right" are physical in canvas, so RTL text aligns the same way
    var top = -bh / 2 + lh / 2;
    if (o.style === "box") {
      ctx.fillStyle = o.color2 || "#000"; ctx.globalAlpha = anim.alpha * (o.boxAlpha == null ? 0.82 : o.boxAlpha);
      full.forEach(function (l, i) {
        if (!l) return;
        var w = widths[i], px = size * 0.32, x0 = align === "center" ? -w / 2 : align === "left" ? -bw / 2 : bw / 2 - w;
        roundRect(ctx, x0 - px, top + i * lh - lh / 2 + size * 0.04, w + 2 * px, lh, size * 0.22); ctx.fill();
      });
      ctx.globalAlpha = anim.alpha;
    }
    lines.forEach(function (l, i) {
      var y = top + i * lh, x = ax;
      if (o.style === "outline") {
        ctx.lineJoin = "round"; ctx.miterLimit = 2; ctx.lineWidth = Math.max(2, size * 0.17); ctx.strokeStyle = o.color2 || "#000";
        ctx.strokeText(l, x, y);
      } else if (o.style === "shadow") {
        ctx.shadowColor = "rgba(0,0,0,.75)"; ctx.shadowBlur = size * 0.28; ctx.shadowOffsetY = size * 0.06;
      } else if (o.style === "glow") {
        ctx.shadowColor = o.color2 && o.color2 !== "#000000" ? o.color2 : o.color; ctx.shadowBlur = size * 0.55;
        ctx.fillStyle = o.color; ctx.fillText(l, x, y);
      }
      ctx.fillStyle = o.color || "#fff"; ctx.fillText(l, x, y);
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    });
    ctx.restore();
    return { w: bw, h: bh };
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function textOpts(c, W, H) {
    var u = Math.min(W, H);
    return { text: c.text, size: Math.max(6, c.size / 100 * u), stack: fontStack(c), bold: c.bold, color: c.color, color2: c.color2, style: c.style, align: c.align };
  }
  var CAP = {
    bold: { color: "#ffffff", color2: "#000000", style: "outline", bold: true },
    box: { color: "#ffffff", color2: "#101010", style: "box", bold: true },
    yellow: { color: "#ffe14d", color2: "#000000", style: "outline", bold: true },
    minimal: { color: "#ffffff", color2: "#000000", style: "shadow", bold: false }
  };
  function captionOpts(cs, c, W, H) {
    var pr = CAP[cs.preset] || CAP.bold, u = Math.min(W, H);
    return { text: c.text, size: Math.max(6, cs.size / 100 * u), stack: FONT_STACKS[cs.font] || FONT_STACKS.system, bold: pr.bold,
      color: pr.color, color2: pr.color2, style: pr.style, align: "center" };
  }
  function captionAnim(cs, c, t) {
    if (!cs.pop) return { alpha: 1, scale: 1, dy: 0, chars: 1 };
    var p = Math.max(0, Math.min(1, (t - c.start) / 0.14));
    return { alpha: Math.min(1, p * 2), scale: 0.86 + 0.14 * (1 - Math.pow(1 - p, 2)), dy: 0, chars: 1 };
  }

  // ---------- the frame ----------
  // Returns what was drawn (for tests): {layers:[{id, alpha, dx}], texts:[id]}
  function paint(ctx, W, H, p, t, provider) {
    var info = { layers: [], texts: [] };
    ctx.save();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = p.bg === "color" ? p.bgColor : "#000000"; ctx.fillRect(0, 0, W, H);
    var vids = p.tracks.filter(function (tr) { return tr.kind === "video" && !tr.hidden; }).reverse(), first = true;
    vids.forEach(function (tr) {
      var layers = M.videoLayers(tr, t);
      layers.forEach(function (L) {
        var m = p.media[L.clip.media], src = m ? provider(L.clip, m, L.src) : null;
        if (m && m.missing) L.missing = true;
        drawLayer(ctx, W, H, p, L, src, first && tr.main, t);
        info.layers.push({ id: L.clip.id, alpha: L.alpha, dx: L.dx || 0, cover: L.cover ? L.cover.alpha : 0, src: L.src });
      });
      if (layers.length) first = false;
    });
    p.tracks.forEach(function (tr) {
      if (tr.kind !== "text" || tr.hidden) return;
      tr.clips.forEach(function (c) {
        if (!M.activeAt(c, t)) return;
        var o = textOpts(c, W, H);
        drawTextBlock(ctx, W, H, o, c.x * W, c.y * H, W * 0.88, M.textAnim(c, t));
        info.texts.push(c.id);
      });
    });
    p.tracks.forEach(function (tr) {
      if (tr.kind !== "caption" || tr.hidden) return;
      tr.clips.forEach(function (c) {
        if (!M.activeAt(c, t) || !c.text) return;
        drawTextBlock(ctx, W, H, captionOpts(p.captionStyle, c, W, H), W / 2, p.captionStyle.y * H, W * 0.84, captionAnim(p.captionStyle, c, t));
        info.texts.push(c.id);
      });
    });
    ctx.restore();
    return info;
  }

  VE.render = { paint: paint, fitRect: fitRect, fontStack: fontStack, FONT_STACKS: FONT_STACKS, textDir: textDir, drawTextBlock: drawTextBlock,
    textOpts: textOpts, captionOpts: captionOpts, kenBurns: kenBurns, CAP: CAP };
})();
