"""
Tests for ghl_icp_export.py's pure extraction logic — the client-ICP CSV
export (12/09/2026). No real GHL API calls needed for any of these; the
module's own docstring records the two real findings (qualification/sales
call is a pipeline STAGE NAME, not a tag; GHL's opportunity object has no
true call count) that these tests hold it to.
"""
from datetime import datetime, timezone

import ghl_icp_export as icp


SALES_PIPELINE = {
    "id": "p1", "name": "Sales Pipeline",
    "stages": [
        {"id": "s1", "name": "Qualification Call Booked"},
        {"id": "s2", "name": "Qualification Call Taken (No SC)"},
        {"id": "s3", "name": "Sales Call Booked"},
        {"id": "s4", "name": "Sales Call Taken"},
        {"id": "s5", "name": "Closed Won"},
    ],
}
PODCAST_PIPELINE = {
    "id": "p2", "name": "ICONS Podcast",
    "stages": [
        {"id": "t1", "name": "Second Sales Call Taken"},
        {"id": "t2", "name": "Closed won"},
        {"id": "t3", "name": "Closed lost"},
    ],
}


def _opp(contact_id, stage_id, created="2026-01-01T00:00:00.000Z", updated="2026-01-05T00:00:00.000Z"):
    return {"contactId": contact_id, "pipelineStageId": stage_id, "createdAt": created, "updatedAt": updated}


class TestNormalize:
    def test_normalize_email_lowercases_and_strips(self):
        assert icp.normalize_email_("  Jane.Doe@Example.COM  ") == "jane.doe@example.com"

    def test_normalize_email_handles_none(self):
        assert icp.normalize_email_(None) == ""

    def test_normalize_phone_keeps_digits_only(self):
        assert icp.normalize_phone_("+1 (555) 123-4567") == "15551234567"

    def test_normalize_phone_handles_none(self):
        assert icp.normalize_phone_(None) == ""


class TestClassifyPipelineStages:
    def test_matches_qualification_and_sales_call_stages_case_insensitively(self):
        lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        assert lookup["s1"]["is_qualification"] is True
        assert lookup["s2"]["is_qualification"] is True
        assert lookup["s3"]["is_sales_call"] is True
        assert lookup["s4"]["is_sales_call"] is True
        assert lookup["s1"]["is_sales_call"] is False
        assert lookup["s3"]["is_qualification"] is False

    def test_matches_closed_won_and_closed_lost_regardless_of_case(self):
        lookup = icp.classify_pipeline_stages_([PODCAST_PIPELINE])
        assert lookup["t2"]["is_closed_won"] is True  # "Closed won" (lowercase w)
        assert lookup["t3"]["is_closed_lost"] is True

    def test_a_second_sales_call_stage_still_counts_as_sales_call(self):
        lookup = icp.classify_pipeline_stages_([PODCAST_PIPELINE])
        assert lookup["t1"]["is_sales_call"] is True

    def test_carries_pipeline_id_and_name_alongside_each_stage(self):
        lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        assert lookup["s1"]["pipeline_id"] == "p1"
        assert lookup["s1"]["pipeline_name"] == "Sales Pipeline"

    def test_handles_multiple_pipelines_at_once(self):
        lookup = icp.classify_pipeline_stages_([SALES_PIPELINE, PODCAST_PIPELINE])
        assert "s1" in lookup and "t1" in lookup


class TestGroupOpportunitiesByContact:
    def test_groups_multiple_opportunities_under_the_same_contact(self):
        opps = [_opp("c1", "s1"), _opp("c1", "s3"), _opp("c2", "s1")]
        grouped = icp.group_opportunities_by_contact_(opps)
        assert len(grouped["c1"]) == 2
        assert len(grouped["c2"]) == 1

    def test_skips_an_opportunity_with_no_contact_id(self):
        grouped = icp.group_opportunities_by_contact_([{"pipelineStageId": "s1"}])
        assert grouped == {}

    def test_empty_input_returns_empty_dict(self):
        assert icp.group_opportunities_by_contact_([]) == {}
        assert icp.group_opportunities_by_contact_(None) == {}


class TestBuildContactIcpRow:
    NOW = datetime(2026, 9, 12, tzinfo=timezone.utc)

    def _contact(self, **overrides):
        base = {"id": "c1", "firstNameRaw": "Jane", "lastNameRaw": "Doe",
                "email": "Jane@Example.com", "phone": "555-123-4567", "dateUpdated": "2026-01-01T00:00:00.000Z"}
        base.update(overrides)
        return base

    def test_a_contact_with_zero_opportunities_gets_zero_counts_not_dropped(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        row = icp.build_contact_icp_row_(self._contact(), [], stage_lookup, now=self.NOW)
        assert row["qualification_call_count"] == 0
        assert row["sales_call_count"] == 0
        assert row["total_call_count"] == 0
        assert row["opportunity_count"] == 0
        assert row["first_call_date"] == ""
        assert row["converted"] is False
        assert row["close_date"] == ""
        assert row["lost_date"] == ""
        assert row["pipeline_name"] == ""
        assert row["pipeline_stage"] == ""

    def test_zero_opportunity_contact_falls_back_to_the_contact_s_own_dateUpdated_for_activity(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        row = icp.build_contact_icp_row_(self._contact(dateUpdated="2026-08-01T00:00:00.000Z"), [], stage_lookup, now=self.NOW)
        assert row["days_since_last_activity"] == (self.NOW - datetime(2026, 8, 1, tzinfo=timezone.utc)).days

    def test_email_and_phone_are_normalized_in_the_row(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        row = icp.build_contact_icp_row_(self._contact(), [], stage_lookup, now=self.NOW)
        assert row["email"] == "jane@example.com"
        assert row["phone"] == "5551234567"

    def test_full_name_prefers_raw_cased_first_last(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        row = icp.build_contact_icp_row_(self._contact(), [], stage_lookup, now=self.NOW)
        assert row["full_name"] == "Jane Doe"

    def test_full_name_falls_back_to_contactName_when_no_first_last(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        contact = self._contact(firstNameRaw=None, lastNameRaw=None, firstName=None, lastName=None, contactName="Jane Doe Jr")
        row = icp.build_contact_icp_row_(contact, [], stage_lookup, now=self.NOW)
        assert row["full_name"] == "Jane Doe Jr"

    def test_qualification_call_count_is_a_01_flag_not_a_true_count(self):
        # Two separate qualification-matching opportunities must still read as 1, not 2 --
        # see this file's own header for why a true count isn't available from opportunities.
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        opps = [_opp("c1", "s1"), _opp("c1", "s2")]
        row = icp.build_contact_icp_row_(self._contact(), opps, stage_lookup, now=self.NOW)
        assert row["qualification_call_count"] == 1
        assert row["sales_call_count"] == 0
        assert row["total_call_count"] == 1
        assert row["opportunity_count"] == 2

    def test_reaching_both_qualification_and_sales_call_stages_gives_total_2(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        opps = [_opp("c1", "s1"), _opp("c1", "s4")]
        row = icp.build_contact_icp_row_(self._contact(), opps, stage_lookup, now=self.NOW)
        assert row["qualification_call_count"] == 1
        assert row["sales_call_count"] == 1
        assert row["total_call_count"] == 2

    def test_converted_true_and_close_date_set_once_a_closed_won_opportunity_exists(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        opps = [_opp("c1", "s4", updated="2026-02-01T00:00:00.000Z"),
                _opp("c1", "s5", updated="2026-02-10T00:00:00.000Z")]
        row = icp.build_contact_icp_row_(self._contact(), opps, stage_lookup, now=self.NOW)
        assert row["converted"] is True
        assert row["close_date"] == "2026-02-10"

    def test_lost_date_only_comes_from_a_real_closed_lost_stage_never_fabricated(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])  # no Closed-lost stage at all
        opps = [_opp("c1", "s4", updated="2026-02-01T00:00:00.000Z")]
        row = icp.build_contact_icp_row_(self._contact(), opps, stage_lookup, now=self.NOW)
        assert row["lost_date"] == "", "must stay blank, not guess a lost date the pipeline has no concept of"

    def test_lost_date_is_set_when_a_closed_lost_stage_is_actually_reached(self):
        stage_lookup = icp.classify_pipeline_stages_([PODCAST_PIPELINE])
        opps = [_opp("c1", "t3", updated="2026-03-15T00:00:00.000Z")]
        row = icp.build_contact_icp_row_(self._contact(), opps, stage_lookup, now=self.NOW)
        assert row["lost_date"] == "2026-03-15"
        assert row["converted"] is False

    def test_unions_opportunities_across_multiple_pipelines_for_one_contact(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE, PODCAST_PIPELINE])
        opps = [_opp("c1", "s1"), _opp("c1", "t1")]  # qualification in pipeline 1, sales call in pipeline 2
        row = icp.build_contact_icp_row_(self._contact(), opps, stage_lookup, now=self.NOW)
        assert row["qualification_call_count"] == 1
        assert row["sales_call_count"] == 1
        assert row["opportunity_count"] == 2

    def test_pipeline_name_and_stage_reflect_the_most_recently_updated_opportunity(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE, PODCAST_PIPELINE])
        opps = [
            _opp("c1", "s1", updated="2026-01-01T00:00:00.000Z"),
            _opp("c1", "t1", updated="2026-06-01T00:00:00.000Z"),
        ]
        row = icp.build_contact_icp_row_(self._contact(), opps, stage_lookup, now=self.NOW)
        assert row["pipeline_name"] == "ICONS Podcast"
        assert row["pipeline_stage"] == "Second Sales Call Taken"

    def test_first_call_date_is_the_earliest_opportunity_created_date(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        opps = [_opp("c1", "s1", created="2026-03-01T00:00:00.000Z"),
                _opp("c1", "s4", created="2026-01-15T00:00:00.000Z")]
        row = icp.build_contact_icp_row_(self._contact(), opps, stage_lookup, now=self.NOW)
        assert row["first_call_date"] == "2026-01-15"

    def test_an_unresolvable_stage_id_is_skipped_rather_than_crashing(self):
        stage_lookup = icp.classify_pipeline_stages_([SALES_PIPELINE])
        opps = [_opp("c1", "does-not-exist-in-any-pipeline")]
        row = icp.build_contact_icp_row_(self._contact(), opps, stage_lookup, now=self.NOW)
        assert row["opportunity_count"] == 1  # still counted as a real opportunity
        assert row["qualification_call_count"] == 0
        assert row["pipeline_name"] == ""  # but contributes nothing resolvable


class TestBuildIcpRows:
    def test_includes_a_zero_opportunity_contact_alongside_one_with_data(self):
        stage_lookup_pipelines = [SALES_PIPELINE]
        contacts = [
            {"id": "c1", "firstNameRaw": "No", "lastNameRaw": "Calls", "email": "no@example.com"},
            {"id": "c2", "firstNameRaw": "Has", "lastNameRaw": "Calls", "email": "has@example.com"},
        ]
        opps = [_opp("c2", "s1")]
        rows = icp.build_icp_rows_(contacts, opps, stage_lookup_pipelines, now=datetime(2026, 9, 12, tzinfo=timezone.utc))
        assert len(rows) == 2
        by_id = {r["contact_id"]: r for r in rows}
        assert by_id["c1"]["opportunity_count"] == 0
        assert by_id["c2"]["opportunity_count"] == 1

    def test_empty_contact_list_returns_empty_rows(self):
        assert icp.build_icp_rows_([], [], [SALES_PIPELINE]) == []


class TestWriteIcpCsv:
    def test_writes_header_and_rows_in_the_documented_column_order(self, tmp_path):
        rows = [{col: "" for col in icp.CSV_COLUMNS}]
        rows[0]["contact_id"] = "c1"
        rows[0]["full_name"] = "Jane Doe"
        out = tmp_path / "export.csv"
        icp.write_icp_csv_(rows, str(out))
        text = out.read_text()
        lines = text.strip("\n").split("\n")
        assert lines[0] == ",".join(icp.CSV_COLUMNS)
        assert lines[1].startswith("c1,Jane Doe,")

    def test_writes_nothing_but_a_header_for_zero_rows(self, tmp_path):
        out = tmp_path / "export.csv"
        icp.write_icp_csv_([], str(out))
        lines = out.read_text().strip("\n").split("\n")
        assert lines == [",".join(icp.CSV_COLUMNS)]
