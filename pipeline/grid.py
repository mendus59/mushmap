"""The H3 grid over the regions the heat map covers, with an elevation per cell."""
from __future__ import annotations

import io
import zipfile

import h3
import shapefile
from shapely.geometry import shape
from shapely.ops import unary_union

from common import http_bytes
from elevation import elevations

RESOLUTION = 7  # about 5.2 km² per cell
# Census cartographic boundaries are clipped to the shoreline, so Puget Sound and the ocean stay out.
STATES_URL = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_5m.zip"
REGION_STATES = {"53": "Washington", "41": "Oregon"}


def region_shape():
    archive = zipfile.ZipFile(io.BytesIO(http_bytes(STATES_URL)))
    names = archive.namelist()
    stem = next(n[:-4] for n in names if n.endswith(".shp"))
    reader = shapefile.Reader(
        shp=io.BytesIO(archive.read(stem + ".shp")),
        shx=io.BytesIO(archive.read(stem + ".shx")),
        dbf=io.BytesIO(archive.read(stem + ".dbf")),
    )
    field_names = [f[0] for f in reader.fields[1:]]
    shapes = []
    for rec in reader.iterShapeRecords():
        attrs = dict(zip(field_names, rec.record))
        if attrs["STATEFP"] in REGION_STATES:
            shapes.append(shape(rec.shape.__geo_interface__))
    if len(shapes) != len(REGION_STATES):
        raise RuntimeError(f"Expected {len(REGION_STATES)} states, found {len(shapes)}")
    return unary_union(shapes)


def cells_for(geometry, resolution: int = RESOLUTION) -> list[str]:
    return sorted(h3.geo_to_cells(geometry, resolution))


def build_grid() -> dict:
    cells = cells_for(region_shape())
    print(f"grid: {len(cells)} cells at resolution {RESOLUTION}")
    centers = [h3.cell_to_latlng(c) for c in cells]
    elev = elevations(centers)
    return {"res": RESOLUTION, "states": list(REGION_STATES.values()), "cells": cells, "elev": elev}
