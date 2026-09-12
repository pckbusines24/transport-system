import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, formatMoney, toNum } from "@/lib/utils";
import { amountInWords } from "@/lib/num-to-words";
import { firmImageUrl } from "@/lib/branding";
import { PrintToolbar } from "@/app/print/invoice/[id]/print-toolbar";

export const dynamic = "force-dynamic";

/** Covering letter for a bill submission — print / save as PDF. */
export default async function SubmissionPrintPage({
  params,
}: {
  params: { id: string };
}) {
  const session = requireSession();
  await authorize(session, "billing", "print");

  const data = await withTenant(session.tenantId, async (tx) => {
    const sub = await tx.invoiceSubmission.findFirst({
      where: { id: params.id, firmId: session.firmId },
      include: { items: { include: { invoice: true } } },
    });
    if (!sub) return null;
    const [firm, party] = await Promise.all([
      tx.firm.findUnique({ where: { id: sub.firmId } }),
      tx.party.findUnique({ where: { id: sub.partyId } }),
    ]);
    return { sub, firm, party };
  });

  if (!data) notFound();
  const { sub, firm, party } = data;
  // the logo uploaded in Firm Settings, top-left of the header like the chalan print
  const logoUrl = firmImageUrl(firm, "logo");
  const items = [...sub.items].sort((a, b) =>
    a.invoice.invoiceNo.localeCompare(b.invoice.invoiceNo),
  );
  const total = items.reduce((s, it) => s + toNum(it.invoice.netTotal), 0);

  return (
    <div className="bg-white p-4 text-black">
      <PrintToolbar />
      <div className="mx-auto max-w-[190mm] border border-black p-6 text-sm">
        {/* company letterhead */}
        <div className="flex items-center gap-3 border-b-2 border-black pb-3">
          {logoUrl && (
            <div className="flex w-[110px] shrink-0 items-center justify-center">
              <img
                src={logoUrl}
                alt=""
                className="max-h-[64px] max-w-[110px] object-contain"
              />
            </div>
          )}
          <div className="min-w-0 flex-1 text-center">
            <div className="text-2xl font-bold uppercase">{firm?.name}</div>
            <div className="text-xs">
              {[firm?.address1, firm?.address2].filter(Boolean).join(", ")}
            </div>
            <div className="text-xs">
              {[
                firm?.mobile && `Mob: ${firm.mobile}`,
                firm?.email && `Email: ${firm.email}`,
                firm?.gstin && `GSTIN: ${firm.gstin}`,
                firm?.pan && `PAN: ${firm.pan}`,
              ]
                .filter(Boolean)
                .join(" | ")}
            </div>
          </div>
          {/* mirrors the logo column so the firm details sit dead centre */}
          {logoUrl && <div className="w-[110px] shrink-0" />}
        </div>

        <div className="mt-4 flex justify-between text-xs">
          <div>
            <b>Bill Submission No:</b> {sub.submissionNo}
          </div>
          <div>
            <b>Date:</b> {formatDate(sub.submissionDate)}
          </div>
        </div>

        <div className="mt-3 text-xs">
          <div>To,</div>
          <div className="font-semibold">{party?.name}</div>
          {party?.address1 && (
            <div>
              {[party.address1, party.address2].filter(Boolean).join(", ")}
            </div>
          )}
        </div>

        <div className="mt-4 text-center text-sm font-semibold underline">
          Subject: Submission of Freight Bills for Payment Processing
        </div>
        <p className="mt-3 text-xs">
          Dear Sir / Madam,
          <br />
          Please find enclosed the following invoice(s) submitted herewith for
          your kind verification and payment processing. Kindly acknowledge
          receipt by signing and returning a copy of this letter.
        </p>

        <table className="mt-3 w-full border-collapse text-xs">
          <thead>
            <tr>
              {["S. No.", "Invoice Date", "Invoice No.", "Invoice Amount"].map(
                (h) => (
                  <th
                    key={h}
                    className="border border-black px-2 py-1 text-left"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.id}>
                <td className="border border-black px-2 py-0.5">{i + 1}</td>
                <td className="border border-black px-2 py-0.5">
                  {formatDate(it.invoice.invoiceDate)}
                </td>
                <td className="border border-black px-2 py-0.5">
                  {it.invoice.invoiceNo}
                </td>
                <td className="border border-black px-2 py-0.5 text-right">
                  {formatMoney(toNum(it.invoice.netTotal))}
                </td>
              </tr>
            ))}
            <tr className="font-bold">
              <td colSpan={2} className="border border-black px-2 py-1">
                Total Number of Bills: {items.length}
              </td>
              <td className="border border-black px-2 py-1 text-right">
                Total Amount
              </td>
              <td className="border border-black px-2 py-1 text-right">
                {formatMoney(total)}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="mt-2 text-xs font-semibold">
          Amount in Words: {amountInWords(total)}
        </div>
        {sub.remarks && (
          <div className="mt-2 text-xs">
            <b>Remarks:</b> {sub.remarks}
          </div>
        )}

        <div className="mt-10 flex justify-between text-xs">
          <div>
            <div className="mb-10 font-semibold">
              Received By (Sign &amp; Stamp)
            </div>
            <div>Name: ______________________</div>
            <div className="mt-1">Designation: ________________</div>
            <div className="mt-1">Date / Time: ________________</div>
          </div>
          <div className="text-right">
            <div className="mb-14 font-semibold">For {firm?.name}</div>
            <div>Authorized Signatory</div>
          </div>
        </div>
      </div>
    </div>
  );
}
