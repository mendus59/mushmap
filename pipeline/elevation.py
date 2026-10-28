"""Elevation from the free AWS Terrain Tiles (Terrarium PNG encoding, no key, no rate limit).

Open-Meteo's elevation API counts every coordinate against a 10,000-a-day limit, too few for the
~88,000-cell grid, so we sample the DEM tiles directly instead.
"""
from __future__ import annotations

import io
import math

from PIL import Image

from common import http_bytes

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM = 10  # about 110 m per pixel at 45° N
TILE_PX = 256


def tile_position(lat: float, lon: float, zoom: int = ZOOM) -> tuple[int, int, int, int]:
    """Web Mercator tile x, y and the pixel within it."""
    n = 2 ** zoom
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n
    tx, ty = int(x), int(y)
    return tx, ty, min(TILE_PX - 1, int((x - tx) * TILE_PX)), min(TILE_PX - 1, int((y - ty) * TILE_PX))


def decode_terrarium(r: int, g: int, b: int) -> float:
    return r * 256 + g + b / 256 - 32768


class TileSampler:
    def __init__(self, zoom: int = ZOOM, max_tiles: int | None = None) -> None:
        self.zoom = zoom
        self.max_tiles = max_tiles  # oldest tiles are dropped past this, to bound memory
        self.tiles: dict[tuple[int, int], Image.Image] = {}
        self.loaded = 0

    def tile(self, x: int, y: int) -> Image.Image:
        key = (x, y)
        if key not in self.tiles:
            data = http_bytes(TILE_URL.format(z=self.zoom, x=x, y=y))
            if self.max_tiles is not None and len(self.tiles) >= self.max_tiles:
                del self.tiles[next(iter(self.tiles))]
            self.tiles[key] = Image.open(io.BytesIO(data)).convert("RGB")
            self.loaded += 1
            if self.loaded % 100 == 0:
                print(f"  elevation tiles loaded: {self.loaded}")
        return self.tiles[key]

    def elevation(self, lat: float, lon: float) -> int:
        tx, ty, px, py = tile_position(lat, lon, self.zoom)
        return round(decode_terrarium(*self.tile(tx, ty).getpixel((px, py))))


_sampler = TileSampler()


def elevations(points: list[tuple[float, float]]) -> list[float | None]:
    """Metres above sea level for each (lat, lon), in order."""
    return [_sampler.elevation(lat, lon) for lat, lon in points]
