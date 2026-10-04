import { TransportError, type TransportErrorKind } from "../errors.js";
import type { HttpRequest, HttpResponse, Transport } from "./transport.js";

export interface RetryPolicy {
  /** Extra attempts after the first one, for idempotent calls only. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; returns a number in [0, 1). */
  random?: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface SendOptions {
  timeoutMs: number;
  /**
   * Safe to repeat? Only then are network errors, timeouts, HTTP 429 and HTTP 5xx retried.
   * Non-idempotent calls get exactly one attempt.
   */
  idempotent: boolean;
  retry: RetryPolicy;
  /** Caller-supplied cancellation; never retried after it fires. */
  signal?: AbortSignal | undefined;
}

/** Errors that mean "the Russian Trusted Root CA is probably missing from the trust store". */
const MISSING_ISSUER_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const TLS_VERIFY_CODES = new Set([
  ...MISSING_ISSUER_CODES,
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** The request cannot have reached the server when one of these happens. */
const NOT_SENT_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]);

export async function send(
  transport: Transport,
  request: Omit<HttpRequest, "signal">,
  options: SendOptions,
): Promise<HttpResponse> {
  const attempts = options.idempotent ? Math.max(0, options.retry.retries) + 1 : 1;
  let lastError: TransportError | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const isLast = attempt === attempts - 1;
    try {
      const response = await attemptOnce(transport, request, options);
      if (!isLast && isRetryableStatus(response.status)) {
        const delay = retryDelay(attempt, options.retry, response);
        if (delay === undefined) return response; // server asks to wait longer than we are willing to
        await sleep(options.retry, delay);
        continue;
      }
      return response;
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      lastError = error;
      const retryable = error.kind === "network" || error.kind === "timeout";
      if (isLast || !retryable) throw error;
      await sleep(options.retry, retryDelay(attempt, options.retry) ?? options.retry.maxDelayMs);
    }
  }
  // Unreachable: the loop either returns or throws on its last attempt.
  throw lastError ?? new TransportError("No attempt was made", { kind: "network", outcomeUnknown: false });
}

async function attemptOnce(
  transport: Transport,
  request: Omit<HttpRequest, "signal">,
  options: SendOptions,
): Promise<HttpResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    return await transport({ ...request, signal: controller.signal });
  } catch (error) {
    throw toTransportError(error, { timedOut, aborted: controller.signal.aborted, timeoutMs: options.timeoutMs });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export function toTransportError(
  error: unknown,
  context: { timedOut: boolean; aborted: boolean; timeoutMs: number },
): TransportError {
  if (error instanceof TransportError) return error;
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : undefined;
  const original = error instanceof Error ? error.message : String(error);

  if (context.timedOut) {
    return new TransportError(`Request timed out after ${context.timeoutMs} ms`, {
      kind: "timeout",
      outcomeUnknown: true,
      code,
      cause: error,
    });
  }
  if (context.aborted) {
    return new TransportError("Request was aborted by the caller", {
      kind: "aborted",
      outcomeUnknown: true,
      code,
      cause: error,
    });
  }
  if (code !== undefined && (TLS_VERIFY_CODES.has(code) || code.startsWith("ERR_SSL"))) {
    const hint = MISSING_ISSUER_CODES.has(code)
      ? " If the host chains to the Russian Trusted Root CA, pass createRussianTrustAgent() as the agent."
      : "";
    return new TransportError(`TLS failure (${code}): ${original}.${hint}`, {
      kind: "tls",
      outcomeUnknown: false,
      code,
      cause: error,
    });
  }
  const kind: TransportErrorKind = "network";
  return new TransportError(`Network error${code ? ` (${code})` : ""}: ${original}`, {
    kind,
    outcomeUnknown: code === undefined || !NOT_SENT_CODES.has(code),
    code,
    cause: error,
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Exponential backoff with jitter. Returns undefined when a `Retry-After` is longer than `maxDelayMs`. */
function retryDelay(attempt: number, policy: RetryPolicy, response?: HttpResponse): number | undefined {
  const retryAfter = response ? Number(response.headers["retry-after"]) : Number.NaN;
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    const ms = retryAfter * 1000;
    return ms > policy.maxDelayMs ? undefined : ms;
  }
  const random = policy.random ?? Math.random;
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(exponential * (0.5 + random() * 0.5));
}

function sleep(policy: RetryPolicy, ms: number): Promise<void> {
  return policy.sleep ? policy.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
}
