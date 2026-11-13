import type { Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { Session } from "@/lib/session";

/**
 * POD remark group — the LRs that unload together: same live chalan AND same
 * consignee. Their POD Unload Date and Remark are kept identical: entering or
 * editing them on one LR's POD applies to every POD of the group. Everything
 * else on a POD (ack no, PO, gate entry, weights, file) stays per LR.
 *
 * The group is derived, never stored: an LR with no live chalan is a group
 * of one, and an LR on a different consignee of the same truck is separate.
 */
export interface PodGroup {
  /** "<chalanId>:<consigneeId>", or "lr:<lrId>" for an LR on no live chalan */
  key: string;
  /** every operational LR of the group, the LR itself included */
  lrIds: string[];
}

/** The group of each given LR. */
export async function podGroups(tx: Tx, firmId: string, lrIds: string[]): Promise<Map<string, PodGroup>> {
  const out = new Map<string, PodGroup>();
  if (!lrIds.length) return out;
  const [links, lrs] = await Promise.all([
    tx.chalanLr.findMany({
      where: { lrId: { in: lrIds }, chalan: { firmId, deletedAt: null, cancelledAt: null } },
      select: { lrId: true, chalanId: true },
    }),
    tx.lr.findMany({ where: { id: { in: lrIds }, firmId }, select: { id: true, consigneeId: true } }),
  ]);
  // an LR rides one live chalan
  const chalanOf = new Map(links.map((l) => [l.lrId, l.chalanId]));
  const consigneeOf = new Map(lrs.map((l) => [l.id, l.consigneeId]));
  const chalanIds = Array.from(new Set(links.map((l) => l.chalanId)));
  const members = chalanIds.length
    ? await tx.chalanLr.findMany({
        where: {
          chalanId: { in: chalanIds },
          lr: { firmId, deletedAt: null, lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] } },
        },
        select: { chalanId: true, lr: { select: { id: true, consigneeId: true } } },
      })
    : [];
  for (const id of lrIds) {
    const chalanId = chalanOf.get(id);
    const consigneeId = consigneeOf.get(id);
    if (!chalanId || !consigneeId) {
      out.set(id, { key: `lr:${id}`, lrIds: [id] });
      continue;
    }
    const ids = members
      .filter((m) => m.chalanId === chalanId && m.lr.consigneeId === consigneeId)
      .map((m) => m.lr.id);
    out.set(id, { key: `${chalanId}:${consigneeId}`, lrIds: ids.includes(id) ? ids : [...ids, id] });
  }
  return out;
}

/**
 * The group's current Unload Date / Remark, from the most recently changed
 * POD of the group that carries either — to prefill an LR confirmed later.
 */
export async function podGroupValues(
  tx: Tx,
  firmId: string,
  groups: Map<string, PodGroup>
): Promise<Map<string, { unloadDate: Date | null; remarks: string }>> {
  const allIds = Array.from(new Set(Array.from(groups.values()).flatMap((g) => g.lrIds)));
  const pods = allIds.length
    ? await tx.pod.findMany({
        where: { firmId, lrId: { in: allIds }, OR: [{ unloadDate: { not: null } }, { remarks: { not: null } }] },
        select: { lrId: true, unloadDate: true, remarks: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      })
    : [];
  const out = new Map<string, { unloadDate: Date | null; remarks: string }>();
  groups.forEach((g, lrId) => {
    const p = pods.find((x) => x.lrId && g.lrIds.includes(x.lrId));
    if (p) out.set(lrId, { unloadDate: p.unloadDate, remarks: p.remarks ?? "" });
  });
  return out;
}

/**
 * Apply an Unload Date / Remark to every OTHER POD of the LR's group (one
 * audit entry each). `onlyFilled` (a new POD): a blank value is not pushed
 * onto the group; an explicit edit pushes blanks too, so clearing clears all.
 * Returns the LR numbers that changed.
 */
export async function syncPodGroup(
  tx: Tx,
  session: Session & { firmId: string },
  lrId: string,
  values: { unloadDate: Date | null; remarks: string | null },
  opts: { onlyFilled: boolean }
): Promise<string[]> {
  const group = (await podGroups(tx, session.firmId, [lrId])).get(lrId);
  const others = (group?.lrIds ?? []).filter((id) => id !== lrId);
  if (!others.length) return [];
  const data: { unloadDate?: Date | null; remarks?: string | null } = {};
  if (!opts.onlyFilled || values.unloadDate) data.unloadDate = values.unloadDate;
  if (!opts.onlyFilled || values.remarks) data.remarks = values.remarks || null;
  if (!Object.keys(data).length) return [];

  const pods = await tx.pod.findMany({
    where: { firmId: session.firmId, lrId: { in: others } },
    select: { id: true, unloadDate: true, remarks: true, lr: { select: { lrNo: true } } },
  });
  const changed: string[] = [];
  for (const p of pods) {
    const sameDate =
      !("unloadDate" in data) || (p.unloadDate?.getTime() ?? null) === (data.unloadDate?.getTime() ?? null);
    const sameRemark = !("remarks" in data) || (p.remarks ?? null) === (data.remarks ?? null);
    if (sameDate && sameRemark) continue;
    await tx.pod.update({ where: { id: p.id }, data });
    await audit(tx, session, {
      entity: "Pod",
      entityId: p.id,
      action: "UPDATE",
      before: { unloadDate: p.unloadDate, remarks: p.remarks },
      after: { ...data, reason: "synced from the LR's POD group (same chalan + consignee)" },
    });
    if (p.lr?.lrNo) changed.push(p.lr.lrNo);
  }
  return changed;
}
