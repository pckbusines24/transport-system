"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Field, NumInput, isoFromText, textFromIso, todayText } from "./shared";
import {
  getPendingTripDocs,
  getPrevLoadingKm,
  getTripSettlementInfo,
  saveTrip,
  type PendingTripDoc,
  type TripSettlementInfo,
} from "@/app/(app)/trips/actions";
import {
  fetchDriverAdvancesForTrip,
  type DriverAdvanceFetchRow,
} from "@/app/(app)/vehicle/driver-advances/actions";
import { fetchAdblueForTrip } from "@/app/(app)/vehicle/adblue/actions";
import {
  fetchVehicleExpensesForTrip,
  type TripFetchedExpenseRow,
} from "@/app/(app)/vehicle/expenses/actions";
import { settleDriverRunningBalance } from "@/app/(app)/vehicle/driver-settlements/actions";

const r2 = (n: number) => Math.round(n * 100) / 100;
const signed = (n: number) =>
  n === 0 ? "0" : `${n > 0 ? "+" : "−"}${formatMoney(Math.abs(n))}`;

/**
 * The three methods are independent: each decides what the left and right sides
 * mean, and switching between them changes nothing about how the other two
 * behave.
 *
 *  DIESEL_AVG / FIXED — driver settlement methods. Left is what the driver
 *    actually spent, right is what the company approved, and the difference is
 *    posted to the driver +/- register.
 *  ACTUAL — a vehicle profitability method. Left is what the vehicle actually
 *    cost to run, income is the Grand Total of the linked documents, and there
 *    is no approved side and no driver settlement at all.
 */
const CALC_METHODS = {
  DIESEL_AVG: "Diesel Average",
  FIXED: "Fixed",
  ACTUAL: "Actual Income − Actual Expenses",
} as const;
type CalcMethod = keyof typeof CALC_METHODS;

export interface TripSettlementInitial {
  id: string;
  tripNo: string;
  fromDate: string | null;
  toDate: string | null;
  vehicleId: string;
  driverId: string | null;
  calcMethod: string;
  docs: { refType: "CHALAN" | "BROKER_SLIP"; refId: string }[];
  tollExpenseType: string;
  tollAmount: number;
  actualDiesel: number;
  actualAdvance: number;
  advanceIds: string[];
  ureaQty: number;
  ureaRate: number;
  ureaExpenseType: string;
  loadingKm: number;
  unloadingKm: number;
  newLoadingKm: number;
  dieselAvg: number;
  dieselAvg2: number;
  dieselRate: number;
  apprDriverAdvance: number;
  roadBillExp: number;
  foodingDays: number;
  foodingRate: number;
  rtoExp: number;
  fixedTripExp: number;
  roadExp: number;
  otherOpExp: number;
  autoFetchedExp: number;
}

export function TripSettlementForm({
  vehicles,
  drivers,
  driverByVehicle,
  bankOptions,
  nextTripNo,
  initial,
  readOnly = false,
}: {
  vehicles: MasterOption[];
  drivers: MasterOption[];
  driverByVehicle: Record<string, string>;
  bankOptions: MasterOption[];
  nextTripNo: string;
  initial?: TripSettlementInitial | null;
  /** View mode from the register: everything visible (detail popups included), no Save/Update */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  // ---- step 1: header ----
  const [tripNo, setTripNo] = React.useState(initial?.tripNo ?? nextTripNo);
  const [vehicleId, setVehicleId] = React.useState<string | null>(initial?.vehicleId ?? null);
  const [driverId, setDriverId] = React.useState<string | null>(initial?.driverId ?? null);
  const [fromText, setFromText] = React.useState(
    initial?.fromDate ? textFromIso(initial.fromDate) : todayText()
  );
  const [toText, setToText] = React.useState(
    initial?.toDate ? textFromIso(initial.toDate) : todayText()
  );
  const [calcMethod, setCalcMethod] = React.useState<CalcMethod>(
    initial?.calcMethod === "FIXED" || initial?.calcMethod === "ACTUAL"
      ? initial.calcMethod
      : "DIESEL_AVG"
  );
  const isActual = calcMethod === "ACTUAL";

  const fromIso = isoFromText(fromText);
  const toIso = isoFromText(toText) || fromIso;

  React.useEffect(() => {
    if (vehicleId && !driverId && driverByVehicle[vehicleId]) {
      setDriverId(driverByVehicle[vehicleId]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId]);

  // ---- step 1b: pending chalans / broker slips ----
  const [pendingDocs, setPendingDocs] = React.useState<PendingTripDoc[]>([]);
  // a failed fetch must SAY so — an empty list with no error reads as "no
  // pending documents", which sends the user hunting in the wrong direction
  const [pendingError, setPendingError] = React.useState<string | null>(null);
  const [selectedDocs, setSelectedDocs] = React.useState<Set<string>>(
    new Set(initial?.docs.map((d) => `${d.refType}:${d.refId}`) ?? [])
  );
  React.useEffect(() => {
    if (!vehicleId || !fromIso || !toIso) {
      setPendingDocs([]);
      setPendingError(null);
      return;
    }
    let cancelled = false;
    getPendingTripDocs({
      vehicleId,
      dateFrom: fromIso,
      dateTo: toIso,
      excludeTripId: initial?.id ?? null,
    })
      .then((r) => {
        if (!cancelled) {
          setPendingDocs(r);
          setPendingError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setPendingDocs([]);
          setPendingError(
            e instanceof Error && e.message
              ? e.message
              : "Pending chalans could not be loaded — refresh the page and try again."
          );
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId, fromIso, toIso]);

  const selected = pendingDocs.filter((d) => selectedDocs.has(`${d.refType}:${d.refId}`));
  const docFreight = r2(selected.reduce((s, d) => s + d.freight, 0));
  // Trip income is the Grand Total, never the bare freight — detention, ODC and
  // fine slip are earned on the trip, and commission, mamul and courier are
  // suffered on it, so a freight-only figure overstates what the vehicle made.
  const docGrandTotal = r2(selected.reduce((s, d) => s + d.grandTotal, 0));

  // ---- left side: SNAPSHOT by default on saved trips ----
  // A finalized trip sheet is frozen — view & edit show the values saved at
  // final-save time. Live fetching only runs for new sheets, or after the
  // user explicitly clicks "Fetch New Data".
  const [liveMode, setLiveMode] = React.useState(!initial?.id);
  const [exp, setExp] = React.useState<{
    dieselTotal: number;
    tollTotal: number;
    rows: TripFetchedExpenseRow[];
  }>({
    dieselTotal: initial?.actualDiesel ?? 0,
    tollTotal: initial?.tollAmount ?? 0,
    rows: [],
  });
  const [advances, setAdvances] = React.useState<{ total: number; rows: DriverAdvanceFetchRow[] }>({
    total: initial?.actualAdvance ?? 0,
    rows: [],
  });
  const [urea, setUrea] = React.useState<{
    totalQty: number;
    rows: { id: string; date: string; destination: string; qty: number; remarks: string }[];
  }>({ totalQty: initial?.ureaQty ?? 0, rows: [] });
  const [popup, setPopup] = React.useState<"DIESEL" | "ADVANCE" | "UREA" | null>(null);

  // Saved sheets are frozen: totals come from the snapshot and no live fetch
  // runs, which used to leave every "click for detail" popup EMPTY. Opening a
  // popup now lazily fetches the detail rows for the saved period — read-only,
  // merged into `rows` only, so the frozen totals are never touched.
  const detailFetched = React.useRef(false);
  const openPopup = (p: "DIESEL" | "ADVANCE" | "UREA") => {
    setPopup(p);
    if (liveMode || detailFetched.current || !vehicleId || !fromIso || !toIso) return;
    detailFetched.current = true;
    fetchVehicleExpensesForTrip({ vehicleId, dateFrom: fromIso, dateTo: toIso })
      .then((r) => setExp((prev) => ({ ...prev, rows: r.rows })))
      .catch(() => {});
    fetchAdblueForTrip({ vehicleId, dateFrom: fromIso, dateTo: toIso })
      .then((r) => setUrea((prev) => ({ ...prev, rows: r.rows })))
      .catch(() => {});
    if (driverId)
      fetchDriverAdvancesForTrip({
        driverId,
        vehicleId,
        dateFrom: fromIso,
        dateTo: toIso,
        includeTripId: initial?.id ?? null,
      })
        .then((r) => setAdvances((prev) => ({ ...prev, rows: r.rows })))
        .catch(() => {});
  };

  React.useEffect(() => {
    if (!liveMode || !vehicleId || !fromIso || !toIso) return;
    let cancelled = false;
    fetchVehicleExpensesForTrip({ vehicleId, dateFrom: fromIso, dateTo: toIso })
      .then((r) => !cancelled && setExp(r))
      .catch(() => setExp({ dieselTotal: 0, tollTotal: 0, rows: [] }));
    fetchAdblueForTrip({ vehicleId, dateFrom: fromIso, dateTo: toIso })
      .then((r) => !cancelled && setUrea(r))
      .catch(() => setUrea({ totalQty: 0, rows: [] }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode, vehicleId, fromIso, toIso]);
  React.useEffect(() => {
    if (!liveMode) return;
    if (!driverId || !fromIso || !toIso) {
      setAdvances({ total: 0, rows: [] });
      return;
    }
    let cancelled = false;
    fetchDriverAdvancesForTrip({
      driverId,
      vehicleId,
      dateFrom: fromIso,
      dateTo: toIso,
      includeTripId: initial?.id ?? null,
    })
      .then((r) => !cancelled && setAdvances(r))
      .catch(() => setAdvances({ total: 0, rows: [] }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode, driverId, vehicleId, fromIso, toIso]);

  const [tollType, setTollType] = React.useState<"DRIVER" | "COMPANY">(
    initial?.tollExpenseType === "COMPANY" ? "COMPANY" : "DRIVER"
  );
  const [ureaType, setUreaType] = React.useState<"DRIVER" | "COMPANY">(
    initial?.ureaExpenseType === "COMPANY" ? "COMPANY" : "DRIVER"
  );
  const [ureaRate, setUreaRate] = React.useState(initial?.ureaRate ?? 0);
  const ureaAmount = r2(urea.totalQty * ureaRate);

  const tollDriver = tollType === "DRIVER" ? exp.tollTotal : 0;
  const ureaDriver = ureaType === "DRIVER" ? ureaAmount : 0;
  const driverActualTotal = r2(exp.dieselTotal + advances.total + tollDriver + ureaDriver);

  // ---- right side (company approved) ----
  const [loadingKm, setLoadingKm] = React.useState(initial?.loadingKm ?? 0);
  const [unloadingKm, setUnloadingKm] = React.useState(initial?.unloadingKm ?? 0);
  const [newLoadingKm, setNewLoadingKm] = React.useState(initial?.newLoadingKm ?? 0);
  const [dieselAvg, setDieselAvg] = React.useState(initial?.dieselAvg ?? 0);
  const [dieselAvg2, setDieselAvg2] = React.useState(initial?.dieselAvg2 ?? 0);
  const [dieselRate, setDieselRate] = React.useState(initial?.dieselRate ?? 0);
  // previous trip's New Loading KM (info-only warning; never blocks saving)
  const prevKmRef = React.useRef<{ km: number; tripNo: string } | null>(null);
  const prevKmWarned = React.useRef(false);
  const [apprAdvance, setApprAdvance] = React.useState(initial?.apprDriverAdvance ?? 0);
  const [roadBill, setRoadBill] = React.useState(initial?.roadBillExp ?? 0);
  const [foodingDays, setFoodingDays] = React.useState(initial?.foodingDays ?? 0);
  const [foodingRate, setFoodingRate] = React.useState(initial?.foodingRate ?? 0);
  const [rtoExp, setRtoExp] = React.useState(initial?.rtoExp ?? 0);
  const [fixedExp, setFixedExp] = React.useState(initial?.fixedTripExp ?? 0);
  // ACTUAL method — the operating heads that are not auto-fetched
  const [roadExp, setRoadExp] = React.useState(initial?.roadExp ?? 0);
  const [otherOpExp, setOtherOpExp] = React.useState(initial?.otherOpExp ?? 0);

  // auto-fetch the previous trip's New Loading KM into Loading KM
  React.useEffect(() => {
    if (!vehicleId || initial?.id) return;
    let cancelled = false;
    getPrevLoadingKm({ vehicleId, excludeTripId: initial?.id ?? null })
      .then((r) => {
        if (cancelled) return;
        prevKmRef.current = r;
        prevKmWarned.current = false;
        if (r) setLoadingKm(r.km);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId]);

  const onLoadingKmChange = (n: number) => {
    setLoadingKm(n);
    const prev = prevKmRef.current;
    if (prev && n !== prev.km && !prevKmWarned.current) {
      prevKmWarned.current = true; // info only — never blocks anything
      window.confirm(
        `Previous Trip (${prev.tripNo}) New Loading KM is ${prev.km.toLocaleString("en-IN")}. Do you want to use a different Loading KM?`
      );
    }
  };

  const dist1 = Math.max(0, unloadingKm - loadingKm);
  const dist2 = newLoadingKm > 0 ? Math.max(0, newLoadingKm - unloadingKm) : 0;
  const fuel1 = dieselAvg > 0 ? r2((dist1 / dieselAvg) * dieselRate) : 0;
  const fuel2 = dieselAvg2 > 0 ? r2((dist2 / dieselAvg2) * dieselRate) : 0;
  // Total Diesel Cost is a whole rupee (standard rounding: .50 rounds up)
  const totalDieselCost = Math.round(fuel1 + fuel2);
  const fooding = r2(foodingDays * foodingRate);

  // ---- ACTUAL method: real running cost of the vehicle ----
  // Toll and urea are counted whichever way their Driver/Company toggle is set:
  // the toggle decides who bears the cost for the driver settlement, but the
  // vehicle burned the fuel and paid the toll either way.
  // register-booked "other" heads deliberately NOT counted: those bills are
  // already the company's recorded cost in the vehicle expense register —
  // pulling them in here counted the same rupee twice
  const actualOperatingTotal = r2(
    exp.dieselTotal +
      advances.total +
      exp.tollTotal +
      ureaAmount +
      roadBill +
      fooding +
      rtoExp +
      roadExp +
      otherOpExp
  );
  const actualProfit = r2(docGrandTotal - actualOperatingTotal);

  // approved total (compared with actuals for the DRIVER settlement).
  // ACTUAL has no approved side — it never reaches the settlement at all.
  const approvedTotal = isActual
    ? 0
    : calcMethod === "DIESEL_AVG"
      ? r2(totalDieselCost + apprAdvance + roadBill + fooding + rtoExp)
      : r2(fixedExp + apprAdvance);
  // left-side total as stored on the trip: driver actuals for the settlement
  // methods, vehicle operating cost for ACTUAL
  const actualTotal = isActual ? actualOperatingTotal : driverActualTotal;
  // company toll / urea join the COMPANY VEHICLE COST only — never the settlement
  const grandTotal = isActual
    ? actualOperatingTotal
    : r2(
        approvedTotal +
          (tollType === "COMPANY" ? exp.tollTotal : 0) +
          (ureaType === "COMPANY" ? ureaAmount : 0)
      );
  // never posted for ACTUAL; the server enforces this too
  const driverBalance = isActual ? 0 : r2(approvedTotal - driverActualTotal);

  // ---- running balance ----
  const [settleInfo, setSettleInfo] = React.useState<TripSettlementInfo>({
    previousBalance: 0,
    current: null,
  });
  const reloadSettleInfo = React.useCallback(() => {
    if (!driverId) return;
    getTripSettlementInfo({ driverId, excludeTripId: initial?.id ?? null })
      .then(setSettleInfo)
      .catch(() => setSettleInfo({ previousBalance: 0, current: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverId, initial?.id]);
  React.useEffect(() => {
    reloadSettleInfo();
  }, [reloadSettleInfo]);

  const finalRunning = r2(settleInfo.previousBalance + driverBalance);

  // ---- settle dialog (pay / receive current trip balance) ----
  const [settleOpen, setSettleOpen] = React.useState(false);
  const [settleBank, setSettleBank] = React.useState<string | null>(null);
  const [settleMode, setSettleMode] = React.useState<"CASH" | "BANK">("CASH");

  const submit = async () => {
    if (!vehicleId) return toast({ variant: "destructive", title: "Vehicle is required" });
    if (!fromIso) return toast({ variant: "destructive", title: "Valid From Date is required" });
    setBusy(true);
    try {
      // approved components stored as trip expenses so registers / vehicle
      // P&L see the company cost (trip never creates module expense records)
      const expenses: { category: string; amount: number; remarks: string | null; date: string | null }[] = [];
      const push = (category: string, amount: number, remarks: string) => {
        if (amount > 0) expenses.push({ category, amount, remarks, date: fromIso });
      };
      if (isActual) {
        // ACTUAL books what was really spent, so the vehicle report shows the
        // same cost the sheet does. Diesel and toll are recorded here rather
        // than left to the vehicle expense register because the P&L already
        // excludes those two heads from its own expense sweep — counting them
        // in both places would double the running cost.
        push("DIESEL", exp.dieselTotal, "Actual diesel (auto)");
        push("TOLL", exp.tollTotal, "Actual toll (auto)");
        push("MISC", advances.total, "Actual driver advance (auto)");
        // company urea is regenerated server-side; only the driver-borne case
        // needs booking here, or the two would stack
        if (ureaType === "DRIVER") push("UREA", ureaAmount, "Actual urea (auto)");
        push("MISC", roadBill, "Road bills");
        push("DRIVER_BATA", fooding, "Fooding");
        push("POLICE_RTO", rtoExp, "RTO expenses");
        push("MISC", roadExp, "Road expenses");
        push("MISC", otherOpExp, "Other operating expense");
      } else if (calcMethod === "DIESEL_AVG") {
        push("DIESEL", totalDieselCost, "Approved fuel cost (auto)");
        push("DRIVER_BATA", fooding, "Fooding (auto)");
        push("POLICE_RTO", rtoExp, "RTO / road (auto)");
        push("MISC", roadBill, "Road bill (auto)");
      } else {
        push("MISC", fixedExp, "Fixed trip expense (auto)");
      }
      if (!isActual) {
        push("MISC", apprAdvance, "Approved driver advance (auto)");
        if (tollType === "COMPANY") push("TOLL", exp.tollTotal, "Toll — company (auto)");
      }

      const res = await saveTrip({
        id: initial?.id ?? null,
        tripNo,
        tripDate: fromIso,
        returnDate: toIso,
        vehicleId,
        driverId,
        fromDate: fromIso,
        toDate: toIso,
        calcMethod,
        docs: selected.map((d) => ({ refType: d.refType, refId: d.refId })),
        // snapshot mode keeps the previously linked advances untouched
        advanceIds: liveMode
          ? driverId
            ? advances.rows.map((a) => a.id)
            : []
          : initial?.advanceIds ?? [],
        tollExpenseType: tollType,
        tollAmount: exp.tollTotal,
        actualDiesel: exp.dieselTotal,
        actualAdvance: advances.total,
        ureaQty: urea.totalQty,
        ureaRate,
        ureaExpenseType: ureaType,
        loadingKm,
        unloadingKm,
        newLoadingKm,
        dieselAvg,
        dieselAvg2,
        dieselRate,
        apprDriverAdvance: apprAdvance,
        roadBillExp: roadBill,
        foodingDays,
        foodingRate,
        rtoExp,
        fixedTripExp: fixedExp,
        roadExp,
        otherOpExp,
        // register-booked heads no longer join the ACTUAL sheet (they live in
        // the vehicle expense register as the company's own recorded cost)
        autoFetchedExp: 0,
        actualTotal,
        approvedTotal,
        grandTotal,
        // Income snapshot. The vehicle report reads the linked documents live so
        // a later edit to a chalan reflects without re-saving; this is kept for
        // legacy sheets and for the trip register's own column.
        gFreight: docGrandTotal,
        expenses,
      });
      if (res.ok) {
        toast({
          title: initial?.id ? "Trip sheet updated" : "Trip sheet saved",
          description: `Driver balance ${signed(driverBalance)} posted to the +/- register.`,
        });
        // register-first workflow: always return to the register after save
        router.push("/trips?tab=register");
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(false);
    }
  };

  const cell = "border px-1.5 py-1";

  return (
    <div className="space-y-4">
      {/* -------- step 1 -------- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">Step 1 — Trip Details</CardTitle>
          {initial?.id && (
            <div className="flex flex-wrap items-center gap-2">
              {!liveMode ? (
                <>
                  <Badge variant="secondary">Saved snapshot — frozen at final save</Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLiveMode(true);
                      toast({
                        title: "Fetching new data...",
                        description:
                          "Latest expenses, advances and urea are being loaded — save to keep the new version.",
                      });
                    }}
                  >
                    Fetch New Data
                  </Button>
                </>
              ) : (
                <Badge>Live data — save to freeze the new version</Badge>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-6">
          <Field label="Trip No">
            <Input value={tripNo} onChange={(e) => setTripNo(e.target.value)} />
          </Field>
          <Field label="Vehicle No *">
            <MasterCombobox
              options={vehicles}
              value={vehicleId}
              onChange={setVehicleId}
              placeholder="Select vehicle..."
            />
          </Field>
          <Field label="Driver Name">
            <MasterCombobox
              options={drivers}
              value={driverId}
              onChange={setDriverId}
              placeholder="Select driver..."
            />
          </Field>
          <Field label="From Date *">
            <DateInput value={fromText} onChange={setFromText} />
          </Field>
          <Field label="To Date">
            <DateInput value={toText} onChange={setToText} />
          </Field>
          <Field label="Calculation Method">
            <Select value={calcMethod} onValueChange={(v) => setCalcMethod(v as CalcMethod)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(CALC_METHODS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      {/* -------- step 2: pending docs -------- */}
      {vehicleId && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Step 2 — Pending Chalans / Broker Slips ({pendingDocs.length}) — selected grand total{" "}
              {formatMoney(docGrandTotal)}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                (freight {formatMoney(docFreight)})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {[
                    "",
                    "Type",
                    "Doc No",
                    "Date",
                    "Company / Broker",
                    "From",
                    "To",
                    "Actual Wt",
                    "Charge Wt",
                    "Freight Rate",
                    "Freight Amount",
                    "Grand Total",
                  ].map((h) => (
                    <th key={h} className={`${cell} bg-muted text-left font-semibold`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pendingDocs.map((d) => {
                  const key = `${d.refType}:${d.refId}`;
                  return (
                    <tr key={key}>
                      <td className={cell}>
                        <Checkbox
                          checked={selectedDocs.has(key)}
                          onCheckedChange={(c) =>
                            setSelectedDocs((prev) => {
                              const next = new Set(prev);
                              if (c) next.add(key);
                              else next.delete(key);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className={cell}>
                        <Badge variant={d.refType === "CHALAN" ? "secondary" : "outline"}>
                          {d.refType === "CHALAN" ? "Chalan" : "Broker Slip"}
                        </Badge>
                      </td>
                      <td className={cell}>{d.docNo}</td>
                      <td className={cell}>{formatDate(d.date)}</td>
                      <td className={cell}>{d.name}</td>
                      <td className={cell}>{d.from}</td>
                      <td className={cell}>{d.to}</td>
                      <td className={`${cell} text-right`}>{d.actualWt}</td>
                      <td className={`${cell} text-right`}>{d.chargeWt}</td>
                      <td className={`${cell} text-right`}>{d.rate}</td>
                      <td className={`${cell} text-right`}>{formatMoney(d.freight)}</td>
                      <td
                        className={`${cell} text-right font-semibold`}
                        title={`Freight ${formatMoney(d.freight)} + additions ${formatMoney(
                          d.additions
                        )} − deductions ${formatMoney(d.deductions)}`}
                      >
                        {formatMoney(d.grandTotal)}
                      </td>
                    </tr>
                  );
                })}
                {!pendingDocs.length && (
                  <tr>
                    {pendingError ? (
                      <td colSpan={12} className={`${cell} py-2 text-center text-destructive`}>
                        Pending list could not be loaded: {pendingError}
                      </td>
                    ) : (
                      <td colSpan={12} className={`${cell} py-2 text-center text-muted-foreground`}>
                        No pending chalans / broker slips for this vehicle in the date range.
                        Documents settled in earlier trip sheets never appear again.
                      </td>
                    )}
                  </tr>
                )}
              </tbody>
            </table>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Values are read live from the chalan / broker slip — edits there reflect here
              automatically.
            </p>
          </CardContent>
        </Card>
      )}

      {/* -------- step 3 (ACTUAL): actual vehicle operating expenses -------- */}
      {vehicleId && isActual && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">LEFT — Actual Vehicle Operating Expenses</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => openPopup("DIESEL")}
                >
                  Diesel (click for details)
                </button>
                <b className="tabular-nums">{formatMoney(exp.dieselTotal)}</b>
              </div>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => openPopup("ADVANCE")}
                >
                  Driver Advance (click for details)
                </button>
                <b className="tabular-nums">{formatMoney(advances.total)}</b>
              </div>
              <div className="flex items-center justify-between">
                <span>Toll</span>
                <b className="tabular-nums">{formatMoney(exp.tollTotal)}</b>
              </div>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => openPopup("UREA")}
                >
                  Urea ({urea.totalQty.toLocaleString("en-IN")} L ×
                </button>
                <div className="flex flex-wrap items-center gap-2">
                  <NumInput value={ureaRate} onChange={setUreaRate} className="h-7 w-20 text-xs" />
                  <b className="tabular-nums">{formatMoney(ureaAmount)}</b>
                </div>
              </div>
              <p className="border-t pt-2 text-[11px] text-muted-foreground">
                Above: fetched from the vehicle expense, driver advance and AdBlue
                registers. Below: operating expenses entered on this sheet. Toll and urea
                count in full here whatever their Driver / Company setting — that toggle
                decides who bears the cost in a driver settlement, which this method does
                not run.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Road Bills">
                  <NumInput value={roadBill} onChange={setRoadBill} className="h-8" />
                </Field>
                <Field label="RTO Expenses">
                  <NumInput value={rtoExp} onChange={setRtoExp} className="h-8" />
                </Field>
                <Field label="Fooding Days">
                  <NumInput value={foodingDays} onChange={setFoodingDays} className="h-8" />
                </Field>
                <Field label="Fooding Rate / Day">
                  <NumInput value={foodingRate} onChange={setFoodingRate} className="h-8" />
                </Field>
                <Field label="Fooding Total">
                  <Input value={formatMoney(fooding)} readOnly className="h-8 bg-muted text-right" />
                </Field>
                <Field label="Road Expenses">
                  <NumInput value={roadExp} onChange={setRoadExp} className="h-8" />
                </Field>
                <Field label="Any Other Operating Expense">
                  <NumInput value={otherOpExp} onChange={setOtherOpExp} className="h-8" />
                </Field>
              </div>
              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <span>Total Actual Operating Expenses</span>
                <span className="tabular-nums">{formatMoney(actualOperatingTotal)}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">RIGHT — Actual Income vs Actual Expenses</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span>Actual Income (Grand Total of selected documents)</span>
                <b className="tabular-nums">{formatMoney(docGrandTotal)}</b>
              </div>
              <div className="flex justify-between">
                <span>Actual Operating Expenses</span>
                <b className="tabular-nums">− {formatMoney(actualOperatingTotal)}</b>
              </div>
              <div className="flex items-center justify-between border-t pt-2 text-base font-semibold">
                <span>Trip Profit / Loss</span>
                <span
                  className={`tabular-nums ${
                    actualProfit >= 0 ? "text-emerald-600" : "text-destructive"
                  }`}
                >
                  {signed(actualProfit)}
                </span>
              </div>
              <p className="rounded-md border border-dashed p-2 text-[11px] text-muted-foreground">
                No driver settlement is calculated or posted under this method. Driver
                settlement, driver +/−, adjustment, recovery and salary settlement all stay
                out of it — the figures above are the vehicle&apos;s actual operating result
                only. Switch to Diesel Average or Fixed to settle the driver.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* -------- step 3: left / right -------- */}
      {vehicleId && !isActual && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* LEFT: actual driver expenses */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">LEFT — Actual Driver Expenses</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => openPopup("DIESEL")}>
                  Diesel (click for details)
                </button>
                <b className="tabular-nums">{formatMoney(exp.dieselTotal)}</b>
              </div>
              <div className="flex items-center justify-between">
                <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => openPopup("ADVANCE")}>
                  Driver Advance (click for details)
                </button>
                <b className="tabular-nums">{formatMoney(advances.total)}</b>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>Toll</span>
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={tollType} onValueChange={(v) => setTollType(v as "DRIVER" | "COMPANY")}>
                    <SelectTrigger className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DRIVER">Driver Expense</SelectItem>
                      <SelectItem value="COMPANY">Company Expense</SelectItem>
                    </SelectContent>
                  </Select>
                  <b className={`tabular-nums ${tollType === "COMPANY" ? "text-muted-foreground line-through" : ""}`}>
                    {formatMoney(exp.tollTotal)}
                  </b>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => openPopup("UREA")}>
                  Urea ({urea.totalQty.toLocaleString("en-IN")} L ×
                </button>
                <div className="flex flex-wrap items-center gap-2">
                  <NumInput value={ureaRate} onChange={setUreaRate} className="h-7 w-20 text-xs" />
                  <Select value={ureaType} onValueChange={(v) => setUreaType(v as "DRIVER" | "COMPANY")}>
                    <SelectTrigger className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DRIVER">Driver Expense</SelectItem>
                      <SelectItem value="COMPANY">Company Expense</SelectItem>
                    </SelectContent>
                  </Select>
                  <b className={`tabular-nums ${ureaType === "COMPANY" ? "text-muted-foreground line-through" : ""}`}>
                    {formatMoney(ureaAmount)}
                  </b>
                </div>
              </div>
              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <span>Total Actual Driver Expenses</span>
                <span className="tabular-nums">{formatMoney(driverActualTotal)}</span>
              </div>
            </CardContent>
          </Card>

          {/* RIGHT: company approved */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                RIGHT — Company Approved Expenses ({CALC_METHODS[calcMethod]})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {calcMethod === "DIESEL_AVG" ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="Loading KM (auto from prev trip)">
                      <NumInput value={loadingKm} onChange={onLoadingKmChange} className="h-8" />
                    </Field>
                    <Field label="Unloading KM"><NumInput value={unloadingKm} onChange={setUnloadingKm} className="h-8" /></Field>
                    <Field label="New Loading KM"><NumInput value={newLoadingKm} onChange={setNewLoadingKm} className="h-8" /></Field>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="Diesel Rate (per L)"><NumInput value={dieselRate} onChange={setDieselRate} className="h-8" /></Field>
                    <Field label="Diesel Average 1 (km/L)"><NumInput value={dieselAvg} onChange={setDieselAvg} className="h-8" /></Field>
                    <Field label="Diesel Average 2 (km/L)"><NumInput value={dieselAvg2} onChange={setDieselAvg2} className="h-8" /></Field>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div>
                      Trip Distance 1: <b>{dist1.toLocaleString("en-IN")} km</b> ÷ {dieselAvg || "—"} × {dieselRate} ={" "}
                      <b>Diesel Cost 1: {formatMoney(fuel1)}</b>
                    </div>
                    <div>
                      Trip Distance 2: <b>{dist2.toLocaleString("en-IN")} km</b> ÷ {dieselAvg2 || "—"} × {dieselRate} ={" "}
                      <b>Diesel Cost 2: {formatMoney(fuel2)}</b>
                    </div>
                    <div className="col-span-2">Total Diesel Cost: <b>{formatMoney(totalDieselCost)}</b></div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Driver Advance"><NumInput value={apprAdvance} onChange={setApprAdvance} className="h-8" /></Field>
                    <Field label="Road Bill Expenses"><NumInput value={roadBill} onChange={setRoadBill} className="h-8" /></Field>
                    <Field label="Fooding Days"><NumInput value={foodingDays} onChange={setFoodingDays} className="h-8" /></Field>
                    <Field label="Fooding Rate / Day"><NumInput value={foodingRate} onChange={setFoodingRate} className="h-8" /></Field>
                    <Field label="RTO / Road Expenses"><NumInput value={rtoExp} onChange={setRtoExp} className="h-8" /></Field>
                    <Field label="Fooding Total">
                      <Input value={formatMoney(fooding)} readOnly className="h-8 bg-muted text-right" />
                    </Field>
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Fixed Trip Expense"><NumInput value={fixedExp} onChange={setFixedExp} className="h-8" /></Field>
                  <Field label="Driver Advance"><NumInput value={apprAdvance} onChange={setApprAdvance} className="h-8" /></Field>
                </div>
              )}
              {(tollType === "COMPANY" || ureaType === "COMPANY") && (
                <div className="text-xs text-muted-foreground">
                  Company items added to Vehicle Cost:{" "}
                  {tollType === "COMPANY" ? `Toll ${formatMoney(exp.tollTotal)} ` : ""}
                  {ureaType === "COMPANY" ? `Urea ${formatMoney(ureaAmount)}` : ""}
                </div>
              )}
              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <span>Total Approved Expenses</span>
                <span className="tabular-nums">{formatMoney(approvedTotal)}</span>
              </div>
              <div className="flex justify-between text-sm font-medium text-muted-foreground">
                <span>Grand Total (Company Vehicle Cost — accounting only)</span>
                <span className="tabular-nums">{formatMoney(grandTotal)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* -------- driver settlement — never shown for the ACTUAL method -------- */}
      {vehicleId && !isActual && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Driver Settlement (Approved vs Actual — Grand Total is never used)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-md border p-2">
                <div className="text-[11px] text-muted-foreground">Approved − Actual</div>
                <div className="font-semibold tabular-nums">
                  {formatMoney(approvedTotal)} − {formatMoney(driverActualTotal)}
                </div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-[11px] text-muted-foreground">Current Trip Balance</div>
                <div className={`text-lg font-bold tabular-nums ${driverBalance >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                  {signed(driverBalance)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {driverBalance > 0
                    ? "Company owes the driver (driver saved)"
                    : driverBalance < 0
                      ? "Driver owes the company (overspent)"
                      : "Settled even"}
                </div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-[11px] text-muted-foreground">Previous Driver Balance</div>
                <div className="text-lg font-bold tabular-nums">{signed(settleInfo.previousBalance)}</div>
                <div className="text-[11px] text-muted-foreground">
                  Pending only — settled amounts never carry forward
                </div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-[11px] text-muted-foreground">Final Running Balance</div>
                <div className={`text-lg font-bold tabular-nums ${finalRunning >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                  {signed(finalRunning)}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {settleInfo.current &&
                settleInfo.current.status === "PENDING" &&
                (settleInfo.previousBalance + settleInfo.current.amount !== 0 ? (
                  <Button
                    size="sm"
                    variant={
                      settleInfo.previousBalance + settleInfo.current.amount > 0
                        ? "default"
                        : "destructive"
                    }
                    onClick={() => {
                      setSettleBank(null);
                      setSettleOpen(true);
                    }}
                  >
                    {settleInfo.previousBalance + settleInfo.current.amount > 0
                      ? `Pay Driver ${formatMoney(Math.abs(settleInfo.previousBalance + settleInfo.current.amount))} (running balance)`
                      : `Receive from Driver ${formatMoney(Math.abs(settleInfo.previousBalance + settleInfo.current.amount))} (running balance)`}
                  </Button>
                ) : null)}
              {settleInfo.current && settleInfo.current.status === "SETTLED" && (
                <Badge>Settled — voucher {settleInfo.current.voucherNo}</Badge>
              )}
              <Button size="sm" variant="outline" asChild>
                <a href="/vehicle/driver-settlements" target="_blank" rel="noreferrer">
                  Adjust Previous Balance (open +/- Register)
                </a>
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Save the trip first — the balance posts to the Driver +/- Register (reference: trip
              no). Pay / Receive creates the Payment / Receipt Voucher automatically; unsettled
              balances carry forward to the next trip sheet by reference.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {readOnly && (
          <span className="text-xs font-medium text-muted-foreground">
            View only — nothing on this screen will be saved. Use Edit from the register to
            change the sheet.
          </span>
        )}
        <Button variant="outline" onClick={() => router.push("/trips?tab=register")} disabled={busy}>
          {readOnly ? "Close" : "Cancel"}
        </Button>
        {!readOnly && (
          <Button onClick={submit} disabled={busy || !vehicleId}>
            {busy ? "Saving..." : initial?.id ? "Update Trip Sheet" : "Save Trip Sheet"}
          </Button>
        )}
      </div>

      {/* -------- popups -------- */}
      <Dialog open={popup !== null} onOpenChange={(o) => !o && setPopup(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {popup === "DIESEL"
                ? `Diesel — ${formatMoney(exp.dieselTotal)}`
                : popup === "ADVANCE"
                  ? `Driver Advance — ${formatMoney(advances.total)}`
                  : `Urea — ${urea.totalQty.toLocaleString("en-IN")} L × ${ureaRate} = ${formatMoney(ureaAmount)}`}
            </DialogTitle>
            <DialogDescription>Fetched live from the source module.</DialogDescription>
          </DialogHeader>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {(popup === "DIESEL"
                  ? ["Date", "Supplier", "Voucher No", "Amount", "Remarks"]
                  : popup === "ADVANCE"
                    ? ["Date", "Mode", "Voucher Ref", "Amount", "Remarks"]
                    : ["Date", "Destination", "Litres", "Remarks"]
                ).map((h) => (
                  <th key={h} className={`${cell} bg-muted text-left font-semibold`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {popup === "DIESEL" &&
                exp.rows
                  .filter((r) => r.head.toLowerCase().includes("diesel"))
                  .map((r, i) => (
                    <tr key={i}>
                      <td className={cell}>{formatDate(r.date)}</td>
                      <td className={cell}>{r.supplier}</td>
                      <td className={cell}>{r.voucherNo}</td>
                      <td className={`${cell} text-right`}>{formatMoney(r.amount)}</td>
                      <td className={cell}>{r.remarks}</td>
                    </tr>
                  ))}
              {popup === "ADVANCE" &&
                advances.rows.map((r) => (
                  <tr key={r.id}>
                    <td className={cell}>{formatDate(r.date)}</td>
                    <td className={cell}>{r.paymentMode}</td>
                    <td className={cell}>{r.voucherRef}</td>
                    <td className={`${cell} text-right`}>{formatMoney(r.amount)}</td>
                    <td className={cell}>{r.remarks}</td>
                  </tr>
                ))}
              {popup === "UREA" &&
                urea.rows.map((r) => (
                  <tr key={r.id}>
                    <td className={cell}>{formatDate(r.date)}</td>
                    <td className={cell}>{r.destination}</td>
                    <td className={`${cell} text-right`}>{r.qty.toLocaleString("en-IN")}</td>
                    <td className={cell}>{r.remarks}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </DialogContent>
      </Dialog>

      {/* -------- settle current trip balance -------- */}
      <Dialog open={settleOpen} onOpenChange={setSettleOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {settleInfo.previousBalance + (settleInfo.current?.amount ?? 0) > 0
                ? "Pay Driver"
                : "Receive from Driver"}{" "}
              {formatMoney(Math.abs(settleInfo.previousBalance + (settleInfo.current?.amount ?? 0)))}{" "}
              — full running balance
            </DialogTitle>
            <DialogDescription>
              Settles the driver&apos;s entire outstanding running balance (all pending entries) —
              one {settleInfo.previousBalance + (settleInfo.current?.amount ?? 0) > 0 ? "Payment" : "Receipt"}{" "}
              Voucher is created automatically, referenced by the settled trip numbers.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Mode">
              <Select value={settleMode} onValueChange={(v) => { setSettleMode(v as "CASH" | "BANK"); setSettleBank(null); }}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="BANK">Bank</SelectItem>
                  <SelectItem value="CARD">Card</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Cash / Bank Account *">
              <MasterCombobox
                options={bankOptions.filter((b) => b.meta === settleMode)}
                value={settleBank}
                onChange={setSettleBank}
                placeholder="Select account..."
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettleOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              disabled={busy || !settleBank}
              onClick={async () => {
                if (!driverId) return;
                setBusy(true);
                try {
                  const res = await settleDriverRunningBalance({
                    driverId,
                    date: fromIso || new Date().toISOString().slice(0, 10),
                    paymentMode: settleMode,
                    bankPartyId: settleBank ?? "",
                    remarks: `Settled from trip sheet ${tripNo}`,
                  });
                  if (res.ok) {
                    toast({ title: `Settled — voucher ${res.voucherNo} created` });
                    setSettleOpen(false);
                    reloadSettleInfo();
                  } else toast({ variant: "destructive", title: "Failed", description: res.error });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Processing..." : "Confirm & Create Voucher"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
