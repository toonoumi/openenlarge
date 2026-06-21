// Tiny no-build i18n for the landing page.
// - Translatable text uses [data-i18n] (textContent) or [data-i18n-html] (innerHTML).
// - Initial locale: localStorage override, else browser language (zh* -> Chinese).
// - Exposes window.OE = { t, set, locale } and fires an 'oe-locale' event on change
//   so releases.js can re-localize the OS-aware download labels.
window.OE = (function () {
  var STRINGS = {
    en: {
      "meta.title": "OpenEnlarge — Open-source film scan editor",
      "meta.desc": "OpenEnlarge inverts film scans through real film-and-paper chemistry for authentic results in one fast workflow. Free and open source.",

      "nav.features": "Features",
      "nav.how": "How it works",
      "nav.roadmap": "Roadmap",
      "nav.download": "Download",
      "nav.blog": "Blog",
      "nav.docs": "Docs",
      "nav.cta": "Download",

      "blog.metaTitle": "Blog — OpenEnlarge",
      "blog.metaDesc": "Guides, technique, and updates on inverting film scans with OpenEnlarge.",
      "blog.eyebrow": "◆ Blog",
      "blog.h1": "From the darkroom.",
      "blog.lede": "Guides, technique, and updates on inverting film scans with OpenEnlarge.",

      "hero.eyebrow": "◆ Open source · density-domain",
      "hero.h1": "Open-source<br><span class=\"grad\">film scan editor.</span>",
      "hero.lede": "OpenEnlarge inverts film scans through real film-and-paper chemistry for authentic results in one fast workflow. Free and open source.",
      "hero.dl": "↓ Download",
      "hero.star": "★ Star on GitHub",
      "hero.metaLine": "Free · MIT licensed · macOS, Windows & Linux",

      "featured.label": "Appeared on",

      "quote.1": "“OpenEnlarge has the best designed film base color picker UI”",
      "quote.2": "“The color is really really legit.”",
      "quote.3": "“It's so much faster than LR.”",
      "quote.4": "“Finally an inversion that respects the actual film base.”",
      "quote.5": "“Batch-developed a whole roll in one pass. Unreal.”",
      "quote.6": "“Open source and it out-colors my paid tools.”",

      "features.kicker": "Workflow",
      "features.h2": "From scan to finished, in four steps.",

      "step.import.no": "01 · Import",
      "step.import.h3": "Bring in everything.",
      "step.import.p": "Import a folder of scans or tether straight to your scanner — new frames auto-develop the moment they land. If a camera can shoot it, OpenEnlarge can read it.",
      "step.develop.no": "02 · Develop",
      "step.develop.h3": "Edit the whole roll at once.",
      "step.develop.p": "Lay the roll out as an old-school contact sheet and push density, tone and color across every frame in one pass — one calibration, one look, the whole set developed together.",
      "step.tune.no": "03 · Fine-tune",
      "step.tune.h3": "Then perfect each frame.",
      "step.tune.p": "Drop into any single image with the full develop toolkit — curves, color and exposure live — plus a stack of AI tools to finish, clean and enlarge.",
      "step.export.no": "04 · Export",
      "step.export.h3": "Export, exactly how you need it.",
      "step.export.p": "Select the keepers and batch them out in one shot — pick a format, set quality, cap the file size, and apply a shared crop across the whole roll.",

      "tag.tether": "⊙ Tethered shooting",
      "tag.contact": "Contact sheet",
      "tag.wholeroll": "Whole-roll tone",
      "tag.density": "Shared density range",
      "tag.perroll": "Per-roll film base",
      "tag.rebate": "Print rebate",
      "tag.curves": "Tonal curves",
      "tag.wheels": "Color wheels",
      "tag.copylook": "Copy / paste look",
      "tag.tonematch": "Tone Matching",
      "tag.aienhance": "✦ AI Enhance",
      "tag.upscale": "✦ Upscale 4K / 8K",
      "tag.dust": "✦ AI Dust & Hair Removal",
      "tag.hdr": "HDR preview",
      "tag.quality": "Quality control",
      "tag.maxsize": "Max file size",
      "tag.batchcrop": "Batch crop",

      "how.kicker": "How it works",
      "how.h2": "Density first, aesthetics second.",
      "how.card.label": "Density inversion",
      "how.card.tag": "film-core",
      "how.1.h3": "Decode",
      "how.1.p": "Your scan is decoded to linear RGB — the light the scanner actually measured.",
      "how.2.h3": "Invert in density",
      "how.2.p": "Each channel's density is restored against the measured film base, then printed back to a positive — where naive flips go wrong.",
      "how.3.h3": "Develop",
      "how.3.p": "Creative finishing — curves, color, exposure — on a faithful base.",

      "gallery.kicker": "Gallery",
      "gallery.h2": "Created with OpenEnlarge.",

      "road.kicker": "Get involved",
      "road.h2": "Be part of what's next.",
      "road.sub": "Jump into Discord to swap scans and steer the build, open an issue with what you need, or read where it's all headed.",
      "road.discord": "Join Discord",
      "road.issue": "Open an issue",
      "road.roadmap": "Read ROADMAP.md",
      "road.github": "GitHub",

      "dl.kicker": "Download",
      "dl.h2": "Get OpenEnlarge",
      "dl.lede": "Free and open source. macOS, Windows & Linux.",
      "dl.base": "↓ Download",
      "dl.os.macos": "Download for macOS",
      "dl.os.windows": "Download for Windows",
      "dl.os.linux": "Download for Linux",
      "dl.alpha.kicker": "Testing builds",
      "dl.alpha.h2": "Try an alpha",
      "dl.alpha.lede": "Unstable pre-release builds for testing. Expect bugs.",
      "dl.alpha.base": "↓ Download alpha",
      "dl.alpha.os.macos": "↓ Download alpha for macOS",
      "dl.alpha.os.windows": "↓ Download alpha for Windows",
      "dl.alpha.os.linux": "↓ Download alpha for Linux",

      "footer.left": "© 2026 OpenEnlarge · <a href=\"https://github.com/mohaelder/openenlarge/blob/main/LICENSE\">MIT</a>",
      "footer.right": "<a href=\"https://github.com/mohaelder/openenlarge\">GitHub</a> · <a href=\"https://github.com/mohaelder/openenlarge/releases/latest\">Releases</a>"
    },
    zh: {
      "meta.title": "OpenEnlarge — 开源胶片扫描编辑",
      "meta.desc": "OpenEnlarge 依据胶片与相纸真实的化学过程反相胶片扫描件，在一套流畅高效的工作流中获得真实的成片。免费且开源。",

      "nav.features": "功能",
      "nav.how": "原理",
      "nav.roadmap": "路线图",
      "nav.download": "下载",
      "nav.blog": "博客",
      "nav.docs": "文档",
      "nav.cta": "下载",

      "blog.metaTitle": "博客 — OpenEnlarge",
      "blog.metaDesc": "关于使用 OpenEnlarge 反转胶片扫描件的指南、技巧与更新。",
      "blog.eyebrow": "◆ 博客",
      "blog.h1": "来自暗房。",
      "blog.lede": "关于使用 OpenEnlarge 反转胶片扫描件的指南、技巧与更新。",

      "hero.eyebrow": "◆ 开源 · 密度域反转",
      "hero.h1": "开源<br><span class=\"grad\">胶片扫描编辑</span>",
      "hero.lede": "OpenEnlarge 依据胶片与相纸真实的化学过程反相胶片扫描件，在一套流畅高效的工作流中获得真实的成片。免费且开源。",
      "hero.dl": "↓ 下载",
      "hero.star": "★ 在 GitHub 加星",
      "hero.metaLine": "免费 · MIT 许可 · macOS、Windows 和 Linux",

      "featured.label": "出现于",

      "quote.1": "“OpenEnlarge 的片基取色界面是设计得最好的。”",
      "quote.2": "“颜色真的非常地道。”",
      "quote.3": "“比 Lightroom 快太多了。”",
      "quote.4": "“终于有一款反相工具尊重真实的片基了。”",
      "quote.5": "“一次就批量冲洗了一整卷，太不真实了。”",
      "quote.6": "“开源工具，调色却胜过我花钱买的软件。”",

      "features.kicker": "工作流",
      "features.h2": "从扫描到成片，只需四步。",

      "step.import.no": "01 · 导入",
      "step.import.h3": "把素材全都带进来。",
      "step.import.p": "导入一个扫描文件夹，或直接联机你的扫描仪——新画面一落地便自动冲洗。只要相机能拍，OpenEnlarge 就能读。",
      "step.develop.no": "02 · 显影",
      "step.develop.h3": "一次性编辑整卷。",
      "step.develop.p": "把整卷像老式印样那样铺开，一次推动每一帧的密度、影调和色彩——一次校准、一套风格，整卷一起显影。",
      "step.tune.no": "03 · 精修",
      "step.tune.h3": "再逐帧精修。",
      "step.tune.p": "进入任意单张图像，使用完整的显影工具集——曲线、色彩与曝光实时可调——外加一整套用于收尾、清理和放大的 AI 工具。",
      "step.export.no": "04 · 导出",
      "step.export.h3": "完全按你的需要导出。",
      "step.export.p": "选出留用的片子并一次性批量导出——选择格式、设定质量、限制文件大小，并对整卷应用同一裁剪。",

      "tag.tether": "⊙ 联机拍摄",
      "tag.contact": "印样",
      "tag.wholeroll": "整卷影调",
      "tag.density": "共享密度范围",
      "tag.perroll": "整卷片基",
      "tag.rebate": "印边",
      "tag.curves": "色调曲线",
      "tag.wheels": "色轮",
      "tag.copylook": "复制 / 粘贴风格",
      "tag.tonematch": "色调匹配",
      "tag.aienhance": "✦ AI 增强",
      "tag.upscale": "✦ 放大至 4K / 8K",
      "tag.dust": "✦ AI 去尘除发",
      "tag.hdr": "HDR 预览",
      "tag.quality": "质量控制",
      "tag.maxsize": "最大文件大小",
      "tag.batchcrop": "批量裁剪",

      "how.kicker": "原理",
      "how.h2": "先密度，后美学。",
      "how.card.label": "密度反转",
      "how.card.tag": "胶片内核",
      "how.1.h3": "解码",
      "how.1.p": "你的扫描件被解码为线性 RGB——即扫描仪真正测得的光。",
      "how.2.h3": "在密度域反转",
      "how.2.p": "以实测片基为基准还原每个通道的密度，再印回正片——这正是简单翻转会出错的地方。",
      "how.3.h3": "显影",
      "how.3.p": "在忠实的基础上进行创意修饰——曲线、色彩、曝光。",

      "gallery.kicker": "作品",
      "gallery.h2": "由 OpenEnlarge 创作。",

      "road.kicker": "参与进来",
      "road.h2": "一起塑造下一步。",
      "road.sub": "加入 Discord 交流扫描件、引导开发方向，提交 issue 说出你的需求，或了解一切将走向何方。",
      "road.discord": "加入 Discord",
      "road.issue": "提交 issue",
      "road.roadmap": "查看 ROADMAP.md",
      "road.github": "GitHub",

      "dl.kicker": "下载",
      "dl.h2": "获取 OpenEnlarge",
      "dl.lede": "免费且开源。支持 macOS、Windows 和 Linux。",
      "dl.base": "↓ 下载",
      "dl.os.macos": "下载 macOS 版",
      "dl.os.windows": "下载 Windows 版",
      "dl.os.linux": "下载 Linux 版",
      "dl.alpha.kicker": "测试版",
      "dl.alpha.h2": "试用 Alpha 版",
      "dl.alpha.lede": "用于测试的不稳定预发布版本，可能存在问题。",
      "dl.alpha.base": "↓ 下载 Alpha 版",
      "dl.alpha.os.macos": "↓ 下载 macOS Alpha 版",
      "dl.alpha.os.windows": "↓ 下载 Windows Alpha 版",
      "dl.alpha.os.linux": "↓ 下载 Linux Alpha 版",

      "footer.left": "© 2026 OpenEnlarge · <a href=\"https://github.com/mohaelder/openenlarge/blob/main/LICENSE\">MIT</a>",
      "footer.right": "<a href=\"https://github.com/mohaelder/openenlarge\">GitHub</a> · <a href=\"https://github.com/mohaelder/openenlarge/releases/latest\">Releases</a>"
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
    // Per-page override: <html data-i18n-title="..." data-i18n-desc="...">; defaults to the home page keys.
    var ds = document.documentElement.dataset;
    document.title = t(ds.i18nTitle || "meta.title");
    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", t(ds.i18nDesc || "meta.desc"));

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
