"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { formatDate, formatMoney, formatWt } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import { StatCard } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterBar, type FilterOption } from "@/components/data/filter-bar";
import type { StatusBill, StatusChalan, StatusFilters, StatusLr, StatusReceipt, StatusResult } from "./status-data";

/* ------------------------------------------------------------------ helpers */

const money = (n: number) => formatMoney(n);
const wt = (n: number | null) => (n === null ? "—" : `${formatWt(n)} MT`);
const dt = (s: string | null) => (s ? formatDate(s) : "—");
const rateUnit = (basis: string) =>
  basis === "QTY" ? "/Qty" : basis === "FIXED" ? "/Trip" : basis ? "/MT" : "";

function statusBadge(status: string) {
  const v =
    status === "PAID" ? "success" : status === "PARTLY PAID" ? "warning" : status === "UNPAID" ? "destructive" : "muted";
  return <Badge variant={v}>{status}</Badge>;
}

function podBadge(status: "RECEIVED" | "PENDING") {
  return <Badge variant={status === "RECEIVED" ? "success" : "warning"}>{status === "RECEIVED" ? "Received" : "Pending"}</Badge>;
}

/** "VIEW / DRILL DOWN" toggle used by every section. */
function Drill({
  open,
  onToggle,
  label = "Drill down",
}: {
  open: boolean;
  onToggle: () => void;
  label?: string;
}) {
  return (
    <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onToggle}>
      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      {label}
    </Button>
  );
}

function Section({
  title,
  hint,
  right,
  children,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          {title}
          {hint && <InfoHint>{hint}</InfoHint>}
        </div>
        {right}
      </div>
      <div className="overflow-x-auto p-2">{children}</div>
    </div>
  );
}

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <TableHead className={`h-8 whitespace-nowrap text-xs ${right ? "text-right" : ""}`}>{children}</TableHead>
);
const Td = ({ children, right, strong, className = "" }: { children: React.ReactNode; right?: boolean; strong?: boolean; className?: string }) => (
  <TableCell className={`py-1.5 text-xs ${right ? "text-right tabular-nums" : ""} ${strong ? "font-semibold" : ""} ${className}`}>
    {children}
  </TableCell>
);

/* ------------------------------------------------------------------ receipts */

function ReceiptsTable({ rows, kind, total }: { rows: StatusReceipt[]; kind: "received" | "paid"; total: number }) {
  if (!rows.length) return <p className="px-2 py-1 text-xs text-muted-foreground">No {kind === "received" ? "receipts" : "payments"} recorded.</p>;
  let remaining = total;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <Th>Date</Th>
          <Th>Voucher / Ref</Th>
          <Th>Bank / Cash</Th>
          <Th right>Amount</Th>
          <Th right>TDS</Th>
          <Th right>Shortage</Th>
          <Th right>Other</Th>
          <Th right>Round Off</Th>
          <Th right>Remaining</Th>
          <Th>Remarks</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => {
          remaining = Math.round((remaining - r.amount - r.tds - r.deduction - r.other - r.roundOff) * 100) / 100;
          return (
            <TableRow key={i}>
              <Td>{dt(r.date)}</Td>
              <Td>{r.voucherNo}</Td>
              <Td>{r.account}</Td>
              <Td right strong>{money(r.amount)}</Td>
              <Td right>{r.tds ? money(r.tds) : "—"}</Td>
              <Td right>{r.deduction ? money(r.deduction) : "—"}</Td>
              <Td right>{r.other ? money(r.other) : "—"}</Td>
              <Td right>{r.roundOff ? money(r.roundOff) : "—"}</Td>
              <Td right>{money(remaining)}</Td>
              <Td className="max-w-[16rem] truncate">{r.remarks}</Td>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ bills */

function BillRows({ bills, emptyText }: { bills: StatusBill[]; emptyText: string }) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  if (!bills.length) return <p className="px-2 py-1 text-xs text-muted-foreground">{emptyText}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <Th>Bill No.</Th>
          <Th>Date</Th>
          <Th>Party</Th>
          <Th>Billed LRs</Th>
          <Th>Chalan</Th>
          <Th right>Bill Amount</Th>
          <Th right>Advance</Th>
          <Th right>Received</Th>
          <Th right>Pending</Th>
          <Th>Status</Th>
          <Th> </Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bills.map((b) => (
          <React.Fragment key={b.id}>
            <TableRow>
              <Td strong>
                <Link className="text-primary hover:underline" href={`/billing/register?q=${encodeURIComponent(b.invoiceNo)}`}>
                  {b.invoiceNo}
                </Link>
                <span className="ml-1 text-muted-foreground">({b.kind})</span>
              </Td>
              <Td>{dt(b.invoiceDate)}</Td>
              <Td>{b.party}</Td>
              <Td className="max-w-[14rem]">{b.lrNos.join(", ")}</Td>
              <Td>{b.chalanNos.join(", ") || "—"}</Td>
              <Td right strong>{money(b.netTotal)}</Td>
              <Td right>{money(b.advance)}</Td>
              <Td right>{money(b.received - b.advance)}</Td>
              <Td right strong>{money(b.outstanding)}</Td>
              <Td>{statusBadge(b.status)}</Td>
              <Td>
                <Drill open={!!open[b.id]} onToggle={() => setOpen((p) => ({ ...p, [b.id]: !p[b.id] }))} label="Payments" />
              </Td>
            </TableRow>
            {open[b.id] && (
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={11} className="p-2">
                  <div className="mb-1 grid gap-1 text-xs sm:grid-cols-4">
                    <div>Bill Amount: <b className="tabular-nums">{money(b.netTotal)}</b></div>
                    <div>− Advance: <b className="tabular-nums">{money(b.advance)}</b></div>
                    <div>− Received (net of TDS / deductions): <b className="tabular-nums">{money(b.received - b.advance)}</b></div>
                    <div>= Pending: <b className="tabular-nums">{money(b.outstanding)}</b></div>
                  </div>
                  <ReceiptsTable rows={b.receipts} kind="received" total={b.netTotal - b.advance} />
                </TableCell>
              </TableRow>
            )}
          </React.Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ LR rows */

function LrTable({ lrs, showRoute }: { lrs: StatusLr[]; showRoute?: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <Th>LR No.</Th>
          <Th>Date</Th>
          <Th>Status</Th>
          {showRoute && <Th>Route</Th>}
          <Th>Consignor</Th>
          <Th>Consignee</Th>
          <Th>Bill To</Th>
          <Th right>Qty</Th>
          <Th right>AC WT</Th>
          <Th right>CH WT</Th>
          <Th right>Rate</Th>
          <Th right>Freight</Th>
          <Th right>LR Total</Th>
          <Th>Bill</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lrs.map((l) => (
          <TableRow key={l.id}>
            <Td strong>
              <Link className="text-primary hover:underline" href={`/lr/register?q=${encodeURIComponent(l.lrNo)}`}>
                {l.lrNo}
              </Link>
            </Td>
            <Td>{dt(l.lrDate)}</Td>
            <Td><Badge variant="outline">{l.status.replace(/_/g, " ")}</Badge></Td>
            {showRoute && <Td>{l.from} → {l.to}</Td>}
            <Td>{l.consignor}</Td>
            <Td>{l.consignee}</Td>
            <Td>{l.billTo}</Td>
            <Td right>{l.qty}</Td>
            <Td right>{formatWt(l.actualWt)}</Td>
            <Td right>{formatWt(l.chargeWt)}</Td>
            <Td right>{l.rate ? `${money(l.rate)}${rateUnit(l.rateBasis)}` : "—"}</Td>
            <Td right>{money(l.freight)}</Td>
            <Td right strong>{money(l.grandTotal)}</Td>
            <Td>{l.billNos.length ? l.billNos.join(", ") : <span className="text-muted-foreground">Not billed</span>}</Td>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PodTable({ lrs }: { lrs: StatusLr[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <Th>LR No.</Th>
          <Th>POD Status</Th>
          <Th>Unload Date</Th>
          <Th right>Booking WT</Th>
          <Th right>Received WT</Th>
          <Th right>Shortage WT</Th>
          <Th right>Shortage Amt</Th>
          <Th>POD Date</Th>
          <Th>Ack No.</Th>
          <Th>Remark</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lrs.map((l) => (
          <TableRow key={l.id}>
            <Td strong>{l.lrNo}</Td>
            <Td>{podBadge(l.pod.status)}</Td>
            <Td>{dt(l.pod.unloadDate)}</Td>
            <Td right>{wt(l.pod.actualWt)}</Td>
            <Td right>{wt(l.pod.recWt)}</Td>
            <Td right className={l.pod.shortageWt > 0 ? "text-destructive font-semibold" : ""}>
              {l.pod.status === "RECEIVED" ? wt(l.pod.shortageWt) : "—"}
            </Td>
            <Td right>{l.shortageAmt ? money(l.shortageAmt) : "—"}</Td>
            <Td>{dt(l.pod.podDate)}</Td>
            <Td>{l.pod.ackNo || "—"}</Td>
            <Td className="max-w-[16rem] truncate">{l.pod.remarks}</Td>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ timeline */

function Timeline({ items }: { items: StatusChalan["timeline"] }) {
  return (
    <ol className="flex flex-wrap gap-2">
      {items.map((t, i) => (
        <li
          key={i}
          className={`flex min-w-[9.5rem] flex-1 flex-col rounded-md border px-2.5 py-1.5 text-xs ${
            t.done ? "border-success/40 bg-success/5" : "border-dashed"
          }`}
        >
          <span className="font-semibold">{t.stage}</span>
          <span className="text-muted-foreground">{dt(t.date)}</span>
          <span className={t.done ? "text-success" : "text-muted-foreground"}>{t.status}</span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ chalan block */

function ChalanBlock({ c }: { c: StatusChalan }) {
  const [lrOpen, setLrOpen] = React.useState(false);
  const [finOpen, setFinOpen] = React.useState(false);
  const [podOpen, setPodOpen] = React.useState(false);
  const [billOpen, setBillOpen] = React.useState(false);
  const [tlOpen, setTlOpen] = React.useState(false);
  const s = c.settlement;
  const podDone = c.lrs.filter((l) => l.pod.status === "RECEIVED").length;
  const billed = c.lrs.filter((l) => l.billIds.length).length;
  const totalShortWt = c.lrs.reduce((a, l) => a + l.pod.shortageWt, 0);

  return (
    <Card className={c.cancelled ? "opacity-60" : ""}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Link className="text-primary hover:underline" href={`/chalan/register?q=${encodeURIComponent(c.chalanNo)}`}>
              Chalan {c.chalanNo}
            </Link>
            <span className="text-sm font-normal text-muted-foreground">{dt(c.chalanDate)}</span>
            <Badge variant={c.cancelled ? "destructive" : c.isFinal ? "success" : "muted"}>
              {c.cancelled ? "Cancelled" : c.isFinal ? "Final" : "Draft"}
            </Badge>
            <span className="text-sm font-normal">
              {c.vehicleNo} · {c.broker}
              {c.from || c.to ? ` · ${c.from} → ${c.to}` : ""}
            </span>
          </CardTitle>
          <Drill open={tlOpen} onToggle={() => setTlOpen((v) => !v)} label="Status timeline" />
        </div>
        {tlOpen && (
          <div className="pt-2">
            <Timeline items={c.timeline} />
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* ---- 1. chalan / freight */}
        <Section
          title="1 · Chalan / Freight Details"
          hint="Booking Margin = Booking Bhada − CH Bhada. Booking rate and bhada come from the LRs; charge rate and CH bhada from the chalan."
          right={<Drill open={lrOpen} onToggle={() => setLrOpen((v) => !v)} label={`${c.lrs.length} LR — expand`} />}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <Th>Chalan No.</Th>
                <Th>LR No.</Th>
                <Th>Owner / Broker</Th>
                <Th>Vehicle No.</Th>
                <Th right>Qty</Th>
                <Th right>AC WT</Th>
                <Th right>CH WT</Th>
                <Th right>Booking Rate</Th>
                <Th right>Charge Rate</Th>
                <Th right>Bhada</Th>
                <Th right>CH Bhada</Th>
                <Th right>Booking Margin</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <Td strong>{c.chalanNo}</Td>
                <Td className="max-w-[14rem]">{c.lrs.map((l) => l.lrNo).join(", ") || "—"}</Td>
                <Td>{c.broker}</Td>
                <Td>{c.vehicleNo}</Td>
                <Td right>{c.qty}</Td>
                <Td right>{formatWt(c.actualWt)}</Td>
                <Td right>{formatWt(c.chargeWt)}</Td>
                <Td right>{c.bookingRate ? money(c.bookingRate) : "—"}</Td>
                <Td right>{c.chargeRate ? `${money(c.chargeRate)}${rateUnit(c.rateBasis)}` : "—"}</Td>
                <Td right>{money(c.bookingFreight)}</Td>
                <Td right>{money(c.chFreight)}</Td>
                <Td right strong className={c.margin < 0 ? "text-destructive" : "text-success"}>
                  {money(c.margin)}
                </Td>
              </TableRow>
            </TableBody>
          </Table>
          {lrOpen && (
            <div className="mt-2 border-t pt-2">
              <LrTable lrs={c.lrs} />
            </div>
          )}
        </Section>

        {/* ---- 2. owner / broker settlement */}
        <Section
          title="2 · Owner / Broker Financial Settlement"
          hint="Bhada + additions − deductions = Total Chalan Amount; − Commission − TDS − Mamool − Courier = Grand Total; − Advances = Balance; − payments / shortage / round-off at settlement = Outstanding."
          right={<Drill open={finOpen} onToggle={() => setFinOpen((v) => !v)} label="Advances, payments & adjustments" />}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <Th right>Bhada</Th>
                <Th right>Addition</Th>
                <Th right>Deduction</Th>
                <Th right>Total Chalan</Th>
                <Th right>Commission</Th>
                <Th right>TDS</Th>
                <Th right>Mamool</Th>
                <Th right>Courier</Th>
                <Th right>Grand Total</Th>
                <Th right>Advance</Th>
                <Th>Advance Date</Th>
                <Th right>Balance</Th>
                <Th right>Paid</Th>
                <Th>Balance Date</Th>
                <Th right>Outstanding</Th>
                <Th>Status</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <Td right>{money(s.freight)}</Td>
                <Td right>{money(s.addition)}</Td>
                <Td right>{money(s.deduction)}</Td>
                <Td right>{money(s.totalChalanAmt)}</Td>
                <Td right>{money(s.commission)}</Td>
                <Td right>{money(s.tds)}</Td>
                <Td right>{money(s.mamool)}</Td>
                <Td right>{money(s.courier)}</Td>
                <Td right strong>{money(s.grandTotal)}</Td>
                <Td right>{money(s.advanceTotal)}</Td>
                <Td>{c.advances.length ? c.advances.map((a) => dt(a.date)).join(", ") : "—"}</Td>
                <Td right>{money(s.balance)}</Td>
                <Td right>{money(s.paid)}</Td>
                <Td>{dt(s.balanceDate)}</Td>
                <Td right strong>{money(s.outstanding)}</Td>
                <Td>{statusBadge(s.status)}</Td>
              </TableRow>
            </TableBody>
          </Table>
          {finOpen && (
            <div className="mt-2 grid gap-3 border-t pt-2 lg:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Advances ({c.advances.length})</div>
                {c.advances.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <Th>Date</Th>
                        <Th>Type</Th>
                        <Th>Bank / Cash / Supplier</Th>
                        <Th>Voucher</Th>
                        <Th right>Amount</Th>
                        <Th>Remarks</Th>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.advances.map((a, i) => (
                        <TableRow key={i}>
                          <Td>{dt(a.date)}</Td>
                          <Td>{a.type}</Td>
                          <Td>{a.account}</Td>
                          <Td>{a.voucherNo || "—"}</Td>
                          <Td right strong>{money(a.amount)}</Td>
                          <Td className="max-w-[12rem] truncate">{a.remarks}</Td>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No advances.</p>
                )}
                <div className="mb-1 mt-3 text-xs font-semibold uppercase text-muted-foreground">Balance payments</div>
                <ReceiptsTable rows={c.payments} kind="paid" total={s.balance} />
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Expense / adjustment breakup</div>
                {c.adjustments.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <Th>Head</Th>
                        <Th>Date</Th>
                        <Th>Reference</Th>
                        <Th right>Amount</Th>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.adjustments.map((a, i) => (
                        <TableRow key={i}>
                          <Td>{a.head}</Td>
                          <Td>{dt(a.date)}</Td>
                          <Td>{a.reference || "—"}</Td>
                          <Td right className={a.sign < 0 ? "text-destructive" : "text-success"}>
                            {a.sign < 0 ? "− " : "+ "}
                            {money(a.amount)}
                          </Td>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No additions or deductions.</p>
                )}
              </div>
            </div>
          )}
        </Section>

        {/* ---- 3. POD / receiving / shortage */}
        <Section
          title={`3 · POD / Receiving / Shortage — ${podDone}/${c.lrs.length} received${totalShortWt > 0 ? ` · shortage ${formatWt(totalShortWt)} MT` : ""}`}
          right={<Drill open={podOpen} onToggle={() => setPodOpen((v) => !v)} label="LR-wise POD" />}
        >
          {podOpen ? (
            <PodTable lrs={c.lrs} />
          ) : (
            <div className="flex flex-wrap gap-2 px-1 py-1">
              {c.lrs.map((l) => (
                <span key={l.id} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                  <b>{l.lrNo}</b>
                  {podBadge(l.pod.status)}
                  {l.pod.status === "RECEIVED" && (
                    <span className="text-muted-foreground">
                      {wt(l.pod.recWt)}
                      {l.pod.shortageWt > 0 ? ` · short ${formatWt(l.pod.shortageWt)}` : ""}
                    </span>
                  )}
                </span>
              ))}
              {!c.lrs.length && <span className="text-xs text-muted-foreground">No LRs on this chalan.</span>}
            </div>
          )}
        </Section>

        {/* ---- 4. bill & payment */}
        <Section
          title={`4 · Bill & Payment — ${billed}/${c.lrs.length} LR billed`}
          hint="Bill amount is the bill's own net total — only the LRs actually on that bill, never the whole chalan. Received = advance on the bill + receipt vouchers allocated to it."
          right={<Drill open={billOpen} onToggle={() => setBillOpen((v) => !v)} label={billOpen ? "Collapse" : "Bills & receipts"} />}
        >
          {billOpen ? (
            <BillRows bills={c.bills} emptyText="No bill raised for these LRs yet." />
          ) : c.bills.length ? (
            <div className="flex flex-wrap gap-2 px-1 py-1 text-xs">
              {c.bills.map((b) => (
                <span key={b.id} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1">
                  <b>{b.invoiceNo}</b> {dt(b.invoiceDate)} · {money(b.netTotal)} · pending {money(b.outstanding)} {statusBadge(b.status)}
                </span>
              ))}
            </div>
          ) : (
            <p className="px-2 py-1 text-xs text-muted-foreground">No bill raised for these LRs yet.</p>
          )}
        </Section>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

export function StatusClient({
  data,
  filters,
  brokerOptions,
  vehicleOptions,
}: {
  data: StatusResult;
  filters: StatusFilters;
  brokerOptions: FilterOption[];
  vehicleOptions: FilterOption[];
}) {
  const searched =
    !!filters.lrNo || !!filters.chalanNo || !!filters.billNo || !!filters.vehicleId || !!filters.brokerId || !!filters.dateFrom || !!filters.dateTo;
  const s = data.summary;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold">
        Status — Transaction Tracking
        <InfoHint>
          One search shows the complete chain: LR → Chalan → owner/broker settlement → POD / received weight /
          shortage → Bill (only the LRs actually billed) → advance → receipts → pending. Searching one LR brings
          every LR on the same chalan. Read-only — nothing is posted from here.
        </InfoHint>
      </h1>

      <FilterBar
        filters={[
          { type: "text", key: "lr", label: "LR No." },
          { type: "text", key: "chalan", label: "Chalan No." },
          { type: "text", key: "bill", label: "Bill No." },
          { type: "combobox", key: "vehicle", label: "Vehicle No.", options: vehicleOptions },
          { type: "combobox", key: "broker", label: "Broker / Owner", options: brokerOptions },
          { type: "daterange", key: "date", label: "Chalan Date" },
        ]}
      />

      {!searched ? (
        <Card>
          <CardContent className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
            <Search className="h-5 w-5" />
            Enter an LR No., Chalan No., Bill No., pick a vehicle or broker, or set a date range to trace a transaction.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            <StatCard label="Total LR" value={s.lrs} hint={`${data.chalans.length} chalan${data.chalans.length === 1 ? "" : "s"}`} />
            <StatCard label="Total Qty" value={s.qty} />
            <StatCard label="Total Freight" value={money(s.freight)} hint="booking bhada" />
            <StatCard label="Total Addition" value={money(s.addition)} />
            <StatCard label="Total Deduction" value={money(s.deduction)} />
            <StatCard label="Total Commission" value={money(s.commission)} />
            <StatCard label="Total Mamool" value={money(s.mamool)} />
            <StatCard label="Total TDS" value={money(s.tds)} />
            <StatCard label="Total Advance" value={money(s.advance)} hint="paid to owner / broker" />
            <StatCard label="Total Bill Amount" value={money(s.billAmount)} />
            <StatCard label="Total Received" value={money(s.received)} tone="success" />
            <StatCard label="Total Pending" value={money(s.pending)} tone={s.pending > 0 ? "destructive" : "success"} />
            <StatCard label="Total Shortage" value={`${formatWt(s.shortageWt)} MT`} tone={s.shortageWt > 0 ? "destructive" : "default"} />
          </div>

          {data.truncated && (
            <p className="text-xs text-warning">Showing the latest 150 chalans — narrow the filters to see the rest.</p>
          )}

          {data.chalans.map((c) => (
            <ChalanBlock key={c.id} c={c} />
          ))}

          {data.looseLrs.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">LRs not yet on a chalan ({data.looseLrs.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Section title="LR Details">
                  <LrTable lrs={data.looseLrs} showRoute />
                </Section>
                <Section title="POD / Receiving / Shortage">
                  <PodTable lrs={data.looseLrs} />
                </Section>
                <Section title="Bill & Payment">
                  <BillRows
                    bills={data.bills.filter((b) => data.looseLrs.some((l) => l.billIds.includes(b.id)))}
                    emptyText="No bill raised for these LRs yet."
                  />
                </Section>
              </CardContent>
            </Card>
          )}

          {!data.chalans.length && !data.looseLrs.length && (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">Nothing matched these filters.</CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
