(function () {
  "use strict";
  var root = document.documentElement;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Download button: label by visitor OS, other OS as the small link.
  var base = "https://github.com/ndunl075/hivemind/releases/latest/download/";
  var os = /Mac|iPhone|iPad/.test(navigator.platform || "") || /Mac OS X/.test(navigator.userAgent) ? "mac" : "windows";
  var names = { windows: "Windows", mac: "Mac" };
  var other = os === "mac" ? "windows" : "mac";
  var main = document.getElementById("dl-main");
  var alt = document.getElementById("dl-alt");
  main.href = base + "hivemind-" + os + ".zip";
  main.textContent = "Download for " + names[os];
  alt.href = base + "hivemind-" + other + ".zip";
  alt.textContent = "Or download for " + names[other];

  // Scroll-in.
  var items = document.querySelectorAll(".reveal");
  if (!reduce && "IntersectionObserver" in window) {
    root.classList.add("js");
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    items.forEach(function (el) { io.observe(el); });
  }

  // Demo: scripted from the sequence in ARCHITECTURE.md section 3.
  var ana = document.getElementById("lines-ana");
  var nico = document.getElementById("lines-nico");
  var board = document.getElementById("board-state");
  var replay = document.getElementById("replay");
  var F = "src/auth/login.ts";
  var steps = [
    [ana, "ok", "Claim task #4: fix session expiry", null, F + " is free"],
    [ana, "ok", "Edit " + F + ' <span class="t">· allowed, file held</span>', null, F + " held by codex-ana · task #4"],
    [nico, "", "Edit " + F, null, null],
    [nico, "deny", "Blocked. Held by codex-ana, task #4, unpushed changes.", null, null],
    [nico, "msg", 'Message to codex-ana: “need login.ts for the session fix”', null, "1 message waiting for codex-ana"],
    [ana, "msg", "Next step: message from claude-nico, “need login.ts for the session fix”", null, null],
    [ana, "ok", "Push. File released", null, F + " is free"],
    [nico, "ok", "Edit " + F + ' <span class="t">· allowed</span>', null, F + " held by claude-nico"]
  ];
  var timers = [];

  function add(s) {
    var li = document.createElement("li");
    if (s[1]) li.className = s[1];
    li.innerHTML = s[2];
    s[0].appendChild(li);
    void li.offsetWidth;
    li.classList.add("on");
    if (s[4]) board.textContent = s[4];
  }
  function clear() {
    timers.forEach(clearTimeout); timers = [];
    ana.innerHTML = ""; nico.innerHTML = "";
    board.textContent = F + " is free";
  }
  function play() {
    clear();
    if (reduce) { steps.forEach(add); return; }
    replay.hidden = true;
    steps.forEach(function (s, i) { timers.push(setTimeout(function () { add(s); }, 700 + i * 1500)); });
    timers.push(setTimeout(function () { replay.hidden = false; }, 700 + steps.length * 1500));
  }
  replay.addEventListener("click", play);

  var stage = document.getElementById("stage");
  if (reduce || !("IntersectionObserver" in window)) {
    play();
  } else {
    var so = new IntersectionObserver(function (es) {
      if (es[0].isIntersecting) { so.disconnect(); play(); }
    }, { threshold: 0.35 });
    so.observe(stage);
  }
})();
