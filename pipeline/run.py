"""Update MushMap's heat map data.

    python pipeline/run.py --data <dir>

Builds the grid on first run, the trail data monthly (trails.py), fetches new iNaturalist sightings for every tracked group,
looks up their elevations, and rebuilds the per-group and per-species models. Host-tree basal
area per cell (hosts.json) is built once from the USFS tree maps and kept with the data. Weather
(NOAA GHCN-Daily) is reloaded every run: recent conditions per cell, and per model a table of how
the weather before finds differs from usual.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import h3

from common import load_catalog, read_json, write_json
from elevation import elevations
from grid import build_grid
from hosts import build_hosts, host_score
from model import build_model
from observations import update_group
from trails import build as build_trails, build_if_stale as build_trails_if_stale
from weather import current_json, load_weather, weather_model

MIN_SPECIES_OBS = 25  # fewer sightings than this and a species shares its group's map
# Weighted host basal area (ft²/acre, averaged over the cell) that gives a host score of 0.5.
# Mature Douglas-fir forest is around 150-250; a cell that is a fifth forest reads as a good host cell.
HOST_HALF_BA = 20.0


def species_lookup(group: dict) -> dict[str, str]:
    """Lower-case scientific names and synonyms to species id."""
    names: dict[str, str] = {}
    for s in group["species"]:
        for n in [s["scientificName"], *s["synonyms"]]:
            names[n.lower()] = s["id"]
    return names


def species_of(taxon: str, lookup: dict[str, str]) -> str | None:
    """Match a sighting's taxon to a tracked species; subspecies and varieties count as their species."""
    words = taxon.lower().split()
    return lookup.get(" ".join(words[:2])) if len(words) >= 2 else None


def fill_elevations(rows: list[list]) -> None:
    missing = [r for r in rows if r[5] is None]
    if not missing:
        return
    print(f"  looking up {len(missing)} elevations")
    for r, e in zip(missing, elevations([(r[2], r[3]) for r in missing])):
        r[5] = e


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True, help="Directory holding the generated data")
    parser.add_argument("--groups", help="Comma-separated group ids (default: all)")
    parser.add_argument("--skip-fetch", action="store_true", help="Rebuild models from stored sightings only")
    parser.add_argument("--rebuild-grid", action="store_true")
    parser.add_argument("--skip-weather", action="store_true", help="Leave weather out of the models")
    parser.add_argument("--skip-trails", action="store_true", help="Leave the trail data as it is")
    parser.add_argument("--only-trails", action="store_true", help="Rebuild the trail data and nothing else")
    args = parser.parse_args()

    catalog = load_catalog()
    groups = catalog["groups"]
    if args.groups:
        wanted = set(args.groups.split(","))
        groups = [g for g in groups if g["id"] in wanted]

    grid_path = args.data / "cells.json"
    grid = None if args.rebuild_grid else read_json(grid_path)
    if grid is None:
        grid = build_grid()
        write_json(grid_path, grid)
    cell_index = {c: i for i, c in enumerate(grid["cells"])}

    if args.only_trails:
        build_trails(args.data)
        return
    if not args.skip_trails:
        try:
            build_trails_if_stale(args.data)
        except Exception as err:  # the trail finder can wait a week; the heat map should not
            print(f"::warning::Trail data not rebuilt: {err}")

    hosts_path = args.data / "hosts.json"
    stored_hosts = read_json(hosts_path, {})
    if stored_hosts.get("cells") != len(grid["cells"]):
        stored_hosts = {"cells": len(grid["cells"]), "basalArea": {}}
    codes = [t["fia"] for g in catalog["groups"] for t in g.get("hostTrees", [])]
    basal_area = build_hosts(
        grid["cells"], codes, stored_hosts["basalArea"],
        save=lambda ba: write_json(hosts_path, {"cells": len(grid["cells"]), "basalArea": ba}),
    )

    wx = None
    if not args.skip_weather:
        wx = load_weather()
        centres = [h3.cell_to_latlng(c) for c in grid["cells"]]
        p14, t7 = wx.current([c[0] for c in centres], [c[1] for c in centres], [e if e is not None else float("nan") for e in grid["elev"]])
        write_json(args.data / "weather" / "current.json", current_json(wx.as_of, p14, t7))
        print(f"weather as of {wx.as_of}: {int((p14 == p14).sum())} cells with rain, {int((t7 == t7).sum())} with temperature")

    index_path = args.data / "model" / "index.json"
    index = read_json(index_path, {"models": []})
    entries = {m["id"]: m for m in index["models"]}

    for g in groups:
        print(f"{g['name']}:")
        obs_path = args.data / "obs" / f"{g['id']}.json"
        store = read_json(obs_path)
        if not args.skip_fetch:
            store = update_group(store, g["inatTaxa"])
            fill_elevations(store["obs"])
            write_json(obs_path, store)
        rows = store["obs"] if store else []

        for e in [e for e in entries.values() if e["groupId"] == g["id"]]:
            del entries[e["id"]]
        lookup = species_lookup(g)
        by_species: dict[str, list[list]] = {}
        for r in rows:
            sid = species_of(r[4], lookup)
            if sid:
                by_species.setdefault(sid, []).append(r)

        host_floor = g.get("hostFloor", 1.0)
        host = host_score(basal_area, g.get("hostTrees", []), len(grid["cells"]), HOST_HALF_BA) if host_floor < 1 else None
        if host is not None and rows:
            # Sanity check: sightings should sit on host cells far more often than the region does.
            at_obs = [host[i] for r in rows if (i := cell_index.get(h3.latlng_to_cell(r[2], r[3], grid["res"]))) is not None]
            print(f"  host score: {host.mean():.2f} across the region, {sum(at_obs) / max(len(at_obs), 1):.2f} where found")

        conds = wx.sighting_conditions(rows) if wx else {}
        if conds:
            print(f"  weather before {len(conds)} of {len(rows)} sightings")

        models = [(g["id"], "group", g["name"], rows)]
        for s in g["species"]:
            srows = by_species.get(s["id"], [])
            if len(srows) >= MIN_SPECIES_OBS:
                models.append((s["id"], "species", s["scientificName"], srows))
        for model_id, kind, label, mrows in models:
            if not mrows:
                continue
            model = build_model(model_id, mrows, cell_index, grid["res"], host, host_floor)
            weather = weather_model(conds, [r[0] for r in mrows])
            if weather:
                model["weather"] = weather
            write_json(args.data / "model" / f"{model_id}.json", model)
            entries[model_id] = {"id": model_id, "kind": kind, "groupId": g["id"], "label": label, "count": len(mrows)}
            print(f"  model {model_id}: {len(mrows)} sightings")

    order = {g["id"]: i for i, g in enumerate(catalog["groups"])}
    write_json(index_path, {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "region": grid["states"],
        "models": sorted(entries.values(), key=lambda m: (order.get(m["groupId"], 99), m["kind"] != "group", m["label"])),
    })


if __name__ == "__main__":
    main()
