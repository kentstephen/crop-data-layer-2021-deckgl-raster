# /// script
# requires-python = ">=3.12"
# dependencies = ["requests"]
# ///
"""Build a 256-entry CDL palette LUT from the Google Earth Engine STAC catalog.

Writes web/src/palette.json with:
  rgbaBase64: base64 of a flat (256*4) uint8 array — class index -> RGBA
  names:      { "1": "Corn", "5": "Soybeans", ... } — for picking v2

Class 0 ("Background") is forced to alpha=0 so the shader discards it.
Run once; only re-run when GEE updates the class table (rare).
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import requests

GEE_URL = "https://storage.googleapis.com/earthengine-stac/catalog/USDA/USDA_NASS_CDL.json"
OUT = Path(__file__).resolve().parent.parent / "src" / "palette.json"


def main() -> None:
    gee = requests.get(GEE_URL, timeout=30).json()
    classes = gee["summaries"]["eo:bands"][0]["gee:classes"]

    rgba = bytearray(256 * 4)  # all zeros -> alpha=0 -> transparent
    names: dict[str, str] = {}
    for c in classes:
        v = int(c["value"])
        if not (0 <= v <= 255):
            continue
        h = c["color"].lstrip("#")
        rgba[v * 4 + 0] = int(h[0:2], 16)
        rgba[v * 4 + 1] = int(h[2:4], 16)
        rgba[v * 4 + 2] = int(h[4:6], 16)
        rgba[v * 4 + 3] = 255
        names[str(v)] = c["description"]

    # Class 0 = "Background" -> transparent regardless of what GEE says.
    rgba[0:4] = b"\x00\x00\x00\x00"

    out = {
        "rgbaBase64": base64.b64encode(bytes(rgba)).decode(),
        "names": names,
    }
    OUT.write_text(json.dumps(out))
    print(f"{len(names)} classes -> {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
