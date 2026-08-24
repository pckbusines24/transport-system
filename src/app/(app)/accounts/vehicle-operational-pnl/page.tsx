import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatMoney, toNum } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport, type ReportRow } from "@/components/accounts/simple-report";

export const dynamic = "force-dynamic";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Vehicle Operational Profit & Loss — the company's OWN fleet only.
 *
 * Income: FleetOps chalans and broker-slip OWNER side, both restricted to
 * vehicles with ownershipType OWNER, at the operational grand total:
 * freight + detention + ODC + fine slip + other − LD − commission − mamool
 * − courier / payment charge. Relative and broker vehicles never appear.
 *
 * Expenses come from the SOURCE DOCUMENTS, not ledger-head nets (a shared
 * head like Shortage would drag the whole firm's balance in):
 *  - Vehicle expenses: each bill's own-vehicle allocation share
 *    (VehicleExpenseItem, on its allocation date), split per head.
 *  - Driver salary BOOKED (gross) for drivers assigned to own vehicles,
 *    less the advances adjusted inside those salaries (the advance cash is
 *    already counted below — the same rupee must not count twice).
 *  - Driver advances paid (own-vehicle drivers).
 *  - Driver settlements on ACCRUAL: every +/- row counts on its OWN (trip)
 *    date — company-owes-driver as expense, driver-owes-company as a minus —
 *    whether or not it is paid yet. Settling later moves no P&L figure: the
 *    row's recorded amount never changes, only its status does. This matches
 *    the income side, which also accrues when the chalan is made. (F&F
 *    carry-forward rows are excluded — they duplicate the original rows'
 *    unrecovered remainder.)
 *  - Urea from the trip settlements of own vehicles (both driver- and
 *    company-borne: driver-borne urea already reduced the settlement paid,
 *    so adding it here completes the trip's true cost).
 *  - Full EMI of VEHICLE-type loans on own vehicles, on payment date.
 */
export default async function VehicleOperationalPnlPage({
  searchParams,
}: {
  searchParams: { date_from?: string; date_to?: string };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const dateWhere =
    searchParams.date_from || searchParams.date_to
      ? {
          ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        }
      : undefined;
  // salary months are "YYYY-MM" strings — the date range maps to month bounds
  const monthWhere =
    searchParams.date_from || searchParams.date_to
      ? {
          ...(searchParams.date_from ? { gte: searchParams.date_from.slice(0, 7) } : {}),
          ...(searchParams.date_to ? { lte: searchParams.date_to.slice(0, 7) } : {}),
        }
      : undefined;

  const data = await withTenant(session.tenantId, async (tx) => {
    // Period rule (FY continuity): everything is DATE-scoped. No explicit
    // range → the session FY's own dates. Income is attributed to the LR's
    // date — an old-year LR chalan/billed in the new year still lands in the
    // OLD year's P&L, never the new one's.
    const sessionFy = await tx.financialYear.findUniqueOrThrow({ where: { id: session.fyId } });
    const period = dateWhere ?? { gte: sessionFy.startDate, lte: sessionFy.endDate };
    // LOCAL year-month — toISOString on an IST-stamped 1 April rolls back to
    // "…-03" and double-counts March salaries across both FYs
    const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const monthPeriod =
      monthWhere ?? { gte: ym(sessionFy.startDate), lte: ym(sessionFy.endDate) };
    const scope = { firmId: session.firmId };
    const ownIds = (
      await tx.vehicle.findMany({ where: { ownershipType: "OWNER" }, select: { id: true } })
    ).map((v) => v.id);

    const [chalanRows, slips, heads, expenseItems, salaries, advances, settlements, assignments, trips, emis] =
      await Promise.all([
        // fetched wide, attributed by the EARLIEST linked LR's date (fallback:
        // chalan date) and summed below — the LR decides which year earns it
        tx.chalan.findMany({
          where: {
            ...scope,
            deletedAt: null,
            cancelledAt: null,
            vehicleId: { in: ownIds },
          },
          select: {
            chalanDate: true,
            freight: true,
            detention: true,
            odcAmt: true,
            fineSlip: true,
            otherAmt: true,
            ldCharge: true,
            commissionAmt: true,
            mamool: true,
            courierCharge: true,
            lrs: { select: { lr: { select: { lrDate: true } } } },
          },
        }),
        tx.brokerSlip.aggregate({
          where: {
            ...scope,
            deletedAt: null,
            vehicleId: { in: ownIds },
            slipDate: period,
          },
          _sum: {
            vFreight: true,
            vDetention: true,
            vOdcAmt: true,
            vFineAmt: true,
            vLdCharge: true,
            vCommAmt: true,
            vMamool: true,
            vPaymentAmt: true,
          },
        }),
        tx.accountHead.findMany({ select: { id: true, name: true } }),
        // each expense bill's OWN-vehicle share, on the allocation date —
        // relative/broker shares live on other vehicles' items and never enter
        tx.vehicleExpenseItem.findMany({
          where: {
            vehicleId: { in: ownIds },
            allocDate: period,
            voucher: { ...scope, deletedAt: null, txnType: "EXPENSE" },
          },
          include: { voucher: { include: { lines: true } } },
        }),
        // BOOKED salary months (own-vehicle drivers filtered below)
        tx.driverSalary.findMany({
          where: {
            ...scope,
            deletedAt: null,
            month: monthPeriod,
          },
        }),
        tx.driverAdvance.findMany({
          where: {
            ...scope,
            deletedAt: null,
            date: period,
          },
          select: { driverId: true, vehicleId: true, date: true, amount: true },
        }),
        // ACCRUAL: every live +/- row on its own date — pending or settled
        tx.driverSettlement.findMany({
          where: {
            ...scope,
            deletedAt: null,
            date: period,
          },
          select: {
            id: true,
            driverId: true,
            vehicleId: true,
            date: true,
            amount: true,
            remarks: true,
          },
        }),
        tx.driverAssignment.findMany(),
        // trip-sheet costs on own vehicles: urea (all methods) + the ACTUAL
        // sheet's manual operating expenses (road bill / RTO / fooding /
        // road / other) — those five exist only on the sheet, no register
        // bill or driver settlement ever carries them
        tx.trip.findMany({
          where: {
            ...scope,
            deletedAt: null,
            vehicleId: { in: ownIds },
            tripDate: period,
            OR: [{ ureaAmount: { gt: 0 } }, { calcMethod: "ACTUAL" }],
          },
          select: {
            ureaAmount: true,
            calcMethod: true,
            roadBillExp: true,
            foodingDays: true,
            foodingRate: true,
            rtoExp: true,
            roadExp: true,
            otherOpExp: true,
          },
        }),
        // full EMI of vehicle loans on own vehicles, on payment date — the
        // loan is long-lived, so no FY filter on it: an instalment paid this
        // period counts even when the loan was taken in an earlier FY
        tx.loanEmi.findMany({
          where: {
            deletedAt: null,
            payDate: period,
            loan: {
              firmId: session.firmId,
              deletedAt: null,
              loanType: "VEHICLE",
              vehicleId: { in: ownIds },
            },
          },
          select: { total: true },
        }),
      ]);

    // income attribution by LR date: the earliest linked LR decides which
    // period (year) earns the chalan — a March LR chalaned/billed in April
    // stays March's income
    const inPeriod = (d: Date) =>
      (!period.gte || d >= period.gte) && (!period.lte || d <= period.lte);
    const chalanSum = {
      freight: 0,
      detention: 0,
      odcAmt: 0,
      fineSlip: 0,
      otherAmt: 0,
      ldCharge: 0,
      commissionAmt: 0,
      mamool: 0,
      courierCharge: 0,
    };
    for (const c of chalanRows) {
      const lrTimes = c.lrs.map((l) => l.lr.lrDate.getTime());
      const eff = lrTimes.length ? new Date(Math.min(...lrTimes)) : c.chalanDate;
      if (!inPeriod(eff)) continue;
      chalanSum.freight += toNum(String(c.freight));
      chalanSum.detention += toNum(String(c.detention));
      chalanSum.odcAmt += toNum(String(c.odcAmt));
      chalanSum.fineSlip += toNum(String(c.fineSlip));
      chalanSum.otherAmt += toNum(String(c.otherAmt));
      chalanSum.ldCharge += toNum(String(c.ldCharge));
      chalanSum.commissionAmt += toNum(String(c.commissionAmt));
      chalanSum.mamool += toNum(String(c.mamool));
      chalanSum.courierCharge += toNum(String(c.courierCharge));
    }
    const chalans = { _sum: chalanSum };

    return {
      ownIds,
      ownCount: ownIds.length,
      chalans,
      slips,
      heads,
      expenseItems,
      salaries,
      advances,
      settlements,
      assignments,
      trips,
      emis,
    };
  });

  const {
    ownIds,
    ownCount,
    chalans,
    slips,
    heads,
    expenseItems,
    salaries,
    advances,
    settlements,
    assignments,
    trips,
    emis,
  } = data;
  const n = (v: unknown) => r2(toNum(String(v ?? 0)));

  // ---- FleetOps income (own vehicles) ----
  const c = chalans._sum;
  const fleet = {
    freight: n(c.freight),
    detention: n(c.detention),
    odc: n(c.odcAmt),
    fine: n(c.fineSlip),
    other: n(c.otherAmt),
    ld: n(c.ldCharge),
    commission: n(c.commissionAmt),
    mamool: n(c.mamool),
    courier: n(c.courierCharge),
  };
  const fleetTotal = r2(
    fleet.freight + fleet.detention + fleet.odc + fleet.fine + fleet.other -
      fleet.ld - fleet.commission - fleet.mamool - fleet.courier
  );

  // ---- broker slip owner side (own vehicles) ----
  const s = slips._sum;
  const slip = {
    freight: n(s.vFreight),
    detention: n(s.vDetention),
    odc: n(s.vOdcAmt),
    fine: n(s.vFineAmt),
    ld: n(s.vLdCharge),
    commission: n(s.vCommAmt),
    mamool: n(s.vMamool),
    payment: n(s.vPaymentAmt),
  };
  const slipTotal = r2(
    slip.freight + slip.detention + slip.odc + slip.fine -
      slip.ld - slip.commission - slip.mamool - slip.payment
  );

  const totalVehicleIncome = r2(fleetTotal + slipTotal);

  // ---- vehicle expenses: own-vehicle bill shares, split per head ----
  // a multi-head bill's share splits across its lines in proportion, exactly
  // like Vehicle 360 — so both screens always tell the same story
  const headName = new Map(heads.map((h) => [h.id, h.name]));
  const perHead = new Map<string, number>();
  for (const item of expenseItems) {
    const share = toNum(String(item.amount));
    if (share <= 0.009) continue;
    const v = item.voucher;
    const vTotal = toNum(String(v.amount));
    const parts =
      v.lines.length && vTotal > 0
        ? v.lines.map((l, idx) => ({
            headId: l.headId,
            amount:
              idx === v.lines.length - 1
                ? r2(
                    share -
                      v.lines
                        .slice(0, -1)
                        .reduce((sum, x) => sum + r2((share * toNum(String(x.amount))) / vTotal), 0)
                  )
                : r2((share * toNum(String(l.amount))) / vTotal),
          }))
        : [{ headId: v.headId, amount: share }];
    for (const p of parts) {
      if (p.amount <= 0.009) continue;
      perHead.set(p.headId, r2((perHead.get(p.headId) ?? 0) + p.amount));
    }
  }
  const headRows: ReportRow[] = Array.from(perHead.entries())
    .map(([headId, amount]) => ({
      head: headName.get(headId) ?? "(unknown head)",
      amount,
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));
  const vehicleExpTotal = r2(headRows.reduce((sum, rw) => sum + Number(rw.amount), 0));

  // ---- company-driver rule: the vehicle on the transaction — or the
  // driver's assignment on that date — is OWN
  const ownSet = new Set(ownIds);
  const vehicleAt = (driverId: string, at: Date): string | null => {
    const a = assignments.find(
      (x) => x.driverId === driverId && x.fromDate <= at && (!x.toDate || x.toDate >= at)
    );
    return a?.vehicleId ?? null;
  };
  const isCompanyDriverTxn = (t: { driverId: string; vehicleId: string | null; at: Date }) =>
    t.vehicleId ? ownSet.has(t.vehicleId) : ownSet.has(vehicleAt(t.driverId, t.at) ?? "");

  // ---- driver salary BOOKED (gross) for own-vehicle drivers ----
  const ownSalaries = salaries.filter((sal) =>
    isCompanyDriverTxn({
      driverId: sal.driverId,
      vehicleId: null,
      // the assignment in the middle of the salary month decides ownership
      at: new Date(`${sal.month}-15T00:00:00`),
    })
  );
  const salaryBooked = r2(
    ownSalaries.reduce(
      (sum, sal) =>
        sum +
        toNum(String(sal.salaryAmount)) +
        toNum(String(sal.incentive)) +
        toNum(String(sal.bonus)) +
        toNum(String(sal.otherAllowance)),
      0
    )
  );
  // advances adjusted INSIDE those salaries — the advance cash is counted in
  // the advances line below, so the overlap nets out here (never twice)
  const advAdjustedInSalary = r2(
    ownSalaries.reduce((sum, sal) => sum + toNum(String(sal.advanceAdjust)), 0)
  );

  // ---- driver advances paid (own-vehicle drivers) ----
  const advancePaid = r2(
    advances
      .filter((a) => isCompanyDriverTxn({ driverId: a.driverId, vehicleId: a.vehicleId, at: a.date }))
      .reduce((sum, a) => sum + toNum(String(a.amount)), 0)
  );

  // ---- driver settlements on ACCRUAL: every row on its own date ----
  // company-owes-driver (+) is an expense the moment the trip books it;
  // driver-owes-company (−) reduces the expense the same way. Paying later
  // moves nothing here — the recorded amount never changes, only the status.
  // F&F "balance carried forward" rows are duplicates of the original rows'
  // unrecovered remainder and must not count twice.
  let settlementPayable = 0;
  let settlementReceivable = 0;
  for (const st of settlements) {
    if (st.remarks?.startsWith("Balance carried forward after final settlement")) continue;
    if (!isCompanyDriverTxn({ driverId: st.driverId, vehicleId: st.vehicleId, at: st.date })) continue;
    const amt = toNum(String(st.amount));
    if (Math.abs(amt) <= 0.009) continue;
    if (amt > 0) settlementPayable = r2(settlementPayable + amt);
    else settlementReceivable = r2(settlementReceivable + Math.abs(amt));
  }
  const driverTotal = r2(
    salaryBooked - advAdjustedInSalary + advancePaid + settlementPayable - settlementReceivable
  );

  // ---- urea from own-vehicle trip settlements ----
  const ureaTrips = trips.filter((t) => toNum(String(t.ureaAmount)) > 0);
  const ureaTotal = r2(ureaTrips.reduce((sum, t) => sum + toNum(String(t.ureaAmount)), 0));

  // ---- ACTUAL trip sheets: the five manual operating expenses ----
  const actualTrips = trips.filter((t) => t.calcMethod === "ACTUAL");
  const sumOf = (pick: (t: (typeof trips)[number]) => number) =>
    r2(actualTrips.reduce((s, t) => s + pick(t), 0));
  const tripOpex = {
    roadBill: sumOf((t) => toNum(String(t.roadBillExp))),
    rto: sumOf((t) => toNum(String(t.rtoExp))),
    fooding: sumOf((t) => toNum(String(t.foodingDays)) * toNum(String(t.foodingRate))),
    road: sumOf((t) => toNum(String(t.roadExp))),
    other: sumOf((t) => toNum(String(t.otherOpExp))),
  };
  const tripOpexTotal = r2(
    tripOpex.roadBill + tripOpex.rto + tripOpex.fooding + tripOpex.road + tripOpex.other
  );

  // ---- vehicle loan EMIs (full instalment) ----
  const loanExpense = r2(emis.reduce((sum, e) => sum + toNum(String(e.total)), 0));

  const totalExpenses = r2(
    vehicleExpTotal + driverTotal + ureaTotal + tripOpexTotal + loanExpense
  );
  const profit = r2(totalVehicleIncome - totalExpenses);

  const filters: FilterDef[] = [{ type: "daterange", key: "date", label: "Period" }];
  const money = (v: number) => formatMoney(v);
  const line = (label: string, value: number, opts?: { strong?: boolean; less?: boolean }) => (
    <div
      key={label}
      className={`flex justify-between py-0.5 ${opts?.strong ? "border-t pt-1 font-semibold" : ""}`}
    >
      <span>{label}</span>
      <span className="tabular-nums">
        {opts?.less ? "− " : ""}
        {money(Math.abs(value))}
      </span>
    </div>
  );

  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title flex items-center gap-2">
        Vehicle Operational Profit &amp; Loss
        <InfoHint>
          Own vehicles only ({ownCount} in the fleet) — relative and broker vehicles are fully
          excluded. Income is the operational grand total of FleetOps chalans and broker-slip
          owner side. Expenses come from the source documents: own-vehicle bill allocations,
          booked driver salary (own-vehicle drivers, net of salary-adjusted advances), driver
          advances, driver settlements on ACCRUAL (every +/- balance counts on its trip date,
          paid or not — paying later changes nothing here), urea from own-vehicle trip
          settlements, the ACTUAL-method trip sheet&apos;s manual operating expenses (road
          bill / RTO / fooding / road / other), and full vehicle-loan EMIs.
        </InfoHint>
      </h1>
      <FilterBar filters={filters} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">Total Vehicle Income</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {money(totalVehicleIncome)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">Total Vehicle Expenses</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {money(totalExpenses)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">
              Vehicle Operational Profit / Loss
            </CardTitle>
          </CardHeader>
          <CardContent
            className={`text-2xl font-bold tabular-nums ${profit >= 0 ? "text-emerald-600" : "text-destructive"}`}
          >
            {money(profit)}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 text-sm lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Income (Own Vehicles)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                FleetOps (Chalans)
              </div>
              {line("Freight", fleet.freight)}
              {line("Detention", fleet.detention)}
              {line("ODC Amount", fleet.odc)}
              {line("Fine Slip", fleet.fine)}
              {line("Other Amount", fleet.other)}
              {line("Less: LD Charge", fleet.ld, { less: true })}
              {line("Less: Commission", fleet.commission, { less: true })}
              {line("Less: Mamool", fleet.mamool, { less: true })}
              {line("Less: Courier Charge", fleet.courier, { less: true })}
              {line("Grand Total Freight (FleetOps)", fleetTotal, { strong: true })}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Broker Slip (Owner Side)
              </div>
              {line("Freight", slip.freight)}
              {line("Detention", slip.detention)}
              {line("ODC Amount", slip.odc)}
              {line("Fine Slip", slip.fine)}
              {line("Less: LD Charge", slip.ld, { less: true })}
              {line("Less: Commission", slip.commission, { less: true })}
              {line("Less: Mamool", slip.mamool, { less: true })}
              {line("Less: Payment Charge", slip.payment, { less: true })}
              {line("Grand Total Freight (Broker Owner Side)", slipTotal, { strong: true })}
            </div>
            <div>{line("Total Vehicle Income", totalVehicleIncome, { strong: true })}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Expenses (Own Vehicles)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Vehicle Expenses (bill allocations)
              </div>
              {headRows.slice(0, 12).map((rw) => line(String(rw.head), Number(rw.amount)))}
              {headRows.length > 12 && (
                <div className="py-0.5 text-xs text-muted-foreground">
                  +{headRows.length - 12} more heads — full list in the table below
                </div>
              )}
              {line("Total Vehicle Expenses", vehicleExpTotal, { strong: true })}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Driver Management ({ownSalaries.length} salary month{ownSalaries.length === 1 ? "" : "s"})
              </div>
              {line("Driver Salary (booked, gross)", salaryBooked)}
              {line("Less: Advance adjusted in salary", advAdjustedInSalary, { less: true })}
              {line("Driver Advances Paid", advancePaid)}
              {line("Driver Settlements (company owes driver, booked)", settlementPayable)}
              {line("Less: Settlements (driver owes company, booked)", settlementReceivable, { less: true })}
              {line("Total Driver Expenses", driverTotal, { strong: true })}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Urea (Trip Settlements)
              </div>
              {line(`Urea on own-vehicle trips (${ureaTrips.length} trips)`, ureaTotal)}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Trip Sheet Expenses — Actual method ({actualTrips.length} trip
                {actualTrips.length === 1 ? "" : "s"})
              </div>
              {line("Road Bills", tripOpex.roadBill)}
              {line("RTO Expenses", tripOpex.rto)}
              {line("Fooding", tripOpex.fooding)}
              {line("Road Expenses", tripOpex.road)}
              {line("Any Other Operating Expense", tripOpex.other)}
              {line("Total Trip Sheet Expenses", tripOpexTotal, { strong: true })}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Vehicle Loan Expenses
              </div>
              {line(`Vehicle Loan EMIs (${emis.length} instalments, full EMI)`, loanExpense)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent className="max-w-md text-sm">
          {line("FleetOps Grand Total Freight", fleetTotal)}
          {line("Broker Owner Side Grand Total Freight", slipTotal)}
          {line("Vehicle Expenses (bill allocations)", vehicleExpTotal, { less: true })}
          {line("Driver Expenses (salary + advances + settlements)", driverTotal, { less: true })}
          {line("Urea (trip settlements)", ureaTotal, { less: true })}
          {line("Trip Sheet Expenses (Actual method)", tripOpexTotal, { less: true })}
          {line("Vehicle Loan EMIs", loanExpense, { less: true })}
          <div
            className={`mt-1 flex justify-between border-t pt-1 text-base font-bold ${profit >= 0 ? "text-emerald-600" : "text-destructive"}`}
          >
            <span>Vehicle Operational Profit / Loss</span>
            <span className="tabular-nums">{money(profit)}</span>
          </div>
        </CardContent>
      </Card>

      <SimpleReport
        title="Vehicle expense heads (own-vehicle bill allocations)"
        columns={[
          { key: "head", header: "Ledger Head" },
          { key: "amount", header: "Own-Vehicle Share", kind: "money" },
        ]}
        rows={headRows}
        fileName="vehicle-operational-pnl-heads"
        emptyMessage="No own-vehicle expense allocations in this period."
      />
    </div>
  );
}
