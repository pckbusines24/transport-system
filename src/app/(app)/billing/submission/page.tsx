import { partyMeta } from "@/lib/party-option";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import {
  BillSubmissionClient,
  type SubmissionRegisterRow,
} from "@/components/billing/bill-submission-client";

export const dynamic = "force-dynamic";

export default async function BillSubmissionPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "billing", "view");
  const { date_from, date_to, party, q, received } = searchParams;

  const { parties, rows } = await withTenant(session.tenantId, async (tx) => {
    const [parties, subs] = await Promise.all([
      tx.party.findMany({
        where: { isActive: true, ledgerGroup: "CONSIGNEE_CONSIGNOR" },
        orderBy: { name: "asc" },
      }),
      tx.invoiceSubmission.findMany({
        // date filter beats FY (FY continuity)
        where: {
          firmId: session.firmId,
          ...(date_from || date_to
            ? {
                submissionDate: {
                  ...(date_from ? { gte: new Date(date_from + "T00:00:00") } : {}),
                  ...(date_to ? { lte: new Date(date_to + "T23:59:59") } : {}),
                },
              }
            : { fyId: session.fyId }),
          ...(party ? { partyId: party } : {}),
          ...(q ? { submissionNo: { contains: q, mode: "insensitive" } } : {}),
          ...(received === "received"
            ? { receivedBy: { not: null } }
            : received === "pending"
              ? { receivedBy: null }
              : {}),
        },
        include: { items: { include: { invoice: { select: { netTotal: true } } } } },
        orderBy: { submissionDate: "desc" },
      }),
    ]);
    return { parties, rows: subs };
  });

  const partyName = (id: string) => parties.find((p) => p.id === id)?.name ?? "";

  const registerRows: SubmissionRegisterRow[] = rows.map((s) => ({
    id: s.id,
    submissionNo: s.submissionNo,
    submissionDate: s.submissionDate.toISOString(),
    customer: partyName(s.partyId),
    totalBills: s.items.length,
    totalAmount: s.items.reduce((sum, it) => sum + toNum(String(it.invoice.netTotal)), 0),
    receivedBy: s.receivedBy ?? "",
    receivedDate: s.receivedDate ? s.receivedDate.toISOString() : null,
    hasDocs: !!(s.signedLetterPath || s.ackCopyPath || s.supportingPath),
    remarks: s.remarks ?? "",
    returnedCount: s.items.filter((it) => it.status === "RETURNED").length,
  }));

  return (
    <div className="space-y-4 p-4">
      <BillSubmissionClient
        rows={registerRows}
        partyOptions={parties.map((p) => ({
          value: p.id,
          label: p.name,
          meta: partyMeta(p, p.gstin, p.pan),
        }))}
      />
    </div>
  );
}
