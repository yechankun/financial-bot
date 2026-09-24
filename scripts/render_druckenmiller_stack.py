#!/usr/bin/env python3
"""
Render the Druckenmiller chart stack for one or more symbols across D/W/M.

Example:
    python3 render_druckenmiller_stack.py --symbols TSLA,EWY
"""

from __future__ import annotations

import argparse
import os
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable, List

SCRIPT_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = SCRIPT_DIR.parent
DEFAULT_RENDERER_DIR = PACKAGE_DIR / "renderer"
RENDERER_DIR = Path(os.environ.get("CHART_RENDERER_DIR", "").strip() or DEFAULT_RENDERER_DIR)
NODE_MODULES_DIR = RENDERER_DIR / "node_modules"
INSTALL_LOCK_DIR = RENDERER_DIR / ".install-lock"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbols", required=True, help="Comma-separated symbols, e.g. TSLA,EWY,GLD")
    parser.add_argument("--source", default="yahoo", help="Chart source passed to npm run render")
    parser.add_argument(
        "--timeframes",
        default="D,W,M",
        help="Comma-separated timeframes from D,W,M. Default: D,W,M",
    )
    parser.add_argument(
        "--out-root",
        default="outputs/druckenmiller-stack",
        help="Output root directory for rendered charts",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="Parallel render concurrency passed through to the renderer. Default: 4",
    )
    return parser.parse_args()


def parse_csv(raw: str) -> List[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def ensure_supported(timeframes: Iterable[str]) -> List[str]:
    ordered: List[str] = []
    for timeframe in timeframes:
        normalized = timeframe.upper()
        if normalized not in {"D", "W", "M"}:
            raise ValueError(f"unsupported timeframe: {timeframe}")
        ordered.append(normalized)
    return ordered


def ensure_renderer_ready() -> None:
    package_json = RENDERER_DIR / "package.json"
    tsx_bin = NODE_MODULES_DIR / ".bin" / "tsx"
    registry_json = RENDERER_DIR / ".pinets" / "registry.json"

    if not package_json.exists():
        raise SystemExit(f"error: renderer bundle is missing package.json: {package_json}")
    if not registry_json.exists():
        raise SystemExit(f"error: renderer bundle is missing registry.json: {registry_json}")
    if tsx_bin.exists():
        return

    while True:
        try:
            INSTALL_LOCK_DIR.mkdir()
            break
        except FileExistsError:
            if tsx_bin.exists():
                return
            time.sleep(0.25)

    try:
        if tsx_bin.exists():
            return
        install_cmd = ["npm", "install", "--silent", "--no-fund", "--no-audit"]
        subprocess.run(install_cmd, check=True, cwd=RENDERER_DIR)
    finally:
        INSTALL_LOCK_DIR.rmdir()


def main() -> int:
    args = parse_args()
    symbols = parse_csv(args.symbols)
    timeframes = ensure_supported(parse_csv(args.timeframes))
    out_root = Path(args.out_root)

    if not symbols:
        raise SystemExit("error: at least one symbol is required")

    ensure_renderer_ready()

    cmd = [
        "npm",
        "run",
        "render",
        "--",
        "--source",
        args.source,
        "--symbols",
        ",".join(symbols),
        "--timeframes",
        ",".join(timeframes),
        "--out-root",
        str(out_root),
        "--concurrency",
        str(max(1, args.concurrency)),
    ]
    subprocess.run(cmd, check=True, cwd=RENDERER_DIR)

    manifest_path = out_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in manifest.get("entries", []):
        chart_png = entry.get("pngPath") or entry.get("chart_png")
        if chart_png:
            print(chart_png)
    print(manifest_path.resolve())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"error: render failed with exit code {exc.returncode}", file=sys.stderr)
        raise SystemExit(exc.returncode)
