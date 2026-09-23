import Link from "next/link";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, formatMoney, toNum } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { InfoHint } from "@/components/ui/info-hint";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";

export const dynamic = "force-dynamic";

/**
 * Chalan Cancel Advance Register — advances that were already given on a
 * chalan when it was cancelled (accident / rejection). Each stays open on the
 * broker until it is recovered by receipt voucher or adjusted against his
 * next chalan; the adjustment trail shows per document.
 */
export default async function ChalanCancelAdvancesPage({
  searchParams,
}: {
  searchParams: { date_from?: string; date_to?: string; chalan?: string; broker?: string; status?: string };
}) {
  const session = requireSession();
  await authorize(session, "chalan", "view");

  const hasDates = Boolean(searchParams.date_from || searchParams.date_to);

  const { advances, parties, chalans, brokerOptions } = await withTenant(session.tenantId, async (tx) => {
    // FY continuity: an unrecovered cancel-advance stays listed EVERY year
    // until the money comes back; fully-recovered ones stay scoped to the
    // session FY so the register does not fill with closed history — UNLESS
    // a date filter is set, which shows EVERY row of that period (recovered
    // included, any year): date filter beats FY, like every other register
    const all = await tx.partyAdvance.findMany({
      where: {
        firmId: session.firmId,
        deletedAt: null,
        source: "CHALAN_CANCEL",
        ...(hasDates
          ? {
              date: {
                ...(searchParams.date_from
                  ? { gte: new Date(searchParams.date_from + "T00:00:00") }
                  : {}),
                ...(searchParams.date_to
                  ? { lte: new Date(searchParams.date_to + "T23:59:59") }
                  : {}),
              },
            }
          : {}),
      },
      include: { uses: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });
    const advances = hasDates
      ? all
      : all.filter(
          (a) =>
            a.fyId === session.fyId ||
            Number(a.amount) - Number(a.consumedAmount) > 0.009
        );
    const parties = await tx.party.findMany({
      where: { id: { in: advances.map((a) => a.partyId) } },
      select: { id: true, name: true },
    });
    // filter options: every owner / broker, searchable by transport name too
    const brokerOptions = await tx.party.findMany({
      where: { ledgerGroup: { in: ["OWNER_BROKER", "RELATIVE"] }, isActive: true },
      select: { id: true, name: true, transportName: true, alias: true },
      orderBy: { name: "asc" },
    });
    const chalans = await tx.chalan.findMany({
      where: { id: { in: advances.map((a) => a.sourceRefId ?? "") } },
      select: { id: true, chalanNo: true, cancelReason: true, cancelledAt: true },
    });
    return { advances, parties, chalans, brokerOptions };
  });

  const partyName = new Map(parties.map((p) => [p.id, p.name]));
  const chalanOf = new Map(chalans.map((c) => [c.id, c]));

  const statusOf = (balance: number, consumed: number) =>
    balance <= 0.009 ? "RECOVERED" : consumed > 0.009 ? "PARTLY" : "OPEN";
  const chalanQ = searchParams.chalan?.trim().toLowerCase() ?? "";
  const rows = advances.map((a) => {
    const amount = toNum(String(a.amount));
    const consumed = toNum(String(a.consumedAmount));
    const balance = Math.round((amount - consumed) * 100) / 100;
    const chalan = a.sourceRefId ? chalanOf.get(a.sourceRefId) : undefined;
    return {
      id: a.id,
      date: a.date,
      chalanNo: a.voucherNo ?? chalan?.chalanNo ?? "",
      reason: chalan?.cancelReason ?? "",
      broker: partyName.get(a.partyId) ?? "",
      amount,
      consumed,
      balance,
      usedAgainst: a.uses
        .map((u) => `${u.refNo} ${formatMoney(toNum(String(u.amount)))}`)
        .join(", "),
      remarks: a.remarks ?? "",
      partyId: a.partyId,
      status: statusOf(balance, consumed),
    };
  }).filter(
    (r) =>
      (!chalanQ || r.chalanNo.toLowerCase().includes(chalanQ)) &&
      (!searchParams.broker || r.partyId === searchParams.broker) &&
      (!searchParams.status || r.status === searchParams.status)
  );

  const totalOpen = rows.reduce((s, r) => s + r.balance, 0);
  const filters: FilterDef[] = [
    { type: "daterange", key: "date", label: "Date" },
    { type: "text", key: "chalan", label: "Cancelled Chalan No" },
    {
      type: "combobox",
      key: "broker",
      label: "Broker / Owner",
      options: brokerOptions.map((b) => ({
        value: b.id,
        label: b.name,
        meta: [b.transportName, b.alias].filter(Boolean).join(" · ") || undefined,
      })),
    },
    {
      type: "select",
      key: "status",
      label: "Status",
      options: [
        { value: "OPEN", label: "Open" },
        { value: "PARTLY", label: "Partly Adjusted" },
        { value: "RECOVERED", label: "Recovered" },
      ],
    },
  ];

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="page-title flex items-center gap-2">
            Chalan Cancel Advance Register
            <InfoHint>
              Advances stuck on cancelled chalans (accident / rejection). Recover by receipt
              voucher, or adjust in the broker&apos;s next chalan — the adjustment grid offers
              these automatically. Set a date range to see EVERY row of that period (any
              year, recovered included); without one the register shows this FY plus every
              still-open advance.
            </InfoHint>
          </h1>
        </div>
        <div className="rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
          Open to recover: <b className="tabular-nums">{formatMoney(totalOpen)}</b>
        </div>
      </div>

      <FilterBar filters={filters} />

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/80">
            <tr>
              {["Date", "Cancelled Chalan", "Reason", "Broker / Owner", "Advance Amount", "Adjusted", "Balance", "Adjusted Against", "Status"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="h-20 text-center text-muted-foreground">
                  No cancelled-chalan advances — this register fills only when a chalan with
                  advances is cancelled.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t align-top hover:bg-muted/40">
                  <td className="whitespace-nowrap px-2 py-1.5">{formatDate(r.date.toISOString())}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-medium">
                    <Link href={`/chalan?id=${chalans.find((c) => c.chalanNo === r.chalanNo)?.id ?? ""}`} className="text-primary hover:underline">
                      {r.chalanNo}
                    </Link>
                  </td>
                  <td className="max-w-[16rem] whitespace-pre-wrap px-2 py-1.5 text-muted-foreground">{r.reason || "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{r.broker}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatMoney(r.amount)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatMoney(r.consumed)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right font-medium tabular-nums">{formatMoney(r.balance)}</td>
                  <td className="max-w-[18rem] whitespace-pre-wrap px-2 py-1.5 text-xs">{r.usedAgainst || "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {r.balance <= 0.009 ? (
                      <Badge>Recovered</Badge>
                    ) : r.consumed > 0 ? (
                      <Badge variant="secondary">Partly Adjusted</Badge>
                    ) : (
                      <Badge variant="destructive">Open</Badge>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
