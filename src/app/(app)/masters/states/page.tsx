import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { INDIA_STATES } from "@/lib/india-states";
import { StatesClient } from "@/components/masters/states-client";
import { rankByMatch } from "@/lib/search-rank";

export default async function StatesPage({ searchParams }: { searchParams: { q?: string } }) {
  const session = requireSession();
  await authorize(session, "masters", "view");
  const q = searchParams.q?.trim();

  const rows = await withTenant(session.tenantId, async (tx) => {
    // an empty master (fresh install / after a wipe) starts with the standard
    // Indian states + GST codes; a non-empty one is the user's own list and is
    // never touched, so their edits and deletions stick
    const count = await tx.state.count();
    if (count === 0) {
      await tx.state.createMany({
        data: INDIA_STATES.map((s) => ({ tenantId: session.tenantId, ...s })),
      });
    }
    return tx.state.findMany({
      where: q ? { name: { contains: q, mode: "insensitive" } } : undefined,
      orderBy: { name: "asc" },
    })
      // exact match on the typed search first
      .then((rows) => rankByMatch(rows, q ?? "", (r) => r.name));
  });

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";
  return <StatesClient rows={rows} canDelete={canDelete} />;
}
