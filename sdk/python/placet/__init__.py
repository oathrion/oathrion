"""Former name of Oathrion's Python SDK. Use ``import oathrion``.

The module was renamed with the product (Placet -> Oathrion, October 2026). Code that still
says ``import placet`` or ``from placet import OathrionClient`` keeps working, with a
``DeprecationWarning``; this alias will be removed at an announced major version. The legacy
class names (``PlacetClient``, ``PlacetError``, …) are re-exported by ``oathrion`` itself.
"""

import warnings

warnings.warn(
    "The `placet` module is now `oathrion`: replace `import placet` with `import oathrion`. "
    "The old name will be removed at a future major version.",
    DeprecationWarning,
    stacklevel=2,
)

from oathrion import *  # noqa: E402,F401,F403
from oathrion import __all__, __version__  # noqa: E402,F401
