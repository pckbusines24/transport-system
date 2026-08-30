import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Brand mark.
 *
 * The idea is FORWARD MOTION ALONG A ROUTE, not a picture of a truck. A literal
 * vehicle silhouette turns to mush below about 24px, and a favicon is 16px —
 * so the mark is built from three shapes that stay readable at any size:
 *
 *   - a rounded tile, which is what makes it legible as an app icon
 *   - a bold chevron, reading as direction
 *   - a shorter trailing chevron, reading as speed
 *   - a baseline bar: the road the movement happens on
 *
 * Colours are deliberately hard-coded rather than themed. A logo has to survive
 * being dropped on a bank letterhead, a PDF invoice or someone's dark-mode
 * browser tab unchanged — a mark that shifts with the UI theme is not a mark.
 * The one exception is `onDark`, for placing it on the inverted panel.
 */

const INK = "#14161C";
const GOLD = "#F5C842";

export function LogoMark({
  className,
  onDark = false,
  ...props
}: React.SVGProps<SVGSVGElement> & { onDark?: boolean }) {
  const tile = onDark ? INK : GOLD;
  const fg = onDark ? GOLD : INK;
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label="TransportTMS"
      className={cn("shrink-0", className)}
      {...props}
    >
      {/* 22% radius reads as a modern app tile without going full circle */}
      <rect width="48" height="48" rx="10.5" fill={tile} />
      {/* leading chevron — the direction of travel */}
      <path
        d="M18.5 13.5 L30.5 24 L18.5 34.5"
        fill="none"
        stroke={fg}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* trailing chevron, lighter and set back: motion, not a second arrow */}
      <path
        d="M11.5 18.5 L17 24 L11.5 29.5"
        fill="none"
        stroke={fg}
        strokeWidth="3.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.45"
      />
    </svg>
  );
}

/** Mark plus wordmark, for the app header and the sign-in screen. */
export function Logo({
  className,
  markClassName,
  onDark = false,
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  onDark?: boolean;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className={cn("h-8 w-8", markClassName)} onDark={onDark} />
      {showWordmark && (
        // tight tracking and a light second word: the eye reads "Transport" as
        // the name and "TMS" as the qualifier, without needing two type sizes
        <span className="text-[1.0625rem] font-semibold tracking-[-0.02em]">
          Transport
          <span className="font-light text-muted-foreground">TMS</span>
        </span>
      )}
    </span>
  );
}
