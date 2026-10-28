import sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import forecast as F  # noqa: E402


def dates(start: date, n: int) -> list[str]:
    return [date.fromordinal(start.toordinal() + i).isoformat() for i in range(n)]


def test_target_days_are_thursdays_of_coming_weeks():
    days = F.target_days(date(2026, 10, 28), weeks=2)  # a Wednesday in ISO week 44
    assert days == [(44, date(2026, 10, 29)), (45, date(2026, 11, 5)), (46, date(2026, 11, 12))]


def test_week_conditions_sums_rain_and_averages_temperature():
    d = dates(date(2026, 10, 1), 30)
    prcp = np.ones((2, 30))
    prcp[1, :] = np.nan
    tmean = np.tile(np.arange(30, dtype=float), (2, 1))
    c = F.week_conditions(d, prcp, tmean, date(2026, 10, 20))  # day index 19
    assert c["pKnown"] == 14 and c["tKnown"] == 7
    assert c["p14"][0] == 14
    assert np.isnan(c["p14"][1])
    assert c["t7"][0] == np.mean(np.arange(13, 20))


def test_week_conditions_scales_partly_known_rain_and_gives_up_when_too_little():
    d = dates(date(2026, 10, 1), 30)
    prcp = np.full((1, 30), 2.0)
    tmean = np.zeros((1, 30))
    c = F.week_conditions(d, prcp, tmean, date(2026, 11, 2))  # 3 days past the end: 11 of 14 known
    assert c["pKnown"] == 11 and c["p14"][0] == 28
    assert F.week_conditions(d, prcp, tmean, date(2026, 11, 10)) is None
