"use server";

import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { masterReferences, type MasterKind, type MasterRefReport } from "@/lib/master-refs";

/**
 * "Where is this master used?" — asked by the delete dialog BEFORE it offers
 * a Delete button, so the user sees the dependent entries up front instead
 * of a failed delete afterwards. The delete actions run the same check
 * server-side, so this is a courtesy, not the guard.
 */
export async function getMasterReferences(
  kind: MasterKind,
  id: string
): Promise<MasterRefReport> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    // units are stored on products by NAME, so the check needs it
    const name =
      kind === "unit" ? (await tx.unit.findFirst({ where: { id } }))?.name ?? undefined : undefined;
    return masterReferences(tx, kind, { id, name });
  });
}
