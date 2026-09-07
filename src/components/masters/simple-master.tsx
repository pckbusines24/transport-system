"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getMasterReferences } from "@/app/(app)/masters/_lib/ref-actions";
import type { MasterKind, MasterRefReport } from "@/lib/master-refs";
import { DeletePrecheckDialog } from "@/components/data/delete-precheck";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { DataTable } from "@/components/data/data-table";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { MultiCombobox } from "@/components/data/multi-combobox";
import { DateInput } from "@/components/data/date-input";
import { ExportButton, type ExportColumn } from "@/components/data/export-button";
import { ImportButton, type ImportConfig } from "@/components/data/import-button";

export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

export type FormState = Record<string, unknown>;

export interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (option: MasterOption) => void;
}

export interface FieldDef {
  name: string;
  label: string;
  type: "text" | "number" | "textarea" | "switch" | "select" | "combobox" | "multicombobox" | "date" | "radio";
  options?: MasterOption[];
  /** options that depend on the form or on which record is being edited
   *  (e.g. mark choices owned by ANOTHER record as disabled) */
  optionsFor?: (ctx: { form: FormState; editingId: string | null }) => MasterOption[];
  placeholder?: string;
  /** Render field only when true. */
  visibleIf?: (form: FormState) => boolean;
  /** Inline "+ create" dialog for combobox fields. */
  createDialog?: (props: CreateDialogProps) => React.ReactNode;
  /** Label of the "+ Create" row in the combobox list. */
  createLabel?: string;
  /** Span both columns of the dialog grid. */
  span2?: boolean;
  uppercase?: boolean;
}

export interface MasterFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Record name used in the title ("New Product") and the saved toast. */
  entity: string;
  fields: FieldDef[];
  /** Form values when the dialog opens (defaults for a new record, the row for an edit). */
  initial: FormState;
  /** Set when editing; sent as `id` in the save payload. */
  editingId?: string | null;
  save: (input: unknown) => Promise<ActionResult>;
  /** Optional payload transform before calling `save`. */
  transform?: (form: FormState) => unknown;
  /** Extra content rendered below the fields (hints, computed values). */
  renderExtra?: (form: FormState, set: (name: string, value: unknown) => void) => React.ReactNode;
  dialogClassName?: string;
  /** Called after a successful save. The caller decides whether to close. */
  onSaved: (id: string, form: FormState) => void | Promise<void>;
  /** Delete handler for the edit dialog; the button shows only when provided. */
  onDelete?: () => Promise<void>;
  /** button text — "Deactivate" for masters that are hidden rather than removed */
  deleteLabel?: string;
}

/**
 * The master record form: the SAME dialog whether it is opened from the
 * master screen (SimpleMaster) or from a "+ Create" row of a combobox on a
 * transaction form (see inline-dialogs.tsx). Field definitions live in
 * field-defs.tsx so both paths render identical fields and validation.
 */
export function MasterFormDialog({
  open,
  onOpenChange,
  entity,
  fields,
  initial,
  editingId,
  save,
  transform,
  renderExtra,
  dialogClassName,
  onSaved,
  onDelete,
  deleteLabel = "Delete",
}: MasterFormDialogProps) {
  const { toast } = useToast();
  const [form, setForm] = React.useState<FormState>(initial);
  const [busy, setBusy] = React.useState(false);
  const [extraOptions, setExtraOptions] = React.useState<Record<string, MasterOption[]>>({});

  // a fresh form every time the dialog opens
  React.useEffect(() => {
    if (open) {
      setForm(initial);
      setExtraOptions({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = React.useCallback(
    (name: string, value: unknown) => setForm((f) => ({ ...f, [name]: value })),
    []
  );

  const handleSave = async () => {
    setBusy(true);
    try {
      const payload = transform ? transform(form) : form;
      const res = await save({ ...(payload as object), id: editingId ?? undefined });
      if (res.ok) {
        toast({ title: `${entity} saved` });
        await onSaved(res.id, form);
      } else {
        toast({ variant: "destructive", title: "Save failed", description: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setBusy(true);
    try {
      await onDelete();
    } finally {
      setBusy(false);
    }
  };

  const renderField = (f: FieldDef) => {
    if (f.visibleIf && !f.visibleIf(form)) return null;
    const fieldOptions = f.optionsFor
      ? f.optionsFor({ form, editingId: editingId ?? null })
      : (f.options ?? []);
    const value = form[f.name];
    const wrapCls = f.span2 ? "space-y-1.5 sm:col-span-2" : "space-y-1.5";
    let control: React.ReactNode;
    switch (f.type) {
      case "textarea":
        control = (
          <Textarea
            value={(value as string) ?? ""}
            onChange={(e) => set(f.name, e.target.value)}
            placeholder={f.placeholder}
            rows={2}
          />
        );
        break;
      case "number":
        control = (
          <Input
            type="number"
            inputMode="decimal"
            value={value === null || value === undefined ? "" : String(value)}
            onChange={(e) => set(f.name, e.target.value === "" ? "" : e.target.value)}
            placeholder={f.placeholder}
            className="text-right"
          />
        );
        break;
      case "switch":
        control = (
          <div className="flex h-10 items-center">
            <Switch checked={Boolean(value)} onCheckedChange={(v) => set(f.name, v)} />
          </div>
        );
        break;
      case "select":
        control = (
          <Select
            value={(value as string) ?? ""}
            onValueChange={(v) => set(f.name, v)}
          >
            <SelectTrigger>
              <SelectValue placeholder={f.placeholder ?? "Select..."} />
            </SelectTrigger>
            <SelectContent>
              {fieldOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
        break;
      case "radio":
        control = (
          <div className="flex h-10 flex-wrap items-center gap-4">
            {fieldOptions.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name={f.name}
                  checked={value === o.value}
                  onChange={() => set(f.name, o.value)}
                  className="h-4 w-4 accent-primary"
                />
                {o.label}
              </label>
            ))}
          </div>
        );
        break;
      case "combobox": {
        const options = [...fieldOptions, ...(extraOptions[f.name] ?? [])];
        control = (
          <MasterCombobox
            options={options}
            value={(value as string) ?? null}
            onChange={(v) => set(f.name, v)}
            placeholder={f.placeholder ?? "Select..."}
            createLabel={f.createLabel}
            renderCreateDialog={
              f.createDialog
                ? (closeAndSelect) =>
                    f.createDialog!({
                      open: true,
                      onOpenChange: (o) => {
                        if (!o) closeAndSelect((value as string) ?? "");
                      },
                      onCreated: (opt) => {
                        setExtraOptions((prev) => ({
                          ...prev,
                          [f.name]: [...(prev[f.name] ?? []), opt],
                        }));
                        closeAndSelect(opt.value);
                      },
                    })
                : undefined
            }
          />
        );
        break;
      }
      case "multicombobox":
        control = (
          <MultiCombobox
            options={fieldOptions}
            values={Array.isArray(value) ? (value as string[]) : []}
            onChange={(vals) => set(f.name, vals)}
            placeholder={f.placeholder ?? "Select..."}
          />
        );
        break;
      case "date":
        control = (
          <DateInput
            value={(value as string) ?? ""}
            onChange={(text) => set(f.name, text)}
          />
        );
        break;
      default:
        control = (
          <Input
            value={(value as string) ?? ""}
            onChange={(e) =>
              set(f.name, f.uppercase ? e.target.value.toUpperCase() : e.target.value)
            }
            placeholder={f.placeholder}
          />
        );
    }
    return (
      <div key={f.name} className={wrapCls}>
        <Label className="text-xs">{f.label}</Label>
        {control}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogClassName ?? "max-h-[90vh] overflow-y-auto sm:max-w-xl"}>
        <DialogHeader>
          <DialogTitle>{editingId ? `Edit ${entity}` : `New ${entity}`}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">{fields.map(renderField)}</div>
        {renderExtra?.(form, set)}
        <DialogFooter className="gap-2">
          {editingId && onDelete && (
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={busy}
              className="sm:mr-auto"
            >
              <Trash2 className="h-4 w-4" />
              {deleteLabel}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SimpleMasterProps<T> {
  /** record name: dialog title ("New City"), toasts, delete dialog */
  title: string;
  /** page heading when it differs from the record name (default: title) */
  heading?: string;
  /** rendered beside the heading, e.g. an InfoHint */
  titleExtra?: React.ReactNode;
  /** rendered inside a tabbed screen that owns the heading and padding */
  embedded?: boolean;
  newLabel?: string;
  rows: T[];
  columns: ColumnDef<T, unknown>[];
  exportColumns: ExportColumn<T>[];
  exportName: string;
  filters?: FilterDef[];
  fields: FieldDef[];
  defaults: FormState;
  toForm: (row: T) => FormState;
  getId: (row: T) => string;
  save: (input: unknown) => Promise<ActionResult>;
  remove?: (id: string) => Promise<ActionResult>;
  canDelete: boolean;
  /**
   * Which master this is, for the "where is it used?" check that runs before
   * a delete. Without it the dialog falls back to a plain confirm (leaf
   * masters nothing points at, e.g. rates).
   */
  refKind?: MasterKind;
  /** "deactivate": the record is hidden, not removed — references are shown
   *  for information and the action is still allowed */
  deleteMode?: "delete" | "deactivate";
  /** Optional payload transform before calling `save`. */
  transform?: (form: FormState) => unknown;
  /** Extra content rendered below the fields (hints, computed values). */
  renderExtra?: (form: FormState, set: (name: string, value: unknown) => void) => React.ReactNode;
  dialogClassName?: string;
  /** Excel/CSV import + sample template (rendered next to Export). */
  importConfig?: ImportConfig;
  /**
   * Row-level lock: return a message to block editing that row (shown as a
   * toast instead of opening the dialog). Used for system-owned records.
   */
  rowLocked?: (row: T) => string | null;
}

export function SimpleMaster<T>({
  title,
  heading,
  titleExtra,
  embedded = false,
  newLabel = "New",
  rows,
  columns,
  exportColumns,
  exportName,
  filters,
  fields,
  defaults,
  toForm,
  getId,
  save,
  remove,
  canDelete,
  refKind,
  deleteMode = "delete",
  transform,
  renderExtra,
  dialogClassName,
  importConfig,
  rowLocked,
}: SimpleMasterProps<T>) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  // delete pre-check: null = closed, "loading" = asking the server, else the report
  const [delCheck, setDelCheck] = React.useState<null | "loading" | MasterRefReport>(null);
  const [deleting, setDeleting] = React.useState(false);
  const deactivate = deleteMode === "deactivate";
  const verb = deactivate ? "Deactivate" : "Delete";
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [initial, setInitial] = React.useState<FormState>(defaults);

  const openNew = () => {
    setEditingId(null);
    setInitial(defaults);
    setOpen(true);
  };

  const openEdit = (row: T) => {
    const lock = rowLocked?.(row);
    if (lock) {
      toast({ title: "Locked", description: lock });
      return;
    }
    setEditingId(getId(row));
    setInitial(toForm(row));
    setOpen(true);
  };

  const runDelete = async () => {
    if (!editingId || !remove) return;
    setDeleting(true);
    try {
      const res = await remove(editingId);
      if (res.ok) {
        toast({ title: `${title} ${deactivate ? "deactivated" : "deleted"}` });
        setDelCheck(null);
        setOpen(false);
        router.refresh();
      } else {
        toast({ variant: "destructive", title: `${verb} failed`, description: res.error });
      }
    } finally {
      setDeleting(false);
    }
  };

  // Delete = look up every entry that still points at this record FIRST.
  // Hard-delete masters are blocked while anything references them; the
  // server action repeats the check, so this is the explanation, not the guard.
  const handleDelete = async () => {
    if (!editingId || !remove) return;
    if (!refKind) {
      if (!window.confirm(`${verb} this ${title.toLowerCase()}? This cannot be undone.`)) return;
      await runDelete();
      return;
    }
    setDelCheck("loading");
    try {
      setDelCheck(await getMasterReferences(refKind, editingId));
    } catch (e) {
      setDelCheck(null);
      toast({
        variant: "destructive",
        title: "Could not check references",
        description: e instanceof Error ? e.message : "Try again",
      });
    }
  };


  return (
    <div className={embedded ? "space-y-4" : "space-y-4 p-4"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* inside a tabbed screen the page owns the heading; the empty div
            keeps the action bar right-aligned */}
        {embedded ? (
          <div />
        ) : (
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            {heading ?? title}
            {titleExtra}
          </h1>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {importConfig && <ImportButton config={importConfig} />}
          <ExportButton rows={rows} columns={exportColumns} fileName={exportName} />
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4" />
            {newLabel}
          </Button>
        </div>
      </div>

      {filters && filters.length > 0 && <FilterBar filters={filters} />}

      <DataTable columns={columns} data={rows} onRowClick={openEdit} />

      <MasterFormDialog
        open={open}
        onOpenChange={setOpen}
        entity={title}
        fields={fields}
        initial={initial}
        editingId={editingId}
        save={save}
        transform={transform}
        renderExtra={renderExtra}
        dialogClassName={dialogClassName}
        onSaved={() => {
          setOpen(false);
          router.refresh();
        }}
        onDelete={canDelete && remove ? handleDelete : undefined}
        deleteLabel={verb}
      />

      <DeletePrecheckDialog
        state={delCheck}
        subject={title.toLowerCase()}
        mode={deleteMode}
        deleting={deleting}
        onCancel={() => setDelCheck(null)}
        onConfirm={() => void runDelete()}
      />
    </div>
  );
}
