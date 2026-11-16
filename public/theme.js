// Applies a remembered light/dark choice before the page paints. Without one, the CSS follows the system setting.
(function () {
  try {
    var t = localStorage.getItem('cofdr-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* storage unavailable: follow the system setting */
  }
})();
