import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport } from "@/components/accounts/simple-report";
import { istDayEnd, istDayStart } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: { date_from?: string; date_to?: string; entity?: string; action?: string; user?: string };
}) {
  const session = requireSession();
  await authorize(session, "settings", "view");

  const { rows, users } = await withTenant(session.tenantId, async (tx) => {
    const where: Prisma.AuditLogWhereInput = {};
    if (searchParams.date_from || searchParams.date_to) {
      where.createdAt = {
        ...(searchParams.date_from ? { gte: istDayStart(searchParams.date_from) } : {}),
        ...(searchParams.date_to ? { lte: istDayEnd(searchParams.date_to) } : {}),
      };
    }
    if (searchParams.entity) where.entity = { contains: searchParams.entity, mode: "insensitive" };
    if (searchParams.action) where.action = searchParams.action;
    if (searchParams.user) where.userId = searchParams.user;
    const [rows, users] = await Promise.all([
      tx.auditLog.findMany({
        where,
        include: { user: true },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      tx.user.findMany({ orderBy: { name: "asc" } }),
    ]);
    return { rows, users };
  });

  const filters: FilterDef[] = [
    { type: "daterange", key: "date", label: "Date" },
    { type: "text", key: "entity", label: "Entity (LR, Invoice...)" },
    {
      type: "select",
      key: "action",
      label: "Action",
      options: ["CREATE", "UPDATE", "DELETE", "PRINT", "LOGIN"].map((a) => ({ value: a, label: a })),
    },
    {
      type: "combobox",
      key: "user",
      label: "User",
      options: users.map((u) => ({ value: u.id, label: u.name })),
    },
  ];

  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title">Audit Log</h1>
      <FilterBar filters={filters} />
      <SimpleReport
        title={`Latest ${rows.length} entries (max 500)`}
        fileName="audit-log"
        emptyMessage="No audit entries found."
        columns={[
          { key: "when", header: "Timestamp" },
          { key: "user", header: "User" },
          { key: "action", header: "Action", kind: "badge" },
          { key: "entity", header: "Entity" },
          { key: "entityId", header: "Record ID" },
        ]}
        rows={rows.map((r) => ({
          when: r.createdAt.toLocaleString("en-IN", { hour12: false }),
          user: r.user?.name ?? "system",
          action: r.action,
          entity: r.entity,
          entityId: r.entityId,
        }))}
      />
    </div>
  );
}
