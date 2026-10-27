/* Video Editor audio: offline mix for export (OfflineAudioContext), pitch-preserving time-stretch for speed changes,
   and a tiny WAV writer. Gains come from VE.model.clipGain, the same envelope the preview uses. */
(function () {
  "use strict";
  var VE = window.VE = window.VE || {}, M = VE.model;
  var SR = 48000, AUTOMATION_HZ = 60;

  // WSOLA time-stretch: output is input.length / speed samples, pitch unchanged.
  function stretch(x, speed, sr) {
    if (Math.abs(speed - 1) < 1e-3) return x;
    var win = Math.round(sr * 0.04) & ~1, hs = win >> 1, ha = hs * speed, tolr = Math.round(sr * 0.008), ov = hs;
    var outLen = Math.max(1, Math.floor(x.length / speed)), y = new Float32Array(outLen + win), w = new Float32Array(win);
    for (var i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win); // periodic Hann: 50% overlap sums to 1
    var prev = 0, step = x.length > sr * 90 ? 8 : 3;
    for (var k = 0, op = 0; op < outLen; k++, op += hs) {
      var nominal = Math.round(k * ha), best = nominal;
      if (k > 0 && prev + hs + ov < x.length) {
        var nat = prev + hs, bc = -Infinity;
        for (var d = -tolr; d <= tolr; d += 2) {
          var c = nominal + d; if (c < 0 || c + ov >= x.length) continue;
          var s = 0; for (var j = 0; j < ov; j += step) s += x[nat + j] * x[c + j];
          if (s > bc) { bc = s; best = c; }
        }
      }
      if (best + win > x.length) best = Math.max(0, x.length - win);
      for (var q = 0; q < win && op + q < y.length; q++) y[op + q] += (x[best + q] || 0) * w[q];
      prev = best;
    }
    return y.subarray(0, outLen);
  }

  // Cut [in, out] of a buffer, as stereo Float32Arrays, time-stretched by speed.
  function segment(buf, inS, outS, speed) {
    var a = Math.max(0, Math.floor(inS * buf.sampleRate)), b = Math.min(buf.length, Math.ceil(outS * buf.sampleRate));
    if (b <= a) return null;
    var chs = [];
    for (var c = 0; c < 2; c++) {
      var src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).subarray(a, b);
      chs.push(stretch(src, speed, buf.sampleRate));
    }
    return chs;
  }

  // Mix the whole project. getBuffer(media) -> Promise<AudioBuffer|null>. Returns an AudioBuffer (stereo, SR).
  async function mix(p, dur, getBuffer, sampleRate) {
    sampleRate = sampleRate || SR;
    var len = Math.max(1, Math.ceil(dur * sampleRate)), ctx = new OfflineAudioContext(2, len, sampleRate), iv = M.duckIntervals(p), any = false;
    for (var ti = 0; ti < p.tracks.length; ti++) {
      var tr = p.tracks[ti];
      if ((tr.kind !== "video" && tr.kind !== "audio") || tr.muted) continue;
      for (var ci = 0; ci < tr.clips.length; ci++) {
        var c = tr.clips[ci], m = p.media[c.media];
        if (!m || m.kind === "image" || c.muted || !(c.volume > 0) || c.start >= dur) continue;
        var buf = await getBuffer(m);
        if (!buf) continue;
        var seg = segment(buf, c.in, c.out, c.speed || 1);
        if (!seg) continue;
        var ab = ctx.createBuffer(2, seg[0].length, buf.sampleRate);
        ab.copyToChannel(seg[0], 0); ab.copyToChannel(seg[1], 1);
        var src = ctx.createBufferSource(), g = ctx.createGain();
        src.buffer = ab; src.connect(g); g.connect(ctx.destination);
        var end = Math.min(dur, M.clipEnd(c)), t0 = c.start;
        g.gain.setValueAtTime(M.clipGain(p, tr, c, t0, iv), t0);
        for (var t = t0 + 1 / AUTOMATION_HZ; t < end; t += 1 / AUTOMATION_HZ) g.gain.linearRampToValueAtTime(M.clipGain(p, tr, c, t, iv), t);
        g.gain.linearRampToValueAtTime(M.clipGain(p, tr, c, end - 1e-4, iv), end);
        src.start(t0, 0, Math.max(0, end - t0));
        any = true;
      }
    }
    var out = await ctx.startRendering();
    out.silent = !any;
    return out;
  }

  function rms(buf, t0, t1, ch) {
    var d = buf.getChannelData(ch || 0), a = Math.floor(t0 * buf.sampleRate), b = Math.min(d.length, Math.floor(t1 * buf.sampleRate)), s = 0;
    for (var i = a; i < b; i++) s += d[i] * d[i];
    return b > a ? Math.sqrt(s / (b - a)) : 0;
  }

  // 16-bit PCM WAV from channel arrays.
  function wav(chs, sr) {
    var n = chs[0].length, nc = chs.length, buf = new ArrayBuffer(44 + n * nc * 2), v = new DataView(buf);
    function w(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    w(0, "RIFF"); v.setUint32(4, 36 + n * nc * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, nc, true); v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n * nc * 2, true);
    for (var i = 0, o = 44; i < n; i++) for (var c = 0; c < nc; c++, o += 2) { var x = Math.max(-1, Math.min(1, chs[c][i])); v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); }
    return new Blob([buf], { type: "audio/wav" });
  }

  VE.audio = { mix: mix, stretch: stretch, segment: segment, rms: rms, wav: wav, SR: SR };
})();
