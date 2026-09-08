// Minimal RFC-4180 CSV serialization (client-side export of the filtered
// usage rows; charter §9 page 5 导出 CSV — client-side, ≤500-row cap is the
// ledger query limit and surfaced in the UI).
export interface CsvColumn<T> {
  header: string
  value: (row: T) => string | number | null | undefined
}

/** A leading formula character would be executed by Excel/LibreOffice/Sheets
 *  when the export is opened (=HYPERLINK exfiltration via error text, @import,
 *  +cmd). Neutralized with a text prefix per the OWASP mitigation. Numbers
 *  skip the guard — a legitimate negative value must stay numeric. */
const FORMULA_PREFIX = /^[=+@\t\r-]/

function escapeField(value: string | number): string {
  if (typeof value === 'number') return String(value)
  let out = value
  if (FORMULA_PREFIX.test(out)) out = "'" + out
  if (/[",\r\n]/.test(out)) out = '"' + out.replaceAll('"', '""') + '"'
  return out
}

/** Serialize rows to CSV (CRLF per RFC 4180). Always emits the header row. */
export function toCsv<T>(rows: readonly T[], columns: ReadonlyArray<CsvColumn<T>>): string {
  const lines: string[] = [columns.map((c) => escapeField(c.header)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(c.value(row) ?? '')).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

/** Trigger a client-side download of a CSV blob (file-saver-free). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }) // BOM for Excel
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}