"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { SimpleMaster } from "@/components/masters/simple-master";
import { unitDefaults, unitFields } from "@/components/masters/field-defs";
import { saveUnit, deleteUnit, importUnits } from "@/app/(app)/masters/units/actions";

interface Row {
  id: string;
  name: string;
  value: number;
}

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "value", header: "Value", meta: { numeric: true } },
];

export function UnitsClient({
  rows,
  canDelete,
  embedded,
}: {
  rows: Row[];
  canDelete: boolean;
  embedded?: boolean;
}) {
  return (
    <SimpleMaster
      title="Unit"
      embedded={embedded}
      rows={rows}
      columns={columns}
      exportColumns={[
        { header: "Name", key: "name" },
        { header: "Value", key: "value", numeric: true },
      ]}
      exportName="units"
      filters={[{ type: "text", key: "q", label: "Search name..." }]}
      fields={unitFields}
      defaults={unitDefaults}
      toForm={(r) => ({ name: r.name, value: String(r.value) })}
      getId={(r) => r.id}
      save={saveUnit}
      remove={deleteUnit}
      importConfig={{
        action: importUnits,
        templateHeaders: ["Unit", "Value"],
        templateExample: ["MT", "1"],
        templateName: "units",
      }}
      canDelete={canDelete}
    />
  );
}
