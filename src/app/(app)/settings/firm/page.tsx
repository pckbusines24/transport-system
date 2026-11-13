import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { firmImageUrl } from "@/lib/branding";
import { FirmForm, type FirmFormValues } from "@/components/settings/firm-form";

export const dynamic = "force-dynamic";

export default async function FirmSettingsPage() {
  const session = requireSession();
  await authorize(session, "settings", "view");

  const { firm, banks, states, cities } = await withTenant(session.tenantId, async (tx) => {
    const [firm, banks, states, cities] = await Promise.all([
      tx.firm.findUnique({ where: { id: session.firmId } }),
      tx.party.findMany({
        where: { isActive: true, ledgerGroup: { in: ["BANK", "CASH", "CARD"] } },
        orderBy: { name: "asc" },
      }),
      tx.state.findMany({ orderBy: { name: "asc" } }),
      tx.city.findMany({ orderBy: { name: "asc" } }),
    ]);
    return { firm, banks, states, cities };
  });

  if (!firm) {
    return <div className="p-4 text-sm text-muted-foreground">Firm not found.</div>;
  }

  const s = (v: string | null | undefined) => v ?? "";
  const defaults: FirmFormValues = {
    name: firm.name,
    alias: s(firm.alias),
    address1: s(firm.address1),
    address2: s(firm.address2),
    stateId: s(firm.stateId),
    cityId: s(firm.cityId),
    phone: s(firm.phone),
    mobile: s(firm.mobile),
    email: s(firm.email),
    website: s(firm.website),
    gstin: s(firm.gstin),
    pan: s(firm.pan),
    cin: s(firm.cin),
    msmeNo: s(firm.msmeNo),
    ibaCode: s(firm.ibaCode),
    vendorCode: s(firm.vendorCode),
    rcmCovered: firm.rcmCovered,
    jurisdiction: s(firm.jurisdiction),
    cgstPct: toNum(String(firm.cgstPct)),
    sgstPct: toNum(String(firm.sgstPct)),
    igstPct: toNum(String(firm.igstPct)),
    defaultTdsPct: toNum(String(firm.defaultTdsPct)),
    podFollowUpDays: firm.podFollowUpDays ?? 15,
    balanceFollowUpEnabled: firm.balanceFollowUpEnabled ?? true,
    balanceFollowUpDays: firm.balanceFollowUpDays ?? 15,
    defaultBankPartyId: s(firm.defaultBankPartyId),
    bankName: s(firm.bankName),
    bankAccount: s(firm.bankAccount),
    bankBranch: s(firm.bankBranch),
    bankIfsc: s(firm.bankIfsc),
    smtpHost: s(firm.smtpHost),
    smtpUser: s(firm.smtpUser),
    smtpPass: s(firm.smtpPass),
  };

  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title">Firm Settings — {firm.name}</h1>
      <FirmForm
        defaults={defaults}
        logoUrl={firmImageUrl(firm, "logo")}
        sealUrl={firmImageUrl(firm, "seal")}
        bankOptions={banks.map((b) => ({ value: b.id, label: b.name }))}
        stateOptions={states.map((st) => ({ value: st.id, label: st.name }))}
        cityOptions={cities.map((c) => ({ value: c.id, label: c.name }))}
      />
    </div>
  );
}
