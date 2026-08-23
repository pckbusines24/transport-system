import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { getPartyOptions, getVehicleOptions } from "@/lib/lookups";
import { toNum } from "@/lib/utils";
import { FilterBar } from "@/components/data/filter-bar";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import {
  VoucherRegisterTable,
  RegisterRow,
  type VoucherRegisterTotals,
} from "@/components/accounts/voucher-register-table";
import { VoucherType, ModuleLink, Prisma } from "@prisma/client";

const PAGE_SIZE = 100;

const MODULE_LINKS = [
  "BILLING",
  "LORRY_HIRE",
  "BROKER_ENTRY",
  "FREIGHT_CHALLAN",
  "CASH_MEMO",
  "GST_BILLING",
  "LR_ENTRY",
  "OTHERS",
];

function toDate(s: string | undefined, end = false): Date | undefined {
  if (!s) return undefined;
  return new Date(`${s}T${end ? "23:59:59" : "00:00:00"}`);
}

export async function VoucherRegisterTab({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  const [partyOptions, vehicleOptions] = await Promise.all([
    getPartyOptions(),
    getVehicleOptions(),
  ]);

  const type = searchParams.type as VoucherType | undefined;
  // date filter beats FY (FY continuity): dates set → any year's vouchers.
  // A ?q= deep-link (Ledger/Ref search) also spans years — the target voucher
  // may live in an earlier FY.
  const where: Prisma.VoucherWhereInput = {
    firmId: session.firmId,
    ...(searchParams.date_from || searchParams.date_to || searchParams.q
      ? {}
      : { fyId: session.fyId }),
    deletedAt: null,
    ...(type && ["RECEIPT", "PAYMENT", "CONTRA", "JOURNAL"].includes(type) ? { type } : {}),
    // ?q= deep-links from the Ledger Summary land on the exact voucher
    ...(searchParams.q
      ? { voucherNo: { contains: searchParams.q, mode: "insensitive" as const } }
      : {}),
    ...(searchParams.party ? { partyId: searchParams.party } : {}),
    ...(searchParams.vehicle ? { vehicleId: searchParams.vehicle } : {}),
    ...(searchParams.module && MODULE_LINKS.includes(searchParams.module)
      ? { moduleLink: searchParams.module as ModuleLink }
      : {}),
    ...(searchParams.date_from || searchParams.date_to
      ? {
          voucherDate: {
            ...(toDate(searchParams.date_from) ? { gte: toDate(searchParams.date_from) } : {}),
            ...(toDate(searchParams.date_to, true) ? { lte: toDate(searchParams.date_to, true) } : {}),
          },
        }
      : {}),
  };

  const page = parsePage(searchParams.page);
  const { rows, total, totals } = await withTenant(session.tenantId, async (tx) => {
    const [vouchers, total, agg, parties] = await Promise.all([
      tx.voucher.findMany({
        where,
        // allocation remarks carry the settlement markers — the table hides
        // Edit on auto-created chalan/slip settlement vouchers
        include: { allocations: { select: { remarks: true } } },
        orderBy: [{ voucherDate: "asc" }, { voucherNo: "asc" }],
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
      tx.voucher.count({ where }),
      // footer totals over the FULL filtered set — the table only gets one page
      tx.voucher.aggregate({
        where,
        _sum: { amount: true, tdsAmt: true, deduction: true, netAmount: true },
      }),
      tx.party.findMany({ select: { id: true, name: true } }),
    ]);
    const partyName = new Map(parties.map((p) => [p.id, p.name]));
    const totals: VoucherRegisterTotals = {
      amount: toNum(agg._sum.amount),
      tdsAmt: toNum(agg._sum.tdsAmt),
      deduction: toNum(agg._sum.deduction),
      netAmount: toNum(agg._sum.netAmount),
    };
    const rows: RegisterRow[] = vouchers.map((v) => ({
      id: v.id,
      voucherNo: v.voucherNo,
      voucherDate: v.voucherDate.toISOString(),
      type: v.type,
      partyName: v.partyId ? partyName.get(v.partyId) ?? null : null,
      moduleLink: v.moduleLink,
      bankName: v.bankPartyId ? partyName.get(v.bankPartyId) ?? null : null,
      chequeNo: v.chequeNo,
      amount: Number(v.amount),
      tdsAmt: Number(v.tdsAmt),
      deduction: Number(v.deduction),
      netAmount: Number(v.netAmount),
      settlement: v.allocations.some(
        (a) =>
          a.remarks === "CHALAN_BAL_SETTLEMENT" ||
          a.remarks === "BROKER_SLIP_P_SETTLEMENT" ||
          a.remarks === "BROKER_SLIP_V_SETTLEMENT"
      )
        ? 1
        : 0,
    }));
    return { rows, total, totals };
  });

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";

  return (
    <div className="space-y-4">
      <FilterBar
        filters={[
          { type: "text", key: "q", label: "Voucher No..." },
          { type: "daterange", key: "date", label: "Date" },
          {
            type: "select",
            key: "type",
            label: "Type",
            options: [
              { value: "RECEIPT", label: "Receipt" },
              { value: "JOURNAL", label: "Journal" },
              { value: "PAYMENT", label: "Payment" },
              { value: "CONTRA", label: "Contra" },
            ],
          },
          { type: "combobox", key: "party", label: "Party", options: partyOptions },
          {
            type: "select",
            key: "module",
            label: "Module",
            options: MODULE_LINKS.map((m) => ({ value: m, label: m.replace(/_/g, " ") })),
          },
          { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
        ]}
      />
      <VoucherRegisterTable rows={rows} canDelete={canDelete} totals={totals} />
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/accounts/vouchers"
        searchParams={searchParams}
      />
    </div>
  );
}
