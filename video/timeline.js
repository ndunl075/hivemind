// Deterministic timeline: renderFrame(t) sets every property from time t alone,
// so any frame can be rendered in any order.
(function () {
  var DUR = 49, FPS = 60;

  // cubic-bezier solver
  function bez(x1, y1, x2, y2) {
    function a(p1, p2) { return 1 - 3 * p2 + 3 * p1; }
    function b(p1, p2) { return 3 * p2 - 6 * p1; }
    function c(p1) { return 3 * p1; }
    function at(t, p1, p2) { return ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t; }
    function slope(t, p1, p2) { return 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1); }
    return function (x) {
      if (x <= 0) return 0; if (x >= 1) return 1;
      var t = x;
      for (var i = 0; i < 8; i++) {
        var s = slope(t, x1, x2); if (Math.abs(s) < 1e-6) break;
        t -= (at(t, x1, x2) - x) / s;
      }
      var lo = 0, hi = 1;
      for (var j = 0; j < 20 && Math.abs(at(t, x1, x2) - x) > 1e-6; j++) {
        if (at(t, x1, x2) < x) lo = t; else hi = t; t = (lo + hi) / 2;
      }
      return at(t, y1, y2);
    };
  }
  var E = {
    out: bez(0.16, 1, 0.3, 1),     // expo-like decelerate
    soft: bez(0.25, 1, 0.5, 1),    // quart out
    io: bez(0.65, 0, 0.35, 1),     // symmetric in-out
    inn: bez(0.55, 0, 0.75, 0.2),  // accelerate out of frame
    lin: function (x) { return x; }
  };
  function clamp(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function p(t, a, b, e) { return (e || E.out)(clamp((t - a) / (b - a))); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }

  // split headlines into masked words
  var splits = {};
  $$(".split").forEach(function (el) {
    var words = el.textContent.trim().split(/\s+/);
    el.innerHTML = '<span class="line">' + words.map(function (w) { return '<span class="word">' + w + "</span>"; }).join(" ") + "</span>";
    splits[el.dataset.k] = $$('[data-k="' + el.dataset.k + '"] .word');
  });
  function words(key, t, tin, tout) {
    var ws = splits[key];
    ws.forEach(function (w, i) {
      var ki = p(t, tin + i * 0.045, tin + i * 0.045 + 0.95, E.out);
      var ko = tout == null ? 0 : p(t, tout + i * 0.025, tout + i * 0.025 + 0.55, E.inn);
      w.style.transform = "translate3d(0," + ((1 - ki) * 108 - ko * 108) + "%,0)";
    });
  }
  // fade + rise in, fade + lift out
  function rise(el, t, tin, tout, dy, dur) {
    dy = dy == null ? 28 : dy; dur = dur || 0.9;
    var ki = p(t, tin, tin + dur, E.out);
    var ko = tout == null ? 0 : p(t, tout, tout + 0.55, E.inn);
    el.style.opacity = ki * (1 - ko);
    el.style.transform = "translate3d(0," + ((1 - ki) * dy - ko * 16) + "px,0)";
  }
  function scene(id, t, a, b) {
    var el = $(id); var on = t >= a && t < b;
    el.style.opacity = on ? 1 : 0; el.style.visibility = on ? "visible" : "hidden";
    return on;
  }

  // film grain, a few fixed noise tiles cycled per frame
  var grain = $("#grain"), gctx = grain.getContext("2d"), tiles = [];
  var seed = 1; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  for (var g = 0; g < 6; g++) {
    var img = gctx.createImageData(960, 540);
    for (var i = 0; i < img.data.length; i += 4) { var v = rnd() * 255 | 0; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    tiles.push(img);
  }

  if (/[?&]bgonly/.test(location.search)) document.documentElement.classList.add("bgonly");

  // connectors from each agent card down to the file chip
  (function () {
    var file = $("#s3-file"), fy = file.offsetTop, fx = 960;
    [["#s3-ana", "#s3-la", -150], ["#s3-nico", "#s3-lb", 150]].forEach(function (c) {
      var card = $(c[0]), x = card.offsetLeft + card.offsetWidth / 2, y = card.offsetTop + card.offsetHeight;
      var ex = fx + c[2], my = (y + fy) / 2;
      $(c[1]).setAttribute("d", "M " + x + " " + y + " C " + x + " " + my + ", " + ex + " " + my + ", " + ex + " " + fy);
    });
  })();

  var boardCodes = $$("#board code");
  var laItems = $$("#la li"), lnItems = $$("#ln li");
  var demoSteps = [
    [laItems[0], 20.6, null], [laItems[1], 21.7, 1], [lnItems[0], 22.9, null], [lnItems[1], 23.9, null],
    [lnItems[2], 25.3, 2], [laItems[2], 26.6, null], [laItems[3], 27.9, 3], [lnItems[3], 29.0, 4]
  ];

  function renderFrame(t) {
    var frame = Math.round(t * FPS);
    gctx.putImageData(tiles[frame % tiles.length], 0, 0);

    // backdrop: slow, constant drift
    $("#bg").style.transform = "translate3d(" + (-t * 0.9) + "px," + (-t * 0.35) + "px,0)";

    // 1. logo build
    if (scene("#s1", t, 0, 4.45)) {
      var da = p(t, 0.35, 1.65, E.io), db = p(t, 0.6, 1.9, E.io);
      $("#s1-a").style.strokeDashoffset = 1 - da;
      $("#s1-b").style.strokeDashoffset = 1 - db;
      var kc = p(t, 1.5, 2.4, E.out);
      $("#s1-core").style.opacity = kc;
      $("#s1-core").style.transform = "scale(" + lerp(0.55, 1, kc) + ")";
      var mark = $("#s1-mark"), word = $("#s1-word");
      var shift = (word.offsetWidth + 40) / 2;
      var kl = p(t, 2.2, 3.3, E.io);
      mark.style.transform = "translate3d(" + lerp(shift, 0, kl) + "px,0,0)";
      var kw = p(t, 2.45, 3.45, E.out);
      word.style.clipPath = "inset(-10% " + ((1 - kw) * 100) + "% -10% 0)";
      word.style.transform = "translate3d(" + lerp(shift - 60, 0, p(t, 2.2, 3.3, E.io)) + "px,0,0)";
      var ko = p(t, 3.85, 4.45, E.inn);
      $("#s1-lock").style.opacity = 1 - ko;
      $("#s1-lock").style.transform = "scale(" + lerp(1, 0.97, ko) + ")";
    }

    // 2. problem
    if (scene("#s2", t, 4.3, 8.3)) {
      words("s2a", t, 4.45, 7.5);
      words("s2b", t, 5.35, 7.62);
    }

    // 3. collision
    if (scene("#s3", t, 8.0, 14.6)) {
      var x3 = 13.9;
      rise($("#s3-label"), t, 8.1, x3, 16);
      var ka = p(t, 8.2, 9.1), kn = p(t, 8.35, 9.25), ko3 = p(t, x3, x3 + 0.6, E.inn);
      $("#s3-ana").style.opacity = ka * (1 - ko3);
      $("#s3-ana").style.transform = "translate3d(" + ((1 - ka) * -70) + "px," + (-ko3 * 16) + "px,0)";
      $("#s3-nico").style.opacity = kn * (1 - ko3);
      $("#s3-nico").style.transform = "translate3d(" + ((1 - kn) * 70) + "px," + (-ko3 * 16) + "px,0)";
      var kf = p(t, 8.6, 9.4);
      var file = $("#s3-file");
      file.style.opacity = kf * (1 - ko3);
      file.style.transform = "translate3d(-50%," + ((1 - kf) * 24 - ko3 * 16) + "px,0)";
      var la = p(t, 9.4, 10.5, E.io), lb = p(t, 9.6, 10.6, E.io);
      $("#s3-la").style.strokeDashoffset = 1 - la; $("#s3-lb").style.strokeDashoffset = 1 - lb;
      $("#s3-la").style.opacity = $("#s3-lb").style.opacity = 1 - ko3;
      var hit = t >= 10.6, chip = $("#s3-chip");
      chip.textContent = hit ? "conflict" : (t >= 9.6 ? "2 writers" : "idle");
      chip.className = "chip " + (hit ? "bad" : t >= 9.6 ? "acc" : "dim");
      var kr = p(t, 10.6, 11.0, E.soft);
      file.style.borderColor = hit ? "rgba(255,179,179," + lerp(0.22, 1, kr) + ")" : "";
      file.style.boxShadow = hit ? "0 0 0 " + (kr * 10) + "px rgba(255,179,179," + (0.22 * (1 - p(t, 10.8, 11.8, E.soft))) + ")" : "";
      var ast = $("#s3-ast");
      ast.textContent = t >= 10.9 ? "overwritten" : "writing";
      ast.style.color = t >= 10.9 ? "var(--bad)" : "var(--ok)";
      $$(".s3c").forEach(function (el, i) { rise(el, t, 11.2 + i * 0.25, x3 - 0.1 + i * 0.05, 14); });
    }

    // 4. introducing
    if (scene("#s4", t, 14.4, 19.2)) {
      var ki4 = p(t, 14.55, 15.5), ko4 = p(t, 18.45, 19.0, E.inn);
      var tile = $("#s4-tile");
      tile.style.opacity = ki4 * (1 - ko4);
      tile.style.transform = "translate3d(0," + (-ko4 * 16) + "px,0) scale(" + lerp(0.86, 1, ki4) + ")";
      words("s4a", t, 15.0, 18.4);
      words("s4b", t, 15.3, 18.5);
      rise($("#s4-sub"), t, 16.3, 18.45, 14);
    }

    // 5. demo
    if (scene("#s5", t, 19.0, 31.6)) {
      var x5 = 30.9;
      rise($("#s5-label"), t, 19.1, x5, 14);
      words("s5a", t, 19.2, x5);
      var stage = $("#s5-stage");
      var ks = p(t, 19.45, 20.5), kso = p(t, x5, x5 + 0.6, E.inn);
      var push = lerp(1, 1.03, p(t, 19.45, 31.5, E.lin));
      stage.style.opacity = ks * (1 - kso);
      stage.style.transform = "translate3d(0," + ((1 - ks) * 60 - kso * 20) + "px,0) scale(" + push + ")";
      var boardIdx = 0;
      demoSteps.forEach(function (s) {
        var k = p(t, s[1], s[1] + 0.55, E.soft);
        s[0].style.opacity = k;
        s[0].style.transform = "translate3d(0," + ((1 - k) * 10) + "px,0)";
        if (s[2] != null && t >= s[1]) boardIdx = s[2];
      });
      // board text: crossfade to the latest state
      var lastChange = 0;
      demoSteps.forEach(function (s) { if (s[2] != null && t >= s[1]) lastChange = s[1]; });
      var kb = lastChange ? p(t, lastChange, lastChange + 0.45, E.soft) : 1;
      var prev = 0;
      demoSteps.forEach(function (s) { if (s[2] != null && s[1] < lastChange) prev = s[2]; });
      boardCodes.forEach(function (c, i) {
        var o = 0, y = 0;
        if (i === boardIdx) { o = kb; y = (1 - kb) * 10; }
        else if (i === prev && kb < 1) { o = 1 - kb; y = -kb * 10; }
        c.style.opacity = o; c.style.transform = "translate3d(0," + y + "px,0)";
      });
    }

    // 6. features
    if (scene("#s6", t, 31.4, 37.7)) {
      ["#f1", "#f2", "#f3"].forEach(function (id, i) {
        var f = $(id), t0 = 31.6 + i * 0.28, tout = 37.0 + i * 0.06;
        rise(f.querySelector(".label"), t, t0, tout, 16);
        rise(f.querySelector("h3"), t, t0 + 0.1, tout, 22);
        rise(f.querySelector(".card"), t, t0 + 0.25, tout, 40, 1.0);
        $$(id + " .row").forEach(function (r, j) {
          var k = p(t, t0 + 0.6 + j * 0.14, t0 + 1.2 + j * 0.14, E.soft);
          r.style.opacity = k; r.style.transform = "translate3d(0," + ((1 - k) * 8) + "px,0)";
        });
      });
    }

    // 7. dashboard
    if (scene("#s7", t, 37.5, 43.3)) {
      var x7 = 42.65;
      rise($("#s7-label"), t, 37.6, x7, 14);
      words("s7a", t, 37.7, x7);
      var fr = $("#s7-frame");
      var kfr = p(t, 38.0, 39.4), kfo = p(t, x7, x7 + 0.6, E.inn);
      var drift = lerp(0, -70, p(t, 38.0, 43.3, E.io));
      fr.style.opacity = kfr * (1 - kfo);
      fr.style.transform = "translate3d(0," + ((1 - kfr) * 180 + drift) + "px,0) scale(" + lerp(0.94, 1, kfr) + ")";
    }

    // 8. end card
    if (scene("#s8", t, 43.2, DUR + 1)) {
      rise($("#s8-lock"), t, 43.35, null, 24, 1.1);
      rise($("#s8-tag"), t, 43.9, null, 18);
      rise($("#s8-works"), t, 44.4, null, 14);
      rise($("#s8-cta"), t, 44.8, null, 14);
      var kend = p(t, 48.2, 49.0, E.io);
      $("#s8").style.opacity = 1 - kend;
    }
  }

  window.FILM = { DUR: DUR, FPS: FPS, renderFrame: renderFrame };

  // live preview in a browser: open index.html?play
  if (/[?&]play/.test(location.search)) {
    var start = performance.now();
    (function loop(now) { renderFrame(((now - start) / 1000) % DUR); requestAnimationFrame(loop); })(start);
  } else {
    renderFrame(0);
  }
})();
