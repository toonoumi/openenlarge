import json, pathlib, unittest
ROOT = pathlib.Path(__file__).resolve().parent.parent

class TestStringsSchema(unittest.TestCase):
    def test_all_locales_same_keys(self):
        data = json.loads((ROOT / "web/landing-strings.json").read_text())
        self.assertEqual(set(data.keys()), {"en", "zh", "ja", "ko"})
        base = set(data["en"].keys())
        for lc in ("zh", "ja", "ko"):
            self.assertEqual(set(data[lc].keys()), base, f"{lc} key set differs from en")

if __name__ == "__main__":
    unittest.main()
