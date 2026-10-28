"""Weather for the coming weeks, so the heat map can predict as well as describe.

    python pipeline/forecast.py --data <dir>

Runs daily. Asks Open-Meteo (free for non-commercial use, no key) for the last three weeks of
daily rain and temperature and the 16-day forecast at the centre of each H3 resolution 4 cell
(about 1,800 km², roughly 270 points over Washington and Oregon). For each of the next few weeks
it works out the same measures the station weather uses (weather.py), taken on the Thursday of
the week:
    p14: rain in the 14 days up to and including that day, in mm;
    t7:  mean temperature over the 7 days up to and including that day, in °C.
A week counts while at least half of its rain window is observed or forecast; the rain total is
scaled up for the missing days. The browser moves temperature to each cell's elevation and
scores it against each model's weather table, as it does for the station weather.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import h3
import numpy as np

from common import http_json, read_json, write_json
from weather import P_DAYS, T_DAYS

API_URL = "https://api.open-meteo.com/v1/forecast"
RESOLUTION = 4
BATCH = 50  # locations per request
PAST_DAYS = 21
FORECAST_DAYS = 16
WEEKS_AHEAD = 4
P_MIN_KNOWN = P_DAYS // 2
T_MIN_KNOWN = 4
TIMEZONE = "America/Los_Angeles"


def forecast_points(cells: list[str]) -> list[str]:
    return sorted({h3.cell_to_parent(c, RESOLUTION) for c in cells})


def fetch(points: list[str]) -> tuple[list[str], np.ndarray, np.ndarray, list[float | None]]:
    """Daily dates, precipitation and mean temperature [point, day], and each point's elevation."""
    dates: list[str] = []
    prcp, tmean, elev = [], [], []
    for start in range(0, len(points), BATCH):
        batch = points[start:start + BATCH]
        centres = [h3.cell_to_latlng(p) for p in batch]
        body = http_json(API_URL, {
            "latitude": ",".join(f"{c[0]:.4f}" for c in centres),
            "longitude": ",".join(f"{c[1]:.4f}" for c in centres),
            "daily": "precipitation_sum,temperature_2m_max,temperature_2m_min",
            "past_days": PAST_DAYS,
            "forecast_days": FORECAST_DAYS,
            "timezone": TIMEZONE,
        })
        for loc in body if isinstance(body, list) else [body]:
            daily = loc["daily"]
            dates = daily["time"]
            prcp.append([np.nan if v is None else v for v in daily["precipitation_sum"]])
            tmean.append([np.nan if a is None or b is None else (a + b) / 2
                          for a, b in zip(daily["temperature_2m_max"], daily["temperature_2m_min"])])
            elev.append(loc.get("elevation"))
    return dates, np.array(prcp, dtype=np.float64), np.array(tmean, dtype=np.float64), elev


def window(values: np.ndarray, end: int, days: int) -> tuple[np.ndarray, int]:
    """Values [point, day] over the `days` days ending with day index `end`, and how many days exist."""
    lo = max(0, end - days + 1)
    hi = min(values.shape[1], end + 1)
    return values[:, lo:hi], max(0, hi - lo)


def week_conditions(dates: list[str], prcp: np.ndarray, tmean: np.ndarray, target: date) -> dict | None:
    """p14 and t7 on `target` at every point, or None when too little of the window is known."""
    first = date.fromisoformat(dates[0])
    end = (target - first).days
    p, p_known = window(prcp, end, P_DAYS)
    t, t_known = window(tmean, end, T_DAYS)
    if p_known < P_MIN_KNOWN or t_known < T_MIN_KNOWN:
        return None
    with np.errstate(invalid="ignore"):
        p14 = np.nansum(p, axis=1) * P_DAYS / p_known
        p14[np.all(np.isnan(p), axis=1)] = np.nan
        t7 = np.nanmean(t, axis=1) if t.size else np.full(len(t), np.nan)
    return {"pKnown": p_known, "tKnown": t_known, "p14": p14, "t7": t7}


def target_days(today: date, weeks: int = WEEKS_AHEAD) -> list[tuple[int, date]]:
    """(ISO week, Thursday of that week) for this week and the next few."""
    monday = today - timedelta(days=today.weekday())
    out = []
    for n in range(weeks + 1):
        thursday = monday + timedelta(days=7 * n + 3)
        out.append((thursday.isocalendar().week, thursday))
    return out


def forecast_json(today: date, points: list[str], elev, dates, prcp, tmean) -> dict:
    def values(a, digits):
        return [None if np.isnan(v) else round(float(v), digits) for v in a]
    weeks = []
    for week, thursday in target_days(today):
        c = week_conditions(dates, prcp, tmean, thursday)
        if c is None:
            continue
        weeks.append({
            "week": week, "date": thursday.isoformat(), "pKnown": c["pKnown"], "tKnown": c["tKnown"],
            "p14": values(c["p14"], 0), "t7": values(c["t7"], 1),
        })
    return {
        "asOf": today.isoformat(), "source": "Open-Meteo", "res": RESOLUTION, "pDays": P_DAYS, "tDays": T_DAYS,
        "points": points, "elev": [None if e is None else round(e) for e in elev], "weeks": weeks,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True, help="Directory holding the generated data")
    args = parser.parse_args()
    grid = read_json(args.data / "cells.json")
    if grid is None:
        raise SystemExit("No grid yet; run pipeline/run.py first")
    points = forecast_points(grid["cells"])
    print(f"forecast: {len(points)} points")
    dates, prcp, tmean, elev = fetch(points)
    today = datetime.now(ZoneInfo(TIMEZONE)).date()
    out = forecast_json(today, points, elev, dates, prcp, tmean)
    write_json(args.data / "weather" / "forecast.json", out)
    for w in out["weeks"]:
        p = np.array([v for v in w["p14"] if v is not None])
        print(f"  week {w['week']} ({w['date']}): {w['pKnown']} of {P_DAYS} rain days known, "
              f"median rain {np.median(p) if p.size else float('nan'):.0f} mm")


if __name__ == "__main__":
    main()
