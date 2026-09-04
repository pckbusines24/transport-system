/**
 * What a type-ahead combobox should settle on when it loses focus.
 *
 * The subtlety is that OPTION LABELS ARE NOT UNIQUE. Two brokers can both be
 * called "SSBL" under different owners (Rajan Yadav and Rameshwar), and the
 * Chalan form's Transport Name picker lists both — same label, different broker
 * id. Resolving the typed text by label alone therefore silently jumps to
 * whichever record happens to come first:
 *
 *   pick SSBL (Rameshwar) -> blur -> find(label === "SSBL") -> SSBL (Rajan)
 *
 * so moving to the next field quietly rewrote the user's choice, and only the
 * first of the two was ever selectable.
 *
 * The rule: a selection already consistent with what is displayed is left
 * alone. Label matching is a convenience for TYPED text that has no selection
 * behind it yet — never a re-validation of a choice the user already made.
 */

export interface ResolvableOption {
  value: string;
  label: string;
}

export interface BlurResolution {
  /** the value to settle on — null clears the field */
  value: string | null;
  /** the text to display */
  text: string;
  /** whether `value` differs from what was already selected */
  changed: boolean;
}

export function resolveOnBlur(args: {
  /** what the user has typed / what is displayed */
  text: string;
  /** the currently selected value */
  value: string | null | undefined;
  options: readonly ResolvableOption[];
}): BlurResolution {
  const { options } = args;
  const current = args.value ?? null;
  const selected = current ? (options.find((o) => o.value === current) ?? null) : null;
  const text = args.text.trim();

  // cleared: an empty box means no selection
  if (!text) return { value: null, text: "", changed: current !== null };

  // The selection already matches what is on screen — keep it. This is the
  // case that duplicate labels used to break: re-matching here would discard
  // the user's record for a same-named one.
  if (selected && selected.label.toLowerCase() === text.toLowerCase()) {
    return { value: selected.value, text: selected.label, changed: false };
  }

  // typed text with nothing selected behind it: an exact label match selects
  const exact = options.find((o) => o.label.toLowerCase() === text.toLowerCase());
  if (exact) {
    return { value: exact.value, text: exact.label, changed: exact.value !== current };
  }

  // no match: revert the display to whatever is actually selected
  return { value: current, text: selected?.label ?? "", changed: false };
}
