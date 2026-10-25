import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { DocumentMasterClient } from "@/components/masters/document-master-client";
import { rankByMatch } from "@/lib/search-rank";

export async function DocumentTypesTab({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const session = requireSession();
  await authorize(session, "masters", "view");
  const q = searchParams.q?.trim();

  const rows = await withTenant(session.tenantId, (tx) =>
    tx.documentType.findMany({
      where: q ? { name: { contains: q, mode: "insensitive" } } : undefined,
      orderBy: { name: "asc" },
    })
      // exact match on the typed search first
      .then((rows) => rankByMatch(rows, q ?? "", (r) => r.name))
  );

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";
  return <DocumentMasterClient embedded rows={rows} canDelete={canDelete} />;
}
