import sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import weather as W  # noqa: E402

STATIONS_TXT = "\n".join([
    "US1WAKG0001  47.6000 -122.3000   50.0 WA SEATTLE 1                                ",
    "USC00350001  45.5000 -122.6000  100.0 OR PORTLAND                                 ",
    "USC00100001  43.6000 -116.2000  800.0 ID BOISE                                    ",
    "CA001000001  49.0000 -123.0000   10.0 BC VANCOUVER                                ",
])


def test_parse_stations_keeps_wa_and_or():
    st = W.parse_stations(STATIONS_TXT)
    assert st.ids == ["US1WAKG0001", "USC00350001"]
    assert st.lat[1] == 45.5 and st.elev[1] == 100


def test_add_lines_skips_flagged_values():
    st = W.parse_stations(STATIONS_TXT)
    daily = W.Daily(date(2026, 1, 1), 2, 10)
    daily.add_lines([
        "USC00350001,20260102,PRCP,125,,,H,0800",
        "USC00350001,20260102,TMAX,101,,,H,0800",
        "USC00350001,20260102,TMIN,-21,,,H,0800",
        "USC00350001,20260103,PRCP,99999,,X,H,0800",  # failed a quality check
        "USC99999999,20260102,PRCP,10,,,H,0800",  # not one of ours
    ], st)
    assert daily.prcp[1, 1] == np.float32(12.5)
    assert np.isnan(daily.prcp[1, 2])
    assert daily.tmean()[1, 1] == np.float32(4.0)
    assert daily.last_day == 1


def test_window_mean_uses_days_before_and_needs_enough_values():
    v = np.array([[1, 2, 3, 4, np.nan, 6, 7]], dtype=np.float32)
    out = W.window_mean(v, 3, 2)
    assert np.isnan(out[0, :3]).all()
    assert out[0, 3] == 2  # mean of days 0..2
    assert out[0, 5] == 3.5  # days 2..4, one missing
    v2 = np.array([[np.nan, np.nan, 1, np.nan]], dtype=np.float32)
    assert np.isnan(W.window_mean(v2, 3, 2)[0, 3])


def test_neighbours_and_interpolation():
    st_lat, st_lon = np.array([45.0, 45.0, 47.0]), np.array([-122.0, -122.1, -122.0])
    idx, km = W.neighbours(st_lat, st_lon, [45.0], [-122.05], k=3, max_km=50)
    assert sorted(idx[0][idx[0] >= 0].tolist()) == [0, 1]  # the third is ~220 km away
    field = np.array([[10.0], [20.0], [99.0]])
    assert abs(W.interpolate(field, idx, km, [0])[0] - 15) < 1e-9  # equidistant
    field[0, 0] = np.nan
    assert W.interpolate(field, idx, km, [0])[0] == 20  # falls back to the valid station
    assert np.isnan(W.interpolate(field, idx, km, [1])[0])  # day past the data


def make_weather(rain_on_find_days=True):
    st = W.parse_stations(STATIONS_TXT)
    daily = W.Daily(date(2024, 1, 1), 2, 3 * 366 + 2)
    rng = np.random.default_rng(1)
    daily.prcp[:] = rng.uniform(0, 1, daily.prcp.shape)
    daily.tmax[:] = 15
    daily.tmin[:] = 5
    if rain_on_find_days:
        d = daily.day(date(2025, 10, 10))
        daily.prcp[:, d - 10:d] = 10  # a soaking before the 2025 finds
    daily.last_day = daily.prcp.shape[1] - 3
    return W.Weather(st, daily)


def test_sighting_conditions_compares_with_other_years():
    wx = make_weather()
    rows = [[7, "2025-10-10", 45.5, -122.6, "Cantharellus formosus", 100]]
    c = wx.sighting_conditions(rows)
    p, t, background = c[7]
    assert p > 100 and t == 10
    assert len(background) == 2 and all(b[0] < 20 for b in background)
    # Higher elevation is cooler.
    p2, t2, _ = wx.sighting_conditions([[8, "2025-10-10", 45.5, -122.6, "x", 1100]])[8]
    assert abs(t2 - (10 - 6.5)) < 0.01


def test_weather_table_lifts_conditions_seen_before_finds():
    finds = [(100.0, 10.0)] * 200
    background = [(5.0, 10.0)] * 400 + [(100.0, 10.0)] * 100
    table = np.array(W.weather_table(finds, background))
    assert table.shape == (W.P_BINS, W.T_BINS)
    wet, dry = W.p_bin(100.0), W.p_bin(5.0)
    assert table[wet, W.t_bin(10)] > 150
    assert table[dry, W.t_bin(10)] < 50
    assert table[0, W.t_bin(34)] == 100  # nothing expected or seen: usual


def test_weather_model_and_current_json():
    assert W.weather_model({}, [1]) is None
    m = W.weather_model({1: (50.0, 9.0, [(20.0, 9.0)])}, [1, 2])
    assert m["count"] == 1 and (m["min"], m["max"]) == (W.LIFT_MIN, W.LIFT_MAX)
    j = W.current_json(date(2026, 10, 25), np.array([12.4, np.nan]), np.array([8.26, 3.0]))
    assert j == {"asOf": "2026-10-25", "pDays": 14, "tDays": 7, "p14": [12.0, None], "t7": [8.3, 3.0]}
