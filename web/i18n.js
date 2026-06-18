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
      "nav.roadmap": "Roadmap",
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
      "feat.autopos.h3": "Negative & positive, auto",
      "feat.autopos.p": "Every frame is classified on develop — negatives are inverted, positives pass through untouched. One click overrides either way. Pin D_max precisely by clicking a clear-leader patch in the live viewport.",
      "feat.decode.h3": "RAW, TIFF, JPEG & PNG",
      "feat.decode.p": "Fuji RAF, Panasonic RW2, Nikon NEF, Sony ARW, Canon CR3, Hasselblad 3FR and DNG, plus 16-bit TIFF, JPEG and PNG — decoded to linear RGB.",
      "feat.tether.h3": "Tethered shooting",
      "feat.tether.p": "Watch a folder and auto-import + develop new scans as they land — finished positives appear as you shoot.",
      "feat.base.h3": "Automatic film-base detection",
      "feat.base.p": "Finds the orange-mask rebate and samples it as one coherent clear-film color, locked per roll. Measured inside your crop, so camera scans don't wash out — recalibrate or pick a neutral anytime.",
      "feat.develop.h3": "Full develop controls",
      "feat.develop.p": "Tonal curves, color grading, color wheels, exposure, black point and gamma — live. Copy and paste tone & color between frames.",
      "feat.tonematch.h3": "Tone Matching",
      "feat.tonematch.p": "Match the toning of a frame to any reference image, with an adjustable strength — borrow the mood of a look you love.",
      "feat.aienhance.h3": "AI Enhance",
      "feat.aienhance.p": "One-click enhancement powered by OpenAI (gpt-image-2). Bring your own API key in Settings and enhance straight from the toolbar.",
      "feat.upscale.h3": "Upscale to 4K / 8K",
      "feat.upscale.p": "On-device upscaling with a tiled ONNX engine — models download on demand, no cloud round-trip. Standalone, or as a finishing pass on a developed frame.",
      "feat.dust.h3": "AI Dust & Hair Removal",
      "feat.dust.p": "Automatic defect detection plus MI-GAN inpainting — or paint a mask with the AI-fill eraser and apply a single, undoable AI erase.",
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
      "road.kicker": "Roadmap",
      "road.h2": "What's coming next.",
      "road.next": "NEXT",
      "road.more": "MORE",
      "road.import.h3": "Import Roll",
      "road.import.p": "Bring in a folder of scans as one roll that shares a single film-base calibration and density range across every frame — so a whole roll develops consistently.",
      "road.hdr.h3": "Improve HDR",
      "road.hdr.p": "Graduate HDR out of experimental: edit into the HDR headroom with the develop sliders, widen export beyond gain-map JPEG, and verify across more displays.",
      "road.vote.h3": "Shape what's next",
      "road.vote.p": "This is a living roadmap. See <a href=\"https://github.com/mohaelder/openenlarge/blob/main/ROADMAP.md\">ROADMAP.md</a> or <a href=\"https://github.com/mohaelder/openenlarge/issues/new\">open an issue</a> — what you ask for shapes what gets built.",
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
      "nav.roadmap": "路线图",
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
      "feat.autopos.h3": "负片正片，自动识别",
      "feat.autopos.p": "冲洗时自动判别每一帧——负片反相，正片原样保留，一键即可手动切换。在实时画面中点击片头清片即可精确锚定 D_max。",
      "feat.decode.h3": "RAW、TIFF、JPEG 与 PNG",
      "feat.decode.p": "支持富士 RAF、松下 RW2、尼康 NEF、索尼 ARW、佳能 CR3、哈苏 3FR 与 DNG，以及 16 位 TIFF、JPEG 和 PNG——统一解码为线性 RGB。",
      "feat.tether.h3": "联机拍摄",
      "feat.tether.p": "监视文件夹，新扫描一落地即自动导入并冲洗——成片随拍随现。",
      "feat.base.h3": "自动片基检测",
      "feat.base.p": "自动找到橙色片基的齿孔边并采样为一个连贯的清片颜色，按整卷锁定。在裁剪区域内测量，因此相机翻拍不会过曝褪色——可随时重新校准或拾取中性灰。",
      "feat.develop.h3": "完整的冲洗控制",
      "feat.develop.p": "色调曲线、调色、色轮、曝光、黑点与伽马——实时调整。可在不同帧之间复制粘贴色调与色彩设置。",
      "feat.tonematch.h3": "色调匹配",
      "feat.tonematch.p": "将一帧的色调匹配到任意参考图像，强度可调——轻松借用你钟爱的影调。",
      "feat.aienhance.h3": "AI 增强",
      "feat.aienhance.p": "由 OpenAI（gpt-image-2）驱动的一键增强。在设置中填入你自己的 API 密钥，即可在工具栏直接增强。",
      "feat.upscale.h3": "放大至 4K / 8K",
      "feat.upscale.p": "采用分块 ONNX 引擎的本地放大——模型按需下载，无需云端往返。可独立使用，也可作为成片的收尾处理。",
      "feat.dust.h3": "AI 去尘除发",
      "feat.dust.p": "自动检测瑕疵并用 MI-GAN 修复——或用 AI 填充橡皮擦涂抹蒙版，一次性应用可撤销的 AI 擦除。",
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
      "road.kicker": "路线图",
      "road.h2": "接下来要做什么。",
      "road.next": "下一步",
      "road.more": "更多",
      "road.import.h3": "整卷导入",
      "road.import.p": "将一个文件夹的扫描件作为一整卷导入，让所有帧共享同一份片基校准和密度范围——这样整卷都能一致地冲洗。",
      "road.hdr.h3": "改进 HDR",
      "road.hdr.p": "让 HDR 走出实验阶段：用冲洗滑块直接编辑到 HDR 高光余量，扩展超出增益图 JPEG 的导出格式，并在更多显示器上验证。",
      "road.vote.h3": "参与决定下一步",
      "road.vote.p": "这是一份持续更新的路线图。查看 <a href=\"https://github.com/mohaelder/openenlarge/blob/main/ROADMAP.md\">ROADMAP.md</a> 或 <a href=\"https://github.com/mohaelder/openenlarge/issues/new\">提交 issue</a>——你的需求将决定下一步开发什么。",
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
