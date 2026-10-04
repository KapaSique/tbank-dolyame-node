/**
 * Business-level outcomes are values, not exceptions.
 *
 * T-Bank answers business failures with HTTP 200 + `Success: false`, so "the HTTP call worked"
 * and "the operation worked" are different questions. Methods return a `Result`; exceptional
 * conditions (invalid input, network/TLS failure, garbage response) are thrown instead.
 */
export type Result<T, E extends Error> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly httpStatus: number;
      /** Dolyame only: the `X-Correlation-ID` sent with the request, for support tickets and logs. */
      readonly correlationId?: string;
    }
  | { readonly ok: false; readonly error: E };

/** Turn a failed `Result` back into a thrown error. */
export function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (result.ok) return result.data;
  throw result.error;
}
