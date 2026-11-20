// Artwork pages (art/*.html). Two small behaviours shared with the gallery
// (script.js), kept here because these pages don't load the gallery script.

// 1. GitHub Pages now and then answers an image request with a 503. Retry a
//    failed image a few times with a growing delay before giving up, so a
//    blip doesn't leave a broken-image icon.
(function () {
  var RETRIES = 3;
  function base(u) { return String(u || "").replace(/[?&]r=\d+$/, ""); }
  document.addEventListener("error", function (e) {
    var img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    var b = base(img.getAttribute("src"));
    if (!b || /^data:/i.test(b)) return;
    if (img.dataset.retrySrc !== b) { img.dataset.retrySrc = b; img.dataset.retries = "0"; }
    var n = Number(img.dataset.retries) + 1;
    if (n > RETRIES) return;
    img.dataset.retries = String(n);
    setTimeout(function () {
      if (!img.isConnected || base(img.getAttribute("src")) !== b) return;
      img.src = b + (b.indexOf("?") >= 0 ? "&" : "?") + "r=" + n;
    }, 700 * Math.pow(2, n - 1) + Math.random() * 400);
  }, true);
})();

// 2. The same casual save deterrents as the gallery: no context menu and no
//    drag-out on artwork images. (Nothing on the web can stop a screenshot.)
(function () {
  function onArt(e) { return e.target instanceof HTMLImageElement && e.target.closest(".a-piece__fig, .a-grid"); }
  document.addEventListener("contextmenu", function (e) { if (onArt(e)) e.preventDefault(); });
  document.addEventListener("dragstart", function (e) { if (onArt(e)) e.preventDefault(); });
})();
