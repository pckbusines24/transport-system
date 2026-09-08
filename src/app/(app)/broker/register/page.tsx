import { partyMeta } from "@/lib/party-option";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { round2 } from "@/lib/calc/tds";
import { brokerPartySettlement, payableSettlement } from "@/lib/settlement";
import { Button } from "@/components/ui/button";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import { BrokerRegisterTable, type BrokerRegisterRow } from "@/components/broker/register-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

interface SearchParams {
  [key: string]: string | undefined;
  date_from?: string;
  date_to?: string;
  q?: string; // slip no search
  vehicle?: string;
  party?: string;
  side?: string; // PARTY | OWNER
  pod?: string; // yes | no
  pstatus?: string; // received | pending
  vstatus?: string; // paid | pending
  page?: string;
}

export default async function BrokerRegisterPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = requireSession();
  await authorize(session, "broker", "view");

  const page = parsePage(searchParams.page);
  // vstatus filters on the LIVE settled position computed after the query, so
  // it cannot be pushed into SQL — with vstatus set, the full filtered set is
  // fetched and paged in memory instead of at the database
  // both balance filters run on the LIVE settled position (voucher
  // allocations included), so the page slice is taken after filtering
  const dbPaged = !searchParams.vstatus && !searchParams.pstatus;

  const { rows, totalCount, vPos, pPos, vehicles, brokers, cityById, partyById, vehicleById, userById } = await withTenant(
    session.tenantId,
    async (tx) => {
      // date filter beats FY (FY continuity): dates set → any year's slips
      // dates OR a slip-number search beat FY — slip numbers continue across
      // years, so an old number stays findable from this year's register
      const where: Prisma.BrokerSlipWhereInput = {
        firmId: session.firmId,
        ...(searchParams.date_from || searchParams.date_to || searchParams.q
          ? {}
          : { fyId: session.fyId }),
        deletedAt: null,
      };
      if (searchParams.date_from || searchParams.date_to) {
        where.slipDate = {
          ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        };
      }
      if (searchParams.q)
        where.slipNo = { contains: searchParams.q, mode: "insensitive" };
      if (searchParams.vehicle) where.vehicleId = searchParams.vehicle;
      if (searchParams.pod) where.podAttached = searchParams.pod === "yes";
      // pstatus / vstatus filter on the LIVE settled position (below), not the
      // stored columns — a slip settled by a voucher is genuinely settled
      if (searchParams.party) {
        if (searchParams.side === "PARTY") where.partyId = searchParams.party;
        else if (searchParams.side === "OWNER") {
          where.OR = [{ ownerId: searchParams.party }, { transporterId: searchParams.party }];
        } else {
          where.OR = [
            { partyId: searchParams.party },
            { ownerId: searchParams.party },
            { transporterId: searchParams.party },
          ];
        }
      }

      const [slips, totalCount, vehicleRows, partyRows, cityRows, userRows] = await Promise.all([
        tx.brokerSlip.findMany({
          where,
          orderBy: [{ slipDate: "desc" }, { slipNo: "desc" }],
          ...(dbPaged ? { take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE } : {}),
        }),
        tx.brokerSlip.count({ where }),
        tx.vehicle.findMany({
          where: { isActive: true },
          orderBy: { number: "asc" },
          select: { id: true, number: true },
        }),
        tx.party.findMany({
          where: { isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true, ledgerGroup: true, transportName: true, alias: true },
        }),
        tx.city.findMany({ select: { id: true, name: true } }),
        tx.user.findMany({ select: { id: true, name: true } }),
      ]);

      // LIVE owner-side settlement — the stored vBalance/vPaymentStatus never
      // move when a Payment Voucher settles the slip; this register must show
      // the same figures the Outstanding Payables register does
      const vPos = await payableSettlement(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: "BROKER_ENTRY",
        docs: slips.map((s) => ({
          id: s.id,
          balance: round2(Number(s.vNetAmt) - Number(s.vAdvance)),
          ownPaid: Number(s.vPaidAmount),
          ownShortage: Number(s.vShortage),
          ownRoundOff: Number(s.vRoundOff),
        })),
      });

      // LIVE party-side settlement: the slip's own balance-received block
      // plus Receipt Voucher allocations (BROKER_SLIP_PARTY)
      const pPos = await brokerPartySettlement(tx, {
        firmId: session.firmId,
        docs: slips.map((s) => ({
          id: s.id,
          pNetAmt: Number(s.pNetAmt),
          pAdvance: Number(s.pAdvance),
          pPaidAmount: Number(s.pPaidAmount),
          pShortage: Number(s.pShortage),
          pRoundOff: Number(s.pRoundOff),
        })),
      });

      return {
        rows: slips,
        totalCount,
        vPos,
        pPos,
        vehicles: vehicleRows,
        brokers: partyRows.filter((p) => p.ledgerGroup === "OWNER_BROKER" || p.ledgerGroup === "RELATIVE"),
        cityById: new Map(cityRows.map((c) => [c.id, c.name])),
        partyById: new Map(partyRows.map((p) => [p.id, p.name])),
        vehicleById: new Map(vehicleRows.map((v) => [v.id, v.number])),
        userById: new Map(userRows.map((u) => [u.id, u.name])),
      };
    }
  );

  const allRows: BrokerRegisterRow[] = rows.map((s) => ({
    id: s.id,
    slipNo: s.slipNo,
    slipDate: s.slipDate.toISOString(),
    vehicle: (s.vehicleId && vehicleById.get(s.vehicleId)) || "",
    transporter: (s.transporterId && partyById.get(s.transporterId)) || "",
    owner: (s.ownerId && partyById.get(s.ownerId)) || s.ownerName || "",
    loadStation: (s.loadStationId && cityById.get(s.loadStationId)) || "",
    destination: (s.destCityId && cityById.get(s.destCityId)) || "",
    qty: Number(s.qty),
    actualWt: Number(s.actualWt),
    pFreight: Number(s.pFreight),
    // recomputed, never the stored column
    pBalance: round2(Number(s.pNetAmt) - Number(s.pAdvance)),
    vFreight: Number(s.vFreight),
    vNetAmt: Number(s.vNetAmt),
    vAdvance: Number(s.vAdvance),
    // live outstanding (own payments + voucher allocations), never stored
    vBalance: vPos.get(s.id)?.outstanding ?? Number(s.vBalance),
    pAdvance: Number(s.pAdvance),
    pNetAmt: Number(s.pNetAmt),
    podAttached: s.podAttached,
    podFilePath: s.podFilePath,
    podFileName: s.podFileName,
    podUploadDate: s.podUploadDate ? s.podUploadDate.toISOString() : null,
    // live: own block + receipt vouchers. Money, TDS and other deductions a
    // receipt carried all count as received; shortage and round-off keep
    // their own lines so the status dialog reconciles
    pPaymentStatus: (pPos.get(s.id)?.outstanding ?? Infinity) <= 0.009 ? "RECEIVED" : "PENDING",
    pPaidAmount: round2(
      Number(s.pPaidAmount) +
        (pPos.get(s.id)?.voucherPaid ?? 0) +
        (pPos.get(s.id)?.voucherTds ?? 0) +
        (pPos.get(s.id)?.voucherOther ?? 0)
    ),
    pRoundOff: round2(Number(s.pRoundOff) + (pPos.get(s.id)?.voucherRoundOff ?? 0)),
    pShortage: round2(Number(s.pShortage) + (pPos.get(s.id)?.voucherShortage ?? 0)),
    pPaymentDate: s.pPaymentDate ? s.pPaymentDate.toISOString() : null,
    vPaymentStatus:
      (vPos.get(s.id)?.outstanding ?? Number(s.vBalance)) <= 0.009 ? "PAID" : "PENDING",
    vPaidAmount: Number(s.vPaidAmount),
    vRoundOff: Number(s.vRoundOff),
    vShortage: Number(s.vShortage),
    vPaymentDate: s.vPaymentDate ? s.vPaymentDate.toISOString() : null,
    unloadDate: s.unloadDate ? s.unloadDate.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    createdBy: (s.createdById && userById.get(s.createdById)) || "",
  }));
  // balance filters run on the LIVE positions computed above
  const filtered = allRows.filter((r) => {
    if (searchParams.vstatus) {
      const paid = r.vBalance <= 0.009;
      if (searchParams.vstatus === "paid" ? !paid : paid) return false;
    }
    if (searchParams.pstatus) {
      const received = r.pPaymentStatus === "RECEIVED";
      if (searchParams.pstatus === "received" ? !received : received) return false;
    }
    return true;
  });
  const total = dbPaged ? totalCount : filtered.length;
  // dbPaged → rows are already the page slice; otherwise slice the filtered set
  const data = dbPaged ? filtered : filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const filters: FilterDef[] = [
    { type: "text", key: "q", label: "Slip No..." },
    { type: "daterange", key: "date", label: "Slip Date" },
    {
      type: "combobox",
      key: "vehicle",
      label: "Vehicle",
      options: vehicles.map((v) => ({ value: v.id, label: v.number })),
    },
    {
      type: "combobox",
      key: "party",
      label: "Transporter / Owner",
      options: brokers.map((p) => ({ value: p.id, label: p.name, meta: partyMeta(p) })),
    },
    {
      type: "select",
      key: "side",
      label: "Side",
      options: [
        { value: "PARTY", label: "Party" },
        { value: "OWNER", label: "Owner" },
      ],
    },
    {
      type: "select",
      key: "pstatus",
      label: "Broker Balance",
      options: [
        { value: "received", label: "Received" },
        { value: "pending", label: "Pending" },
      ],
    },
    {
      type: "select",
      key: "vstatus",
      label: "Owner Balance",
      options: [
        { value: "paid", label: "Paid" },
        { value: "pending", label: "Pending" },
      ],
    },
    {
      type: "select",
      key: "pod",
      label: "POD Attached",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    },
  ];

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Broker Entry Register</h1>
        <Button asChild size="sm">
          <Link href="/broker/slip">New Broker Slip</Link>
        </Button>
      </div>
      <FilterBar filters={filters} />
      {/* balance receipt / payment moved into the slip itself */}
      <BrokerRegisterTable data={data} canDelete={canDelete} />
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/broker/register"
        searchParams={searchParams}
      />
    </div>
  );
}
