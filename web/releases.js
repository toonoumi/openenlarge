// Detect the visitor's OS and point the download buttons at the matching
// installer, read from a static, same-origin releases.json (generated at release
// time — see .github/workflows/release.yml). No api.github.com call at runtime,
// so the download buttons populate even behind the Great Firewall. Installers are
// served from Cloudflare R2 via download.aako.world.
// Labels are localized via window.OE (see i18n.js) and re-applied on language change.
(function () {
  // Error fallback only (e.g. releases.json failed to load) — not the normal path.
  var LATEST = "https://github.com/mohaelder/openenlarge/releases/latest";

  function detectOS() {
    var ua = (navigator.userAgent || "") + " " + (navigator.platform || "");
    if (/Android/i.test(ua)) return null; // Android UA contains "Linux"; no desktop build for it
    if (/Mac|iPhone|iPad/i.test(ua)) return "macos";
    if (/Win/i.test(ua)) return "windows";
    if (/Linux|X11/i.test(ua)) return "linux";
    return null;
  }

  function t(key, fallback) {
    return (window.OE && window.OE.t) ? window.OE.t(key) : fallback;
  }

  var os = detectOS();
  var REL_BASE = (window.OE && window.OE.locale && window.OE.locale !== "en") ? "../" : "./";
  var heroBtn = document.getElementById("hero-download");
  var dlBtn = document.getElementById("dl-download");
  var navBtn = document.getElementById("nav-download");
  var meta = document.getElementById("release-meta");
  var lastTag = null;

  // Set the OS-specific download label (localized) on the primary buttons.
  function applyOsLabels() {
    if (!os) return; // unknown OS: leave the localized base label from data-i18n
    var label = "↓ " + t("dl.os." + os, "Download");
    if (heroBtn) heroBtn.textContent = label;
    if (dlBtn) dlBtn.textContent = label;
  }

  // Append the release tag to the localized meta line, e.g. "... · v0.5.0".
  function applyMeta() {
    if (meta && lastTag) meta.textContent = t("hero.metaLine", meta.textContent) + " · " + lastTag;
  }

  applyOsLabels();

  // Re-localize when the user switches language (i18n.js reset textContent first).
  window.addEventListener("oe-locale", function () {
    applyOsLabels();
    applyMeta();
  });

  // releases.json shape: { "tag": "vX.Y.Z", "assets": { "macos": url, "windows": url, "linux": url } }
  fetch(REL_BASE + "releases.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (rel) {
      var assets = rel.assets || {};
      var url = (os && assets[os]) ? assets[os] : LATEST;
      [heroBtn, dlBtn, navBtn].forEach(function (b) { if (b) b.href = url; });

      if (rel.tag) { lastTag = rel.tag; applyMeta(); }

      // Wire the per-OS quick links to their installer, if present.
      var row = document.getElementById("os-row");
      if (row) {
        ["macos", "windows", "linux"].forEach(function (o) {
          var link = row.querySelector('[data-os="' + o + '"]');
          if (assets[o] && link) link.href = assets[o];
        });
      }
    })
    .catch(function () {
      // releases.json missing/unreadable: fall back to the GitHub releases page.
      [heroBtn, dlBtn, navBtn].forEach(function (b) { if (b) b.href = LATEST; });
    });

  // Testing channel: reveal the alpha block only when releases-alpha.json exists
  // and carries assets. Absent/empty => the block stays hidden (default).
  fetch(REL_BASE + "releases-alpha.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (rel) {
      var assets = rel.assets || {};
      if (!assets.macos && !assets.windows && !assets.linux) return; // nothing to show
      var block = document.getElementById("alpha-block");
      var btn = document.getElementById("alpha-download");
      var tagEl = document.getElementById("alpha-tag");
      if (block) block.style.display = "";
      if (btn) {
        btn.href = (os && assets[os]) ? assets[os] : LATEST;
        if (os) btn.textContent = t("dl.alpha.os." + os, btn.textContent);
      }
      if (tagEl && rel.tag) tagEl.textContent = rel.tag;
    })
    .catch(function () { /* no alpha published — leave the block hidden */ });
})();
