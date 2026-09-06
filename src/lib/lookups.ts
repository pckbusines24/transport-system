"use server";

import { requireSession } from "./session";
import { withTenant } from "./db";
import {
  getCityLookup,
  getPartyLookup,
  getProductLookup,
  getUnitLookup,
  getVehicleLookup,
} from "./cached-lookups";
import { LedgerGroup } from "@prisma/client";

export interface Option {
  value: string;
  label: string;
  meta?: string;
}

export async function getCityOptions(): Promise<Option[]> {
  const s = requireSession();
  const cities = await getCityLookup(s.tenantId);
  return cities.map((c) => ({ value: c.id, label: c.name, meta: c.stateName }));
}

export async function getPartyOptions(groups?: LedgerGroup[]): Promise<Option[]> {
  const s = requireSession();
  // one cached read of the active party master, filtered here — the cached
  // list is already ordered by name, so slicing it preserves the old order
  const parties = await getPartyLookup(s.tenantId);
  // Bank & Cash are maintained in their own master; never offer them as parties
  // unless a caller (getBankOptions) asks for those groups explicitly.
  const wanted = groups?.length
    ? (g: string) => (groups as string[]).includes(g)
    : (g: string) => g !== "BANK" && g !== "CASH" && g !== "CARD";
  return parties
    .filter((p) => wanted(p.ledgerGroup))
    .map((p) => ({
      value: p.id,
      label: p.name,
      // alias & transport name first: the combobox searches label+meta, so the
      // short name or the transport's trade name both find the party
      meta: [p.alias, p.transportName, p.gstin, p.pan].filter(Boolean).join(" · ") || undefined,
    }));
}

export async function getVehicleOptions(): Promise<Option[]> {
  const s = requireSession();
  const vehicles = await getVehicleLookup(s.tenantId);
  return vehicles.map((v) => ({
    value: v.id,
    label: v.number,
    meta: vehicleMeta({ ...v, owner: v.ownerName ? { name: v.ownerName } : null }),
  }));
}

function vehicleMeta(v: { isOwn: boolean; ownershipType: string; ownerNames: string | null; owner: { name: string } | null }) {
  if (v.isOwn) return `Owned${v.ownerNames ? " — " + v.ownerNames : v.owner ? " — " + v.owner.name : ""}`;
  const kind = v.ownershipType === "RELATIVE" ? "Relative" : "Broker";
  return `${kind} — ${v.owner?.name ?? "?"}`;
}

export async function getProductOptions(): Promise<Option[]> {
  const s = requireSession();
  const products = await getProductLookup(s.tenantId);
  return products.map((p) => ({ value: p.id, label: p.name, meta: p.groupName }));
}

/**
 * Bank & Cash heads. `meta` carries the ledger group ("BANK" | "CASH") so
 * callers can filter the list by the selected payment mode.
 */
export async function getBankOptions(): Promise<Option[]> {
  const s = requireSession();
  const parties = await getPartyLookup(s.tenantId);
  return parties
    .filter((p) => p.ledgerGroup === "BANK" || p.ledgerGroup === "CASH" || p.ledgerGroup === "CARD")
    .map((p) => ({ value: p.id, label: p.name, meta: p.ledgerGroup }));
}

/**
 * Deliberately NOT cached, unlike its sibling lookups: the states master is
 * lazily seeded during the /masters/states page RENDER when the table is empty
 * (after a data wipe), and a page render cannot revalidate a cache tag — so a
 * form opened before that seed would serve an empty list until the TTL lapsed.
 * It is 30-odd tiny rows; the read is not worth that failure mode.
 */
export async function getStateOptions(): Promise<Option[]> {
  const s = requireSession();
  const states = await withTenant(s.tenantId, (tx) =>
    tx.state.findMany({ orderBy: { name: "asc" } })
  );
  return states.map((st) => ({ value: st.id, label: st.name, meta: st.gstCode }));
}

export async function getUnitOptions(): Promise<Option[]> {
  const s = requireSession();
  const units = await getUnitLookup(s.tenantId);
  return units.map((u) => ({ value: u.id, label: u.name }));
}

/** Unit options keyed by NAME — for fields that store the unit name (e.g. Product.unit). */
export async function getUnitNameOptions(): Promise<Option[]> {
  const s = requireSession();
  const units = await getUnitLookup(s.tenantId);
  return units.map((u) => ({ value: u.name, label: u.name }));
}

/** Product groups for the product form (small table; read live). */
export async function getProductGroupOptions(): Promise<Option[]> {
  const s = requireSession();
  const groups = await withTenant(s.tenantId, (tx) =>
    tx.productGroup.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })
  );
  return groups.map((g) => ({ value: g.id, label: g.name }));
}

// ---------- inline creates (the "+" pattern) ----------
//
// The inline "+ Create" dialogs save through the SAME server actions as the
// master screens (saveParty, saveVehicle, ...) so validation, audit and cache
// invalidation are identical. Afterwards they call this to turn the new id
// into the combobox option shape the dropdown lists.

export type MasterKind = "party" | "vehicle" | "city" | "product" | "productGroup" | "unit";

export async function getMasterOption(
  kind: MasterKind,
  id: string
): Promise<Option & { transportName?: string | null; ownerName?: string | null }> {
  const s = requireSession();
  return withTenant(s.tenantId, async (tx) => {
    switch (kind) {
      case "party": {
        const p = await tx.party.findUniqueOrThrow({ where: { id } });
        return {
          value: p.id,
          label: p.name,
          // same meta as getPartyOptions so the new row searches like the rest
          meta: [p.alias, p.transportName, p.gstin, p.pan].filter(Boolean).join(" · ") || undefined,
          // chalan / broker-slip keep their own broker lists — the created option
          // carries the two-way name-link data so it links without a page reload
          transportName: p.transportName ?? null,
          ownerName: p.name,
        };
      }
      case "vehicle": {
        const v = await tx.vehicle.findUniqueOrThrow({ where: { id }, include: { owner: true } });
        return { value: v.id, label: v.number, meta: vehicleMeta(v) };
      }
      case "city": {
        const c = await tx.city.findUniqueOrThrow({ where: { id }, include: { state: true } });
        return { value: c.id, label: c.name, meta: c.state.name };
      }
      case "product": {
        const p = await tx.product.findUniqueOrThrow({ where: { id }, include: { group: true } });
        return { value: p.id, label: p.name, meta: p.group.name };
      }
      case "productGroup": {
        const g = await tx.productGroup.findUniqueOrThrow({ where: { id } });
        return { value: g.id, label: g.name };
      }
      case "unit": {
        // keyed by NAME like getUnitNameOptions — Product.unit stores the name
        const u = await tx.unit.findUniqueOrThrow({ where: { id } });
        return { value: u.name, label: u.name };
      }
    }
  });
}

/** Rate lookup for LR entry: party + product + source + destination */
export async function lookupRate(input: {
  partyId: string;
  productId?: string | null;
  sourceCityId: string;
  destCityId: string;
}) {
  const s = requireSession();
  return withTenant(s.tenantId, async (tx) => {
    const route = {
      partyId: input.partyId,
      sourceCityId: input.sourceCityId,
      destCityId: input.destCityId,
    };
    // a rate row may list several products (productIds); the product-specific
    // match wins, then the blank "ALL products" row
    if (input.productId) {
      const specific = await tx.rateMaster.findFirst({
        where: {
          ...route,
          OR: [
            { productIds: { has: input.productId } },
            { productId: input.productId },
          ],
        },
      });
      if (specific) return specific;
    }
    return tx.rateMaster.findFirst({
      where: { ...route, productId: null, productIds: { isEmpty: true } },
    });
  });
}
