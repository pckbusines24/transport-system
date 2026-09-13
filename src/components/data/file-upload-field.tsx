"use client";

import * as React from "react";
import { Eye, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";

/**
 * Reusable upload field for master dialogs: uploads to the given endpoint,
 * stores the returned path/name via `onChange`, and offers preview (opens in a
 * new tab — also the download), replace and remove.
 */
export function FileUploadField({
  label,
  endpoint,
  filePath,
  fileName,
  accept = ".pdf,.jpg,.jpeg,.png",
  maxSizeMb = 10,
  hint,
  onChange,
}: {
  label: string;
  endpoint: string; // e.g. /api/uploads/docreg
  filePath: string | null;
  fileName: string | null;
  accept?: string;
  /** client-side size guard; the endpoint enforces its own limit too */
  maxSizeMb?: number;
  /** replaces the default "PDF, JPG or PNG — max 10 MB." line */
  hint?: string;
  onChange: (filePath: string | null, fileName: string | null) => void;
}) {
  const { toast } = useToast();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  const upload = async (file: File) => {
    if (file.size > maxSizeMb * 1024 * 1024) {
      toast({
        variant: "destructive",
        title: `File too large — max ${maxSizeMb} MB`,
        description: `${file.name} is ${(file.size / 1048576).toFixed(2)} MB`,
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(endpoint, { method: "POST", body: fd });
      const json = (await res.json()) as {
        ok: boolean;
        path?: string;
        name?: string;
        error?: string;
      };
      if (json.ok && json.path) {
        onChange(json.path, json.name ?? file.name);
        toast({ title: "File uploaded", description: json.name ?? file.name });
      } else {
        toast({ variant: "destructive", title: "Upload failed", description: json.error });
      }
    } catch {
      toast({ variant: "destructive", title: "Upload failed" });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label className="text-xs">{label}</Label>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" />
          {busy ? "Uploading..." : filePath ? "Replace File" : "Upload File"}
        </Button>
        {filePath && (
          <>
            <Button type="button" variant="secondary" size="sm" asChild>
              <a href={`/api/uploads/${filePath}`} target="_blank" rel="noreferrer">
                <Eye className="h-3.5 w-3.5" />
                Preview / Download
              </a>
            </Button>
            <span className="max-w-[220px] truncate text-xs text-muted-foreground">
              {fileName ?? filePath.split("/").pop()}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              title="Remove file"
              onClick={() => onChange(null, null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{hint ?? "PDF, JPG or PNG — max 10 MB."}</p>
    </div>
  );
}
