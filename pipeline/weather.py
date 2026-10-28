"""Recent weather from NOAA GHCN-Daily station records, and how it compares with the weather before past finds.

GHCN-Daily (https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily)
is free on AWS with no key or rate limit, one file per year, updated daily with a lag of two or three days.
Washington and Oregon have about 1,500 stations reporting precipitation and 400 reporting temperature.

Two measures describe the weather at a place on a day:
    p14: rain and melt water in the 14 days before, in mm (fruiting follows soaking rain);
    t7:  mean daily temperature over the 7 days before, in °C, adjusted for elevation.
Each is interpolated from the nearest stations (inverse distance squared), and temperature is moved
to the target elevation at the standard lapse rate.

For each model we compare the weather before its sightings with the weather at the same places on
the same day in other years. Where conditions before finds are more common than usual, the weather
fits; the browser then scores this week's weather in each cell against that table.
"""
from __future__ import annotations

import subprocess
import tempfile
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from common import USER_AGENT

BASE_URL = "https://noaa-ghcn-pds.s3.amazonaws.com/"
STATES = ("WA", "OR")
START_YEAR = 2008  # iNaturalist's first year
P_DAYS, P_MIN_VALID = 14, 12
T_DAYS, T_MIN_VALID = 7, 5
LAPSE_C_PER_M = 0.0065
NEIGHBOURS = 6
MAX_KM = 60.0

# Weather table bins: precipitation on a log scale, temperature in whole degrees.
P_STEP = 0.25  # bins of log(1 + mm)
P_BINS = 25  # up to about 400 mm in 14 days
T_MIN = -10
T_BINS = 46  # -10 to 35 °C
SMOOTH_BINS = 1.5
# Pseudo-sightings per bin at the usual rate, so bins with few expected sightings stay near "usual".
PRIOR_PER_BIN = 3.0
# The browser multiplies a cell's score by the lift, held between these, so usual weather leaves it unchanged.
LIFT_MIN, LIFT_MAX = 0.25, 1.5


class Stations:
    def __init__(self, ids: list[str], lat, lon, elev) -> None:
        self.ids = ids
        self.index = {s: i for i, s in enumerate(ids)}
        self.lat = np.asarray(lat, dtype=np.float64)
        self.lon = np.asarray(lon, dtype=np.float64)
        self.elev = np.asarray(elev, dtype=np.float64)


def parse_stations(text: str, states=STATES) -> Stations:
    """ghcnd-stations.txt is fixed width: id 1-11, lat 13-20, lon 22-30, elevation 32-37, state 39-40."""
    ids, lat, lon, elev = [], [], [], []
    for line in text.splitlines():
        if line[:2] != "US" or line[38:40] not in states:
            continue
        e = float(line[31:37])
        ids.append(line[:11])
        lat.append(float(line[12:20]))
        lon.append(float(line[21:30]))
        elev.append(np.nan if e <= -999 else e)
    return Stations(ids, lat, lon, elev)


def download(url: str, path: Path) -> None:
    subprocess.run(["curl", "-sSfL", "--retry", "4", "-A", USER_AGENT, "-o", str(path), url], check=True)


def load_stations(tmp: Path) -> Stations:
    path = tmp / "ghcnd-stations.txt"
    download(BASE_URL + "ghcnd-stations.txt", path)
    return parse_stations(path.read_text())


def year_lines(year: int, stations: Stations, tmp: Path) -> list[str]:
    """This year's PRCP, TMAX and TMIN rows for our stations (the file is ~150 MB for the whole world)."""
    gz = tmp / f"{year}.csv.gz"
    download(f"{BASE_URL}csv.gz/by_year/{year}.csv.gz", gz)
    ids = tmp / "ids.txt"
    ids.write_text("".join(f"{s},\n" for s in stations.ids))
    out = subprocess.run(
        f"gzip -dc '{gz}' | grep -F -f '{ids}' | grep -E '^[^,]+,[0-9]+,(PRCP|TMAX|TMIN),' || true",
        shell=True, check=True, capture_output=True, text=True,
    ).stdout
    gz.unlink()
    return out.splitlines()


class Daily:
    """Station-by-day precipitation (mm) and mean temperature (°C), NaN where missing."""

    def __init__(self, start: date, n_stations: int, n_days: int) -> None:
        self.start = start
        self.prcp = np.full((n_stations, n_days), np.nan, dtype=np.float32)
        self.tmax = np.full((n_stations, n_days), np.nan, dtype=np.float32)
        self.tmin = np.full((n_stations, n_days), np.nan, dtype=np.float32)
        self.last_day = -1

    def day(self, d: date) -> int:
        return (d - self.start).days

    def add_lines(self, lines: list[str], stations: Stations) -> None:
        arrays = {"PRCP": self.prcp, "TMAX": self.tmax, "TMIN": self.tmin}
        n_days = self.prcp.shape[1]
        for line in lines:
            # ID,YYYYMMDD,ELEMENT,VALUE,MFLAG,QFLAG,SFLAG,OBS-TIME
            f = line.split(",")
            if len(f) < 6 or f[5]:  # a quality flag means the value failed a check
                continue
            s = stations.index.get(f[0])
            if s is None:
                continue
            d = self.day(date(int(f[1][:4]), int(f[1][4:6]), int(f[1][6:8])))
            if 0 <= d < n_days:
                arrays[f[2]][s, d] = int(f[3]) / 10  # tenths of mm and tenths of °C
                self.last_day = max(self.last_day, d)

    def tmean(self) -> np.ndarray:
        return (self.tmax + self.tmin) / 2


def window_mean(values: np.ndarray, days: int, min_valid: int) -> np.ndarray:
    """out[:, d] = mean of values[:, d-days:d] (the days before d), NaN with fewer than min_valid values."""
    valid = ~np.isnan(values)
    sums = np.zeros((values.shape[0], values.shape[1] + 1))
    counts = np.zeros_like(sums)
    np.cumsum(np.where(valid, values, 0), axis=1, out=sums[:, 1:])
    np.cumsum(valid, axis=1, out=counts[:, 1:])
    out = np.full(values.shape, np.nan, dtype=np.float32)
    s = sums[:, days:-1] - sums[:, :-days - 1]
    c = counts[:, days:-1] - counts[:, :-days - 1]
    with np.errstate(invalid="ignore", divide="ignore"):
        out[:, days:] = np.where(c >= min_valid, s / c, np.nan)
    return out


def neighbours(st_lat, st_lon, lats, lons, k: int = NEIGHBOURS, max_km: float = MAX_KM):
    """The k nearest stations to each point within max_km, as (index, km) arrays; index -1 where none."""
    lats, lons = np.asarray(lats, dtype=np.float64), np.asarray(lons, dtype=np.float64)
    k = min(k, len(st_lat))
    idx = np.full((len(lats), k), -1, dtype=np.int64)
    dist = np.full((len(lats), k), np.inf)
    for a in range(0, len(lats), 4000):
        la, lo = lats[a:a + 4000, None], lons[a:a + 4000, None]
        # Equirectangular distance is accurate to well under 1% at these ranges.
        x = np.radians(st_lon[None, :] - lo) * np.cos(np.radians((st_lat[None, :] + la) / 2))
        y = np.radians(st_lat[None, :] - la)
        km = 6371 * np.sqrt(x * x + y * y)
        near = np.argpartition(km, k - 1, axis=1)[:, :k]
        nk = np.take_along_axis(km, near, axis=1)
        nk_ok = nk <= max_km
        idx[a:a + 4000] = np.where(nk_ok, near, -1)
        dist[a:a + 4000] = np.where(nk_ok, nk, np.inf)
    return idx, dist


def interpolate(field: np.ndarray, nb_idx, nb_km, days, adjust=None) -> np.ndarray:
    """Inverse-distance-squared mean of field[station, day] over each point's valid neighbours."""
    days = np.asarray(days)
    safe = np.where(nb_idx >= 0, nb_idx, 0)
    inside = (days >= 0) & (days < field.shape[1])
    vals = field[safe, np.clip(days, 0, field.shape[1] - 1)[:, None]].astype(np.float64)
    if adjust is not None:
        vals = vals + adjust
    ok = (nb_idx >= 0) & ~np.isnan(vals) & inside[:, None]
    w = np.where(ok, 1 / (nb_km + 2.0) ** 2, 0)  # +2 km so a station on the spot does not take all weight
    total = w.sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(total > 0, (w * np.where(ok, vals, 0)).sum(axis=1) / total, np.nan)


def current_json(as_of: date, p14, t7) -> dict:
    """Recent weather per grid cell, as served to the browser."""
    def values(a, digits):
        return [None if np.isnan(v) else round(float(v), digits) for v in a]
    return {"asOf": as_of.isoformat(), "pDays": P_DAYS, "tDays": T_DAYS, "p14": values(p14, 0), "t7": values(t7, 1)}


class Weather:
    """Everything needed to describe the weather at any place and day since START_YEAR."""

    def __init__(self, stations: Stations, daily: Daily) -> None:
        self.stations = stations
        self.daily = daily
        self.p14 = window_mean(daily.prcp, P_DAYS, P_MIN_VALID) * P_DAYS
        self.t7 = window_mean(daily.tmean(), T_DAYS, T_MIN_VALID)
        has_p = ~np.all(np.isnan(daily.prcp), axis=1)
        has_t = ~np.all(np.isnan(daily.tmax), axis=1)
        self.p_st = np.flatnonzero(has_p)
        self.t_st = np.flatnonzero(has_t)
        del daily.tmax, daily.tmin  # free memory; t7 holds what we need

    @property
    def as_of(self) -> date:
        """The last day with any data; conditions are measured over the days before it, ending with it."""
        return self.daily.start + timedelta(days=self.daily.last_day)

    def conditions(self, lats, lons, elevs, days) -> tuple[np.ndarray, np.ndarray]:
        """(p14 mm, t7 °C) at each point on each day index (the window ends the day before)."""
        st = self.stations
        pi, pk = neighbours(st.lat[self.p_st], st.lon[self.p_st], lats, lons)
        p = interpolate(self.p14[self.p_st], pi, pk, days)
        ti, tk = neighbours(st.lat[self.t_st], st.lon[self.t_st], lats, lons)
        t_elev = st.elev[self.t_st][np.where(ti >= 0, ti, 0)]
        elevs = np.asarray(elevs, dtype=np.float64)[:, None]
        adjust = np.where(np.isnan(t_elev) | np.isnan(elevs), 0, (t_elev - elevs) * LAPSE_C_PER_M)
        t = interpolate(self.t7[self.t_st], ti, tk, days, adjust)
        return p, t

    def sighting_conditions(self, rows: list[list]) -> dict[int, tuple[float, float, list[tuple[float, float]]]]:
        """For each sighting id: (p14, t7) before it, and the same measures on the same date in every other year."""
        rows = [r for r in rows if r[5] is not None and int(r[1][:4]) >= self.daily.start.year]
        if not rows:
            return {}
        years = list(range(self.daily.start.year, self.as_of.year + 1))
        lats, lons, elevs, days, owner = [], [], [], [], []
        for n, r in enumerate(rows):
            y, m, d = (int(x) for x in r[1].split("-"))
            for yr in [y] + [v for v in years if v != y]:
                when = date(yr, m, min(d, 28) if m == 2 else d)
                day = self.daily.day(when) + 1  # include the find day itself: window ends the day of the find
                if day > self.daily.last_day + 1:
                    continue
                lats.append(r[2])
                lons.append(r[3])
                elevs.append(r[5])
                days.append(day)
                owner.append(n if yr == y else -1 - n)
        p, t = self.conditions(lats, lons, elevs, days)
        out: dict[int, tuple[float, float, list]] = {}
        for o, pv, tv in zip(owner, p, t):
            if np.isnan(pv) or np.isnan(tv):
                continue
            n = o if o >= 0 else -1 - o
            entry = out.setdefault(rows[n][0], [None, None, []])
            if o >= 0:
                entry[0], entry[1] = float(pv), float(tv)
            else:
                entry[2].append((float(pv), float(tv)))
        return {k: (v[0], v[1], v[2]) for k, v in out.items() if v[0] is not None and v[2]}

    def current(self, lats, lons, elevs) -> tuple[np.ndarray, np.ndarray]:
        """(p14, t7) for each point over the latest days with data."""
        days = np.full(len(lats), self.daily.last_day + 1)
        return self.conditions(lats, lons, elevs, days)


def load_weather(start_year: int = START_YEAR, today: date | None = None) -> Weather:
    today = today or date.today()
    with tempfile.TemporaryDirectory() as t:
        tmpdir = Path(t)
        stations = load_stations(tmpdir)
        start = date(start_year, 1, 1)
        # One spare day so the window ending on the last day with data can be indexed.
        daily = Daily(start, len(stations.ids), (today - start).days + 2)
        print(f"weather: {len(stations.ids)} GHCN stations in {', '.join(STATES)}")
        for year in range(start_year, today.year + 1):
            lines = year_lines(year, stations, tmpdir)
            daily.add_lines(lines, stations)
            print(f"  {year}: {len(lines)} station-days")
        return Weather(stations, daily)


def p_bin(p) -> np.ndarray:
    return np.clip(np.round(np.log1p(np.maximum(p, 0)) / P_STEP), 0, P_BINS - 1).astype(int)


def t_bin(t) -> np.ndarray:
    return np.clip(np.round(np.asarray(t)) - T_MIN, 0, T_BINS - 1).astype(int)


def _smooth(h: np.ndarray) -> np.ndarray:
    r = int(np.ceil(3 * SMOOTH_BINS))
    k = np.exp(-np.arange(-r, r + 1) ** 2 / (2 * SMOOTH_BINS ** 2))
    k /= k.sum()
    h = np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 0, h)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 1, h)


def histogram(points: list[tuple[float, float]]) -> np.ndarray:
    h = np.zeros((P_BINS, T_BINS))
    if points:
        p, t = np.array(points).T
        np.add.at(h, (p_bin(p), t_bin(t)), 1)
    return h


def weather_table(finds: list[tuple[float, float]], background: list[tuple[float, float]]) -> list[list[int]]:
    """Lift in percent per (precipitation bin, temperature bin): how much more often finds follow such
    weather than the same places and dates do in other years (100 = usual, 200 = twice as often)."""
    f = _smooth(histogram(finds))
    b = _smooth(histogram(background))
    if b.sum() == 0:
        return np.full((P_BINS, T_BINS), 100).tolist()
    # Sightings expected in each bin if finds ignored the weather, then the observed/expected ratio,
    # shrunk toward 1 where few are expected.
    expected = b / b.sum() * f.sum()
    lift = (f + PRIOR_PER_BIN) / (expected + PRIOR_PER_BIN)
    return np.round(100 * np.clip(lift, 0, 2)).astype(int).tolist()


def weather_model(conds: dict, ids) -> dict | None:
    """The weather part of a model for the sightings with these ids."""
    finds, background = [], []
    for i in ids:
        c = conds.get(i)
        if c:
            finds.append((c[0], c[1]))
            background.extend(c[2])
    if not finds:
        return None
    return {
        "min": LIFT_MIN, "max": LIFT_MAX, "pStep": P_STEP, "tMin": T_MIN, "count": len(finds),
        "table": weather_table(finds, background),
    }
