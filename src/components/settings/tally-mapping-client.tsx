"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { saveTallyMapping } from "@/app/(app)/settings/tally/actions";

export interface MapSection {
  title: string;
  desc?: string;
  rows: {
    module: string;
    sourceKey: string;
    label: string;
    hint?: string;
    fallback: string;
  }[];
}

export function TallyMappingClient({
  sections,
  existing,
}: {
  sections: MapSection[];
  existing: { module: string; sourceKey: string; tallyName: string }[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(existing.map((r) => [`${r.module}:${r.sourceKey}`, r.tallyName]))
  );

  const save = async () => {
    setSaving(true);
    try {
      const rows = sections.flatMap((s) =>
        s.rows.map((r) => ({
          module: r.module,
          sourceKey: r.sourceKey,
          tallyName: values[`${r.module}:${r.sourceKey}`] ?? "",
        }))
      );
      const res = await saveTallyMapping(rows);
      if (res.ok) {
        toast({ title: "Tally mapping saved" });
        router.refresh();
      } else {
        toast({ variant: "destructive", title: res.error });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {sections.map((s) => (
        <Card key={s.title}>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm">{s.title}</CardTitle>
            {s.desc && <p className="text-xs text-muted-foreground">{s.desc}</p>}
          </CardHeader>
          <CardContent className="space-y-1.5 p-4 pt-2">
            {s.rows.length === 0 && (
              <p className="text-sm text-muted-foreground">No rows.</p>
            )}
            {s.rows.map((r) => {
              const k = `${r.module}:${r.sourceKey}`;
              return (
                <div
                  key={k}
                  className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_20px_1.2fr]"
                >
                  <div className="text-sm">
                    {r.label}
                    {r.hint && (
                      <span className="ml-2 text-xs text-muted-foreground">({r.hint})</span>
                    )}
                  </div>
                  <div className="hidden text-center text-muted-foreground sm:block">→</div>
                  <Input
                    className="h-9"
                    value={values[k] ?? ""}
                    placeholder={r.fallback}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [k]: e.target.value.toUpperCase() }))
                    }
                  />
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Saving..." : "Save Mapping"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Blank = the placeholder name goes across (created automatically in Tally)
        </span>
      </div>
    </div>
  );
}
