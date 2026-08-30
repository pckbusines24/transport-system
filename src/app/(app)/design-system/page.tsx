import type { Metadata } from "next";
import { ArrowUpRight, Building2, Package, Truck, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardToolbar,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Meter, SegmentedMeter, Stat } from "@/components/ui/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Design System" };

/**
 * Living specimen of the design system. Every token and primitive appears
 * here, so a change to globals.css can be judged on one screen instead of by
 * clicking through forty of them.
 *
 * Keep this page in sync when a primitive gains a variant — an undocumented
 * variant is one nobody will use.
 */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-eyebrow">{title}</h2>
        {hint && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Swatch({ name, className, note }: { name: string; className: string; note?: string }) {
  return (
    <div className="space-y-1.5">
      <div className={`h-16 rounded-lg border border-border/60 ${className}`} />
      <div className="text-xs font-medium">{name}</div>
      {note && <div className="text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

export default function DesignSystemPage() {
  return (
    <div className="space-y-12 p-4 pb-20 sm:p-6">
      <header className="space-y-3">
        <h1 className="text-display">Design system</h1>
        <p className="max-w-2xl text-muted-foreground">
          One warm canvas, near-white panels, ink for emphasis and yellow for accent. Everything
          below resolves to a CSS variable in <code className="text-foreground">globals.css</code>,
          so dark mode is a variable swap and never a second set of classes.
        </p>
      </header>

      <Section
        title="Surfaces"
        hint="Separation comes from surface and shadow, not from drawn lines. Borders stay near-invisible so a dense register does not turn into a grid of boxes."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Swatch name="background" className="bg-background" note="the page canvas" />
          <Swatch name="card" className="bg-card" note="panels" />
          <Swatch name="sunken" className="bg-sunken" note="inputs, table headers, wells" />
          <Swatch name="inverted" className="bg-inverted" note="one emphasis panel per screen" />
        </div>
      </Section>

      <Section title="Brand & status" hint="Badges pick a tone, never a colour.">
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Swatch name="primary" className="bg-primary" />
          <Swatch name="secondary" className="bg-secondary" />
          <Swatch name="success" className="bg-success" />
          <Swatch name="warning" className="bg-warning" />
          <Swatch name="destructive" className="bg-destructive" />
          <Swatch name="info" className="bg-info" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>Default</Badge>
          <Badge variant="ink">Ink</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="muted">Muted</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="success" dot>
            Paid
          </Badge>
          <Badge variant="warning" dot>
            Pending
          </Badge>
          <Badge variant="destructive" dot>
            Overdue
          </Badge>
          <Badge variant="info" dot>
            In transit
          </Badge>
        </div>
      </Section>

      <Section
        title="Typography"
        hint="Display type is light and tight — at 40px a regular weight reads heavy and dated. Labels go the other way: small, medium, widely tracked."
      >
        <Card>
          <CardContent className="space-y-5 pt-6">
            <div>
              <div className="text-display">Welcome back</div>
              <div className="mt-1 text-xs text-muted-foreground">.text-display</div>
            </div>
            <div>
              <div className="text-metric">₹12,48,900</div>
              <div className="mt-1 text-xs text-muted-foreground">.text-metric — tabular figures</div>
            </div>
            <div>
              <div className="page-title">Section heading</div>
              <div className="mt-1 text-xs text-muted-foreground">.page-title</div>
            </div>
            <div>
              <div className="text-eyebrow">Outstanding</div>
              <div className="mt-1 text-xs text-muted-foreground">.text-eyebrow</div>
            </div>
            <div>
              <p className="max-w-prose text-sm">
                Body copy sits at 14px with generous line height. Long-form explanation in this app
                is rare — most screens are dense tables — so body text is tuned for short helper
                paragraphs rather than articles.
              </p>
              <div className="mt-1 text-xs text-muted-foreground">text-sm</div>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Elevation"
        hint="Four steps. Blur and spread rise together, so height reads as distance rather than as a darker line."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["shadow-sm", "shadow-sm", "resting controls"],
            ["shadow-card", "shadow-card", "panels"],
            ["shadow-raised", "shadow-raised", "hover, emphasis"],
            ["shadow-overlay", "shadow-overlay", "dialogs, popovers"],
          ].map(([name, cls, note]) => (
            <div key={name} className="space-y-1.5">
              <div className={`h-16 rounded-xl bg-card ${cls}`} />
              <div className="text-xs font-medium">{name}</div>
              <div className="text-xs text-muted-foreground">{note}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Buttons"
        hint="A hierarchy, not a palette. At most one default per view — it is the single thing the screen wants you to do."
      >
        <Card>
          <CardContent className="space-y-6 pt-6">
            <div className="flex flex-wrap items-center gap-3">
              <Button>Primary</Button>
              <Button variant="ink">Ink</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Delete</Button>
              <Button variant="link">Link</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">Small</Button>
              <Button>Default</Button>
              <Button size="lg">Large</Button>
              <Button size="icon" variant="outline" aria-label="Open">
                <ArrowUpRight />
              </Button>
              <Button size="icon" pill variant="ink" aria-label="Open">
                <ArrowUpRight />
              </Button>
              <Button pill variant="outline">
                Pill
              </Button>
              <Button disabled>Disabled</Button>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Metrics" hint="Headline figures and the segmented header meter.">
        <Card>
          <CardContent className="space-y-8 pt-6">
            <div className="flex flex-wrap gap-10">
              <Stat label="Employees" value="78" icon={<Users />} delta={4} />
              <Stat label="Vehicles" value="56" icon={<Truck />} delta={-2} />
              <Stat label="Trips" value="203" icon={<Package />} />
              <Stat label="Firms" value="6" icon={<Building2 />} size="sm" />
            </div>
            <SegmentedMeter
              segments={[
                { label: "Delivered", value: 62, tone: "ink" },
                { label: "In transit", value: 21, tone: "primary" },
                { label: "Pending", value: 12, tone: "hatched" },
                { label: "Held", value: 5, tone: "outline" },
              ]}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <Meter label="Collection" value={72} />
              <Meter label="POD returned" value={41} tone="ink" />
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Cards"
        hint="Variants describe a role, not a colour. Use inverted at most once per screen or it stops meaning anything."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Plain</CardTitle>
              <CardDescription>The default panel.</CardDescription>
            </CardHeader>
            <CardContent className="pt-0 text-sm text-muted-foreground">
              Content sits on white with a hairline border and the card shadow.
            </CardContent>
          </Card>
          <Card variant="inverted">
            <CardToolbar>
              <div>
                <CardTitle>Inverted</CardTitle>
                <CardDescription className="text-inverted-muted">
                  The emphasis panel.
                </CardDescription>
              </div>
              <Button size="icon-sm" pill variant="ghost" aria-label="Open">
                <ArrowUpRight />
              </Button>
            </CardToolbar>
            <CardContent className="text-sm text-inverted-muted">
              Reserved for the one thing that matters most on a screen.
            </CardContent>
          </Card>
          <Card variant="sunken">
            <CardHeader>
              <CardTitle>Sunken</CardTitle>
              <CardDescription>A well.</CardDescription>
            </CardHeader>
            <CardContent className="pt-0 text-sm">
              Filters and empty states — carved into the page rather than sitting on it.
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Forms" hint="Fields are filled, not outlined. The border only asserts itself on focus.">
        <Card>
          <CardContent className="grid gap-5 pt-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ds-lr">LR number</Label>
              <Input id="ds-lr" placeholder="e.g. 10428" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ds-party">Consignor</Label>
              <Input id="ds-party" placeholder="Search party…" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ds-disabled">Disabled</Label>
              <Input id="ds-disabled" disabled placeholder="Not editable" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ds-amount">Freight</Label>
              <Input id="ds-amount" inputMode="decimal" defaultValue="12,500.00" className="tabular" />
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Table"
        hint="Registers are the heart of this app. Numerals are tabular so columns never jitter, and rows separate by tint rather than by rules."
      >
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>LR No</TableHead>
                <TableHead>Party</TableHead>
                <TableHead className="text-right">Freight</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                ["10428", "Shree Traders", "12,500.00", "success", "Paid"],
                ["10429", "Kisan Agro", "8,140.00", "warning", "Pending"],
                ["10430", "Metro Steel", "31,900.00", "destructive", "Overdue"],
              ].map(([no, party, amt, tone, label]) => (
                <TableRow key={no}>
                  <TableCell className="font-medium">{no}</TableCell>
                  <TableCell>{party}</TableCell>
                  <TableCell className="text-right tabular-nums">{amt}</TableCell>
                  <TableCell>
                    <Badge variant={tone as "success" | "warning" | "destructive"} dot>
                      {label}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>
    </div>
  );
}
