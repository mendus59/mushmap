"""Research-grade iNaturalist sightings in the region, fetched incrementally per taxon name."""
from __future__ import annotations

import time
from typing import Any

from common import http_json

API = "https://api.inaturalist.org/v1/observations"
# iNaturalist place ids: Washington, Oregon.
PLACE_IDS = "46,10"
PAGE = 200
# iNaturalist asks API users to stay around 60 requests a minute.
PAUSE_S = 1.1


def fetch_new(taxon_name: str, id_above: int) -> tuple[list[list[Any]], int]:
    """Sightings newer than id_above, as [id, observed_on, lat, lon, taxon_name] rows, plus the new cursor."""
    rows: list[list[Any]] = []
    while True:
        body = http_json(API, {
            "taxon_name": taxon_name,
            "place_id": PLACE_IDS,
            "quality_grade": "research",
            # Obscured sightings are moved up to ~20 km at random; leave them out.
            "geoprivacy": "open",
            "taxon_geoprivacy": "open",
            "id_above": id_above,
            "order_by": "id",
            "order": "asc",
            "per_page": PAGE,
        })
        results = body.get("results", [])
        for r in results:
            id_above = max(id_above, r["id"])
            row = to_row(r)
            if row:
                rows.append(row)
        time.sleep(PAUSE_S)
        if len(results) < PAGE:
            return rows, id_above


def to_row(r: dict[str, Any]) -> list[Any] | None:
    coords = (r.get("geojson") or {}).get("coordinates")
    day = r.get("observed_on")
    taxon = (r.get("taxon") or {}).get("name")
    if not coords or not day or not taxon:
        return None
    lon, lat = coords
    return [r["id"], day, round(lat, 5), round(lon, 5), taxon]


def update_group(store: dict[str, Any] | None, taxon_names: list[str]) -> dict[str, Any]:
    """Add new sightings for each taxon name to a group's store and return it."""
    store = store or {"cursor": {}, "obs": []}
    seen = {row[0] for row in store["obs"]}
    for name in taxon_names:
        rows, store["cursor"][name] = fetch_new(name, store["cursor"].get(name, 0))
        # Taxon names can overlap (e.g. a synonym), so skip sightings already stored.
        new_rows = [r for r in rows if r[0] not in seen]
        if new_rows:
            seen.update(r[0] for r in new_rows)
            # Elevation is filled in later (index 5).
            store["obs"].extend(r + [None] for r in new_rows)
        print(f"  {name}: +{len(new_rows)} (cursor {store['cursor'][name]})")
    return store
