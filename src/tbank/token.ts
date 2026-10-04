import { createHash, timingSafeEqual } from "node:crypto";

/**
 * T-Bank request/notification signature.
 *
 * Per the documentation: take the root-level parameters (nested objects and arrays such as
 * `Receipt`, `DATA`/`Data`, `Shops` do not take part), add `Password`, sort by key, concatenate
 * the values, SHA-256 (UTF-8) -> lowercase hex. `Token` itself is never part of the input,
 * `null`/`undefined` values are skipped, booleans become "true"/"false".
 *
 * Keys are sorted by UTF-16 code units (like `Array.prototype.sort()`), not with `localeCompare`.
 * The docs say "alphabetically"; the two orders only differ when keys have different letter case at
 * their first differing position (e.g. "PayType" vs "PaymentId"), which the documented examples
 * do not contain. Not verified against a live terminal for such keys.
 */
export function signToken(params: Readonly<Record<string, unknown>>, password: string): string {
  const input = tokenInput({ ...params, Password: password });
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** The exact string that gets hashed. Exposed for debugging "inittokenisvalid=false" problems. */
export function tokenInput(params: Readonly<Record<string, unknown>>): string {
  return Object.entries(params)
    .filter(([key, value]) => key !== "Token" && isTokenValue(value))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => String(value))
    .join("");
}

function isTokenValue(value: unknown): boolean {
  return value !== null && value !== undefined && typeof value !== "object" && typeof value !== "function" && typeof value !== "symbol";
}

/** Constant-time check of the `Token` field of a signed object (request echo, notification, ...). */
export function verifyToken(signed: Readonly<Record<string, unknown>>, password: string): boolean {
  const provided = signed["Token"];
  if (typeof provided !== "string" || provided.length === 0) return false;
  return safeEqualText(signToken(signed, password), provided.toLowerCase());
}

/** Compares digests, so neither content nor length of the secret value leaks through timing. */
export function safeEqualText(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}
