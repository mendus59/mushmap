"""Heat map model v1: when and at what elevation a species fruits, and where it has been found.

The browser combines the two per cell and week:
    score = seasonElev[week][elevation bin] * (HISTORY_FLOOR + (1 - HISTORY_FLOOR) * history[cell])
Host trees and weather join as further factors in later versions.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date

import h3

WEEKS = 53
ELEV_BIN_M = 50
ELEV_MAX_M = 4400  # Mount Rainier is 4392 m
ELEV_BINS = ELEV_MAX_M // ELEV_BIN_M + 1
WEEK_SIGMA = 1.5  # weeks
ELEV_SIGMA_M = 150.0
HISTORY_RINGS = 4  # about 10 km at resolution 7
HISTORY_SIGMA_RINGS = 1.5
HISTORY_SATURATION = 1.5  # sightings-worth of density that reads as "well known spot"
HISTORY_FLOOR = 0.25


def iso_week(day: str) -> int:
    """ISO week number, 1 to 53."""
    return date.fromisoformat(day).isocalendar()[1]


def elev_bin(metres: float) -> int:
    return max(0, min(ELEV_BINS - 1, round(metres / ELEV_BIN_M)))


def season_elevation(obs: list[tuple[int, float]]) -> list[list[int]]:
    """Smoothed density of sightings over (week, elevation), scaled to 0..100.

    Weeks wrap around the year end; elevation does not.
    """
    table = [[0.0] * ELEV_BINS for _ in range(WEEKS)]
    week_span = math.ceil(3 * WEEK_SIGMA)
    elev_span = math.ceil(3 * ELEV_SIGMA_M / ELEV_BIN_M)
    week_kernel = {d: math.exp(-d * d / (2 * WEEK_SIGMA ** 2)) for d in range(-week_span, week_span + 1)}
    elev_kernel = {
        d: math.exp(-((d * ELEV_BIN_M) ** 2) / (2 * ELEV_SIGMA_M ** 2)) for d in range(-elev_span, elev_span + 1)
    }
    for week, elev in obs:
        w0, e0 = week - 1, elev_bin(elev)
        for dw, kw in week_kernel.items():
            row = table[(w0 + dw) % WEEKS]
            for de, ke in elev_kernel.items():
                e = e0 + de
                if 0 <= e < ELEV_BINS:
                    row[e] += kw * ke
    peak = max((v for row in table for v in row), default=0.0)
    if peak == 0:
        return [[0] * ELEV_BINS for _ in range(WEEKS)]
    return [[round(100 * v / peak) for v in row] for row in table]


def history(obs_cells: list[str], cell_index: dict[str, int]) -> tuple[list[int], list[int]]:
    """Kernel density of past sightings over the grid, as sparse (cell index, 0..100) lists.

    Density saturates so one hot spot with hundreds of sightings does not drown out the rest.
    """
    raw: dict[int, float] = defaultdict(float)
    for cell in obs_cells:
        for ring in range(HISTORY_RINGS + 1):
            weight = math.exp(-ring * ring / (2 * HISTORY_SIGMA_RINGS ** 2))
            for c in h3.grid_ring(cell, ring) if ring else [cell]:
                idx = cell_index.get(c)
                if idx is not None:
                    raw[idx] += weight
    idxs, vals = [], []
    for idx in sorted(raw):
        v = round(100 * (1 - math.exp(-raw[idx] / HISTORY_SATURATION)))
        if v >= 1:
            idxs.append(idx)
            vals.append(v)
    return idxs, vals


def build_model(model_id: str, rows: list[list], cell_index: dict[str, int], resolution: int) -> dict:
    """rows: [id, observed_on, lat, lon, taxon, elevation]."""
    season_obs = [(iso_week(r[1]), r[5]) for r in rows if r[5] is not None]
    obs_cells = [h3.latlng_to_cell(r[2], r[3], resolution) for r in rows]
    hist_idx, hist_val = history(obs_cells, cell_index)
    return {
        "id": model_id,
        "count": len(rows),
        "elevBinM": ELEV_BIN_M,
        "historyFloor": HISTORY_FLOOR,
        "seasonElev": season_elevation(season_obs),
        "historyIdx": hist_idx,
        "historyVal": hist_val,
    }
