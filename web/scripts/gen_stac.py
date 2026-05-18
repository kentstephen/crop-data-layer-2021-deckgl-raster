# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "planetary-computer",
#     "pystac-client",
# ]
# ///
"""Fetch CDL STAC items from MPC and write a minimal SAS-signed JSON.

Output is consumed by web/src/App.tsx. Re-run when SAS tokens expire
(~1 hour after generation) — the browser will start 403'ing tile requests.

Usage:
    uv run web/scripts/gen_stac.py [--bbox W S E N] [--year Y]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import planetary_computer
import pystac_client

OUT = Path(__file__).resolve().parent.parent / "src" / "minimal_stac.json"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        default=[-125.0, 24.0, -66.0, 50.0],  # CONUS (lower 48)
        metavar=("W", "S", "E", "N"),
    )
    ap.add_argument("--year", type=int, default=2021)
    args = ap.parse_args()

    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )
    search = catalog.search(
        collections=["usda-cdl"],
        bbox=args.bbox,
        datetime=str(args.year),
        query={"usda_cdl:type": {"eq": "cropland"}},
    )
    items = list(search.items())

    fc = {
        "type": "FeatureCollection",
        "year": args.year,
        "features": [
            {
                "bbox": item.bbox,
                "assets": {"image": {"href": item.assets["cropland"].href}},
            }
            for item in items
        ],
    }
    OUT.write_text(json.dumps(fc))
    print(f"{len(items)} items -> {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
