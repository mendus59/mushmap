"""Host-tree basal area per grid cell from the USDA Forest Service tree species maps.

Source: Wilson et al. 2013, "Live tree species basal area of the contiguous United States (2000-2009)",
doi:10.2737/RDS-2013-0013. One ERDAS .img raster per FIA species code (Data/RasterMaps/s<code>.img),
250 m pixels, live tree basal area in square feet per acre. The rasters ship in four zip archives by
species-code range, about 3 GB in all, so this runs once and the result is kept on the data branch.
"""
from __future__ import annotations

import re
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import h3
import numpy as np
import rasterio
from rasterio.warp import transform as warp_transform

from common import USER_AGENT

BASE_URL = "https://www.fs.usda.gov/rds/archive/products/RDS-2013-0013/"
ARCHIVES = [
    (10, 350, "RDS-2013-0013_RasterMaps_s10-s350.zip"),
    (351, 600, "RDS-2013-0013_RasterMaps_s351-s600.zip"),
    (601, 825, "RDS-2013-0013_RasterMaps_s601-s825.zip"),
    (826, 999, "RDS-2013-0013_RasterMaps_s826-s999.zip"),
]
# Each cell's value is the mean over its resolution 9 children (49 points, about 0.1 km² apart),
# so one 250 m pixel at the cell centre does not decide it.
SAMPLE_RES = 9


def archive_for(code: int) -> str:
    for lo, hi, name in ARCHIVES:
        if lo <= code <= hi:
            return name
    raise ValueError(f"No archive covers FIA species code {code}")


def download(name: str, dest: Path) -> Path:
    path = dest / name
    if not path.exists():
        print(f"  downloading {name}")
        req = urllib.request.Request(BASE_URL + name, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=600) as resp, open(path, "wb") as out:
            shutil.copyfileobj(resp, out, length=1 << 20)
    return path


def extract_species(archive: Path, code: int, dest: Path) -> Path:
    """Extract s<code>.img and its sidecars (.ige, .rrd, .aux.xml) and return the .img path."""
    pattern = re.compile(rf"(^|/)s{code}\.(img|ige|rrd|rde|aux\.xml|xml)$", re.IGNORECASE)
    with zipfile.ZipFile(archive) as zf:
        members = [m for m in zf.namelist() if pattern.search(m.replace("\\", "/"))]
        if not members:
            sample = ", ".join(zf.namelist()[:10])
            raise FileNotFoundError(f"s{code}.img not in {archive.name} (first entries: {sample})")
        for m in members:
            zf.extract(m, dest)
    img = next(m for m in members if m.lower().endswith(".img"))
    return dest / img


def sample_points(cells: list[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Latitudes, longitudes and owning cell index of every sample point."""
    lats, lons, owners = [], [], []
    for i, cell in enumerate(cells):
        for child in h3.cell_to_children(cell, SAMPLE_RES):
            lat, lon = h3.cell_to_latlng(child)
            lats.append(lat)
            lons.append(lon)
            owners.append(i)
    return np.array(lats), np.array(lons), np.array(owners)


def cell_means(raster_path: Path, lats: np.ndarray, lons: np.ndarray, owners: np.ndarray, n_cells: int) -> np.ndarray:
    """Mean raster value per cell; nodata and pixels off the raster count as zero basal area."""
    with rasterio.open(raster_path) as ds:
        xs, ys = warp_transform("EPSG:4326", ds.crs, lons.tolist(), lats.tolist())
        rows, cols = rasterio.transform.rowcol(ds.transform, xs, ys)
        rows, cols = np.asarray(rows), np.asarray(cols)
        r0, r1 = max(rows.min(), 0), min(rows.max() + 1, ds.height)
        c0, c1 = max(cols.min(), 0), min(cols.max() + 1, ds.width)
        window = rasterio.windows.Window(c0, r0, c1 - c0, r1 - r0)
        data = ds.read(1, window=window, masked=True).filled(0).astype(np.float64)
    inside = (rows >= r0) & (rows < r1) & (cols >= c0) & (cols < c1)
    values = np.zeros(len(rows))
    values[inside] = data[rows[inside] - r0, cols[inside] - c0]
    values[~np.isfinite(values) | (values < 0)] = 0
    sums = np.bincount(owners, weights=values, minlength=n_cells)
    counts = np.bincount(owners, minlength=n_cells)
    return sums / np.maximum(counts, 1)


def build_hosts(
    cells: list[str], codes: list[int], existing: dict[str, list[float]] | None = None, save=None,
) -> dict[str, list[float]]:
    """Basal area (ft²/acre, one decimal) per cell for each FIA species code, keyed by the code as text.

    save(result) is called after each archive, so a failed download keeps the species already done.
    """
    out = dict(existing or {})
    missing = sorted({c for c in codes if str(c) not in out})
    if not missing:
        return out
    print(f"host trees: building {len(missing)} species for {len(cells)} cells")
    lats, lons, owners = sample_points(cells)
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        by_archive: dict[str, list[int]] = {}
        for code in missing:
            by_archive.setdefault(archive_for(code), []).append(code)
        for name, archive_codes in by_archive.items():
            archive = download(name, tmpdir)
            for code in archive_codes:
                try:
                    img = extract_species(archive, code, tmpdir / f"s{code}")
                except FileNotFoundError as err:
                    # Not every FIA species has a map (e.g. Oregon white oak, 815). Store it as empty
                    # so later runs do not download the archive again for it.
                    print(f"  skipping s{code}: {err}")
                    out[str(code)] = []
                    continue
                means = cell_means(img, lats, lons, owners, len(cells))
                out[str(code)] = [round(float(v), 1) for v in means]
                print(f"  s{code}: {np.count_nonzero(means > 1)} cells over 1 ft²/acre, max {means.max():.0f}")
                shutil.rmtree(tmpdir / f"s{code}")
            archive.unlink()  # free disk before the next ~800 MB archive
            if save:
                save(out)
    return out


def host_score(hosts: dict[str, list[float]], host_trees: list[dict], n_cells: int, half_ba: float) -> np.ndarray:
    """0..1 per cell: weighted host basal area, saturating (half_ba ft²/acre of weighted host gives 0.5)."""
    total = np.zeros(n_cells)
    for t in host_trees:
        values = hosts.get(str(t["fia"]))
        if values:  # missing, or [] for a species without a map
            total += t["weight"] * np.asarray(values)
    return 1 - np.exp(-total * np.log(2) / half_ba)
