import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { refPositions } from "@/lib/settlement";
import {
  OfficeTxnClient,
  type OfficeTxnRow,
} from "@/components/accounts/office-txn-client";

export const dynamic = "force-dynamic";

export async function OfficeIncomeExpenseTab({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "office", "view");
  const { date_from, date_to, type, head, party, mode, q } = searchParams;

  const { txns, heads, parties, banks, expPos, incPos } = await withTenant(session.tenantId, async (tx) => {
    const [txns, heads, parties, banks] = await Promise.all([
      tx.officeTransaction.findMany({
        where: {
          firmId: session.firmId,
          fyId: session.fyId,
          deletedAt: null,
          ...(date_from || date_to
            ? {
                date: {
                  ...(date_from ? { gte: new Date(date_from + "T00:00:00") } : {}),
                  ...(date_to ? { lte: new Date(date_to + "T23:59:59") } : {}),
                },
              }
            : {}),
          ...(type === "INCOME" || type === "EXPENSE" ? { txnType: type } : {}),
          ...(head ? { headId: head } : {}),
          ...(party ? { partyId: party } : {}),
          ...(mode === "CASH" || mode === "BANK"
            ? { paymentMode: mode }
            : mode === "CREDIT"
              ? { paymentMode: null }
              : {}),
          ...(q
            ? {
                OR: [
                  { voucherNo: { contains: q, mode: "insensitive" } },
                  { refNo: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        include: { lines: true },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      }),
      tx.accountHead.findMany({
        where: { kind: { in: ["INCOME", "EXPENSE"] } },
        orderBy: { name: "asc" },
      }),
      tx.party.findMany({
        where: { isActive: true, ledgerGroup: { notIn: ["BANK", "CASH", "CARD"] } },
        orderBy: { name: "asc" },
      }),
      tx.party.findMany({
        where: { isActive: true, ledgerGroup: { in: ["BANK", "CASH", "CARD"] } },
        orderBy: { name: "asc" },
      }),
    ]);
    // live settlement of the credit entries, read through the shared engine so
    // the register agrees with the voucher grid and the outstanding report
    // rather than deriving its own figure
    const credit = txns.filter((t) => !t.paymentMode);
    const [expPos, incPos] = await Promise.all([
      refPositions(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: "OFFICE_EXPENSE",
        docs: credit
          .filter((t) => t.txnType === "EXPENSE")
          .map((t) => ({ id: t.id, original: toNum(String(t.amount)) })),
      }),
      refPositions(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: "OFFICE_INCOME",
        docs: credit
          .filter((t) => t.txnType === "INCOME")
          .map((t) => ({ id: t.id, original: toNum(String(t.amount)) })),
      }),
    ]);
    return { txns, heads, parties, banks, expPos, incPos };
  });

  const headName = new Map(heads.map((h) => [h.id, h.name]));
  const partyName = new Map([...parties, ...banks].map((p) => [p.id, p.name]));

  /**
   * An entry paid at source has nothing outstanding and no reference to settle,
   * so it reports as SETTLED rather than as a reference nobody can act on.
   */
  const settlementOf = (t: { id: string; txnType: string; paymentMode: string | null; amount: unknown }) => {
    if (t.paymentMode) {
      const amt = toNum(String(t.amount));
      return { settled: amt, outstanding: 0, status: "SETTLED AT ENTRY" };
    }
    const p = (t.txnType === "EXPENSE" ? expPos : incPos).get(t.id);
    return {
      settled: p?.settled ?? 0,
      outstanding: p?.outstanding ?? toNum(String(t.amount)),
      status: p?.status ?? "UNPAID",
    };
  };

  const rows: OfficeTxnRow[] = txns.map((t) => ({
    id: t.id,
    voucherNo: t.voucherNo,
    date: t.date.toISOString(),
    txnType: t.txnType,
    headId: t.headId,
    head: headName.get(t.headId) ?? "",
    partyId: t.partyId,
    party: t.partyId ? partyName.get(t.partyId) ?? "" : "",
    paymentMode: t.paymentMode ?? "",
    bankPartyId: t.bankPartyId,
    bank: t.bankPartyId ? partyName.get(t.bankPartyId) ?? "" : "",
    amount: toNum(String(t.amount)),
    gstPct: toNum(String(t.gstPct)),
    gstAmount: toNum(String(t.gstAmount)),
    // blank reference falls back to the voucher number — the same value that
    // was persisted on save and that the voucher grid offers for settlement
    refNo: t.refNo || t.voucherNo,
    remarks: t.remarks ?? "",
    attachmentPath: t.attachmentPath,
    lines: t.lines.map((l) => ({
      headId: l.headId,
      head: headName.get(l.headId) ?? "",
      amount: toNum(String(l.amount)),
      remarks: l.remarks ?? "",
    })),
    ...settlementOf(t),
  }));

  return (
    <div className="space-y-4">
      <OfficeTxnClient
        rows={rows}
        headOptions={heads.map((h) => ({ value: h.id, label: h.name, meta: h.kind }))}
        partyOptions={parties.map((p) => ({
          value: p.id,
          label: p.name,
          meta: p.ledgerGroup.replace(/_/g, " "),
        }))}
        bankOptions={banks.map((b) => ({ value: b.id, label: b.name, meta: b.ledgerGroup }))}
        canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      />
    </div>
  );
}
