"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { SimpleMaster } from "@/components/masters/simple-master";
import { saveDocumentType, deleteDocumentType, importDocumentTypes } from "@/app/(app)/masters/document-master/actions";

interface Row {
  id: string;
  name: string;
  description: string | null;
  showReminder: boolean;
  reminderDays: number;
}

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "description", header: "Description" },
  {
    accessorKey: "showReminder",
    header: "Reminder",
    cell: ({ row }) =>
      row.original.showReminder ? <Badge>Yes</Badge> : <Badge variant="secondary">No</Badge>,
  },
];

export function DocumentMasterClient({
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
      title="Document Type"
      embedded={embedded}
      rows={rows}
      columns={columns}
      exportColumns={[
        { header: "Name", key: "name" },
        { header: "Description", key: "description" },
        { header: "Reminder", accessor: (r) => (r.showReminder ? "Yes" : "No") },
      ]}
      exportName="document-types"
      filters={[{ type: "text", key: "q", label: "Search name..." }]}
      fields={[
        { name: "name", label: "Name *", type: "text" },
        { name: "showReminder", label: "Show Reminder", type: "switch" },
        {
          name: "reminderDays",
          label: "Remind Before Expiry (days) — 15 / 30 / 45 / 60 / 90 or custom",
          type: "number",
        },
        { name: "description", label: "Description", type: "textarea", span2: true },
      ]}
      defaults={{ name: "", description: "", showReminder: true, reminderDays: 30 }}
      toForm={(r) => ({
        name: r.name,
        description: r.description ?? "",
        showReminder: r.showReminder,
        reminderDays: r.reminderDays,
      })}
      getId={(r) => r.id}
      save={saveDocumentType}
      remove={deleteDocumentType}
      refKind="documentType"
      importConfig={{
        action: importDocumentTypes,
        templateHeaders: ["Name", "Description", "Reminder Days"],
        templateExample: ["INSURANCE", "Vehicle insurance", "30"],
        templateName: "document-types",
      }}
      canDelete={canDelete}
    />
  );
}
