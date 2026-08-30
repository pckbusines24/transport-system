import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/session";

/**
 * Redirect with a RELATIVE Location header.
 *
 * `NextResponse.redirect(new URL(path, req.url))` resolves the path against the
 * URL the Node process actually received, which behind Render's proxy is
 * `http://localhost:10000/...` — so signing out bounced the browser to
 * localhost. A relative Location (RFC 7231 §7.1.2) is resolved by the browser
 * against the address bar instead: correct behind any proxy, at any port, and
 * without having to trust x-forwarded-* headers.
 */
function redirectTo(path: string, status: 303 | 307) {
  return new NextResponse(null, { status, headers: { Location: path } });
}

// POST only: a GET /logout is prefetchable by <Link>, which silently
// destroyed sessions whenever a page containing a sign-out link rendered.
export async function POST() {
  clearSessionCookie();
  // 303 forces the follow-up to be a GET, so /login is not re-POSTed
  return redirectTo("/login", 303);
}

export async function GET() {
  // do NOT clear the session on GET — just bounce home
  return redirectTo("/dashboard", 307);
}
