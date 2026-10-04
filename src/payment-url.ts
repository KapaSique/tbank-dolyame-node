import { ValidationError } from "./errors.js";

/**
 * Guard for redirecting a buyer to a `PaymentURL` / `link` returned by a payment provider.
 *
 * The payment page host is data returned by the provider, not a constant of the API: it can differ
 * from the API host and providers may serve it from more than one domain over time. If your
 * application keeps an allow-list (for open-redirect protection, CSP `form-action`, an outbound
 * firewall or a front-end `safeRedirect()`), keep it in configuration and cover every domain the
 * provider documents; a hard-coded single host silently turns a working payment into "no link".
 *
 * Patterns: `pay.example.com` (exact host) or `*.example.com` (any subdomain, not the apex).
 */
export function isAllowedPaymentUrl(url: string, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.port !== "") return false;

  const host = parsed.hostname.toLowerCase();
  return allowedHosts.some((pattern) => {
    const rule = pattern.toLowerCase();
    return rule.startsWith("*.") ? host.endsWith(rule.slice(1)) : host === rule;
  });
}

/** Returns the parsed URL or throws, so a rejected redirect is loud in logs instead of silently `null`. */
export function assertAllowedPaymentUrl(url: string, allowedHosts: readonly string[]): URL {
  if (!isAllowedPaymentUrl(url, allowedHosts)) {
    let host = "(unparseable)";
    try {
      host = new URL(url).host;
    } catch {
      /* keep placeholder */
    }
    throw new ValidationError(
      [{ path: "url", code: "HOST_NOT_ALLOWED", message: `host is not in the allow-list: ${host}` }],
      "Payment URL",
    );
  }
  return new URL(url);
}
