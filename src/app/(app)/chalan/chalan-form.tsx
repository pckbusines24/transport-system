"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { DateInput } from "@/components/data/date-input";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { Field, NumInput, PartyCombobox, VehicleCombobox, enterAdvances } from "@/components/fleet/fields";
import { LrPicker, SelectedLrList, type PendingLrRow } from "@/components/fleet/lr-picker";
import { computeChalan, dieselAdvanceAmount } from "@/lib/calc/chalan";
import { tdsPctFromPan, type TdsMode } from "@/lib/calc/tds";
import { formatDate, formatMoney, parseDdMmYyyy } from "@/lib/utils";
import {
  AdvanceAdjustGrid,
  advanceAdjustError,
  advanceAdjustLines,
} from "@/components/chalan/advance-adjust-grid";
import type { OpenAdvance } from "@/lib/party-advance";
import {
  finalizeChalan,
  saveBalancePayment,
  getBrokerAdvances,
  getBrokerTdsInfo,
  getPendingLrsForVehicle,
  saveChalan,
  saveChalanAdvances,
} from "./actions";

export interface BrokerOption {
  value: string;
  label: string;
  meta?: string;
  pan: string | null;
  tdsMode: TdsMode | null;
  transportName: string | null;
  ownerName: string | null;
}

export interface AdvanceRow {
  type:
    | "CASH"
    | "BANK"
    | "DIESEL"
    | "TOLL"
    | "TYRE"
    | "SPARE_PARTS"
    | "REPAIR"
    | "OTHER"
    | "ADVANCE_ADJ";
  supplierName: string;
  bankName: string;
  bankPartyId?: string | null;
  advanceType?: "HEAD" | "BANK_CASH" | "ADV_ADJ";
  headId?: string | null;
  /** ADVANCE_ADJ only — the advance voucher this row consumes */
  advanceId?: string | null;
  advanceVoucherNo?: string | null;
  /** ADVANCE_ADJ editor row only — advanceId -> amount, expanded on save */
  adjValues?: Record<string, number>;
  dieselQty: number;
  dieselRate: number;
  amount: number;
  date: string | null;
  remarks: string;
}

export interface ChalanRecord {
  id: string;
  chalanNo: string;
  chalanDate: string;
  brokerId: string;
  vehicleId: string;
  driverName: string;
  driverMobile: string;
  licenseNo: string;
  payableAt: string;
  transportName: string;
  ownerName: string;
  remarks: string;
  isFinal: boolean;
  paymentStatus: string;
  balRoundOff: number;
  balShortage: number;
  balPaidAmount: number;
  balPaymentDate: string | null;
  balPaymentHeadId: string | null;
  balPaymentMode: string;
  balRemarks: string;
  /** per-voucher advance adjustment applied in the balance-payment step */
  balAdvanceLines: { advanceId: string; amount: number }[];
  /** already settled against this chalan from a Payment Voucher */
  voucherSettled: number;
  /** combined SAVED settlement (chalan-side legacy + settlement voucher) —
      display only, never used to prefill the payment inputs */
  settledPaid?: number;
  settledShortage?: number;
  settledRoundOff?: number;
  settledAdvanceAdj?: number;
  podTotal: number;
  podDone: number;
  /** total shortage weight recorded across the LRs' PODs */
  podShortageWt: number;
  freight: number;
  rate: number;
  rateBasis: "QTY" | "ACTUAL_WT" | "CHARGE_WT" | "FIXED";
  detention: number;
  odcAmt: number;
  fineSlip: number;
  ldCharge: number;
  shortageAmt: number;
  otherAmt: number;
  otherRemarks: string;
  commissionPct: number;
  commissionAmt: number;
  mamool: number;
  courierCharge: number;
  tdsPct: number;
  startKm: number | null;
  unloadDate: string | null;
  unloadKm: number | null;
  unloadRemarks: string;
  lrs: PendingLrRow[];
  advances: AdvanceRow[];
}


export function ChalanForm({
  nextChalanNo,
  brokers,
  vehicles,
  banks,
  accountHeads,
  record,
}: {
  nextChalanNo: string;
  brokers: BrokerOption[];
  vehicles: { value: string; label: string; meta?: string }[];
  banks: { value: string; label: string; meta?: string }[];
  accountHeads: { value: string; label: string; meta?: string }[];
  record: ChalanRecord | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // the register view's filters, carried in so we can land back EXACTLY
  // where the user left (date range, broker, vehicle, tab, page — everything)
  const registerReturn = `/chalan/register${searchParams.get("ret") ? `?${searchParams.get("ret")}` : ""}`;
  const { toast } = useToast();

  // ------- header -------
  const [id, setId] = React.useState<string | null>(record?.id ?? null);
  const [chalanNo, setChalanNo] = React.useState(record?.chalanNo ?? nextChalanNo);
  const [dateText, setDateText] = React.useState(
    formatDate(record ? new Date(record.chalanDate) : new Date())
  );
  const [brokerId, setBrokerId] = React.useState<string | null>(record?.brokerId ?? null);
  const [brokerTds, setBrokerTds] = React.useState<{ pan: string | null; tdsMode: TdsMode | null } | null>(
    null
  );
  const [vehicleId, setVehicleId] = React.useState<string | null>(record?.vehicleId ?? null);
  const [driverName, setDriverName] = React.useState(record?.driverName ?? "");
  const [driverMobile, setDriverMobile] = React.useState(record?.driverMobile ?? "");
  const [licenseNo, setLicenseNo] = React.useState(record?.licenseNo ?? "");
  // new chalans default to Raigarh; editable
  const [payableAt, setPayableAt] = React.useState(record ? record.payableAt : "Raigarh");
  const [transportName, setTransportName] = React.useState(record?.transportName ?? "");
  const [ownerName, setOwnerName] = React.useState(record?.ownerName ?? "");
  const [remarks, setRemarks] = React.useState(record?.remarks ?? "");

  // ------- LRs -------
  const [pending, setPending] = React.useState<PendingLrRow[]>([]);
  const [selected, setSelected] = React.useState<PendingLrRow[]>(record?.lrs ?? []);

  // ------- amounts -------
  const [freight, setFreight] = React.useState(record?.freight ?? 0);
  const [rate, setRate] = React.useState(record?.rate ?? 0);
  const [rateBasis, setRateBasis] = React.useState<"QTY" | "ACTUAL_WT" | "CHARGE_WT" | "FIXED">(
    record?.rateBasis ?? "CHARGE_WT"
  );
  const [detention, setDetention] = React.useState(record?.detention ?? 0);
  const [odcAmt, setOdcAmt] = React.useState(record?.odcAmt ?? 0);
  const [fineSlip, setFineSlip] = React.useState(record?.fineSlip ?? 0);
  const [ldCharge, setLdCharge] = React.useState(record?.ldCharge ?? 0);
  const [shortageAmt, setShortageAmt] = React.useState(record?.shortageAmt ?? 0);
  const [otherAmt, setOtherAmt] = React.useState(record?.otherAmt ?? 0);
  const [otherRemarks, setOtherRemarks] = React.useState(record?.otherRemarks ?? "");
  const [commMode, setCommMode] = React.useState<"PCT" | "MANUAL">(
    record && record.commissionPct === 0 && record.commissionAmt > 0 ? "MANUAL" : "PCT"
  );
  const [commissionPct, setCommissionPct] = React.useState(record?.commissionPct ?? 0);
  const [commissionAmt, setCommissionAmt] = React.useState(record?.commissionAmt ?? 0);
  const [mamool, setMamool] = React.useState(record?.mamool ?? 0);
  const [courierCharge, setCourierCharge] = React.useState(record?.courierCharge ?? 0);
  const [tdsPct, setTdsPct] = React.useState(record?.tdsPct ?? 0);
  const [tdsOverridden, setTdsOverridden] = React.useState(!!record);

  // ------- trip km -------
  const [startKm, setStartKm] = React.useState(record?.startKm ?? 0);
  const [unloadDateText, setUnloadDateText] = React.useState(
    record?.unloadDate ? formatDate(new Date(record.unloadDate)) : ""
  );
  const [unloadKm, setUnloadKm] = React.useState(record?.unloadKm ?? 0);
  const [unloadRemarks, setUnloadRemarks] = React.useState(record?.unloadRemarks ?? "");

  // ------- advances -------
  // ADVANCE_ADJ rows are persisted one-per-voucher but edited as a single grid
  // row, so collapse them on load and expand again on save.
  const [advances, setAdvances] = React.useState<AdvanceRow[]>(() => {
    const rows = record?.advances ?? [];
    const adj = rows.filter((r) => r.type === "ADVANCE_ADJ");
    const rest = rows.filter((r) => r.type !== "ADVANCE_ADJ");
    if (!adj.length) return rest;
    const adjValues: Record<string, number> = {};
    for (const r of adj) if (r.advanceId) adjValues[r.advanceId] = r.amount;
    return [
      ...rest,
      {
        type: "ADVANCE_ADJ",
        advanceType: "ADV_ADJ",
        adjValues,
        headId: null,
        supplierName: "",
        bankName: "",
        bankPartyId: null,
        dieselQty: 0,
        dieselRate: 0,
        amount: adj.reduce((s, r) => s + r.amount, 0),
        date: adj[0]?.date ?? null,
        remarks: adj[0]?.remarks ?? "",
      } as AdvanceRow,
    ];
  });

  // open advance vouchers of the broker, per section (each adds back its own
  // consumption so editing a saved chalan shows a truthful available balance)
  const [advOptions, setAdvOptions] = React.useState<OpenAdvance[]>([]);
  const [balAdvOptions, setBalAdvOptions] = React.useState<OpenAdvance[]>([]);
  const [advLoading, setAdvLoading] = React.useState(false);
  const [balAdjValues, setBalAdjValues] = React.useState<Record<string, number>>(() => {
    const v: Record<string, number> = {};
    for (const l of record?.balAdvanceLines ?? []) v[l.advanceId] = l.amount;
    return v;
  });

  // ------- balance payment (PENDING -> PAID) -------
  const [balRoundOff, setBalRoundOff] = React.useState(record?.balRoundOff ?? 0);
  const [balShortage, setBalShortage] = React.useState(record?.balShortage ?? 0);
  const [balDateText, setBalDateText] = React.useState(
    record?.balPaymentDate ? formatDate(new Date(record.balPaymentDate)) : formatDate(new Date())
  );
  const [balHeadId, setBalHeadId] = React.useState<string | null>(record?.balPaymentHeadId ?? null);
  const [balMode, setBalMode] = React.useState(record?.balPaymentMode ?? "BANK");
  const [balRemarks, setBalRemarks] = React.useState(record?.balRemarks ?? "");
  const [balSaving, setBalSaving] = React.useState(false);
  const [paymentStatus, setPaymentStatus] = React.useState(record?.paymentStatus ?? "PENDING");
  const podTotal = record?.podTotal ?? 0;
  const podDone = record?.podDone ?? 0;
  const allPodDone = podTotal > 0 && podDone >= podTotal;

  const [saving, setSaving] = React.useState(false);
  const isFinal = record?.isFinal ?? false;

  // fetch pending LRs when vehicle changes
  React.useEffect(() => {
    if (!vehicleId) {
      setPending([]);
      return;
    }
    getPendingLrsForVehicle(vehicleId, id ?? undefined).then((rows) =>
      setPending(rows.filter((r) => !selected.some((s) => s.id === r.id)))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId, id]);

  // broker's open advance vouchers (both sections)
  const refreshAdvanceOptions = React.useCallback(() => {
    if (!brokerId) {
      setAdvOptions([]);
      setBalAdvOptions([]);
      return;
    }
    setAdvLoading(true);
    Promise.all([
      getBrokerAdvances(brokerId, id, "ADVANCE"),
      getBrokerAdvances(brokerId, id, "BALANCE"),
    ])
      .then(([a, b]) => {
        setAdvOptions(a);
        setBalAdvOptions(b);
      })
      .finally(() => setAdvLoading(false));
  }, [brokerId, id]);

  React.useEffect(() => {
    refreshAdvanceOptions();
  }, [refreshAdvanceOptions]);

  // brokers created inline carry transportName/ownerName on the option —
  // merged here so the two-way name link works without a page reload
  const [createdBrokers, setCreatedBrokers] = React.useState<BrokerOption[]>([]);
  const allBrokers = React.useMemo(
    () => [...brokers, ...createdBrokers.filter((c) => !brokers.some((b) => b.value === c.value))],
    [brokers, createdBrokers]
  );

  // auto TDS pct from broker PAN
  React.useEffect(() => {
    if (!brokerId) return;
    const b = allBrokers.find((x) => x.value === brokerId);
    const apply = (pan: string | null, mode: TdsMode | null) => {
      setBrokerTds({ pan, tdsMode: mode });
      if (!tdsOverridden) setTdsPct(tdsPctFromPan(pan, mode));
    };
    if (b) apply(b.pan, b.tdsMode);
    else getBrokerTdsInfo(brokerId).then((info) => apply(info.pan, info.tdsMode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerId]);

  /** the adjustment row's amount is the sum of its per-voucher entries */
  const advAmount = (a: AdvanceRow) =>
    a.type === "ADVANCE_ADJ"
      ? Math.round(
          Object.values(a.adjValues ?? {}).reduce((s, n) => s + (n || 0), 0) * 100
        ) / 100
      : a.amount;

  const bookingFreight = selected.reduce((s, r) => s + r.freight, 0);
  const actualWt = selected.reduce((s, r) => s + r.actualWt, 0);
  const chargeWt = selected.reduce((s, r) => s + r.chargeWt, 0);

  const totals = computeChalan({
    rate,
    rateBasis,
    qty: selected.reduce((s, r) => s + r.qty, 0),
    actualWt,
    chargeWt,
    manualFreight: rate > 0 ? 0 : freight,
    detention,
    odcAmt,
    fineSlip,
    otherAmt,
    ldCharge,
    shortageAmt,
    mamool,
    courierCharge,
    commissionPct: commMode === "PCT" ? commissionPct : 0,
    commissionAmt: commMode === "MANUAL" ? commissionAmt : 0,
    tdsPct,
    advances: advances.map(advAmount),
  });

  // balance section: only what a Payment Voucher has not already settled is
  // available here — the two modules share one outstanding
  const voucherSettled = record?.voucherSettled ?? 0;
  const balOpen = Math.round((totals.balance - voucherSettled) * 100) / 100;
  const balSettleable = Math.round((balOpen - balRoundOff - balShortage) * 100) / 100;
  const balAdjTotal =
    Math.round(Object.values(balAdjValues).reduce((s, n) => s + (n || 0), 0) * 100) / 100;
  const balPaidPreview = Math.round((balSettleable - balAdjTotal) * 100) / 100;
  const balAdjError = advanceAdjustError(balAdvOptions, balAdjValues, balSettleable);

  const handleBalancePayment = async () => {
    if (!id) return;
    if (!allPodDone) {
      toast({
        variant: "destructive",
        title: "POD not complete",
        description: `POD is ${podDone}/${podTotal} — all LRs must have a confirmed POD first.`,
      });
      return;
    }
    const d = parseDdMmYyyy(balDateText);
    if (!d) {
      toast({ variant: "destructive", title: "Valid payment date is required" });
      return;
    }
    if (balAdjError) {
      toast({ variant: "destructive", title: "Advance adjustment invalid", description: balAdjError });
      return;
    }
    // the head is only needed when money actually leaves the bank/cash book
    if (balPaidPreview > 0.009 && !balHeadId) {
      toast({ variant: "destructive", title: "Select the bank/cash payment head" });
      return;
    }
    setBalSaving(true);
    try {
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const res = await saveBalancePayment({
        chalanId: id,
        roundOff: balRoundOff,
        shortage: balShortage,
        paymentDate: `${d.getFullYear()}-${mm}-${dd}`,
        paymentHeadId: balHeadId,
        paymentMode: balMode as
          | "CASH"
          | "BANK"
          | "CARD"
          | "UPI"
          | "CHEQUE"
          | "NEFT_RTGS"
          | "ADVANCE_ADJ",
        remarks: balRemarks,
        advanceLines: advanceAdjustLines(balAdvOptions, balAdjValues).map((l) => ({
          advanceId: l.advanceId,
          amount: l.amount,
        })),
      });
      if (res.ok) {
        setPaymentStatus("PAID");
        toast({
          title: "Balance settled — chalan marked PAID",
          description: `Paid ${formatMoney(res.paidAmount)} — posted to the bank/cash book.`,
        });
        // back to the register WITH its filters, refreshed for the new status
        router.push(registerReturn);
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Balance payment failed", description: res.error });
        setBalSaving(false);
      }
    } catch {
      setBalSaving(false);
    }
  };

  const autoTdsPct = tdsPctFromPan(brokerTds?.pan, brokerTds?.tdsMode);
  const tdsBadge =
    brokerTds?.tdsMode === "DECLARATION"
      ? "0% — declaration"
      : autoTdsPct === 1
        ? "1% — individual PAN"
        : "2% — company PAN";

  const runningKm = startKm && unloadKm ? unloadKm - startKm : 0;
  const chalanDate = parseDdMmYyyy(dateText);
  const unloadDate = parseDdMmYyyy(unloadDateText);
  const tripDays =
    chalanDate && unloadDate
      ? Math.max(0, Math.round((unloadDate.getTime() - chalanDate.getTime()) / 86400000))
      : 0;

  const buildPayload = () => ({
    id,
    chalanNo,
    chalanDate: chalanDate ? chalanDate.toISOString() : new Date().toISOString(),
    brokerId,
    vehicleId,
    driverName,
    driverMobile,
    licenseNo,
    payableAt,
    transportName,
    ownerName,
    remarks,
    lrIds: selected.map((r) => r.id),
    freight,
    rate,
    rateBasis,
    detention,
    odcAmt,
    fineSlip,
    ldCharge,
    shortageAmt,
    otherAmt,
    otherRemarks,
    commissionPct: commMode === "PCT" ? commissionPct : 0,
    commissionAmt: commMode === "MANUAL" ? commissionAmt : 0,
    mamool,
    courierCharge,
    tdsPct,
    startKm: startKm || null,
    unloadDate: unloadDate ? unloadDate.toISOString() : null,
    unloadKm: unloadKm || null,
    unloadRemarks,
  });

  const handleSave = async () => {
    if (!brokerId || !vehicleId || !chalanNo || !chalanDate) {
      toast({ variant: "destructive", title: "Broker, vehicle, chalan no & date are required" });
      return;
    }
    if (selected.length === 0) {
      toast({
        variant: "destructive",
        title: "Select at least one LR",
        description: "A chalan cannot be saved without LRs — pick them from the pending list.",
      });
      return;
    }
    setSaving(true);
    const res = await saveChalan(buildPayload());
    setSaving(false);
    if (res.ok) {
      if (!id) {
        setId(res.id);
        router.replace(`/chalan?id=${res.id}`, { scroll: false });
      }
      toast({ title: "Chalan saved", description: "You can now add advances." });
    } else {
      toast({ variant: "destructive", title: "Save failed", description: res.error });
    }
  };

  /** Expand the single adjustment editor row into one row per advance voucher. */
  const buildAdvancePayload = () =>
    advances.flatMap((a) => {
      if (a.type !== "ADVANCE_ADJ") return [{ ...a, adjValues: undefined }];
      return advanceAdjustLines(advOptions, a.adjValues ?? {}).map((l) => ({
        ...a,
        adjValues: undefined,
        advanceId: l.advanceId,
        advanceVoucherNo: l.voucherNo,
        amount: l.amount,
      }));
    });

  /** Cap for the advance-section grid: what the chalan owes minus other advances. */
  const advAdjRow = advances.find((a) => a.type === "ADVANCE_ADJ");
  const otherAdvanceTotal = advances
    .filter((a) => a.type !== "ADVANCE_ADJ")
    .reduce((s, a) => s + a.amount, 0);
  const advAdjPayable = Math.round((totals.grandTotal - otherAdvanceTotal) * 100) / 100;
  const advAdjError = advAdjRow
    ? advanceAdjustError(advOptions, advAdjRow.adjValues ?? {}, advAdjPayable)
    : null;

  const handleSaveAdvances = async () => {
    if (!id) return;
    if (advAdjError) {
      toast({ variant: "destructive", title: "Advance adjustment invalid", description: advAdjError });
      return;
    }
    setSaving(true);
    const res = await saveChalanAdvances(id, buildAdvancePayload());
    setSaving(false);
    if (res.ok) {
      toast({ title: "Advances saved" });
      refreshAdvanceOptions();
    } else toast({ variant: "destructive", title: "Save failed", description: res.error });
  };

  const handleFinalSave = async () => {
    if (!id) return;
    setSaving(true);
    // persist latest edits + advances first, then finalize
    const s = await saveChalan(buildPayload());
    if (!s.ok) {
      setSaving(false);
      toast({ variant: "destructive", title: "Save failed", description: s.error });
      return;
    }
    if (advAdjError) {
      setSaving(false);
      toast({ variant: "destructive", title: "Advance adjustment invalid", description: advAdjError });
      return;
    }
    const a = await saveChalanAdvances(id, buildAdvancePayload());
    if (!a.ok) {
      setSaving(false);
      toast({ variant: "destructive", title: "Save failed", description: a.error });
      return;
    }
    const res = await finalizeChalan(id);
    setSaving(false);
    if (res.ok) {
      toast({ title: "Chalan finalized", description: "LRs moved to ON CHALAN." });
      router.push(registerReturn);
    } else {
      toast({ variant: "destructive", title: "Finalize failed", description: res.error });
    }
  };

  const setAdvance = (i: number, patch: Partial<AdvanceRow>) =>
    setAdvances((prev) =>
      prev.map((row, idx) => {
        if (idx !== i) return row;
        const next = { ...row, ...patch };
        if (next.type === "DIESEL" && ("dieselQty" in patch || "dieselRate" in patch || patch.type)) {
          next.amount = dieselAdvanceAmount(next.dieselQty, next.dieselRate);
        }
        return next;
      })
    );

  const brokerName = allBrokers.find((b) => b.value === brokerId)?.label;

  // Owner ↔ Transport Name two-way link, mapped in the Owner Master:
  // picking either one fills the other automatically
  const selectBroker = (v: string | null, createdOpt?: MasterOption) => {
    setBrokerId(v);
    setTdsOverridden(false);
    // a just-created broker isn't in the props list yet — take the name-link
    // data straight off the created option and remember it locally
    const extra = createdOpt as
      | (MasterOption & { transportName?: string | null; ownerName?: string | null })
      | undefined;
    if (v && extra && extra.value === v && !allBrokers.some((b) => b.value === v)) {
      const nb: BrokerOption = {
        value: extra.value,
        label: extra.label,
        meta: extra.meta,
        pan: null,
        tdsMode: null,
        transportName: extra.transportName ?? null,
        ownerName: extra.ownerName ?? extra.label,
      };
      setCreatedBrokers((prev) => [...prev, nb]);
      setTransportName(nb.transportName ?? "");
      setOwnerName(nb.ownerName ?? nb.label);
      return;
    }
    const b = allBrokers.find((x) => x.value === v);
    if (b) {
      setTransportName(b.transportName ?? "");
      setOwnerName(b.ownerName ?? b.label);
    }
  };
  const transportOptions = allBrokers
    .filter((b) => b.transportName)
    .map((b) => ({ value: b.value, label: b.transportName as string, meta: b.label }));

  return (
    <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          Chalan Entry{" "}
          {isFinal && <Badge className="ml-2 align-middle">Final</Badge>}
          {id && !isFinal && (
            <Badge variant="secondary" className="ml-2 align-middle">
              Draft
            </Badge>
          )}
        </h1>
        <div className="flex flex-wrap gap-2">
          {id && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/print/chalan/${id}`} target="_blank">
                Print
              </Link>
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <Link href="/chalan/register">Register</Link>
          </Button>
        </div>
      </div>

      {/* header */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Chalan Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Chalan No">
            <Input value={chalanNo} onChange={(e) => setChalanNo(e.target.value)} onKeyDown={enterAdvances} />
          </Field>
          <Field label="Date">
            <DateInput value={dateText} onChange={(t) => setDateText(t)} />
          </Field>
          <Field label="Broker / Owner">
            <PartyCombobox
              options={allBrokers}
              value={brokerId}
              onChange={(v, opt) => selectBroker(v, opt)}
              ledgerGroup="OWNER_BROKER"
              placeholder="Select broker..."
            />
          </Field>
          <Field label="Transport Name (auto-links the owner)">
            <MasterCombobox
              options={transportOptions}
              value={
                brokerId &&
                allBrokers.find((b) => b.value === brokerId)?.transportName === transportName &&
                transportName
                  ? brokerId
                  : null
              }
              onChange={(v) => selectBroker(v)}
              placeholder={transportName || "Select transport name..."}
            />
          </Field>
          <Field label="Vehicle">
            <VehicleCombobox options={vehicles} value={vehicleId} onChange={setVehicleId} />
          </Field>
          <Field label="Driver Name">
            <Input value={driverName} onChange={(e) => setDriverName(e.target.value)} onKeyDown={enterAdvances} />
          </Field>
          <Field label="Driver Mobile">
            <Input value={driverMobile} onChange={(e) => setDriverMobile(e.target.value)} onKeyDown={enterAdvances} />
          </Field>
          <Field label="License No">
            <Input value={licenseNo} onChange={(e) => setLicenseNo(e.target.value)} onKeyDown={enterAdvances} />
          </Field>
          <Field label="Payable At">
            <Input value={payableAt} onChange={(e) => setPayableAt(e.target.value)} onKeyDown={enterAdvances} />
          </Field>
        </CardContent>
      </Card>

      {/* LR picker */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">LRs on this Chalan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 p-4 pt-0">
          {vehicleId ? (
            <LrPicker
              rows={pending.filter((p) => !selected.some((s) => s.id === p.id))}
              onAdd={(rows) => {
                // Rate/Amount is entered manually — do NOT auto-fill from the LR.
                // Only quantities/weights (used for display) come from the LRs.
                setSelected((prev) => [...prev, ...rows]);
              }}
              title="Pending LRs for vehicle"
            />
          ) : (
            <div className="text-sm text-muted-foreground">
              Select a vehicle to load its pending LRs.
            </div>
          )}
          <SelectedLrList
            rows={selected}
            onRemove={(lrId) => setSelected((prev) => prev.filter((r) => r.id !== lrId))}
          />
        </CardContent>
      </Card>

      {/* amounts */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Amounts</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Rate">
            <NumInput value={rate} onChange={setRate} />
          </Field>
          <Field label="Rate Basis">
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={rateBasis}
              onChange={(e) => setRateBasis(e.target.value as typeof rateBasis)}
            >
              <option value="CHARGE_WT">Per Charge Wt</option>
              <option value="ACTUAL_WT">Per Actual Wt</option>
              <option value="QTY">Per Qty</option>
              <option value="FIXED">Fixed Amount</option>
            </select>
          </Field>
          <Field label={rate > 0 ? "Vehicle Freight (auto = rate × basis)" : "Vehicle Freight (manual)"}>
            <NumInput
              value={rate > 0 ? totals.freight : freight}
              onChange={setFreight}
              readOnly={rate > 0}
            />
          </Field>
          <Field label="Booking Freight (reference — not printed)">
            <NumInput value={bookingFreight} readOnly />
          </Field>
          <Field label="Actual Wt">
            <NumInput value={actualWt} readOnly />
          </Field>
          <Field label="Charge Wt">
            <NumInput value={chargeWt} readOnly />
          </Field>
          <Field label="Detention">
            <NumInput value={detention} onChange={setDetention} />
          </Field>
          <Field label="ODC Amount">
            <NumInput value={odcAmt} onChange={setOdcAmt} />
          </Field>
          <Field label="Fine Slip">
            <NumInput value={fineSlip} onChange={setFineSlip} />
          </Field>
          <Field label="LD Charge (−)">
            <NumInput value={ldCharge} onChange={setLdCharge} />
          </Field>
          <Field label="Shortage Amount (−)">
            <NumInput value={shortageAmt} onChange={setShortageAmt} />
          </Field>
          <Field label="Other Amount">
            <NumInput value={otherAmt} onChange={setOtherAmt} />
          </Field>
          <Field label="Other Remarks" className="sm:col-span-2">
            <Input value={otherRemarks} onChange={(e) => setOtherRemarks(e.target.value)} onKeyDown={enterAdvances} />
          </Field>

          <Field label="Commission" className="lg:col-span-2">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="commMode"
                  checked={commMode === "PCT"}
                  onChange={() => setCommMode("PCT")}
                />
                %
              </label>
              <NumInput
                value={commissionPct}
                onChange={setCommissionPct}
                disabled={commMode !== "PCT"}
                className="w-20"
              />
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="commMode"
                  checked={commMode === "MANUAL"}
                  onChange={() => setCommMode("MANUAL")}
                />
                Manual
              </label>
              <NumInput
                value={commissionAmt}
                onChange={setCommissionAmt}
                disabled={commMode !== "MANUAL"}
                className="w-28"
              />
              <span className="text-sm text-muted-foreground">
                = {formatMoney(totals.commissionAmt)}
              </span>
            </div>
          </Field>
          <Field label="Mamool">
            <NumInput value={mamool} onChange={setMamool} />
          </Field>
          <Field label="Courier Charge">
            <NumInput value={courierCharge} onChange={setCourierCharge} />
          </Field>

          <Field label="TDS %" className="lg:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <NumInput
                value={brokerTds?.tdsMode === "DECLARATION" ? 0 : tdsPct}
                onChange={(n) => {
                  setTdsPct(n);
                  setTdsOverridden(true);
                }}
                readOnly={brokerTds?.tdsMode === "DECLARATION"}
                className="w-20"
              />
              {brokerTds?.tdsMode === "DECLARATION" && (
                <Badge variant="default">Declared — TDS not applicable</Badge>
              )}
              {brokerTds && (
                <Badge variant={tdsPct === autoTdsPct ? "secondary" : "outline"}>{tdsBadge}</Badge>
              )}
              <span className="text-sm text-muted-foreground">
                TDS = {formatMoney(totals.tdsAmt)}
              </span>
            </div>
          </Field>
          <Field label="Remarks" className="lg:col-span-2">
            <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} onKeyDown={enterAdvances} />
          </Field>
        </CardContent>
      </Card>

      {/* step 1 save */}
      {!id && (
        <div className="flex justify-end">
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save (Step 1)"}
          </Button>
        </div>
      )}

      {/* advances */}
      <Card className={!id ? "opacity-50" : undefined}>
        <CardHeader className="flex flex-row items-center justify-between p-4 pb-2">
          <CardTitle className="text-sm">
            Advances {brokerName && <span className="font-normal text-muted-foreground">— {brokerName}</span>}
          </CardTitle>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!id}
            onClick={() =>
              setAdvances((prev) => [
                ...prev,
                {
                  type: "BANK",
                  advanceType: "BANK_CASH",
                  headId: null,
                  supplierName: "",
                  bankName: "",
                  bankPartyId: null,
                  dieselQty: 0,
                  dieselRate: 0,
                  amount: 0,
                  date: new Date().toISOString(),
                  remarks: "",
                },
              ])
            }
          >
            + Add advance
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 p-4 pt-0">
          {!id && (
            <div className="text-sm text-muted-foreground">Save the chalan first to add advances.</div>
          )}
          {advances.map((a, i) => (
            <div key={i} className="grid items-end gap-2 rounded-md border p-2 sm:grid-cols-2 lg:grid-cols-6">
              <Field label="Advance Type">
                <Select
                  value={a.advanceType ?? "BANK_CASH"}
                  onValueChange={(v) =>
                    setAdvance(i, {
                      advanceType: v as "HEAD" | "BANK_CASH" | "ADV_ADJ",
                      type: v === "BANK_CASH" ? "BANK" : v === "ADV_ADJ" ? "ADVANCE_ADJ" : "OTHER",
                      headId: null,
                      bankPartyId: null,
                      bankName: "",
                      adjValues: v === "ADV_ADJ" ? {} : undefined,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="HEAD">Income / Expense Head</SelectItem>
                    <SelectItem value="BANK_CASH">Bank / Cash Head</SelectItem>
                    <SelectItem
                      value="ADV_ADJ"
                      disabled={a.type !== "ADVANCE_ADJ" && advances.some((r) => r.type === "ADVANCE_ADJ")}
                    >
                      Advance Adjustment
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              {a.type === "ADVANCE_ADJ" ? (
                <>
                  <div className="sm:col-span-2 lg:col-span-4">
                    <AdvanceAdjustGrid
                      advances={advOptions}
                      values={a.adjValues ?? {}}
                      onChange={(next) => setAdvance(i, { adjValues: next })}
                      payable={advAdjPayable}
                      loading={advLoading}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setAdvances((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                </>
              ) : (
                <>
              <Field label={(a.advanceType ?? "BANK_CASH") === "HEAD" ? "Head" : "Bank / Cash"}>
                <MasterCombobox
                  options={(a.advanceType ?? "BANK_CASH") === "HEAD" ? accountHeads : banks}
                  value={a.headId ?? a.bankPartyId ?? null}
                  onChange={(v) => {
                    const isHead = (a.advanceType ?? "BANK_CASH") === "HEAD";
                    const opts = isHead ? accountHeads : banks;
                    const label = opts.find((o) => o.value === v)?.label ?? "";
                    // a head advance credits the chosen expense head; a bank /
                    // cash one credits the party — never both
                    setAdvance(i, {
                      headId: isHead ? v : null,
                      bankPartyId: isHead ? null : v,
                      bankName: label,
                    });
                  }}
                  placeholder="Select..."
                />
              </Field>
              <Field label="Amount">
                <NumInput value={a.amount} onChange={(n) => setAdvance(i, { amount: n })} />
              </Field>
              <Field label="Date">
                <DateInput
                  value={a.date ? formatDate(new Date(a.date)) : ""}
                  onChange={(_, d) => setAdvance(i, { date: d ? d.toISOString() : null })}
                />
              </Field>
              <Field label="Remarks">
                <Input
                  value={a.remarks}
                  onChange={(e) => setAdvance(i, { remarks: e.target.value })}
                  placeholder="Advance remarks..."
                />
              </Field>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setAdvances((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  Remove
                </Button>
              </div>
                </>
              )}
            </div>
          ))}
          {advAdjError && <div className="text-xs text-destructive">{advAdjError}</div>}
          {id && advances.length > 0 && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSaveAdvances}
                disabled={saving || !!advAdjError}
              >
                Save advances
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* trip km */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Trip KM</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Start KM">
            <NumInput value={startKm} onChange={setStartKm} />
          </Field>
          <Field label="Unload Date">
            <DateInput value={unloadDateText} onChange={(t) => setUnloadDateText(t)} />
          </Field>
          <Field label="Unload KM">
            <NumInput value={unloadKm} onChange={setUnloadKm} />
          </Field>
          <Field label="Running KM">
            <NumInput value={runningKm} readOnly />
          </Field>
          <Field label="Trip Days">
            <NumInput value={tripDays} readOnly />
          </Field>
          <Field label="Unload Remarks">
            <Input value={unloadRemarks} onChange={(e) => setUnloadRemarks(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      {/* summary */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Summary</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <SummaryItem label="Total Freight" value={totals.totalChalanAmt} />
            <SummaryItem label="Commission" value={totals.commissionAmt} negative />
            <SummaryItem label="Mamool" value={mamool} negative />
            <SummaryItem label="Courier" value={courierCharge} negative />
            <SummaryItem label="TDS" value={totals.tdsAmt} negative />
            <SummaryItem label="Other" value={otherAmt} />
            <SummaryItem label="Advance Paid" value={totals.advanceTotal} negative />
            <div className="rounded-md border bg-muted/40 p-2">
              <div className="text-xs text-muted-foreground">Final Balance Payable</div>
              <div className="text-lg font-semibold tabular-nums">{formatMoney(totals.balance)}</div>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : id ? "Save changes" : "Save (Step 1)"}
            </Button>
            <Button type="button" onClick={handleFinalSave} disabled={saving || !id}>
              Final Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* balance payment — available once the chalan exists */}
      {id && (
        <Card id="balance" className={isFinal ? "border-primary/50" : "opacity-70"}>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="flex items-center justify-between text-sm">
              <span className="flex flex-wrap items-center gap-2">
                Balance Payment
                {paymentStatus === "PAID" ? (
                  <Badge>PAID</Badge>
                ) : (
                  <Badge variant="destructive">Pending Balance</Badge>
                )}
              </span>
              {!isFinal ? (
                <span className="text-xs font-normal text-muted-foreground">
                  Finalize the chalan first to settle its balance
                </span>
              ) : !allPodDone ? (
                <Badge variant="destructive">POD {podDone}/{podTotal} — complete all PODs to pay balance</Badge>
              ) : (
                <Badge>POD {podDone}/{podTotal} complete</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 p-4 pt-2 sm:grid-cols-2 lg:grid-cols-4">
            {/* saved settlement at a glance — the money lives on the
                settlement voucher, so the input previews below read 0 once
                everything is settled */}
            {paymentStatus === "PAID" && record && (
              <div className="rounded-md border bg-muted/40 p-2 text-xs sm:col-span-2 lg:col-span-4">
                <b>Settled:</b> Paid {formatMoney(record.settledPaid ?? 0)}
                {(record.settledShortage ?? 0) > 0.009 && (
                  <> · Shortage {formatMoney(record.settledShortage ?? 0)}</>
                )}
                {Math.abs(record.settledRoundOff ?? 0) > 0.009 && (
                  <> · Round off {formatMoney(record.settledRoundOff ?? 0)}</>
                )}
                {(record.settledAdvanceAdj ?? 0) > 0.009 && (
                  <> · Advance adjusted {formatMoney(record.settledAdvanceAdj ?? 0)}</>
                )}
                {record.balPaymentDate && <> — on {formatDate(record.balPaymentDate)}</>}
                {record.balPaymentMode && <> ({record.balPaymentMode})</>}
                <span className="text-muted-foreground"> · edit/delete: Voucher Register</span>
              </div>
            )}
            <Field label="Balance Amount">
              <div className="space-y-1">
                <NumInput value={balOpen} readOnly />
                {voucherSettled > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {formatMoney(voucherSettled)} of {formatMoney(totals.balance)} already settled
                    by a payment voucher
                  </div>
                )}
              </div>
            </Field>
            <Field label="Round Off (−)">
              <NumInput value={balRoundOff} onChange={setBalRoundOff} />
            </Field>
            <Field label="Shortage (−)">
              <div className="space-y-1">
                <NumInput value={balShortage} onChange={setBalShortage} />
                {(record?.podShortageWt ?? 0) > 0 && (
                  <div className="text-xs text-muted-foreground">
                    POD shortage: {record?.podShortageWt} (wt) — enter the amount to deduct
                  </div>
                )}
              </div>
            </Field>
            <Field label="Advance Adjusted (−)">
              <NumInput value={balAdjTotal} readOnly />
            </Field>
            <Field label="Final Paid Amount">
              <NumInput value={balPaidPreview} readOnly />
            </Field>
            <div className="sm:col-span-2 lg:col-span-4">
              <div className="mb-1 text-xs text-muted-foreground">
                Advance Adjustment — settle the balance against this party&apos;s advance vouchers
              </div>
              <AdvanceAdjustGrid
                advances={balAdvOptions}
                values={balAdjValues}
                onChange={setBalAdjValues}
                payable={balSettleable}
                loading={advLoading}
              />
            </div>
            <Field label="Payment Date">
              <DateInput value={balDateText} onChange={(t) => setBalDateText(t)} />
            </Field>
            <Field label="Payment Head (Bank / Cash)">
              <MasterCombobox
                options={banks}
                value={balHeadId}
                onChange={setBalHeadId}
                placeholder="Select head..."
              />
            </Field>
            <Field label="Payment Mode">
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={balMode}
                onChange={(e) => setBalMode(e.target.value)}
              >
                <option value="BANK">Bank Transfer</option>
                <option value="CASH">Cash</option>
                <option value="CARD">Card</option>
                <option value="UPI">UPI</option>
                <option value="CHEQUE">Cheque</option>
                <option value="NEFT_RTGS">NEFT / RTGS</option>
                <option value="ADVANCE_ADJ">Advance Adjustment</option>
              </select>
            </Field>
            <Field label="Remarks">
              <Input value={balRemarks} onChange={(e) => setBalRemarks(e.target.value)} />
            </Field>
            <div className="flex items-end sm:col-span-2 lg:col-span-4">
              <Button
                type="button"
                onClick={handleBalancePayment}
                disabled={balSaving || !isFinal || !allPodDone || !!balAdjError}
              >
                {balSaving
                  ? "Saving..."
                  : paymentStatus === "PAID"
                    ? "Update Balance Payment"
                    : "Save Balance Payment (mark PAID)"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </form>
  );
}

function SummaryItem({
  label,
  value,
  negative,
}: {
  label: string;
  value: number;
  negative?: boolean;
}) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">
        {negative && value > 0 ? "− " : ""}
        {formatMoney(value)}
      </div>
    </div>
  );
}
