/**
 * Second line of a party option in any filter or dropdown: the transport
 * (trade) name first, then the alias, then whatever tag the screen adds. The
 * comboboxes search label + meta, so typing the owner's name or the transport
 * name both find the same party — the two-way pair the chalan entry form has.
 */
export function partyMeta(
  p: { transportName?: string | null; alias?: string | null },
  ...extra: (string | null | undefined | false)[]
): string | undefined {
  return [p.transportName, p.alias, ...extra].filter(Boolean).join(" · ") || undefined;
}
