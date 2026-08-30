"use server";

import { revalidateTag } from "next/cache";
import { authorize } from "@/lib/authz";
import { requireSession } from "./session";
import { withTenant } from "./db";
import {
  getCityLookup,
  getPartyLookup,
  getProductLookup,
  getUnitLookup,
  getVehicleLookup,
  lookupTag,
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

// ---------- inline creates (the "+" pattern) ----------

export async function createCityInline(input: {
  name: string;
  stateId: string;
  district?: string;
  pincode?: string;
}): Promise<Option> {
  const s = requireSession();
  await authorize(s, "masters", "create");
  const city = await withTenant(s.tenantId, (tx) =>
    tx.city.create({
      data: { tenantId: s.tenantId, name: input.name.toUpperCase().trim(), stateId: input.stateId, district: input.district, pincode: input.pincode },
      include: { state: true },
    })
  );
  // the dropdowns read the cached master now — an inline create that skipped
  // this would leave the new row invisible until the TTL lapsed
  revalidateTag(lookupTag.cities(s.tenantId));
  return { value: city.id, label: city.name, meta: city.state.name };
}

export async function createPartyInline(input: {
  name: string;
  ledgerGroup: LedgerGroup;
  address1?: string;
  gstin?: string;
  pan?: string;
  mobile?: string;
  stateId?: string;
  cityId?: string;
  /** owner/broker parties: the transport firm name printed on documents */
  transportName?: string;
  tdsMode?: "TDS_APPLICABLE" | "DECLARATION";
}): Promise<Option & { transportName?: string | null; ownerName?: string | null }> {
  const s = requireSession();
  await authorize(s, "masters", "create");
  const party = await withTenant(s.tenantId, (tx) =>
    tx.party.create({
      data: { tenantId: s.tenantId, ...input, name: input.name.toUpperCase().trim() },
    })
  );
  revalidateTag(lookupTag.parties(s.tenantId));
  // vehicle meta prints the owner party's name, so it goes stale too
  revalidateTag(lookupTag.vehicles(s.tenantId));
  return {
    value: party.id,
    label: party.name,
    meta: [party.alias, party.gstin, party.pan].filter(Boolean).join(" · ") || undefined,
    // chalan / broker-slip keep their own broker lists — the created option
    // carries the two-way name-link data so it links without a page reload
    transportName: party.transportName ?? null,
    ownerName: party.name,
  };
}

export async function createVehicleInline(input: {
  number: string;
  ownershipType?: "OWNER" | "BROKER" | "RELATIVE";
  ownerId?: string;
  isOwn?: boolean;
  ownerNames?: string;
  vehicleType?: string;
  chassisNo?: string;
  engineNo?: string;
  permitNo?: string;
  insuranceNo?: string;
}): Promise<Option> {
  const s = requireSession();
  await authorize(s, "masters", "create");
  const v = await withTenant(s.tenantId, async (tx) => {
    const created = await tx.vehicle.create({
      data: {
        tenantId: s.tenantId,
        number: input.number.toUpperCase().replace(/\s+/g, ""),
        ownershipType: input.ownershipType ?? (input.isOwn ? "OWNER" : "BROKER"),
        ownerId: input.ownerId || null,
        isOwn: input.ownershipType ? input.ownershipType === "OWNER" : input.isOwn ?? false,
        ownerNames: input.isOwn ? input.ownerNames || null : null,
        vehicleType: input.vehicleType || null,
        chassisNo: input.chassisNo ? input.chassisNo.toUpperCase() : null,
        engineNo: input.engineNo ? input.engineNo.toUpperCase() : null,
        permitNo: input.permitNo || null,
        insuranceNo: input.insuranceNo || null,
      },
      include: { owner: true },
    });
    return created;
  });
  revalidateTag(lookupTag.vehicles(s.tenantId));
  return { value: v.id, label: v.number, meta: vehicleMeta(v) };
}

export async function createProductInline(input: {
  name: string;
  groupId?: string;
  unit?: string;
  hsnCode?: string;
  gstPct?: number;
}): Promise<Option> {
  const s = requireSession();
  await authorize(s, "masters", "create");
  const p = await withTenant(s.tenantId, async (tx) => {
    if (input.unit) {
      const unit = await tx.unit.findFirst({
        where: { name: { equals: input.unit, mode: "insensitive" } },
      });
      if (!unit) throw new Error(`Unit "${input.unit}" is not in the Unit Master`);
      input.unit = unit.name;
    }
    let groupId = input.groupId;
    if (!groupId) {
      const g = await tx.productGroup.upsert({
        where: { tenantId_name: { tenantId: s.tenantId, name: "GENERAL" } },
        create: { tenantId: s.tenantId, name: "GENERAL" },
        update: {},
      });
      groupId = g.id;
    }
    return tx.product.create({
      data: {
        tenantId: s.tenantId,
        name: input.name.toUpperCase().trim(),
        groupId,
        unit: input.unit ?? null,
        hsnCode: input.hsnCode,
        gstPct: input.gstPct ?? 0,
      },
      include: { group: true },
    });
  });
  revalidateTag(lookupTag.products(s.tenantId));
  return { value: p.id, label: p.name, meta: p.group.name };
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
