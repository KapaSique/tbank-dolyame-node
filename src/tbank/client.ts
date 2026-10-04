import type { Agent } from "node:https";
import { ProtocolError, TbankError, ValidationError, type ValidationIssue } from "../errors.js";
import { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_MS, send, type RetryPolicy } from "../http/send.js";
import { createNodeTransport, type HttpResponse, type Transport } from "../http/transport.js";
import type { Result } from "../result.js";
import type { FfdMode } from "./receipt-types.js";
import { collectReceiptIssues } from "./receipt-validate.js";
import { signToken } from "./token.js";
import type {
  CancelRequest,
  CancelResponse,
  CheckOrderResponse,
  ConfirmRequest,
  ConfirmResponse,
  GetStateRequest,
  GetStateResponse,
  InitRequest,
  InitResponse,
} from "./types.js";

/** Production host listed in the official documentation. */
export const TBANK_PRODUCTION_URL = "https://securepay.tinkoff.ru";
/** Test host listed in the official documentation (requires an allow-listed IP). */
export const TBANK_TEST_URL = "https://rest-api-test.tinkoff.ru";

export type TbankResult<T> = Result<T, TbankError>;

export interface TbankClientOptions {
  /** `TerminalKey` from the cabinet. */
  terminalKey: string;
  /** Terminal password; used only to sign requests, never sent. */
  password: string;
  /** Default {@link TBANK_PRODUCTION_URL}. A trailing `/v2` is accepted. */
  baseUrl?: string;
  /** Replaces the HTTP layer entirely (tests, proxies, logging). */
  transport?: Transport;
  /** Agent for the default transport, e.g. `createRussianTrustAgent()`. Ignored if `transport` is set. */
  agent?: Agent;
  /** Per-attempt timeout. Default 15 000 ms. */
  timeoutMs?: number;
  /** Retry policy for idempotent calls only (GetState, CheckOrder, Cancel with ExternalRequestId). */
  retry?: Partial<RetryPolicy>;
  /** Check requests locally before sending. Default true. */
  validate?: boolean;
  /** FFD version used for receipt validation. Default `"auto"`. */
  ffd?: FfdMode;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Overrides the client timeout for this call. */
  timeoutMs?: number;
}

export interface CheckOrderRequest {
  OrderId: string;
}

export class TbankClient {
  private readonly terminalKey: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly validate: boolean;
  private readonly ffd: FfdMode;

  constructor(options: TbankClientOptions) {
    if (!options.terminalKey) throw new TypeError("terminalKey is required");
    if (!options.password) throw new TypeError("password is required");
    this.terminalKey = options.terminalKey;
    this.password = options.password;
    this.baseUrl = normaliseBaseUrl(options.baseUrl ?? TBANK_PRODUCTION_URL);
    this.transport = options.transport ?? createNodeTransport(options.agent ? { agent: options.agent } : {});
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.validate = options.validate ?? true;
    this.ffd = options.ffd ?? "auto";
  }

  /**
   * Creates a payment. Not retried automatically: a repeated Init with the same OrderId is rejected,
   * and a different one would create a second payment. On a `TransportError` with `outcomeUnknown`
   * reconcile with {@link checkOrder} before doing anything else.
   */
  async init(request: InitRequest, options?: CallOptions): Promise<TbankResult<InitResponse>> {
    if (this.validate) throwIfInvalid(collectInitIssues(request, this.ffd), "Init request");
    return this.call<InitResponse>("Init", request, false, options);
  }

  /** Reads the current state of one payment. Safe to repeat, so it is retried on network errors and 5xx. */
  async getState(request: GetStateRequest, options?: CallOptions): Promise<TbankResult<GetStateResponse>> {
    return this.call<GetStateResponse>("GetState", { ...request, PaymentId: String(request.PaymentId) }, true, options);
  }

  /** Lists the payments of an order. Useful to recover a payment whose Init response was lost. */
  async checkOrder(request: CheckOrderRequest, options?: CallOptions): Promise<TbankResult<CheckOrderResponse>> {
    return this.call<CheckOrderResponse>("CheckOrder", request, true, options);
  }

  /** Two-stage flow: debit an `AUTHORIZED` payment. Not retried automatically. */
  async confirm(request: ConfirmRequest, options?: CallOptions): Promise<TbankResult<ConfirmResponse>> {
    if (this.validate) throwIfInvalid(collectFollowUpIssues(request, this.ffd), "Confirm request");
    return this.call<ConfirmResponse>("Confirm", { ...request, PaymentId: String(request.PaymentId) }, false, options);
  }

  /**
   * Releases a hold (`AUTHORIZED`), cancels an unpaid payment (`NEW`) or refunds a debited one
   * (`CONFIRMED`), fully or partially. Retried automatically only when `ExternalRequestId` is set.
   */
  async cancel(request: CancelRequest, options?: CallOptions): Promise<TbankResult<CancelResponse>> {
    if (this.validate) throwIfInvalid(collectFollowUpIssues(request, this.ffd), "Cancel request");
    const idempotent = typeof request.ExternalRequestId === "string" && request.ExternalRequestId !== "";
    return this.call<CancelResponse>("Cancel", { ...request, PaymentId: String(request.PaymentId) }, idempotent, options);
  }

  private async call<T>(
    method: string,
    payload: object,
    idempotent: boolean,
    options: CallOptions = {},
  ): Promise<TbankResult<T>> {
    const params = compact({ ...payload, TerminalKey: this.terminalKey });
    const body = JSON.stringify({ ...params, Token: signToken(params, this.password) });

    const response = await send(
      this.transport,
      {
        method: "POST",
        url: `${this.baseUrl}/v2/${method}`,
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
      },
      { timeoutMs: options.timeoutMs ?? this.timeoutMs, idempotent, retry: this.retry, signal: options.signal },
    );
    return interpretResponse<T>(response, method);
  }
}

/**
 * Decides what an answer means. T-Bank reports business failures as HTTP 200 + `Success: false`,
 * so the HTTP status alone says nothing about the operation.
 */
export function interpretResponse<T>(response: HttpResponse, method = "request"): TbankResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    throw new ProtocolError(`T-Bank ${method} returned a non-JSON body (HTTP ${response.status})`, {
      httpStatus: response.status,
      body: response.body,
    });
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ProtocolError(`T-Bank ${method} returned JSON that is not an object (HTTP ${response.status})`, {
      httpStatus: response.status,
      body: response.body,
    });
  }
  const body = json as Record<string, unknown>;
  const errorCode = body["ErrorCode"] === undefined ? undefined : String(body["ErrorCode"]);
  const httpOk = response.status >= 200 && response.status < 300;
  const success = body["Success"] === true || (typeof body["Success"] === "string" && body["Success"].toLowerCase() === "true");

  if (httpOk && success && (errorCode === undefined || errorCode === "0")) {
    if (typeof body["PaymentId"] === "number") body["PaymentId"] = String(body["PaymentId"]);
    return { ok: true, data: body as T, httpStatus: response.status };
  }

  const looksLikeBankError = "Success" in body || "ErrorCode" in body || "Message" in body;
  if (!looksLikeBankError) {
    throw new ProtocolError(`T-Bank ${method} returned an unexpected body (HTTP ${response.status})`, {
      httpStatus: response.status,
      body: response.body,
    });
  }
  const causes = Array.isArray(body["Causes"]) ? (body["Causes"] as unknown[]).map(String).join("; ") : undefined;
  const details = typeof body["Details"] === "string" && body["Details"] !== "" ? body["Details"] : causes;
  return {
    ok: false,
    error: new TbankError({
      errorCode: errorCode ?? String(response.status),
      message: typeof body["Message"] === "string" && body["Message"] !== "" ? body["Message"] : "No message",
      details,
      httpStatus: response.status,
      response: body,
    }),
  };
}

function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v2$/i, "");
}

function compact(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}

function throwIfInvalid(issues: ValidationIssue[], subject: string): void {
  if (issues.length > 0) throw new ValidationError(issues, subject);
}

const REDIRECT_DUE_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

function collectInitIssues(request: InitRequest, ffd: FfdMode): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };

  if (!Number.isSafeInteger(request.Amount) || request.Amount < 1) {
    add("Amount", "OUT_OF_RANGE", "must be a positive integer number of kopecks");
  }
  if (typeof request.OrderId !== "string" || request.OrderId.length < 1 || request.OrderId.length > 50) {
    add("OrderId", "OUT_OF_RANGE", "must be a string of 1..50 characters");
  }
  if (request.Description !== undefined && request.Description.length > 140) {
    add("Description", "TOO_LONG", "must be at most 140 characters");
  }
  if (request.CustomerKey !== undefined && request.CustomerKey.length > 255) {
    add("CustomerKey", "TOO_LONG", "must be at most 255 characters");
  }
  if (request.PayType !== undefined && request.PayType !== "O" && request.PayType !== "T") {
    add("PayType", "INVALID_ENUM", 'must be "O" (one-stage) or "T" (two-stage)');
  }
  if (request.Language !== undefined && request.Language !== "ru" && request.Language !== "en") {
    add("Language", "INVALID_ENUM", 'must be "ru" or "en"');
  }
  if (request.Recurrent !== undefined && request.Recurrent !== "Y") {
    add("Recurrent", "INVALID_ENUM", 'must be "Y" when present');
  }
  for (const key of ["NotificationURL", "SuccessURL", "FailURL"] as const) {
    const value = request[key];
    if (value !== undefined && !isHttpUrl(value)) add(key, "INVALID_FORMAT", "must be an absolute http(s) URL");
  }
  if (request.RedirectDueDate !== undefined && !REDIRECT_DUE_DATE.test(request.RedirectDueDate)) {
    add("RedirectDueDate", "INVALID_FORMAT", "must look like 2026-10-04T12:28:00+03:00");
  }
  if (request.DATA !== undefined) {
    const entries = Object.entries(request.DATA);
    if (entries.length > 20) add("DATA", "TOO_MANY_ITEMS", "allows at most 20 key/value pairs");
    for (const [key, value] of entries) {
      if (key.length > 20) add(`DATA.${key}`, "TOO_LONG", "key must be at most 20 characters");
      if (typeof value !== "string" || value.length > 100) {
        add(`DATA.${key}`, "TOO_LONG", "value must be a string of at most 100 characters");
      }
    }
  }
  if (request.Receipt !== undefined) {
    issues.push(...collectReceiptIssues(request.Receipt, { ffd, expectedAmount: request.Amount }));
  }
  return issues;
}

function collectFollowUpIssues(request: ConfirmRequest | CancelRequest, ffd: FfdMode): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (request.PaymentId === undefined || request.PaymentId === "") {
    issues.push({ path: "PaymentId", code: "REQUIRED", message: "is required" });
  }
  if (request.Amount !== undefined && (!Number.isSafeInteger(request.Amount) || request.Amount < 1)) {
    issues.push({ path: "Amount", code: "OUT_OF_RANGE", message: "must be a positive integer number of kopecks" });
  }
  if (request.Receipt !== undefined) {
    issues.push(
      ...collectReceiptIssues(request.Receipt, {
        ffd,
        ...(request.Amount === undefined ? {} : { expectedAmount: request.Amount }),
      }),
    );
  }
  return issues;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
