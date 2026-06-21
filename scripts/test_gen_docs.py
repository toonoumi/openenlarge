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

if __name__ == "__main__":
    unittest.main()
