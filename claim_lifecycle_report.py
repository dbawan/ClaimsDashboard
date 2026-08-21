#!/usr/bin/env python3
"""Recovered entry point for the original claim lifecycle report.

The source file was deleted accidentally, but its complete Python 3.13 bytecode
was still present in ``__pycache__``.  That artifact has been preserved beside
this file and is loaded here so the original command-line interface, report
logic, and importable helpers continue to work unchanged.
"""

from __future__ import annotations

import importlib.util
import sys
from importlib.machinery import SourcelessFileLoader
from pathlib import Path
from types import ModuleType


_RECOVERED_MODULE_NAME = "_claim_lifecycle_report_recovered"
_RECOVERED_BYTECODE = (
    Path(__file__).resolve().with_name(
        "claim_lifecycle_report_recovered.cpython-313.pyc"
    )
)


def _load_recovered_module() -> ModuleType:
    if not _RECOVERED_BYTECODE.is_file():
        raise RuntimeError(
            "The recovered claim lifecycle bytecode is missing: "
            f"{_RECOVERED_BYTECODE}"
        )

    loader = SourcelessFileLoader(
        _RECOVERED_MODULE_NAME,
        str(_RECOVERED_BYTECODE),
    )
    spec = importlib.util.spec_from_loader(_RECOVERED_MODULE_NAME, loader)
    if spec is None:
        raise RuntimeError("Could not create a loader for the recovered report")

    module = importlib.util.module_from_spec(spec)
    sys.modules[_RECOVERED_MODULE_NAME] = module
    try:
        loader.exec_module(module)
    except ImportError as exc:
        raise RuntimeError(
            "The recovered report requires Python 3.13, matching the version "
            "that created the preserved bytecode"
        ) from exc
    return module


_recovered = _load_recovered_module()

# Preserve the original module's public API for callers that imported helper
# functions or data classes directly from claim_lifecycle_report.
for _name, _value in vars(_recovered).items():
    if not _name.startswith("_"):
        globals().setdefault(_name, _value)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        eprint("Interrupted")
        raise SystemExit(130)
    except Exception as exc:
        eprint(f"ERROR: {exc}")
        raise SystemExit(1)
