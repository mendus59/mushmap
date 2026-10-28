import sys
from pathlib import Path

import h3
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from grid import cells_for  # noqa: E402
from model import ELEV_BINS, WEEKS, build_model, elev_bin, history, iso_week, season_elevation  # noqa: E402
from observations import to_row  # noqa: E402
from run import species_lookup, species_of  # noqa: E402


def test_iso_week():
    assert iso_week("2026-01-01") == 1
    assert iso_week("2026-10-28") == 44


def test_elev_bin_clamps():
    assert elev_bin(-20) == 0
    assert elev_bin(1024) == 20
    assert elev_bin(99999) == ELEV_BINS - 1


def test_season_elevation_peaks_at_sightings():
    table = season_elevation([(18, 600)] * 5 + [(20, 900)])
    assert len(table) == WEEKS and len(table[0]) == ELEV_BINS
    assert table[17][elev_bin(600)] == 100
    assert table[19][elev_bin(900)] > 0
    # Far from any sighting in time or elevation scores nothing.
    assert table[40][elev_bin(600)] == 0
    assert table[17][elev_bin(3000)] == 0


def test_season_wraps_around_new_year():
    table = season_elevation([(1, 300)])
    assert table[WEEKS - 1][elev_bin(300)] > 50


def test_season_elevation_empty():
    assert season_elevation([])[0][0] == 0


def test_history_spreads_and_saturates():
    center = h3.latlng_to_cell(45.5, -122.6, 7)
    cells = sorted(h3.grid_disk(center, 6))
    index = {c: i for i, c in enumerate(cells)}
    idx, val = history([center] * 50, index)
    values = dict(zip(idx, val))
    assert values[index[center]] == 100
    far = next(c for c in h3.grid_ring(center, 4))
    assert 0 < values[index[far]] < 100
    assert index[next(iter(h3.grid_ring(center, 6)))] not in values


def test_history_ignores_cells_outside_grid():
    center = h3.latlng_to_cell(45.5, -122.6, 7)
    idx, _ = history([center], {center: 0})
    assert idx == [0]


def test_build_model_shape():
    center = h3.latlng_to_cell(45.5, -122.6, 7)
    index = {c: i for i, c in enumerate(sorted(h3.grid_disk(center, 5)))}
    rows = [[1, "2025-05-01", 45.5, -122.6, "Morchella americana", 300], [2, "2025-05-08", 45.5, -122.6, "Morchella", None]]
    m = build_model("morels", rows, index, 7)
    assert m["count"] == 2
    assert len(m["historyIdx"]) == len(m["historyVal"]) > 0


def test_cells_for_box():
    cells = cells_for(box(-122.7, 45.4, -122.5, 45.6))
    assert len(cells) > 50
    assert all(h3.get_resolution(c) == 7 for c in cells)


def test_species_of_matches_synonyms_and_subspecies():
    group = {"species": [
        {"id": "collybia-nuda", "scientificName": "Collybia nuda", "synonyms": ["Lepista nuda", "Clitocybe nuda"]},
    ]}
    lookup = species_lookup(group)
    assert species_of("Lepista nuda", lookup) == "collybia-nuda"
    assert species_of("Collybia nuda var. glaucocana", lookup) == "collybia-nuda"
    assert species_of("Collybia", lookup) is None


def test_to_row():
    r = {"id": 7, "observed_on": "2025-10-01", "geojson": {"coordinates": [-122.123456, 45.654321]}, "taxon": {"name": "Cantharellus formosus"}}
    assert to_row(r) == [7, "2025-10-01", 45.65432, -122.12346, "Cantharellus formosus"]
    assert to_row({"id": 8, "observed_on": None}) is None


def test_tile_position_and_terrarium_decoding():
    from elevation import decode_terrarium, tile_position
    # Portland, OR at zoom 10 falls in tile 163/366.
    tx, ty, px, py = tile_position(45.52, -122.68)
    assert (tx, ty) == (163, 366)
    assert 0 <= px < 256 and 0 <= py < 256
    assert decode_terrarium(128, 0, 0) == 0
    assert decode_terrarium(129, 44, 0) == 300


def test_resolve_taxon_id_picks_exact_fungus(monkeypatch):
    import observations
    monkeypatch.setattr(observations.time, "sleep", lambda s: None)
    monkeypatch.setattr(observations, "http_json", lambda url, params: {"results": [
        {"id": 1, "name": "Morchella esculenta", "iconic_taxon_name": "Fungi"},
        {"id": 2, "name": "Morchella", "iconic_taxon_name": "Plantae"},
        {"id": 3, "name": "Morchella", "iconic_taxon_name": "Fungi"},
    ]})
    assert observations.resolve_taxon_id("Morchella") == 3


def test_update_group_resets_old_store_versions(monkeypatch):
    import observations
    monkeypatch.setattr(observations, "resolve_taxon_id", lambda name: 42)
    calls = []

    def fake_fetch(taxon_id, id_above):
        calls.append((taxon_id, id_above))
        return [[10, "2025-05-01", 45.0, -122.0, "Morchella snyderi"]], 10

    monkeypatch.setattr(observations, "fetch_new", fake_fetch)
    old = {"cursor": {"Morchella": 999}, "obs": [[5, "2024-05-01", 45.0, -122.0, "Verpa bohemica", 100]]}
    store = observations.update_group(old, ["Morchella"])
    assert calls == [(42, 0)]
    assert [r[4] for r in store["obs"]] == ["Morchella snyderi"]
    assert store["version"] == observations.STORE_VERSION
    # A second run continues from the cursor.
    observations.update_group(store, ["Morchella"])
    assert calls[-1] == (42, 10)


def test_update_group_skips_unknown_names(monkeypatch):
    import observations

    def resolve(name):
        if name == "Lepista nuda":
            raise RuntimeError("No active iNaturalist taxon named 'Lepista nuda'")
        return 7

    monkeypatch.setattr(observations, "resolve_taxon_id", resolve)
    monkeypatch.setattr(observations, "fetch_new", lambda taxon_id, id_above: ([], id_above))
    store = observations.update_group(None, ["Collybia nuda", "Lepista nuda"])
    assert store["taxonIds"] == {"Collybia nuda": 7}
