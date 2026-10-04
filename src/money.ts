/**
 * Money helpers. T-Bank works in integer kopecks; Dolyame works in rubles as JSON numbers.
 * Never multiply rubles by 100 with plain floats: 19.99 * 100 === 1998.9999999999998.
 */

const RUBLES = /^(\d+)(?:\.(\d{1,2}))?$/;

/** Exact ruble -> kopeck conversion. Accepts a decimal string or a number with at most 2 decimals. */
export function toKopecks(rubles: number | string): number {
  // String(number) is the shortest round-trip form; exponent forms ("1e21") and 3+ decimals fail the regex.
  const match = RUBLES.exec(typeof rubles === "number" ? String(rubles) : rubles.trim());
  if (!match) {
    throw new RangeError(`Not a valid non-negative amount with at most 2 decimals: ${String(rubles)}`);
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const kopecks = whole * 100 + fraction;
  if (!Number.isSafeInteger(kopecks)) {
    throw new RangeError(`Amount is too large: ${String(rubles)}`);
  }
  return kopecks;
}

export function fromKopecks(kopecks: number): number {
  if (!Number.isInteger(kopecks) || kopecks < 0) {
    throw new RangeError(`Kopecks must be a non-negative integer: ${kopecks}`);
  }
  return Number((kopecks / 100).toFixed(2));
}

/**
 * quantity * price in kopecks, rounded half up, computed with integers so that
 * fractional quantities (weights) do not pick up float noise.
 * `quantity` may have up to 6 decimals (the documented receipt limit).
 */
export function lineAmount(priceKopecks: number, quantity: number): number {
  if (!Number.isSafeInteger(priceKopecks) || priceKopecks < 0) {
    throw new RangeError(`Price must be a non-negative integer number of kopecks: ${priceKopecks}`);
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new RangeError(`Quantity must be a non-negative finite number: ${quantity}`);
  }
  const scaled = Math.round(quantity * 1_000_000);
  if (Math.abs(scaled - quantity * 1_000_000) > 1e-3) {
    throw new RangeError(`Quantity has more than 6 decimals: ${quantity}`);
  }
  const product = BigInt(priceKopecks) * BigInt(scaled);
  return Number((product + 500_000n) / 1_000_000n);
}
