import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { ALL_PAYABLE_REF_TYPES, refPositions, settledByRef } from "@/lib/settlement";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport } from "@/components/accounts/simple-report";

export const dynamic = "force-dynamic";

/**
 * Outstanding Payables — centralized register of everything the firm still has
 * to pay: chalan freight (vehicle owner / broker), broker slip owner side, and
 * unpaid staff salaries. Payment-voucher allocations against a document count
 * as paid/adjusted, as do settlement round-off and shortage write-offs.
 *
 * FREIGHT payables (chalan / broker slip) appear only for MARKET/BROKER
 * vehicles. A company-owned vehicle has no payee, and a relative vehicle's
 * position (freight, diesel, EMI, salary, shortage...) is managed through the
 * relative owner's ledger and settlement — showing either here would invite a
 * second, wrong payment path. Display-only rule: accounting, ledgers and
 * settlements are untouched. Supplier-style bills (office, vehicle expense,
 * AdBlue, salary) are unaffected.
 */
export async function OutstandingPayableTab({
  searchParams,
}: {
  searchParams: {
    date_from?: string;
    date_to?: string;
    party?: string;
    source?: string;
    show_closed?: string;
  };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const showClosed = searchParams.show_closed === "1";
  const source = searchParams.source; // CHALAN | BROKER_SLIP | SALARY | undefined

  const dateWhere =
    searchParams.date_from || searchParams.date_to
      ? {
          ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        }
      : undefined;

  const { rows, parties } = await withTenant(session.tenantId, async (tx) => {
    // no forward leak (FY continuity works one way only): old unpaid documents
    // keep counting, but a document dated in a LATER year must not appear
    // while standing in an earlier one — bound everything to this FY's end
    // unless the user's own date filter already set an upper edge
    const sessionFy = await tx.financialYear.findUnique({ where: { id: session.fyId } });
    const effDate = {
      ...(dateWhere ?? {}),
      ...(dateWhere?.lte || !sessionFy ? {} : { lte: sessionFy.endDate }),
    };
    const effMonthLte =
      searchParams.date_to?.slice(0, 7) ??
      (sessionFy
        ? `${sessionFy.endDate.getFullYear()}-${String(sessionFy.endDate.getMonth() + 1).padStart(2, "0")}`
        : undefined);
    // freight on OWNER (company) and RELATIVE vehicles never belongs in this
    // register — those settle through their own workflows; only market/broker
    // vehicle freight is a standard payable
    const ownRelativeIds = (
      await tx.vehicle.findMany({
        where: { ownershipType: { in: ["OWNER", "RELATIVE"] } },
        select: { id: true },
      })
    ).map((v) => v.id);
    const brokerVehicleOnly = ownRelativeIds.length
      ? { vehicleId: { notIn: ownRelativeIds } }
      : {};

    const chalanWhere: Prisma.ChalanWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
      // cancelled chalans owe nothing
      cancelledAt: null,
      ...brokerVehicleOnly,
    };
    if (searchParams.party) chalanWhere.brokerId = searchParams.party;
    chalanWhere.chalanDate = effDate;

    const slipWhere: Prisma.BrokerSlipWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
      ownerId: searchParams.party ? searchParams.party : { not: null },
      ...brokerVehicleOnly,
    };
    slipWhere.slipDate = effDate;

    const salaryWhere: Prisma.StaffSalaryWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
    };
    if (searchParams.party) salaryWhere.partyId = searchParams.party;
    // month is "YYYY-MM" — string bounds honour the register's date filter,
    // which every other source already applies
    salaryWhere.month = {
      ...(searchParams.date_from ? { gte: searchParams.date_from.slice(0, 7) } : {}),
      ...(effMonthLte ? { lte: effMonthLte } : {}),
    };

    // hire slips are payable to the (text-named) vehicle owner — the dashboard
    // tile counts them, so this register must too; they carry no party link,
    // so a party filter simply excludes them
    const hireWhere: Prisma.HireSlipWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
    };
    hireWhere.slipDate = effDate;

    const officeWhere: Prisma.OfficeTransactionWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
      txnType: "EXPENSE",
      // only entries left on credit are payable — one with a payment mode was
      // settled in cash or bank at entry
      paymentMode: null,
      partyId: searchParams.party ? searchParams.party : { not: null },
    };
    officeWhere.date = effDate;

    // a vehicle expense bill behaves exactly like an office bill: payable only
    // while it is on credit
    const vehicleWhere: Prisma.VehicleExpenseVoucherWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
      txnType: "EXPENSE",
      paymentMode: null,
      partyId: searchParams.party ? searchParams.party : { not: null },
    };
    vehicleWhere.date = effDate;

    // a billed urea refill left on credit; stock still awaiting its invoice owes
    // nothing yet and never appears here
    const adblueWhere: Prisma.AdblueTxnWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
      type: "REFILL",
      billNo: { not: null },
      paymentMode: null,
      supplierId: searchParams.party ? searchParams.party : { not: null },
    };
    adblueWhere.date = effDate;

    const [chalans, slips, salaries, office, vehicle, adblue, hires, parties, paidByRef] =
      await Promise.all([
      source && source !== "CHALAN"
        ? Promise.resolve([])
        : tx.chalan.findMany({ where: chalanWhere, orderBy: { chalanDate: "asc" } }),
      source && source !== "BROKER_SLIP"
        ? Promise.resolve([])
        : tx.brokerSlip.findMany({ where: slipWhere, orderBy: { slipDate: "asc" } }),
      source && source !== "SALARY"
        ? Promise.resolve([])
        : tx.staffSalary.findMany({ where: salaryWhere, orderBy: { month: "asc" } }),
      source && source !== "OFFICE_EXPENSE"
        ? Promise.resolve([])
        : tx.officeTransaction.findMany({ where: officeWhere, orderBy: { date: "asc" } }),
      source && source !== "VEHICLE_EXPENSE"
        ? Promise.resolve([])
        : tx.vehicleExpenseVoucher.findMany({ where: vehicleWhere, orderBy: { date: "asc" } }),
      source && source !== "ADBLUE"
        ? Promise.resolve([])
        : tx.adblueTxn.findMany({ where: adblueWhere, orderBy: { date: "asc" } }),
      (source && source !== "HIRE_SLIP") || searchParams.party
        ? Promise.resolve([])
        : tx.hireSlip.findMany({ where: hireWhere, orderBy: { slipDate: "asc" } }),
      tx.party.findMany({
        where: {
          ledgerGroup: { in: ["OWNER_BROKER", "SUPPLIERS", "STAFF", "DRIVER"] },
          isActive: true,
        },
        orderBy: { name: "asc" },
      }),
      // the ONE settlement formula (money + TDS + shortage + other + round-off,
      // live vouchers of this firm + FY, journals included) — the same helper
      // the chalan register, status drawer and voucher grid read, so this
      // register can never disagree with them by a round-off or an adjustment
      settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ALL_PAYABLE_REF_TYPES,
      }),
    ]);
    // dashboard-tile parity: the Payable tile also counts pending driver
    // settlements (company owes the driver) and open advances RECEIVED
    // (we owe them back to the party) — this register carries both too
    const advances =
      source && source !== "ADVANCE"
        ? []
        : await tx.partyAdvance.findMany({
            where: {
              firmId: session.firmId,
              deletedAt: null,
              kind: "RECEIVED",
              date: effDate,
              ...(searchParams.party ? { partyId: searchParams.party } : {}),
            },
            orderBy: { date: "asc" },
          });
    const advPartyIds = Array.from(new Set(advances.map((a) => a.partyId)));
    const advParties = advPartyIds.length
      ? await tx.party.findMany({
          where: { id: { in: advPartyIds } },
          select: { id: true, name: true },
        })
      : [];
    const driverSetts =
      source && source !== "DRIVER_SETTLEMENT"
        ? []
        : await tx.driverSettlement.findMany({
            where: {
              firmId: session.firmId,
              deletedAt: null,
              amount: { gt: 0 },
              status: "PENDING",
              date: effDate,
            },
            orderBy: { date: "asc" },
          });
    const driverRows = driverSetts.length
      ? await tx.driver.findMany({ select: { id: true, partyId: true, name: true } })
      : [];
    const settPos = await refPositions(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      refType: "DRIVER_SETTLEMENT",
      docs: driverSetts.map((s) => ({ id: s.id, original: toNum(String(s.amount)) })),
    });
    return { chalans, slips, salaries, office, vehicle, adblue, hires, parties, paidByRef, advances, advParties, driverSetts, driverRows, settPos };
  }).then(({ chalans, slips, salaries, office, vehicle, adblue, hires, parties, paidByRef, advances, advParties, driverSetts, driverRows, settPos }) => {
    const partyById = new Map(parties.map((p) => [p.id, p]));
    const status = (total: number, outstanding: number) =>
      outstanding <= 0.009 ? "PAID" : outstanding < total - 0.009 ? "PARTLY PAID" : "UNPAID";
    const partyType = (id: string | null | undefined, fallback: string) => {
      const g = id ? partyById.get(id)?.ledgerGroup : undefined;
      if (g === "OWNER_BROKER") return "Owner / Broker";
      if (g === "SUPPLIERS") return "Supplier";
      if (g === "STAFF") return "Staff";
      if (g === "DRIVER") return "Driver";
      return fallback;
    };

    const chalanRows = chalans.map((c) => {
      const gross = toNum(c.grandTotal);
      const paid =
        toNum(c.advanceTotal) +
        toNum(c.balPaidAmount) +
        toNum(c.balRoundOff) +
        toNum(c.balShortage) +
        // advance vouchers consumed at the balance-payment step settle the
        // chalan exactly like money paid there
        toNum(c.balAdvanceAdjusted) +
        (paidByRef.get(c.id) ?? 0);
      const outstanding = Math.round((gross - paid) * 100) / 100;
      return {
        refNo: c.chalanNo,
        date: c.chalanDate.toISOString(),
        kind: "CHALAN",
        partyType: partyType(c.brokerId, "Owner / Broker"),
        party: partyById.get(c.brokerId)?.name ?? "",
        gross,
        paid,
        outstanding,
        status: status(gross, outstanding),
        link: `chalan?id=${c.id}`,
      };
    });

    // broker slip owner (V) side: hire payable to the vehicle owner
    const slipRows = slips.map((s) => {
      const gross = toNum(s.vNetAmt);
      const paid =
        toNum(s.vAdvance) +
        toNum(s.vPaidAmount) +
        toNum(s.vRoundOff) +
        toNum(s.vShortage) +
        (paidByRef.get(s.id) ?? 0);
      const outstanding = Math.round((gross - paid) * 100) / 100;
      return {
        refNo: s.slipNo,
        date: s.slipDate.toISOString(),
        kind: "BROKER_SLIP",
        partyType: partyType(s.ownerId, "Vehicle Owner"),
        party: (s.ownerId && partyById.get(s.ownerId)?.name) || s.ownerName || "",
        gross,
        paid,
        outstanding,
        status: status(gross, outstanding),
        link: `broker/slip?id=${s.id}`,
      };
    });

    const salaryRows = salaries.map((s) => {
      const gross = toNum(s.netSalary);
      // settled from the payroll screen PLUS anything allocated by a payment
      // voucher — before this, a salary paid by voucher still read as fully
      // outstanding here
      const paid = toNum(s.paidAmount) + (paidByRef.get(s.id) ?? 0);
      const outstanding = Math.round((gross - paid) * 100) / 100;
      // a malformed month must degrade to the entry date, not throw a
      // RangeError that 500s the whole register
      const monthDate = new Date(`${s.month}-01T00:00:00`);
      return {
        refNo: s.refNo || s.voucherNo || `Salary ${s.month}`,
        date: (Number.isNaN(monthDate.getTime()) ? s.createdAt : monthDate).toISOString(),
        kind: "SALARY",
        partyType: "Staff",
        party: partyById.get(s.partyId)?.name ?? "",
        gross,
        paid,
        outstanding,
        status: status(gross, outstanding),
        link: `accounts/staff`,
      };
    });

    const officeRows = office.map((o) => {
      const gross = toNum(o.amount);
      const paid = paidByRef.get(o.id) ?? 0;
      const outstanding = Math.round((gross - paid) * 100) / 100;
      return {
        refNo: o.refNo || o.voucherNo,
        date: o.date.toISOString(),
        kind: "OFFICE_EXPENSE",
        partyType: partyType(o.partyId, "Supplier"),
        party: (o.partyId && partyById.get(o.partyId)?.name) ?? "",
        gross,
        paid,
        outstanding,
        status: status(gross, outstanding),
        link: `accounts/office?id=${o.id}`,
      };
    });

    const vehicleRows = vehicle.map((v) => {
      const gross = toNum(v.amount);
      const paid = paidByRef.get(v.id) ?? 0;
      const outstanding = Math.round((gross - paid) * 100) / 100;
      return {
        // blank reference means the voucher number, the rule every module follows
        refNo: v.refNo || v.voucherNo,
        date: v.date.toISOString(),
        kind: "VEHICLE_EXPENSE",
        partyType: partyType(v.partyId, "Supplier"),
        party: (v.partyId && partyById.get(v.partyId)?.name) ?? "",
        gross,
        paid,
        outstanding,
        status: status(gross, outstanding),
        link: `vehicle/expenses?id=${v.id}`,
      };
    });

    // hire slip: payable = total hire (post TDS/SC) − advance − allocations;
    // same live formula the dashboard tile uses
    const hireRows = hires.map((h) => {
      const gross = toNum(h.totalHire);
      const paid = toNum(h.advance) + (paidByRef.get(h.id) ?? 0);
      const outstanding = Math.round((gross - paid) * 100) / 100;
      return {
        refNo: h.slipNo,
        date: h.slipDate.toISOString(),
        kind: "HIRE_SLIP",
        partyType: "Vehicle Owner",
        party: h.ownerName || h.brokerName || "",
        gross,
        paid,
        outstanding,
        status: status(gross, outstanding),
        link: `hire-slip`,
      };
    });

    const adblueRows = adblue.map((a) => {
      const gross = toNum(a.amount);
      const paid = paidByRef.get(a.id) ?? 0;
      const outstanding = Math.round((gross - paid) * 100) / 100;
      return {
        refNo: a.billNo ?? "",
        date: (a.billDate ?? a.date).toISOString(),
        kind: "ADBLUE",
        partyType: partyType(a.supplierId, "Supplier"),
        party: (a.supplierId && partyById.get(a.supplierId)?.name) ?? a.supplierName ?? "",
        gross,
        paid,
        outstanding,
        status: status(gross, outstanding),
        link: `vehicle/adblue`,
      };
    });

    const advPartyName = new Map(advParties.map((p) => [p.id, p.name]));
    const advanceRows = advances.map((a) => {
      const gross = Math.round(toNum(String(a.amount)) * 100) / 100;
      const paid = Math.round(toNum(String(a.consumedAmount)) * 100) / 100;
      const outstanding = Math.round((gross - paid) * 100) / 100;
      return {
        refNo: a.voucherNo ?? "ADV",
        date: a.date.toISOString(),
        kind: "ADVANCE_RECEIVED",
        partyType: partyType(a.partyId, "Party"),
        party: advPartyName.get(a.partyId) ?? partyById.get(a.partyId)?.name ?? "",
        gross,
        paid,
        outstanding,
        status: status(gross, outstanding),
        link: "accounts/vouchers?tab=REGISTER",
      };
    });

    const drvById = new Map(driverRows.map((d) => [d.id, d]));
    const driverSettRows = driverSetts
      .filter((s) => !searchParams.party || drvById.get(s.driverId)?.partyId === searchParams.party)
      .map((s) => {
        const p = settPos.get(s.id);
        const gross = Math.round(toNum(String(s.amount)) * 100) / 100;
        const paid = Math.round((p?.settled ?? 0) * 100) / 100;
        const outstanding = Math.round((p ? p.outstanding : gross) * 100) / 100;
        return {
          refNo: s.tripRef || s.voucherNo || "SETTLEMENT",
          date: s.date.toISOString(),
          kind: "DRIVER_SETTLEMENT",
          partyType: "Driver",
          party: drvById.get(s.driverId)?.name ?? "",
          gross,
          paid,
          outstanding,
          status: status(gross, outstanding),
          link: "vehicle/driver-settlements",
        };
      });

    return {
      parties,
      rows: [
        ...chalanRows,
        ...slipRows,
        ...salaryRows,
        ...officeRows,
        ...vehicleRows,
        ...adblueRows,
        ...hireRows,
        ...advanceRows,
        ...driverSettRows,
      ]
        .filter((r) => r.gross > 0)
        .filter((r) => showClosed || r.outstanding > 0.009)
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  });

  const filters: FilterDef[] = [
    { type: "daterange", key: "date", label: "Date" },
    {
      type: "combobox",
      key: "party",
      label: "Party",
      options: parties.map((p) => ({
        value: p.id,
        label: `${p.name} (${p.ledgerGroup.replace(/_/g, " ")})`,
      })),
    },
    {
      type: "select",
      key: "source",
      label: "Module",
      options: [
        { value: "CHALAN", label: "Chalan (Freight Payable)" },
        { value: "BROKER_SLIP", label: "Broker Slip (Owner Payable)" },
        { value: "SALARY", label: "Staff Salary" },
        { value: "OFFICE_EXPENSE", label: "Office Expense" },
        { value: "VEHICLE_EXPENSE", label: "Vehicle Expense" },
        { value: "ADBLUE", label: "AdBlue / Urea Purchase" },
        { value: "HIRE_SLIP", label: "Hire Slip (Lorry Hire)" },
        { value: "ADVANCE", label: "Advances (Received)" },
        { value: "DRIVER_SETTLEMENT", label: "Driver Settlements" },
      ],
    },
    {
      type: "select",
      key: "show_closed",
      label: "Show Closed",
      options: [{ value: "1", label: "Include settled" }],
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar filters={filters} />
      <SimpleReport
        title={`${rows.length} payable${rows.length === 1 ? "" : "s"} (chalans + broker slip owner side + hire slips + staff salary + office/vehicle/adblue bills + received advances + driver settlements — same set as the dashboard tile)`}
        columns={[
          { key: "refNo", header: "Ref No", linkBase: "/", linkParamKey: "link" },
          { key: "date", header: "Date", kind: "date" },
          { key: "kind", header: "Module", kind: "badge" },
          { key: "partyType", header: "Party Type" },
          { key: "party", header: "Party" },
          { key: "gross", header: "Gross Amt", kind: "money" },
          { key: "paid", header: "Paid / Adj", kind: "money" },
          { key: "outstanding", header: "Outstanding", kind: "money" },
          { key: "status", header: "Status", kind: "badge" },
        ]}
        rows={rows}
        fileName="outstanding-payables"
        emptyMessage="No outstanding payables — everything is settled."
      />
    </div>
  );
}
