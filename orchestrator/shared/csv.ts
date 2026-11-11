/**
 * One CSV cell. Names in an export come from teammates' repositories and requests, so a cell a
 * spreadsheet would run as a formula is kept as text.
 */
export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLines(header: string[], rows: (string | number | null)[][]): string {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
