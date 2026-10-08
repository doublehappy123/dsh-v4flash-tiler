"""Standalone runner for the tiler engine tests (no pytest required)."""
from __future__ import annotations

import sys
import traceback

import test_tiler as t

TESTS = [name for name in dir(t) if name.startswith("test_")]
failed = 0
for name in sorted(TESTS):
    fn = getattr(t, name)
    try:
        fn()
        print(f"PASS {name}")
    except Exception:
        failed += 1
        print(f"FAIL {name}")
        traceback.print_exc()

print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
sys.exit(1 if failed else 0)
