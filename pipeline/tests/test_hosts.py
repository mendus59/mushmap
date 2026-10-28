import sys
import zipfile
from pathlib import Path

import h3
import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform as warp_transform

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import hosts  # noqa: E402
from model import build_model  # noqa: E402

CENTER = h3.latlng_to_cell(45.5, -122.6, 7)
CELLS = sorted(h3.grid_disk(CENTER, 3))


def write_raster(path: Path) -> None:
    """A 250 m Albers raster like the USFS maps: 120 ft²/acre west of -122.6, nothing east of it."""
    (cx,), (cy,) = warp_transform("EPSG:4326", "EPSG:5070", [-122.6], [45.5])
    size = 160  # 40 km square
    transform = from_origin(cx - size * 125, cy + size * 125, 250, 250)
    data = np.zeros((size, size), dtype=np.float32)
    rows, cols = np.mgrid[0:size, 0:size]
    xs, ys = rasterio.transform.xy(transform, rows.ravel(), cols.ravel())
    lons, _ = warp_transform("EPSG:5070", "EPSG:4326", xs, ys)
    data.ravel()[np.asarray(lons) < -122.6] = 120
    data[0, 0] = -1  # nodata
    with rasterio.open(path, "w", driver="HFA", width=size, height=size, count=1, dtype="float32",
                       crs="EPSG:5070", transform=transform, nodata=-1) as ds:
        ds.write(data, 1)


def test_archive_for():
    assert hosts.archive_for(202).endswith("s10-s350.zip")
    assert hosts.archive_for(815).endswith("s601-s825.zip")


def test_extract_and_cell_means(tmp_path):
    img = tmp_path / "s202.img"
    write_raster(img)
    archive = tmp_path / "maps.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.write(img, "Data/RasterMaps/s202.img")
        zf.writestr("Data/RasterMaps/s2020.img", b"not this one")
    extracted = hosts.extract_species(archive, 202, tmp_path / "out")
    assert extracted.name == "s202.img"

    lats, lons, owners = hosts.sample_points(CELLS)
    assert len(lats) == 49 * len(CELLS)
    means = hosts.cell_means(extracted, lats, lons, owners, len(CELLS))
    west = CELLS.index(min(CELLS, key=lambda c: h3.cell_to_latlng(c)[1]))
    east = CELLS.index(max(CELLS, key=lambda c: h3.cell_to_latlng(c)[1]))
    assert means[west] > 110
    assert means[east] < 10


def test_extract_reports_missing_species(tmp_path):
    archive = tmp_path / "maps.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("Data/RasterMaps/s17.img", b"")
    try:
        hosts.extract_species(archive, 202, tmp_path)
    except FileNotFoundError as err:
        assert "s17.img" in str(err)
    else:
        raise AssertionError("expected FileNotFoundError")


def test_build_hosts_only_fetches_missing_codes(tmp_path, monkeypatch):
    img = tmp_path / "src.img"
    write_raster(img)

    def fake_download(name, dest):
        path = dest / name
        with zipfile.ZipFile(path, "w") as zf:
            zf.write(img, "Data/RasterMaps/s202.img")
        return path

    monkeypatch.setattr(hosts, "download", fake_download)
    saved = []
    out = hosts.build_hosts(CELLS, [202, 17], {"17": [0.0] * len(CELLS)}, save=saved.append)
    assert set(out) == {"17", "202"}
    assert len(out["202"]) == len(CELLS) and max(out["202"]) > 100
    assert saved and saved[-1] is out
    # Nothing missing: no download.
    monkeypatch.setattr(hosts, "download", lambda *a: (_ for _ in ()).throw(AssertionError("downloaded")))
    assert hosts.build_hosts(CELLS, [202], out) == out


def test_host_score_weights_and_saturates():
    ba = {"202": [0.0, 20.0, 200.0], "17": [20.0, 0.0, 0.0]}
    trees = [{"fia": 202, "weight": 1}, {"fia": 17, "weight": 0.5}, {"fia": 999, "weight": 1}]
    score = hosts.host_score(ba, trees, 3, half_ba=20)
    assert score[1] == np.float64(0.5)
    assert 0.29 < score[0] < 0.30  # 10 weighted ft²/acre
    assert score[2] > 0.99


def test_build_model_host_fields():
    index = {c: i for i, c in enumerate(CELLS)}
    rows = [[1, "2025-10-01", 45.5, -122.6, "Cantharellus formosus", 300]]
    host = np.zeros(len(CELLS))
    host[3] = 0.42
    m = build_model("c", rows, index, 7, host, 0.1)
    assert (m["hostFloor"], m["hostIdx"], m["hostVal"]) == (0.1, [3], [42])
    # No gate (floor 1, e.g. wood-chip species): no host fields.
    assert "hostIdx" not in build_model("p", rows, index, 7, host, 1.0)
    assert "hostIdx" not in build_model("p", rows, index, 7)
