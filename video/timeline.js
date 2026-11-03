// Hivemind launch film. Everything is drawn on one canvas, and renderFrame(t)
// depends on t alone, so frames render identically in any order.
//
// Idea: agents are the hexagon cells of the Hivemind mark. They work side by side,
// collide when they cannot see each other, then resolve into the mark itself:
// two cells that overlap and share a lavender core.
(function () {
  var W = 1920, H = 1080, DUR = 26, FPS = 60;
  var COL = { bg: "#14172f", a: "#E4E5EA", b: "#8E8EA0", core: "#A99BFF", bad: "#ffb3b3" };
  var cv = document.getElementById("c"), g = cv.getContext("2d");
  var R = 58, HW = Math.sqrt(3) * R;            // pointy-top cell: circumradius, width
  var LOGO_STROKE = 5 / 32;                      // the mark's stroke as a fraction of R

  // ---------- math ----------
  var E = {
    io3: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    io4: function (t) { return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2; },
    o3: function (t) { return 1 - Math.pow(1 - t, 3); },
    back: function (t) { var c1 = 1.15, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    lin: function (t) { return t; }
  };
  function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function p(t, a, b, e) { return (e || E.o3)(clamp((t - a) / (b - a))); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function mix(c1, c2, k) {
    var a = parseInt(c1.slice(1), 16), b = parseInt(c2.slice(1), 16);
    var r = Math.round(lerp(a >> 16, b >> 16, k)), gg = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, k)), bb = Math.round(lerp(a & 255, b & 255, k));
    return "rgb(" + r + "," + gg + "," + bb + ")";
  }
  function track(t, keys) {
    if (t <= keys[0][0]) return keys[0][1].slice();
    for (var i = 1; i < keys.length; i++) if (t <= keys[i][0]) {
      var a = keys[i - 1], b = keys[i], k = (b[2] || E.io3)(clamp((t - a[0]) / (b[0] - a[0])));
      return a[1].map(function (v, j) { return lerp(v, b[1][j], k); });
    }
    return keys[keys.length - 1][1].slice();
  }
  function axial(q, r) { return [HW * (q + r / 2), 1.5 * R * r]; }
  function key(q, r) { return q + "," + r; }
  var NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // ---------- choreography (precomputed, deterministic) ----------
  var rand = rng(11);
  var inField = function (q, r) { var w = axial(q, r); return Math.abs(w[0]) < 780 && w[1] > -320 && w[1] < 230; };
  var agents = [];
  while (agents.length < 12) {
    var q = Math.round(rand() * 20 - 10), r = Math.round(rand() * 8 - 4);
    if (!inField(q, r)) continue;
    var w = axial(q, r);
    if (agents.some(function (a) { var o = axial(a.q, a.r); return Math.hypot(o[0] - w[0], o[1] - w[1]) < HW * 2.3; })) continue;
    agents.push({ q: q, r: r, col: agents.length % 2 ? COL.b : COL.a, moves: [] });
  }
  agents.forEach(function (a) { a.home = axial(a.q, a.r); a.cell = [a.q, a.r]; });

  // independent work: each tick a few agents step to a free neighbouring cell
  var occ = {}; agents.forEach(function (a) { occ[key(a.q, a.r)] = 1; });
  for (var tick = 0; tick < 11; tick++) {
    var at = 0.9 + tick * 0.36;
    for (var n = 0; n < 4; n++) {
      var a = agents[Math.floor(rand() * agents.length)];
      if (a.busy && a.busy > at) continue;
      var nb = NB[Math.floor(rand() * 6)], nq = a.cell[0] + nb[0], nr = a.cell[1] + nb[1];
      if (!inField(nq, nr) || occ[key(nq, nr)]) continue;
      delete occ[key(a.cell[0], a.cell[1])]; occ[key(nq, nr)] = 1;
      a.moves.push({ t: at, d: 0.62, to: axial(nq, nr), e: E.back });
      a.cell = [nq, nr]; a.busy = at + 0.62;
    }
  }

  // collisions: three pairs of a light and a dark cell land on the same cell
  var light = agents.filter(function (a) { return a.col === COL.a; }), dark = agents.filter(function (a) { return a.col === COL.b; });
  var pairs = [], usedDark = [];
  light.slice(0, 3).forEach(function (A) {
    var best = null, bd = 1e9, pa = axial(A.cell[0], A.cell[1]);
    dark.forEach(function (B) {
      if (usedDark.indexOf(B) >= 0) return;
      var pb = axial(B.cell[0], B.cell[1]), d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      if (d < bd) { bd = d; best = B; }
    });
    usedDark.push(best); pairs.push([A, best]);
  });
  // the pair nearest the centre becomes the mark
  pairs.sort(function (x, y) { var a = axial(x[0].cell[0], x[0].cell[1]), b = axial(y[0].cell[0], y[0].cell[1]); return Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]); });
  pairs.forEach(function (pr, i) {
    var A = pr[0], B = pr[1], at = 5.55 + i * 0.32;
    B.moves.push({ t: at, d: 0.8, to: axial(A.cell[0], A.cell[1]), e: E.io3 });
    A.hit = B.hit = at + 0.8; B.offender = true;
  });

  // resolution: the first pair forms the mark at the origin, everyone else takes a seat on ring 2
  // everyone else takes an evenly spaced seat on a circle around it
  var ring = [];
  for (var s = 0; s < 10; s++) { var ang = (-90 + 18 + s * 36) * Math.PI / 180; ring.push([Math.cos(ang) * HW * 2.85, Math.sin(ang) * HW * 2.85]); }
  var markPair = pairs[0];
  markPair[0].final = [-HW / 4, 0]; markPair[1].final = [HW / 4, 0];
  agents.filter(function (a) { return !a.final; }).forEach(function (a) {
    var pos = a.moves.length ? a.moves[a.moves.length - 1].to : a.home, bi = 0, bd = 1e9;
    ring.forEach(function (s, i) { if (!s.taken) { var d = Math.hypot(s[0] - pos[0], s[1] - pos[1]); if (d < bd) { bd = d; bi = i; } } });
    ring[bi].taken = true; a.final = ring[bi]; a.ringed = true;
  });
  agents.forEach(function (a, i) { a.moves.push({ t: 9.0 + (a.ringed ? 0.08 + (i % 5) * 0.05 : 0), d: 1.05, to: a.final, e: E.io3 }); });

  function posOf(a, t) {
    var cur = a.home;
    for (var i = 0; i < a.moves.length; i++) {
      var m = a.moves[i];
      if (t < m.t) break;
      var k = m.e(clamp((t - m.t) / m.d));
      cur = [lerp(cur[0], m.to[0], k), lerp(cur[1], m.to[1], k)];
      if (t < m.t + m.d) return cur;
      cur = m.to;
    }
    return cur;
  }

  // ---------- drawing ----------
  var cam = { x: 0, y: 60, z: 1 };
  function sx(wx) { return (wx - cam.x) * cam.z + W / 2; }
  function sy(wy) { return (wy - cam.y) * cam.z + H / 2; }
  function hexPath(cx, cy, rad) {
    g.beginPath();
    for (var k = 0; k < 6; k++) {
      var ang = (-90 + 60 * k) * Math.PI / 180;
      var X = sx(cx + rad * Math.cos(ang)), Y = sy(cy + rad * Math.sin(ang));
      k ? g.lineTo(X, Y) : g.moveTo(X, Y);
    }
    g.closePath();
  }
  function hex(cx, cy, color, width, trim, alpha) {
    hexPath(cx, cy, R);
    g.globalAlpha = alpha == null ? 1 : alpha;
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = "round";
    if (trim < 1) { var per = 6 * R * cam.z; g.setLineDash([per * trim, per]); } else g.setLineDash([]);
    g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
  }
  function core(cx, cy, k) {
    if (k <= 0) return;
    var pts = [[0, -0.75], [0.428, -0.5], [0.428, 0.5], [0, 0.75], [-0.428, 0.5], [-0.428, -0.5]];
    g.beginPath();
    pts.forEach(function (pt, i) { var X = sx(cx + pt[0] * R * k), Y = sy(cy + pt[1] * R * k); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
    g.closePath(); g.fillStyle = COL.core; g.fill();
  }
  function lattice(alpha) {
    if (alpha <= 0) return;
    g.strokeStyle = "rgba(255,255,255," + alpha + ")"; g.lineWidth = 1;
    for (var r = -9; r <= 9; r++) for (var q = -16; q <= 16; q++) {
      var w = axial(q, r);
      if (Math.abs(sx(w[0]) - W / 2) > W / 2 + 80 || Math.abs(sy(w[1]) - H / 2) > H / 2 + 80) continue;
      hexPath(w[0], w[1], R); g.stroke();
    }
  }
  function text(str, x, y, size, color, alpha, weight, align) {
    if (alpha <= 0) return;
    g.globalAlpha = alpha; g.fillStyle = color; g.textAlign = align || "left"; g.textBaseline = "alphabetic";
    g.font = (weight || 500) + " " + size + "px Inter";
    g.letterSpacing = (-0.022 * size).toFixed(2) + "px";
    g.fillText(str, x, y); g.globalAlpha = 1;
  }
  function inOut(t, a, b, fin, fout) { return p(t, a, a + (fin || 0.5), E.io3) * (1 - p(t, b, b + (fout || 0.4), E.io3)); }

  var dash = new Image(); dash.src = "../site/dashboard.png";
  var wordW = 0, ZL = 1.85, lock = { x: 0, y: 0 };
  // camera target that centres the lockup (mark, gap, wordmark) on screen
  function solveLock() {
    var mw = 1.5 * HW * ZL, total = mw + 52 + wordW, left = W / 2 - total / 2;
    lock.x = (W / 2 - (left + mw / 2)) / ZL; lock.y = (H / 2 - 470) / ZL;
  }

  // ---------- scenes ----------
  function field(t) {
    // camera: still, then a slow push into the pair that becomes the mark
    var c = track(t, [[0, [0, 60, 1]], [9.0, [0, 40, 1.02], E.lin], [11.0, [0, 30, 1.06], E.lin], [12.4, [lock.x, lock.y, ZL], E.io4], [14, [lock.x, lock.y, ZL * 1.012], E.lin]]);
    cam.x = c[0]; cam.y = c[1]; cam.z = c[2];
    var zk = clamp((cam.z - 1.06) / (ZL - 1.06));
    var fadeOthers = 1 - p(t, 11.0, 11.7, E.io3);
    lattice(0.045 * p(t, 0, 1.2, E.io3) * fadeOthers);

    var stroke = lerp(3, LOGO_STROKE * R * cam.z, zk);
    // connections: every agent to the shared core
    var coreK = p(t, 10.0, 10.55, E.back);
    agents.forEach(function (a, i) {
      if (!a.ringed) return;
      var k = p(t, 10.25 + i * 0.03, 10.85 + i * 0.03, E.io3);
      if (k <= 0) return;
      var P = posOf(a, t), d = Math.hypot(P[0], P[1]), ux = -P[0] / d, uy = -P[1] / d;
      var x0 = P[0] + ux * R * 0.95, y0 = P[1] + uy * R * 0.95;  // leave from the agent's edge
      var endX = -ux * R * 0.62, endY = -uy * R * 0.62;            // stop at the core's edge
      var tx = lerp(x0, endX, k), ty = lerp(y0, endY, k);
      g.globalAlpha = 0.75 * fadeOthers; g.strokeStyle = COL.core; g.lineWidth = 2;
      g.beginPath(); g.moveTo(sx(x0), sy(y0)); g.lineTo(sx(tx), sy(ty)); g.stroke(); g.globalAlpha = 1;
    });

    var mp = posOf(markPair[0], t), mq = posOf(markPair[1], t);
    core((mp[0] + mq[0]) / 2, (mp[1] + mq[1]) / 2, coreK);

    agents.forEach(function (a, i) {
      var P = posOf(a, t);
      var draw = p(t, 0.15 + i * 0.07, 0.85 + i * 0.07, E.io3);
      var color = a.col, alpha = a.ringed ? fadeOthers : 1;
      if (a.hit && t >= a.hit) {
        var k = p(t, a.hit, a.hit + 0.12) * (1 - p(t, 9.0, 9.4, E.io3));
        color = mix(a.col, COL.bad, k);
        if (a.offender && t < 9.4) {
          var dt = t - a.hit, j = Math.exp(-dt * 6) * Math.sin(dt * 2 * Math.PI * 7);
          var settle = 1 - p(t, 9.0, 9.4, E.io3);
          P = [P[0] + (6 + 9 * j) * settle, P[1] + (4 - 5 * j) * settle];
        }
      }
      if (alpha <= 0) return;
      hex(P[0], P[1], color, stroke, draw, alpha);
    });

    // lines of copy
    text("Your AI agents work side by side.", 120, 965, 54, "#fff", inOut(t, 1.3, 4.9));
    text("None of them knows what the others are doing.", 120, 965, 54, "#fff", inOut(t, 6.2, 8.75));

    // lockup: wordmark wipes on beside the mark
    var markRight = sx(HW * 0.75) + 52 * (cam.z / ZL);
    if (t >= 12.2) {
      var kw = p(t, 12.2, 12.85, E.o3);
      g.save(); g.beginPath(); g.rect(markRight - 10, 0, (wordW + 40) * kw, H); g.clip();
      text("Hivemind", markRight + (1 - kw) * -24, sy(0) + 54, 156, "#fff", 1, 500);
      g.restore();
    }
    text("Hivemind connects them to one live board.", W / 2, 760, 40, "rgba(255,255,255,.72)", p(t, 12.9, 13.4, E.io3), 400, "center");
  }

  function dashboard(t) {
    var c = track(t, [
      [14.0, [1240, 800, 0.82, 120, 1680]],
      [16.5, [1270, 790, 0.86, 120, 1680], E.lin],
      [17.4, [2080, 1420, 1.0, 120, 1680], E.io3],
      [19.3, [2060, 1400, 1.03, 120, 1680], E.lin],
      [20.5, [1440, 900, 0.4334, 336, 1248], E.io4],
      [22.0, [1440, 900, 0.44, 336, 1248], E.lin]
    ]);
    var wx = c[3], ww = c[4], wy = 96, wh = 780, s = c[2];
    g.save();
    g.beginPath(); g.roundRect(wx, wy, ww, wh, 14); g.clip();
    g.fillStyle = "#101010"; g.fillRect(wx, wy, ww, wh);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(dash, wx + ww / 2 - c[0] * s, wy + wh / 2 - c[1] * s, 2880 * s, 1800 * s);
    g.restore();
    g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = 1.5;
    g.beginPath(); g.roundRect(wx + 0.75, wy + 0.75, ww - 1.5, wh - 1.5, 14); g.stroke();

    text("Before an agent edits a file, Hivemind checks who already has it.", 120, 975, 44, "#fff", inOut(t, 14.25, 16.75, 0.45, 0.35));
    text("Agents can message each other while they work.", 120, 975, 44, "#fff", inOut(t, 17.3, 19.25, 0.45, 0.35));
    text("A live dashboard shows every agent and what it is working on.", 120, 975, 44, "#fff", inOut(t, 20.3, 30, 0.45));
  }

  function endCard(t) {
    cam.x = 0; cam.y = 0; cam.z = 1.62;
    var cx = W / 2, word = 132, gap = 46;
    g.font = "500 " + word + "px Inter"; g.letterSpacing = (-0.022 * word).toFixed(2) + "px";
    var ww = g.measureText("Hivemind").width, mw = 1.5 * HW * cam.z;
    var left = cx - (mw + gap + ww) / 2;
    cam.x = -((left + mw / 2) - W / 2) / cam.z; cam.y = -(470 - H / 2) / cam.z;
    var k = p(t, 22.15, 22.65, E.io3);
    g.globalAlpha = k;
    core(0, 0, 1);
    hex(-HW / 4, 0, COL.a, LOGO_STROKE * R * cam.z, 1, k);
    hex(HW / 4, 0, COL.b, LOGO_STROKE * R * cam.z, 1, k);
    g.globalAlpha = 1;
    text("Hivemind", left + mw + gap, 470 + word * 0.36, word, "#fff", p(t, 22.3, 22.8, E.io3));
    text("Real-time coordination for your AI agents, across every device and account.", cx, 680, 38, "rgba(255,255,255,.72)", p(t, 22.6, 23.1, E.io3), 400, "center");
    text("usefrontierdigital.com/hivemind", cx, 780, 34, COL.core, p(t, 22.9, 23.4, E.io3), 500, "center");
  }

  function renderFrame(t) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = COL.bg; g.fillRect(0, 0, W, H);
    if (t < 14.0) field(t);
    else if (t < 22.0) dashboard(t);
    else endCard(t);
  }

  var ready = Promise.all([
    document.fonts.load("500 54px Inter"), document.fonts.load("400 40px Inter"),
    new Promise(function (res) { if (dash.complete) res(); else dash.onload = res; })
  ]).then(function () {
    g.font = "500 156px Inter"; g.letterSpacing = (-0.022 * 156).toFixed(2) + "px";
    wordW = g.measureText("Hivemind").width;
    solveLock();
    renderFrame(0);
  });

  window.FILM = { DUR: DUR, FPS: FPS, renderFrame: renderFrame, ready: ready };
  if (/[?&]play/.test(location.search)) ready.then(function () {
    var start = performance.now();
    (function loop(now) { renderFrame(((now - start) / 1000) % DUR); requestAnimationFrame(loop); })(start);
  });
})();
