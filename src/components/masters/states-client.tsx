"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { SimpleMaster } from "@/components/masters/simple-master";
import { saveState, deleteState, importStates } from "@/app/(app)/masters/states/actions";

interface Row {
  id: string;
  name: string;
  gstCode: string;
}

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "gstCode", header: "GST Code" },
];

export function StatesClient({ rows, canDelete }: { rows: Row[]; canDelete: boolean }) {
  return (
    <SimpleMaster
      title="State"
      rows={rows}
      columns={columns}
      exportColumns={[
        { header: "Name", key: "name" },
        { header: "GST Code", key: "gstCode" },
      ]}
      exportName="states"
      filters={[{ type: "text", key: "q", label: "Search name..." }]}
      fields={[
        { name: "name", label: "Name *", type: "text", uppercase: true },
        { name: "gstCode", label: "GST Code", type: "text" },
      ]}
      defaults={{ name: "", gstCode: "" }}
      toForm={(r) => ({ name: r.name, gstCode: r.gstCode })}
      getId={(r) => r.id}
      save={saveState}
      remove={deleteState}
      refKind="state"
      importConfig={{
        action: importStates,
        templateHeaders: ["State", "GST Code"],
        templateExample: ["CHHATTISGARH", "22"],
        templateName: "states",
      }}
      canDelete={canDelete}
    />
  );
}
