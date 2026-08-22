export function shellQuote(value) {
    if (value === '')
        return "''";
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}
//# sourceMappingURL=shell.js.map