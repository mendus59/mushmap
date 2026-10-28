"""Shared helpers for the MushMap data pipeline."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = REPO_ROOT / "public" / "data" / "species.json"
USER_AGENT = "MushMap/1.0 (+https://github.com/mendus59/mushmap)"


def load_catalog() -> dict[str, Any]:
    return json.loads(CATALOG_PATH.read_text())


def read_json(path: Path, default: Any = None) -> Any:
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Compact output: these files are served to browsers.
    path.write_text(json.dumps(data, separators=(",", ":")))


def http_bytes(url: str, params: dict[str, Any] | None = None, retries: int = 4) -> bytes:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError) as err:
            status = getattr(err, "code", None)
            # Client errors other than rate limiting will not get better on retry.
            if status is not None and 400 <= status < 500 and status != 429:
                raise
            if attempt == retries:
                raise
            print(f"  retrying after {err} ({url[:120]})")
            time.sleep(delay)
            delay *= 2
    raise AssertionError("unreachable")


def http_json(url: str, params: dict[str, Any] | None = None) -> Any:
    return json.loads(http_bytes(url, params))
