"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Copy, Plus, Trash2 } from "lucide-react";
import { formatDate, formatMoney, parseDdMmYyyy, toNum } from "@/lib/utils";
import type { RateBasis } from "@/lib/calc/rate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  CityCreateDialog as CityDialog,
  PartyCreateDialog as PartyDialog,
  ProductCreateDialog as ProductDialog,
  VehicleCreateDialog as VehicleDialog,
} from "@/components/masters/inline-dialogs";
import type { LedgerGroup } from "@prisma/client";
import {
  ADVANCE_HEAD_KINDS,
  ADVANCE_HEAD_KIND_LABELS,
  advanceAmount,
  computeBrokerSide,
  computeTripKm,
  sideAdvanceTotal,
  type AdvanceHeadKind,
  type BrokerAdvance,
} from "@/components/broker/broker-calc";
import {
  AdvanceAdjustGrid,
  advanceAdjustError,
  advanceAdjustLines,
} from "@/components/chalan/advance-adjust-grid";
import type { OpenAdvance } from "@/lib/party-advance";
import {
  getBrokerSlipAdvances,
  saveBrokerBalancePayment,
  saveBrokerSlip,
} from "@/app/(app)/broker/actions";

export interface SideValues {
  rate: number;
  freight: number;
  detention: number;
  odcAmt: number;
  fineAmt: number;
  otherAmt: number;
  ldCharge: number;
  shortageAmt: number;
  tdsPct: number;
  tdsAmt: number;
  commPct: number;
  commAmt: number;
  mamool: number;
  paymentCharge: number;
  remarks: string;
}

export interface BrokerSlipFormData {
  id?: string | null;
  slipNo: string;
  slipDate: string; // ISO
  vehicleId?: string | null;
  transporterId?: string | null;
  loadStationId?: string | null;
  destCityId?: string | null;
  consignorId?: string | null;
  consigneeId?: string | null;
  lrNo: string;
  lrDate: string; // ISO or ""
  ewbNo: string;
  ewbDate: string;
  productId?: string | null;
  productName: string;
  qty: number;
  actualWt: number;
  chargeWt: number;
  unit: string;
  rateBasis: RateBasis; // legacy shared basis (kept for compatibility)
  pRateBasis: RateBasis;
  vRateBasis: RateBasis;
  partyId?: string | null;
  p: SideValues;
  ownerId?: string | null;
  ownerName: string;
  v: SideValues;
  advances: BrokerAdvance[];
  startKm?: number | null;
  unloadDate: string;
  unloadKm?: number | null;
  unloadRemarks: string;
  /** balance settlement, per side — only present on a saved slip */
  settle?: { P: SideSettlement; V: SideSettlement };
}

/** What a side's balance was settled with. */
export interface SideSettlement {
  status: string; // PENDING | RECEIVED | PAID
  roundOff: number;
  shortage: number;
  paidAmount: number;
  paymentDate: string; // ISO or ""
  paymentHeadId: string | null;
  paymentMode: string;
  remarks: string;
  /** combined SAVED figures (slip-side legacy + settlement voucher) —
      display only; the editable inputs above stay untouched by these */
  settledPaid?: number;
  settledShortage?: number;
  settledRoundOff?: number;
}

const emptySide = (): SideValues => ({
  rate: 0,
  freight: 0,
  detention: 0,
  odcAmt: 0,
  fineAmt: 0,
  otherAmt: 0,
  ldCharge: 0,
  shortageAmt: 0,
  tdsPct: 0,
  tdsAmt: 0,
  commPct: 0,
  commAmt: 0,
  mamool: 0,
  paymentCharge: 0,
  remarks: "",
});

const RATE_BASIS_OPTIONS: { value: RateBasis; label: string }[] = [
  { value: "QTY", label: "Quantity / Per Bag" },
  { value: "ACTUAL_WT", label: "Weight (Actual) / Per Ton" },
  { value: "CHARGE_WT", label: "Weight (Guaranteed) / Per Ton" },
  { value: "FIXED", label: "Fixed / Per Trip" },
];

function isoToText(iso: string): string {
  if (!iso) return "";
  return formatDate(new Date(iso + "T00:00:00"));
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function todayText(): string {
  return formatDate(new Date());
}

// small labelled number input
function Num({
  label,
  value,
  onChange,
  disabled,
  className,
}: {
  label: string;
  value: number;
  onChange?: (n: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={className ?? "space-y-1"}>
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step="any"
        className="h-8 text-right tabular-nums"
        value={Number.isFinite(value) ? String(value) : ""}
        disabled={disabled}
        onChange={(e) => onChange?.(toNum(e.target.value))}
        onFocus={(e) => e.target.select()}
      />
    </div>
  );
}

export interface BrokerNameOption extends MasterOption {
  transportName?: string | null;
  ownerName?: string | null;
}

interface BrokerSlipFormProps {
  initial: BrokerSlipFormData | null;
  nextSlipNo: string;
  cityOptions: MasterOption[];
  partyOptions: MasterOption[];
  /** brokers carry transportName/ownerName for the two-way name link */
  brokerOptions: BrokerNameOption[];
  vehicleOptions: MasterOption[];
  ownVehicleIds: string[];
  /** vehicles whose ownershipType is RELATIVE */
  relativeVehicleIds: string[];
  productOptions: MasterOption[];
  /** Income/Expense heads (value=id, meta=INCOME|EXPENSE) for advance entry */
  accountHeadOptions: MasterOption[];
  /** Bank/Cash accounts (value=party id, meta=BANK|CASH) for advance entry */
  bankCashOptions: MasterOption[];
}

export function BrokerSlipForm({
  initial,
  nextSlipNo,
  cityOptions: cityOptions0,
  partyOptions: partyOptions0,
  brokerOptions: brokerOptions0,
  vehicleOptions: vehicleOptions0,
  ownVehicleIds: ownVehicleIds0,
  relativeVehicleIds,
  productOptions: productOptions0,
  accountHeadOptions,
  bankCashOptions,
}: BrokerSlipFormProps) {
  const router = useRouter();
  const searchParamsNav = useSearchParams();
  // return to the register EXACTLY as the user left it (filters intact)
  const registerReturn = `/broker/register${searchParamsNav.get("ret") ? `?${searchParamsNav.get("ret")}` : ""}`;
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);

  // options grow via inline creates
  const [cityOptions, setCityOptions] = React.useState(cityOptions0);
  const [partyOptions, setPartyOptions] = React.useState(partyOptions0);
  const [brokerOptions, setBrokerOptions] = React.useState(brokerOptions0);
  const [vehicleOptions, setVehicleOptions] = React.useState(vehicleOptions0);
  const [productOptions, setProductOptions] = React.useState(productOptions0);
  const [ownVehicleIds] = React.useState(ownVehicleIds0);

  const [form, setForm] = React.useState<BrokerSlipFormData>(
    initial ?? {
      slipNo: nextSlipNo,
      slipDate: "",
      lrNo: "",
      lrDate: "",
      ewbNo: "",
      ewbDate: "",
      productName: "",
      qty: 0,
      actualWt: 0,
      chargeWt: 0,
      unit: "MT",
      rateBasis: "CHARGE_WT",
      pRateBasis: "CHARGE_WT",
      vRateBasis: "CHARGE_WT",
      p: emptySide(),
      ownerName: "",
      v: emptySide(),
      advances: [],
      unloadDate: "",
      unloadRemarks: "",
    }
  );
  // date display texts
  const [slipDateText, setSlipDateText] = React.useState(
    initial ? isoToText(initial.slipDate) : todayText()
  );
  const [lrDateText, setLrDateText] = React.useState(initial ? isoToText(initial.lrDate) : "");
  const [ewbDateText, setEwbDateText] = React.useState(initial ? isoToText(initial.ewbDate) : "");
  const [unloadDateText, setUnloadDateText] = React.useState(
    initial ? isoToText(initial.unloadDate) : ""
  );

  const set = <K extends keyof BrokerSlipFormData>(key: K, value: BrokerSlipFormData[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setSide = (side: "p" | "v", patch: Partial<SideValues>) =>
    setForm((f) => ({ ...f, [side]: { ...f[side], ...patch } }));

  const isOwnVehicle = !!form.vehicleId && ownVehicleIds.includes(form.vehicleId);

  // live totals
  const pAdvance = sideAdvanceTotal(form.advances, "P");
  const vAdvance = sideAdvanceTotal(form.advances, "V");
  const sideBasis = (side: "p" | "v") => (side === "p" ? form.pRateBasis : form.vRateBasis);
  const sideTotals = (s: SideValues, advance: number, basis: RateBasis) =>
    computeBrokerSide({
      rate: s.rate,
      rateBasis: basis,
      qty: form.qty,
      actualWt: form.actualWt,
      chargeWt: form.chargeWt,
      manualFreight: s.freight,
      detention: s.detention,
      odcAmt: s.odcAmt,
      fineAmt: s.fineAmt,
      otherAmt: s.otherAmt,
      ldCharge: s.ldCharge,
      shortageAmt: s.shortageAmt,
      tdsPct: s.tdsPct,
      tdsAmtManual: s.tdsAmt,
      commPct: s.commPct,
      commAmtManual: s.commAmt,
      mamool: s.mamool,
      paymentCharge: s.paymentCharge,
      advance,
    });
  const pTotals = sideTotals(form.p, pAdvance, form.pRateBasis);
  const vTotals = sideTotals(form.v, vAdvance, form.vRateBasis);
  const margin = pTotals.netAmt - vTotals.netAmt;

  const km = computeTripKm({
    startKm: form.startKm ?? null,
    unloadKm: form.unloadKm ?? null,
    slipDate: parseDdMmYyyy(slipDateText),
    unloadDate: parseDdMmYyyy(unloadDateText),
  });

  // freight auto from rate x that side's basis (still editable)
  const recomputeFreight = (side: "p" | "v", rate: number, basisOverride?: RateBasis) => {
    const auto = computeBrokerSide({
      rate,
      rateBasis: basisOverride ?? sideBasis(side),
      qty: form.qty,
      actualWt: form.actualWt,
      chargeWt: form.chargeWt,
      detention: 0,
      odcAmt: 0,
      fineAmt: 0,
      otherAmt: 0,
      ldCharge: 0,
      shortageAmt: 0,
      tdsPct: 0,
      commPct: 0,
      mamool: 0,
      paymentCharge: 0,
      advance: 0,
    }).freight;
    setSide(side, { rate, freight: auto });
  };

  const copyFromBooking = () => {
    setForm((f) => ({
      ...f,
      v: {
        ...f.v,
        rate: f.p.rate,
        freight: f.p.freight,
        detention: f.p.detention,
        odcAmt: f.p.odcAmt,
        fineAmt: f.p.fineAmt,
        otherAmt: f.p.otherAmt,
        ldCharge: f.p.ldCharge,
        shortageAmt: f.p.shortageAmt,
      },
    }));
  };

  const onVehicleChange = (v: string | null) => {
    set("vehicleId", v);
    if (v && ownVehicleIds.includes(v)) {
      setSide("v", { tdsPct: 0, tdsAmt: 0, commPct: 0, commAmt: 0, mamool: 0 });
    }
  };
  const isRelativeVehicle = !!form.vehicleId && relativeVehicleIds.includes(form.vehicleId);

  // Broker ↔ Transport Name two-way link, mapped in the Owner Master — same as
  // Chalan Entry. Both pickers select the same party, so picking either name
  // fills the other; the transport list carries the party id as its value, so a
  // trade name shared by two parties still resolves unambiguously.
  const selectBroker = (v: string | null) => {
    set("transporterId", v);
    const b = brokerOptions.find((x) => x.value === v);
    if (b && !form.ownerName) set("ownerName", b.ownerName ?? b.label);
  };
  // a broker created inline lands in brokerOptions a beat AFTER selectBroker
  // ran — backfill the owner name once the enriched option is in the list
  React.useEffect(() => {
    if (!form.transporterId || form.ownerName) return;
    const b = brokerOptions.find((x) => x.value === form.transporterId);
    if (b) set("ownerName", b.ownerName ?? b.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.transporterId, brokerOptions]);
  const transportOptions = brokerOptions
    .filter((b) => b.transportName)
    .map((b) => ({ value: b.value, label: b.transportName as string, meta: b.label }));
  const selectedTransport = brokerOptions.find((b) => b.value === form.transporterId);

  // ---------- advances ----------
  const addAdvance = () =>
    set("advances", [
      ...form.advances,
      { side: "V", type: "BANK", headKind: "BANK", headId: null, amount: 0, date: null, remarks: "" },
    ]);

  // ---------- advance adjustment ----------
  // Broker side may only consume advances RECEIVED from him, owner side only
  // advances PAID to him — same engine as Voucher Entry, so a balance used
  // anywhere disappears everywhere.
  const [advOpts, setAdvOpts] = React.useState<{ P: OpenAdvance[]; V: OpenAdvance[] }>({
    P: [],
    V: [],
  });
  const [advLoading, setAdvLoading] = React.useState(false);

  const refreshAdvances = React.useCallback(() => {
    const p = form.transporterId ?? null;
    const v = form.ownerId ?? null;
    if (!p && !v) return setAdvOpts({ P: [], V: [] });
    setAdvLoading(true);
    Promise.all([
      p ? getBrokerSlipAdvances(p, "P", form.id) : Promise.resolve([]),
      v ? getBrokerSlipAdvances(v, "V", form.id) : Promise.resolve([]),
    ])
      .then(([P, V]) => setAdvOpts({ P, V }))
      .finally(() => setAdvLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.transporterId, form.ownerId, form.id]);

  React.useEffect(() => {
    refreshAdvances();
  }, [refreshAdvances]);

  const adjValues = (side: "P" | "V"): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const a of form.advances) {
      if (a.type === "ADVANCE_ADJ" && a.side === side && a.advanceId) out[a.advanceId] = a.amount;
    }
    return out;
  };
  const setAdjValues = (side: "P" | "V", next: Record<string, number>) => {
    const kept = form.advances.filter((a) => !(a.type === "ADVANCE_ADJ" && a.side === side));
    const rows: BrokerAdvance[] = advanceAdjustLines(advOpts[side], next).map((l) => ({
      side,
      type: "ADVANCE_ADJ" as const,
      headKind: null,
      headId: null,
      advanceId: l.advanceId,
      advanceVoucherNo: l.voucherNo,
      amount: l.amount,
      date: null,
      remarks: null,
    }));
    set("advances", [...kept, ...rows]);
  };
  // an adjustment may not exceed what is still due on that side
  const adjPayable = (side: "P" | "V") => {
    const t = side === "P" ? pTotals : vTotals;
    const other = form.advances
      .filter((a) => a.side === side && a.type !== "ADVANCE_ADJ")
      .reduce((s, a) => s + advanceAmount(a), 0);
    return Math.round((t.netAmt - other) * 100) / 100;
  };
  const adjError = (side: "P" | "V") =>
    advanceAdjustError(advOpts[side], adjValues(side), adjPayable(side));

  // ---------- balance settlement ----------
  // Lives in the slip rather than a register dialog, so it can be reviewed and
  // corrected alongside the figures it settles — same shape as the chalan.
  const emptySettle = (): SideSettlement => ({
    status: "PENDING",
    roundOff: 0,
    shortage: 0,
    paidAmount: 0,
    paymentDate: "",
    paymentHeadId: null,
    paymentMode: "BANK",
    remarks: "",
  });
  const [settle, setSettle] = React.useState<{ P: SideSettlement; V: SideSettlement }>(
    initial?.settle ?? { P: emptySettle(), V: emptySettle() }
  );
  const [settleDateText, setSettleDateText] = React.useState<{ P: string; V: string }>({
    P: initial?.settle?.P.paymentDate ? isoToText(initial.settle.P.paymentDate) : formatDate(new Date()),
    V: initial?.settle?.V.paymentDate ? isoToText(initial.settle.V.paymentDate) : formatDate(new Date()),
  });
  const [settling, setSettling] = React.useState<"P" | "V" | null>(null);

  const setSide2 = (side: "P" | "V", patch: Partial<SideSettlement>) =>
    setSettle((s) => ({ ...s, [side]: { ...s[side], ...patch } }));

  const settleBalance = (side: "P" | "V") => (side === "P" ? pTotals.balance : vTotals.balance);
  const settlePreview = (side: "P" | "V") =>
    Math.round((settleBalance(side) - settle[side].roundOff - settle[side].shortage) * 100) / 100;

  const submitSettle = async (side: "P" | "V") => {
    if (!form.id) return;
    const d = parseDdMmYyyy(settleDateText[side]);
    if (!d) {
      toast({ variant: "destructive", title: "Valid payment date is required" });
      return;
    }
    if (settlePreview(side) > 0.009 && !settle[side].paymentHeadId) {
      toast({ variant: "destructive", title: "Select the bank/cash head" });
      return;
    }
    setSettling(side);
    try {
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const res = await saveBrokerBalancePayment({
        slipId: form.id,
        side,
        roundOff: settle[side].roundOff,
        shortage: settle[side].shortage,
        paymentDate: `${d.getFullYear()}-${mm}-${dd}`,
        paymentHeadId: settle[side].paymentHeadId,
        paymentMode: settle[side].paymentMode as
          | "CASH"
          | "BANK"
          | "CARD"
          | "UPI"
          | "CHEQUE"
          | "NEFT_RTGS",
        remarks: settle[side].remarks,
      });
      if (res.ok) {
        setSide2(side, {
          status: side === "P" ? "RECEIVED" : "PAID",
          paidAmount: res.paidAmount,
        });
        toast({
          title:
            side === "P"
              ? `Balance received — ${formatMoney(res.paidAmount)}`
              : `Balance paid — ${formatMoney(res.paidAmount)}`,
          description: "Posted to the bank/cash book and party ledger.",
        });
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Settlement failed", description: res.error });
      }
    } finally {
      setSettling(null);
    }
  };

  const settleCard = (side: "P" | "V") => {
    const isP = side === "P";
    const s = settle[side];
    const done = isP ? s.status === "RECEIVED" : s.status === "PAID";
    return (
      <Card id={isP ? "balance-receivable" : "balance-payable"}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span>{isP ? "Balance Receivable" : "Balance Payable"}</span>
            {done ? (
              <Badge>{isP ? "Received" : "Paid"}</Badge>
            ) : (
              <Badge variant="destructive">Pending</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {/* saved settlement at a glance — voucher-era figures live on the
              settlement voucher, so the raw slip columns can read 0 */}
          {done && (
            <div className="rounded-md border bg-muted/40 p-2 text-xs sm:col-span-2">
              <b>Settled:</b> {isP ? "Received" : "Paid"}{" "}
              {formatMoney(s.settledPaid ?? s.paidAmount)}
              {(s.settledShortage ?? s.shortage) > 0.009 && (
                <> · Shortage {formatMoney(s.settledShortage ?? s.shortage)}</>
              )}
              {Math.abs(s.settledRoundOff ?? s.roundOff) > 0.009 && (
                <> · Round off {formatMoney(s.settledRoundOff ?? s.roundOff)}</>
              )}
              {s.paymentDate && <> — on {formatDate(new Date(s.paymentDate))}</>}
              {s.paymentMode && <> ({s.paymentMode})</>}
              <span className="text-muted-foreground"> · edit/delete: Voucher Register</span>
            </div>
          )}
          <Num label="Balance Amount" value={settleBalance(side)} disabled />
          <Num
            label="Round Off (−)"
            value={s.roundOff}
            onChange={(n) => setSide2(side, { roundOff: n })}
          />
          <Num
            label="Shortage (−)"
            value={s.shortage}
            onChange={(n) => setSide2(side, { shortage: n })}
          />
          <Num
            label={isP ? "Final Amount Received" : "Final Amount Paid"}
            value={settlePreview(side)}
            disabled
          />
          <div className="space-y-1">
            <Label className="text-xs">Payment Date</Label>
            <DateInput
              className="h-8"
              value={settleDateText[side]}
              onChange={(t) => setSettleDateText((p) => ({ ...p, [side]: t }))}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Bank / Cash Head</Label>
            <MasterCombobox
              options={bankCashOptions}
              value={s.paymentHeadId}
              onChange={(v) => setSide2(side, { paymentHeadId: v })}
              placeholder="Select head..."
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Payment Mode</Label>
            <Select
              value={s.paymentMode}
              onValueChange={(v) => setSide2(side, { paymentMode: v })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BANK">Bank Transfer</SelectItem>
                <SelectItem value="CARD">Card</SelectItem>
                <SelectItem value="CASH">Cash</SelectItem>
                <SelectItem value="UPI">UPI</SelectItem>
                <SelectItem value="CHEQUE">Cheque</SelectItem>
                <SelectItem value="NEFT_RTGS">NEFT / RTGS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Remarks</Label>
            <Input
              className="h-8"
              value={s.remarks}
              onChange={(e) => setSide2(side, { remarks: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void submitSettle(side)}
              disabled={settling !== null}
            >
              {settling === side
                ? "Saving..."
                : done
                  ? `Update Balance ${isP ? "Receipt" : "Payment"}`
                  : `Save Balance ${isP ? "Receipt" : "Payment"}`}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  // legacy rows (pre head-kind) fall back to a sensible kind
  const advanceKind = (a: BrokerAdvance): AdvanceHeadKind =>
    a.headKind ?? (a.type === "BANK" ? "BANK" : a.type === "CASH" ? "CASH" : "EXPENSE");
  const headOptionsFor = (kind: AdvanceHeadKind): MasterOption[] =>
    kind === "BANK" || kind === "CASH"
      ? bankCashOptions.filter((o) => o.meta === kind)
      : accountHeadOptions.filter((o) => o.meta === kind);
  const updateAdvance = (idx: number, patch: Partial<BrokerAdvance>) =>
    set(
      "advances",
      form.advances.map((a, i) => (i === idx ? { ...a, ...patch } : a))
    );
  const removeAdvance = (idx: number) =>
    set(
      "advances",
      form.advances.filter((_, i) => i !== idx)
    );

  const handleSave = async () => {
    const slipDateIso = textToIso(slipDateText);
    if (!form.slipNo.trim()) {
      toast({ variant: "destructive", title: "Slip number is required" });
      return;
    }
    if (!slipDateIso) {
      toast({ variant: "destructive", title: "Valid slip date is required" });
      return;
    }
    const badAdj = adjError("P") ?? adjError("V");
    if (badAdj) {
      toast({ variant: "destructive", title: "Advance adjustment invalid", description: badAdj });
      return;
    }
    setSaving(true);
    try {
      const res = await saveBrokerSlip({
        ...form,
        slipDate: slipDateIso,
        lrDate: textToIso(lrDateText) || null,
        ewbDate: textToIso(ewbDateText) || null,
        unloadDate: textToIso(unloadDateText) || null,
        advances: form.advances.map((a) => ({ ...a, amount: advanceAmount(a) })),
      });
      if (res.ok) {
        toast({ title: `Broker slip ${form.slipNo} saved` });
        router.push(registerReturn);
      } else {
        toast({ variant: "destructive", title: "Save failed", description: res.error });
      }
    } finally {
      setSaving(false);
    }
  };

  const partyCombo = (
    value: string | null | undefined,
    onChange: (v: string | null) => void,
    options: MasterOption[],
    setOptions: React.Dispatch<React.SetStateAction<MasterOption[]>>,
    ledgerGroup: LedgerGroup,
    placeholder: string
  ) => (
    <MasterCombobox
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      renderCreateDialog={(closeAndSelect) => (
        <PartyDialog
          open
          onOpenChange={(o) => {
            if (!o) closeAndSelect("");
          }}
          onCreated={(opt) => {
            setOptions((prev) => [...prev, opt]);
            closeAndSelect(opt.value);
          }}
          defaultGroup={ledgerGroup}
        />
      )}
    />
  );

  const cityCombo = (
    value: string | null | undefined,
    onChange: (v: string | null) => void,
    placeholder: string
  ) => (
    <MasterCombobox
      options={cityOptions}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      renderCreateDialog={(closeAndSelect) => (
        <CityDialog
          open
          onOpenChange={(o) => {
            if (!o) closeAndSelect("");
          }}
          onCreated={(opt) => {
            setCityOptions((prev) => [...prev, opt]);
            closeAndSelect(opt.value);
          }}
        />
      )}
    />
  );

  const sideCard = (side: "p" | "v", totals: ReturnType<typeof computeBrokerSide>) => {
    const s = form[side];
    const isP = side === "p";
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span>{isP ? "Broker Side (Receivable)" : "Owner Side (Payable)"}</span>
            {!isP && (
              <span className="flex flex-wrap items-center gap-2">
                {isOwnVehicle && (
                  <Badge variant="secondary">Own vehicle — TDS/Comm/Mamool default 0</Badge>
                )}
                <Button type="button" variant="outline" size="sm" onClick={copyFromBooking}>
                  <Copy className="h-3.5 w-3.5" /> Copy from booking
                </Button>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isP ? (
            <div className="space-y-1">
              <Label className="text-xs">Broker (auto — from Transporter / Broker above)</Label>
              <Input
                className="h-8"
                value={
                  brokerOptions.find((b) => b.value === form.transporterId)?.label ??
                  "Select the Transporter / Broker in Slip Details"
                }
                readOnly
                disabled
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Owner / Broker</Label>
                {partyCombo(
                  form.ownerId,
                  (v) => set("ownerId", v),
                  brokerOptions,
                  setBrokerOptions,
                  "OWNER_BROKER",
                  "Select owner..."
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Owner Name (text)</Label>
                <Input
                  className="h-8"
                  value={form.ownerName}
                  onChange={(e) => set("ownerName", e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 md:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-xs">Rate Basis</Label>
              <Select
                value={sideBasis(side)}
                onValueChange={(v) => {
                  const basis = v as RateBasis;
                  set(isP ? "pRateBasis" : "vRateBasis", basis);
                  if (s.rate > 0) recomputeFreight(side, s.rate, basis);
                }}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RATE_BASIS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Num label="Rate" value={s.rate} onChange={(n) => recomputeFreight(side, n)} />
            <Num label="Freight" value={s.freight} onChange={(n) => setSide(side, { freight: n })} />
            <Num
              label="Detention"
              value={s.detention}
              onChange={(n) => setSide(side, { detention: n })}
            />
            <Num label="ODC Amt" value={s.odcAmt} onChange={(n) => setSide(side, { odcAmt: n })} />
            <Num
              label="Fine / Slip"
              value={s.fineAmt}
              onChange={(n) => setSide(side, { fineAmt: n })}
            />
            <Num
              label="Other Amt"
              value={s.otherAmt}
              onChange={(n) => setSide(side, { otherAmt: n })}
            />
            <Num
              label="LD Charge (−)"
              value={s.ldCharge}
              onChange={(n) => setSide(side, { ldCharge: n })}
            />
            <Num
              label="Shortage (−)"
              value={s.shortageAmt}
              onChange={(n) => setSide(side, { shortageAmt: n })}
            />
            <Num label="Chalan Amt" value={totals.chalanAmt} disabled />
          </div>

          <div className="grid grid-cols-3 gap-2 md:grid-cols-4">
            <Num label="TDS %" value={s.tdsPct} onChange={(n) => setSide(side, { tdsPct: n })} />
            <Num
              label="TDS Amt"
              value={s.tdsPct > 0 ? totals.tdsAmt : s.tdsAmt}
              disabled={s.tdsPct > 0}
              onChange={(n) => setSide(side, { tdsAmt: n })}
            />
            <Num label="Comm %" value={s.commPct} onChange={(n) => setSide(side, { commPct: n })} />
            <Num
              label="Comm Amt"
              value={s.commPct > 0 ? totals.commAmt : s.commAmt}
              disabled={s.commPct > 0}
              onChange={(n) => setSide(side, { commAmt: n })}
            />
            <Num label="Mamool" value={s.mamool} onChange={(n) => setSide(side, { mamool: n })} />
            <Num
              label="Payment Charge"
              value={s.paymentCharge}
              onChange={(n) => setSide(side, { paymentCharge: n })}
            />
            <Num label="Net Amt" value={totals.netAmt} disabled />
            <Num label={`Advance (${isP ? "P" : "V"})`} value={isP ? pAdvance : vAdvance} disabled />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Num label="Balance" value={totals.balance} disabled />
            <div className="space-y-1">
              <Label className="text-xs">Remarks</Label>
              <Input
                className="h-8"
                value={s.remarks}
                onChange={(e) => setSide(side, { remarks: e.target.value })}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      {/* header */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Slip Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">Slip No</Label>
            <Input
              className="h-8"
              value={form.slipNo}
              onChange={(e) => set("slipNo", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Slip Date</Label>
            <DateInput className="h-8" value={slipDateText} onChange={(t) => setSlipDateText(t)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Vehicle</Label>
            <MasterCombobox
              options={vehicleOptions}
              value={form.vehicleId}
              onChange={onVehicleChange}
              placeholder="Select vehicle..."
              renderCreateDialog={(closeAndSelect) => (
                <VehicleDialog
                  open
                  onOpenChange={(o) => {
                    if (!o) closeAndSelect("");
                  }}
                  onCreated={(opt) => {
                    setVehicleOptions((prev) => [...prev, opt]);
                    closeAndSelect(opt.value);
                  }}
                />
              )}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Transporter / Broker</Label>
            {partyCombo(
              form.transporterId,
              selectBroker,
              brokerOptions,
              setBrokerOptions,
              "OWNER_BROKER",
              "Select transporter..."
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Transport Name</Label>
            <MasterCombobox
              options={transportOptions}
              value={selectedTransport?.transportName ? form.transporterId : null}
              onChange={selectBroker}
              placeholder="Select transport name..."
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Load Station</Label>
            {cityCombo(form.loadStationId, (v) => set("loadStationId", v), "Select city...")}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Destination</Label>
            {cityCombo(form.destCityId, (v) => set("destCityId", v), "Select city...")}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Consignor</Label>
            {partyCombo(
              form.consignorId,
              (v) => set("consignorId", v),
              partyOptions,
              setPartyOptions,
              "CONSIGNEE_CONSIGNOR",
              "Optional..."
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Consignee</Label>
            {partyCombo(
              form.consigneeId,
              (v) => set("consigneeId", v),
              partyOptions,
              setPartyOptions,
              "CONSIGNEE_CONSIGNOR",
              "Optional..."
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">LR No</Label>
            <Input className="h-8" value={form.lrNo} onChange={(e) => set("lrNo", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">LR Date</Label>
            <DateInput className="h-8" value={lrDateText} onChange={(t) => setLrDateText(t)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">E-Way Bill No</Label>
            <Input
              className="h-8"
              value={form.ewbNo}
              onChange={(e) => set("ewbNo", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">EWB Date</Label>
            <DateInput className="h-8" value={ewbDateText} onChange={(t) => setEwbDateText(t)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Product</Label>
            <MasterCombobox
              options={productOptions}
              value={form.productId}
              onChange={(v) => {
                const opt = productOptions.find((o) => o.value === v);
                setForm((f) => ({
                  ...f,
                  productId: v,
                  productName: opt ? opt.label : f.productName,
                }));
              }}
              placeholder="Optional..."
              renderCreateDialog={(closeAndSelect) => (
                <ProductDialog
                  open
                  onOpenChange={(o) => {
                    if (!o) closeAndSelect("");
                  }}
                  onCreated={(opt) => {
                    setProductOptions((prev) => [...prev, opt]);
                    setForm((f) => ({ ...f, productName: opt.label }));
                    closeAndSelect(opt.value);
                  }}
                />
              )}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Product Name</Label>
            <Input
              className="h-8"
              value={form.productName}
              onChange={(e) => set("productName", e.target.value)}
            />
          </div>
          <Num label="Qty" value={form.qty} onChange={(n) => set("qty", n)} />
          <Num label="Actual Wt" value={form.actualWt} onChange={(n) => set("actualWt", n)} />
          <Num
            label="Charge Wt (Guaranteed)"
            value={form.chargeWt}
            onChange={(n) => set("chargeWt", n)}
          />
          <div className="space-y-1">
            <Label className="text-xs">Unit</Label>
            <Input className="h-8" value={form.unit} onChange={(e) => set("unit", e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {/* dual sides */}
      <div className="grid gap-4 lg:grid-cols-2">
        {sideCard("p", pTotals)}
        {sideCard("v", vTotals)}
      </div>

      {/* advances */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Advances</span>
            <Button type="button" variant="outline" size="sm" onClick={addAdvance}>
              <Plus className="h-3.5 w-3.5" /> Add advance
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            An expense head on the <strong>broker side</strong> is the purchase itself — the broker
            supplied it instead of paying, so his receivable drops by that amount.
            {isRelativeVehicle && (
              <>
                {" "}
                This vehicle belongs to a <strong>relative</strong>, so that expense is transferred
                on to the owner{form.ownerId ? "" : " (select the owner to enable it)"}.
              </>
            )}
          </p>
          {form.advances.filter((a) => a.type !== "ADVANCE_ADJ").length === 0 && (
            <p className="text-sm text-muted-foreground">No advances entered.</p>
          )}
          {form.advances.map((a, idx) => {
            // adjustment rows are owned by the Advance Adjustment grids below
            if (a.type === "ADVANCE_ADJ") return null;
            const kind = advanceKind(a);
            return (
              <div key={idx} className="grid grid-cols-2 items-end gap-2 md:grid-cols-6">
                <div className="space-y-1">
                  <Label className="text-xs">Side</Label>
                  <Select
                    value={a.side}
                    onValueChange={(v) => updateAdvance(idx, { side: v as "P" | "V" })}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="P">Broker</SelectItem>
                      <SelectItem value="V">Owner</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={kind}
                    onValueChange={(v) => {
                      const k = v as AdvanceHeadKind;
                      updateAdvance(idx, {
                        headKind: k,
                        headId: null,
                        bankName: "",
                        // keep the legacy type roughly in sync for old reports
                        type: k === "BANK" ? "BANK" : k === "CASH" ? "CASH" : "OTHER",
                      });
                    }}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ADVANCE_HEAD_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {ADVANCE_HEAD_KIND_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{ADVANCE_HEAD_KIND_LABELS[kind]}</Label>
                  <MasterCombobox
                    options={headOptionsFor(kind)}
                    value={a.headId ?? null}
                    onChange={(v) => {
                      const label = headOptionsFor(kind).find((o) => o.value === v)?.label ?? "";
                      updateAdvance(idx, { headId: v, bankName: label });
                    }}
                    placeholder="Select from master..."
                  />
                </div>
                <Num
                  label="Amount"
                  value={advanceAmount(a)}
                  onChange={(n) => updateAdvance(idx, { amount: n })}
                />
                <div className="space-y-1">
                  <Label className="text-xs">Date</Label>
                  <DateInput
                    className="h-8"
                    value={a.date ? isoToText(a.date) : ""}
                    onChange={(t) => updateAdvance(idx, { date: textToIso(t) || null })}
                  />
                </div>
                <div className="flex items-end gap-1">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Remarks</Label>
                    <Input
                      className="h-8"
                      value={a.remarks ?? ""}
                      onChange={(e) => updateAdvance(idx, { remarks: e.target.value })}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    onClick={() => removeAdvance(idx)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
          {form.advances.length > 0 && (
            <div className="flex justify-end gap-6 border-t pt-2 text-sm tabular-nums">
              <span>Broker advances: {formatMoney(pAdvance)}</span>
              <span>Owner advances: {formatMoney(vAdvance)}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* advance adjustment — one grid per side, direction-locked */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Advance Adjustment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <div className="text-xs font-medium">
              Broker Side — Advance Received
              {!form.transporterId && (
                <span className="ml-2 font-normal text-muted-foreground">
                  select the transporter / broker first
                </span>
              )}
            </div>
            <AdvanceAdjustGrid
              advances={advOpts.P}
              values={adjValues("P")}
              onChange={(n) => setAdjValues("P", n)}
              payable={adjPayable("P")}
              loading={advLoading}
            />
            {adjError("P") && <div className="text-xs text-destructive">{adjError("P")}</div>}
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium">
              Owner Side — Advance Paid
              {!form.ownerId && (
                <span className="ml-2 font-normal text-muted-foreground">
                  select the owner first
                </span>
              )}
            </div>
            <AdvanceAdjustGrid
              advances={advOpts.V}
              values={adjValues("V")}
              onChange={(n) => setAdjValues("V", n)}
              payable={adjPayable("V")}
              loading={advLoading}
            />
            {adjError("V") && <div className="text-xs text-destructive">{adjError("V")}</div>}
          </div>
        </CardContent>
      </Card>

      {/* balance settlement — one block per side, in the same left/right order
          as the two sides above. Only a saved slip has a balance to settle. */}
      {form.id && (
        <div className="grid gap-4 lg:grid-cols-2">
          {settleCard("P")}
          {settleCard("V")}
        </div>
      )}

      {/* trip km + payment summary */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Trip KM</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-2">
            <Num
              label="Start KM"
              value={form.startKm ?? 0}
              onChange={(n) => set("startKm", n)}
            />
            <div className="space-y-1">
              <Label className="text-xs">Unload Date</Label>
              <DateInput
                className="h-8"
                value={unloadDateText}
                onChange={(t) => setUnloadDateText(t)}
              />
            </div>
            <Num
              label="Unload KM"
              value={form.unloadKm ?? 0}
              onChange={(n) => set("unloadKm", n)}
            />
            <Num label="Running KM" value={km.runningKm ?? 0} disabled />
            <Num label="Trip Days" value={km.tripDays ?? 0} disabled />
            <div className="space-y-1">
              <Label className="text-xs">Unload Remarks</Label>
              <Input
                className="h-8"
                value={form.unloadRemarks}
                onChange={(e) => set("unloadRemarks", e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Payment Summary (Owner Side)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm tabular-nums">
            {[
              ["Gross Freight", vTotals.chalanAmt],
              ["Commission", vTotals.commAmt],
              ["TDS", vTotals.tdsAmt],
              ["Mamool", form.v.mamool],
              ["Other (Payment Charge)", form.v.paymentCharge],
            ].map(([label, val]) => (
              <div key={label as string} className="flex justify-between">
                <span className="text-muted-foreground">{label}</span>
                <span>{formatMoney(val as number)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t pt-1 font-semibold">
              <span>Net Payable</span>
              <span>{formatMoney(vTotals.netAmt)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Less: Advances</span>
              <span>{formatMoney(vAdvance)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Balance Payable</span>
              <span>{formatMoney(vTotals.balance)}</span>
            </div>
            <div className="flex justify-between border-t pt-1">
              <span className="text-muted-foreground">Margin (Party Net − Owner Net)</span>
              <span className={margin < 0 ? "text-destructive" : ""}>{formatMoney(margin)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => router.push(registerReturn)}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : initial ? "Update Slip" : "Save Slip"}
        </Button>
      </div>
    </div>
  );
}
