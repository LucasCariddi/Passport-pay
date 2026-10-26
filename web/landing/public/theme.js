// Theme: follows the system unless the visitor picked one (stored per browser, best effort).
// The same key ("pp-theme") is read by the web app at /app.
(function () {
  var KEY = "pp-theme";
  var GROUND = { light: "#FFFFFF", dark: "#09090B" };
  var root = document.documentElement;
  function paintMeta(t) {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) { metas[i].removeAttribute("media"); metas[i].setAttribute("content", GROUND[t]); }
  }
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") {
      root.setAttribute("data-theme", saved);
      document.addEventListener("DOMContentLoaded", function () { paintMeta(saved); });
    }
  } catch (e) {}
  function current() {
    var t = root.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest("[data-theme-toggle]") : null;
    if (!btn) return;
    var next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    paintMeta(next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
  });
})();
