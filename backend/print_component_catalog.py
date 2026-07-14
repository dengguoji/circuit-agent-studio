from __future__ import annotations

import json

from component_registry import get_component_catalog


if __name__ == "__main__":
    print(json.dumps(get_component_catalog(), ensure_ascii=False, indent=2))
