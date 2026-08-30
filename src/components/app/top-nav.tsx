"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  ChevronDown,
  LogOut,
  Menu,
  Search,
  User,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { NAV, type NavGroup, type NavItem } from "@/components/app/nav-config";

export interface TopNavProps {
  firmName: string;
  fyLabel: string;
  userName: string;
  role: string;
}

const hrefActive = (href: string, pathname: string) =>
  pathname === href || pathname.startsWith(href + "/");

/** True when this entry, or anything nested under it, matches the route. */
function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.items) return item.items.some((c) => isItemActive(c, pathname));
  return !!item.href && hrefActive(item.href, pathname);
}

function isGroupActive(group: NavGroup, pathname: string): boolean {
  if (group.href) return hrefActive(group.href, pathname);
  return group.items?.some((i) => isItemActive(i, pathname)) ?? false;
}

/** Desktop menu bar: one dropdown per module group. */
function DesktopMenu({ pathname }: { pathname: string }) {
  return (
    // The row is constrained to the same max-width and padding as <main>, so
    // Dashboard lines up with the page title beneath it instead of hugging the
    // window edge. justify-between spreads the groups across that width, which
    // means adding or removing a menu item redistributes the row on its own -
    // no gap opening up on the right. Once the groups no longer fit,
    // justify-between stops applying and the row scrolls instead.
    // One inset track rather than a full-width bar: the group reads as a single
    // control, and the active item is a filled pill inside it. A bar spanning
    // the window is what made this look like a 2010 admin panel.
    <nav className="no-print hidden w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-sunken p-1 lg:flex">
      {NAV.map((group) => {
        const active = isGroupActive(group, pathname);
        if (group.href) {
          return (
            <Link
              key={group.label}
              href={group.href}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors duration-fast",
                active
                  ? "bg-inverted text-inverted-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-card hover:text-foreground"
              )}
            >
              <group.icon className="h-4 w-4" />
              {group.label}
            </Link>
          );
        }
        return (
          <DropdownMenu key={group.label}>
            <DropdownMenuTrigger
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium outline-none transition-colors duration-fast",
                active
                  ? "bg-inverted text-inverted-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-card hover:text-foreground",
                "data-[state=open]:bg-card data-[state=open]:text-foreground"
              )}
            >
              <group.icon className="h-4 w-4" />
              {group.label}
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {group.items!.map((item) =>
                item.items ? (
                  <DropdownMenuSub key={item.label}>
                    <DropdownMenuSubTrigger
                      className={cn(
                        "cursor-pointer",
                        isItemActive(item, pathname) && "bg-primary/10 font-medium"
                      )}
                    >
                      {item.label}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-64">
                      {item.items.map((sub) => (
                        <DropdownMenuItem key={sub.href} asChild>
                          <Link
                            href={sub.href!}
                            className={cn(
                              "w-full cursor-pointer",
                              pathname === sub.href && "bg-primary/10 font-medium"
                            )}
                          >
                            {sub.label}
                          </Link>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : (
                  <DropdownMenuItem key={item.href! + item.label} asChild>
                    <Link
                      href={item.href!}
                      className={cn(
                        "w-full cursor-pointer",
                        pathname === item.href && "bg-primary/10 font-medium"
                      )}
                    >
                      {item.label}
                    </Link>
                  </DropdownMenuItem>
                )
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </nav>
  );
}

/**
 * Mobile: a left drawer with an overlay, portalled to <body>.
 *
 * The portal is not optional. The header carries `backdrop-blur`, and an element
 * with a backdrop-filter becomes the containing block for its fixed descendants -
 * rendered in place, `inset-0` would resolve to the header strip and the drawer
 * would be clipped inside it instead of covering the viewport.
 */
function MobileMenu({
  pathname,
  firmName,
  fyLabel,
  onClose,
}: {
  pathname: string;
  firmName: string;
  fyLabel: string;
  onClose: () => void;
}) {
  // close on Esc, and stop the page behind the drawer from scrolling
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 lg:hidden">
      <div
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Main menu"
        className="absolute inset-y-0 left-0 flex w-[86vw] max-w-[340px] flex-col border-r bg-background shadow-xl"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
        }}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <Brand />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="-mr-2 flex h-10 w-10 items-center justify-center rounded-lg hover:bg-accent"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* the firm chip has no room in the header on a phone, so it lives here */}
        <Link
          href="/select-firm"
          onClick={onClose}
          className="flex shrink-0 items-center gap-2 border-b px-4 py-3 hover:bg-accent"
        >
          <Building2 className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{firmName}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            FY {fyLabel}
          </Badge>
        </Link>

        <div className="flex-1 overflow-y-auto overscroll-contain p-3">
        {NAV.map((group) =>
          group.href ? (
            <Link
              key={group.label}
              href={group.href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium",
                isGroupActive(group, pathname)
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              )}
            >
              <group.icon className="h-4 w-4" />
              {group.label}
            </Link>
          ) : (
            <details key={group.label} open={isGroupActive(group, pathname)} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-accent [&::-webkit-details-marker]:hidden">
                <group.icon className="h-4 w-4 text-primary" />
                <span className="flex-1">{group.label}</span>
                <ChevronDown className="h-4 w-4 opacity-60 transition-transform group-open:rotate-180" />
              </summary>
              <div className="mb-1 ml-5 space-y-0.5 border-l-2 border-primary/30 pl-3">
                {group.items!.map((item) =>
                  item.items ? (
                    // a submenu nests one more accordion rather than a flyout,
                    // which has nothing to hover on a touch screen
                    <details
                      key={item.label}
                      open={isItemActive(item, pathname)}
                      className="group/sub"
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
                        <span className="flex-1">{item.label}</span>
                        <ChevronDown className="h-3.5 w-3.5 opacity-60 transition-transform group-open/sub:rotate-180" />
                      </summary>
                      <div className="ml-3 space-y-0.5 border-l border-primary/20 pl-3">
                        {item.items.map((sub) => (
                          <Link
                            key={sub.href}
                            href={sub.href!}
                            onClick={onClose}
                            className={cn(
                              "block rounded-md px-3 py-2 text-sm",
                              pathname === sub.href
                                ? "bg-primary/15 font-medium text-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground"
                            )}
                          >
                            {sub.label}
                          </Link>
                        ))}
                      </div>
                    </details>
                  ) : (
                    <Link
                      key={item.href! + item.label}
                      href={item.href!}
                      onClick={onClose}
                      className={cn(
                        "block rounded-md px-3 py-2 text-sm",
                        pathname === item.href
                          ? "bg-primary/15 font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      {item.label}
                    </Link>
                  )
                )}
              </div>
            </details>
          )
        )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function Brand() {
  return (
    <Link
      href="/dashboard"
      className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="TransportTMS — go to dashboard"
    >
      <Logo markClassName="h-9 w-9" />
    </Link>
  );
}

const SEARCH_TARGETS = [
  { value: "LR", label: "LR", href: "/lr/register" },
  { value: "CHALAN", label: "Chalan", href: "/chalan/register" },
  { value: "BILL", label: "Bill", href: "/billing/register" },
  { value: "SLIP", label: "Broker Slip", href: "/broker/register" },
];

export function TopNav({ firmName, fyLabel, userName, role }: TopNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [searchType, setSearchType] = React.useState("LR");
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <header className="no-print sticky top-0 z-40 border-b border-border/60 bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75">
      {/* ONE row: brand, nav pill, search, user. The old layout stacked a
          full-width menu bar under the header, which cost 48px of vertical
          space on every screen and made the chrome heavier than the content. */}
      <div
        className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-3 sm:px-4"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          height: "calc(4rem + env(safe-area-inset-top))",
        }}
      >
        <button
          type="button"
          className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-accent lg:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          aria-expanded={mobileOpen}
        >
          <Menu className="h-5 w-5" />
        </button>

        <Brand />

        <Link
          href="/select-firm"
          className="ml-2 hidden min-w-0 items-center gap-2 rounded-full border bg-background px-3 py-1.5 hover:border-primary/50 hover:bg-accent sm:flex"
          title="Switch firm / financial year"
        >
          <Building2 className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="max-w-[180px] truncate text-xs font-semibold">{firmName}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            FY {fyLabel}
          </Badge>
        </Link>

        {/* universal search: each document type searches its own register */}
        <form
          className="ml-auto hidden w-full max-w-md items-center gap-1 md:flex"
          onSubmit={(e) => {
            e.preventDefault();
            if (!q.trim()) return;
            const target = SEARCH_TARGETS.find((t) => t.value === searchType) ?? SEARCH_TARGETS[0];
            router.push(`${target.href}?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <select
            value={searchType}
            onChange={(e) => setSearchType(e.target.value)}
            className="h-9 shrink-0 rounded-full border border-muted bg-background px-2 text-xs focus:outline-none"
            aria-label="Search document type"
          >
            {SEARCH_TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="relative w-full">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${(SEARCH_TARGETS.find((t) => t.value === searchType) ?? SEARCH_TARGETS[0]).label} number...`}
              className="h-9 rounded-full border-muted bg-background pl-9"
            />
          </div>
        </form>

        {/* the search form carries ml-auto, but it is hidden below md - without
            this the controls bunch up against the brand on a phone */}
        <div className="ml-auto shrink-0 md:ml-0">
          <ThemeToggle />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 rounded-full pl-1.5"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-foreground">
                {userName
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((w) => w[0])
                  .join("")
                  .toUpperCase()}
              </span>
              <span className="hidden max-w-[100px] truncate text-xs sm:inline">{userName}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>
              <div className="text-sm font-medium">{userName}</div>
              <div className="text-xs font-normal text-muted-foreground">{role}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/select-firm">
                <Building2 className="h-4 w-4" />
                Switch Firm / FY
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <form action="/logout" method="POST" className="w-full">
                <button type="submit" className="flex w-full items-center gap-2">
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </form>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="hidden">
          <User className="h-4 w-4" />
        </span>
      </div>

      {/* Row 2 — module menu bar (desktop) */}
      <div className="hidden border-t lg:block">
        <DesktopMenu pathname={pathname} />
      </div>

      {mobileOpen && (
        <MobileMenu
          pathname={pathname}
          firmName={firmName}
          fyLabel={fyLabel}
          onClose={() => setMobileOpen(false)}
        />
      )}
    </header>
  );
}
