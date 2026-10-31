const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @) gets a leading
 * apostrophe; plain numbers such as "-150.00" or "+8801711000000" are left alone.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (cells: (string | number | null)[]) => `${cells.map(csvCell).join(',')}\r\n`;

/** Smallest unit → whole taka with two decimals ("1500.00"). */
export const csvMoney = (minor: number) => (minor / 100).toFixed(2);
