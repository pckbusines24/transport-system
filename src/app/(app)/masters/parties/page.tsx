import type { LedgerGroup, Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { PartiesClient } from "@/components/masters/parties-client";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";

const PAGE_SIZE = 100;

export const dynamic = "force-dynamic";

export default async function PartiesPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "masters", "view");
  const q = searchParams.q?.trim();
  const page = parsePage(searchParams.page);

  const { rows, total, states, cities } = await withTenant(session.tenantId, async (tx) => {
    // Bank & Cash accounts belong to the Bank/Cash Heads master, not the party ledger
    const where: Prisma.PartyWhereInput = { ledgerGroup: { notIn: ["BANK", "CASH", "CARD"] } };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { gstin: { contains: q, mode: "insensitive" } },
        { pan: { contains: q, mode: "insensitive" } },
        { alias: { contains: q, mode: "insensitive" } },
        // an owner/broker is often remembered by trade name — that must match too
        { transportName: { contains: q, mode: "insensitive" } },
        { tallyName: { contains: q, mode: "insensitive" } },
      ];
    }
    if (searchParams.group && !["BANK", "CASH", "CARD"].includes(searchParams.group))
      where.ledgerGroup = searchParams.group as LedgerGroup;
    if (searchParams.status === "active") where.isActive = true;
    if (searchParams.status === "inactive") where.isActive = false;
    const [rows, total, states, cities] = await Promise.all([
      tx.party.findMany({
        where,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
      tx.party.count({ where }),
      tx.state.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, gstCode: true } }),
      tx.city.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    return { rows, total, states, cities };
  });

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";
  return (
    <>
    <PartiesClient
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        ledgerGroup: r.ledgerGroup,
        alias: r.alias,
        address1: r.address1,
        address2: r.address2,
        stateId: r.stateId,
        cityId: r.cityId,
        gstin: r.gstin,
        pan: r.pan,
        mobile: r.mobile,
        phone: r.phone,
        email: r.email,
        ownerName: r.ownerName,
        transportName: r.transportName,
        tallyName: r.tallyName,
        vendorCode: r.vendorCode,
        openingBalance: toNum(String(r.openingBalance)),
        openingSide: r.openingSide,
        tdsMode: r.tdsMode,
        bankName: r.bankName,
        bankAccount: r.bankAccount,
        bankIfsc: r.bankIfsc,
        isActive: r.isActive,
      }))}
      stateOptions={states.map((s) => ({ value: s.id, label: s.name, meta: s.gstCode }))}
      cityOptions={cities.map((c) => ({ value: c.id, label: c.name }))}
      canDelete={canDelete}
    />
    <div className="px-4 pb-4">
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/masters/parties"
        searchParams={searchParams}
      />
    </div>
    </>
  );
}
