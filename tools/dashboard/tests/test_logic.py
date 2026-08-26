"""
Unit tests for app.py's pure date/bucketing helpers — no database needed.
These back the score-over-time chart's x-axis; _all_bucket_keys in
particular is the fix for the "hard to read, jams March next to November"
bug reported live, so it's worth pinning down hard.
"""
from datetime import date

import app as app_module


class TestParseCallDate:
    def test_project_convention_ddmmyyyy(self):
        # 05/08/2026 must be 5 August, not May 8th (brief.txt §2).
        assert app_module.parse_call_date("05/08/2026") == date(2026, 8, 5)

    def test_iso_format(self):
        assert app_module.parse_call_date("2026-08-05") == date(2026, 8, 5)

    def test_ddmmyyyy_with_time(self):
        assert app_module.parse_call_date("05/08/2026 14:30:00") == date(2026, 8, 5)

    def test_mmddyyyy_with_time_fallback(self):
        # 25 can't be a month, so the DD/MM-with-time pattern fails to parse
        # and this only succeeds via the MM/DD-with-time fallback pattern.
        assert app_module.parse_call_date("08/25/2026 14:30:00") == date(2026, 8, 25)

    def test_empty_and_none_return_none(self):
        assert app_module.parse_call_date("") is None
        assert app_module.parse_call_date(None) is None

    def test_garbage_returns_none_not_raises(self):
        assert app_module.parse_call_date("not a date") is None

    def test_strips_whitespace(self):
        assert app_module.parse_call_date("  05/08/2026  ") == date(2026, 8, 5)

    def test_iso_datetime_with_space_separator(self):
        # Real bug (P5): a genuine datetime-valued cell (not date-only) can
        # come back space-separated rather than slash-separated.
        assert app_module.parse_call_date("2026-08-05 14:30:00") == date(2026, 8, 5)

    def test_iso_datetime_with_t_separator(self):
        assert app_module.parse_call_date("2026-08-05T14:30:00") == date(2026, 8, 5)


class TestIntOrNone:
    def test_blank_string_is_none_not_a_422(self):
        # Real bug (P1): a filter form submits min_score=/max_score= (empty
        # string) when the field is left blank, not an omitted param —
        # FastAPI would reject that with a 422 if the route param were typed
        # as `int`, so calls_page takes `str` and converts through this.
        assert app_module._int_or_none("") is None
        assert app_module._int_or_none(None) is None

    def test_valid_digits_convert(self):
        assert app_module._int_or_none("3") == 3

    def test_garbage_is_none_not_raises(self):
        assert app_module._int_or_none("not a number") is None


class TestMonthAdd:
    def test_within_year(self):
        assert app_module._month_add(2026, 3, 1) == (2026, 4)

    def test_rolls_into_next_year(self):
        assert app_module._month_add(2026, 12, 1) == (2027, 1)

    def test_rolls_back_into_previous_year(self):
        assert app_module._month_add(2026, 1, -1) == (2025, 12)


class TestBucketKeyAndLabel:
    def test_day(self):
        key, label = app_module._bucket_key_and_label(date(2026, 8, 5), "day")
        assert key == (2026, 8, 5)
        assert label == "Aug 05"

    def test_month(self):
        key, label = app_module._bucket_key_and_label(date(2026, 8, 5), "month")
        assert key == (2026, 8)
        assert label == "Aug 2026"

    def test_year(self):
        key, label = app_module._bucket_key_and_label(date(2026, 8, 5), "year")
        assert key == (2026,)
        assert label == "2026"

    def test_all(self):
        key, label = app_module._bucket_key_and_label(date(2026, 8, 5), "all")
        assert key == (0,)
        assert label == "All time"

    def test_week_buckets_to_monday(self):
        # Wed 05 Aug 2026 -> week starting Mon 03 Aug 2026
        key, label = app_module._bucket_key_and_label(date(2026, 8, 5), "week")
        assert key == (2026, 8, 3)
        assert label == "Wk of Aug 03"

    def test_week_on_a_monday_is_its_own_start(self):
        key, _ = app_module._bucket_key_and_label(date(2026, 8, 3), "week")
        assert key == (2026, 8, 3)


class TestAllBucketKeys:
    def test_all_granularity_ignores_the_date_range(self):
        keys = app_module._all_bucket_keys(date(2026, 1, 1), date(2026, 12, 31), "all")
        assert keys == [((0,), "All time")]

    def test_day_granularity_includes_every_day_even_with_no_data(self):
        keys = app_module._all_bucket_keys(date(2026, 8, 1), date(2026, 8, 5), "day")
        assert [label for _, label in keys] == [
            "Aug 01", "Aug 02", "Aug 03", "Aug 04", "Aug 05",
        ]

    def test_week_granularity_fills_gaps_between_distant_weeks(self):
        # This is the exact bug the team reported: a week in March next to
        # a week in November must not collapse into two adjacent buckets —
        # every week in between must appear, even though nothing happened
        # in most of them.
        keys = app_module._all_bucket_keys(date(2026, 3, 2), date(2026, 4, 6), "week")
        labels = [label for _, label in keys]
        assert labels == [
            "Wk of Mar 02", "Wk of Mar 09", "Wk of Mar 16",
            "Wk of Mar 23", "Wk of Mar 30", "Wk of Apr 06",
        ]

    def test_month_granularity_rolls_across_year_boundary(self):
        keys = app_module._all_bucket_keys(date(2025, 11, 15), date(2026, 2, 1), "month")
        labels = [label for _, label in keys]
        assert labels == ["Nov 2025", "Dec 2025", "Jan 2026", "Feb 2026"]

    def test_year_granularity_spans_multiple_years(self):
        keys = app_module._all_bucket_keys(date(2024, 6, 1), date(2026, 1, 1), "year")
        labels = [label for _, label in keys]
        assert labels == ["2024", "2025", "2026"]

    def test_single_day_range_returns_one_bucket(self):
        keys = app_module._all_bucket_keys(date(2026, 8, 5), date(2026, 8, 5), "day")
        assert len(keys) == 1
