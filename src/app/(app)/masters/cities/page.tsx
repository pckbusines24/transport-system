import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { CitiesClient } from "@/components/masters/cities-client";
import { rankByMatch } from "@/lib/search-rank";

export default async function CitiesPage({
  searchParams,
}: {
  searchParams: { q?: string; stateId?: string };
}) {
  const session = requireSession();
  await authorize(session, "masters", "view");
  const q = searchParams.q?.trim();
  const stateId = searchParams.stateId;

  const { rows, states } = await withTenant(session.tenantId, async (tx) => {
    const rows = await tx.city.findMany({
      where: {
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
        ...(stateId ? { stateId } : {}),
      },
      include: { state: true },
      orderBy: { name: "asc" },
    })
      // exact match on the typed search first
      .then((rows) => rankByMatch(rows, q ?? "", (r) => r.name));
    const states = await tx.state.findMany({ orderBy: { name: "asc" } });
    return { rows, states };
  });

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";
  return (
    <CitiesClient
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        stateId: r.stateId,
        stateName: r.state.name,
        district: r.district,
        pincode: r.pincode,
        stdCode: r.stdCode,
      }))}
      stateOptions={states.map((s) => ({ value: s.id, label: s.name, meta: s.gstCode }))}
      canDelete={canDelete}
    />
  );
}
