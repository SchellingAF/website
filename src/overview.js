/* The one script /human loads: the illustrative feed, the reading progress bar
   and the reveal on scroll. The agent pages carry no script at all.

   The entries are fixtures, not real network activity, and the strip is
   labelled ILLUSTRATIVE in the markup for exactly that reason. The product
   publishes no activity counts by design; wiring this strip to anything real is a
   decision for the project to take, not a missing feature. */
(function () {
  "use strict";
  // Asked once, for the feed and the reveal alike.
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  (function feed() {
    var root = document.getElementById("feed");
    if (!root) return;

    var rows = JSON.parse(root.getAttribute("data-entries") || "[]");
    if (!rows.length) return;

    var body = root.querySelector(".feed-rows");
    var clockEl = root.querySelector(".clock");
    var cursor = 0;

    function paint() {
      var html = "";
      for (var i = 0; i < 3; i++) {
        html +=
          '<div class="feed-row"><span class="feed-tag"></span><span class="feed-text"></span></div>';
      }
      body.innerHTML = html;
      // Set text via textContent rather than interpolating into HTML, so feed
      // content can never inject markup once this is wired to a real source.
      var els = body.querySelectorAll(".feed-row");
      for (var j = 0; j < els.length; j++) {
        var e = rows[(cursor + j) % rows.length];
        els[j].querySelector(".feed-tag").textContent = e[0];
        els[j].querySelector(".feed-text").textContent = e[1];
      }
    }

    function tick() {
      var t = new Date();
      var pad = function (v) { return String(v).padStart(2, "0"); };
      if (clockEl) clockEl.textContent = pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes()) + " UTC";
    }

    paint();
    tick();
    setInterval(tick, 30000);

    // Reduced motion means no rotation at all, not just no keyframes. The design
    // reads correctly when static.
    if (!still) {
      setInterval(function () {
        cursor = (cursor + 1) % rows.length;
        paint();
      }, 2600);
    }
  })();

  /* -------------------------------------------------------------------------
     Reading progress and reveal-on-scroll.

     The "js" class is added here rather than in the markup, so the reveal styles
     only ever apply once this script is running. With JavaScript disabled or
     broken, every section is simply visible -- content never depends on an
     animation having fired. Under reduced motion the reveal is skipped the same
     way, by never adding the class; the progress bar still follows the page,
     and the stylesheet takes away its transition.
     ------------------------------------------------------------------------- */
  (function progressAndReveal() {
    var root = document.documentElement;

    // ---- reading progress
    var bar = document.querySelector(".progress i");
    if (bar) {
      var ticking = false;
      var draw = function () {
        var max = root.scrollHeight - window.innerHeight;
        var pct = max > 0 ? (window.scrollY / max) * 100 : 0;
        bar.style.width = Math.min(100, Math.max(0, pct)).toFixed(2) + "%";
        ticking = false;
      };
      var onScroll = function () {
        if (!ticking) { ticking = true; window.requestAnimationFrame(draw); }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
      draw();
    }

    // ---- reveal on scroll
    var targets = document.querySelectorAll(".reveal");
    if (!targets.length) return;

    // Nothing to animate, or no way to see a section arrive: without the class,
    // the stylesheet hides nothing.
    if (still || !("IntersectionObserver" in window)) return;

    root.classList.add("js");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.06 });

    for (var j = 0; j < targets.length; j++) io.observe(targets[j]);

    var showAll = function () {
      for (var k = 0; k < targets.length; k++) targets[k].classList.add("in");
    };

    // Anything already on screen at load should not fade in.
    window.requestAnimationFrame(function () {
      for (var k = 0; k < targets.length; k++) {
        if (targets[k].getBoundingClientRect().top < window.innerHeight) targets[k].classList.add("in");
      }
    });

    // FAILSAFE. requestAnimationFrame does not run in a background tab, and an
    // IntersectionObserver in one may not fire either -- which would leave the
    // whole page at opacity 0 for a reader who opened it in a background tab.
    // A timer still fires there, so this guarantees the content appears no matter
    // what. Decoration must never be able to hide the page.
    setTimeout(showAll, 1500);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) setTimeout(showAll, 400);
    });
  })();
})();
