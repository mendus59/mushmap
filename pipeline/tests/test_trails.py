import sys
from pathlib import Path

import h3
from shapely import STRtree
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import trails as T  # noqa: E402

# Two touching ways of one named trail (one starts at a road junction), an unnamed 0.3 km path that
# is too short to keep, a private path, a sidewalk, a road and a trailhead.
OSM_XML = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <node id="1" lat="46.000" lon="-121.000"/>
  <node id="2" lat="46.010" lon="-121.000"/>
  <node id="3" lat="46.020" lon="-121.000"/>
  <node id="4" lat="46.030" lon="-121.000"/>
  <node id="5" lat="46.500" lon="-121.500"/>
  <node id="6" lat="46.503" lon="-121.500"/>
  <node id="7" lat="45.990" lon="-121.010"/>
  <node id="8" lat="46.200" lon="-121.200"><tag k="highway" v="trailhead"/></node>
  <node id="9" lat="46.300" lon="-121.300"/>
  <node id="10" lat="46.310" lon="-121.300"/>
  <way id="100"><nd ref="1"/><nd ref="2"/><tag k="highway" v="path"/><tag k="name" v="Bear Creek Trail"/><tag k="sac_scale" v="mountain_hiking"/></way>
  <way id="101"><nd ref="2"/><nd ref="3"/><nd ref="4"/><tag k="highway" v="path"/><tag k="name" v="Bear Creek Trail"/></way>
  <way id="102"><nd ref="5"/><nd ref="6"/><tag k="highway" v="path"/></way>
  <way id="103"><nd ref="9"/><nd ref="10"/><tag k="highway" v="path"/><tag k="access" v="private"/></way>
  <way id="104"><nd ref="9"/><nd ref="10"/><tag k="highway" v="footway"/><tag k="footway" v="sidewalk"/></way>
  <way id="200"><nd ref="7"/><nd ref="1"/><tag k="highway" v="track"/></way>
  <relation id="300"><member type="way" ref="102" role=""/><tag k="route" v="hiking"/><tag k="name" v="Loop Route"/></relation>
</osm>
"""


def test_read_osm_keeps_trails_roads_and_trailheads(tmp_path):
    path = tmp_path / "test.osm"
    path.write_text(OSM_XML)
    osm = T.read_osm([path])
    assert sorted(osm.ways) == [100, 101, 102]
    assert osm.road_nodes == {1}
    assert osm.trailheads == [(46.2, -121.2)]
    assert osm.route_names == {102: "Loop Route"}
    groups = T.group_trails(osm)
    names = sorted((n, sorted(w.id for w in ws)) for n, ws in groups)
    # The route name makes the short unnamed path a named trail, long enough to keep.
    assert names == [("Bear Creek Trail", [100, 101]), ("Loop Route", [102])]


def test_ease_and_accessibility_follow_the_brief():
    easy = T.ease_score(km=4, gain_m=60, sac="hiking", poor_visibility=False)
    hard = T.ease_score(km=6, gain_m=1300, sac="demanding_mountain_hiking", poor_visibility=False)
    assert easy == 1.0 and hard < 0.2
    assert T.access_score(land=1.0, ease=easy, reachable=True) == 100
    assert 45 <= T.access_score(land=1.0, ease=hard, reachable=True) <= 60
    assert T.access_score(land=0.0, ease=easy, reachable=True) <= 10
    assert T.access_score(land=1.0, ease=easy, reachable=False) < 75


def test_land_takes_the_best_access_where_areas_overlap():
    polys = [box(0, 0, 2, 2), box(1, 1, 3, 3)]
    land = T.Land(polys, ["RA", "OA"], ["State forest", "National forest"], STRtree(polys))
    classes, managers = land.classify([0.5, 1.5, 5], [0.5, 1.5, 5])
    assert classes == ["RA", "OA", None]
    assert managers == ["State forest", "National forest", None]
    assert T.land_fraction(classes) == (0.6 + 1.0) / 3
    assert T.access_code("Open Access") == "OA" and T.access_code("XA") == "XA" and T.access_code(None) == "UK"


def test_climb_and_polyline():
    assert T.climb([100, 100, 100]) == 0
    assert 150 < T.climb([0, 100, 200, 300, 300]) < 300
    # Example from Google's polyline documentation.
    assert T.encode_polyline([(-120.2, 38.5), (-120.95, 40.7), (-126.453, 43.252)]) == "_p~iF~ps|U_ulLnnqC_mqNvxq`@"


def test_sections_cut_long_trails_by_area():
    coords = [(-121.0, 45.0 + i * 0.01) for i in range(300)]  # ~33 km north-south
    ways = [T.Way(i, "Long Trail", None, False, [i, i + 1], [coords[i], coords[i + 1]]) for i in range(299)]
    osm = T.OsmData(ways={w.id: w for w in ways})
    groups = T.group_trails(osm)
    assert len(groups) > 1
    assert all(n.startswith("Long Trail (section ") for n, _ in groups)
    assert sum(len(ws) for _, ws in groups) == 299
    assert h3.latlng_to_cell(*reversed(groups[0][1][0].coords[0]), T.SECTION_RES)


class FlatSampler:
    def elevation(self, lat, lon):
        return 500


def test_build_trails_scores_and_places_each_trail(tmp_path):
    path = tmp_path / "test.osm"
    path.write_text(OSM_XML)
    osm = T.read_osm([path])
    cells = sorted({h3.latlng_to_cell(46.0 + i * 0.005, -121.0, 7) for i in range(7)})
    grid = {"res": 7, "cells": cells}
    public = box(-121.1, 45.9, -120.9, 46.1)
    land = T.Land([public], ["OA"], ["Test National Forest"], STRtree([public]))
    out = T.build_trails(osm, land, grid, FlatSampler())
    assert [t["n"] for t in out["trails"]] == ["Bear Creek Trail"]  # Loop Route lies outside the grid
    t = out["trails"][0]
    assert t["km"] == 3.3 and t["g"] == 0 and t["sac"] == "mountain_hiking"
    assert t["pub"] == 100 and t["mgr"] == "Test National Forest" and t["th"] is True
    assert t["s"] == T.access_score(1.0, 0.85, True)
    assert t["c"] == list(range(len(cells)))
    assert T.cell_land(land, grid) == [100] * len(cells)
