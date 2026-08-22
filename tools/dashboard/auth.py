"""
Google OAuth login for the dashboard, per DASHBOARD_RESEARCH_REPORT.md §3.3:
Authlib in-app (not a separate oauth2-proxy — the app needs the user's
identity anyway to eventually show "your" scorecard and gate Kris-only
actions), with three layers on top of the OAuth flow itself:

  1. The GCP OAuth consent screen is set to "Internal" — only accounts in
     the Workspace org can complete the flow at all. That's a GCP Console
     setting, not something this code can enforce.
  2. The `hd` (hosted domain) claim is verified server-side against
     DASHBOARD_WORKSPACE_DOMAIN. It's inside the signed ID token, so it's
     trustworthy — but it has to actually be checked; a missing `hd` means
     the account isn't a Workspace account at all, and must be rejected,
     not just treated as unknown.
  3. The email is checked against an explicit allowlist
     (DASHBOARD_ALLOWED_EMAILS) — survives someone being added to the
     Workspace for an unrelated reason.

Session state is just the verified email in a signed cookie (Starlette's
SessionMiddleware, wired up in app.py) — nothing else needed server-side.
"""
import os

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

WORKSPACE_DOMAIN = os.environ.get("DASHBOARD_WORKSPACE_DOMAIN", "iconsofrealestate.com")
ALLOWED_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("DASHBOARD_ALLOWED_EMAILS", "").split(",")
    if e.strip()
}

oauth = OAuth()
oauth.register(
    name="google",
    client_id=os.environ.get("GOOGLE_OAUTH_CLIENT_ID", ""),
    client_secret=os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", ""),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

router = APIRouter()

# Paths reachable without a session — everything else is gated by
# RequireLoginMiddleware in app.py.
PUBLIC_PATHS = {"/login", "/auth/callback", "/login-denied", "/healthz"}


@router.get("/login")
async def login(request: Request):
    # Prefer an explicit env var over Starlette's own url_for-based guess —
    # this app sits behind Tailscale/a future reverse proxy, and scheme
    # detection (http vs https) from the raw request isn't reliable there.
    redirect_uri = os.environ.get("GOOGLE_OAUTH_REDIRECT_URI") or str(
        request.url_for("auth_callback")
    )
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get("/auth/callback", name="auth_callback")
async def auth_callback(request: Request):
    token = await oauth.google.authorize_access_token(request)
    userinfo = token.get("userinfo") or {}

    email = (userinfo.get("email") or "").lower()
    hd = userinfo.get("hd")

    if hd != WORKSPACE_DOMAIN:
        return RedirectResponse(url="/login-denied?reason=domain")
    if ALLOWED_EMAILS and email not in ALLOWED_EMAILS:
        return RedirectResponse(url="/login-denied?reason=allowlist")

    request.session["user_email"] = email
    request.session["user_name"] = userinfo.get("name", email)
    return RedirectResponse(url="/")


@router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login")


@router.get("/login-denied", response_class=HTMLResponse)
async def login_denied(request: Request, reason: str = ""):
    message = {
        "domain": "That Google account isn't part of the iconsofrealestate.com Workspace.",
        "allowlist": "That account isn't on the dashboard's approved list yet — ask Kris to add it.",
    }.get(reason, "Access denied.")
    return HTMLResponse(
        f"""<!doctype html><html><body style="background:#0f1420;color:#e8ecf4;
        font-family:sans-serif;padding:3rem;">
        <h1>Access denied</h1><p>{message}</p>
        <p><a href="/login" style="color:#7dc4ff;">Try a different account</a></p>
        </body></html>"""
    )
