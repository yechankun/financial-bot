#!/usr/bin/env python3
"""Read-only public CLI bridge for ETF data owned by financial-bot-internal."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]


def resolve_internal_script() -> Path:
    explicit = os.environ.get("ETF_INTERNAL_ROOT") or os.environ.get("INTERNAL_PROVIDER_PACKAGE")
    if explicit:
        location = (Path(explicit).expanduser() if Path(explicit).is_absolute()
                    or explicit.startswith(".") else ROOT / "node_modules" / explicit).resolve()
        if location.is_file():
            location = location.parent.parent if location.parent.name == "src" else location.parent
        candidates = [location]
    else:
        candidates = [ROOT.parent / "financial-bot-internal",
                      ROOT / "node_modules" / "financial-bot-internal"]
    for package_root in candidates:
        candidate = package_root / "scripts" / "etf_operate.py"
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError("financial-bot-internal ETF query CLI is unavailable")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default=os.environ.get("ETF_DIRECT_DATA_DIR")
                        or os.environ.get("BOT_DATA_DIR") or str(ROOT / "data"))
    commands = parser.add_subparsers(dest="command", required=True)
    query = commands.add_parser("query")
    for name in ("query", "share-class-id", "listing-hint", "as-of", "known-at",
                 "range-start", "range-end", "holdings-limit", "holdings-cursor", "sections"):
        query.add_argument(f"--{name}")
    commands.add_parser("status")
    arguments = parser.parse_args(argv)
    if arguments.command == "query" and not (arguments.query or arguments.share_class_id):
        parser.error("query requires --query or --share-class-id")

    command = [sys.executable, str(resolve_internal_script()), "--data-dir",
               str(Path(arguments.data_dir).expanduser().resolve()), "--read-only",
               arguments.command]
    if arguments.command == "query":
        for name in ("query", "share_class_id", "listing_hint", "as_of", "known_at",
                     "range_start", "range_end", "holdings_limit", "holdings_cursor", "sections"):
            value = getattr(arguments, name)
            if value is not None:
                command.extend([f"--{name.replace('_', '-')}", value])
    os.execve(sys.executable, command, os.environ.copy())


if __name__ == "__main__":
    try:
        main()
    except (FileNotFoundError, OSError) as error:
        print(f"ETF query failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
