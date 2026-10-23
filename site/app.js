(function () {
  "use strict";
  var root = document.documentElement;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Download button: label by visitor OS. Windows and Mac computers get one
  // primary button and the other OS as a small link; anything else (Linux,
  // Android, ChromeOS, iPhone, iPad) gets both buttons, neither primary.
  var base = "https://github.com/ndunl075/hivemind/releases/latest/download/";
  var ua = navigator.userAgent || "";
  var touch = navigator.maxTouchPoints > 1;
  var os = "both";
  if (/iPhone|iPad|iPod|Android|CrOS|Linux/.test(ua) || (/Macintosh/.test(ua) && touch)) os = "both";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "mac";
  else if (/Windows/.test(ua)) os = "windows";
  var names = { windows: "Windows", mac: "Mac" };
  var main = document.getElementById("dl-main");
  var alt = document.getElementById("dl-alt");
  if (os === "both") {
    alt.className = "pill";
    alt.textContent = "Download for Mac";
    document.querySelector(".dl").classList.add("both");
    document.getElementById("dl-note").hidden = false;
  } else {
    var other = os === "mac" ? "windows" : "mac";
    main.href = base + "hivemind-" + os + ".zip";
    main.textContent = "Download for " + names[os];
    alt.href = base + "hivemind-" + other + ".zip";
    alt.textContent = "Or download for " + names[other];
  }

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
  var timer = null, idx = 0, paused = false;

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
    clearTimeout(timer); timer = null; idx = 0; paused = false;
    ana.innerHTML = ""; nico.innerHTML = "";
    board.textContent = F + " is free";
  }
  function label(text) { replay.textContent = text; replay.setAttribute("aria-label", text === "Pause" ? "Pause the animation" : text === "Play" ? "Resume the animation" : "Replay the animation"); }
  function tick() {
    if (idx >= steps.length) { timer = null; label("Replay"); return; }
    add(steps[idx++]);
    timer = setTimeout(tick, 1500);
  }
  function play() {
    clear();
    if (reduce) { steps.forEach(add); replay.hidden = true; return; }
    replay.hidden = false;
    label("Pause");
    timer = setTimeout(tick, 700);
  }
  replay.addEventListener("click", function () {
    if (idx >= steps.length && !timer && !paused) { play(); return; }
    if (paused) { paused = false; label("Pause"); timer = setTimeout(tick, 400); }
    else { paused = true; clearTimeout(timer); timer = null; label("Play"); }
  });

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
