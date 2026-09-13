"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { MasterOption } from "@/components/data/master-combobox";
import { SimpleMaster } from "@/components/masters/simple-master";
import { vehicleDefaults, vehicleFields } from "@/components/masters/field-defs";
import { PartyCreateDialog } from "@/components/masters/inline-dialogs";
import { saveVehicle, deleteVehicle, importVehicles } from "@/app/(app)/masters/vehicles/actions";

interface Row {
  id: string;
  number: string;
  isOwn: boolean;
  ownershipType: string; // OWNER | BROKER | RELATIVE
  ownerId: string | null;
  ownerName: string | null; // linked party name
  ownerNames: string | null; // legacy free-text owners
  chassisNo: string | null;
  engineNo: string | null;
  vehicleType: string | null;
  permitNo: string | null;
  insuranceNo: string | null;
}

const OWNERSHIP_LABEL: Record<string, string> = {
  OWNER: "Owner",
  BROKER: "Broker",
  RELATIVE: "Relative",
};

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "number", header: "Vehicle No" },
  {
    id: "ownership",
    header: "Ownership",
    cell: ({ row }) => (
      <Badge
        variant={
          row.original.ownershipType === "OWNER"
            ? "default"
            : row.original.ownershipType === "RELATIVE"
              ? "outline"
              : "secondary"
        }
      >
        {OWNERSHIP_LABEL[row.original.ownershipType] ?? row.original.ownershipType}
      </Badge>
    ),
  },
  {
    id: "person",
    header: "Name",
    cell: ({ row }) => row.original.ownerName ?? row.original.ownerNames ?? "-",
  },
  { accessorKey: "vehicleType", header: "Type" },
  {
    id: "spareParts",
    header: "Spare Parts",
    cell: ({ row }) => (
      // the vehicle's spare-parts history (operational module) — stop the
      // click reaching the row, which opens the edit dialog
      <Link
        href={`/vehicle/spare-parts?tab=vehicle&vehicleId=${row.original.id}`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <Wrench className="h-3.5 w-3.5" /> Spare Parts History
      </Link>
    ),
  },
];

export function VehiclesClient({
  rows,
  ownerOptions,
  canDelete,
}: {
  rows: Row[];
  ownerOptions: MasterOption[];
  canDelete: boolean;
}) {
  return (
    <SimpleMaster
      title="Vehicle"
      rows={rows}
      columns={columns}
      exportColumns={[
        { header: "Vehicle No", key: "number" },
        { header: "Ownership", accessor: (r) => OWNERSHIP_LABEL[r.ownershipType] ?? r.ownershipType },
        { header: "Name", accessor: (r) => r.ownerName ?? r.ownerNames ?? "" },
        { header: "Type", key: "vehicleType" },
        { header: "Chassis No", key: "chassisNo" },
        { header: "Engine No", key: "engineNo" },
        { header: "Permit No", key: "permitNo" },
        { header: "Insurance No", key: "insuranceNo" },
      ]}
      exportName="vehicles"
      filters={[
        { type: "text", key: "q", label: "Search vehicle no..." },
        {
          type: "select",
          key: "own",
          label: "Ownership",
          options: [
            { value: "OWN", label: "Owner" },
            { value: "MARKET", label: "Broker / Relative" },
          ],
        },
      ]}
      // same field list as the inline "+ Create vehicle" dialog (field-defs.tsx)
      fields={vehicleFields({
        ownerOptions,
        ownerCreate: (p) => <PartyCreateDialog {...p} defaultGroup="OWNER_BROKER" />,
      })}
      defaults={vehicleDefaults}
      toForm={(r) => ({
        number: r.number,
        ownershipType: r.ownershipType,
        ownerId: r.ownerId,
        vehicleType: r.vehicleType ?? "",
        chassisNo: r.chassisNo ?? "",
        engineNo: r.engineNo ?? "",
        permitNo: r.permitNo ?? "",
        insuranceNo: r.insuranceNo ?? "",
      })}
      getId={(r) => r.id}
      save={saveVehicle}
      remove={deleteVehicle}
      refKind="vehicle"
      deleteMode="deactivate"
      importConfig={{
        action: importVehicles,
        templateHeaders: ["Vehicle No", "Ownership", "Name", "Type", "Chassis No", "Engine No", "Permit No", "Insurance No"],
        templateExample: ["CG04AB1234", "BROKER", "DEMO TRANSPORT CO", "TRAILER", "", "", "", ""],
        templateName: "vehicles",
      }}
      canDelete={canDelete}
    />
  );
}
