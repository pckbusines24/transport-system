import {
  LayoutDashboard,
  Database,
  FileText,
  Truck,
  ClipboardCheck,
  ReceiptText,
  Handshake,
  Wallet,
  Wrench,
  BarChart3,
  Settings,
  type LucideIcon,
} from "lucide-react";

/**
 * A menu entry: either a link, or a nested group of links rendered as a
 * flyout submenu (desktop) / nested accordion (mobile).
 */
export interface NavItem {
  label: string;
  /** omitted when this entry is a submenu */
  href?: string;
  /** present when this entry opens a submenu instead of navigating */
  items?: NavItem[];
}

export interface NavGroup {
  label: string;
  icon: LucideIcon;
  href?: string;
  items?: NavItem[];
}

export const NAV: NavGroup[] = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
  {
    label: "Masters",
    icon: Database,
    items: [
      { label: "Ledger / Parties", href: "/masters/parties" },
      { label: "Accounts (Bank / Cash / Card)", href: "/masters/bank-cash-heads" },
      { label: "Income-Expense Heads", href: "/masters/account-heads" },
      { label: "TDS Master", href: "/masters/tds-sections" },
      // groups, products and units are tabs of one screen
      { label: "Product Master", href: "/masters/products" },
      { label: "States", href: "/masters/states" },
      { label: "Cities", href: "/masters/cities" },
      { label: "Vehicles", href: "/masters/vehicles" },
      { label: "Rate Setup", href: "/masters/rates" },
      // types and registrations are tabs of one screen
      { label: "Document Master", href: "/masters/document-master" },
    ],
  },
  {
    label: "Booking",
    icon: FileText,
    items: [
      { label: "LR Entry", href: "/lr" },
      { label: "Multiple LR Entry", href: "/lr/multiple" },
      { label: "LR Register", href: "/lr/register" },
    ],
  },
  {
    label: "Fleet Ops",
    icon: Truck,
    items: [
      { label: "Chalan Entry", href: "/chalan" },
      { label: "Chalan Register", href: "/chalan/register" },
      { label: "Chalan Cancel Advances", href: "/chalan/cancel-advances" },
      // the less-used fleet screens sit behind one flyout so the day-to-day
      // chalan entries stay at the top of the menu
      {
        label: "Others",
        items: [
          { label: "Loading Challan", href: "/loading-chalan" },
          { label: "Unloading / Arrival", href: "/arrival" },
          { label: "Delivery (Gate Pass / Cash Memo)", href: "/delivery" },
          { label: "Crossing", href: "/crossing" },
          { label: "Outward Crossing", href: "/outward-crossing" },
          { label: "Hire Slip", href: "/hire-slip" },
          { label: "Summary Entry", href: "/summary" },
        ],
      },
    ],
  },
  {
    label: "POD",
    icon: ClipboardCheck,
    items: [
      { label: "POD Confirmation", href: "/pod" },
      { label: "POD Register", href: "/pod/register" },
      { label: "POD Follow-up", href: "/pod/follow-up" },
    ],
  },
  {
    label: "Billing",
    icon: ReceiptText,
    items: [
      { label: "Billing (Full Truck)", href: "/billing/full-truck" },
      { label: "Bill Submission", href: "/billing/submission" },
      { label: "Billing Register", href: "/billing/register" },
      { label: "Rate Change Register", href: "/billing/rate-change" },
      { label: "Trip Closure Intimation", href: "/billing/trip-closure" },
      // the less-used bill types sit behind one flyout, last in the menu
      {
        label: "Others",
        items: [
          { label: "Billing (Part Truck)", href: "/billing/part-truck" },
          { label: "Billing (Manual)", href: "/billing/manual" },
          { label: "GST Invoice", href: "/billing/gst" },
        ],
      },
    ],
  },
  {
    label: "Broker",
    icon: Handshake,
    items: [
      { label: "Broker Slip Entry", href: "/broker/slip" },
      { label: "Broker Register", href: "/broker/register" },
      { label: "Courier Dispatch", href: "/broker/courier" },
    ],
  },
  {
    label: "Accounts",
    icon: Wallet,
    items: [
      // entry types and the register are tabs of one screen
      { label: "Vouchers", href: "/accounts/vouchers" },
      { label: "Bank / Cash / Card Book", href: "/accounts/bank-book" },
      { label: "Company Operational P&L", href: "/accounts/operational-pnl" },
      { label: "Vehicle Operational P&L", href: "/accounts/vehicle-operational-pnl" },
      { label: "Ledger Summary", href: "/accounts/ledger" },
      // receivable and payable are tabs of one screen
      { label: "Outstanding Register", href: "/accounts/outstanding" },
      { label: "TDS Register", href: "/accounts/tds" },
      { label: "Advance Register", href: "/accounts/advances" },
      // office transactions and staff payroll are tabs of one screen
      { label: "Office Management", href: "/accounts/office" },
      // loans and non-operational money live in their own module
      { label: "Finance & Loans", href: "/finance" },
      { label: "Common Ledgers", href: "/accounts/common-ledger" },
    ],
  },
  {
    label: "Vehicle",
    icon: Wrench,
    items: [
      // register, sheets and expenses are tabs of one screen
      { label: "Trip Management", href: "/trips" },
      // expenses, summary, tracking and P&L are tabs of one screen
      { label: "Vehicle Management", href: "/vehicle/management" },
      // driver info, salary, +/- settlement, advance and F&F are tabs of one screen
      { label: "Driver Management", href: "/vehicle/driver-management" },
      { label: "Extra Work Information", href: "/vehicle/work" },
      { label: "Tyre Management", href: "/vehicle/tyres" },
      // operational tracking only — no accounting / Tally link
      { label: "Spare Parts & Warranty", href: "/vehicle/spare-parts" },
      { label: "AdBlue (Urea) Stock", href: "/vehicle/adblue" },
    ],
  },
  {
    label: "Reports",
    icon: BarChart3,
    items: [
      { label: "All Registers", href: "/reports" },
      { label: "LR Register", href: "/lr/register" },
      { label: "Cancelled LR Report", href: "/reports/cancelled-lrs" },
      { label: "Paper Change LR Report", href: "/reports/paper-change-lrs" },
    ],
  },
  {
    label: "Settings",
    icon: Settings,
    items: [
      { label: "Firm Settings", href: "/settings/firm" },
      { label: "Users", href: "/settings/users" },
      { label: "Role Permissions", href: "/settings/permissions" },
      { label: "Tally Mapping", href: "/settings/tally" },
      { label: "Audit Log", href: "/settings/audit" },
    ],
  },
];
