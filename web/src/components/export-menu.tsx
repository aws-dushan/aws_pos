"use client";

import { DownloadIcon, FileSpreadsheetIcon, FileTextIcon, PrinterIcon } from "lucide-react";
import { toast } from "sonner";
import { downloadCsv, downloadXlsx, printPdf, type ExportTable } from "@/lib/export";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * Export a report table: Excel (.xlsx), CSV, or PDF (a print-ready page). With several tables (the Summary report), Excel has a
 * sheet each and the PDF has them one under the other, under the heading.
 */
export function ExportMenu({ name, table, tables, heading, disabled }: {
  name: string; table?: ExportTable | null; tables?: ExportTable[] | null; heading?: { title: string; subtitle?: string }; disabled?: boolean;
}) {
  const t = tables ?? table;
  const off = disabled || !t || (Array.isArray(t) ? !t.length : !t.rows.length);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="h-10" disabled={off}><DownloadIcon /> Export</Button>} />
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem className="h-10" onClick={() => t && void downloadXlsx(name, t).catch(() => toast.error("Couldn't make the Excel file."))}><FileSpreadsheetIcon className="size-4" /> Excel (.xlsx)</DropdownMenuItem>
        <DropdownMenuItem className="h-10" onClick={() => t && downloadCsv(name, t)}><FileTextIcon className="size-4" /> CSV</DropdownMenuItem>
        <DropdownMenuItem className="h-10" onClick={() => { if (t && !printPdf(t, heading)) toast.error("Allow pop-ups for One POS to print or save as PDF."); }}><PrinterIcon className="size-4" /> PDF / print</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
