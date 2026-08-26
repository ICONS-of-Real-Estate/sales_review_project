"""
Unit tests for auth.py's access-control decision (denial_reason_) and
app.py's fail-closed startup check on DASHBOARD_SESSION_SECRET.

Real bug (M-06): both DASHBOARD_ALLOWED_EMAILS and DASHBOARD_SESSION_SECRET
used to fail OPEN when unset on a fresh/rebuilt deployment — an empty
allowlist let anyone in the Workspace domain log in, and a missing session
secret silently fell back to a hardcoded, public, checked-into-the-repo
string. Both must now fail CLOSED.
"""
import os
import subprocess
import sys
from pathlib import Path

import auth

DASHBOARD_DIR = Path(__file__).resolve().parent.parent


class TestDenialReason:
    def test_wrong_domain_is_denied_regardless_of_allowlist(self, monkeypatch):
        monkeypatch.setattr(auth, "ALLOWED_EMAILS", {"kris@iconsofrealestate.com"})
        assert auth.denial_reason_("othercompany.com", "kris@iconsofrealestate.com") == "domain"

    def test_empty_allowlist_denies_everyone_even_with_correct_domain(self, monkeypatch):
        """The core M-06 fix: an unconfigured (empty) allowlist must deny
        access, not silently grant it to every Workspace account."""
        monkeypatch.setattr(auth, "ALLOWED_EMAILS", set())
        assert auth.denial_reason_(auth.WORKSPACE_DOMAIN, "anyone@iconsofrealestate.com") == "allowlist"

    def test_correct_domain_and_allowlisted_email_is_allowed(self, monkeypatch):
        monkeypatch.setattr(auth, "ALLOWED_EMAILS", {"kris@iconsofrealestate.com"})
        assert auth.denial_reason_(auth.WORKSPACE_DOMAIN, "kris@iconsofrealestate.com") is None

    def test_correct_domain_but_not_on_allowlist_is_denied(self, monkeypatch):
        monkeypatch.setattr(auth, "ALLOWED_EMAILS", {"kris@iconsofrealestate.com"})
        assert auth.denial_reason_(auth.WORKSPACE_DOMAIN, "someoneelse@iconsofrealestate.com") == "allowlist"


class TestSessionSecretFailsClosed:
    def _run(self, env_overrides):
        env = dict(os.environ)
        # Unset DASHBOARD_ALLOWED_EMAILS/GOOGLE_OAUTH_* isn't needed — only
        # DASHBOARD_REQUIRE_LOGIN and DASHBOARD_SESSION_SECRET affect the
        # startup check under test. Explicitly clear any inherited secret
        # so each case starts from "unset" before applying its own override.
        env.pop("DASHBOARD_SESSION_SECRET", None)
        env.update(env_overrides)
        return subprocess.run(
            [sys.executable, "-c", "import app"],
            cwd=str(DASHBOARD_DIR),
            env=env,
            capture_output=True,
            text=True,
        )

    def test_refuses_to_start_with_login_required_and_no_secret(self):
        result = self._run({"DASHBOARD_REQUIRE_LOGIN": "true"})
        assert result.returncode != 0
        assert "DASHBOARD_SESSION_SECRET is not set" in result.stderr

    def test_starts_fine_with_login_disabled_and_no_secret(self):
        result = self._run({"DASHBOARD_REQUIRE_LOGIN": "false"})
        assert result.returncode == 0, result.stderr

    def test_starts_fine_when_secret_is_explicitly_set(self):
        result = self._run({"DASHBOARD_REQUIRE_LOGIN": "true", "DASHBOARD_SESSION_SECRET": "a-real-secret"})
        assert result.returncode == 0, result.stderr


class TestFreshDatabaseGuard:
    """Real bug (M-04): sqlite3.connect() silently creates an empty file if
    DASHBOARD_DB_PATH doesn't exist yet — on a brand-new deployment where
    sync.py has never run, every route querying sales_call_log/etc. used to
    500 with "no such table" instead of rendering an empty dashboard."""

    def test_overview_route_200s_against_a_db_path_that_never_existed(self, tmp_path):
        db_path = tmp_path / "never_existed.db"
        assert not db_path.exists()
        script = (
            "import os; os.environ['DASHBOARD_DB_PATH'] = " + repr(str(db_path)) + "\n"
            "os.environ['DASHBOARD_REQUIRE_LOGIN'] = 'false'\n"
            "import app\n"
            "from fastapi.testclient import TestClient\n"
            "client = TestClient(app.app)\n"
            "resp = client.get('/')\n"
            "assert resp.status_code == 200, resp.text\n"
            "print('OK')\n"
        )
        env = dict(os.environ)
        env.pop("DASHBOARD_SESSION_SECRET", None)
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=str(DASHBOARD_DIR),
            env=env,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "OK" in result.stdout
