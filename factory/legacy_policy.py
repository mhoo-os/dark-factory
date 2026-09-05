#!/usr/bin/env python3
"""Fail closed before a legacy runner can merge or deploy an active registry target."""
from __future__ import annotations

import argparse

from factory.factory_registry import RegistryError, assert_human_only_legacy_operation


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("merge", "deploy"))
    parser.add_argument("--repository", required=True)
    args = parser.parse_args()
    try:
        assert_human_only_legacy_operation(args.repository)
    except RegistryError as error:
        print(f"{args.operation.upper()}_REFUSED: {error}")
        return 78
    print(f"{args.operation.upper()}_HUMAN_HANDOFF_REQUIRED repository={args.repository}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
