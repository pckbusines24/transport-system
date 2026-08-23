import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { peekDocNumber } from "@/lib/sequences";
import { getPartyOptions, getBankOptions, getVehicleOptions } from "@/lib/lookups";
import { BookText } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { TabNav, type TabDef } from "@/components/app/tab-nav";
import { VoucherEntry, RecentVoucher } from "@/components/accounts/voucher-entry";
import { TYPE_META } from "@/components/accounts/voucher-types";
import { VoucherType, DocNumberType } from "@prisma/client";
import { VoucherRegisterTab } from "./register-tab";
import { getAccountHeadOptions } from "./actions";

export const dynamic = "force-dynamic";

const TYPES: VoucherType[] = ["RECEIPT", "PAYMENT", "CONTRA", "JOURNAL"];
const BASE = "/accounts/vouchers";

const TABS: TabDef[] = [
  ...TYPES.map((t) => ({
    value: t,
    label: `${TYPE_META[t].title} Voucher`,
    icon: TYPE_META[t].icon,
  })),
  { value: "REGISTER", label: "Voucher Register", icon: <BookText className="h-4 w-4" /> },
];

export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "vouchers", "view");

  // edit mode: load the voucher (register's Edit button) — its own type
  // decides the tab, and the entry form prefills from it
  const editVoucher = searchParams.edit
    ? await withTenant(session.tenantId, async (tx) => {
        const v = await tx.voucher.findFirst({
          where: { id: searchParams.edit, firmId: session.firmId, deletedAt: null },
          include: { allocations: true },
        });
        if (!v) return null;
        const uses = await tx.partyAdvanceUse.findMany({
          where: { refType: "VOUCHER", refId: v.id },
          select: { advanceId: true, amount: true },
        });
        return { v, uses };
      })
    : null;

  const tab = editVoucher
    ? editVoucher.v.type
    : TABS.some((t) => t.value === searchParams.tab)
      ? (searchParams.tab as string)
      : "RECEIPT";

  // the register is a peer tab, not an entry form — nothing else to load
  if (tab === "REGISTER") {
    return (
      <div className="space-y-4 p-4">
        <PageHeader
          title="Vouchers"
          subtitle="Every receipt, payment, journal and contra voucher entered, with its references and settlement."
        />
        <TabNav tabs={TABS} active={tab} basePath={BASE} />
        <VoucherRegisterTab searchParams={searchParams} />
      </div>
    );
  }

  const [partyOptions, bankOptions, vehicleOptions, headOptions] = await Promise.all([
    getPartyOptions(),
    getBankOptions(),
    getVehicleOptions(),
    // income / expense heads — the journal can debit or credit any of them
    getAccountHeadOptions(),
  ]);

  const { peekNumbers, recent } = await withTenant(session.tenantId, async (tx) => {
    const peekNumbers = {} as Record<VoucherType, string>;
    const recent = {} as Record<VoucherType, RecentVoucher[]>;
    const parties = await tx.party.findMany({ select: { id: true, name: true } });
    const partyName = new Map(parties.map((p) => [p.id, p.name]));
    for (const t of TYPES) {
      peekNumbers[t] =
        (await peekDocNumber(tx, {
          firmId: session.firmId,
          fyId: session.fyId,
          docType: `VOUCHER_${t}` as DocNumberType,
        })) ?? "1";
      const vouchers = await tx.voucher.findMany({
        where: {
          firmId: session.firmId,
          fyId: session.fyId,
          type: t,
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      // advances these vouchers created, with the documents that consumed them
      const advances = vouchers.length
        ? await tx.partyAdvance.findMany({
            where: { voucherId: { in: vouchers.map((v) => v.id) }, deletedAt: null },
            include: { uses: { orderBy: { date: "asc" } } },
          })
        : [];
      const advByVoucher = new Map(advances.map((a) => [a.voucherId ?? "", a]));
      recent[t] = vouchers.map((v) => ({
        id: v.id,
        voucherNo: v.voucherNo,
        voucherDate: v.voucherDate.toISOString(),
        partyName: v.partyId ? partyName.get(v.partyId) ?? null : null,
        bankName: v.bankPartyId ? partyName.get(v.bankPartyId) ?? null : null,
        moduleLink: v.moduleLink,
        amount: Number(v.amount),
        netAmount: Number(v.netAmount),
        advance: (() => {
          const a = advByVoucher.get(v.id);
          if (!a) return null;
          const amount = Number(a.amount);
          const consumed = Number(a.consumedAmount);
          return {
            amount,
            consumed,
            balance: Math.round((amount - consumed) * 100) / 100,
            uses: a.uses.map((u) => ({
              refNo: u.refNo,
              amount: Number(u.amount),
              date: u.date.toISOString(),
            })),
          };
        })(),
      }));
    }
    return { peekNumbers, recent };
  });

  const vType = tab as VoucherType;
  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Vouchers" subtitle={TYPE_META[vType].hint} />
      <TabNav tabs={TABS} active={tab} basePath={BASE} />
      {/* switching type already reset the form, so a link-driven tab loses
          nothing that the old client-state selector did not */}
      <VoucherEntry
        key={editVoucher ? `edit-${editVoucher.v.id}` : vType}
        type={vType}
        peekNumbers={peekNumbers}
        partyOptions={partyOptions}
        bankOptions={bankOptions}
        headOptions={headOptions}
        vehicleOptions={vehicleOptions}
        recent={recent}
        edit={
          editVoucher
            ? {
                id: editVoucher.v.id,
                voucherNo: editVoucher.v.voucherNo,
                voucherDate: editVoucher.v.voucherDate.toISOString(),
                entryType: editVoucher.v.entryType,
                moduleLink: editVoucher.v.moduleLink,
                partyId: editVoucher.v.partyId,
                vehicleId: editVoucher.v.vehicleId,
                accountHeadId: editVoucher.v.accountHeadId,
                bankPartyId: editVoucher.v.bankPartyId,
                creditHeadId: editVoucher.v.creditHeadId,
                chequeNo: editVoucher.v.chequeNo,
                chequeDate: editVoucher.v.chequeDate ? editVoucher.v.chequeDate.toISOString() : null,
                netAmount: Number(editVoucher.v.netAmount),
                remarks: editVoucher.v.remarks,
                allocations: editVoucher.v.allocations.map((a) => ({
                  refId: a.refId,
                  refNo: a.refNo,
                  refType: a.refType,
                  billAmt: Number(a.billAmt),
                  tdsPct: Number(a.tdsPct),
                  tdsAmt: Number(a.tdsAmt),
                  deduction: Number(a.deduction),
                  otherAmt: Number(a.otherAmt),
                  roundOff: Number(a.roundOff),
                  amount: Number(a.amount),
                  remarks: a.remarks,
                })),
                advanceUses: editVoucher.uses.map((u) => ({
                  advanceId: u.advanceId,
                  amount: Number(u.amount),
                })),
              }
            : null
        }
      />
    </div>
  );
}
