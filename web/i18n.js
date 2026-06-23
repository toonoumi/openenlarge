// Per-URL i18n for the landing/blog pages. Text is baked into each locale's static
// HTML by scripts/gen-web.py, so this runtime no longer swaps page text. It:
//  - derives the active locale from the URL path,
//  - exposes window.OE = { t, locale } so releases.js can localize OS-aware labels,
//  - turns #lang-toggle into a language menu that navigates to the sibling-locale URL.
window.OE = (function () {
  var LOCALES = ["en", "zh", "ja", "ko"];
  var LABELS = { en: "English", zh: "中文", ja: "日本語", ko: "한국어" };

  function localeFromPath() {
    var seg = (location.pathname.split("/")[1] || "").toLowerCase();
    return LOCALES.indexOf(seg) > 0 ? seg : "en";
  }
  var locale = localeFromPath();

  // STRINGS are fetched once for OE.t (used by releases.js for OS-specific labels).
  var STRINGS = { en: {}, zh: {}, ja: {}, ko: {} };
  function t(key) {
    return (STRINGS[locale] && STRINGS[locale][key]) || STRINGS.en[key] || key;
  }

  // Resolve the path to landing-strings.json from any locale depth (root or /<locale>/).
  function stringsUrl() {
    return (locale === "en" ? "" : "../") + "landing-strings.json";
  }

  // Compute the sibling URL for a target locale, preserving the current page (index|blog).
  function siblingUrl(target) {
    var isBlog = /blog\.html$/.test(location.pathname);
    var page = isBlog ? "blog.html" : "";
    var base = target === "en" ? "/" : "/" + target + "/";
    return base + page;
  }

  function wireToggle() {
    var toggle = document.getElementById("lang-toggle");
    if (!toggle) return;
    // Cycle to the next locale on click (simple, dependency-free; matches the old button UX).
    var idx = LOCALES.indexOf(locale);
    var next = LOCALES[(idx + 1) % LOCALES.length];
    toggle.textContent = LABELS[next];
    toggle.addEventListener("click", function () { location.href = siblingUrl(next); });
  }

  function init() {
    document.documentElement.lang = locale === "zh" ? "zh-Hans" : locale;
    wireToggle();
    fetch(stringsUrl(), { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) STRINGS = data;
        // Let releases.js (and anything else) re-localize now that strings are loaded.
        window.dispatchEvent(new CustomEvent("oe-locale", { detail: locale }));
      })
      .catch(function () { /* offline / blocked: OE.t falls back to keys */ });
  }
  init();

  return { t: t, get locale() { return locale; } };
})();
