import sys, pathlib, unittest
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import importlib
# import the hyphenated module by file
import importlib.util
spec = importlib.util.spec_from_file_location("gen_docs", ROOT / "scripts" / "gen-docs.py")
gen = importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)

class TestBuild(unittest.TestCase):
    def setUp(self):
        gen.build()
    def test_index_pages_exist(self):
        en = ROOT / "web/docs/index.html"
        zh = ROOT / "web/docs/zh/index.html"
        self.assertTrue(en.exists(), "EN index missing")
        self.assertTrue(zh.exists(), "ZH index missing")
    def test_autogen_banner(self):
        html = (ROOT / "web/docs/index.html").read_text()
        self.assertIn("AUTO-GENERATED", html)
    def test_title_present(self):
        html = (ROOT / "web/docs/index.html").read_text()
        self.assertIn("OpenEnlarge", html)

class TestLayout(unittest.TestCase):
    def setUp(self): gen.build()
    def test_css_emitted(self):
        self.assertTrue((ROOT / "web/docs/docs.css").exists())
    def test_one_h1(self):
        html = (ROOT / "web/docs/index.html").read_text()
        self.assertEqual(html.count("<h1>"), 1)
    def test_sidebar_links_real_anchors(self):
        html = (ROOT / "web/docs/index.html").read_text()
        self.assertIn('class="sidebar"', html)
        self.assertIn("Overview", html)
    def test_canonical_and_hreflang(self):
        html = (ROOT / "web/docs/index.html").read_text()
        self.assertIn('rel="canonical" href="https://openenlarge.io/docs/index.html"', html)
        self.assertIn('hreflang="zh-Hans"', html)
        self.assertIn('hreflang="x-default"', html)
    def test_css_uses_tokens(self):
        css = (ROOT / "web/docs/docs.css").read_text()
        self.assertIn("#0a0a0c", css)
        self.assertIn("#f49d4e", css)

class TestJs(unittest.TestCase):
    def setUp(self): gen.build()
    def test_js_emitted(self):
        self.assertTrue((ROOT / "web/docs/docs.js").exists())
    def test_js_builds_toc(self):
        js = (ROOT / "web/docs/docs.js").read_text()
        self.assertIn("toc-list", js)
        self.assertIn("menu-btn", js)

class TestSeo(unittest.TestCase):
    def setUp(self): gen.build()
    def test_sitemap(self):
        sm = (ROOT / "web/docs/sitemap.xml").read_text()
        self.assertIn("<urlset", sm)
        self.assertIn("https://openenlarge.io/docs/index.html", sm)
        self.assertIn('hreflang="zh-Hans"', sm)
    def test_robots(self):
        rb = (ROOT / "web/docs/robots.txt").read_text()
        self.assertIn("Sitemap: https://openenlarge.io/docs/sitemap.xml", rb)
    def test_jsonld_on_every_page(self):
        import glob
        for f in glob.glob(str(ROOT / "web/docs/**/*.html"), recursive=True):
            html = open(f).read()
            self.assertIn('application/ld+json', html, f)
            self.assertIn('property="og:title"', html, f)
    def test_zh_lang_attr(self):
        html = (ROOT / "web/docs/zh/index.html").read_text()
        self.assertIn('<html lang="zh-Hans">', html)

class TestScienceNegatives(unittest.TestCase):
    def setUp(self): gen.build()
    def test_page_built_both_locales(self):
        self.assertTrue((ROOT / "web/docs/science/negatives.html").exists())
        self.assertTrue((ROOT / "web/docs/zh/science/negatives.html").exists())
    def test_figure_inlined(self):
        for p in ("web/docs/science/negatives.html", "web/docs/zh/science/negatives.html"):
            html = (ROOT / p).read_text()
            self.assertIn("<svg", html, p)            # figure inlined, not a comment
            self.assertNotIn("<!--FIG:", html, p)     # placeholder fully replaced
    def test_hood_block(self):
        for p in ("web/docs/science/negatives.html", "web/docs/zh/science/negatives.html"):
            html = (ROOT / p).read_text()
            self.assertIn('class="hood"', html, p)
            self.assertIn("log₁₀", html, p)

if __name__ == "__main__":
    unittest.main()
