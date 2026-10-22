import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { getVehicleOptions } from "@/lib/lookups";
import { toNum } from "@/lib/utils";
import { FilterBar } from "@/components/data/filter-bar";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import { PodRegisterTable, type PodRegisterRow } from "@/components/pod/pod-register-table";
import type { Prisma, PodSourceType } from "@prisma/client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

const SOURCE_TYPES = [
  "BOOKING",
  "OUTWARD_CROSSING",
  "CROSSING_CHALLAN",
  "GATE_PASS",
  "BROKER_SLIP",
] as const;

export default async function PodRegisterPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "pod", "view");

  const dateFrom = searchParams.date_from ? new Date(searchParams.date_from + "T00:00:00") : null;
  const dateTo = searchParams.date_to ? new Date(searchParams.date_to + "T23:59:59.999") : null;
  const status = searchParams.status;
  const sourceType = SOURCE_TYPES.includes(searchParams.sourceType as PodSourceType)
    ? (searchParams.sourceType as PodSourceType)
    : undefined;
  const vehicleId = searchParams.vehicle;
  const page = parsePage(searchParams.page);

  const [{ pods, total }, vehicleOptions] = await Promise.all([
    withTenant(session.tenantId, async (tx) => {
      // date filter beats FY (FY continuity): dates set → any year's PODs
      const where: Prisma.PodWhereInput = {
        firmId: session.firmId,
        ...(dateFrom || dateTo
          ? { docDate: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } }
          : { fyId: session.fyId }),
        // Pending  = the LR's chalan is still awaiting balance payment
        // Completed = POD done AND the chalan's balance payment is finalized
        ...(status === "PENDING"
          ? {
              lr: {
                chalanLrs: {
                  some: { chalan: { deletedAt: null, paymentStatus: { not: "PAID" } } },
                },
              },
            }
          : status === "COMPLETED"
            ? {
                status: "COMPLETED",
                lr: {
                  chalanLrs: { some: { chalan: { deletedAt: null, paymentStatus: "PAID" } } },
                },
              }
            : {}),
        ...(sourceType ? { sourceType } : {}),
        ...(vehicleId ? { vehicleId } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.pod.findMany({
          where,
          include: { lr: { include: { chalanLrs: { include: { chalan: true } } } } },
          orderBy: { docDate: "desc" },
          take: PAGE_SIZE,
          skip: (page - 1) * PAGE_SIZE,
        }),
        tx.pod.count({ where }),
      ]);
      const vehicleIds = Array.from(new Set(rows.map((r) => r.vehicleId).filter(Boolean))) as string[];
      const vehicles = await tx.vehicle.findMany({
        where: { id: { in: vehicleIds } },
        select: { id: true, number: true },
      });
      const vmap = new Map(vehicles.map((v) => [v.id, v.number]));
      const mapped = rows.map(
        (p): PodRegisterRow => ({
          id: p.id,
          docNo: p.docNo,
          docDate: p.docDate.toISOString(),
          lrNo: p.lr?.lrNo ?? "",
          vehicle: (p.vehicleId && vmap.get(p.vehicleId)) || "",
          ackNo: p.ackNo ?? "",
          unloadDate: p.unloadDate ? p.unloadDate.toISOString() : null,
          poNumber: p.poNumber ?? "",
          gateEntryNo: p.gateEntryNo ?? "",
          recWt: p.recWt === null ? null : toNum(String(p.recWt)),
          shortageWt: p.shortageWt === null ? null : toNum(String(p.shortageWt)),
          filePath: p.filePath,
          status: p.status,
          balancePaid:
            (p.lr?.chalanLrs ?? []).some(
              (cl) => !cl.chalan.deletedAt && cl.chalan.paymentStatus === "PAID"
            ),
          sourceType: p.sourceType,
          remarks: p.remarks ?? "",
        })
      );
      return { pods: mapped, total };
    }),
    getVehicleOptions(),
  ]);

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">POD Register</h1>
      <FilterBar
        filters={[
          { type: "daterange", key: "date", label: "Date" },
          {
            type: "select",
            key: "status",
            label: "Status",
            options: [
              { value: "COMPLETED", label: "Completed" },
              { value: "PENDING", label: "Pending" },
            ],
          },
          {
            type: "select",
            key: "sourceType",
            label: "Source Type",
            options: SOURCE_TYPES.map((s) => ({ value: s, label: s.replace(/_/g, " ") })),
          },
          {
            type: "combobox",
            key: "vehicle",
            label: "Vehicle",
            options: vehicleOptions.map((v) => ({ value: v.value, label: v.label })),
          },
        ]}
      />
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/pod/register"
        searchParams={searchParams}
        hideSinglePage
      />
      <PodRegisterTable rows={pods} canDelete={session.role === "ADMIN" || session.role === "OWNER"} />
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/pod/register"
        searchParams={searchParams}
      />
    </div>
  );
}
