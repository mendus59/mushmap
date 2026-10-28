"""Update MushMap's heat map data.

    python pipeline/run.py --data <dir>

Builds the grid on first run, fetches new iNaturalist sightings for every tracked group,
looks up their elevations, and rebuilds the per-group and per-species models.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

from common import load_catalog, read_json, write_json
from elevation import elevations
from grid import build_grid
from model import build_model
from observations import update_group

MIN_SPECIES_OBS = 25  # fewer sightings than this and a species shares its group's map


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

        models = [(g["id"], "group", g["name"], rows)]
        for s in g["species"]:
            srows = by_species.get(s["id"], [])
            if len(srows) >= MIN_SPECIES_OBS:
                models.append((s["id"], "species", s["scientificName"], srows))
        for model_id, kind, label, mrows in models:
            if not mrows:
                continue
            write_json(args.data / "model" / f"{model_id}.json", build_model(model_id, mrows, cell_index, grid["res"]))
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
