"use client";

import * as React from "react";

/**
 * Scrolling the page while a number field has focus used to change its value
 * (qty 10 became 9 with one wheel tick). On a wheel over the focused number
 * field we take focus off it, so the page scrolls and the value stays.
 * Mounted once in the root layout; covers plain <input type="number"> too.
 */
export function NumberInputGuard() {
  React.useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && el.type === "number" && e.target === el) el.blur();
    };
    document.addEventListener("wheel", onWheel, { passive: true });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);
  return null;
}
