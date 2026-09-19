"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { cn, formatMoney, parseDdMmYyyy, toNum } from "@/lib/utils";
import { lookupRate } from "@/lib/lookups";
import { stateCodeFromGstin } from "@/lib/calc/gst";
import type { RateBasis } from "@/lib/calc/rate";
import {
  computeLrTotals,
  itemAmount,
  itemsFreight,
  RATE_BASIS_LABELS,
  emptyLrItem,
  emptyLrInvoice,
  isBlankLrInvoice,
} from "./lr-calc";
import { saveLr } from "@/app/(app)/lr/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateInput } from "@/components/data/date-input";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { BankCashCombobox } from "@/components/fleet/fields";
import { useToast } from "@/components/ui/use-toast";
import {
  CityCreateDialog,
  PartyCreateDialog,
  VehicleCreateDialog,
  ProductCreateDialog,
} from "@/components/masters/inline-dialogs";

export interface PartyDetail {
  address: string;
  gstin: string;
}

export interface LrFormItem {
  productId: string;
  productName: string;
  description: string;
  qty: number;
  actualWt: number;
  chargeWt: number;
  unit: string;
  rate: number;
  rateBasis: RateBasis;
}

/** one party invoice / e-way line — an LR may carry several */
export interface LrFormInvoice {
  invoiceNo: string;
  obdNo: string;
  refNo: string;
  invoiceDateText: string;
  goodsValue: number;
  ewayBillNo: string;
  ewayExpiryText: string;
}

export interface LrFormValues {
  lrNo: string;
  lrDateText: string;
  refLrNo: string;
  privateMarka: string;
  sourceCityId: string;
  destCityId: string;
  consignorId: string;
  consigneeId: string;
  billToId: string;
  vehicleId: string;
  vehicleText: string;
  invoices: LrFormInvoice[];
  insCompany: string;
  insPolicyNo: string;
  insAmount: number;
  items: LrFormItem[];
  freight: number;
  hamali: number;
  preBhada: number;
  biltyCharge: number;
  collCharge: number;
  cpc: number;
  otherCharge: number;
  gstApplicable: boolean;
  advance: number;
  advanceBank: string;
  lrType: "TO_PAY" | "TBB" | "PAID" | "FOC" | "CANCELLED" | "PAPER_CHANGE";
  printFreight: boolean;
  remarks: string;
  deliveryAt: string;
}

export interface LrFormProps {
  mode: "create" | "edit";
  /** Batch mode: submit adds the LR to the parent's batch instead of saving. */
  batchMode?: boolean;
  /** Receives the payload plus a snapshot of the raw form values (for later tray edits). */
  onBatchAdd?: (payload: Record<string, unknown>, values: LrFormValues) => void;
  /** Batch mode: a tray row is being edited — submit updates it instead of adding. */
  batchEditing?: boolean;
  /** Batch mode: hands the parent form access so tray rows can be loaded / restored. */
  exposeFormApi?: (api: { getValues: () => LrFormValues; reset: (v: LrFormValues) => void }) => void;
  /** Dialog mode: called after a successful save instead of navigating to the register. */
  onSaved?: (lrNo: string) => void;
  isDummy: boolean;
  lrId?: string;
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

const requiredSchema = z.object({
  lrNo: z.string().trim().min(1, "LR number is required"),
  lrDate: z.string().min(1, "Valid LR date (dd/mm/yyyy) is required"),
  sourceCityId: z.string().min(1, "Source city is required"),
  destCityId: z.string().min(1, "Destination city is required"),
  consignorId: z.string().min(1, "Consignor is required"),
  consigneeId: z.string().min(1, "Consignee is required"),
  items: z
    .array(z.object({ productName: z.string().min(1, "Every item needs a product") }))
    .min(1, "At least one item is required"),
});

function toIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Enter advances to the next field (form-entry convention). */
function handleEnterAdvance(e: React.KeyboardEvent<HTMLFormElement>) {
  if (e.key !== "Enter") return;
  const target = e.target as HTMLElement;
  if (target.tagName === "TEXTAREA" || target.tagName === "BUTTON") return;
  e.preventDefault();
  const form = e.currentTarget;
  const focusable = Array.from(
    form.querySelectorAll<HTMLElement>("input, select, textarea, button[role=combobox]")
  ).filter((el) => !el.hasAttribute("disabled"));
  const idx = focusable.indexOf(target);
  if (idx >= 0 && idx < focusable.length - 1) focusable[idx + 1].focus();
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function PartyInfo({ detail }: { detail?: PartyDetail }) {
  if (!detail || (!detail.address && !detail.gstin)) return null;
  return (
    <div className="rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
      {detail.address && <div className="truncate">{detail.address}</div>}
      {detail.gstin && <div>GSTIN: {detail.gstin}</div>}
    </div>
  );
}

export function LrForm(props: LrFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  // Party Invoice Details stays open — clerks fill it on nearly every LR
  const [showInvoice, setShowInvoice] = React.useState(true);
  const [showInsurance, setShowInsurance] = React.useState(false);

  // inline-created options are appended locally
  const [cityOptions, setCityOptions] = React.useState(props.cityOptions);
  const [partyOptions, setPartyOptions] = React.useState(props.partyOptions);
  const [billToOptions, setBillToOptions] = React.useState(props.billToOptions);
  const [vehicleOptions, setVehicleOptions] = React.useState(props.vehicleOptions);
  const [productOptions, setProductOptions] = React.useState(props.productOptions);

  const freightTouched = React.useRef(props.mode === "edit");
  // rows where the user typed Charge Wt manually — stop mirroring Actual Wt there
  const chargeWtTouched = React.useRef<Set<number>>(
    new Set(props.mode === "edit" ? (props.defaults.items ?? []).map((_, i) => i) : [])
  );

  const form = useForm<LrFormValues>({ defaultValues: props.defaults });
  const { register, setValue, watch, control, handleSubmit, reset, getValues } = form;
  const items = useFieldArray({ control, name: "items" });
  const invoices = useFieldArray({ control, name: "invoices" });

  // batch mode: let the parent load a tray row into the form / restore values
  const { exposeFormApi } = props;
  React.useEffect(() => {
    exposeFormApi?.({ getValues, reset });
  }, [exposeFormApi, getValues, reset]);

  // while editing a tray row, treat weights/freight as user-set (no auto-mirroring)
  React.useEffect(() => {
    if (props.batchEditing) {
      freightTouched.current = true;
      (getValues().items ?? []).forEach((_, i) => chargeWtTouched.current.add(i));
    }
  }, [props.batchEditing, getValues]);

  const v = watch();

  const consignorDetail = props.partyDetails[v.consignorId];
  const consigneeDetail = props.partyDetails[v.consigneeId];
  const billToDetail = props.partyDetails[v.billToId];
  const ownerName = v.vehicleId ? props.vehicleOwners[v.vehicleId] ?? "" : "";

  const computedItemsFreight = itemsFreight(
    (v.items ?? []).map((i) => ({
      qty: toNum(i.qty),
      actualWt: toNum(i.actualWt),
      chargeWt: toNum(i.chargeWt),
      rate: toNum(i.rate),
      rateBasis: i.rateBasis,
    }))
  );

  // freight auto = sum of item amounts, until manually edited
  React.useEffect(() => {
    if (!freightTouched.current && toNum(v.freight) !== computedItemsFreight) {
      setValue("freight", computedItemsFreight);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedItemsFreight]);

  const totals = computeLrTotals({
    freight: toNum(v.freight),
    hamali: toNum(v.hamali),
    preBhada: toNum(v.preBhada),
    biltyCharge: toNum(v.biltyCharge),
    collCharge: toNum(v.collCharge),
    cpc: toNum(v.cpc),
    otherCharge: toNum(v.otherCharge),
    gstApplicable: v.gstApplicable,
    gstPct: props.gstPct,
    supplierStateCode: stateCodeFromGstin(consignorDetail?.gstin),
    recipientStateCode: stateCodeFromGstin(consigneeDetail?.gstin),
    advance: toNum(v.advance),
  });

  const tryPrefillRate = React.useCallback(
    async (index: number, productId: string | null) => {
      const { consignorId, billToId, consigneeId, sourceCityId, destCityId } = form.getValues();
      if (!sourceCityId || !destCityId) return;
      // rate may be configured under the consignor, bill-to OR consignee party
      const partyIds = Array.from(
        new Set([consignorId, billToId, consigneeId].filter(Boolean))
      ) as string[];
      for (const partyId of partyIds) {
        try {
          const rate = await lookupRate({
            partyId,
            productId: productId || null,
            sourceCityId,
            destCityId,
          });
          if (rate) {
            freightTouched.current = false; // recompute freight from the looked-up rate
            setValue(`items.${index}.rate`, Number(rate.rate));
            setValue(`items.${index}.rateBasis`, rate.rateBasis as RateBasis);
            return;
          }
        } catch {
          // rate lookup is best-effort
        }
      }
    },
    [form, setValue]
  );

  // Re-fetch rates for every item whenever party or route changes, so the
  // Rate Setup applies regardless of the order fields are filled in.
  const consignorId = form.watch("consignorId");
  const billToId = form.watch("billToId");
  const consigneeId = form.watch("consigneeId");
  const sourceCityId = form.watch("sourceCityId");
  const destCityId = form.watch("destCityId");
  React.useEffect(() => {
    if ((!consignorId && !billToId && !consigneeId) || !sourceCityId || !destCityId) return;
    const rows = form.getValues().items ?? [];
    rows.forEach((row, index) => {
      if (toNum(row.rate) === 0) void tryPrefillRate(index, row.productId || null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consignorId, billToId, consigneeId, sourceCityId, destCityId]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      id: props.lrId ?? null,
      lrNo: values.lrNo,
      lrDate: toIso(values.lrDateText),
      refLrNo: values.refLrNo || null,
      privateMarka: values.privateMarka || null,
      isDummy: props.isDummy,
      sourceCityId: values.sourceCityId,
      destCityId: values.destCityId,
      consignorId: values.consignorId,
      consigneeId: values.consigneeId,
      billToId: values.billToId || null,
      vehicleId: values.vehicleId || null,
      vehicleText: values.vehicleText || null,
      ownerName: props.isDummy ? null : ownerName || null,
      deliveryAt: values.deliveryAt || null,
      remarks: values.remarks || null,
      lrType: values.lrType,
      cargoType,
      printFreight: values.printFreight,
      gstApplicable: values.gstApplicable,
      insCompany: values.insCompany || null,
      insPolicyNo: values.insPolicyNo || null,
      insAmount: toNum(values.insAmount) || null,
      // every invoice line; the server mirrors the first into the LR's own
      // invoice columns for the registers / prints / monitors that read them
      invoices: (values.invoices ?? [])
        .filter((r) => !isBlankLrInvoice(r))
        .map((r) => ({
          invoiceNo: r.invoiceNo || null,
          obdNo: r.obdNo || null,
          refNo: r.refNo || null,
          invoiceDate: r.invoiceDateText ? toIso(r.invoiceDateText) : null,
          goodsValue: toNum(r.goodsValue) || null,
          ewayBillNo: r.ewayBillNo || null,
          ewayExpiry: r.ewayExpiryText ? toIso(r.ewayExpiryText) : null,
        })),
      freight: toNum(values.freight),
      hamali: toNum(values.hamali),
      preBhada: toNum(values.preBhada),
      biltyCharge: toNum(values.biltyCharge),
      collCharge: toNum(values.collCharge),
      cpc: toNum(values.cpc),
      otherCharge: toNum(values.otherCharge),
      advance: toNum(values.advance),
      advanceBank: values.advanceBank || null,
      items: values.items.map((i) => ({
        productId: i.productId || null,
        productName: i.productName,
        description: i.description || null,
        qty: toNum(i.qty),
        actualWt: toNum(i.actualWt),
        chargeWt: toNum(i.chargeWt),
        unit: i.unit || "MT",
        rate: toNum(i.rate),
        rateBasis: i.rateBasis,
      })),
    };

    const check = requiredSchema.safeParse(payload);
    if (!check.success) {
      toast({ variant: "destructive", title: check.error.issues[0]?.message ?? "Invalid form" });
      return;
    }

    if (props.batchMode && props.onBatchAdd) {
      props.onBatchAdd(payload, structuredClone(values));
      if (!props.batchEditing) {
        // keep route/party/vehicle for the next LR — bump the display number
        // and blank the per-consignment fields (goods value, e-way, items)
        const n = parseInt(values.lrNo, 10);
        if (!isNaN(n)) setValue("lrNo", String(n + 1));
        invoices.replace([emptyLrInvoice()]);
        items.replace([emptyLrItem()]);
        // fresh items: freight re-computes from the rate picked via Rate Setup,
        // and Charge Wt mirrors Actual Wt again
        setValue("freight", 0);
        freightTouched.current = false;
        chargeWtTouched.current.clear();
      }
      return;
    }

    setSaving(true);
    try {
      const res = await saveLr(payload);
      if (res.ok) {
        toast({ title: `LR ${values.lrNo} saved` });
        if (props.onSaved) props.onSaved(values.lrNo);
        else router.push("/lr/register");
      } else {
        toast({ variant: "destructive", title: res.error });
      }
    } finally {
      setSaving(false);
    }
  });

  const cargoType = (v.items ?? []).some(
    (it) => it.productId && props.productTypes[it.productId] === "ODC"
  )
    ? "ODC"
    : "NORMAL";

  const inputCls = "h-9";
  const numCls = "h-9 text-right tabular-nums";

  return (
    <form onSubmit={onSubmit} onKeyDown={handleEnterAdvance} className="space-y-4">
      {/* ---------- Header ---------- */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">
            {props.isDummy ? "LR Entry (Dumy)" : "LR Entry"}
            {props.mode === "edit" && " — Edit"}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="LR No *">
            <Input
              {...register("lrNo")}
              className={inputCls}
              readOnly={props.mode === "edit"}
              title={props.mode === "edit" ? "LR number is locked after saving" : undefined}
            />
          </Field>
          <Field label="LR Date *">
            <DateInput
              value={v.lrDateText}
              onChange={(text) => setValue("lrDateText", text)}
              className={inputCls}
            />
          </Field>
          <Field label="Ref LR No">
            <Input {...register("refLrNo")} className={inputCls} />
          </Field>
          <Field label="Private Marka">
            <Input {...register("privateMarka")} className={inputCls} />
          </Field>
        </CardContent>
      </Card>

      {/* ---------- Route ---------- */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Route</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-2">
          <Field label="Source City *">
            <MasterCombobox
              options={cityOptions}
              value={v.sourceCityId}
              onChange={(val) => setValue("sourceCityId", val ?? "")}
              placeholder="Select source city..."
              createLabel="+ Create city"
              renderCreateDialog={(closeAndSelect) => (
                <CityCreateDialog
                  open
                  onOpenChange={(o: boolean) => {
                    if (!o) closeAndSelect(v.sourceCityId);
                  }}
                  onCreated={(opt: MasterOption) => {
                    setCityOptions((prev) => [...prev, opt]);
                    closeAndSelect(opt.value);
                  }}
                />
              )}
            />
          </Field>
          <Field label="Destination City *">
            <MasterCombobox
              options={cityOptions}
              value={v.destCityId}
              onChange={(val) => setValue("destCityId", val ?? "")}
              placeholder="Select destination city..."
              createLabel="+ Create city"
              renderCreateDialog={(closeAndSelect) => (
                <CityCreateDialog
                  open
                  onOpenChange={(o: boolean) => {
                    if (!o) closeAndSelect(v.destCityId);
                  }}
                  onCreated={(opt: MasterOption) => {
                    setCityOptions((prev) => [...prev, opt]);
                    closeAndSelect(opt.value);
                  }}
                />
              )}
            />
          </Field>
        </CardContent>
      </Card>

      {/* ---------- Parties ---------- */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Parties</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0 lg:grid-cols-3">
          <div className="space-y-2">
            <Field label="Consignor *">
              <MasterCombobox
                options={partyOptions}
                value={v.consignorId}
                onChange={(val) => setValue("consignorId", val ?? "")}
                placeholder="Select consignor..."
                createLabel="+ Create party"
                renderCreateDialog={(closeAndSelect) => (
                  <PartyCreateDialog
                    open
                    onOpenChange={(o: boolean) => {
                      if (!o) closeAndSelect(v.consignorId);
                    }}
                    onCreated={(opt: MasterOption) => {
                      setPartyOptions((prev) => [...prev, opt]);
                      setBillToOptions((prev) => [...prev, opt]);
                      closeAndSelect(opt.value);
                    }}
                  />
                )}
              />
            </Field>
            <PartyInfo detail={consignorDetail} />
          </div>
          <div className="space-y-2">
            <Field label="Consignee *">
              <MasterCombobox
                options={partyOptions}
                value={v.consigneeId}
                onChange={(val) => setValue("consigneeId", val ?? "")}
                placeholder="Select consignee..."
                createLabel="+ Create party"
                renderCreateDialog={(closeAndSelect) => (
                  <PartyCreateDialog
                    open
                    onOpenChange={(o: boolean) => {
                      if (!o) closeAndSelect(v.consigneeId);
                    }}
                    onCreated={(opt: MasterOption) => {
                      setPartyOptions((prev) => [...prev, opt]);
                      setBillToOptions((prev) => [...prev, opt]);
                      closeAndSelect(opt.value);
                    }}
                  />
                )}
              />
            </Field>
            <PartyInfo detail={consigneeDetail} />
          </div>
          <div className="space-y-2">
            <Field label="Billed To">
              <MasterCombobox
                options={billToOptions}
                value={v.billToId}
                onChange={(val) => setValue("billToId", val ?? "")}
                placeholder="Select billed-to party..."
                createLabel="+ Create party"
                renderCreateDialog={(closeAndSelect) => (
                  <PartyCreateDialog
                    open
                    onOpenChange={(o: boolean) => {
                      if (!o) closeAndSelect(v.billToId);
                    }}
                    onCreated={(opt: MasterOption) => {
                      setBillToOptions((prev) => [...prev, opt]);
                      closeAndSelect(opt.value);
                    }}
                  />
                )}
              />
            </Field>
            <PartyInfo detail={billToDetail} />
          </div>
        </CardContent>
      </Card>

      {/* ---------- Vehicle ---------- */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Vehicle</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-2">
          {props.isDummy ? (
            <Field label="Vehicle (free text)">
              <Input {...register("vehicleText")} className={inputCls} placeholder="e.g. MP09 XX 1234" />
            </Field>
          ) : (
            <>
              <Field label="Vehicle">
                <MasterCombobox
                  options={vehicleOptions}
                  value={v.vehicleId}
                  onChange={(val) => setValue("vehicleId", val ?? "")}
                  placeholder="Select vehicle..."
                  createLabel="+ Create vehicle"
                  renderCreateDialog={(closeAndSelect) => (
                    <VehicleCreateDialog
                      open
                      onOpenChange={(o: boolean) => {
                        if (!o) closeAndSelect(v.vehicleId);
                      }}
                      onCreated={(opt: MasterOption) => {
                        setVehicleOptions((prev) => [...prev, opt]);
                        closeAndSelect(opt.value);
                      }}
                    />
                  )}
                />
              </Field>
              <Field label="Owner">
                <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground">
                  {ownerName || "—"}
                </div>
              </Field>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---------- Party Invoice Details (collapsible) ---------- */}
      <Card>
        <div className="flex items-center justify-between p-4">
          <button
            type="button"
            className="flex items-center gap-2 text-sm font-semibold"
            onClick={() => setShowInvoice((s) => !s)}
          >
            {showInvoice ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Party Invoice Details
            <span className="text-xs font-normal text-muted-foreground">
              (optional{invoices.fields.length > 1 ? ` · ${invoices.fields.length} invoices` : ""})
            </span>
          </button>
          {showInvoice && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => invoices.append(emptyLrInvoice())}
            >
              <Plus className="h-4 w-4" /> Add Row
            </Button>
          )}
        </div>
        {showInvoice && (
          <CardContent className="space-y-3 p-4 pt-0">
            {/* one line per party invoice — the same Add Row pattern as products */}
            {invoices.fields.map((f, index) => (
              <div
                key={f.id}
                className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_1fr_1fr_1fr_36px]"
              >
                <Field label={index === 0 ? "Invoice No" : `Invoice No (${index + 1})`}>
                  <Input {...register(`invoices.${index}.invoiceNo`)} className={inputCls} />
                </Field>
                <Field label="OBD No">
                  <Input {...register(`invoices.${index}.obdNo`)} className={inputCls} />
                </Field>
                <Field label="Ref No">
                  <Input {...register(`invoices.${index}.refNo`)} className={inputCls} />
                </Field>
                <Field label="Invoice Date">
                  <DateInput
                    value={v.invoices?.[index]?.invoiceDateText ?? ""}
                    onChange={(text) => setValue(`invoices.${index}.invoiceDateText`, text)}
                    className={inputCls}
                  />
                </Field>
                <Field label="Goods Value">
                  <Input
                    type="number"
                    step="any"
                    {...register(`invoices.${index}.goodsValue`, { valueAsNumber: true })}
                    className={numCls}
                  />
                </Field>
                <Field label="E-way Bill No">
                  <Input {...register(`invoices.${index}.ewayBillNo`)} className={inputCls} />
                </Field>
                <Field label="E-way Expiry">
                  <DateInput
                    value={v.invoices?.[index]?.ewayExpiryText ?? ""}
                    onChange={(text) => setValue(`invoices.${index}.ewayExpiryText`, text)}
                    className={inputCls}
                  />
                </Field>
                <div className="flex items-end justify-center pb-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    title="Remove this invoice"
                    onClick={() =>
                      invoices.fields.length > 1
                        ? invoices.remove(index)
                        : invoices.replace([emptyLrInvoice()])
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      {/* ---------- Insurance (collapsible) ---------- */}
      <Card>
        <button
          type="button"
          className="flex w-full items-center gap-2 p-4 text-sm font-semibold"
          onClick={() => setShowInsurance((s) => !s)}
        >
          {showInsurance ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Insurance
          <span className="text-xs font-normal text-muted-foreground">(optional)</span>
        </button>
        {showInsurance && (
          <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-3">
            <Field label="Insurance Company">
              <Input {...register("insCompany")} className={inputCls} />
            </Field>
            <Field label="Policy No">
              <Input {...register("insPolicyNo")} className={inputCls} />
            </Field>
            <Field label="Insured Amount">
              <Input type="number" step="any" {...register("insAmount", { valueAsNumber: true })} className={numCls} />
            </Field>
          </CardContent>
        )}
      </Card>

      {/* ---------- Items ---------- */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between p-4 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            Product Details
            <Badge variant={cargoType === "ODC" ? "destructive" : "secondary"}>
              {cargoType === "ODC" ? "ODC LR" : "Normal LR"}
            </Badge>
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => items.append(emptyLrItem())}
          >
            <Plus className="h-4 w-4" /> Add Row
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 overflow-x-auto p-4 pt-0">
          <div className="min-w-[1120px]">
            <div className="grid grid-cols-[200px_72px_1fr_80px_90px_90px_60px_90px_120px_100px_36px] gap-1 px-1 text-xs font-medium text-muted-foreground">
              <div>Product</div>
              <div>Type</div>
              <div>Description</div>
              <div className="text-right">Qty</div>
              <div className="text-right">Actual Wt</div>
              <div className="text-right">Charge Wt</div>
              <div>Unit</div>
              <div className="text-right">Rate</div>
              <div>Rate Basis</div>
              <div className="text-right">Amount</div>
              <div />
            </div>
            {items.fields.map((field, index) => {
              const row = v.items?.[index];
              const amount = row
                ? itemAmount({
                    qty: toNum(row.qty),
                    actualWt: toNum(row.actualWt),
                    chargeWt: toNum(row.chargeWt),
                    rate: toNum(row.rate),
                    rateBasis: row.rateBasis,
                  })
                : 0;
              return (
                <div
                  key={field.id}
                  className="grid grid-cols-[200px_72px_1fr_80px_90px_90px_60px_90px_120px_100px_36px] items-center gap-1 px-1 py-0.5"
                >
                  <MasterCombobox
                    options={productOptions}
                    value={row?.productId}
                    onChange={(val) => {
                      const opt = productOptions.find((o) => o.value === val);
                      setValue(`items.${index}.productId`, val ?? "");
                      setValue(`items.${index}.productName`, opt?.label ?? "");
                      if (val) {
                        const u = props.productUnits[val];
                        if (u) setValue(`items.${index}.unit`, u);
                        void tryPrefillRate(index, val);
                      }
                    }}
                    placeholder="Product..."
                    className="h-9"
                    createLabel="+ Create product"
                    renderCreateDialog={(closeAndSelect) => (
                      <ProductCreateDialog
                        open
                        onOpenChange={(o: boolean) => {
                          if (!o) closeAndSelect(row?.productId ?? "");
                        }}
                        onCreated={(opt: MasterOption) => {
                          setProductOptions((prev) => [...prev, opt]);
                          setValue(`items.${index}.productName`, opt.label);
                          closeAndSelect(opt.value);
                        }}
                      />
                    )}
                  />
                  <div className="flex justify-center">
                    {row?.productId && props.productTypes[row.productId] === "ODC" ? (
                      <Badge variant="destructive" className="text-[10px]">ODC</Badge>
                    ) : row?.productId ? (
                      <Badge variant="secondary" className="text-[10px]">Normal</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                  <Input {...register(`items.${index}.description`)} className={inputCls} />
                  <Input
                    type="number"
                    step="any"
                    {...register(`items.${index}.qty`, { valueAsNumber: true })}
                    className={numCls}
                    onFocus={(e) => e.target.select()}
                  />
                  <Input
                    type="number"
                    step="any"
                    {...register(`items.${index}.actualWt`, {
                      valueAsNumber: true,
                      onChange: (e) => {
                        if (!chargeWtTouched.current.has(index)) {
                          setValue(`items.${index}.chargeWt`, toNum(e.target.value));
                        }
                      },
                    })}
                    className={numCls}
                    onFocus={(e) => e.target.select()}
                  />
                  <Input
                    type="number"
                    step="any"
                    {...register(`items.${index}.chargeWt`, {
                      valueAsNumber: true,
                      onChange: () => chargeWtTouched.current.add(index),
                    })}
                    className={numCls}
                    onFocus={(e) => e.target.select()}
                  />
                  <Input {...register(`items.${index}.unit`)} className={inputCls} />
                  <Input
                    type="number"
                    step="any"
                    {...register(`items.${index}.rate`, {
                      valueAsNumber: true,
                      // changing a rate (also in edit mode) re-enables auto freight
                      // so Freight and Grand Total recalculate from the new rate
                      onChange: () => {
                        freightTouched.current = false;
                      },
                    })}
                    className={numCls}
                    onFocus={(e) => e.target.select()}
                  />
                  <Select
                    value={row?.rateBasis ?? "CHARGE_WT"}
                    onValueChange={(val) => {
                      freightTouched.current = false;
                      setValue(`items.${index}.rateBasis`, val as RateBasis);
                    }}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["QTY", "ACTUAL_WT", "CHARGE_WT", "FIXED"] as const).map((b) => (
                        <SelectItem key={b} value={b} className={b === "FIXED" ? "font-semibold" : undefined}>
                          {RATE_BASIS_LABELS[b]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex h-9 items-center justify-end rounded-md border bg-muted/50 px-2 text-sm tabular-nums">
                    {formatMoney(amount)}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    disabled={items.fields.length <= 1}
                    onClick={() => items.remove(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
            <div className="flex justify-end px-1 pt-1 text-sm font-medium tabular-nums">
              Items Total: {formatMoney(computedItemsFreight)}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------- Charges ---------- */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Charges</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Field label="Freight">
              <Input
                type="number"
                step="any"
                {...register("freight", {
                  valueAsNumber: true,
                  onChange: () => {
                    freightTouched.current = true;
                  },
                })}
                className={numCls}
              />
            </Field>
            <Field label="Hamali">
              <Input type="number" step="any" {...register("hamali", { valueAsNumber: true })} className={numCls} />
            </Field>
            <Field label="Pre Bhada">
              <Input type="number" step="any" {...register("preBhada", { valueAsNumber: true })} className={numCls} />
            </Field>
            <Field label="Bilty Charge">
              <Input type="number" step="any" {...register("biltyCharge", { valueAsNumber: true })} className={numCls} />
            </Field>
            <Field label="Coll. Charge">
              <Input type="number" step="any" {...register("collCharge", { valueAsNumber: true })} className={numCls} />
            </Field>
            <Field label="CPC">
              <Input type="number" step="any" {...register("cpc", { valueAsNumber: true })} className={numCls} />
            </Field>
            <Field label="Other Charge">
              <Input type="number" step="any" {...register("otherCharge", { valueAsNumber: true })} className={numCls} />
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="flex items-center gap-2 pb-1">
              <Switch
                checked={v.gstApplicable}
                onCheckedChange={(c) => setValue("gstApplicable", c)}
                id="gst-toggle"
              />
              <Label htmlFor="gst-toggle" className="text-sm">
                GST Applicable ({props.gstPct}%)
              </Label>
            </div>
            <Field label="Advance">
              <Input
                type="number"
                step="any"
                {...register("advance", { valueAsNumber: true })}
                className={cn(numCls, "w-32")}
              />
            </Field>
            <Field label="Advance Bank" className="min-w-[220px]">
              <BankCashCombobox mode="BANK"
                options={props.bankOptions}
                value={v.advanceBank ? props.bankOptions.find((b) => b.label === v.advanceBank)?.value ?? null : null}
                onChange={(val) => {
                  const opt = props.bankOptions.find((b) => b.value === val);
                  setValue("advanceBank", opt?.label ?? "");
                }}
                placeholder="Select bank..."
              />
            </Field>
          </div>

          <div className="ml-auto w-full max-w-sm space-y-1 rounded-md border bg-muted/30 p-3 text-sm tabular-nums">
            <div className="flex justify-between">
              <span>Total</span>
              <span>{formatMoney(totals.total)}</span>
            </div>
            {v.gstApplicable && (
              <>
                <div className="flex justify-between text-muted-foreground">
                  <span>CGST</span>
                  <span>{formatMoney(totals.cgstAmt)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>SGST</span>
                  <span>{formatMoney(totals.sgstAmt)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>IGST</span>
                  <span>{formatMoney(totals.igstAmt)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between text-muted-foreground">
              <span>Less: Advance</span>
              <span>{formatMoney(toNum(v.advance))}</span>
            </div>
            <div className="flex justify-between border-t pt-1 font-semibold">
              <span>Grand Total</span>
              <span>{formatMoney(totals.grandTotal)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------- Footer ---------- */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <Field label="LR Type" className="w-36">
            <Select value={v.lrType} onValueChange={(val) => setValue("lrType", val as LrFormValues["lrType"])}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TO_PAY">To Pay</SelectItem>
                <SelectItem value="TBB">TBB</SelectItem>
                <SelectItem value="PAID">Paid</SelectItem>
                <SelectItem value="FOC">FOC</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
                <SelectItem value="PAPER_CHANGE">Paper Change</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Print Freight" className="w-28">
            <Select
              value={v.printFreight ? "yes" : "no"}
              onValueChange={(val) => setValue("printFreight", val === "yes")}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yes">Yes</SelectItem>
                <SelectItem value="no">No</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Delivery At" className="w-48">
            <Input {...register("deliveryAt")} className={inputCls} />
          </Field>
          <Field label="Remarks" className="min-w-[240px] flex-1">
            <Textarea {...register("remarks")} rows={1} className="min-h-9" />
          </Field>
          <Button type="submit" disabled={saving} className="h-9">
            {props.batchMode
              ? props.batchEditing
                ? "Update LR in Batch"
                : "Add LR"
              : saving
                ? "Saving..."
                : props.mode === "edit"
                  ? "Update LR"
                  : "Save LR"}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
