import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, parseDdMmYyyy } from "@/lib/utils";
import { firmImageUrl } from "@/lib/branding";
import { PrintToolbar } from "@/app/print/invoice/[id]/print-toolbar";

export const dynamic = "force-dynamic";

/** statuses that mean the vehicle is idle → Available for Load (mirrors the tracking screen) */
const IDLE_STATUSES = ["EMPTY", "AVAILABLE", "UNLOADED", "TRIP COMPLETED", "AT YARD", "WAITING FOR LOAD"];
const isIdle = (status: string) => IDLE_STATUSES.includes(status.toUpperCase().trim());

/**
 * Printable Vehicle Tracking register — the same letterhead as the chalan and
 * bill-submission prints. `?date=dd/mm/yyyy` prints the as-on-date view,
 * `?view=available` prints the Available-for-Load list.
 */
export default async function VehicleTrackingPrintPage({
  searchParams,
}: {
  searchParams: { date?: string; view?: string };
}) {
  const session = requireSession();
  await authorize(session, "vehicle", "view");

  const asOf = parseDdMmYyyy(searchParams.date ?? "");
  const available = searchParams.view === "available";

  const { firm, vehicles, rows } = await withTenant(session.tenantId, async (tx) => {
    const [firm, vehicles, rows] = await Promise.all([
      tx.firm.findUnique({ where: { id: session.firmId } }),
      // tracking covers Own & Relative vehicles only — same set as the screen
      tx.vehicle.findMany({
        where: { isActive: true, ownershipType: { in: ["OWNER", "RELATIVE"] } },
        orderBy: { number: "asc" },
      }),
      tx.vehicleTracking.findMany({
        where: { firmId: session.firmId },
        orderBy: [{ vehicleId: "asc" }, { date: "asc" }],
      }),
    ]);
    return { firm, vehicles, rows };
  });
  const logoUrl = firmImageUrl(firm, "logo");

  const byVehicle = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byVehicle.get(r.vehicleId) ?? [];
    list.push(r);
    byVehicle.set(r.vehicleId, list);
  }

  const dayEnd = asOf ? new Date(asOf) : null;
  if (dayEnd) dayEnd.setHours(23, 59, 59, 999);

  // one row per vehicle: the latest snapshot (or the latest on/before the as-of date)
  const liveRows = vehicles.map((v) => {
    const hist = byVehicle.get(v.id) ?? [];
    const snap = dayEnd ? [...hist].reverse().find((s) => s.date <= dayEnd) : hist[hist.length - 1];
    return {
      vehicleId: v.id,
      vehicle: v.number,
      transporterName: snap?.transporterName ?? "",
      fromLocation: snap?.fromLocation ?? "",
      toLocation: snap?.toLocation ?? "",
      currentLocation: snap?.currentLocation ?? "",
      status: snap?.status ?? "",
      remarks: snap?.remarks ?? "",
      asOn: snap ? (dayEnd ? snap.date : snap.updatedAt) : null,
      hist,
    };
  });

  const today = new Date();
  const availableRows = liveRows
    .filter((r) => r.status && isIdle(r.status))
    .map((r) => {
      // walk history backwards to find when the current idle spell started
      let since: Date | null = null;
      for (let i = r.hist.length - 1; i >= 0; i--) {
        const st = r.hist[i].status ?? "";
        if (st && isIdle(st)) since = r.hist[i].date;
        else break;
      }
      const idleDays = Math.max(0, Math.floor((today.getTime() - (since ?? today).getTime()) / 86400000));
      return { ...r, availableSince: since, idleDays };
    })
    .sort((a, b) => b.idleDays - a.idleDays);

  const title = available ? "AVAILABLE FOR LOAD" : "VEHICLE TRACKING REPORT";
  const subtitle = asOf ? `As on ${formatDate(asOf)}` : `As on ${formatDate(today)} (current status)`;

  const th = "border border-black px-1.5 py-1 text-left";
  const td = "border border-black px-1.5 py-0.5";

  return (
    <div className="bg-white p-4 text-black">
      <style>{"@page { size: A4 landscape; margin: 8mm; }"}</style>
      <PrintToolbar wide />
      <div className="mx-auto max-w-[277mm] border border-black p-6 text-sm">
        {/* company letterhead — logo left, firm details centred */}
        <div className="flex items-center gap-3 border-b-2 border-black pb-3">
          {logoUrl && (
            <div className="flex w-[110px] shrink-0 items-center justify-center">
              <img src={logoUrl} alt="" className="max-h-[64px] max-w-[110px] object-contain" />
            </div>
          )}
          <div className="min-w-0 flex-1 text-center">
            <div className="text-2xl font-bold uppercase">{firm?.name}</div>
            <div className="text-xs">{[firm?.address1, firm?.address2].filter(Boolean).join(", ")}</div>
            <div className="text-xs">
              {[
                firm?.mobile && `Mob: ${firm.mobile}`,
                firm?.email && `Email: ${firm.email}`,
                firm?.gstin && `GSTIN: ${firm.gstin}`,
                firm?.pan && `PAN: ${firm.pan}`,
              ]
                .filter(Boolean)
                .join(" | ")}
            </div>
          </div>
          {/* mirrors the logo column so the firm details sit dead centre */}
          {logoUrl && <div className="w-[110px] shrink-0" />}
        </div>

        <div className="mt-3 flex items-end justify-between">
          <div className="text-base font-bold underline">{title}</div>
          <div className="text-xs">
            <b>{subtitle}</b>
          </div>
        </div>

        {available ? (
          <table className="mt-3 w-full border-collapse text-xs">
            <thead>
              <tr>
                {["S.No.", "Vehicle No", "Transporter Name", "Current Location", "Available Since", "Idle Days", "Status", "Remarks"].map(
                  (h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {availableRows.length === 0 && (
                <tr>
                  <td colSpan={8} className={`${td} py-2 text-center`}>
                    No vehicle is available for load.
                  </td>
                </tr>
              )}
              {availableRows.map((r, i) => (
                <tr key={r.vehicleId}>
                  <td className={td}>{i + 1}</td>
                  <td className={`${td} font-semibold`}>{r.vehicle}</td>
                  <td className={td}>{r.transporterName}</td>
                  <td className={td}>{r.currentLocation}</td>
                  <td className={td}>{r.availableSince ? formatDate(r.availableSince) : ""}</td>
                  <td className={`${td} text-right`}>{r.idleDays}</td>
                  <td className={td}>{r.status}</td>
                  <td className={td}>{r.remarks}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={8} className={td}>
                  Total Vehicles Available: {availableRows.length}
                </td>
              </tr>
            </tfoot>
          </table>
        ) : (
          <table className="mt-3 w-full border-collapse text-xs">
            <thead>
              <tr>
                {[
                  "S.No.",
                  "Vehicle No",
                  "Transporter Name",
                  "From",
                  "To",
                  "Current Location",
                  "Status",
                  "Remarks",
                  asOf ? "As On" : "Last Updated",
                ].map((h) => (
                  <th key={h} className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {liveRows.map((r, i) => (
                <tr key={r.vehicleId}>
                  <td className={td}>{i + 1}</td>
                  <td className={`${td} font-semibold`}>{r.vehicle}</td>
                  <td className={td}>{r.transporterName}</td>
                  <td className={td}>{r.fromLocation}</td>
                  <td className={td}>{r.toLocation}</td>
                  <td className={td}>{r.currentLocation}</td>
                  <td className={td}>{r.status}</td>
                  <td className={td}>{r.remarks}</td>
                  <td className={td}>{r.asOn ? formatDate(r.asOn) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={9} className={td}>
                  Total Vehicles: {liveRows.length}
                </td>
              </tr>
            </tfoot>
          </table>
        )}

        <div className="mt-10 flex justify-between text-xs font-semibold">
          <div>Prepared By</div>
          <div>For {firm?.name}</div>
        </div>
      </div>
    </div>
  );
}
