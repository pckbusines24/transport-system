import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, formatMoney, istDayEnd, istDayStart, toNum } from "@/lib/utils";
import { waLink } from "@/lib/phone";
import { InfoHint } from "@/components/ui/info-hint";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { ExportButton } from "@/components/data/export-button";

export const dynamic = "force-dynamic";

/**
 * POD & Billing Follow-up — the working-capital screen.
 *
 * An LR enters this list once `Firm.podFollowUpDays` days have passed since
 * its LR DATE (not delivery date — an LR that never even got delivered is
 * caught too) and its POD is still not received. The follow-up CONTACT is
 * derived from the chalan the LR travelled on: a market/broker vehicle names
 * the broker with his mobile, an own/relative vehicle names the driver
 * assigned on that date with his mobile. Numbers are click-to-call /
 * WhatsApp. A second stage lists LRs whose POD is back but no bill exists.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 24 * 3600 * 1000;
/** a date's IST calendar day as yyyy-mm-dd */
const istIso = (d: Date) => formatDate(d).split("/").reverse().join("-");
/** whole IST calendar days from `d` to today (an LR dated today is 0) */
const istDaysOld = (d: Date, todayIso: string) =>
  Math.round((istDayStart(todayIso).getTime() - istDayStart(istIso(d)).getTime()) / DAY_MS);

type FollowRow = {
  lrId: string;
  lrNo: string;
  lrDate: Date;
  daysOld: number;
  party: string;
  route: string;
  amount: number;
  vehicleNo: string;
  ownership: string;
  contactName: string;
  contactMobile: string;
  contactRole: string;
  delivered: boolean;
};

export default async function PodFollowUpPage({
  searchParams,
}: {
  searchParams: { stage?: string; contact?: string; date_from?: string; date_to?: string; min_days?: string };
}) {
  const session = requireSession();
  await authorize(session, "pod", "view");
  const stage = searchParams.stage === "BILL" ? "BILL" : "POD";
  // LR date period, IST day boundaries like every other date filter
  const dateFrom = searchParams.date_from ? istDayStart(searchParams.date_from) : null;
  const dateTo = searchParams.date_to ? istDayEnd(searchParams.date_to) : null;
  // "N days and above": replaces the firm's follow-up threshold for this view
  const minDaysRaw = parseInt(searchParams.min_days ?? "", 10);
  const minDays = Number.isFinite(minDaysRaw) && minDaysRaw >= 0 ? minDaysRaw : null;
  const todayIso = istIso(new Date());

  const data = await withTenant(session.tenantId, async (tx) => {
    const firm = await tx.firm.findUniqueOrThrow({ where: { id: session.firmId } });
    const days = minDays ?? firm.podFollowUpDays ?? 15;
    // at least `days` IST calendar days old = dated on or before this IST day
    const cutoff = istDayEnd(istIso(new Date(istDayStart(todayIso).getTime() - days * DAY_MS)));

    const lrs = await tx.lr.findMany({
      where: {
        // FY continuity: an old-year LR still missing its POD stays chased here
        firmId: session.firmId,
        deletedAt: null,
        lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] },
        lrDate: {
          lte: dateTo && dateTo < cutoff ? dateTo : cutoff,
          ...(dateFrom ? { gte: dateFrom } : {}),
        },
        ...(stage === "POD"
          ? // POD stage: no completed POD yet
            { pods: { none: { status: "COMPLETED" } } }
          : // BILL stage: POD is back, but the LR is on no live bill
            {
              pods: { some: { status: "COMPLETED" } },
              invoiceLrs: { none: {} },
            }),
      },
      include: { chalanLrs: { include: { chalan: true } } },
      orderBy: { lrDate: "asc" },
      take: 500,
    });

    const [cities, parties, vehicles, drivers, assignments] = await Promise.all([
      tx.city.findMany({ select: { id: true, name: true } }),
      tx.party.findMany({ select: { id: true, name: true, mobile: true, phone: true } }),
      tx.vehicle.findMany({ select: { id: true, number: true, ownershipType: true } }),
      tx.driver.findMany({
        where: { firmId: session.firmId, deletedAt: null },
        select: { id: true, name: true, mobile: true },
      }),
      tx.driverAssignment.findMany(),
    ]);
    return { days, lrs, cities, parties, vehicles, drivers, assignments };
  });

  const { days, lrs, cities, parties, vehicles, drivers, assignments } = data;
  const cityName = new Map(cities.map((c) => [c.id, c.name]));
  const partyById = new Map(parties.map((p) => [p.id, p]));
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  const driverById = new Map(drivers.map((d) => [d.id, d]));

  const driverAt = (vehicleId: string, at: Date) => {
    const a = assignments.find(
      (x) => x.vehicleId === vehicleId && x.fromDate <= at && (!x.toDate || x.toDate >= at)
    );
    return a ? driverById.get(a.driverId) : undefined;
  };

  const rows: FollowRow[] = lrs.map((lr) => {
    // the most recent chalan this LR travelled on decides who holds the POD
    const chalan = lr.chalanLrs
      .map((cl) => cl.chalan)
      .filter((c) => !c.deletedAt)
      .sort((a, b) => b.chalanDate.getTime() - a.chalanDate.getTime())[0];
    const vehicle = chalan ? vehicleById.get(chalan.vehicleId) : undefined;
    let contactName = "";
    let contactMobile = "";
    let contactRole = "";
    if (chalan && vehicle) {
      if (vehicle.ownershipType === "BROKER") {
        const broker = partyById.get(chalan.brokerId);
        contactName = chalan.transportName || broker?.name || chalan.ownerName || "";
        contactMobile = broker?.mobile || broker?.phone || "";
        contactRole = "Broker / Owner";
      } else {
        const drv = driverAt(chalan.vehicleId, chalan.chalanDate);
        contactName = drv?.name || chalan.driverName || "";
        contactMobile = drv?.mobile || "";
        contactRole = vehicle.ownershipType === "RELATIVE" ? "Driver (Relative veh.)" : "Driver";
      }
    }
    const billParty = partyById.get(lr.billToId ?? "") ?? partyById.get(lr.consignorId);
    return {
      lrId: lr.id,
      lrNo: lr.lrNo,
      lrDate: lr.lrDate,
      daysOld: istDaysOld(lr.lrDate, todayIso),
      party: billParty?.name ?? "",
      route: `${cityName.get(lr.sourceCityId) ?? ""} → ${cityName.get(lr.destCityId) ?? ""}`,
      amount: r2(toNum(String(lr.total))),
      vehicleNo: vehicle?.number ?? "",
      ownership: vehicle
        ? vehicle.ownershipType === "OWNER"
          ? "Own"
          : vehicle.ownershipType === "RELATIVE"
            ? "Relative"
            : "Market"
        : "",
      contactName,
      contactMobile,
      contactRole,
      delivered: lr.status === "DELIVERED" || lr.status === "BILLED",
    };
  });

  // person-wise grouping: one call collects many PODs
  const byContact = new Map<string, { name: string; mobile: string; count: number; amount: number }>();
  for (const rw of rows) {
    const key = rw.contactName || "(no contact)";
    const acc = byContact.get(key) ?? { name: key, mobile: rw.contactMobile, count: 0, amount: 0 };
    acc.count += 1;
    acc.amount = r2(acc.amount + rw.amount);
    byContact.set(key, acc);
  }
  const contactGroups = Array.from(byContact.values()).sort((a, b) => b.amount - a.amount);

  const filtered = searchParams.contact
    ? rows.filter((rw) => (rw.contactName || "(no contact)") === searchParams.contact)
    : rows;
  const totalAmount = r2(filtered.reduce((s, rw) => s + rw.amount, 0));

  const ageBadge = (d: number) =>
    d > days + 7 ? (
      <Badge variant="destructive">{d} days</Badge>
    ) : (
      <Badge variant="outline">{d} days</Badge>
    );

  const filters: FilterDef[] = [
    {
      type: "select",
      key: "stage",
      label: "Stage",
      options: [
        { value: "POD", label: "POD Pending" },
        { value: "BILL", label: "POD Received — Bill Pending" },
      ],
    },
    { type: "daterange", key: "date", label: "LR Date" },
    { type: "text", key: "min_days", label: "Min Days (and above)" },
    {
      type: "select",
      key: "contact",
      label: "Follow-up Person",
      options: contactGroups.map((g) => ({ value: g.name, label: `${g.name} (${g.count})` })),
    },
  ];

  const cell = "border px-2 py-1";
  // plain values only: the export button is a client component, so no
  // accessor functions can cross from this server page
  const exportRows = filtered.map((rw) => ({
    lrNo: rw.lrNo,
    lrDate: formatDate(rw.lrDate),
    daysOld: rw.daysOld,
    party: rw.party,
    route: rw.route,
    amount: rw.amount,
    vehicle: rw.vehicleNo ? `${rw.vehicleNo} (${rw.ownership})` : "",
    delivered: rw.delivered ? "YES" : "NO",
    contact: rw.contactName ? `${rw.contactName} (${rw.contactRole})` : "",
    mobile: rw.contactMobile,
  }));
  // contact chips narrow the list without dropping the date / days filters
  const keepParams: Record<string, string> = {};
  for (const k of ["date_from", "date_to", "min_days"] as const) {
    const v = searchParams[k];
    if (v) keepParams[k] = v;
  }

  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title flex items-center gap-2">
        POD &amp; Billing Follow-up
        <InfoHint>
          LRs {days} or more days old from the LR date (default threshold in Settings → Firm; the
          Min Days filter overrides it).
          {stage === "POD"
            ? " Shows LRs whose POD has not arrived — the broker's number for market vehicles, that day's driver for own/relative vehicles, with one-click call/WhatsApp."
            : " Shows LRs whose POD is in but the bill is not yet made — revenue waiting only on billing."}
        </InfoHint>
      </h1>
      <FilterBar filters={filters} />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={stage === "POD" ? "POD Pending LRs" : "Bill Pending LRs"}
          value={filtered.length}
        />
        <StatCard label="Freight on Hold" value={formatMoney(totalAmount)} />
        <StatCard label="Follow-up People" value={contactGroups.length} />
      </div>

      {stage === "POD" && contactGroups.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Pending PODs by Contact</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-sm">
            {contactGroups.slice(0, 12).map((g) => (
              <a
                key={g.name}
                href={`?${new URLSearchParams({
                  ...keepParams,
                  stage: "POD",
                  contact: g.name,
                }).toString()}`}
                className="rounded-md border px-2 py-1 hover:bg-muted"
              >
                <b>{g.name}</b> — {g.count} POD · {formatMoney(g.amount)}
                {g.mobile && <span className="ml-1 text-muted-foreground">({g.mobile})</span>}
              </a>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <ExportButton
          rows={exportRows}
          fileName={stage === "POD" ? "pod-follow-up" : "bill-pending-follow-up"}
          sheetName={stage === "POD" ? "POD Pending" : "Bill Pending"}
          columns={[
            { header: "LR No", key: "lrNo" },
            { header: "LR Date", key: "lrDate" },
            { header: "Days", key: "daysOld", numeric: true },
            { header: "Party", key: "party" },
            { header: "Route", key: "route" },
            { header: "Freight", key: "amount", numeric: true },
            { header: "Vehicle", key: "vehicle" },
            { header: "Delivered?", key: "delivered" },
            { header: "Follow-up", key: "contact" },
            { header: "Mobile", key: "mobile" },
          ]}
          summary={[
            { label: "LRs", value: filtered.length },
            { label: "Freight on Hold", value: totalAmount },
          ]}
        />
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {[
                "LR No",
                "LR Date",
                "Days",
                "Party",
                "Route",
                "Freight",
                "Vehicle",
                "Delivered?",
                "Follow-up",
                "Mobile",
              ].map((h) => (
                <th key={h} className={`${cell} bg-muted/60 text-left font-semibold`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((rw) => (
              <tr key={rw.lrId}>
                <td className={`${cell} font-medium`}>
                  <a
                    className="text-primary hover:underline"
                    href={`/print/lr/${rw.lrId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {rw.lrNo}
                  </a>
                </td>
                <td className={cell}>{formatDate(rw.lrDate.toISOString())}</td>
                <td className={cell}>{ageBadge(rw.daysOld)}</td>
                <td className={cell}>{rw.party}</td>
                <td className={cell}>{rw.route}</td>
                <td className={`${cell} text-right tabular-nums`}>{formatMoney(rw.amount)}</td>
                <td className={cell}>
                  {rw.vehicleNo ? `${rw.vehicleNo} (${rw.ownership})` : "—"}
                </td>
                <td className={cell}>
                  {rw.delivered ? (
                    <Badge variant="secondary">YES</Badge>
                  ) : (
                    <Badge variant="destructive" title="No delivery entry yet — this LR is stuck">
                      NO
                    </Badge>
                  )}
                </td>
                <td className={cell}>
                  {rw.contactName ? (
                    <>
                      {rw.contactName}
                      <span className="ml-1 text-muted-foreground">({rw.contactRole})</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={`${cell} whitespace-nowrap`}>
                  {rw.contactMobile ? (
                    <>
                      <a className="text-primary hover:underline" href={`tel:${rw.contactMobile}`}>
                        {rw.contactMobile}
                      </a>{" "}
                      {waLink(rw.contactMobile) && (
                        <a
                          className="text-emerald-600 hover:underline"
                          href={waLink(rw.contactMobile)!}
                          target="_blank"
                          rel="noreferrer"
                        >
                          WA
                        </a>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={10} className={`${cell} py-6 text-center text-muted-foreground`}>
                  {stage === "POD"
                    ? `No PODs pending — everything within ${days} days is clear.`
                    : "Every LR with a received POD has been billed."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
