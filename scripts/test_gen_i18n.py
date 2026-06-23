import sys, pathlib, importlib.util, unittest
ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("gen_i18n", ROOT / "scripts" / "gen-i18n.py")
gen = importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)

class TestLocaleColumns(unittest.TestCase):
    def test_locales_excludes_metadata(self):
        header = ["key", "en", "zh", "ja", "ko", "file", "note"]
        self.assertEqual(gen.locale_columns(header), ["en", "zh", "ja", "ko"])

    def test_locales_two_column_legacy(self):
        header = ["key", "en", "zh", "file", "note"]
        self.assertEqual(gen.locale_columns(header), ["en", "zh"])

if __name__ == "__main__":
    unittest.main()
