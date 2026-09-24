"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDate, formatMoney, parseDdMmYyyy } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { DateInput } from "@/components/data/date-input";
import { ExportButton } from "@/components/data/export-button";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import {
  deleteStaffAdvance,
  deleteStaffLoan,
  deleteStaffSalary,
  getStaffDetails,
  payStaffSalary,
  payStaffRunning,
  processStaffSalary,
  saveStaffAdvance,
  saveStaffLoan,
  saveStaffProfile,
  type StaffDetails,
} from "@/app/(app)/accounts/staff/actions";

export interface StaffRow {
  partyId: string;
  name: string;
  isActive: boolean;
  employeeId: string;
  department: string;
  designation: string;
  joiningDate: string | null;
  basicSalary: number;
  allowances: number;
  salariesProcessed: number;
  salariesPaid: number;
  pendingSalary: number;
  advanceTotal: number;
  advanceBalance: number;
  loanTotal: number;
  loanOutstanding: number;
  totalRecoveries: number;
  lastSalaryPaid: string | null;
  lastAdvanceDate: string | null;
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function Num({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange?: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        step="0.01"
        className="h-8 text-right tabular-nums"
        value={Number.isFinite(value) ? String(value) : ""}
        disabled={disabled}
        onChange={(e) => onChange?.(Number(e.target.value) || 0)}
        onFocus={(e) => e.target.select()}
      />
    </div>
  );
}

const money = (
  key: keyof Pick<
    StaffRow,
    "pendingSalary" | "advanceBalance" | "loanOutstanding" | "basicSalary"
  >,
  header: string
): ColumnDef<StaffRow> => ({
  accessorKey: key,
  header,
  cell: ({ row }) => formatMoney(row.original[key]),
  meta: {
    numeric: true,
    total: (rows) => formatMoney(rows.reduce((s, r) => s + r[key], 0)),
  } satisfies DataTableColumnMeta<StaffRow>,
});

export function StaffPayrollClient({
  rows,
  bankOptions,
}: {
  rows: StaffRow[];
  bankOptions: MasterOption[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  // dialogs
  const [profileRow, setProfileRow] = React.useState<StaffRow | null>(null);
  const [advanceRow, setAdvanceRow] = React.useState<StaffRow | null>(null);
  const [loanRow, setLoanRow] = React.useState<StaffRow | null>(null);
  const [salaryRow, setSalaryRow] = React.useState<StaffRow | null>(null);
  const [details, setDetails] = React.useState<StaffDetails | null>(null);

  const openDetails = async (partyId: string) => {
    const res = await getStaffDetails(partyId);
    if (res.ok) setDetails(res.data);
    else toast({ variant: "destructive", title: res.error });
  };

  // ---------- profile form ----------
  const [profile, setProfile] = React.useState({
    employeeId: "",
    department: "",
    designation: "",
    joiningDateText: "",
    basicSalary: 0,
    allowances: 0,
  });
  React.useEffect(() => {
    if (profileRow) {
      setProfile({
        employeeId: profileRow.employeeId,
        department: profileRow.department,
        designation: profileRow.designation,
        joiningDateText: profileRow.joiningDate ? formatDate(profileRow.joiningDate) : "",
        basicSalary: profileRow.basicSalary,
        allowances: profileRow.allowances,
      });
    }
  }, [profileRow]);

  const submitProfile = async () => {
    if (!profileRow) return;
    setBusy(true);
    try {
      const res = await saveStaffProfile({
        partyId: profileRow.partyId,
        employeeId: profile.employeeId,
        department: profile.department,
        designation: profile.designation,
        joiningDate: textToIso(profile.joiningDateText) || null,
        basicSalary: profile.basicSalary,
        allowances: profile.allowances,
      });
      if (res.ok) {
        toast({ title: "Staff profile saved" });
        setProfileRow(null);
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(false);
    }
  };

  // ---------- advance form ----------
  const [advance, setAdvance] = React.useState({
    dateText: formatDate(new Date()),
    amount: 0,
    headId: null as string | null,
    remarks: "",
  });
  const submitAdvance = async () => {
    if (!advanceRow) return;
    setBusy(true);
    try {
      const res = await saveStaffAdvance({
        partyId: advanceRow.partyId,
        date: textToIso(advance.dateText),
        amount: advance.amount,
        headId: advance.headId ?? "",
        remarks: advance.remarks,
      });
      if (res.ok) {
        toast({ title: `Advance ${res.advanceNo} recorded and posted to the ledger` });
        setAdvanceRow(null);
        setAdvance({ dateText: formatDate(new Date()), amount: 0, headId: null, remarks: "" });
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(false);
    }
  };

  // ---------- loan form ----------
  const [loan, setLoan] = React.useState({
    dateText: formatDate(new Date()),
    amount: 0,
    emiAmount: 0,
    headId: null as string | null,
    remarks: "",
  });
  const submitLoan = async () => {
    if (!loanRow) return;
    setBusy(true);
    try {
      const res = await saveStaffLoan({
        partyId: loanRow.partyId,
        date: textToIso(loan.dateText),
        amount: loan.amount,
        emiAmount: loan.emiAmount,
        headId: loan.headId ?? "",
        remarks: loan.remarks,
      });
      if (res.ok) {
        toast({ title: `Loan ${res.loanNo} recorded and posted to the ledger` });
        setLoanRow(null);
        setLoan({ dateText: formatDate(new Date()), amount: 0, emiAmount: 0, headId: null, remarks: "" });
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(false);
    }
  };

  // ---------- salary processing ----------
  const emptySalary = {
    month: new Date().toISOString().slice(0, 7),
    basic: 0,
    allowances: 0,
    overtime: 0,
    incentives: 0,
    bonus: 0,
    otherEarnings: 0,
    attendanceAdj: 0,
    leaveDeduction: 0,
    penalties: 0,
    otherDeductions: 0,
    advanceId: null as string | null,
    advanceRecovery: 0,
    loanId: null as string | null,
    loanRecovery: 0,
    remarks: "",
    markPaid: false,
    paymentDateText: formatDate(new Date()),
    paymentHeadId: null as string | null,
  };
  const [salary, setSalary] = React.useState(emptySalary);
  const [salaryDetails, setSalaryDetails] = React.useState<StaffDetails | null>(null);

  const openSalary = async (row: StaffRow) => {
    setSalaryRow(row);
    setSalary({ ...emptySalary, basic: row.basicSalary, allowances: row.allowances });
    const res = await getStaffDetails(row.partyId);
    if (res.ok) setSalaryDetails(res.data);
  };

  // edit a processed month from the details dialog: same form, prefilled —
  // saving reverses and re-posts that month's ledger
  const openSalaryEdit = (d: StaffDetails, s: StaffDetails["salaries"][number]) => {
    const row = rows.find((r) => r.partyId === d.partyId);
    if (!row) return;
    setDetails(null);
    setSalaryRow(row);
    setSalaryDetails(d);
    setSalary({
      month: s.month,
      basic: s.basic,
      allowances: s.allowances,
      overtime: s.overtime,
      incentives: s.incentives,
      bonus: s.bonus,
      otherEarnings: s.otherEarnings,
      attendanceAdj: s.attendanceAdj,
      leaveDeduction: s.leaveDeduction,
      penalties: s.penalties,
      otherDeductions: s.otherDeductions,
      advanceId: s.advanceId,
      advanceRecovery: s.advanceRecovery,
      loanId: s.loanId,
      loanRecovery: s.loanRecovery,
      remarks: s.remarks,
      markPaid: s.paymentStatus === "PAID",
      paymentDateText: s.paymentDate ? formatDate(s.paymentDate) : formatDate(new Date()),
      paymentHeadId: s.paymentHeadId,
    });
  };

  const removeRecord = async (
    kind: "advance" | "loan" | "salary",
    id: string,
    label: string
  ) => {
    if (!details) return;
    if (!window.confirm(`Delete ${label}? Its ledger entries will be reversed.`)) return;
    setBusy(true);
    try {
      const res =
        kind === "advance"
          ? await deleteStaffAdvance(id)
          : kind === "loan"
            ? await deleteStaffLoan(id)
            : await deleteStaffSalary(id);
      if (res.ok) {
        toast({ title: `${label} deleted` });
        await openDetails(details.partyId);
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(false);
    }
  };

  const gross = round2(
    salary.basic + salary.allowances + salary.overtime + salary.incentives + salary.bonus + salary.otherEarnings
  );
  const deductions = round2(
    salary.attendanceAdj +
      salary.leaveDeduction +
      salary.penalties +
      salary.otherDeductions +
      salary.advanceRecovery +
      salary.loanRecovery
  );
  const net = round2(gross - deductions);

  const submitSalary = async () => {
    if (!salaryRow) return;
    setBusy(true);
    try {
      const res = await processStaffSalary({
        partyId: salaryRow.partyId,
        month: salary.month,
        basic: salary.basic,
        allowances: salary.allowances,
        overtime: salary.overtime,
        incentives: salary.incentives,
        bonus: salary.bonus,
        otherEarnings: salary.otherEarnings,
        attendanceAdj: salary.attendanceAdj,
        leaveDeduction: salary.leaveDeduction,
        penalties: salary.penalties,
        otherDeductions: salary.otherDeductions,
        advanceId: salary.advanceId,
        advanceRecovery: salary.advanceRecovery,
        loanId: salary.loanId,
        loanRecovery: salary.loanRecovery,
        remarks: salary.remarks,
        markPaid: salary.markPaid,
        paymentDate: salary.markPaid ? textToIso(salary.paymentDateText) : null,
        paymentHeadId: salary.markPaid ? salary.paymentHeadId : null,
      });
      if (res.ok) {
        toast({
          title: `Salary ${salary.month} processed — net ${formatMoney(res.netSalary)}`,
          description: "Ledger updated (salary expense, recoveries, deductions).",
        });
        setSalaryRow(null);
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(false);
    }
  };

  // pay pending salary from details
  const [payFor, setPayFor] = React.useState<{ salaryId: string; month: string; outstanding: number; running?: boolean } | null>(null);
  const [pay, setPay] = React.useState({ dateText: formatDate(new Date()), headId: null as string | null, amount: 0 });
  const submitPay = async () => {
    if (!payFor || !pay.headId) {
      toast({ variant: "destructive", title: "Select the bank/cash head" });
      return;
    }
    setBusy(true);
    try {
      const res = payFor.running
        ? await payStaffRunning({
            partyId: details?.partyId ?? "",
            paymentDate: textToIso(pay.dateText),
            paymentHeadId: pay.headId,
            amount: pay.amount,
          })
        : await payStaffSalary({
            salaryId: payFor.salaryId,
            paymentDate: textToIso(pay.dateText),
            paymentHeadId: pay.headId,
            amount: pay.amount,
          });
      if (res.ok) {
        toast({
          title: `Salary ${payFor.month}: ${formatMoney(res.paid)} paid`,
          description: res.remaining > 0.009 ? `${formatMoney(res.remaining)} still pending` : "Fully paid",
        });
        setPayFor(null);
        if (details) await openDetails(details.partyId);
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<StaffRow>[] = [
    {
      accessorKey: "name",
      header: "Employee",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.name}</div>
          <div className="text-xs text-muted-foreground">
            {[row.original.employeeId, row.original.designation, row.original.department]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      ),
    },
    money("basicSalary", "Basic Salary"),
    {
      id: "salaryStatus",
      header: "Salary (Paid/Processed)",
      cell: ({ row }) => `${row.original.salariesPaid}/${row.original.salariesProcessed}`,
    },
    money("pendingSalary", "Pending Salary"),
    money("advanceBalance", "Advance Balance"),
    money("loanOutstanding", "Loan Outstanding"),
    {
      accessorKey: "lastSalaryPaid",
      header: "Last Salary Paid",
      cell: ({ row }) =>
        row.original.lastSalaryPaid ? formatDate(row.original.lastSalaryPaid) : "—",
    },
    {
      accessorKey: "isActive",
      header: "Status",
      cell: ({ row }) =>
        row.original.isActive ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setProfileRow(row.original)}>
            Profile
          </Button>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setAdvanceRow(row.original)}>
            Advance
          </Button>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setLoanRow(row.original)}>
            Loan
          </Button>
          <Button variant="secondary" size="sm" className="h-6 px-2 text-xs" onClick={() => void openSalary(row.original)}>
            Salary
          </Button>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => void openDetails(row.original.partyId)}>
            Edit / History
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Staff Payroll &amp; Advances</h1>
        <ExportButton
          rows={rows}
          fileName="staff-payroll-summary"
          sheetName="Staff Summary"
          columns={[
            { header: "Employee", key: "name" },
            { header: "Employee ID", key: "employeeId" },
            { header: "Department", key: "department" },
            { header: "Designation", key: "designation" },
            { header: "Joining Date", accessor: (r) => (r.joiningDate ? formatDate(r.joiningDate) : "") },
            { header: "Basic Salary", key: "basicSalary", numeric: true },
            { header: "Allowances", key: "allowances", numeric: true },
            { header: "Salaries Paid", key: "salariesPaid", numeric: true },
            { header: "Pending Salary", key: "pendingSalary", numeric: true },
            { header: "Advances Given", key: "advanceTotal", numeric: true },
            { header: "Advance Balance", key: "advanceBalance", numeric: true },
            { header: "Loan Total", key: "loanTotal", numeric: true },
            { header: "Loan Outstanding", key: "loanOutstanding", numeric: true },
            { header: "Total Recoveries", key: "totalRecoveries", numeric: true },
            { header: "Last Salary Paid", accessor: (r) => (r.lastSalaryPaid ? formatDate(r.lastSalaryPaid) : "") },
            { header: "Last Advance", accessor: (r) => (r.lastAdvanceDate ? formatDate(r.lastAdvanceDate) : "") },
            { header: "Status", accessor: (r) => (r.isActive ? "ACTIVE" : "INACTIVE") },
          ]}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Staff are Party master records (group STAFF). Advances, loans and salaries post to the
        ledger automatically — open Edit / History to edit a salary month or delete a record
        (its ledger entries are reversed).
      </p>
      <DataTable
        columns={columns}
        data={rows}
        emptyMessage="No staff parties yet — add them in the Party master with group STAFF."
        onRowClick={(row) => void openDetails(row.partyId)}
      />

      {/* profile dialog */}
      <Dialog open={!!profileRow} onOpenChange={(o) => !o && setProfileRow(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Staff Profile — {profileRow?.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Employee ID</Label>
              <Input className="h-8" value={profile.employeeId} onChange={(e) => setProfile((p) => ({ ...p, employeeId: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Department</Label>
              <Input className="h-8" value={profile.department} onChange={(e) => setProfile((p) => ({ ...p, department: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Designation</Label>
              <Input className="h-8" value={profile.designation} onChange={(e) => setProfile((p) => ({ ...p, designation: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Joining Date</Label>
              <DateInput className="h-8" value={profile.joiningDateText} onChange={(t) => setProfile((p) => ({ ...p, joiningDateText: t }))} />
            </div>
            <Num label="Basic Salary (monthly)" value={profile.basicSalary} onChange={(n) => setProfile((p) => ({ ...p, basicSalary: n }))} />
            <Num label="Allowances (monthly)" value={profile.allowances} onChange={(n) => setProfile((p) => ({ ...p, allowances: n }))} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProfileRow(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submitProfile} disabled={busy}>
              {busy ? "Saving..." : "Save Profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* advance dialog */}
      <Dialog open={!!advanceRow} onOpenChange={(o) => !o && setAdvanceRow(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Staff Advance — {advanceRow?.name}</DialogTitle>
            <DialogDescription>
              Advance No is auto-generated; posts to bank/cash and the staff ledger.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Advance Date</Label>
              <DateInput className="h-8" value={advance.dateText} onChange={(t) => setAdvance((a) => ({ ...a, dateText: t }))} />
            </div>
            <Num label="Advance Amount" value={advance.amount} onChange={(n) => setAdvance((a) => ({ ...a, amount: n }))} />
            <div className="space-y-1">
              <Label className="text-xs">Paid From (Bank / Cash)</Label>
              <MasterCombobox options={bankOptions} value={advance.headId} onChange={(v) => setAdvance((a) => ({ ...a, headId: v }))} placeholder="Select head..." />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remarks</Label>
              <Input className="h-8" value={advance.remarks} onChange={(e) => setAdvance((a) => ({ ...a, remarks: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdvanceRow(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submitAdvance} disabled={busy || advance.amount <= 0}>
              {busy ? "Saving..." : "Give Advance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* loan dialog */}
      <Dialog open={!!loanRow} onOpenChange={(o) => !o && setLoanRow(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Staff Loan — {loanRow?.name}</DialogTitle>
            <DialogDescription>
              Loan No is auto-generated; recovery happens through salary processing (EMI
              deductions) — the original loan entry is never modified.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Loan Date</Label>
              <DateInput className="h-8" value={loan.dateText} onChange={(t) => setLoan((l) => ({ ...l, dateText: t }))} />
            </div>
            <Num label="Loan Amount" value={loan.amount} onChange={(n) => setLoan((l) => ({ ...l, amount: n }))} />
            <Num label="EMI / Recovery Amount" value={loan.emiAmount} onChange={(n) => setLoan((l) => ({ ...l, emiAmount: n }))} />
            <div className="space-y-1">
              <Label className="text-xs">Paid From (Bank / Cash)</Label>
              <MasterCombobox options={bankOptions} value={loan.headId} onChange={(v) => setLoan((l) => ({ ...l, headId: v }))} placeholder="Select head..." />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Remarks</Label>
              <Input className="h-8" value={loan.remarks} onChange={(e) => setLoan((l) => ({ ...l, remarks: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLoanRow(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submitLoan} disabled={busy || loan.amount <= 0}>
              {busy ? "Saving..." : "Give Loan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* salary processing dialog */}
      <Dialog open={!!salaryRow} onOpenChange={(o) => !o && setSalaryRow(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Process Salary — {salaryRow?.name}</DialogTitle>
            <DialogDescription>
              Net salary auto-calculates; advance / loan recoveries adjust the open balances.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Salary Month</Label>
              <Input className="h-8" type="month" value={salary.month} onChange={(e) => setSalary((s) => ({ ...s, month: e.target.value }))} />
            </div>
            <Num label="Basic Salary" value={salary.basic} onChange={(n) => setSalary((s) => ({ ...s, basic: n }))} />
            <Num label="Allowances" value={salary.allowances} onChange={(n) => setSalary((s) => ({ ...s, allowances: n }))} />
            <Num label="Overtime" value={salary.overtime} onChange={(n) => setSalary((s) => ({ ...s, overtime: n }))} />
            <Num label="Incentives" value={salary.incentives} onChange={(n) => setSalary((s) => ({ ...s, incentives: n }))} />
            <Num label="Bonus" value={salary.bonus} onChange={(n) => setSalary((s) => ({ ...s, bonus: n }))} />
            <Num label="Other Earnings" value={salary.otherEarnings} onChange={(n) => setSalary((s) => ({ ...s, otherEarnings: n }))} />
            <Num label="Attendance Adj (−)" value={salary.attendanceAdj} onChange={(n) => setSalary((s) => ({ ...s, attendanceAdj: n }))} />
            <Num label="Leave Deduction (−)" value={salary.leaveDeduction} onChange={(n) => setSalary((s) => ({ ...s, leaveDeduction: n }))} />
            <Num label="Penalties (−)" value={salary.penalties} onChange={(n) => setSalary((s) => ({ ...s, penalties: n }))} />
            <Num label="Other Deductions (−)" value={salary.otherDeductions} onChange={(n) => setSalary((s) => ({ ...s, otherDeductions: n }))} />
            <div className="space-y-1">
              <Label className="text-xs">Recover Advance</Label>
              <MasterCombobox
                options={(salaryDetails?.advances ?? [])
                  .filter((a) => a.balance > 0 || a.id === salary.advanceId)
                  .map((a) => ({ value: a.id, label: a.advanceNo, meta: `Bal ${formatMoney(a.balance)}` }))}
                value={salary.advanceId}
                onChange={(v) => setSalary((s) => ({ ...s, advanceId: v }))}
                placeholder="Open advances..."
              />
            </div>
            <Num label="Advance Recovery (−)" value={salary.advanceRecovery} onChange={(n) => setSalary((s) => ({ ...s, advanceRecovery: n }))} />
            <div className="space-y-1">
              <Label className="text-xs">Recover Loan</Label>
              <MasterCombobox
                options={(salaryDetails?.loans ?? [])
                  .filter((l) => l.outstanding > 0 || l.id === salary.loanId)
                  .map((l) => ({ value: l.id, label: l.loanNo, meta: `Out ${formatMoney(l.outstanding)} · EMI ${formatMoney(l.emiAmount)}` }))}
                value={salary.loanId}
                onChange={(v) => {
                  const l = salaryDetails?.loans.find((x) => x.id === v);
                  setSalary((s) => ({
                    ...s,
                    loanId: v,
                    loanRecovery: l && l.emiAmount > 0 ? Math.min(l.emiAmount, l.outstanding) : s.loanRecovery,
                  }));
                }}
                placeholder="Open loans..."
              />
            </div>
            <Num label="Loan Recovery (−)" value={salary.loanRecovery} onChange={(n) => setSalary((s) => ({ ...s, loanRecovery: n }))} />
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Remarks</Label>
              <Input className="h-8" value={salary.remarks} onChange={(e) => setSalary((s) => ({ ...s, remarks: e.target.value }))} />
            </div>
          </div>
          <div className="grid gap-2 rounded-md border bg-muted/40 p-3 text-sm sm:grid-cols-3">
            <div>
              Gross Salary: <b className="tabular-nums">{formatMoney(gross)}</b>
            </div>
            <div>
              Total Deductions: <b className="tabular-nums">{formatMoney(deductions)}</b>
            </div>
            <div>
              Net Salary Payable: <b className="tabular-nums">{formatMoney(net)}</b>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={salary.markPaid}
                onChange={(e) => setSalary((s) => ({ ...s, markPaid: e.target.checked }))}
              />
              Pay now
            </label>
            {salary.markPaid && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Payment Date</Label>
                  <DateInput className="h-8" value={salary.paymentDateText} onChange={(t) => setSalary((s) => ({ ...s, paymentDateText: t }))} />
                </div>
                <div className="w-52 space-y-1">
                  <Label className="text-xs">Paid From (Bank / Cash)</Label>
                  <MasterCombobox options={bankOptions} value={salary.paymentHeadId} onChange={(v) => setSalary((s) => ({ ...s, paymentHeadId: v }))} placeholder="Select head..." />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSalaryRow(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submitSalary} disabled={busy || net < 0}>
              {busy ? "Saving..." : salary.markPaid ? "Process & Pay Salary" : "Process Salary"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* details dialog: dashboard + registers + ledger */}
      <Dialog open={!!details} onOpenChange={(o) => !o && setDetails(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{details?.name} — Financial Profile</DialogTitle>
            <DialogDescription>
              {[
                details?.profile.employeeId && `ID: ${details.profile.employeeId}`,
                details?.profile.designation,
                details?.profile.department,
                details?.profile.joiningDate && `Joined ${formatDate(details.profile.joiningDate)}`,
              ]
                .filter(Boolean)
                .join(" · ") || "No employment profile yet — use the Profile button."}
            </DialogDescription>
          </DialogHeader>
          {details && (
            <div className="space-y-3 text-sm">
              {/* salary register */}
              <div className="rounded-md border p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">
                    Salary Register
                  </span>
                  <ExportButton
                    rows={details.salaries}
                    fileName={`salary-register-${details.name}`}
                    columns={[
                      { header: "Month", key: "month" },
                      { header: "Gross", key: "grossSalary", numeric: true },
                      { header: "Deductions", key: "totalDeductions", numeric: true },
                      { header: "Advance Recovery", key: "advanceRecovery", numeric: true },
                      { header: "Loan Recovery", key: "loanRecovery", numeric: true },
                      { header: "Net Salary", key: "netSalary", numeric: true },
                      { header: "Outstanding", key: "outstanding", numeric: true },
                      { header: "Prev Pending", key: "prevPending", numeric: true },
                      { header: "Running Balance", key: "runningBalance", numeric: true },
                      {
                        header: "Status",
                        accessor: (r) =>
                          r.paymentStatus === "PAID"
                            ? "PAID"
                            : r.isSettled
                              ? "PAID VIA VOUCHER"
                              : r.voucherSettled > 0.009
                                ? "PARTLY PAID"
                                : "PENDING",
                      },
                      { header: "Paid Via Voucher", accessor: (r) => (r.voucherSettled > 0.009 ? r.voucherSettled : "") , numeric: true },
                      { header: "Voucher No", accessor: (r) => r.voucherNos.join(", ") },
                      { header: "Paid On", accessor: (r) => (r.paymentDate ? formatDate(r.paymentDate) : r.voucherPaidDate ? formatDate(r.voucherPaidDate) : "") },
                    ]}
                  />
                </div>
                {details.salaries.length === 0 && (
                  <div className="text-xs text-muted-foreground">No salaries processed yet.</div>
                )}
                {details.salaries.length > 0 && (() => {
                  const last = details.salaries[details.salaries.length - 1];
                  return (
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs">
                      <span>
                        Running salary balance: <b className="tabular-nums">{formatMoney(last.runningBalance)}</b>
                        <span className="text-muted-foreground"> (all pending months, oldest first)</span>
                      </span>
                      {last.runningBalance > 0.009 && (
                        <Button
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => {
                            setPay((p) => ({ ...p, amount: last.runningBalance }));
                            setPayFor({ salaryId: last.id, month: `running balance up to ${last.month}`, outstanding: last.runningBalance, running: true });
                          }}
                        >
                          Pay running balance
                        </Button>
                      )}
                    </div>
                  );
                })()}
                {details.salaries.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 border-b py-1 text-xs last:border-0">
                    <span className="font-medium">{s.month}</span>
                    <span className="tabular-nums">Gross {formatMoney(s.grossSalary)}</span>
                    <span className="tabular-nums">Ded {formatMoney(s.totalDeductions)}</span>
                    <span className="tabular-nums font-medium">Net {formatMoney(s.netSalary)}</span>
                    <span className="tabular-nums text-muted-foreground" title="Outstanding of earlier months">Prev {formatMoney(s.prevPending)}</span>
                    <span className="tabular-nums" title="Previous pending + this month's outstanding">Running <b>{formatMoney(s.runningBalance)}</b></span>
                    {s.paymentStatus === "PAID" ? (
                      <Badge>Paid{s.paymentDate ? ` ${formatDate(s.paymentDate)}` : ""}</Badge>
                    ) : s.isSettled ? (
                      // settled by a payment voucher: not payable again, and a
                      // Pay button here would only dead-end on the guard
                      <Badge variant="secondary" title={s.voucherNos.join(", ")}>
                        Paid via voucher{s.voucherPaidDate ? ` ${formatDate(s.voucherPaidDate)}` : ""}
                        {s.voucherNos.length ? ` (${s.voucherNos.join(", ")})` : ""}
                      </Badge>
                    ) : (
                      <span className="flex items-center gap-1">
                        {s.voucherSettled > 0.009 ? (
                          <Badge variant="warning">
                            Partly paid {formatMoney(s.voucherSettled)} · pending {formatMoney(s.netSalary - s.voucherSettled)}
                          </Badge>
                        ) : (
                          <Badge variant="destructive">Pending</Badge>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => {
                            const outstanding = Math.round((s.netSalary - s.voucherSettled) * 100) / 100;
                            setPay((p) => ({ ...p, amount: outstanding }));
                            setPayFor({ salaryId: s.id, month: s.month, outstanding });
                          }}
                        >
                          Pay
                        </Button>
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={busy}
                        onClick={() => openSalaryEdit(details, s)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={busy}
                        onClick={() => void removeRecord("salary", s.id, `Salary ${s.month}`)}
                      >
                        Delete
                      </Button>
                    </span>
                  </div>
                ))}
              </div>

              {/* advance + loan registers */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border p-3">
                  <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                    Advance Register
                  </div>
                  {details.advances.length === 0 && (
                    <div className="text-xs text-muted-foreground">No advances.</div>
                  )}
                  {details.advances.map((a) => (
                    <div key={a.id} className="border-b py-1 text-xs last:border-0">
                      <div className="flex justify-between">
                        <span className="font-medium">
                          {a.advanceNo} — {formatDate(a.date)}
                        </span>
                        <span className="tabular-nums">{formatMoney(a.amount)}</span>
                      </div>
                      <div className="flex items-center justify-between text-muted-foreground">
                        <span>Adjusted {formatMoney(a.adjusted)}</span>
                        <span className="flex items-center gap-1">
                          <span className={a.balance > 0 ? "font-medium text-foreground" : ""}>
                            Balance {formatMoney(a.balance)}
                          </span>
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-5 px-1.5 text-[10px]"
                            disabled={busy || a.adjusted > 0}
                            title={a.adjusted > 0 ? "Recovered through salary — edit those salaries first" : undefined}
                            onClick={() => void removeRecord("advance", a.id, `Advance ${a.advanceNo}`)}
                          >
                            Delete
                          </Button>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="rounded-md border p-3">
                  <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                    Loan Register
                  </div>
                  {details.loans.length === 0 && (
                    <div className="text-xs text-muted-foreground">No loans.</div>
                  )}
                  {details.loans.map((l) => (
                    <div key={l.id} className="border-b py-1 text-xs last:border-0">
                      <div className="flex justify-between">
                        <span className="font-medium">
                          {l.loanNo} — {formatDate(l.date)}
                        </span>
                        <span className="tabular-nums">{formatMoney(l.amount)}</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>
                          Recovered {formatMoney(l.recovered)}
                          {l.emiAmount > 0 ? ` · EMI ${formatMoney(l.emiAmount)}` : ""}
                        </span>
                        <span className="flex items-center gap-1">
                          Outstanding {formatMoney(l.outstanding)}{" "}
                          {l.status === "CLOSED" ? <Badge variant="secondary">Closed</Badge> : <Badge>Open</Badge>}
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-5 px-1.5 text-[10px]"
                            disabled={busy || l.recovered > 0}
                            title={l.recovered > 0 ? "Recovered through salary — edit those salaries first" : undefined}
                            onClick={() => void removeRecord("loan", l.id, `Loan ${l.loanNo}`)}
                          >
                            Delete
                          </Button>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* staff ledger */}
              <div className="rounded-md border p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">
                    Staff Ledger (running balance)
                  </span>
                  <ExportButton
                    rows={details.ledger}
                    fileName={`staff-ledger-${details.name}`}
                    columns={[
                      { header: "Date", accessor: (r) => formatDate(r.date) },
                      { header: "Type", key: "refType" },
                      { header: "Ref No", key: "refNo" },
                      { header: "Narration", key: "narration" },
                      { header: "Debit", key: "debit", numeric: true },
                      { header: "Credit", key: "credit", numeric: true },
                      { header: "Balance", key: "balance", numeric: true },
                    ]}
                  />
                </div>
                <div className="max-h-64 overflow-auto">
                  {details.ledger.length === 0 && (
                    <div className="text-xs text-muted-foreground">No ledger entries yet.</div>
                  )}
                  {details.ledger.map((e, i) => (
                    <div key={i} className="grid grid-cols-[80px_1fr_70px_70px_80px] gap-1 border-b py-0.5 text-xs last:border-0">
                      <span>{formatDate(e.date)}</span>
                      <span className="truncate" title={e.narration}>
                        {e.refType.replace(/_/g, " ")} {e.refNo} — {e.narration}
                      </span>
                      <span className="text-right tabular-nums">{e.debit ? formatMoney(e.debit) : ""}</span>
                      <span className="text-right tabular-nums">{e.credit ? formatMoney(e.credit) : ""}</span>
                      <span className="text-right tabular-nums font-medium">
                        {formatMoney(Math.abs(e.balance))} {e.balance >= 0 ? "Dr" : "Cr"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetails(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* pay salary dialog */}
      <Dialog open={!!payFor} onOpenChange={(o) => !o && setPayFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pay Salary — {payFor?.month}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Payment Date</Label>
              <DateInput className="h-8" value={pay.dateText} onChange={(t) => setPay((p) => ({ ...p, dateText: t }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Paid From (Bank / Cash)</Label>
              <MasterCombobox options={bankOptions} value={pay.headId} onChange={(v) => setPay((p) => ({ ...p, headId: v }))} placeholder="Select head..." />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Amount (outstanding {formatMoney(payFor?.outstanding ?? 0)} — reduce for a part payment)</Label>
              <Input
                type="number"
                step="0.01"
                className="h-8 text-right"
                value={pay.amount ? String(pay.amount) : ""}
                onChange={(e) => setPay((p) => ({ ...p, amount: Number(e.target.value) || 0 }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayFor(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submitPay} disabled={busy}>
              {busy ? "Paying..." : "Pay Salary"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
