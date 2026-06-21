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

if __name__ == "__main__":
    unittest.main()
