// Yahoo writes US share classes with a dash (BRK-B). Two-letter suffixes (.NS, .TO, .DE, ...)
// and the one-letter ones below name an exchange, so they must keep their dot.
const ONE_LETTER_EXCHANGE_SUFFIXES = new Set(['L', 'T', 'F', 'V']);

export function toYahooShareClassSymbol(symbol: string) {
    const match = /^([A-Z]{1,10})\.([A-Z])$/.exec(symbol);
    return match && !ONE_LETTER_EXCHANGE_SUFFIXES.has(match[2]) ? `${match[1]}-${match[2]}` : symbol;
}

export function fromYahooShareClassSymbol(symbol: string) {
    const match = /^([A-Z]{1,10})-([A-Z])$/.exec(symbol);
    return match && !ONE_LETTER_EXCHANGE_SUFFIXES.has(match[2]) ? `${match[1]}.${match[2]}` : symbol;
}
