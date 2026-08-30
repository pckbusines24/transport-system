"use client";

import * as React from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Logo, LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { login, type LoginState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}

/**
 * Sign-in.
 *
 * Two columns rather than a card floating in the middle of an empty page: at
 * this size a lone box reads as an unfinished page, and the dead space inside
 * it was doing nothing. The ink panel is the design system's emphasis surface
 * used for the one thing that deserves it here — saying whose product this is
 * before anyone has logged in.
 *
 * The form itself sits directly on the canvas with no card. It is already the
 * only thing in its column; wrapping it in a border would be a box inside a
 * box for no gain.
 */
export default function LoginPage() {
  const [state, formAction] = useFormState<LoginState, FormData>(login, {});

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)]">
      {/* ---- brand panel: desktop only, since on a phone it would push the
              form below the fold for no benefit ---- */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-inverted p-10 text-inverted-foreground lg:flex xl:p-14">
        {/* the mark, oversized and bled off the corner. Low enough opacity to
            stay texture rather than becoming a second logo competing with the
            real one at the top. */}
        <svg
          className="pointer-events-none absolute -bottom-40 -right-40 h-[34rem] w-[34rem] opacity-[0.04]"
          viewBox="0 0 48 48"
          aria-hidden
        >
          <path
            d="M18.5 13.5 L30.5 24 L18.5 34.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M11.5 18.5 L17 24 L11.5 29.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {/* a warm wash so the panel is not a flat black rectangle */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(38rem 26rem at 12% 8%, hsl(var(--primary) / 0.16), transparent 62%)",
          }}
          aria-hidden
        />

        <div className="relative">
          <Logo onDark />
        </div>

        <div className="relative max-w-md">
          <p className="text-3xl font-light leading-[1.15] tracking-[-0.02em] xl:text-4xl">
            Every LR, chalan and bill in one place.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-inverted-muted">
            Booking through delivery, POD to invoice, and the ledger behind all of it — kept
            consistent so the numbers agree wherever you look.
          </p>
        </div>

        <p className="relative text-xs text-inverted-muted">
          Transport management, built for Indian road freight.
        </p>
      </aside>

      {/* ---- form ---- */}
      <main className="flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-[22rem]">
          {/* the brand panel is hidden below lg, so the mark comes back here */}
          <LogoMark className="mb-8 h-12 w-12 lg:hidden" />

          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Sign in</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Enter your credentials to continue.
          </p>

          <form action={formAction} className="mt-8 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" name="username" autoComplete="username" autoFocus required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>

            {state.needTenant && (
              <div className="space-y-2">
                <Label htmlFor="tenant">Company code</Label>
                <Input id="tenant" name="tenant" placeholder="e.g. acme-transport" />
              </div>
            )}

            {state.error && (
              // role=alert so a screen reader announces a failed attempt; the
              // tinted block makes it findable without re-reading the form
              <p
                role="alert"
                className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {state.error}
              </p>
            )}

            <SubmitButton />
          </form>
        </div>
      </main>
    </div>
  );
}
