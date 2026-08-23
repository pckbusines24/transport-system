import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import {
  getCityLookup,
  getPartyLookup,
  getProductLookup,
  getVehicleLookup,
} from "@/lib/cached-lookups";
import { nextLrNumber } from "@/lib/sequences";
import { formatDate } from "@/lib/utils";
import type { MasterOption } from "@/components/data/master-combobox";
import type { LrFormValues, PartyDetail } from "@/components/lr/lr-form";
import { emptyLrItem } from "@/components/lr/lr-calc";
import type { RateBasis } from "@/lib/calc/rate";

export interface LrFormData {
  mode: "create" | "edit";
  lrId?: string;
  isDummy: boolean;
  /** billed LRs are edited only via the bill preview — the /lr page blocks them */
  isBilled: boolean;
  defaults: LrFormValues;
  gstPct: number;
  cityOptions: MasterOption[];
  partyOptions: MasterOption[];
  billToOptions: MasterOption[];
  vehicleOptions: MasterOption[];
  productOptions: MasterOption[];
  bankOptions: MasterOption[];
  partyDetails: Record<string, PartyDetail>;
  vehicleOwners: Record<string, string>;
  productUnits: Record<string, string>;
  productTypes: Record<string, string>;
}

export async function loadLrFormData(editId?: string, copyId?: string): Promise<LrFormData> {
  const sourceId = editId ?? copyId;
  const session = requireSession();

  // master-data dropdowns come from the tag-invalidated lookup cache — only
  // the per-visit rows (firm GST config, next number, the LR being edited)
  // still hit the database
  const [cities, allParties, vehicles, products, txData] = await Promise.all([
    getCityLookup(session.tenantId),
    getPartyLookup(session.tenantId),
    getVehicleLookup(session.tenantId),
    getProductLookup(session.tenantId),
    withTenant(session.tenantId, async (tx) => {
      const [firm, nextNo, existing] = await Promise.all([
        tx.firm.findUniqueOrThrow({ where: { id: session.firmId } }),
        nextLrNumber(tx, { firmId: session.firmId, fyId: session.fyId }),
        sourceId
          ? tx.lr.findFirst({
              // firm-scoped only: an old-FY LR opens for editing from the new
              // year too (FY continuity) — saveLr keeps it in its own year
              where: { id: sourceId, firmId: session.firmId, deletedAt: null },
              include: { items: true },
            })
          : Promise.resolve(null),
      ]);
      return { firm, nextNo, existing };
    }),
  ]);
  const { firm, nextNo, existing } = txData;
  const parties = allParties.filter((p) => p.ledgerGroup === "CONSIGNEE_CONSIGNOR");
  // Billed To offers consignor/consignee parties only — no owners/brokers
  const billToParties = parties;
  const banks = allParties.filter((p) => ["BANK", "CASH", "CARD"].includes(p.ledgerGroup));


  const igstPct = Number(firm.igstPct);
  const gstPct = igstPct > 0 ? igstPct : Number(firm.cgstPct) + Number(firm.sgstPct);

  const partyDetails: Record<string, PartyDetail> = {};
  for (const p of parties) {
    partyDetails[p.id] = {
      address: [p.address1, p.address2].filter(Boolean).join(", "),
      gstin: p.gstin ?? "",
    };
  }

  const vehicleOwners: Record<string, string> = {};
  for (const veh of vehicles) {
    vehicleOwners[veh.id] = veh.isOwn ? "Own Vehicle" : veh.ownerName ?? "";
  }

  const productUnits: Record<string, string> = {};
  for (const p of products) if (p.unit) productUnits[p.id] = p.unit;
  const productTypes: Record<string, string> = {};
  for (const p of products) productTypes[p.id] = p.productType;

  const defaults: LrFormValues = existing
    ? {
        lrNo: existing.lrNo,
        lrDateText: formatDate(existing.lrDate),
        refLrNo: existing.refLrNo ?? "",
        privateMarka: existing.privateMarka ?? "",
        sourceCityId: existing.sourceCityId,
        destCityId: existing.destCityId,
        consignorId: existing.consignorId,
        consigneeId: existing.consigneeId,
        billToId: existing.billToId ?? "",
        vehicleId: existing.vehicleId ?? "",
        vehicleText: existing.vehicleText ?? "",
        invoiceNo: existing.invoiceNo ?? "",
        obdNo: existing.obdNo ?? "",
        refNo: existing.refNo ?? "",
        invoiceDateText: existing.invoiceDate ? formatDate(existing.invoiceDate) : "",
        goodsValue: existing.goodsValue ? Number(existing.goodsValue) : 0,
        ewayBillNo: existing.ewayBillNo ?? "",
        ewayExpiryText: existing.ewayExpiry ? formatDate(existing.ewayExpiry) : "",
        insCompany: existing.insCompany ?? "",
        insPolicyNo: existing.insPolicyNo ?? "",
        insAmount: existing.insAmount ? Number(existing.insAmount) : 0,
        items: existing.items.map((i) => ({
          productId: i.productId ?? "",
          productName: i.productName,
          description: i.description ?? "",
          qty: Number(i.qty),
          actualWt: Number(i.actualWt),
          chargeWt: Number(i.chargeWt),
          unit: i.unit,
          rate: Number(i.rate),
          rateBasis: i.rateBasis as RateBasis,
        })),
        freight: Number(existing.freight),
        hamali: Number(existing.hamali),
        preBhada: Number(existing.preBhada),
        biltyCharge: Number(existing.biltyCharge),
        collCharge: Number(existing.collCharge),
        cpc: Number(existing.cpc),
        otherCharge: Number(existing.otherCharge),
        gstApplicable: existing.gstApplicable,
        advance: Number(existing.advance),
        advanceBank: existing.advanceBank ?? "",
        lrType: existing.lrType,
        printFreight: existing.printFreight,
        remarks: existing.remarks ?? "",
        deliveryAt: existing.deliveryAt ?? "",
      }
    : {
        lrNo: nextNo ?? "1",
        lrDateText: formatDate(new Date()),
        refLrNo: "",
        privateMarka: "",
        sourceCityId: "",
        destCityId: "",
        consignorId: "",
        consigneeId: "",
        billToId: "",
        vehicleId: "",
        vehicleText: "",
        invoiceNo: "",
        obdNo: "",
        refNo: "",
        invoiceDateText: "",
        goodsValue: 0,
        ewayBillNo: "",
        ewayExpiryText: "",
        insCompany: "",
        insPolicyNo: "",
        insAmount: 0,
        items: [emptyLrItem()],
        freight: 0,
        hamali: 0,
        preBhada: 0,
        biltyCharge: 0,
        collCharge: 0,
        cpc: 0,
        otherCharge: 0,
        gstApplicable: false,
        advance: 0,
        advanceBank: "",
        lrType: "TBB",
        printFreight: false,
        remarks: "",
        deliveryAt: "",
      };

  if (existing && copyId && !editId) {
    // "Copy to New LR": reuse everything except per-consignment identifiers
    defaults.lrNo = nextNo ?? "1";
    defaults.lrDateText = formatDate(new Date());
    defaults.refLrNo = "";
    defaults.invoiceNo = "";
    defaults.obdNo = "";
    defaults.refNo = "";
    defaults.invoiceDateText = "";
    defaults.ewayBillNo = "";
    defaults.ewayExpiryText = "";
    defaults.printFreight = false; // every new LR defaults to not printing freight
    // per-consignment cargo starts blank too — the rate comes back from
    // Rate Setup when a product is picked, and freight recomputes from it
    defaults.goodsValue = 0;
    defaults.items = [emptyLrItem()];
    defaults.freight = 0;
  }

  const isCopy = Boolean(existing && copyId && !editId);
  return {
    mode: existing && !isCopy ? ("edit" as const) : ("create" as const),
    lrId: isCopy ? undefined : existing?.id,
    isDummy: existing?.isDummy ?? false,
    isBilled: !isCopy && existing?.status === "BILLED",
    defaults,
    gstPct,
    cityOptions: cities.map((c) => ({ value: c.id, label: c.name, meta: c.stateName })),
    partyOptions: parties.map((p) => ({
      value: p.id,
      label: p.name,
      meta: [p.alias, p.gstin, p.pan].filter(Boolean).join(" · ") || undefined,
    })),
    billToOptions: billToParties.map((p) => ({
      value: p.id,
      label: p.name,
      meta: [p.alias, p.gstin, p.pan].filter(Boolean).join(" · ") || undefined,
    })),
    vehicleOptions: vehicles.map((veh) => ({
      value: veh.id,
      label: veh.number,
      meta: veh.isOwn ? `Owned${veh.ownerNames ? " — " + veh.ownerNames : ""}` : `Broker — ${veh.ownerName ?? "?"}`,
    })),
    productOptions: products.map((p) => ({ value: p.id, label: p.name, meta: p.groupName })),
    bankOptions: banks.map((p) => ({ value: p.id, label: p.name })),
    partyDetails,
    vehicleOwners,
    productUnits,
    productTypes,
  };
}
