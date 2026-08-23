"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type { InvoiceKind } from "@prisma/client";
import { compareLrNo, formatDate, formatMoney, parseDdMmYyyy, toNum } from "@/lib/utils";
import { computeInvoice, roundInvoiceNet } from "@/lib/calc/invoice";
import { gstSplit } from "@/lib/calc/gst";
import { round2 } from "@/lib/calc/tds";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { DateInput } from "@/components/data/date-input";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { PartyCreateDialog } from "@/components/masters/inline-dialogs";
import {
  getBillingLrsByIds,
  getPartyAdvanceBalance,
  getPartyBillingDetails,
  getPendingLrsForParty,
  resolveBulkLrs,
  saveInvoice,
  type BillingDefaults,
  type BillingPendingLr,
  type InvoiceEditPayload,
  type PartyBillingDetails,
} from "@/app/(app)/billing/actions";
import { getLrFormDataById } from "@/app/(app)/lr/actions";
import { LrForm } from "@/components/lr/lr-form";
import {
  InvoicePrintView,
  type InvoiceViewData,
} from "@/components/billing/invoice-print-view";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ---------------------------------------------------------------- helpers

function isoToText(iso: string | null): string {
  if (!iso) return "";
  return formatDate(new Date(iso));
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function Num({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange?: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
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

interface ChargeRow {
  chargeType: string;
  description: string;
  amount: number;
  relatedLrs: string;
  remarks: string;
}

interface LineRow {
  productName: string;
  description: string;
  uom: string;
  hsnCode: string;
  qty: number;
  rate: number;
  discountPct: number;
  gstPct: number;
  // Manual bill consignment columns (printed in the firm's own bill format)
  cnNo: string;
  lineDateText: string; // dd/mm/yyyy
  loadingStation: string;
  deliveryStation: string;
  invoiceNo: string;
  vehicleNo: string;
  deliveryDateText: string;
  wt: number;
  gtWt: number;
}

/** Manual bill row: freight = GT WT × Rate; a weightless row bills Qty × Rate. */
function manualLineAmount(l: LineRow): number {
  return round2(l.gtWt > 0 ? l.gtWt * l.rate : l.qty * l.rate);
}

const KIND_TITLES: Record<InvoiceKind, string> = {
  PART_TRUCK: "Part Truck Bill",
  FULL_TRUCK: "Full Truck Bill",
  MANUAL: "Manual Bill",
  GST: "GST Bill",
};

interface InvoiceFormProps {
  kind: InvoiceKind;
  initial: InvoiceEditPayload | null;
  suggestedInvoiceNo?: string;
  /** last saved bill number of this kind — informational reference only */
  prevInvoiceNo?: string | null;
  /** Income & Expense heads for the Additional Charges "Charge Type" dropdown */
  chargeHeadOptions?: MasterOption[];
  /** firm details for the bill preview (from Company Master) */
  firm?: {
    name: string;
    address: string;
    gstin: string;
    pan: string;
    mobile: string;
    email: string;
    stateName: string;
    stateCode: string;
    ibaCode: string;
    vendorCode: string;
    rcmCovered: boolean;
    logoUrl?: string | null;
    sealUrl?: string | null;
  };
  partyOptions: MasterOption[];
  bankOptions: MasterOption[];
  /** bank fields keyed by party id — the preview prints them line by line */
  bankDetails?: Record<
    string,
    { name: string; branch: string; account: string; ifsc: string }
  >;
  defaults: BillingDefaults;
}

export function InvoiceForm({
  kind,
  initial,
  suggestedInvoiceNo,
  prevInvoiceNo,
  chargeHeadOptions = [],
  firm,
  partyOptions: partyOptions0,
  bankOptions,
  bankDetails,
  defaults,
}: InvoiceFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const withLrs = kind === "PART_TRUCK" || kind === "FULL_TRUCK";
  const withLines = kind === "MANUAL" || kind === "GST";

  const [saving, setSaving] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [partyOptions, setPartyOptions] = React.useState(partyOptions0);

  // header
  const [invoiceNo, setInvoiceNo] = React.useState(initial?.invoiceNo ?? suggestedInvoiceNo ?? "");
  const [invoiceDateText, setInvoiceDateText] = React.useState(
    initial ? isoToText(initial.invoiceDate) : formatDate(new Date())
  );
  const [dueDateText, setDueDateText] = React.useState(isoToText(initial?.dueDate ?? null));
  const [partyId, setPartyId] = React.useState<string | null>(initial?.partyId ?? null);
  const [bankPartyId, setBankPartyId] = React.useState<string | null>(
    initial?.bankPartyId ?? defaults.defaultBankPartyId
  );
  const [setBankDefault, setSetBankDefault] = React.useState(false);
  const [tdsPct, setTdsPct] = React.useState(initial?.tdsPct ?? defaults.defaultTdsPct);
  const [remarks, setRemarks] = React.useState(initial?.remarks ?? "");
  const [subject, setSubject] = React.useState(initial?.subject ?? "");
  const [vehicleText, setVehicleText] = React.useState(initial?.vehicleText ?? "");
  const [advance, setAdvance] = React.useState(initial?.advance ?? 0);
  // open party advance balance (auto-created by receipt vouchers)
  const [availableAdvance, setAvailableAdvance] = React.useState(0);
  React.useEffect(() => {
    if (!partyId) {
      setAvailableAdvance(0);
      return;
    }
    getPartyAdvanceBalance(partyId)
      .then(setAvailableAdvance)
      .catch(() => setAvailableAdvance(0));
  }, [partyId]);
  const [gstApplicable, setGstApplicable] = React.useState(
    kind === "GST" ? true : initial?.gstApplicable ?? false
  );
  const [gstPct, setGstPct] = React.useState(
    initial?.gstPct ?? (kind === "GST" ? 0 : defaults.firmGstPct)
  );

  // GST extras
  const [placeOfSupply, setPlaceOfSupply] = React.useState(initial?.placeOfSupply ?? "");
  const [supplyDateText, setSupplyDateText] = React.useState(isoToText(initial?.supplyDate ?? null));
  const [transportMode, setTransportMode] = React.useState(initial?.transportMode ?? "");
  // FULL_TRUCK (GST-unregistered): bills are on RCM basis by default
  const [reverseCharge, setReverseCharge] = React.useState(
    initial ? initial.reverseCharge : kind === "FULL_TRUCK"
  );
  const [sacCode, setSacCode] = React.useState(initial?.sacCode || "996791");
  const [tcsPct, setTcsPct] = React.useState(initial?.tcsPct ?? 0);
  const [freightExtra, setFreightExtra] = React.useState(initial?.freightExtra ?? 0);
  const [othersExtra, setOthersExtra] = React.useState(initial?.othersExtra ?? 0);
  const [narration, setNarration] = React.useState(initial?.narration ?? "");

  // LR selection
  const [pendingLrs, setPendingLrs] = React.useState<BillingPendingLr[]>(initial?.lrs ?? []);
  const [selectedLrIds, setSelectedLrIds] = React.useState<Set<string>>(
    new Set(initial?.lrs.map((l) => l.id) ?? [])
  );
  const [loadingLrs, setLoadingLrs] = React.useState(false);
  // in-place LR edit from the bill preview (dialog on top of the preview)
  const [lrEdit, setLrEdit] = React.useState<Awaited<
    ReturnType<typeof getLrFormDataById>
  > | null>(null);
  const [lrEditLoading, setLrEditLoading] = React.useState<string | null>(null);
  const [bulkText, setBulkText] = React.useState("");
  const [bulkBusy, setBulkBusy] = React.useState(false);
  // per-column filters for the pending-LR picker (obdNo = prefix search)
  const [lrFilters, setLrFilters] = React.useState({
    lrNo: "",
    date: "",
    source: "",
    dest: "",
    vehicle: "",
    obdNo: "",
    qty: "",
    chargeWt: "",
    amount: "",
  });
  const setLrFilter = (patch: Partial<typeof lrFilters>) =>
    setLrFilters((f) => ({ ...f, ...patch }));

  // charges / lines
  const [charges, setCharges] = React.useState<ChargeRow[]>(
    initial?.charges.map((c) => ({ ...c })) ?? []
  );
  const [lines, setLines] = React.useState<LineRow[]>(
    initial?.lines.map((l) => ({
      productName: l.productName,
      description: l.description,
      uom: l.uom,
      hsnCode: l.hsnCode,
      qty: l.qty,
      rate: l.rate,
      discountPct: l.discountPct,
      gstPct: l.gstPct,
      cnNo: l.cnNo,
      lineDateText: isoToText(l.lineDate),
      loadingStation: l.loadingStation,
      deliveryStation: l.deliveryStation,
      invoiceNo: l.invoiceNo,
      vehicleNo: l.vehicleNo,
      deliveryDateText: isoToText(l.deliveryDate),
      wt: l.wt,
      gtWt: l.gtWt,
    })) ?? []
  );

  const [partyDetail, setPartyDetail] = React.useState<PartyBillingDetails | null>(null);
  const partyStateCode = partyDetail?.stateCode || null;

  React.useEffect(() => {
    if (!partyId) {
      setPartyDetail(null);
      return;
    }
    getPartyBillingDetails(partyId).then(setPartyDetail).catch(() => setPartyDetail(null));
  }, [partyId]);

  const loadPending = React.useCallback(
    async (pid: string, keep: BillingPendingLr[]) => {
      setLoadingLrs(true);
      try {
        const rows = await getPendingLrsForParty(pid, kind);
        const keepIds = new Set(keep.map((l) => l.id));
        setPendingLrs([...keep, ...rows.filter((r) => !keepIds.has(r.id))]);
      } catch {
        toast({ variant: "destructive", title: "Failed to load pending LRs" });
      } finally {
        setLoadingLrs(false);
      }
    },
    [kind, toast]
  );

  const onPartyChange = (v: string | null) => {
    setPartyId(v);
    if (!withLrs) return;
    // keep LRs already on the invoice being edited (same party), drop the rest
    const keep = initial && v === initial.partyId ? initial.lrs : [];
    setSelectedLrIds(new Set(keep.map((l) => l.id)));
    if (v) void loadPending(v, keep);
    else setPendingLrs([]);
  };

  // initial pending load for edit mode
  React.useEffect(() => {
    if (withLrs && initial?.partyId) void loadPending(initial.partyId, initial.lrs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openLrEdit = async (lrId: string) => {
    setLrEditLoading(lrId);
    try {
      const data = await getLrFormDataById(lrId);
      if (!data) {
        toast({ variant: "destructive", title: "LR not found — it may have been deleted" });
        return;
      }
      setLrEdit(data);
    } catch {
      toast({ variant: "destructive", title: "Failed to load LR for editing" });
    } finally {
      setLrEditLoading(null);
    }
  };

  // after an in-place LR edit: re-fetch the selected LRs fresh (they may be
  // linked to this invoice and absent from the pending query), then reload
  // the pending list — the open preview re-renders with the updated figures
  const onLrEdited = async () => {
    setLrEdit(null);
    if (!partyId) return;
    try {
      const fresh = await getBillingLrsByIds(Array.from(selectedLrIds));
      await loadPending(partyId, fresh);
    } catch {
      toast({ variant: "destructive", title: "Failed to refresh LRs — reload the page" });
    }
  };

  const toggleLr = (id: string, checked: boolean) => {
    setSelectedLrIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelectedLrIds(checked ? new Set(visibleLrs.map((l) => l.id)) : new Set());
  };

  const addBulk = async () => {
    if (!partyId) {
      toast({ variant: "destructive", title: "Select a party first" });
      return;
    }
    if (!bulkText.trim()) return;
    setBulkBusy(true);
    try {
      const { added, errors } = await resolveBulkLrs(partyId, bulkText, kind);
      if (added.length) {
        setPendingLrs((prev) => {
          const have = new Set(prev.map((l) => l.id));
          return [...prev, ...added.filter((a) => !have.has(a.id))];
        });
        setSelectedLrIds((prev) => {
          const next = new Set(prev);
          added.forEach((a) => next.add(a.id));
          return next;
        });
        setBulkText("");
      }
      for (const err of errors.slice(0, 5)) {
        toast({ variant: "destructive", title: err.reason });
      }
      if (errors.length > 5) {
        toast({ variant: "destructive", title: `...and ${errors.length - 5} more LR errors` });
      }
    } finally {
      setBulkBusy(false);
    }
  };

  // charges
  const addCharge = () =>
    setCharges((c) => [...c, { chargeType: "", description: "", amount: 0, relatedLrs: "", remarks: "" }]);
  const updateCharge = (idx: number, patch: Partial<ChargeRow>) =>
    setCharges((c) => c.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  const removeCharge = (idx: number) => setCharges((c) => c.filter((_, i) => i !== idx));

  // lines
  const addLine = () =>
    setLines((l) => [
      ...l,
      {
        productName: "",
        description: "",
        uom: "",
        hsnCode: "",
        qty: 1,
        rate: 0,
        discountPct: 0,
        gstPct: 0,
        cnNo: "",
        lineDateText: "",
        loadingStation: "",
        deliveryStation: "",
        invoiceNo: "",
        vehicleNo: "",
        deliveryDateText: "",
        wt: 0,
        gtWt: 0,
      },
    ]);
  const updateLine = (idx: number, patch: Partial<LineRow>) =>
    setLines((l) => l.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  const removeLine = (idx: number) => setLines((l) => l.filter((_, i) => i !== idx));

  const rcmActive = kind === "FULL_TRUCK" && reverseCharge;

  const contains = (v: string | number, q: string) =>
    !q || String(v).toLowerCase().includes(q.trim().toLowerCase());
  const visibleLrs = pendingLrs.filter(
    (lr) =>
      contains(lr.lrNo, lrFilters.lrNo) &&
      contains(formatDate(lr.lrDate), lrFilters.date) &&
      contains(lr.source, lrFilters.source) &&
      contains(lr.dest, lrFilters.dest) &&
      contains(lr.vehicle, lrFilters.vehicle) &&
      // OBD: prefix search — matches from the beginning of the OBD number
      (!lrFilters.obdNo ||
        lr.obdNo.toLowerCase().startsWith(lrFilters.obdNo.trim().toLowerCase())) &&
      contains(lr.qty, lrFilters.qty) &&
      contains(lr.chargeWt, lrFilters.chargeWt) &&
      contains(lr.amount, lrFilters.amount)
  );

  // ---------------------------------------------------------------- totals (mirror of server calc)
  // always LR-number order, never tick order — the S.No column stays
  // 10002 → 1, 10003 → 2, ... and an edit cannot reshuffle the lines
  const selectedLrs = pendingLrs
    .filter((l) => selectedLrIds.has(l.id))
    .sort((a, b) => compareLrNo(a.lrNo, b.lrNo));

  let totals: {
    total: number;
    grandTotal: number;
    cgstAmt: number;
    sgstAmt: number;
    igstAmt: number;
    tdsAmt: number;
    roundOff: number;
    netTotal: number;
    balance: number;
  };
  let tcsAmt = 0;

  if (kind === "GST") {
    const computed = lines.map((l) => {
      const total = round2(l.qty * l.rate);
      const taxableValue = round2(total * (1 - l.discountPct / 100));
      const gst = gstSplit({
        taxableValue,
        gstPct: l.gstPct,
        supplierStateCode: defaults.firmStateCode,
        recipientStateCode: partyStateCode,
      });
      return { total, taxableValue, ...gst };
    });
    const totTaxable = round2(computed.reduce((s, l) => s + l.taxableValue, 0));
    const cgstAmt = round2(computed.reduce((s, l) => s + l.cgst, 0));
    const sgstAmt = round2(computed.reduce((s, l) => s + l.sgst, 0));
    const igstAmt = round2(computed.reduce((s, l) => s + l.igst, 0));
    const preTcs = round2(totTaxable + cgstAmt + sgstAmt + igstAmt + freightExtra + othersExtra);
    tcsAmt = round2((preTcs * tcsPct) / 100);
    const grandTotal = round2(preTcs + tcsAmt);
    const { netTotal, roundOff } = roundInvoiceNet(grandTotal);
    totals = {
      total: round2(computed.reduce((s, l) => s + l.total, 0)),
      grandTotal,
      cgstAmt,
      sgstAmt,
      igstAmt,
      tdsAmt: 0,
      roundOff,
      netTotal,
      balance: round2(netTotal - advance),
    };
  } else {
    totals = computeInvoice({
      lrAmounts:
        kind === "MANUAL" ? lines.map(manualLineAmount) : selectedLrs.map((l) => l.amount),
      extraCharges: charges.map((c) => c.amount),
      // RCM basis: tax liability is on the recipient — no GST added to the bill
      gstApplicable: gstApplicable && !rcmActive,
      gstPct,
      supplierStateCode: defaults.firmStateCode,
      recipientStateCode: partyStateCode,
      tdsPct,
      advance,
    });
  }

  // ---------------------------------------------------------------- save
  const validateHeader = (): boolean => {
    if (!invoiceNo.trim()) {
      toast({ variant: "destructive", title: "Invoice number is required" });
      return false;
    }
    if (!textToIso(invoiceDateText)) {
      toast({ variant: "destructive", title: "Valid invoice date is required" });
      return false;
    }
    if (!partyId) {
      toast({ variant: "destructive", title: "Party is required" });
      return false;
    }
    return true;
  };

  const openPreview = () => {
    if (!validateHeader()) return;
    if (selectedLrs.length === 0) {
      toast({ variant: "destructive", title: "Select at least one LR" });
      return;
    }
    setPreviewOpen(true);
  };

  const handleSave = async () => {
    const invoiceDateIso = textToIso(invoiceDateText);
    if (!validateHeader() || !invoiceDateIso) return;
    setSaving(true);
    try {
      const res = await saveInvoice({
        id: initial?.id,
        kind,
        invoiceNo: invoiceNo.trim(),
        invoiceDate: invoiceDateIso,
        dueDate: textToIso(dueDateText) || null,
        partyId,
        bankPartyId,
        setBankDefault,
        tdsPct: kind === "GST" ? 0 : tdsPct,
        remarks,
        subject,
        gstApplicable,
        gstPct,
        // sorted LR order — the saved invoiceLr rows keep the printed S.No order
        lrIds: withLrs ? selectedLrs.map((l) => l.id) : [],
        charges: withLrs
          ? charges
              .filter((c) => c.chargeType.trim() || c.amount !== 0)
              .map((c) => ({ ...c, chargeType: c.chargeType.trim() || "OTHER" }))
          : [],
        lines: withLines
          ? lines
              .filter((l) => l.productName.trim())
              .map((l) => ({
                ...l,
                lineDate: textToIso(l.lineDateText) || null,
                deliveryDate: textToIso(l.deliveryDateText) || null,
              }))
          : [],
        advance,
        vehicleText,
        placeOfSupply,
        supplyDate: textToIso(supplyDateText) || null,
        transportMode,
        reverseCharge,
        sacCode,
        tcsPct,
        freightExtra,
        othersExtra,
        narration,
      });
      if (res.ok) {
        toast({ title: `Invoice ${invoiceNo} saved` });
        if (kind === "FULL_TRUCK") {
          // open the print window automatically after a successful save
          window.open(`/print/invoice/${res.id}`, "_blank");
        }
        router.push(`/billing/register?kind=${kind}`);
      } else {
        setPreviewOpen(false);
        toast({ variant: "destructive", title: "Save failed", description: res.error });
      }
    } finally {
      setSaving(false);
    }
  };

  const interstate =
    !!defaults.firmStateCode && !!partyStateCode && defaults.firmStateCode !== partyStateCode;

  // informational RCM split — never added to the invoice total
  const rcmPct = gstPct || defaults.firmGstPct;
  const rcmInfo = rcmActive
    ? (() => {
        const split = gstSplit({
          taxableValue: totals.grandTotal,
          gstPct: rcmPct,
          supplierStateCode: defaults.firmStateCode,
          recipientStateCode: partyStateCode,
        });
        return {
          taxableValue: totals.grandTotal,
          pct: rcmPct,
          cgst: split.cgst,
          sgst: split.sgst,
          igst: split.igst,
        };
      })()
    : null;

  const previewData: InvoiceViewData = {
    billNo: invoiceNo,
    billDate: invoiceDateText,
    placeOfSupply: placeOfSupply || partyDetail?.stateName || "",
    gstPct: rcmPct,
    firm: firm ?? {
      name: "",
      address: "",
      gstin: "",
      pan: "",
      mobile: "",
      email: "",
      stateName: "",
      stateCode: "",
      ibaCode: "",
      vendorCode: "",
      rcmCovered: true,
    },
    tdsPct,
    serviceDescription: "Goods Transport Service",
    sacCode,
    party: partyDetail ?? {
      name: partyOptions.find((p) => p.value === partyId)?.label ?? "",
      address: "",
      gstin: "",
      pan: "",
      stateName: "",
      stateCode: "",
      vendorCode: "",
    },
    lrs: selectedLrs.map((lr) => ({
      id: lr.id,
      lrNo: lr.lrNo,
      lrDate: formatDate(lr.lrDate),
      source: lr.source,
      dest: lr.dest,
      obdNo: lr.obdNo,
      poNumber: lr.poNumber,
      gateEntryNo: lr.gateEntryNo,
      invoiceNo: lr.invoiceNo,
      vehicle: lr.vehicle,
      material: lr.material,
      consignee: lr.consignee,
      unloadDate: lr.unloadDate ? formatDate(lr.unloadDate) : "",
      qty: lr.qty,
      actualWt: lr.actualWt,
      chargeWt: lr.chargeWt,
      rate: lr.rate,
      amount: lr.amount,
    })),
    charges: charges
      .filter((c) => c.chargeType.trim() || c.amount !== 0)
      .map((c) => ({
        label: [c.chargeType || "OTHER", c.description].filter(Boolean).join(" — "),
        relatedLrs: c.relatedLrs,
        amount: c.amount,
      })),
    totals: {
      total: totals.total,
      grandTotal: totals.grandTotal,
      cgstAmt: totals.cgstAmt,
      sgstAmt: totals.sgstAmt,
      igstAmt: totals.igstAmt,
      roundOff: totals.roundOff,
      netTotal: totals.netTotal,
      advance,
      balance: totals.balance,
    },
    rcm: rcmInfo,
    gstApplied: gstApplicable && !rcmActive,
    reverseCharge,
    remarks,
    bank:
      (bankPartyId && bankDetails?.[bankPartyId]) ||
      // no details supplied: still name the bank rather than dropping the block
      (bankPartyId
        ? {
            name: bankOptions.find((b) => b.value === bankPartyId)?.label ?? "",
            branch: "",
            account: "",
            ifsc: "",
          }
        : null),
  };

  return (
    <div className="space-y-4">
      {/* header */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{KIND_TITLES[kind]} Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">
              {kind === "FULL_TRUCK" ? "Invoice No *" : "Invoice No * (auto-generated, editable)"}
            </Label>
            <Input className="h-8" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
            {kind === "FULL_TRUCK" && prevInvoiceNo && (
              <p className="text-xs text-muted-foreground">
                Previous Bill No: <b>{prevInvoiceNo}</b> (reference only)
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Invoice Date *</Label>
            <DateInput className="h-8" value={invoiceDateText} onChange={setInvoiceDateText} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Due Date</Label>
            <DateInput className="h-8" value={dueDateText} onChange={setDueDateText} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Party *</Label>
            <MasterCombobox
              options={partyOptions}
              value={partyId}
              onChange={onPartyChange}
              placeholder="Select party..."
              renderCreateDialog={(closeAndSelect) => (
                <PartyCreateDialog
                  open
                  onOpenChange={(o) => {
                    if (!o) closeAndSelect("");
                  }}
                  defaultGroup="CONSIGNEE_CONSIGNOR"
                  onCreated={(opt) => {
                    setPartyOptions((prev) => [...prev, opt]);
                    closeAndSelect(opt.value);
                  }}
                />
              )}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Bank Account (printed on bill)</Label>
            <MasterCombobox
              options={bankOptions}
              value={bankPartyId}
              onChange={setBankPartyId}
              placeholder="Select bank..."
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Set as default bank</Label>
            <div className="flex h-8 items-center">
              <Switch checked={setBankDefault} onCheckedChange={setSetBankDefault} />
            </div>
          </div>
          {kind !== "GST" && <Num label="TDS %" value={tdsPct} onChange={setTdsPct} />}
          <Num
            label={
              availableAdvance > 0
                ? `Advance (available: ${formatMoney(availableAdvance)})`
                : "Advance"
            }
            value={advance}
            onChange={setAdvance}
          />
          <div className="space-y-1">
            <Label className="text-xs">Vehicle (text)</Label>
            <Input className="h-8" value={vehicleText} onChange={(e) => setVehicleText(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Subject</Label>
            <Input className="h-8" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">Remarks</Label>
            <Input className="h-8" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
          {kind === "FULL_TRUCK" && (
            <div className="space-y-1">
              <Label className="text-xs">SAC (Service Accounting Code)</Label>
              <Input className="h-8" value={sacCode} onChange={(e) => setSacCode(e.target.value)} />
            </div>
          )}
          {kind === "FULL_TRUCK" && (
            <div className="space-y-1">
              <Label className="text-xs">RCM Basis (Reverse Charge)</Label>
              <div className="flex h-8 items-center gap-2">
                <Switch checked={reverseCharge} onCheckedChange={setReverseCharge} />
                {rcmActive && (
                  <span className="text-xs text-muted-foreground">
                    GST payable by recipient under RCM
                  </span>
                )}
              </div>
            </div>
          )}
          {kind !== "GST" && !rcmActive && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">GST Applicable</Label>
                <div className="flex h-8 items-center">
                  <Switch checked={gstApplicable} onCheckedChange={setGstApplicable} />
                </div>
              </div>
              {gstApplicable && <Num label="GST %" value={gstPct} onChange={setGstPct} />}
            </>
          )}
        </CardContent>
      </Card>

      {/* GST extras */}
      {kind === "GST" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">GST Details</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-xs">Place of Supply</Label>
              <Input
                className="h-8"
                value={placeOfSupply}
                onChange={(e) => setPlaceOfSupply(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Supply Date</Label>
              <DateInput className="h-8" value={supplyDateText} onChange={setSupplyDateText} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Transport Mode</Label>
              <Input
                className="h-8"
                value={transportMode}
                onChange={(e) => setTransportMode(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reverse Charge</Label>
              <div className="flex h-8 items-center">
                <Switch checked={reverseCharge} onCheckedChange={setReverseCharge} />
              </div>
            </div>
            <Num label="TCS %" value={tcsPct} onChange={setTcsPct} />
            <Num label="Freight (extra)" value={freightExtra} onChange={setFreightExtra} />
            <Num label="Others (extra)" value={othersExtra} onChange={setOthersExtra} />
            <div className="space-y-1">
              <Label className="text-xs">Narration</Label>
              <Input className="h-8" value={narration} onChange={(e) => setNarration(e.target.value)} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* LR selection */}
      {withLrs && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span>
                Pending LRs {kind === "PART_TRUCK" ? "(TBB only)" : ""}
                {loadingLrs ? " — loading..." : ""}
              </span>
              <span className="text-sm font-normal text-muted-foreground">
                {selectedLrIds.size} of {pendingLrs.length} selected
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Textarea
                placeholder="Bulk add: paste LR numbers separated by space / comma / new line"
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                className="min-h-[38px] flex-1"
                rows={1}
              />
              <Button type="button" variant="outline" onClick={addBulk} disabled={bulkBusy}>
                {bulkBusy ? "Adding..." : "Add LRs"}
              </Button>
            </div>
            <div className="max-h-96 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox
                        checked={
                          visibleLrs.length > 0 &&
                          visibleLrs.every((l) => selectedLrIds.has(l.id))
                        }
                        onCheckedChange={(c) => toggleAll(c === true)}
                      />
                    </TableHead>
                    <TableHead>LR No</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>OBD No</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Charge Wt</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                  {/* per-column filters; OBD filters by prefix */}
                  <TableRow>
                    <TableHead />
                    {(
                      [
                        ["lrNo", "LR No..."],
                        ["date", "Date..."],
                        ["source", "From..."],
                        ["dest", "To..."],
                        ["vehicle", "Vehicle..."],
                        ["obdNo", "OBD starts with..."],
                        ["qty", "Qty..."],
                        ["chargeWt", "Wt..."],
                        ["amount", "Amt..."],
                      ] as const
                    ).map(([key, ph]) => (
                      <TableHead key={key} className="py-1">
                        <Input
                          className="h-7 text-xs"
                          placeholder={ph}
                          value={lrFilters[key]}
                          onChange={(e) => setLrFilter({ [key]: e.target.value })}
                        />
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleLrs.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-muted-foreground">
                        {partyId
                          ? pendingLrs.length
                            ? "No LRs match the filters."
                            : "No pending LRs for this party."
                          : "Select a party to load LRs."}
                      </TableCell>
                    </TableRow>
                  )}
                  {visibleLrs.map((lr) => (
                    <TableRow key={lr.id} className="cursor-pointer" onClick={() => toggleLr(lr.id, !selectedLrIds.has(lr.id))}>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedLrIds.has(lr.id)}
                          onCheckedChange={(c) => toggleLr(lr.id, c === true)}
                        />
                      </TableCell>
                      <TableCell>{lr.lrNo}</TableCell>
                      <TableCell>{formatDate(lr.lrDate)}</TableCell>
                      <TableCell>{lr.source}</TableCell>
                      <TableCell>{lr.dest}</TableCell>
                      <TableCell>{lr.vehicle}</TableCell>
                      <TableCell>{lr.obdNo}</TableCell>
                      <TableCell className="text-right tabular-nums">{lr.qty}</TableCell>
                      <TableCell className="text-right tabular-nums">{lr.chargeWt}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(lr.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                {selectedLrs.length > 0 && (
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={7}>Selected total</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {selectedLrs.reduce((s, l) => s + l.qty, 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {round2(selectedLrs.reduce((s, l) => s + l.chargeWt, 0))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(selectedLrs.reduce((s, l) => s + l.amount, 0))}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                )}
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* extra charges (LR bills) */}
      {withLrs && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span>Additional Charges</span>
              <Button type="button" variant="outline" size="sm" onClick={addCharge}>
                <Plus className="h-3.5 w-3.5" /> Add charge
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {charges.length === 0 && (
              <p className="text-sm text-muted-foreground">No additional charges.</p>
            )}
            {charges.map((c, idx) => (
              <div key={idx} className="grid grid-cols-2 items-end gap-2 md:grid-cols-6">
                <div className="space-y-1">
                  <Label className="text-xs">Charge Type</Label>
                  {chargeHeadOptions.length > 0 ? (
                    <MasterCombobox
                      options={chargeHeadOptions}
                      value={c.chargeType || null}
                      onChange={(v) => updateCharge(idx, { chargeType: v ?? "" })}
                      placeholder="Select head..."
                    />
                  ) : (
                    <Input
                      className="h-8"
                      value={c.chargeType}
                      placeholder="e.g. DETENTION"
                      onChange={(e) => updateCharge(idx, { chargeType: e.target.value.toUpperCase() })}
                    />
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Description</Label>
                  <Input
                    className="h-8"
                    value={c.description}
                    onChange={(e) => updateCharge(idx, { description: e.target.value })}
                  />
                </div>
                <Num label="Amount" value={c.amount} onChange={(n) => updateCharge(idx, { amount: n })} />
                <div className="space-y-1">
                  <Label className="text-xs">Related LR(s)</Label>
                  <Select
                    value=""
                    onValueChange={(v) => {
                      if (v === "ALL") {
                        updateCharge(idx, { relatedLrs: "All LRs" });
                        return;
                      }
                      const current =
                        c.relatedLrs && c.relatedLrs !== "All LRs"
                          ? c.relatedLrs.split(",").map((s) => s.trim()).filter(Boolean)
                          : [];
                      if (!current.includes(v)) current.push(v);
                      updateCharge(idx, { relatedLrs: current.join(", ") });
                    }}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue
                        placeholder={c.relatedLrs ? c.relatedLrs : "All LRs (default)"}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">Entire Bill / All LRs</SelectItem>
                      {selectedLrs.map((lr) => (
                        <SelectItem key={lr.id} value={lr.lrNo}>
                          LR {lr.lrNo}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {c.relatedLrs && (
                    <div className="flex flex-wrap gap-1">
                      {c.relatedLrs === "All LRs" ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          All LRs{" "}
                          <button
                            type="button"
                            className="text-destructive"
                            onClick={() => updateCharge(idx, { relatedLrs: "" })}
                          >
                            ×
                          </button>
                        </span>
                      ) : (
                        c.relatedLrs
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .map((no) => (
                            <span key={no} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                              {no}{" "}
                              <button
                                type="button"
                                className="text-destructive"
                                onClick={() =>
                                  updateCharge(idx, {
                                    relatedLrs: c.relatedLrs
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter((s) => s && s !== no)
                                      .join(", "),
                                  })
                                }
                              >
                                ×
                              </button>
                            </span>
                          ))
                      )}
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Remarks</Label>
                  <Input
                    className="h-8"
                    value={c.remarks}
                    onChange={(e) => updateCharge(idx, { remarks: e.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => removeCharge(idx)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* lines (manual / GST bills) */}
      {withLines && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span>{kind === "MANUAL" ? "Bill Rows — printed as-is on the bill" : "Bill Lines"}</span>
              <Button type="button" variant="outline" size="sm" onClick={addLine}>
                <Plus className="h-3.5 w-3.5" /> Add line
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {lines.length === 0 && <p className="text-sm text-muted-foreground">No lines added.</p>}
            {kind === "MANUAL" && lines.length > 0 && (
              <div className="overflow-x-auto">
                <div className="min-w-[1500px] space-y-1">
                  <div className="grid grid-cols-[90px_120px_150px_150px_140px_120px_1fr_120px_85px_85px_95px_110px_36px] gap-1 px-1 text-xs font-medium text-muted-foreground">
                    <div>C. Note</div>
                    <div>Date</div>
                    <div>Loading Station</div>
                    <div>Delivery Station</div>
                    <div>Invoice No</div>
                    <div>Vehicle No</div>
                    <div>Material *</div>
                    <div>Delivery Date</div>
                    <div className="text-right">WT</div>
                    <div className="text-right">GT WT</div>
                    <div className="text-right">Rate</div>
                    <div className="text-right">Amount</div>
                    <div />
                  </div>
                  {lines.map((l, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-[90px_120px_150px_150px_140px_120px_1fr_120px_85px_85px_95px_110px_36px] items-center gap-1 px-1"
                    >
                      <Input
                        className="h-8"
                        value={l.cnNo}
                        onChange={(e) => updateLine(idx, { cnNo: e.target.value })}
                      />
                      <DateInput
                        value={l.lineDateText}
                        onChange={(t) => updateLine(idx, { lineDateText: t })}
                        className="h-8"
                      />
                      <Input
                        className="h-8"
                        value={l.loadingStation}
                        onChange={(e) => updateLine(idx, { loadingStation: e.target.value })}
                      />
                      <Input
                        className="h-8"
                        value={l.deliveryStation}
                        onChange={(e) => updateLine(idx, { deliveryStation: e.target.value })}
                      />
                      <Input
                        className="h-8"
                        value={l.invoiceNo}
                        onChange={(e) => updateLine(idx, { invoiceNo: e.target.value })}
                      />
                      <Input
                        className="h-8"
                        value={l.vehicleNo}
                        onChange={(e) => updateLine(idx, { vehicleNo: e.target.value })}
                      />
                      <Input
                        className="h-8"
                        value={l.productName}
                        onChange={(e) => updateLine(idx, { productName: e.target.value })}
                        placeholder="e.g. RHS GRADE YST"
                      />
                      <DateInput
                        value={l.deliveryDateText}
                        onChange={(t) => updateLine(idx, { deliveryDateText: t })}
                        className="h-8"
                      />
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        className="h-8 text-right tabular-nums"
                        value={Number.isFinite(l.wt) ? String(l.wt) : ""}
                        onChange={(e) => updateLine(idx, { wt: toNum(e.target.value) })}
                        onFocus={(e) => e.target.select()}
                      />
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        className="h-8 text-right tabular-nums"
                        value={Number.isFinite(l.gtWt) ? String(l.gtWt) : ""}
                        onChange={(e) => updateLine(idx, { gtWt: toNum(e.target.value) })}
                        onFocus={(e) => e.target.select()}
                      />
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        className="h-8 text-right tabular-nums"
                        value={Number.isFinite(l.rate) ? String(l.rate) : ""}
                        onChange={(e) => updateLine(idx, { rate: toNum(e.target.value) })}
                        onFocus={(e) => e.target.select()}
                      />
                      <div className="flex h-8 items-center justify-end rounded-md border bg-muted/50 px-2 text-sm tabular-nums">
                        {formatMoney(manualLineAmount(l))}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => removeLine(idx)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <div className="flex justify-end gap-4 px-1 pt-1 text-sm tabular-nums">
                    <span className="text-xs text-muted-foreground">
                      Amount = GT WT × Rate (no weight → Rate as lumpsum × Qty)
                    </span>
                    <span className="font-medium">
                      Total Freight:{" "}
                      {formatMoney(round2(lines.reduce((s, l) => s + manualLineAmount(l), 0)))}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {kind !== "MANUAL" &&
            lines.map((l, idx) => {
              const lineTotal = round2(l.qty * l.rate);
              const taxable = round2(lineTotal * (1 - l.discountPct / 100));
              return (
                <div key={idx} className="grid grid-cols-2 items-end gap-2 md:grid-cols-9">
                  <div className="space-y-1 md:col-span-2">
                    <Label className="text-xs">Particulars *</Label>
                    <Input
                      className="h-8"
                      value={l.productName}
                      onChange={(e) => updateLine(idx, { productName: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">UOM</Label>
                    <Input
                      className="h-8"
                      value={l.uom}
                      onChange={(e) => updateLine(idx, { uom: e.target.value })}
                    />
                  </div>
                  {kind === "GST" && (
                    <div className="space-y-1">
                      <Label className="text-xs">HSN / SAC</Label>
                      <Input
                        className="h-8"
                        value={l.hsnCode}
                        onChange={(e) => updateLine(idx, { hsnCode: e.target.value })}
                      />
                    </div>
                  )}
                  <Num label="Qty" value={l.qty} onChange={(n) => updateLine(idx, { qty: n })} />
                  <Num label="Rate" value={l.rate} onChange={(n) => updateLine(idx, { rate: n })} />
                  {kind === "GST" && (
                    <>
                      <Num
                        label="Disc %"
                        value={l.discountPct}
                        onChange={(n) => updateLine(idx, { discountPct: n })}
                      />
                      <Num
                        label="GST %"
                        value={l.gstPct}
                        onChange={(n) => updateLine(idx, { gstPct: n })}
                      />
                    </>
                  )}
                  <div className="flex items-end gap-1">
                    <Num label={kind === "GST" ? "Taxable" : "Amount"} value={taxable} disabled />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => removeLine(idx)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* totals */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Totals</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm tabular-nums md:grid-cols-2">
          <div className="space-y-1">
            {(
              [
                [withLrs ? "LR Freight Total" : "Lines Total", totals.total],
                ["Grand Total (before tax)", totals.grandTotal],
              ] as const
            ).map(([label, val]) => (
              <div key={label} className="flex justify-between">
                <span className="text-muted-foreground">{label}</span>
                <span>{formatMoney(val)}</span>
              </div>
            ))}
            {rcmActive && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">GST</span>
                <span className="text-xs">Payable by recipient under RCM</span>
              </div>
            )}
            {((gstApplicable && !rcmActive) || kind === "GST") && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    CGST {interstate ? "" : `(intra-state)`}
                  </span>
                  <span>{formatMoney(totals.cgstAmt)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">SGST</span>
                  <span>{formatMoney(totals.sgstAmt)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">IGST {interstate ? "(inter-state)" : ""}</span>
                  <span>{formatMoney(totals.igstAmt)}</span>
                </div>
              </>
            )}
            {kind === "GST" && tcsPct > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">TCS @ {tcsPct}%</span>
                <span>{formatMoney(tcsAmt)}</span>
              </div>
            )}
          </div>
          <div className="space-y-1">
            {kind !== "GST" && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">TDS @ {tdsPct}% (info)</span>
                <span>{formatMoney(totals.tdsAmt)}</span>
              </div>
            )}
            {totals.roundOff !== 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Round Off</span>
                <span>
                  {(totals.roundOff > 0 ? "+" : "−") + formatMoney(Math.abs(totals.roundOff))}
                </span>
              </div>
            )}
            <div className="flex justify-between font-semibold">
              <span>Net Total</span>
              <span>{formatMoney(totals.netTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Less: Advance</span>
              <span>{formatMoney(advance)}</span>
            </div>
            <div className="flex justify-between border-t pt-1 font-semibold">
              <span>Balance</span>
              <span>{formatMoney(totals.balance)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => router.push(`/billing/register?kind=${kind}`)}>
          Cancel
        </Button>
        {kind === "FULL_TRUCK" ? (
          <Button onClick={openPreview} disabled={saving}>
            Preview Bill
          </Button>
        ) : (
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : initial ? "Update Bill" : "Save Bill"}
          </Button>
        )}
      </div>

      {/* bill preview (Full Truck) — review, adjust, then final save + auto print */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Bill Preview — as it will be printed</DialogTitle>
          </DialogHeader>
          {/* identical layout to the printed invoice */}
          <InvoicePrintView
            data={previewData}
            lrActions={(lr) => (
              <span className="flex gap-1">
                <button
                  type="button"
                  className="text-primary underline disabled:opacity-50"
                  disabled={lrEditLoading !== null}
                  title="Edit this LR — the preview updates as soon as you save"
                  onClick={() => void openLrEdit(lr.id)}
                >
                  {lrEditLoading === lr.id ? "Loading..." : "Edit"}
                </button>
                <button
                  type="button"
                  className="text-destructive underline"
                  title="Remove this LR from the bill"
                  onClick={() => toggleLr(lr.id, false)}
                >
                  Remove
                </button>
              </span>
            )}
          />
          <div className="space-y-1">
            <Label className="text-xs">Remarks (optional — printed on the bill)</Label>
            <Textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={2}
              placeholder="Add or edit bill remarks..."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)} disabled={saving}>
              Back to Edit
            </Button>
            <Button onClick={handleSave} disabled={saving || selectedLrs.length === 0}>
              {saving ? "Saving..." : "Final Save & Print"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* in-place LR edit — full LR form on top of the preview; saving updates
          the LR and refreshes the preview without leaving the page */}
      <Dialog open={!!lrEdit} onOpenChange={(o) => !o && setLrEdit(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>Edit LR {lrEdit?.defaults.lrNo}</DialogTitle>
          </DialogHeader>
          {lrEdit && (
            <LrForm key={lrEdit.lrId} {...lrEdit} onSaved={() => void onLrEdited()} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
