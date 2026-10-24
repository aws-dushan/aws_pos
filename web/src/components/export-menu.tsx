"use client";

import { DownloadIcon, FileSpreadsheetIcon, FileTextIcon, PrinterIcon } from "lucide-react";
import { toast } from "sonner";
import { downloadCsv, downloadXlsx, printPdf, type ExportTable } from "@/lib/export";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Export a report table: Excel (.xlsx), CSV, or PDF (a print-ready page). */
export function ExportMenu({ name, table, disabled }: { name: string; table: ExportTable | null; disabled?: boolean }) {
  const off = disabled || !table?.rows.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="h-10" disabled={off}><DownloadIcon /> Export</Button>} />
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem className="h-10" onClick={() => table && void downloadXlsx(name, table).catch(() => toast.error("Couldn't make the Excel file."))}><FileSpreadsheetIcon className="size-4" /> Excel (.xlsx)</DropdownMenuItem>
        <DropdownMenuItem className="h-10" onClick={() => table && downloadCsv(name, table)}><FileTextIcon className="size-4" /> CSV</DropdownMenuItem>
        <DropdownMenuItem className="h-10" onClick={() => { if (table && !printPdf(table)) toast.error("Allow pop-ups for One POS to print or save as PDF."); }}><PrinterIcon className="size-4" /> PDF / print</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
