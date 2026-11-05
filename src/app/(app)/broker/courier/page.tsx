import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import {
  CourierDispatchClient,
  type CourierDispatchRow,
} from "@/components/broker/courier-dispatch-client";
import { rankByMatch } from "@/lib/search-rank";
import { istDayEnd, istDayStart } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function CourierDispatchPage({
  searchParams,
}: {
  searchParams: { date_from?: string; date_to?: string; q?: string; vehicle?: string };
}) {
  const session = requireSession();
  await authorize(session, "courier", "view");
  const { date_from, date_to, q, vehicle } = searchParams;

  const dispatches = await withTenant(session.tenantId, (tx) => {
    const where: Prisma.CourierDispatchWhereInput = {
      firmId: session.firmId,
      fyId: session.fyId,
      deletedAt: null,
    };
    if (date_from || date_to) {
      where.dispatchDate = {
        ...(date_from ? { gte: istDayStart(date_from) } : {}),
        ...(date_to ? { lte: istDayEnd(date_to) } : {}),
      };
    }
    if (q) {
      where.OR = [
        { dispatchNo: { contains: q, mode: "insensitive" } },
        { courierCompany: { contains: q, mode: "insensitive" } },
        { trackingNo: { contains: q, mode: "insensitive" } },
        { partyName: { contains: q, mode: "insensitive" } },
      ];
    }
    if (vehicle) {
      // a dispatch matches when ANY of its vehicle rows matches
      where.items = {
        some: { vehicleNo: { contains: vehicle.replace(/\s+/g, ""), mode: "insensitive" } },
      };
    }
    return tx.courierDispatch.findMany({
      where,
      include: { items: true },
      orderBy: [{ dispatchDate: "desc" }, { createdAt: "desc" }],
    })
      // exact match on the typed search first
      .then((rows) => rankByMatch(rows, q ?? "", (r) => [r.dispatchNo, r.courierCompany, r.trackingNo, r.partyName]));
  });

  const rows: CourierDispatchRow[] = dispatches.map((d) => ({
    id: d.id,
    dispatchNo: d.dispatchNo,
    dispatchDate: d.dispatchDate.toISOString(),
    courierCompany: d.courierCompany,
    trackingNo: d.trackingNo ?? "",
    partyName: d.partyName,
    remarks: d.remarks ?? "",
    attachmentPath: d.attachmentPath,
    attachmentName: d.attachmentName ?? "",
    items: d.items.map((it) => ({
      vehicleNo: it.vehicleNo,
      documentDetails: it.documentDetails,
      remarks: it.remarks ?? "",
    })),
  }));

  return (
    <div className="space-y-4 p-4">
      <CourierDispatchClient
        rows={rows}
        canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      />
    </div>
  );
}
