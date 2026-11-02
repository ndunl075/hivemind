// Deterministic timeline: renderFrame(t) sets every property from time t alone,
// so any frame renders the same in any order. Cuts sit on a 120 BPM grid (0.5 s beats).
(function () {
  var DUR = 28, FPS = 60;

  function bez(x1, y1, x2, y2) {
    function A(a, b) { return 1 - 3 * b + 3 * a; }
    function B(a, b) { return 3 * b - 6 * a; }
    function C(a) { return 3 * a; }
    function at(t, a, b) { return ((A(a, b) * t + B(a, b)) * t + C(a)) * t; }
    return function (x) {
      if (x <= 0) return 0; if (x >= 1) return 1;
      var lo = 0, hi = 1, t = x;
      for (var i = 0; i < 40; i++) { var v = at(t, x1, x2); if (Math.abs(v - x) < 1e-7) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
      return at(t, y1, y2);
    };
  }
  var E = {
    out: bez(0.16, 1, 0.3, 1),   // fast arrival, long settle
    io: bez(0.83, 0, 0.17, 1),   // whip moves
    inn: bez(0.7, 0, 0.84, 0),   // exits
    lin: function (x) { return x; }
  };
  function clamp(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function p(t, a, b, e) { return (e || E.out)(clamp((t - a) / (b - a))); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function $(s) { return document.querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  // keyframe track: [[t, v], [t, v, ease], ...]; ease applies to the segment ending at that key
  function track(t, keys) {
    if (t <= keys[0][0]) return keys[0][1];
    for (var i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        var a = keys[i - 1], b = keys[i], k = (keys[i][2] || E.io)(clamp((t - a[0]) / (b[0] - a[0])));
        return Array.isArray(a[1]) ? a[1].map(function (v, j) { return lerp(v, b[1][j], k); }) : lerp(a[1], b[1], k);
      }
    }
    return keys[keys.length - 1][1];
  }
  function show(el, on) { el.style.visibility = on ? "visible" : "hidden"; }
  // scenes and blocks toggle display, so nothing inside them can leak past their window
  function on(el, v) { el.style.display = v ? "" : "none"; }
  function win(id, t, a, b) { var v = t >= a && t < b; on($(id), v); if (v) $(id).style.visibility = "visible"; return v; }
  // masked line: slides up into its mask, and out of the top on exit
  function mask(el, t, tin, tout, dur) {
    var ki = p(t, tin, tin + (dur || 0.45), E.out);
    var ko = tout == null ? 0 : p(t, tout, tout + 0.3, E.inn);
    el.style.transform = "translate3d(0," + ((1 - ki) * 105 - ko * 105) + "%,0)";
  }
  function inner(sel) { return $$(sel + " .mask > span"); }
  function offsetIn(el, root) {
    var x = 0, y = 0;
    while (el && el !== root) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent; }
    return { x: x, y: y };
  }

  // ---------- chrome ----------
  var secs = $$("#sec span");
  var secCuts = [[0, 0], [11.0, 1], [17.5, 2], [20.5, 3]];
  function chrome(t) {
    var vis = (t >= 0 && t < 5.75) || (t >= 11.0 && t < 20.5);
    on($("#chrome"), vis);
    var cur = 0, at = -1, prev = -1;
    secCuts.forEach(function (c, i) { if (t >= c[0]) { prev = i ? secCuts[i - 1][1] : -1; cur = c[1]; at = c[0]; } });
    var k = p(t, at + 0.05, at + 0.4, E.out);
    secs.forEach(function (s, i) {
      var y = 100;
      if (i === cur) y = (1 - k) * 100;
      else if (i === prev && at > 11.0) y = -k * 100;
      s.style.transform = "translate3d(0," + y + "%,0)";
    });
  }

  // ---------- terminal lines ----------
  var lines = $$("#c1 .ln").map(function (el) {
    var body = el.querySelector(".body");
    return { el: el, t: +el.dataset.t, typed: el.hasAttribute("data-type"), body: body, text: body.textContent };
  });
  var cursor = document.createElement("span"); cursor.className = "cursor";
  var boardSpans = $$("#slot span");
  var boardCuts = [[11.0, 0], [12.27, 1], [14.12, 2], [15.85, 3], [16.6, 4]];
  var cam = $("#cam"), flight = $("#flight");
  var fromPt, toPt;
  function measure() {
    var s = offsetIn($("#send"), cam), d = offsetIn($("#land"), cam);
    fromPt = { x: s.x + 40, y: s.y + 36 };
    toPt = { x: d.x, y: d.y };
  }

  function renderFrame(t) {
    chrome(t);

    // A1: two agents, one file
    if (win("#a1", t, 0, 1.5)) {
      mask($("#a1-l1"), t, 0.06, 1.2);
      mask($("#a1-l2"), t, 0.75, 1.25);
    }

    // A2: the collision
    if (win("#a2", t, 1.5, 4.0)) {
      var punch = t >= 2.75 ? 0.035 * Math.exp(-(t - 2.75) * 9) : 0;
      $("#a2-cam").style.transform = "scale(" + (lerp(1, 1.05, p(t, 1.5, 4.0, E.lin)) + punch) + ")";
      $("#a-path").parentElement.style.transform = "";
      mask($("#a-path"), t, 1.5, null, 0.5);
      var ka = p(t, 1.62, 2.1), kn = p(t, 1.82, 2.3);
      $("#a2-ana").style.transform = "translate3d(" + ((1 - ka) * -900) + "px,0,0)";
      $("#a2-nico").style.transform = "translate3d(" + ((1 - kn) * -900) + "px,0,0)";
      var hit = t >= 2.75;
      $("#a2-ana-s").textContent = hit ? "overwritten" : t >= 2.25 ? "writing" : "editing";
      $("#a2-nico-s").textContent = t >= 2.25 ? "writing" : "editing";
      $("#a2-ana-s").style.color = hit ? "var(--bad)" : "";
      $("#a-path").style.color = hit ? "var(--bad)" : "";
      $("#a-strike").style.transform = "scaleX(" + p(t, 2.75, 3.05) + ")";
      mask($("#a2-k .mask > span"), t, 3.05, null, 0.4);
    }

    // A3: consequences, one per beat
    if (win("#a3", t, 4.0, 5.75)) {
      var blocks = $$("#a3 > div");
      blocks.forEach(function (b, i) {
        var a = 4.0 + i * 0.5, z = i < 2 ? a + 0.5 : 5.75;
        on(b, t >= a && t < z);
        var spans = $$(".mask > span", b);
        spans.forEach(function (s, j) { mask(s, t, a + j * 0.04, i === 2 ? 5.42 : null, 0.32); });
      });
    }

    // B1: mark builds, its core floods the frame, wordmark lands
    if (win("#b1", t, 5.75, 8.5)) {
      $("#b1-a").style.strokeDashoffset = 1 - p(t, 5.85, 6.35, E.io);
      $("#b1-b").style.strokeDashoffset = 1 - p(t, 5.97, 6.47, E.io);
      var kc = p(t, 6.3, 6.75);
      $("#b1-core").style.transform = "scale(" + kc + ")";
      var S = lerp(1, 24, p(t, 7.0, 7.5, bez(0.7, 0, 0.9, 0.35)));
      $("#b1-g").style.transform = "scale(" + S + ")";
      on($("#flood"), t >= 7.0 && S >= 20);
      on($("#b1-mark"), !(S >= 20));
      on($("#b1-word"), t >= 7.4);
      mask($("#b1-word .mask > span"), t, 7.45, null, 0.55);
    }

    // B2: positioning
    if (win("#b2", t, 8.5, 11.0)) {
      mask($("#b2-l1"), t, 8.5, 10.6);
      mask($("#b2-l2"), t, 8.6, 10.64);
      mask($("#b2-k"), t, 9.1, 10.68, 0.4);
    }

    // C1: the product, live
    if (win("#c1", t, 11.0, 17.5)) {
      var cpos = track(t, [
        [11.0, [960, 540, 1]], [12.45, [960, 540, 1]],
        [12.85, [1386, 420, 1.5]], [14.2, [1386, 440, 1.52], E.lin],
        [14.6, [960, 540, 1]], [17.5, [960, 540, 1.04], E.lin]
      ]);
      var punch2 = t >= 13.0 ? 0.05 * Math.exp(-(t - 13.0) * 10) * (t < 14.2 ? 1 : 0) : 0;
      var s = cpos[2] + punch2;
      cam.style.transform = "translate(" + (960 - cpos[0] * s) + "px," + (540 - cpos[1] * s) + "px) scale(" + s + ")";
      [["#pa", 11.0], ["#pn", 11.08]].forEach(function (q) {
        var k = p(t, q[1], q[1] + 0.5);
        $(q[0]).style.clipPath = "inset(0 0 " + ((1 - k) * 100) + "% 0 round 16px)";
      });
      $("#board").style.clipPath = "inset(0 " + ((1 - p(t, 11.2, 11.75)) * 100) + "% 0 0 round 14px)";

      cursor.remove();
      lines.forEach(function (L) {
        var vis = t >= L.t;
        show(L.el, vis);
        if (L.typed) {
          var k = clamp((t - L.t) / 0.24), n = Math.round(L.text.length * k);
          L.body.textContent = L.text.slice(0, n);
          if (vis && k < 1) L.body.appendChild(cursor);
        }
        if (L.el.id === "blocked") L.el.style.background = "rgba(255,179,179," + (0.2 * (1 - p(t, 13.0, 13.9))) + ")";
      });
      // the message leaves claude-nico and lands in codex-ana's pane
      var kf = p(t, 14.6, 15.12, E.io);
      show(flight, t >= 14.5 && t < 15.12);
      if (t >= 14.5 && t < 15.12) {
        var x = lerp(fromPt.x, toPt.x, kf), y = lerp(fromPt.y, toPt.y, kf) - Math.sin(kf * Math.PI) * 170;
        var sc = lerp(0.85, 1, p(t, 14.5, 14.7)) ;
        flight.style.transform = "translate(" + x + "px," + y + "px) scale(" + sc + ")";
      }
      // board state rolls like a split-flap
      var cur = 0, at = 11.0, prev = -1;
      boardCuts.forEach(function (c, i) { if (t >= c[0]) { prev = i ? boardCuts[i - 1][1] : -1; cur = c[1]; at = c[0]; } });
      var kb = p(t, at, at + 0.35);
      boardSpans.forEach(function (sp, i) {
        var y = 100;
        if (i === cur) y = at === 11.0 ? 0 : (1 - kb) * 100;
        else if (i === prev) y = -kb * 100;
        sp.style.transform = "translate3d(0," + y + "%,0)";
      });
    }

    // C2: three features, one per bar half
    [["#f1", 17.5], ["#f2", 18.5], ["#f3", 19.5]].forEach(function (f) {
      if (!win(f[0], t, f[1], f[1] + 1)) return;
      inner(f[0]).forEach(function (s, j) { mask(s, t, f[1] + j * 0.05, null, 0.4); });
      $$(f[0] + " .rows > *").forEach(function (r, j) {
        var k = p(t, f[1] + 0.1 + j * 0.07, f[1] + 0.55 + j * 0.07);
        r.style.transform = "translate3d(" + ((1 - k) * 120) + "px,0,0)";
        r.style.clipPath = "inset(0 0 0 " + ((1 - k) * 100) + "% round 16px)";
      });
    });

    // C3: dashboard, pull out from the blocked edit to the whole board
    if (win("#d1", t, 20.5, 24.0)) {
      var d = track(t, [
        [20.5, [1250, 810, 1.0, 960, 560]],
        [20.95, [1250, 810, 0.95, 960, 560], E.lin],
        [22.2, [1440, 900, 0.545, 960, 600]],
        [24.0, [1440, 900, 0.56, 960, 600], E.lin]
      ]);
      $("#dash").style.transform = "translate(" + (d[3] - d[0] * d[2]) + "px," + (d[4] - d[1] * d[2]) + "px) scale(" + d[2] + ")";
    }

    // D: end card
    if (win("#e1", t, 24.0, DUR + 1)) {
      $("#e-a").style.strokeDashoffset = 1 - p(t, 24.0, 24.4, E.io);
      $("#e-b").style.strokeDashoffset = 1 - p(t, 24.07, 24.47, E.io);
      $("#e-core").style.transform = "scale(" + p(t, 24.3, 24.7) + ")";
      mask($("#e-word"), t, 24.2, null, 0.55);
      mask($("#e-tag"), t, 24.6, null, 0.5);
      var kr = p(t, 25.0, 25.6);
      $("#e-row").style.clipPath = "inset(0 " + ((1 - kr) * 50) + "% 0 " + ((1 - kr) * 50) + "%)";
    }
  }

  measure();
  window.FILM = { DUR: DUR, FPS: FPS, renderFrame: renderFrame };
  if (/[?&]play/.test(location.search)) {
    var start = performance.now();
    (function loop(now) { renderFrame(((now - start) / 1000) % DUR); requestAnimationFrame(loop); })(start);
  } else {
    renderFrame(0);
  }
})();
