export interface ValidationIssue {
  /** Dotted/bracketed path into the validated object, e.g. `Items[2].Amount`. */
  readonly path: string;
  /** Stable machine-readable code, e.g. `AMOUNT_MISMATCH`. */
  readonly code: string;
  readonly message: string;
}

export class TbankDolyameError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A request failed local validation; nothing was sent over the network. */
export class ValidationError extends TbankDolyameError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[], subject = "Request") {
    super(`${subject} validation failed: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.issues = issues;
  }
}

export type TransportErrorKind = "timeout" | "aborted" | "tls" | "network";

/**
 * The HTTP exchange itself failed (timeout, DNS, TLS verification, reset).
 *
 * `outcomeUnknown` is true when the request may have reached the server.
 * For non-idempotent calls (T-Bank Init/Confirm, Dolyame create/commit/...)
 * do not blindly repeat: reconcile first with GetState / info.
 */
export class TransportError extends TbankDolyameError {
  readonly kind: TransportErrorKind;
  readonly outcomeUnknown: boolean;
  /** Node error code when available, e.g. `SELF_SIGNED_CERT_IN_CHAIN`, `ECONNRESET`. */
  readonly code: string | undefined;

  constructor(
    message: string,
    details: { kind: TransportErrorKind; outcomeUnknown: boolean; code?: string | undefined; cause?: unknown },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = details.kind;
    this.outcomeUnknown = details.outcomeUnknown;
    this.code = details.code;
  }
}

/** The server answered, but not in a shape this library understands (HTML error page, empty body, ...). */
export class ProtocolError extends TbankDolyameError {
  readonly httpStatus: number;
  readonly bodySnippet: string;

  constructor(message: string, details: { httpStatus: number; body: string }) {
    super(message);
    this.httpStatus = details.httpStatus;
    this.bodySnippet = details.body.slice(0, 300);
  }
}

export interface TbankErrorFields {
  readonly errorCode: string;
  readonly message: string;
  readonly details?: string | undefined;
  readonly httpStatus: number;
  /** The decoded response body, untouched. */
  readonly response: unknown;
}

/**
 * Business-level failure reported by T-Bank: `Success=false` (usually with HTTP 200)
 * or an HTTP 5xx error body. Carries `ErrorCode`, `Message` and `Details` from the response.
 */
export class TbankError extends TbankDolyameError {
  /** `ErrorCode` from the response. `"0"` means no error. */
  readonly errorCode: string;
  /** `Message` from the response (the human-readable part). */
  readonly bankMessage: string;
  readonly details: string | undefined;
  readonly httpStatus: number;
  readonly response: unknown;

  constructor(fields: TbankErrorFields) {
    super(
      `T-Bank error ${fields.errorCode}: ${fields.message}${fields.details ? ` (${fields.details})` : ""}`,
    );
    this.errorCode = fields.errorCode;
    this.bankMessage = fields.message;
    this.details = fields.details;
    this.httpStatus = fields.httpStatus;
    this.response = fields.response;
  }
}

export interface DolyameErrorFields {
  readonly httpStatus: number;
  /** `code` from the error body, e.g. `UNPROCESSABLE_ENTITY`, `CONFLICT`. */
  readonly code: string;
  readonly message: string;
  readonly errorDetailCode?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly details?: Record<string, string> | undefined;
  readonly operationDetails?: readonly string[] | undefined;
  /** Parsed `Retry-After` (seconds) of an HTTP 429 response. */
  readonly retryAfterSeconds?: number | undefined;
  readonly response: unknown;
}

/** Non-2xx answer from the Dolyame partner API with a JSON error body. */
export class DolyameError extends TbankDolyameError {
  readonly httpStatus: number;
  readonly code: string;
  readonly bankMessage: string;
  readonly errorDetailCode: string | undefined;
  readonly correlationId: string | undefined;
  readonly details: Record<string, string> | undefined;
  readonly operationDetails: readonly string[] | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly response: unknown;

  constructor(fields: DolyameErrorFields) {
    super(
      `Dolyame error HTTP ${fields.httpStatus} ${fields.code}${
        fields.errorDetailCode ? `/${fields.errorDetailCode}` : ""
      }: ${fields.message}`,
    );
    this.httpStatus = fields.httpStatus;
    this.code = fields.code;
    this.bankMessage = fields.message;
    this.errorDetailCode = fields.errorDetailCode;
    this.correlationId = fields.correlationId;
    this.details = fields.details;
    this.operationDetails = fields.operationDetails;
    this.retryAfterSeconds = fields.retryAfterSeconds;
    this.response = fields.response;
  }
}

export type NotificationErrorReason = "invalid_json" | "not_an_object" | "missing_token" | "invalid_token";

/** A T-Bank notification could not be parsed or failed token verification. Do not trust its content. */
export class NotificationError extends TbankDolyameError {
  readonly reason: NotificationErrorReason;

  constructor(reason: NotificationErrorReason) {
    super(`T-Bank notification rejected: ${reason}`);
    this.reason = reason;
  }
}

export type WebhookErrorReason = "invalid_json" | "not_an_object" | "invalid_shape" | "unknown_status";

/** A Dolyame webhook body could not be parsed into a known shape. */
export class WebhookError extends TbankDolyameError {
  readonly reason: WebhookErrorReason;
  readonly payload: unknown;

  constructor(reason: WebhookErrorReason, detail: string, payload?: unknown) {
    super(`Dolyame webhook rejected (${reason}): ${detail}`);
    this.reason = reason;
    this.payload = payload;
  }
}
