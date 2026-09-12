"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { toNum } from "@/lib/utils";
import { invoiceSettlement } from "@/lib/settlement";

// ---------------------------------------------------------------- types

export interface SubmissionInvoiceRow {
  id: string;
  invoiceNo: string;
  invoiceDate: string; // ISO
  amount: number; // net total
  partyName: string;
  /** latest ACTIVE submission this invoice already sits in (informational) */
  lastSubmissionNo: string | null;
}

export interface SubmissionDetails {
  id: string;
  submissionNo: string;
  submissionDate: string;
  partyId: string;
  partyName: string;
  remarks: string;
  receivedBy: string;
  designation: string;
  receiverMobile: string;
  receivedDate: string | null;
  receivedTime: string;
  ackRemarks: string;
  signedLetterPath: string | null;
  ackCopyPath: string | null;
  supportingPath: string | null;
  items: {
    invoiceId: string;
    invoiceNo: string;
    invoiceDate: string;
    amount: number;
    status: string; // SUBMITTED | RETURNED
    resubmittedInNo: string | null;
    resubmissionDate: string | null;
  }[];
}

export interface InvoiceHistoryStep {
  label: string;
  detail: string;
  date: string | null; // ISO
}

// ---------------------------------------------------------------- helpers

async function nextSubmissionNo(tx: Tx, firmId: string, fyId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(NULLIF(regexp_replace("submissionNo", '\\D', '', 'g'), '')::bigint) AS max
    FROM "InvoiceSubmission" WHERE "firmId" = ${firmId} AND "fyId" = ${fyId}`;
  const max = rows[0]?.max ? Number(rows[0].max) : 0;
  return `BS-${String(max + 1).padStart(6, "0")}`;
}

async function decorateInvoices(
  tx: Tx,
  invoices: { id: string; invoiceNo: string; invoiceDate: Date; netTotal: unknown; partyId: string }[]
): Promise<SubmissionInvoiceRow[]> {
  const partyIds = Array.from(new Set(invoices.map((i) => i.partyId)));
  const invoiceIds = invoices.map((i) => i.id);
  const [parties, items] = await Promise.all([
    tx.party.findMany({ where: { id: { in: partyIds } } }),
    tx.invoiceSubmissionItem.findMany({
      where: { invoiceId: { in: invoiceIds }, status: "SUBMITTED" },
      include: { submission: { select: { submissionNo: true } } },
    }),
  ]);
  const pmap = new Map(parties.map((p) => [p.id, p.name]));
  const lastByInvoice = new Map(items.map((it) => [it.invoiceId, it.submission.submissionNo]));
  return invoices.map((i) => ({
    id: i.id,
    invoiceNo: i.invoiceNo,
    invoiceDate: i.invoiceDate.toISOString(),
    amount: toNum(String(i.netTotal)),
    partyName: pmap.get(i.partyId) ?? "",
    lastSubmissionNo: lastByInvoice.get(i.id) ?? null,
  }));
}

// ---------------------------------------------------------------- lookups

/** Invoices of a customer within a date range (for auto-fetch). */
export async function getInvoicesForSubmission(
  partyId: string,
  dateFrom: string | null,
  dateTo: string | null
): Promise<SubmissionInvoiceRow[]> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const invoices = await tx.invoice.findMany({
      where: {
        firmId: session.firmId,
        fyId: session.fyId,
        partyId,
        deletedAt: null,
        ...(dateFrom || dateTo
          ? {
              invoiceDate: {
                ...(dateFrom ? { gte: new Date(dateFrom + "T00:00:00") } : {}),
                ...(dateTo ? { lte: new Date(dateTo + "T23:59:59") } : {}),
              },
            }
          : {}),
      },
      orderBy: { invoiceDate: "asc" },
    });
    return decorateInvoices(tx, invoices);
  });
}

/** Manual add: find an invoice by number (any date, any age). */
export async function findInvoiceForSubmission(
  q: string
): Promise<{ ok: true; rows: SubmissionInvoiceRow[] } | { ok: false; error: string }> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const invoices = await tx.invoice.findMany({
      where: {
        firmId: session.firmId,
        fyId: session.fyId,
        deletedAt: null,
        invoiceNo: { contains: q.trim(), mode: "insensitive" },
      },
      orderBy: { invoiceDate: "desc" },
      take: 10,
    });
    if (invoices.length === 0) return { ok: false as const, error: `No invoice matches "${q}".` };
    return { ok: true as const, rows: await decorateInvoices(tx, invoices) };
  });
}

// ---------------------------------------------------------------- save

const saveSchema = z.object({
  /** set when editing an existing submission — number is kept, header & invoices updated */
  id: z.string().optional(),
  submissionDate: z.string().min(1, "Submission date is required"),
  partyId: z.string().min(1, "Customer is required"),
  remarks: z.string().optional(),
  invoiceIds: z.array(z.string()).min(1, "Select at least one invoice"),
});

/**
 * Create a bill submission. Automatic return/resubmission logic: any invoice
 * in this batch that already sits in an earlier submission has that earlier
 * item flipped to RETURNED with a pointer to this submission — no manual
 * return entry is ever needed.
 */
export async function saveInvoiceSubmission(
  input: unknown
): Promise<{ ok: true; id: string; submissionNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  await authorize(session, "billing", data.id ? "edit" : "create");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const submissionDate = new Date(data.submissionDate + "T00:00:00");
      if (data.id) return updateSubmission(tx, session, { ...data, id: data.id }, submissionDate);
      // never trust the id list: every invoice must be a live bill of THIS
      // firm/FY belonging to the submission's party — a stale or foreign id
      // would otherwise attach someone else's bill and flip its lifecycle
      const owned = await tx.invoice.findMany({
        where: {
          id: { in: data.invoiceIds },
          firmId: session.firmId,
          fyId: session.fyId,
          partyId: data.partyId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (owned.length !== data.invoiceIds.length) {
        return {
          ok: false as const,
          error: "One or more selected invoices no longer exist for this party — refresh and retry.",
        };
      }
      const submissionNo = await nextSubmissionNo(tx, session.firmId, session.fyId);
      const created = await tx.invoiceSubmission.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          submissionNo,
          submissionDate,
          partyId: data.partyId,
          remarks: data.remarks || null,
          createdById: session.userId,
          items: {
            create: data.invoiceIds.map((invoiceId) => ({
              tenantId: session.tenantId,
              invoiceId,
            })),
          },
        },
      });

      // auto-detect resubmissions: earlier ACTIVE items of these invoices
      // (in other submissions of THIS firm) become RETURNED, pointing here
      await tx.invoiceSubmissionItem.updateMany({
        where: {
          invoiceId: { in: data.invoiceIds },
          submissionId: { not: created.id },
          submission: { firmId: session.firmId },
          status: "SUBMITTED",
        },
        data: {
          status: "RETURNED",
          resubmittedInId: created.id,
          resubmittedInNo: submissionNo,
          resubmissionDate: submissionDate,
        },
      });

      await audit(tx, session, {
        entity: "InvoiceSubmission",
        entityId: created.id,
        action: "CREATE",
        after: { submissionNo, partyId: data.partyId, invoiceIds: data.invoiceIds },
      });
      revalidatePath("/billing/submission");
      return { ok: true as const, id: created.id, submissionNo };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

/**
 * Edit an existing submission: header (date / customer / remarks) and the
 * invoice list. The submission number never changes. Invoices removed here
 * hand their earlier copies back (RETURNED -> SUBMITTED) and invoices added
 * here flip their earlier copies to RETURNED, exactly as a fresh save would.
 */
async function updateSubmission(
  tx: Tx,
  session: ReturnType<typeof requireSession>,
  data: z.infer<typeof saveSchema> & { id: string },
  submissionDate: Date
): Promise<{ ok: true; id: string; submissionNo: string } | { ok: false; error: string }> {
  const existing = await tx.invoiceSubmission.findFirst({
    where: { id: data.id, firmId: session.firmId },
    include: { items: true },
  });
  if (!existing) return { ok: false, error: "Submission not found." };

  const owned = await tx.invoice.findMany({
    where: {
      id: { in: data.invoiceIds },
      firmId: session.firmId,
      fyId: session.fyId,
      partyId: data.partyId,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (owned.length !== data.invoiceIds.length) {
    return {
      ok: false,
      error: "One or more selected invoices do not belong to this customer — refresh and retry.",
    };
  }

  const before = { ...existing, items: existing.items.map((it) => it.invoiceId) };
  const prevIds = new Set(existing.items.map((it) => it.invoiceId));
  const nextIds = new Set(data.invoiceIds);
  const removed = Array.from(prevIds).filter((id) => !nextIds.has(id));
  const added = Array.from(nextIds).filter((id) => !prevIds.has(id));

  await tx.invoiceSubmission.update({
    where: { id: existing.id },
    data: { submissionDate, partyId: data.partyId, remarks: data.remarks || null },
  });

  if (removed.length) {
    await tx.invoiceSubmissionItem.deleteMany({
      where: { submissionId: existing.id, invoiceId: { in: removed } },
    });
    // the earlier copies this submission had marked RETURNED are live again
    await tx.invoiceSubmissionItem.updateMany({
      where: { resubmittedInId: existing.id, invoiceId: { in: removed } },
      data: { status: "SUBMITTED", resubmittedInId: null, resubmittedInNo: null, resubmissionDate: null },
    });
  }

  if (added.length) {
    await tx.invoiceSubmissionItem.createMany({
      data: added.map((invoiceId) => ({
        tenantId: session.tenantId,
        submissionId: existing.id,
        invoiceId,
      })),
    });
    await tx.invoiceSubmissionItem.updateMany({
      where: {
        invoiceId: { in: added },
        submissionId: { not: existing.id },
        submission: { firmId: session.firmId },
        status: "SUBMITTED",
      },
      data: {
        status: "RETURNED",
        resubmittedInId: existing.id,
        resubmittedInNo: existing.submissionNo,
        resubmissionDate: submissionDate,
      },
    });
  }

  // a changed date must show on every earlier copy that points here
  if (existing.submissionDate.getTime() !== submissionDate.getTime()) {
    await tx.invoiceSubmissionItem.updateMany({
      where: { resubmittedInId: existing.id },
      data: { resubmissionDate: submissionDate },
    });
  }

  await audit(tx, session, {
    entity: "InvoiceSubmission",
    entityId: existing.id,
    action: "UPDATE",
    before,
    after: {
      submissionNo: existing.submissionNo,
      submissionDate,
      partyId: data.partyId,
      remarks: data.remarks || null,
      invoiceIds: data.invoiceIds,
    },
  });
  revalidatePath("/billing/submission");
  return { ok: true, id: existing.id, submissionNo: existing.submissionNo };
}

// ---------------------------------------------------------------- acknowledgement

const ackSchema = z.object({
  id: z.string().min(1),
  receivedBy: z.string().min(1, "Received By is required"),
  designation: z.string().optional(),
  receiverMobile: z.string().optional(),
  receivedDate: z.string().min(1, "Receiving date is required"),
  receivedTime: z.string().optional(),
  ackRemarks: z.string().optional(),
});

export async function saveSubmissionAck(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = ackSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  await authorize(session, "billing", "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.invoiceSubmission.findFirstOrThrow({
        where: { id: data.id, firmId: session.firmId },
      });
      const after = await tx.invoiceSubmission.update({
        where: { id: data.id },
        data: {
          receivedBy: data.receivedBy,
          designation: data.designation || null,
          receiverMobile: data.receiverMobile || null,
          receivedDate: new Date(data.receivedDate + "T00:00:00"),
          receivedTime: data.receivedTime || null,
          ackRemarks: data.ackRemarks || null,
        },
      });
      await audit(tx, session, {
        entity: "InvoiceSubmission",
        entityId: data.id,
        action: "UPDATE",
        before,
        after,
      });
    });
    revalidatePath("/billing/submission");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

// ---------------------------------------------------------------- uploads

export async function setSubmissionFile(
  id: string,
  kind: "signed" | "ack" | "support",
  filePath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "billing", "edit");
  if (!filePath.startsWith(`${session.tenantId}/`)) {
    return { ok: false, error: "Invalid file path." };
  }
  const field =
    kind === "signed" ? "signedLetterPath" : kind === "ack" ? "ackCopyPath" : "supportingPath";
  try {
    await withTenant(session.tenantId, async (tx) => {
      // scoped: a submission id from another firm must not be writable here
      await tx.invoiceSubmission.findFirstOrThrow({
        where: { id, firmId: session.firmId },
        select: { id: true },
      });
      await tx.invoiceSubmission.update({ where: { id }, data: { [field]: filePath } });
      await audit(tx, session, {
        entity: "InvoiceSubmission",
        entityId: id,
        action: "UPDATE",
        after: { [field]: filePath },
      });
    });
    revalidatePath("/billing/submission");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Upload failed" };
  }
}

// ---------------------------------------------------------------- details & history

export async function getSubmissionDetails(
  id: string
): Promise<{ ok: true; data: SubmissionDetails } | { ok: false; error: string }> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const sub = await tx.invoiceSubmission.findFirst({
      where: { id, firmId: session.firmId },
      include: { items: { include: { invoice: true } } },
    });
    if (!sub) return { ok: false as const, error: "Submission not found" };
    const party = await tx.party.findUnique({ where: { id: sub.partyId } });
    return {
      ok: true as const,
      data: {
        id: sub.id,
        submissionNo: sub.submissionNo,
        submissionDate: sub.submissionDate.toISOString(),
        partyId: sub.partyId,
        partyName: party?.name ?? "",
        remarks: sub.remarks ?? "",
        receivedBy: sub.receivedBy ?? "",
        designation: sub.designation ?? "",
        receiverMobile: sub.receiverMobile ?? "",
        receivedDate: sub.receivedDate ? sub.receivedDate.toISOString() : null,
        receivedTime: sub.receivedTime ?? "",
        ackRemarks: sub.ackRemarks ?? "",
        signedLetterPath: sub.signedLetterPath,
        ackCopyPath: sub.ackCopyPath,
        supportingPath: sub.supportingPath,
        items: sub.items
          .sort((a, b) => a.invoice.invoiceNo.localeCompare(b.invoice.invoiceNo))
          .map((it) => ({
            invoiceId: it.invoiceId,
            invoiceNo: it.invoice.invoiceNo,
            invoiceDate: it.invoice.invoiceDate.toISOString(),
            amount: toNum(String(it.invoice.netTotal)),
            status: it.status,
            resubmittedInNo: it.resubmittedInNo,
            resubmissionDate: it.resubmissionDate ? it.resubmissionDate.toISOString() : null,
          })),
      },
    };
  });
}

/** Full lifecycle of one invoice across all its submissions. */
export async function getInvoiceSubmissionHistory(
  invoiceId: string
): Promise<{ ok: true; invoiceNo: string; steps: InvoiceHistoryStep[] } | { ok: false; error: string }> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, firmId: session.firmId, deletedAt: null },
    });
    if (!invoice) return { ok: false as const, error: "Invoice not found" };
    const items = await tx.invoiceSubmissionItem.findMany({
      where: { invoiceId },
      include: { submission: true },
      orderBy: { submission: { submissionDate: "asc" } },
    });
    const steps: InvoiceHistoryStep[] = [
      { label: "Generated", detail: `Invoice ${invoice.invoiceNo}`, date: invoice.createdAt.toISOString() },
    ];
    items.forEach((it, idx) => {
      steps.push({
        label: idx === 0 ? "Submitted" : "Resubmitted",
        detail: it.submission.submissionNo,
        date: it.submission.submissionDate.toISOString(),
      });
      if (it.status === "RETURNED") {
        steps.push({
          label: "Returned by Customer",
          detail: `Corrected & resubmitted in ${it.resubmittedInNo ?? "-"}`,
          date: it.resubmissionDate ? it.resubmissionDate.toISOString() : null,
        });
      } else if (it.submission.receivedDate) {
        steps.push({
          label: "Accepted",
          detail: `Acknowledged by ${it.submission.receivedBy ?? "customer"}`,
          date: it.submission.receivedDate.toISOString(),
        });
      }
    });
    // payment status is LIVE and independent of the submission lifecycle: the
    // stored `balance` column freezes at creation and never moves when receipt
    // vouchers settle the bill — the same engine as the Outstanding register
    // decides this step
    const settle = await invoiceSettlement(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      invoices: [invoice],
    });
    if ((settle.get(invoice.id)?.outstanding ?? toNum(String(invoice.balance))) <= 0.009) {
      steps.push({ label: "Payment Received", detail: "Invoice fully settled", date: null });
    }
    return { ok: true as const, invoiceNo: invoice.invoiceNo, steps };
  });
}
