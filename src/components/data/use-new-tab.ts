"use client";

import * as React from "react";

/**
 * Opens a blank browser tab that the current page renders into through
 * `createPortal(…, container)`. The content stays part of this React tree,
 * so it shares live state with the page (edits here show up there at once).
 *
 * The app's stylesheets and <html>/<body> classes are copied into the tab so
 * Tailwind classes render the same. Closing the tab clears `container`; the
 * tab is closed when this page unmounts or unloads, since a portal without
 * its page would be a dead copy.
 */
export function useNewTab(onClosed?: () => void) {
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const winRef = React.useRef<Window | null>(null);
  const onClosedRef = React.useRef(onClosed);
  onClosedRef.current = onClosed;

  const detach = React.useCallback(() => {
    winRef.current = null;
    setContainer(null);
  }, []);

  /** Must be called from a click handler so the browser allows the tab. */
  const open = React.useCallback(
    (title: string): boolean => {
      const existing = winRef.current;
      if (existing && !existing.closed) {
        existing.focus();
        return true;
      }
      const w = window.open("", "_blank");
      if (!w) return false;
      const doc = w.document;
      doc.title = title;
      document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
        const copy = doc.importNode(node, true) as HTMLElement;
        if (node instanceof HTMLLinkElement) copy.setAttribute("href", node.href);
        doc.head.appendChild(copy);
      });
      doc.documentElement.className = document.documentElement.className;
      doc.body.className = document.body.className;
      const root = doc.createElement("div");
      doc.body.appendChild(root);
      winRef.current = w;

      const gone = () => {
        if (winRef.current !== w) return;
        detach();
        onClosedRef.current?.();
      };
      w.addEventListener("pagehide", gone);
      // pagehide is not guaranteed for a blank tab; poll as a backstop
      const timer = window.setInterval(() => {
        if (w.closed) {
          window.clearInterval(timer);
          gone();
        } else if (winRef.current !== w) {
          window.clearInterval(timer);
        }
      }, 800);

      setContainer(root);
      return true;
    },
    [detach]
  );

  const close = React.useCallback(() => {
    const w = winRef.current;
    detach();
    if (w && !w.closed) w.close();
  }, [detach]);

  /** Turn the tab into a normal page (e.g. the print view) and let it go. */
  const navigate = React.useCallback(
    (path: string) => {
      const w = winRef.current;
      detach();
      if (w && !w.closed) w.location.href = new URL(path, window.location.origin).href;
      else window.open(path, "_blank");
    },
    [detach]
  );

  // close a still-attached tab when this page goes away
  React.useEffect(() => {
    const onHide = () => winRef.current?.close();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      const w = winRef.current;
      if (w && !w.closed) w.close();
    };
  }, []);

  return { container, open, close, navigate };
}
