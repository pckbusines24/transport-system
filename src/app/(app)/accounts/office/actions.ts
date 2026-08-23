"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { assertDateInFy } from "@/lib/fy-guard";
import { postLedger, reverseLedger, type LedgerPostEntry } from "@/lib/ledger";
import { settledByRef } from "@/lib/settlement";

/**
 * Office Income & Expense — automatic double-entry posting (refType
 * OFFICE_TXN). Four cases:
 *   Expense + supplier: DR expense head → CR supplier (bill), DR supplier →
 *     CR bank/cash (payment) — supplier ledger shows both legs, nets to zero.
 *   Expense, no supplier: DR expense head, CR bank/cash.
 *   Income + party:  DR party → CR income head (accrual), DR bank → CR party.
 *   Income, no party: DR bank/cash, CR income head.
 * The editable external reference number (bill/invoice/receipt/challan/LR)
 * is carried as the ledger refNo so it appears in every ledger and register.
 * Edits reverse + re-post; deletes are soft — full audit trail either way.
 */

const REVALIDATE = "/accounts/office";

async function nextVoucherNo(tx: Tx, firmId: string, fyId: string, txnType: string) {
  const prefix = txnType === "INCOME" ? "OIN-" : "OEX-";
  const rows = await tx.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(NULLIF(regexp_replace("voucherNo", '\\D', '', 'g'), '')::bigint) AS max
    FROM "OfficeTransaction"
    WHERE "firmId" = ${firmId} AND "fyId" = ${fyId} AND "txnType" = ${txnType}`;
  const max = rows[0]?.max ? Number(rows[0].max) : 0;
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

const schema = z.object({
  id: z.string().nullish(),
  date: z.string().min(1, "Date is required"),
  txnType: z.enum(["INCOME", "EXPENSE"]),
  headId: z.string().min(1, "Income / Expense head is required"),
  partyId: z.string().nullish(), // supplier / party — optional
  paymentMode: z.enum(["CASH", "BANK", "CARD"]).nullish(), // blank = on credit (settle later)
  bankPartyId: z.string().nullish(),
  amount: z.number().min(0.01, "Amount is required"),
  gstPct: z.number().min(0).default(0),
  gstAmount: z.number().min(0).default(0),
  refNo: z.string().nullish(), // free alphanumeric external reference
  remarks: z.string().nullish(),
  attachmentPath: z.string().nullish(),
  // one bill, many heads (optional): head-wise split of the same bill —
  // spare parts + repair labour on one invoice. Sum must equal `amount`.
  lines: z
    .array(
      z.object({
        headId: z.string().min(1),
        amount: z.number().min(0.01),
        remarks: z.string().nullish(),
      })
    )
    .default([]),
});

export async function saveOfficeTransaction(
  input: unknown
): Promise<{ ok: true; id: string; voucherNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "office", d.id ? "edit" : "create");
  if (d.attachmentPath && !d.attachmentPath.startsWith(`${session.tenantId}/`)) {
    return { ok: false, error: "Invalid attachment path" };
  }
  if (d.paymentMode && !d.bankPartyId) {
    return { ok: false, error: "Cash / Bank account is required when a payment mode is selected." };
  }
  if (!d.paymentMode && !d.partyId) {
    return {
      ok: false,
      error:
        "Select a Supplier/Party (for a credit entry) or a Payment Mode with Cash/Bank account.",
    };
  }

  // a multi-head bill leads with its first line's head; the total must match
  if (d.lines.length) {
    const lineSum = Math.round(d.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    if (Math.abs(lineSum - d.amount) > 0.009) {
      return {
        ok: false,
        error: `Head-wise split (${lineSum.toFixed(2)}) must equal the bill amount (${d.amount.toFixed(2)}).`,
      };
    }
    d.headId = d.lines[0].headId;
  }

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const head = await tx.accountHead.findFirst({ where: { id: d.headId } });
      if (!head) return { ok: false as const, error: "Head not found" };
      if (head.kind !== d.txnType) {
        return {
          ok: false as const,
          error: `"${head.name}" is a ${head.kind} head — select a matching ${d.txnType} head.`,
        };
      }
      // every split head must exist and match the entry's side
      const lineHeads = d.lines.length
        ? await tx.accountHead.findMany({ where: { id: { in: d.lines.map((l) => l.headId) } } })
        : [];
      if (d.lines.length) {
        const byId = new Map(lineHeads.map((h) => [h.id, h]));
        for (const l of d.lines) {
          const lh = byId.get(l.headId);
          if (!lh) return { ok: false as const, error: "A split head was not found." };
          if (lh.kind !== d.txnType) {
            return {
              ok: false as const,
              error: `"${lh.name}" is a ${lh.kind} head — every split line must be a ${d.txnType} head.`,
            };
          }
        }
      }

      // Once a voucher has settled against this entry, the entry can no longer
      // move underneath it: dropping the amount below what is already settled
      // would leave a negative outstanding, and switching a credit entry to
      // cash/bank would pay it a second time. Release the voucher first.
      if (d.id) {
        // the guard must look up settlements under the STORED type — checking
        // the incoming type would let a settled expense slip through by being
        // flipped to income
        const stored = await tx.officeTransaction.findFirst({
          where: { id: d.id, deletedAt: null },
          select: { txnType: true },
        });
        if (!stored) return { ok: false as const, error: "Entry not found" };
        const settledHere = await settledByRef(tx, {
          firmId: session.firmId,
          fyId: session.fyId,
          refTypes: [stored.txnType === "EXPENSE" ? "OFFICE_EXPENSE" : "OFFICE_INCOME"],
          refIds: [d.id],
        });
        const settled = settledHere.get(d.id) ?? 0;
        if (settled > 0.009 && stored.txnType !== d.txnType) {
          return {
            ok: false as const,
            error: "This entry is settled by a voucher — its Income/Expense type cannot change. Release the voucher first.",
          };
        }
        if (settled > 0.009) {
          if (d.paymentMode) {
            return {
              ok: false as const,
              error: `${settled.toFixed(2)} has already been settled against this entry by a voucher. Remove that allocation before marking it paid in cash/bank.`,
            };
          }
          if (d.amount < settled - 0.009) {
            return {
              ok: false as const,
              error: `Amount cannot be less than the ${settled.toFixed(2)} already settled against this entry.`,
            };
          }
        }
      }

      const date = new Date(`${d.date}T00:00:00`);
      // wrong-FY guard: the entry's own date must belong to the session FY
      await assertDateInFy(tx, session, date, "office entry");
      const values = {
        date,
        txnType: d.txnType,
        headId: d.headId,
        partyId: d.partyId || null,
        paymentMode: d.paymentMode || null,
        bankPartyId: d.paymentMode ? d.bankPartyId || null : null,
        amount: d.amount,
        gstPct: d.gstPct,
        gstAmount: d.gstAmount,
        refNo: d.refNo?.trim() || null,
        remarks: d.remarks || null,
        attachmentPath: d.attachmentPath || null,
      };

      let id: string;
      let voucherNo: string;
      if (d.id) {
        const before = await tx.officeTransaction.findFirstOrThrow({
          where: { id: d.id, deletedAt: null },
        });
        const updated = await tx.officeTransaction.update({
          where: { id: d.id },
          // a blank reference means "use the voucher number" — persisted rather
          // than derived, so the register, the voucher grid and the ledger all
          // read one stored value instead of three copies of the same rule
          data: { ...values, refNo: values.refNo || before.voucherNo },
        });
        id = updated.id;
        voucherNo = updated.voucherNo;
        await reverseLedger(tx, "OFFICE_TXN", id);
        await audit(tx, session, {
          entity: "OfficeTransaction",
          entityId: id,
          action: "UPDATE",
          before,
          after: updated,
        });
      } else {
        voucherNo = await nextVoucherNo(tx, session.firmId, session.fyId, d.txnType);
        const created = await tx.officeTransaction.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            voucherNo,
            createdById: session.userId,
            ...values,
            refNo: values.refNo || voucherNo,
          },
        });
        id = created.id;
        await audit(tx, session, {
          entity: "OfficeTransaction",
          entityId: id,
          action: "CREATE",
          after: created,
        });
      }

      // replace the head-wise split (empty array clears it back to single-head)
      await tx.officeTxnLine.deleteMany({ where: { txnId: id } });
      if (d.lines.length) {
        await tx.officeTxnLine.createMany({
          data: d.lines.map((l) => ({
            tenantId: session.tenantId,
            txnId: id,
            headId: l.headId,
            amount: l.amount,
            remarks: l.remarks || null,
          })),
        });
      }

      // ---- automatic double-entry posting ----
      const common = {
        date,
        refType: "OFFICE_TXN",
        refId: id,
        // external document number (bill/invoice/receipt/challan/LR) if given,
        // else the auto voucher number — shown in every ledger & register
        refNo: values.refNo || voucherNo,
      };
      const label = `${head.name}${values.remarks ? " — " + values.remarks : ""}`;
      // paid = money moved now (cash/bank leg); otherwise the amount stays
      // outstanding on the supplier/party ledger until settled by a voucher
      const paid = !!values.paymentMode && !!values.bankPartyId;
      const entries: LedgerPostEntry[] = [];
      // multi-head bill: one head leg per split line; single-head: one leg
      const lineHeadName = new Map(lineHeads.map((h) => [h.id, h.name]));
      const headLegs = d.lines.length
        ? d.lines.map((l) => ({
            headId: l.headId,
            amount: l.amount,
            narrTail: `${lineHeadName.get(l.headId) ?? ""}${l.remarks ? " — " + l.remarks : ""}`,
          }))
        : [{ headId: d.headId, amount: d.amount, narrTail: label }];
      if (d.txnType === "EXPENSE") {
        for (const leg of headLegs) {
          entries.push({
            ...common,
            accountHeadId: leg.headId,
            side: "DEBIT",
            amount: leg.amount,
            narration: `Office expense ${voucherNo}: ${leg.narrTail}`,
          });
        }
        if (values.partyId) {
          // supplier bill — stays outstanding unless paid immediately
          entries.push({
            ...common,
            partyId: values.partyId,
            side: "CREDIT",
            amount: d.amount,
            narration: `Supplier bill ${common.refNo} — ${head.name}`,
          });
          if (paid) {
            entries.push({
              ...common,
              partyId: values.partyId,
              side: "DEBIT",
              amount: d.amount,
              narration: `Payment to supplier (${values.paymentMode!.toLowerCase()}) ${voucherNo}`,
            });
          }
        }
        if (paid) {
          entries.push({
            ...common,
            partyId: values.bankPartyId!,
            side: "CREDIT",
            amount: d.amount,
            narration: `Office expense ${voucherNo}: ${label}`,
          });
        }
      } else {
        if (paid) {
          entries.push({
            ...common,
            partyId: values.bankPartyId!,
            side: "DEBIT",
            amount: d.amount,
            narration: `Office income ${voucherNo}: ${label}`,
          });
        }
        if (values.partyId) {
          // income accrual — stays outstanding unless received immediately
          entries.push({
            ...common,
            partyId: values.partyId,
            side: "DEBIT",
            amount: d.amount,
            narration: `Income accrual ${common.refNo} — ${head.name}`,
          });
          if (paid) {
            entries.push({
              ...common,
              partyId: values.partyId,
              side: "CREDIT",
              amount: d.amount,
              narration: `Received from party (${values.paymentMode!.toLowerCase()}) ${voucherNo}`,
            });
          }
        }
        for (const leg of headLegs) {
          entries.push({
            ...common,
            accountHeadId: leg.headId,
            side: "CREDIT",
            amount: leg.amount,
            narration: `Office income ${voucherNo}: ${leg.narrTail}`,
          });
        }
      }
      await postLedger(tx, session, entries);

      revalidatePath(REVALIDATE);
      return { ok: true as const, id, voucherNo };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

export async function deleteOfficeTransaction(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete office transactions" };
  }
  await authorize(session, "office", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.officeTransaction.findFirstOrThrow({
        where: { id, deletedAt: null },
      });
      // deleting a settled entry would leave the voucher allocation pointing at
      // nothing, and the money it settled unaccounted for on both sides
      const settled = await settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: [before.txnType === "EXPENSE" ? "OFFICE_EXPENSE" : "OFFICE_INCOME"],
        refIds: [id],
      });
      const amount = settled.get(id) ?? 0;
      if (amount > 0.009) {
        throw new Error(
          `${amount.toFixed(2)} has been settled against ${before.refNo || before.voucherNo} by a voucher. Delete or edit that voucher first.`
        );
      }
      await tx.officeTransaction.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseLedger(tx, "OFFICE_TXN", id);
      await audit(tx, session, {
        entity: "OfficeTransaction",
        entityId: id,
        action: "DELETE",
        before,
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Delete failed" };
  }
}
