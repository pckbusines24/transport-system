import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { ProductsClient } from "@/components/masters/products-client";
import { rankByMatch } from "@/lib/search-rank";

export async function ProductsTab({
  searchParams,
}: {
  searchParams: { q?: string; groupId?: string };
}) {
  const session = requireSession();
  await authorize(session, "masters", "view");
  const q = searchParams.q?.trim();
  const groupId = searchParams.groupId;

  const { rows, groups, units } = await withTenant(session.tenantId, async (tx) => {
    const rows = await tx.product.findMany({
      where: {
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
        ...(groupId ? { groupId } : {}),
      },
      include: { group: true },
      orderBy: { name: "asc" },
    })
      // exact match on the typed search first
      .then((rows) => rankByMatch(rows, q ?? "", (r) => r.name));
    const groups = await tx.productGroup.findMany({ orderBy: { name: "asc" } });
    const units = await tx.unit.findMany({ orderBy: { name: "asc" } });
    return { rows, groups, units };
  });

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";
  return (
    <ProductsClient
      embedded
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        groupId: r.groupId,
        groupName: r.group.name,
        unit: r.unit,
        hsnCode: r.hsnCode,
        productType: r.productType,
        gstPct: Number(r.gstPct),
        type: r.type,
        className: r.className,
        division: r.division,
      }))}
      groupOptions={groups.map((g) => ({ value: g.id, label: g.name }))}
      unitOptions={units.map((u) => ({ value: u.name, label: u.name }))}
      canDelete={canDelete}
    />
  );
}
