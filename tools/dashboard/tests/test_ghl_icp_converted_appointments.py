"""
Tests for ghl_icp_converted_appointments.py's pure logic -- the fix for a
real bug found in the first real export (12/09/2026): opportunity
pipelineStageId gets overwritten as a deal advances, so a converted
opportunity's CURRENT stage is always "Closed Won," never the
qualification/sales-call stage it actually passed through on the way
there (confirmed live: 56/60 real converted contacts read as "reached
neither stage" under that approach). Appointments are real per-event
records instead, so these counts can be TRUE counts, not 0/1 flags.
"""
import ghl_icp_converted_appointments as appts


class TestClassifyAppointment:
    def test_matches_qualification_call_in_the_title(self):
        result = appts.classify_appointment_({"title": "Qualification Call w/ Jane Doe"})
        assert result == {"is_qualification": True, "is_sales_call": False}

    def test_matches_sales_call_in_the_title(self):
        result = appts.classify_appointment_({"title": "Sales Call - Jane Doe"})
        assert result == {"is_qualification": False, "is_sales_call": True}

    def test_falls_back_to_calendar_name_when_no_title(self):
        result = appts.classify_appointment_({"calendarName": "Qualification Calls"})
        assert result["is_qualification"] is True

    def test_falls_back_to_name_when_no_title_or_calendar_name(self):
        result = appts.classify_appointment_({"name": "Sales Call"})
        assert result["is_sales_call"] is True

    def test_neither_matches_when_no_recognizable_text_at_all(self):
        result = appts.classify_appointment_({})
        assert result == {"is_qualification": False, "is_sales_call": False}

    def test_case_insensitive_match(self):
        result = appts.classify_appointment_({"title": "SALES CALL"})
        assert result["is_sales_call"] is True

    def test_starting_a_podcast_counts_as_a_sales_call(self):
        # Real title sampled live (12/09/2026), ICONS Podcast funnel's real
        # closing call -- confirmed with Kris it functions as the sales call
        # despite the non-literal title.
        result = appts.classify_appointment_({"title": "Starting A Podcast / Amanda LeGault and  Tomas"})
        assert result == {"is_qualification": False, "is_sales_call": True}

    def test_podcast_qualification_call_still_matches_qualification(self):
        # Real title sampled live: "Podcast Qualification Call / ..." --
        # substring match on "Qualification Call" must still fire.
        result = appts.classify_appointment_({"title": "Podcast Qualification Call / Amanda LeGault and ICONS of Real Estate"})
        assert result == {"is_qualification": True, "is_sales_call": False}


class TestSummarizeContactAppointments:
    def test_zero_appointments_gives_zero_counts_and_blank_date(self):
        summary = appts.summarize_contact_appointments_([])
        assert summary == {
            "appointment_count": 0, "qualification_call_count": 0,
            "sales_call_count": 0, "first_appointment_date": "",
        }

    def test_counts_are_true_counts_not_01_flags(self):
        # Real distinction from ghl_icp_export.py's opportunity-stage-based
        # flags -- two real qualification call appointments must count as 2.
        appointments = [
            {"title": "Qualification Call", "startTime": "2026-01-01T00:00:00Z"},
            {"title": "Qualification Call (Reschedule)", "startTime": "2026-01-15T00:00:00Z"},
            {"title": "Sales Call", "startTime": "2026-02-01T00:00:00Z"},
        ]
        summary = appts.summarize_contact_appointments_(appointments)
        assert summary["qualification_call_count"] == 2
        assert summary["sales_call_count"] == 1
        assert summary["appointment_count"] == 3

    def test_first_appointment_date_is_the_earliest_regardless_of_list_order(self):
        appointments = [
            {"title": "Sales Call", "startTime": "2026-03-01T00:00:00Z"},
            {"title": "Qualification Call", "startTime": "2026-01-01T00:00:00Z"},
        ]
        summary = appts.summarize_contact_appointments_(appointments)
        assert summary["first_appointment_date"] == "2026-01-01T00:00:00Z"

    def test_tolerates_appointments_with_no_date_field_at_all(self):
        appointments = [{"title": "Qualification Call"}]
        summary = appts.summarize_contact_appointments_(appointments)
        assert summary["first_appointment_date"] == ""
        assert summary["qualification_call_count"] == 1

    def test_unclassifiable_appointments_still_count_toward_appointment_count(self):
        appointments = [{"title": "Follow-up chat"}, {"title": "Qualification Call"}]
        summary = appts.summarize_contact_appointments_(appointments)
        assert summary["appointment_count"] == 2
        assert summary["qualification_call_count"] == 1
        assert summary["sales_call_count"] == 0
