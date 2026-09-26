import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SystemFontData } from "@/localFonts";

export interface SystemFontPickerLabels {
  title: string;
  search: string;
  empty: string;
  loading: string;
  error: string;
  cancel: string;
}

/**
 * Modal listing locally installed fonts (Local Font Access API). Purely
 * presentational: the caller owns the query/list state and the selection.
 */
export function SystemFontPicker({
  status,
  fonts,
  error,
  labels,
  onSelect,
  onClose,
}: {
  status: "loading" | "ready" | "error";
  fonts: SystemFontData[];
  error?: string | null;
  labels: SystemFontPickerLabels;
  onSelect: (font: SystemFontData) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fonts;
    return fonts.filter((f) =>
      `${f.family} ${f.style} ${f.fullName} ${f.postscriptName}`
        .toLowerCase()
        .includes(q),
    );
  }, [fonts, query]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={labels.title}
        className="w-full max-w-lg"
      >
        <Card>
          <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-3">
            <CardTitle>{labels.title}</CardTitle>
            <Button variant="neutral" size="sm" type="button" onClick={onClose}>
              {labels.cancel}
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={labels.search}
              aria-label={labels.search}
            />
            <div className="max-h-[55vh] overflow-y-auto rounded-base border-2 border-border">
              {status === "loading" && (
                <p className="p-3 text-sm font-base opacity-70">
                  {labels.loading}
                </p>
              )}
              {status === "error" && (
                <div className="p-3 text-sm font-base">
                  <p>✗ {labels.error}</p>
                  {error && (
                    <p className="mt-1 text-xs break-all opacity-70">{error}</p>
                  )}
                </div>
              )}
              {status === "ready" && filtered.length === 0 && (
                <p className="p-3 text-sm font-base opacity-70">
                  {labels.empty}
                </p>
              )}
              {status === "ready" &&
                filtered.map((f) => (
                  <button
                    key={`${f.postscriptName}:${f.fullName}`}
                    type="button"
                    onClick={() => onSelect(f)}
                    className="flex w-full items-baseline gap-2 border-b-2 border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-main"
                  >
                    <span className="min-w-0 truncate font-heading">
                      {f.family}
                    </span>
                    <span className="shrink-0 text-xs opacity-60">
                      {f.style || f.fullName}
                    </span>
                  </button>
                ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
