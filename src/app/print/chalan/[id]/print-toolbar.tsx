"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function PrintToolbar({ copies }: { copies: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // keep the other params (e.g. an unsaved balance-payment preview)
  const withCopies = (v: string) => {
    const q = new URLSearchParams(searchParams.toString());
    q.set("copies", v);
    return `${pathname}?${q.toString()}`;
  };

  return (
    <div className="no-print mx-auto mb-4 flex max-w-[190mm] items-center justify-end gap-2 print:hidden">
      <span className="text-sm text-muted-foreground">Copies</span>
      <Select
        value={String(copies)}
        onValueChange={(v) => router.replace(withCopies(v))}
      >
        <SelectTrigger className="h-8 w-16">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[1, 2, 3].map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" onClick={() => window.print()}>
        Print
      </Button>
    </div>
  );
}
