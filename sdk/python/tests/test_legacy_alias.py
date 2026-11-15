"""The `placet` module is the deprecated alias of `oathrion` (rename of October 2026).

Existing code that says `import placet` must keep working, and must be told to move.
"""

import importlib
import sys
import unittest
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import oathrion  # noqa: E402


class LegacyAliasTest(unittest.TestCase):
    def setUp(self) -> None:
        for name in ("placet", "placet.client", "placet.errors"):
            sys.modules.pop(name, None)

    def test_import_placet_warns_and_gives_the_same_objects(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            placet = importlib.import_module("placet")
        self.assertTrue(any(issubclass(w.category, DeprecationWarning) and "oathrion" in str(w.message) for w in caught))
        self.assertIs(placet.OathrionClient, oathrion.OathrionClient)
        self.assertIs(placet.PlacetClient, oathrion.OathrionClient)
        self.assertIs(placet.PlacetNotAllowedError, oathrion.OathrionNotAllowedError)
        self.assertEqual(placet.__version__, oathrion.__version__)

    def test_submodules_keep_their_old_path(self) -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            client = importlib.import_module("placet.client")
            errors = importlib.import_module("placet.errors")
        self.assertIs(client.OathrionClient, oathrion.OathrionClient)
        self.assertIs(errors.OathrionError, oathrion.OathrionError)


if __name__ == "__main__":
    unittest.main()
