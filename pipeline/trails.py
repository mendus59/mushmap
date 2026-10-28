"""Trails and how easy they are to get to and walk, for the trail finder.

    python pipeline/trails.py --data <dir>

Built once and then monthly (run.py calls build_if_stale), since trails and land change slowly.

Sources, all free with no key:
  - Trails, roads and trailheads: OpenStreetMap extracts for Washington and Oregon from Geofabrik.
  - Land ownership and public access: USGS Protected Areas Database (PAD-US) "Public_Access" web
    service, which marks land as open, restricted (permit or seasonal), closed or unknown access.
    Land it does not cover is treated as private.
  - Elevation: AWS Terrain Tiles, sampled every ~100 m along each trail.

Trail ways with the same name that touch are joined into one trail; unnamed paths are joined with
the unnamed paths they touch and kept when they add up to a kilometre. Trails longer than
SECTION_KM are cut into sections by area, so the Pacific Crest Trail is not one entry.

Accessibility (0-100) rewards trails on open public land, reachable from a road or trailhead, with
little climbing per kilometre and an easy OSM difficulty (sac_scale):
    score = 8 + 92 * land * (0.4 + 0.6 * ease) * reach
so a trail on private land scores about 8, a hard climb on open public land about 50, and an easy
flat trail on open public land from a trailhead 100.
"""
from __future__ import annotations

import argparse
import subprocess
import tempfile
from array import array
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import h3
import numpy as np
from shapely import STRtree, points as shapely_points
from shapely.geometry import LineString, MultiLineString, shape
from shapely.ops import linemerge

from common import USER_AGENT, http_json, read_json, write_json
from elevation import TileSampler

OSM_URLS = [
    "https://download.geofabrik.de/north-america/us/washington-latest.osm.pbf",
    "https://download.geofabrik.de/north-america/us/oregon-latest.osm.pbf",
]
PADUS_URL = "https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Public_Access/FeatureServer/0/query"
REGION_BBOX = (-124.9, 41.9, -116.4, 49.1)  # west, south, east, north
REBUILD_DAYS = 30

TRAIL_HIGHWAYS = {"path", "footway", "bridleway"}
SKIP_FOOTWAYS = {"sidewalk", "crossing", "access_aisle", "traffic_island"}
ROAD_HIGHWAYS = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "track", "service",
}
SKIP_SERVICE = {"driveway", "parking_aisle", "drive-through", "emergency_access"}
CLOSED_ACCESS = {"private", "no"}
TRAILHEAD_RES = 9  # H3 cells ~0.1 km²; a trail within one ring of a trailhead's cell counts as reachable
MIN_NAMED_KM = 0.2
MIN_UNNAMED_KM = 1.0
SECTION_KM = 15.0
SECTION_RES = 5  # ~250 km² areas for cutting long trails into sections
SAMPLE_M = 100.0
SIMPLIFY_DEG = 0.0002  # ~20 m
ELEV_ZOOM = 11  # ~55 m per pixel

# Weight of each PAD-US access class towards "public land you may walk on".
ACCESS_WEIGHT = {"OA": 1.0, "RA": 0.6, "UK": 0.4, "XA": 0.0}
ACCESS_RANK = {"XA": 0, "UK": 1, "RA": 2, "OA": 3}
SAC_EASE = {
    None: 1.0, "hiking": 1.0, "mountain_hiking": 0.85, "demanding_mountain_hiking": 0.6,
    "alpine_hiking": 0.4, "demanding_alpine_hiking": 0.25, "difficult_alpine_hiking": 0.25,
}
SAC_RANK = list(SAC_EASE)
POOR_VISIBILITY = {"bad", "horrible", "no"}
UNREACHED = 0.7  # reach factor for a trail with no road or trailhead of its own


# --- OpenStreetMap ---------------------------------------------------------------------------

@dataclass
class Way:
    id: int
    name: str
    sac: str | None
    poor_visibility: bool
    nodes: list[int]
    coords: list[tuple[float, float]]  # (lon, lat)


@dataclass
class OsmData:
    ways: dict[int, Way] = field(default_factory=dict)
    road_nodes: set[int] = field(default_factory=set)
    trailheads: list[tuple[float, float]] = field(default_factory=list)  # (lat, lon)
    route_names: dict[int, str] = field(default_factory=dict)  # way id -> hiking route name


def read_osm(paths: list[Path]) -> OsmData:
    import osmium

    data = OsmData()
    road_nodes = array("q")
    for path in paths:
        fp = (osmium.FileProcessor(str(path))
              .with_locations()
              .with_filter(osmium.filter.KeyFilter("highway", "amenity", "route")))
        for o in fp:
            tags = o.tags
            if o.is_node():
                if tags.get("highway") == "trailhead" or tags.get("amenity") == "parking":
                    data.trailheads.append((o.location.lat, o.location.lon))
            elif o.is_way():
                hw = tags.get("highway")
                if tags.get("amenity") == "parking" and len(o.nodes) and o.nodes[0].location.valid():
                    data.trailheads.append((o.nodes[0].location.lat, o.nodes[0].location.lon))
                if tags.get("access") in CLOSED_ACCESS or tags.get("foot") in CLOSED_ACCESS:
                    continue
                if hw in TRAIL_HIGHWAYS:
                    if hw == "footway" and tags.get("footway") in SKIP_FOOTWAYS:
                        continue
                    if o.id in data.ways:
                        continue  # in both state extracts
                    nodes = [n.ref for n in o.nodes if n.location.valid()]
                    coords = [(n.location.lon, n.location.lat) for n in o.nodes if n.location.valid()]
                    if len(coords) < 2:
                        continue
                    data.ways[o.id] = Way(o.id, tags.get("name", ""), tags.get("sac_scale"),
                                          tags.get("trail_visibility") in POOR_VISIBILITY, nodes, coords)
                elif hw in ROAD_HIGHWAYS and not (hw == "service" and tags.get("service") in SKIP_SERVICE):
                    road_nodes.extend(n.ref for n in o.nodes)
            elif o.is_relation():
                if tags.get("route") in ("hiking", "foot") and tags.get("name"):
                    for m in o.members:
                        if m.type == "w":
                            data.route_names.setdefault(m.ref, tags.get("name"))
    trail_nodes = np.fromiter((n for w in data.ways.values() for n in w.nodes), dtype=np.int64)
    roads = np.frombuffer(road_nodes, dtype=np.int64)
    data.road_nodes = set(np.intersect1d(trail_nodes, roads).tolist())
    print(f"osm: {len(data.ways)} trail ways, {len(data.road_nodes)} road junctions, "
          f"{len(data.trailheads)} trailheads and parking areas, {len(data.route_names)} ways in hiking routes")
    return data


def way_km(coords) -> float:
    total = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        total += h3.great_circle_distance((lat1, lon1), (lat2, lon2), unit="km")
    return total


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[int, int] = {}

    def find(self, x: int) -> int:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        self.parent[self.find(a)] = self.find(b)


def connected(ways: list[Way]) -> list[list[Way]]:
    """Groups of ways that share any node."""
    uf = UnionFind()
    owner: dict[int, int] = {}
    for w in ways:
        uf.find(w.id)
        for n in w.nodes:
            if n in owner:
                uf.union(w.id, owner[n])
            else:
                owner[n] = w.id
    groups: dict[int, list[Way]] = defaultdict(list)
    for w in ways:
        groups[uf.find(w.id)].append(w)
    return list(groups.values())


def trail_name(w: Way, route_names: dict[int, str]) -> str:
    return w.name or route_names.get(w.id, "")


def sections(ways: list[Way]) -> list[list[Way]]:
    """Cut a long trail into pieces by area, each piece one connected run."""
    by_area: dict[str, list[Way]] = defaultdict(list)
    for w in ways:
        lon, lat = w.coords[len(w.coords) // 2]
        by_area[h3.latlng_to_cell(lat, lon, SECTION_RES)].append(w)
    return [c for group in by_area.values() for c in connected(group)]


def group_trails(osm: OsmData) -> list[tuple[str, list[Way]]]:
    """(name, ways) for every trail kept: same-name ways that touch, cut into sections when long."""
    by_name: dict[str, list[Way]] = defaultdict(list)
    for w in osm.ways.values():
        by_name[trail_name(w, osm.route_names)].append(w)
    out: list[tuple[str, list[Way]]] = []
    for name, ways in by_name.items():
        for comp in connected(ways):
            km = sum(way_km(w.coords) for w in comp)
            if km < (MIN_NAMED_KM if name else MIN_UNNAMED_KM):
                continue
            pieces = sections(comp) if km > SECTION_KM else [comp]
            pieces = [p for p in pieces if sum(way_km(w.coords) for w in p) >= MIN_NAMED_KM]
            if len(pieces) > 1:
                pieces.sort(key=lambda p: -np.mean([c[1] for w in p for c in w.coords]))  # north to south
                out.extend((f"{name or 'Unnamed trail'} (section {i + 1} of {len(pieces)})", p)
                           for i, p in enumerate(pieces))
            else:
                out.extend((name or "Unnamed trail", p) for p in pieces)
    return out


# --- Land ------------------------------------------------------------------------------------

def access_code(value: str | None) -> str:
    v = (value or "").strip().upper()
    if v.startswith("O"):
        return "OA"
    if v.startswith("R"):
        return "RA"
    if v.startswith("X") or v.startswith("C"):
        return "XA"
    return "UK"


@dataclass
class Land:
    polygons: list
    access: list[str]
    manager: list[str]
    tree: STRtree

    def classify(self, lats, lons) -> tuple[list[str | None], list[str | None]]:
        """Best access class and its manager at each point; None where no public land covers it."""
        pts = shapely_points(np.asarray(lons, dtype=float), np.asarray(lats, dtype=float))
        best: list[str | None] = [None] * len(pts)
        mgr: list[str | None] = [None] * len(pts)
        if not len(pts) or not self.polygons:
            return best, mgr
        pi, gi = self.tree.query(pts, predicate="intersects")
        for p, g in zip(pi, gi):
            a = self.access[g]
            if best[p] is None or ACCESS_RANK[a] > ACCESS_RANK[best[p]]:
                best[p], mgr[p] = a, self.manager[g]
        return best, mgr


def fetch_land(bbox=REGION_BBOX, step: float = 1.0) -> Land:
    """PAD-US public access polygons over the region, a degree square at a time."""
    seen: set[int] = set()
    polygons, access, manager = [], [], []
    west, south, east, north = bbox
    lon = west
    while lon < east:
        lat = south
        while lat < north:
            offset = 0
            while True:
                body = http_json(PADUS_URL, {
                    "where": "1=1",
                    "geometry": f"{lon},{lat},{min(lon + step, east)},{min(lat + step, north)}",
                    "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                    "spatialRel": "esriSpatialRelIntersects",
                    "outFields": "OBJECTID,Pub_Access,Mang_Name,Unit_Nm", "outSR": 4326,
                    "maxAllowableOffset": 0.0003, "geometryPrecision": 5,
                    "resultOffset": offset, "resultRecordCount": 1000, "f": "geojson",
                })
                if "error" in body:
                    raise RuntimeError(f"PAD-US query failed: {body['error']}")
                feats = body.get("features", [])
                for f in feats:
                    props = f.get("properties") or {}
                    oid = props.get("OBJECTID", f.get("id"))
                    if oid in seen or not f.get("geometry"):
                        continue
                    seen.add(oid)
                    geom = shape(f["geometry"])
                    if not geom.is_valid:
                        geom = geom.buffer(0)
                    polygons.append(geom)
                    access.append(access_code(props.get("Pub_Access")))
                    manager.append(props.get("Unit_Nm") or props.get("Mang_Name") or "")
                exceeded = body.get("exceededTransferLimit") or (body.get("properties") or {}).get("exceededTransferLimit")
                if not feats or not exceeded:
                    break
                offset += len(feats)
            lat += step
        lon += step
        print(f"  PAD-US: {len(polygons)} areas so far (to {lon:.0f}°)")
    counts = {a: access.count(a) for a in ACCESS_WEIGHT}
    print(f"land: {len(polygons)} PAD-US areas {counts}")
    return Land(polygons, access, manager, STRtree(polygons))


# --- Scoring ---------------------------------------------------------------------------------

def ease_score(km: float, gain_m: float, sac: str | None, poor_visibility: bool) -> float:
    """1 for a flat, easy trail, falling with climbing per km, total climbing and OSM difficulty."""
    grade = gain_m / max(km, 0.1)  # metres climbed per km
    grade_ease = min(1.0, max(0.15, 1 - (grade - 25) / 150))
    total_ease = min(1.0, max(0.3, 1 - (gain_m - 300) / 1200))
    ease = min(grade_ease, total_ease) * SAC_EASE.get(sac, 0.25)
    return ease * (0.7 if poor_visibility else 1.0)


def access_score(land: float, ease: float, reachable: bool) -> int:
    return round(8 + 92 * land * (0.4 + 0.6 * ease) * (1.0 if reachable else UNREACHED))


def land_fraction(classes: list[str | None]) -> float:
    if not classes:
        return 0.0
    return sum(ACCESS_WEIGHT[c] if c else 0.0 for c in classes) / len(classes)


def samples(line: LineString, every_m: float = SAMPLE_M) -> list[tuple[float, float]]:
    """(lon, lat) every ~every_m along a line, ends included."""
    coords = list(line.coords)
    km = way_km(coords)
    n = max(2, int(km * 1000 / every_m) + 1)
    return [line.interpolate(i / (n - 1), normalized=True).coords[0] for i in range(n)]


def climb(elevs: list[float]) -> float:
    """Metres climbed going whichever way along a profile climbs more, after light smoothing."""
    if len(elevs) < 3:
        return abs(elevs[-1] - elevs[0]) if len(elevs) == 2 else 0.0
    e = np.array(elevs, dtype=float)
    s = np.convolve(np.pad(e, 1, mode="edge"), np.ones(3) / 3, mode="valid")
    d = np.diff(s)
    return float(max(d[d > 0].sum(), -d[d < 0].sum()))


def encode_polyline(coords: list[tuple[float, float]], precision: int = 5) -> str:
    """Google encoded polyline of (lon, lat) pairs (stored lat first, as the format expects)."""
    out, plat, plon = [], 0, 0
    f = 10 ** precision
    for lon, lat in coords:
        ilat, ilon = round(lat * f), round(lon * f)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def near_cells(lat: float, lon: float) -> list[str]:
    return list(h3.grid_disk(h3.latlng_to_cell(lat, lon, TRAILHEAD_RES), 1))


def build_trails(osm: OsmData, land: Land, grid: dict, sampler: TileSampler) -> dict:
    cell_index = {c: i for i, c in enumerate(grid["cells"])}
    trailhead_cells: set[str] = set()
    for lat, lon in osm.trailheads:
        trailhead_cells.update(near_cells(lat, lon))

    groups = group_trails(osm)
    # Visit trails west to east, north to south, so elevation tiles are reused while cached.
    groups.sort(key=lambda g: (round(g[1][0].coords[0][0], 1), -g[1][0].coords[0][1]))
    print(f"trails: {len(groups)} after joining and sectioning")
    trails = []
    for n, (name, ways) in enumerate(groups):
        merged = linemerge(MultiLineString([w.coords for w in ways]))
        lines = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
        km = sum(way_km(w.coords) for w in ways)
        pts, gain = [], 0.0
        for line in lines:
            s = samples(line)
            pts.extend(s)
            gain += climb([sampler.elevation(lat, lon) for lon, lat in s])
        classes, managers = land.classify([p[1] for p in pts], [p[0] for p in pts])
        public = land_fraction(classes)
        mgr_counts: dict[str, int] = defaultdict(int)
        for m in managers:
            if m:
                mgr_counts[m] += 1
        sac = max((w.sac for w in ways if w.sac in SAC_EASE), key=SAC_RANK.index, default=None)
        poor = sum(way_km(w.coords) for w in ways if w.poor_visibility) > km / 2
        node_set = {nd for w in ways for nd in w.nodes}
        reachable = bool(node_set & osm.road_nodes) or any(
            h3.latlng_to_cell(lat, lon, TRAILHEAD_RES) in trailhead_cells for lon, lat in pts)
        ease = ease_score(km, gain, sac, poor)
        cells = sorted({i for lon, lat in pts if (i := cell_index.get(h3.latlng_to_cell(lat, lon, grid["res"]))) is not None})
        if not cells:
            continue  # outside the grid (across a state line)
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        trails.append({
            "n": name,
            "km": round(km, 1),
            "g": round(gain),
            "sac": sac,
            "pub": round(public * 100),
            "open": round(100 * sum(c == "OA" for c in classes) / max(len(classes), 1)),
            "mgr": max(mgr_counts, key=mgr_counts.get) if mgr_counts else None,
            "th": reachable,
            "e": round(ease * 100),
            "s": access_score(public, ease, reachable),
            "c": cells,
            "b": [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)],
            "l": [encode_polyline(list(line.simplify(SIMPLIFY_DEG).coords)) for line in lines],
        })
        if (n + 1) % 2000 == 0:
            print(f"  {n + 1} of {len(groups)} trails scored")
    return {"trails": trails}


def cell_land(land: Land, grid: dict) -> list[int]:
    """Share of each grid cell (centre and corners) on public land, weighted by access, 0-100."""
    lats, lons = [], []
    for c in grid["cells"]:
        for lat, lon in [h3.cell_to_latlng(c), *h3.cell_to_boundary(c)]:
            lats.append(lat)
            lons.append(lon)
    classes, _ = land.classify(lats, lons)
    per = len(classes) // len(grid["cells"])
    return [round(100 * land_fraction(classes[i * per:(i + 1) * per])) for i in range(len(grid["cells"]))]


def download(url: str, path: Path) -> None:
    subprocess.run(["curl", "-sSfL", "--retry", "4", "-A", USER_AGENT, "-o", str(path), url], check=True)


def build(data_dir: Path) -> None:
    grid = read_json(data_dir / "cells.json")
    if grid is None:
        raise SystemExit("No grid yet; run pipeline/run.py first")
    with tempfile.TemporaryDirectory() as t:
        paths = []
        for url in OSM_URLS:
            path = Path(t) / url.rsplit("/", 1)[1]
            print(f"downloading {url}")
            download(url, path)
            paths.append(path)
        osm = read_osm(paths)
    land = fetch_land()
    out = build_trails(osm, land, grid, TileSampler(ELEV_ZOOM, max_tiles=3000))
    out["cellLand"] = cell_land(land, grid)
    out["generatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    write_json(data_dir / "trails" / "trails.json", out)
    s = np.array([t["s"] for t in out["trails"]])
    print(f"wrote {len(out['trails'])} trails; accessibility quartiles {np.percentile(s, [25, 50, 75]).tolist()}; "
          f"{sum(t['th'] for t in out['trails'])} reachable from a road or trailhead; "
          f"mean cell public land {np.mean(out['cellLand']):.0f}%")


def build_if_stale(data_dir: Path, days: int = REBUILD_DAYS) -> None:
    existing = read_json(data_dir / "trails" / "trails.json")
    if existing:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(existing["generatedAt"])
        if age < timedelta(days=days):
            print(f"trails: {len(existing['trails'])} from {existing['generatedAt'][:10]}, rebuilt every {days} days")
            return
    build(data_dir)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True, help="Directory holding the generated data")
    args = parser.parse_args()
    build(args.data)


if __name__ == "__main__":
    main()
