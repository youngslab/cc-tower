export function shellQuote(value: string): string {
  if (value === '') return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
