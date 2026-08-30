import { redirect } from "next/navigation";
import { Building2, LogOut, MapPin } from "lucide-react";
import { LogoMark } from "@/components/brand/logo";
import { withTenant } from "@/lib/db";
import { getSession } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { selectFirm } from "./actions";
import { FyButton } from "./fy-button";

export const dynamic = "force-dynamic";

export default async function SelectFirmPage() {
  const session = getSession();
  if (!session) redirect("/login");

  const firms = await withTenant(session.tenantId, async (tx) => {
    const assignments = await tx.userFirm.findMany({ where: { userId: session.userId } });
    const firmIds = assignments.map((a) => a.firmId);
    return tx.firm.findMany({
      where: {
        tenantId: session.tenantId,
        isActive: true,
        ...(firmIds.length > 0 ? { id: { in: firmIds } } : {}),
      },
      include: {
        financialYears: { where: { isActive: true }, orderBy: { startDate: "desc" } },
      },
      orderBy: { name: "asc" },
    });
  });

  const initials = session.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background p-4">
      {/* One wash, anchored top-right to match the app canvas. The previous
          version stacked a gradient band and two blurred blobs, which is three
          decorations competing on a page whose entire job is one choice. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60rem 34rem at 85% -10%, hsl(var(--primary) / 0.20), transparent 60%)",
        }}
        aria-hidden
      />

      <div className="relative w-full max-w-2xl space-y-8">
        {/* brand + user strip */}
        <div className="flex flex-col items-center gap-5 text-center">
          <LogoMark className="h-14 w-14" />
          <div>
            <h1 className="text-3xl font-light tracking-[-0.02em]">
              Welcome back, {session.name.split(/\s+/)[0]}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose a firm and financial year to start working
            </p>
          </div>
        </div>

        {firms.length === 0 && (
          <Card className="shadow-card">
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              No firms are available for your account. Contact your administrator.
            </CardContent>
          </Card>
        )}

        <div className="space-y-4">
          {firms.map((firm) => (
            <Card
              key={firm.id}
              className="overflow-hidden border-border/70 shadow-card transition-shadow hover:shadow-lg"
            >
              <CardContent className="p-0">
                <div className="flex items-center gap-4 border-b bg-muted/40 px-5 py-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15">
                    <Building2 className="h-5 w-5 text-primary" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold">{firm.name}</p>
                    {firm.address1 && (
                      <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {firm.address1}
                      </p>
                    )}
                  </div>
                  {firm.gstin && (
                    <Badge variant="outline" className="tabular hidden shrink-0 text-[10px] sm:inline-flex">
                      {firm.gstin}
                    </Badge>
                  )}
                </div>

                <div className="px-5 py-4">
                  {firm.financialYears.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No financial years configured.</p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {firm.financialYears.map((fy) => (
                        <form key={fy.id} action={selectFirm}>
                          <input type="hidden" name="firmId" value={firm.id} />
                          <input type="hidden" name="fyId" value={fy.id} />
                          <FyButton
                            label={`FY ${fy.label}`}
                            sub={`${formatDate(fy.startDate)} — ${formatDate(
                              // a 23:59:59-stamped end date would read as the
                              // NEXT IST day — pull late stamps back before
                              // formatting so 31 March prints as 31 March
                              fy.endDate.getUTCHours() >= 12
                                ? new Date(fy.endDate.getTime() - 13 * 3600 * 1000)
                                : fy.endDate
                            )}`}
                          />
                        </form>
                      ))}
                      {/* FY continuity: the NEXT year is always offered — picking
                          it creates the year and steps in, no setup screen */}
                      {(() => {
                        const latest = firm.financialYears[0];
                        const y = latest.startDate.getFullYear() + 1;
                        return (
                          <form action={selectFirm}>
                            <input type="hidden" name="firmId" value={firm.id} />
                            <input type="hidden" name="fyId" value="__next__" />
                            <FyButton
                              label={`FY ${y}-${y + 1}`}
                              sub="new year — created as soon as you select it"
                              dashed
                            />
                          </form>
                        );
                      })()}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex items-center justify-center gap-3 pt-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold">
            {initials}
          </span>
          <span className="text-sm text-muted-foreground">
            {session.name} · {session.role}
          </span>
          <form action="/logout" method="POST">
            <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
