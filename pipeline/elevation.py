"""Elevation lookups from the Open-Meteo elevation API (free, no key, 90 m Copernicus DEM)."""
from __future__ import annotations

import time

from common import http_json

API = "https://api.open-meteo.com/v1/elevation"
BATCH = 100  # API maximum coordinates per request


def elevations(points: list[tuple[float, float]]) -> list[float | None]:
    """Metres above sea level for each (lat, lon), in order."""
    out: list[float | None] = []
    for start in range(0, len(points), BATCH):
        chunk = points[start:start + BATCH]
        body = http_json(API, {
            "latitude": ",".join(f"{lat:.5f}" for lat, _ in chunk),
            "longitude": ",".join(f"{lon:.5f}" for _, lon in chunk),
        })
        values = body.get("elevation", [])
        if len(values) != len(chunk):
            raise RuntimeError(f"Open-Meteo returned {len(values)} elevations for {len(chunk)} points")
        out.extend(round(v) if isinstance(v, (int, float)) and v == v else None for v in values)
        if start // BATCH % 50 == 49:
            print(f"  elevations: {start + len(chunk)}/{len(points)}")
        time.sleep(0.25)
    return out
