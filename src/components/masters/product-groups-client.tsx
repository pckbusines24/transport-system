"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { SimpleMaster } from "@/components/masters/simple-master";
import { productGroupDefaults, productGroupFields } from "@/components/masters/field-defs";
import { saveProductGroup, deleteProductGroup, importProductGroups } from "@/app/(app)/masters/product-groups/actions";

interface Row {
  id: string;
  name: string;
  products: number;
}

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "products", header: "Products", meta: { numeric: true } },
];

export function ProductGroupsClient({
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
      title="Product Group"
      embedded={embedded}
      rows={rows}
      columns={columns}
      exportColumns={[
        { header: "Name", key: "name" },
        { header: "Products", key: "products", numeric: true },
      ]}
      exportName="product-groups"
      filters={[{ type: "text", key: "q", label: "Search name..." }]}
      fields={productGroupFields}
      defaults={productGroupDefaults}
      toForm={(r) => ({ name: r.name })}
      getId={(r) => r.id}
      save={saveProductGroup}
      remove={deleteProductGroup}
      importConfig={{
        action: importProductGroups,
        templateHeaders: ["Group"],
        templateExample: ["STEEL"],
        templateName: "product-groups",
      }}
      canDelete={canDelete}
    />
  );
}
