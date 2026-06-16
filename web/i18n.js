// Tiny no-build i18n for the landing page.
// - Translatable text uses [data-i18n] (textContent) or [data-i18n-html] (innerHTML).
// - Initial locale: localStorage override, else browser language (zh* -> Chinese).
// - Exposes window.OE = { t, set, locale } and fires an 'oe-locale' event on change
//   so releases.js can re-localize the OS-aware download labels.
window.OE = (function () {
  var STRINGS = {
    en: {
      "meta.title": "OpenEnlarge — Open-source film scan editor",
      "meta.desc": "OpenEnlarge is free, open-source software that brings the darkroom to your desktop. Instead of naively flipping colors, it simulates the actual chemistry of film and paper — grounded in the Beer-Lambert density model the math is drawn from — to invert your scans authentically and edit them, all in one fast, fluid workflow.",
      "nav.features": "Features",
      "nav.how": "How it works",
      "nav.download": "Download",
      "nav.cta": "Download",
      "hero.eyebrow": "◆ Open source · density-domain",
      "hero.h1": "Open-source<br><span class=\"grad\">film scan editor.</span>",
      "hero.lede": "OpenEnlarge is free, open-source software that brings the darkroom to your desktop. Instead of naively flipping colors, it simulates the actual chemistry of film and paper — grounded in the Beer-Lambert density model the math is drawn from — to invert your scans authentically and edit them, all in one fast, fluid workflow.",
      "hero.dl": "↓ Download",
      "hero.star": "★ Star on GitHub",
      "hero.metaLine": "Free · MIT licensed · macOS, Windows & Linux",
      "card.label": "Density inversion",
      "features.kicker": "Features",
      "features.h2": "A real darkroom, on your desktop.",
      "feat.density.h3": "Cineon density inversion",
      "feat.density.p": "A physically-based Beer-Lambert engine (Kodak Cineon / negadoctor) inverts in the density domain, anchored on the measured film base — not a flipped curve.",
      "feat.decode.h3": "RAW, TIFF, JPEG & PNG",
      "feat.decode.p": "Fuji RAF, Panasonic RW2, Nikon NEF, Sony ARW, Canon CR3, Hasselblad 3FR and DNG, plus 16-bit TIFF, JPEG and PNG — decoded to linear RGB.",
      "feat.tether.h3": "Tethered shooting",
      "feat.tether.p": "Watch a folder and auto-import + develop new scans as they land — finished positives appear as you shoot.",
      "feat.base.h3": "Automatic film-base detection",
      "feat.base.p": "Finds the orange-mask rebate and samples it as one coherent clear-film color, locked per roll. Measured inside your crop, so camera scans don't wash out — recalibrate or pick a neutral anytime.",
      "feat.develop.h3": "Full develop controls",
      "feat.develop.p": "Tonal curves, color grading, color wheels, exposure, black point and gamma — live.",
      "feat.crop.h3": "Crop & batch export",
      "feat.crop.p": "Straighten, crop and rotate with a live histogram, then batch export to 16-bit TIFF, PNG or JPEG — with one shared crop applied across the whole roll.",
      "feat.hdr.h3": "HDR preview & export",
      "feat.hdr.p": "Toggle any frame into true HDR — highlights glow beyond white on HDR-capable displays — and export it as a gain-map HDR JPEG that matches the preview. Experimental.",
      "feat.cli.h3": "Headless CLI",
      "feat.cli.p": "<code>film-cli</code> runs the same density engine for scripting and batch inversion.",
      "how.kicker": "How it works",
      "how.h2": "Density first, aesthetics second.",
      "step1.h3": "Decode",
      "step1.p": "Your RAF/DNG/TIFF scan is decoded to linear RGB — the light the scanner actually measured through the film.",
      "step2.h3": "Invert in density",
      "step2.p": "Restore each channel's density relative to the measured film base, anchored to the roll's density range, then print back to a positive (Kodak Cineon). Density is linear in dye; transmittance isn't — so this is where naive flips go wrong.",
      "step3.h3": "Develop",
      "step3.p": "Apply creative finishing — curves, color, exposure — on a faithful base. Export, or batch the whole roll.",
      "shots.kicker": "Screenshots",
      "shots.h2": "See it in action.",
      "dl.kicker": "Download",
      "dl.h2": "Get OpenEnlarge",
      "dl.lede": "Free and open source. macOS, Windows & Linux.",
      "dl.base": "↓ Download",
      "dl.os.macos": "Download for macOS",
      "dl.os.windows": "Download for Windows",
      "dl.os.linux": "Download for Linux"
    },
    zh: {
      "meta.title": "OpenEnlarge — 开源胶片扫描编辑",
      "meta.desc": "OpenEnlarge 是一款免费、开源的软件，将暗房搬到你的桌面。它不是简单地反转颜色，而是依据 Beer-Lambert 光密度模型，模拟胶片与相纸真实的化学过程，从而真实地反相扫描件，并在一套流畅高效的工作流中完成编辑。",
      "nav.features": "功能",
      "nav.how": "原理",
      "nav.download": "下载",
      "nav.cta": "下载",
      "hero.eyebrow": "◆ 开源 · 密度域反转",
      "hero.h1": "开源<br><span class=\"grad\">胶片扫描编辑</span>",
      "hero.lede": "OpenEnlarge 是一款免费、开源的软件，将暗房搬到你的桌面。它不是简单地反转颜色，而是依据 Beer-Lambert 光密度模型，模拟胶片与相纸真实的化学过程，从而真实地反相扫描件，并在一套流畅高效的工作流中完成编辑。",
      "hero.dl": "↓ 下载",
      "hero.star": "★ 在 GitHub 加星",
      "hero.metaLine": "免费 · MIT 许可 · macOS、Windows 和 Linux",
      "card.label": "密度反转",
      "features.kicker": "功能",
      "features.h2": "桌面上的真实暗房。",
      "feat.density.h3": "Cineon 密度反转",
      "feat.density.p": "基于物理的比尔-朗伯引擎（Kodak Cineon / negadoctor）在密度域中反转，以实测的片基为基准——而非翻转曲线。",
      "feat.decode.h3": "RAW、TIFF、JPEG 与 PNG",
      "feat.decode.p": "支持富士 RAF、松下 RW2、尼康 NEF、索尼 ARW、佳能 CR3、哈苏 3FR 与 DNG，以及 16 位 TIFF、JPEG 和 PNG——统一解码为线性 RGB。",
      "feat.tether.h3": "联机拍摄",
      "feat.tether.p": "监视文件夹，新扫描一落地即自动导入并冲洗——成片随拍随现。",
      "feat.base.h3": "自动片基检测",
      "feat.base.p": "自动找到橙色片基的齿孔边并采样为一个连贯的清片颜色，按整卷锁定。在裁剪区域内测量，因此相机翻拍不会过曝褪色——可随时重新校准或拾取中性灰。",
      "feat.develop.h3": "完整的冲洗控制",
      "feat.develop.p": "色调曲线、调色、色轮、曝光、黑点与伽马——实时调整。",
      "feat.crop.h3": "裁剪与批量导出",
      "feat.crop.p": "借助实时直方图拉直、裁剪和旋转，然后批量导出为 16 位 TIFF、PNG 或 JPEG——可对整卷应用同一裁剪。",
      "feat.hdr.h3": "HDR 预览与导出",
      "feat.hdr.p": "一键将任意一帧切换为真正的 HDR——在支持 HDR 的显示器上高光会亮过纯白——并导出为与预览一致的增益图 HDR JPEG。实验性功能。",
      "feat.cli.h3": "无界面命令行",
      "feat.cli.p": "<code>film-cli</code> 使用相同的密度引擎，用于脚本化和批量反转。",
      "how.kicker": "原理",
      "how.h2": "先密度，后美学。",
      "step1.h3": "解码",
      "step1.p": "你的 RAF/DNG/TIFF 扫描被解码为线性 RGB——即扫描仪透过胶片真正测得的光。",
      "step2.h3": "在密度域反转",
      "step2.p": "以实测片基为基准还原每个通道的密度，并按整卷的密度范围归一，再印回正片（Kodak Cineon）。密度与染料浓度成线性，而透射率不是——简单翻转正是在这里出错。",
      "step3.h3": "冲洗",
      "step3.p": "在忠实的基础上进行创意修饰——曲线、色彩、曝光。导出，或批量处理整卷。",
      "shots.kicker": "截图",
      "shots.h2": "实际效果。",
      "dl.kicker": "下载",
      "dl.h2": "获取 OpenEnlarge",
      "dl.lede": "免费且开源。支持 macOS、Windows 和 Linux。",
      "dl.base": "↓ 下载",
      "dl.os.macos": "下载 macOS 版",
      "dl.os.windows": "下载 Windows 版",
      "dl.os.linux": "下载 Linux 版"
    }
  };

  var locale = "en";

  function detect() {
    try {
      var saved = localStorage.getItem("oe_locale");
      if (saved === "en" || saved === "zh") return saved;
    } catch (e) { /* localStorage may be blocked */ }
    var nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    return nav.indexOf("zh") === 0 ? "zh" : "en";
  }

  function t(key) {
    return (STRINGS[locale] && STRINGS[locale][key]) || STRINGS.en[key] || key;
  }

  function apply() {
    document.documentElement.lang = locale === "zh" ? "zh-Hans" : "en";
    document.title = t("meta.title");
    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", t("meta.desc"));

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });

    var toggle = document.getElementById("lang-toggle");
    if (toggle) toggle.textContent = locale === "zh" ? "EN" : "中文";

    window.dispatchEvent(new CustomEvent("oe-locale", { detail: locale }));
  }

  function set(next) {
    locale = next === "zh" ? "zh" : "en";
    try { localStorage.setItem("oe_locale", locale); } catch (e) { /* ignore */ }
    apply();
  }

  function init() {
    locale = detect();
    var toggle = document.getElementById("lang-toggle");
    if (toggle) toggle.addEventListener("click", function () {
      set(locale === "zh" ? "en" : "zh");
    });
    apply();
  }

  init();

  return {
    t: t,
    set: set,
    get locale() { return locale; }
  };
})();
