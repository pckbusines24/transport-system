"use client";

/**
 * Inline-create dialogs for use as `renderCreateDialog` targets of
 * MasterCombobox across modules (LR, chalan, billing, ...).
 *
 * Each one is the SAME form as the corresponding master screen: it renders
 * the shared field definitions (field-defs.tsx) inside MasterFormDialog and
 * saves through the master's own server action, so fields, validation, audit
 * and cache invalidation cannot differ between "Masters" and a "+ Create"
 * row on a transaction form.
 *
 * Shared prop signature: { open, onOpenChange, onCreated(option) }.
 */

import * as React from "react";
import type { LedgerGroup } from "@prisma/client";
import { useToast } from "@/components/ui/use-toast";
import type { MasterOption } from "@/components/data/master-combobox";
import {
  MasterFormDialog,
  type ActionResult,
  type CreateDialogProps,
  type FieldDef,
  type FormState,
} from "@/components/masters/simple-master";
import {
  cityDefaults,
  cityFields,
  partyDefaults,
  partyDialogClassName,
  partyFields,
  partyTransform,
  productDefaults,
  productFields,
  productGroupDefaults,
  productGroupFields,
  unitDefaults,
  unitFields,
  vehicleDefaults,
  vehicleFields,
} from "@/components/masters/field-defs";
import {
  getCityOptions,
  getMasterOption,
  getPartyOptions,
  getProductGroupOptions,
  getStateOptions,
  getUnitNameOptions,
  type MasterKind,
  type Option,
} from "@/lib/lookups";
import { saveCity } from "@/app/(app)/masters/cities/actions";
import { saveParty } from "@/app/(app)/masters/parties/actions";
import { saveVehicle } from "@/app/(app)/masters/vehicles/actions";
import { saveProduct } from "@/app/(app)/masters/products/actions";
import { saveProductGroup } from "@/app/(app)/masters/product-groups/actions";
import { saveUnit } from "@/app/(app)/masters/units/actions";

export interface InlineCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (option: Option) => void;
}

/** Load combobox options when the dialog opens. */
function useOptionsOnOpen(open: boolean, load: () => Promise<MasterOption[]>): MasterOption[] {
  const [options, setOptions] = React.useState<MasterOption[]>([]);
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    load()
      .then((o) => alive && setOptions(o))
      .catch(() => alive && setOptions([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return options;
}

/** MasterFormDialog wired for "create then select": save, resolve the option, hand it back. */
function InlineMasterDialog({
  open,
  onOpenChange,
  onCreated,
  entity,
  kind,
  fields,
  initial,
  save,
  transform,
  dialogClassName,
}: InlineCreateDialogProps & {
  entity: string;
  kind: MasterKind;
  fields: FieldDef[];
  initial: FormState;
  save: (input: unknown) => Promise<ActionResult>;
  transform?: (form: FormState) => unknown;
  dialogClassName?: string;
}) {
  const { toast } = useToast();
  return (
    <MasterFormDialog
      open={open}
      onOpenChange={onOpenChange}
      entity={entity}
      fields={fields}
      initial={initial}
      save={save}
      transform={transform}
      dialogClassName={dialogClassName}
      onSaved={async (id) => {
        try {
          onCreated(await getMasterOption(kind, id));
        } catch (e) {
          // the record IS saved; only the auto-select failed
          toast({
            variant: "destructive",
            title: `${entity} saved but could not be selected — pick it from the list`,
            description: e instanceof Error ? e.message : undefined,
          });
          onOpenChange(false);
        }
      }}
    />
  );
}

export function CityCreateDialog(props: InlineCreateDialogProps) {
  const stateOptions = useOptionsOnOpen(props.open, getStateOptions);
  return (
    <InlineMasterDialog
      {...props}
      entity="City"
      kind="city"
      fields={cityFields({ stateOptions })}
      initial={cityDefaults}
      save={saveCity}
    />
  );
}

export function PartyCreateDialog({
  defaultGroup,
  ...props
}: InlineCreateDialogProps & { defaultGroup?: LedgerGroup }) {
  const stateOptions = useOptionsOnOpen(props.open, getStateOptions);
  const cityOptions = useOptionsOnOpen(props.open, getCityOptions);
  return (
    <InlineMasterDialog
      {...props}
      entity="Party"
      kind="party"
      fields={partyFields({
        stateOptions,
        cityOptions,
        cityCreate: (p: CreateDialogProps) => <CityCreateDialog {...p} />,
      })}
      initial={{ ...partyDefaults, ledgerGroup: defaultGroup ?? partyDefaults.ledgerGroup }}
      transform={partyTransform}
      save={saveParty}
      dialogClassName={partyDialogClassName}
    />
  );
}

export function VehicleCreateDialog(props: InlineCreateDialogProps) {
  // unified list: owners, brokers and relatives are all persons here;
  // legacy RELATIVE-group parties stay selectable
  const ownerOptions = useOptionsOnOpen(props.open, () =>
    getPartyOptions(["OWNER_BROKER", "RELATIVE"])
  );
  return (
    <InlineMasterDialog
      {...props}
      entity="Vehicle"
      kind="vehicle"
      fields={vehicleFields({
        ownerOptions,
        ownerCreate: (p: CreateDialogProps) => <PartyCreateDialog {...p} defaultGroup="OWNER_BROKER" />,
      })}
      initial={vehicleDefaults}
      save={saveVehicle}
    />
  );
}

export function ProductCreateDialog(props: InlineCreateDialogProps) {
  const groupOptions = useOptionsOnOpen(props.open, getProductGroupOptions);
  const unitOptions = useOptionsOnOpen(props.open, getUnitNameOptions);
  return (
    <InlineMasterDialog
      {...props}
      entity="Product"
      kind="product"
      fields={productFields({
        groupOptions,
        unitOptions,
        groupCreate: (p: CreateDialogProps) => <ProductGroupCreateDialog {...p} />,
        unitCreate: (p: CreateDialogProps) => <UnitCreateDialog {...p} />,
      })}
      initial={productDefaults}
      save={saveProduct}
    />
  );
}

export function ProductGroupCreateDialog(props: InlineCreateDialogProps) {
  return (
    <InlineMasterDialog
      {...props}
      entity="Product Group"
      kind="productGroup"
      fields={productGroupFields}
      initial={productGroupDefaults}
      save={saveProductGroup}
      dialogClassName="sm:max-w-md"
    />
  );
}

export function UnitCreateDialog(props: InlineCreateDialogProps) {
  return (
    <InlineMasterDialog
      {...props}
      entity="Unit"
      kind="unit"
      fields={unitFields}
      initial={unitDefaults}
      save={saveUnit}
      dialogClassName="sm:max-w-md"
    />
  );
}
