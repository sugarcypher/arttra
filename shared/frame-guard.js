// Refuse to render inside someone else's frame (CSP frame-ancestors can't be
// set from a <meta> tag on GitHub Pages).
if (window.top !== window.self) {
  try { window.top.location = window.self.location; } catch (e) { document.documentElement.style.display = "none"; }
}
