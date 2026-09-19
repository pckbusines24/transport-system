import Link from "next/link";
import {
  BarChart3,
  BookOpen,
  ClipboardCheck,
  FileText,
  Landmark,
  ReceiptText,
  Scale,
  Truck,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";
import { requireSession } from "@/lib/session";
import { Card, CardContent } from "@/components/ui/card";

// Report cards open the Month Browser: month chips on top, the whole list
// below with endless scroll and filters. The working registers inside each
// module stay untouched — this is the reading view.
const SECTIONS: { title: string; links: { label: string; href: string; icon: typeof FileText; desc: string }[] }[] = [
  {
    title: "Operations",
    links: [
      { label: "LR Register", href: "/reports/browser?src=LR", icon: FileText, desc: "Month-wise bookings, endless scroll" },
      { label: "Chalan (Market / Broker)", href: "/reports/browser?src=CHALAN_MARKET", icon: Truck, desc: "Market vehicle chalans and balances" },
      { label: "Chalan (Own / Relative)", href: "/reports/browser?src=CHALAN_OWNREL", icon: Truck, desc: "Own and relative vehicle chalans" },
      { label: "POD Register", href: "/reports/browser?src=POD", icon: ClipboardCheck, desc: "Proof-of-delivery records" },
      { label: "Broker Register", href: "/reports/browser?src=BROKER", icon: Users, desc: "Broker slips, both sides" },
    ],
  },
  {
    title: "Billing",
    links: [
      { label: "Billing Register", href: "/reports/browser?src=BILLING", icon: ReceiptText, desc: "PT / FT / Manual / GST invoices" },
      { label: "Outstanding Receivable", href: "/reports/browser?src=OUT_RECV", icon: Scale, desc: "Bills where money is still to come" },
      { label: "Outstanding Payable", href: "/reports/browser?src=OUT_PAY", icon: Scale, desc: "Chalans / slips still to be paid" },
      { label: "Voucher Register", href: "/reports/browser?src=VOUCHER", icon: Wallet, desc: "Receipts, payments, contra, journal" },
    ],
  },
  {
    title: "Accounts",
    links: [
      { label: "Bank Book", href: "/reports/browser?src=BOOK_BANK", icon: Landmark, desc: "Bank accounts, running balance" },
      { label: "Cash Book", href: "/reports/browser?src=BOOK_CASH", icon: Landmark, desc: "Cash accounts, running balance" },
      { label: "Card Book", href: "/reports/browser?src=BOOK_CARD", icon: Landmark, desc: "Card accounts, running balance" },
      { label: "Ledger Summary", href: "/reports/browser?src=LEDGER", icon: BookOpen, desc: "Pick a ledger, read it month-wise" },
      { label: "Common Ledgers", href: "/reports/browser?src=COMMON", icon: Scale, desc: "Shortage, round off, commission, mamool, detention" },
      { label: "TDS Payable", href: "/reports/browser?src=TDS_PAY", icon: Scale, desc: "TDS we deducted, month-wise" },
      { label: "TDS Receivable", href: "/reports/browser?src=TDS_RECV", icon: Scale, desc: "TDS deducted from us, month-wise" },
      { label: "TDS Report – Quarterly Wise", href: "/reports/tds-quarterly", icon: Scale, desc: "Payable TDS: party × rate × Q1–Q4, with drill-down" },
      { label: "Purchase & Sale Register", href: "/reports/purchase-sale", icon: ReceiptText, desc: "Party × month matrix with TDS — bills, chalans and slips" },
      { label: "Company Operational P&L", href: "/accounts/operational-pnl", icon: BarChart3, desc: "Operational income vs expense" },
    ],
  },
  {
    title: "Fleet",
    links: [
      {
        label: "Vehicle Operational Profit & Loss",
        href: "/accounts/vehicle-operational-pnl",
        icon: BarChart3,
        desc: "Own fleet: trip income vs vehicle costs, driver payments and EMI",
      },
      {
        label: "Trip Profit & Loss with Expenses",
        href: "/vehicle/pnl",
        icon: Wrench,
        desc: "Vehicle-wise trips with expense drill-down",
      },
      {
        label: "Vehicle Expense Adjustment Report",
        href: "/reports/vehicle-expense-adjustment",
        icon: Scale,
        desc: "Chalan / broker-slip expense deductions vs Vehicle Expense Book, head-wise with drill-down",
      },
    ],
  },
  {
    title: "Integration",
    links: [
      {
        label: "Tally Export",
        href: "/reports/tally-export",
        icon: BookOpen,
        desc: "Chalan, billing, slips, vouchers & expenses as Tally Prime import files",
      },
    ],
  },
];

export default function ReportsHubPage() {
  requireSession();
  return (
    <div className="space-y-6 p-4">
      <h1 className="page-title">Reports &amp; Registers</h1>
      {SECTIONS.map((s) => (
        <div key={s.title} className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {s.title}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {s.links.map((l) => (
              <Link key={l.href} href={l.href} className="group">
                <Card className="h-full transition-all hover:border-primary/40 hover:shadow-card">
                  <CardContent className="flex items-start gap-3 p-4">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <l.icon className="h-[18px] w-[18px]" />
                    </span>
                    <span>
                      <span className="block font-medium group-hover:text-primary">{l.label}</span>
                      <span className="block text-sm text-muted-foreground">{l.desc}</span>
                    </span>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
