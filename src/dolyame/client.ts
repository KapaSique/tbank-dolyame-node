import { randomUUID } from "node:crypto";
import type { Agent } from "node:https";
import { DolyameError, ProtocolError, ValidationError, type ValidationIssue } from "../errors.js";
import { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_MS, send, type RetryPolicy } from "../http/send.js";
import { createNodeTransport, type HttpResponse, type Transport } from "../http/transport.js";
import type { Result } from "../result.js";
import { createMtlsAgent, type MtlsOptions } from "../tls/agent.js";
import type {
  DolyameCommitRequest,
  DolyameCompleteDeliveryRequest,
  DolyameCreateRequest,
  DolyameOrderInfo,
  DolyameRefundRequest,
} from "./types.js";
import {
  collectCommitIssues,
  collectCompleteDeliveryIssues,
  collectCreateIssues,
  collectRefundIssues,
} from "./validate.js";

/** Host from the OpenAPI document. Demo and production differ by credentials, not by host (per the docs). */
export const DOLYAME_BASE_URL = "https://partner.dolyame.ru";

export type DolyameResult<T> = Result<T, DolyameError>;

export interface DolyameClientOptions {
  /** API login from your Dolyame manager (production and demo logins differ). */
  login: string;
  password: string;
  baseUrl?: string;
  /**
   * mTLS client certificate and key (issued in the T-Business cabinet). The Russian Trusted Root CA
   * is added to the trust store automatically because `partner.dolyame.ru` chains to it.
   */
  tls?: MtlsOptions;
  /** A ready-made agent instead of `tls`. */
  agent?: Agent;
  /** Replaces the HTTP layer (tests). When used, `tls`/`agent` are not needed. */
  transport?: Transport;
  timeoutMs?: number;
  /** Applies to `info` only; every other call is a single attempt. */
  retry?: Partial<RetryPolicy>;
  /** Check requests locally before sending. Default true. */
  validate?: boolean;
  /** UUID v4 generator for `X-Correlation-ID`. Default `crypto.randomUUID`. */
  generateCorrelationId?: () => string;
}

export interface DolyameCallOptions {
  /** Your own UUID v4; by default a fresh one is generated per call. */
  correlationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DolyameClient {
  private readonly authorization: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly validate: boolean;
  private readonly generateCorrelationId: () => string;

  constructor(options: DolyameClientOptions) {
    if (!options.login) throw new TypeError("login is required");
    if (options.login.includes(":")) throw new TypeError("login must not contain ':' (HTTP Basic auth)");
    if (!options.password) throw new TypeError("password is required");
    if (!options.transport && !options.tls && !options.agent) {
      throw new TypeError(
        "mTLS is mandatory for the Dolyame partner API: pass `tls` (cert + key) or an `agent`. " +
          "Without a client certificate the host answers with an HTML 400 page.",
      );
    }
    this.authorization = `Basic ${Buffer.from(`${options.login}:${options.password}`, "utf8").toString("base64")}`;
    this.baseUrl = (options.baseUrl ?? DOLYAME_BASE_URL).replace(/\/+$/, "");
    const agent = options.agent ?? (options.tls ? createMtlsAgent(options.tls) : undefined);
    this.transport = options.transport ?? createNodeTransport(agent ? { agent } : {});
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.validate = options.validate ?? true;
    this.generateCorrelationId = options.generateCorrelationId ?? randomUUID;
  }

  /**
   * Creates an order (application). Not retried automatically; if the outcome is unknown
   * (`TransportError.outcomeUnknown`), call {@link info} with the same order id before re-sending.
   */
  async create(request: DolyameCreateRequest, options?: DolyameCallOptions): Promise<DolyameResult<DolyameOrderInfo>> {
    if (this.validate) throwIfInvalid(collectCreateIssues(request), "Dolyame create request");
    return this.call("POST", "/v1/orders/create", request, false, options);
  }

  /** Current state of an order. Read-only, so it is retried on network errors, 429 and 5xx. */
  async info(orderId: string, options?: DolyameCallOptions): Promise<DolyameResult<DolyameOrderInfo>> {
    return this.call("GET", orderPath(orderId, "info"), undefined, true, options);
  }

  /** Confirms the order (status `wait_for_commit`), within 72 hours of create. */
  async commit(orderId: string, request: DolyameCommitRequest, options?: DolyameCallOptions): Promise<DolyameResult<DolyameOrderInfo>> {
    if (this.validate) throwIfInvalid(collectCommitIssues(request), "Dolyame commit request");
    return this.call("POST", orderPath(orderId, "commit"), request, false, options);
  }

  /** Cancels an order. The documentation allows it only in status `wait_for_commit`. */
  async cancel(orderId: string, options?: DolyameCallOptions): Promise<DolyameResult<DolyameOrderInfo>> {
    return this.call("POST", orderPath(orderId, "cancel"), undefined, false, options);
  }

  /** Returns part or all of a confirmed order. */
  async refund(orderId: string, request: DolyameRefundRequest, options?: DolyameCallOptions): Promise<DolyameResult<DolyameOrderInfo>> {
    if (this.validate) throwIfInvalid(collectRefundIssues(request), "Dolyame refund request");
    return this.call("POST", orderPath(orderId, "refund"), request, false, options);
  }

  /** Reports successful delivery. */
  async completeDelivery(
    orderId: string,
    request: DolyameCompleteDeliveryRequest = {},
    options?: DolyameCallOptions,
  ): Promise<DolyameResult<DolyameOrderInfo>> {
    if (this.validate) throwIfInvalid(collectCompleteDeliveryIssues(request), "Dolyame complete_delivery request");
    return this.call("POST", orderPath(orderId, "complete_delivery"), request, false, options);
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    payload: object | undefined,
    idempotent: boolean,
    options: DolyameCallOptions = {},
  ): Promise<DolyameResult<DolyameOrderInfo>> {
    const correlationId = options.correlationId ?? this.generateCorrelationId();
    if (!UUID_V4.test(correlationId)) {
      throw new ValidationError(
        [{ path: "X-Correlation-ID", code: "INVALID_FORMAT", message: "must be a UUID v4" }],
        "Dolyame request",
      );
    }
    const headers: Record<string, string> = {
      authorization: this.authorization,
      accept: "application/json",
      "x-correlation-id": correlationId,
    };
    if (payload !== undefined) headers["content-type"] = "application/json";

    const response = await send(
      this.transport,
      {
        method,
        url: `${this.baseUrl}${path}`,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      },
      { timeoutMs: options.timeoutMs ?? this.timeoutMs, idempotent, retry: this.retry, signal: options.signal },
    );
    return interpretDolyameResponse(response, correlationId);
  }
}

/** HTTP 2xx -> typed order info; anything else -> `DolyameError`; non-JSON -> `ProtocolError`. */
export function interpretDolyameResponse(response: HttpResponse, correlationId: string): DolyameResult<DolyameOrderInfo> {
  const parsed = parseJson(response.body);
  const httpOk = response.status >= 200 && response.status < 300;

  if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const hint =
      /ssl certificate/i.test(response.body)
        ? " The host did not accept the mTLS client certificate (missing, expired or not issued for this API)."
        : "";
    throw new ProtocolError(`Dolyame returned a non-JSON body (HTTP ${response.status}).${hint}`, {
      httpStatus: response.status,
      body: response.body,
    });
  }
  const body = parsed as Record<string, unknown>;

  if (httpOk) {
    if (typeof body["status"] !== "string") {
      throw new ProtocolError("Dolyame returned a 2xx body without `status`", {
        httpStatus: response.status,
        body: response.body,
      });
    }
    return { ok: true, data: body as unknown as DolyameOrderInfo, httpStatus: response.status, correlationId };
  }

  const retryAfter = Number(response.headers["retry-after"]);
  return {
    ok: false,
    error: new DolyameError({
      httpStatus: response.status,
      code: typeof body["code"] === "string" ? body["code"] : `HTTP_${response.status}`,
      message: typeof body["message"] === "string" ? body["message"] : "No message",
      errorDetailCode: typeof body["errorDetailCode"] === "string" ? body["errorDetailCode"] : undefined,
      correlationId: typeof body["correlationId"] === "string" ? body["correlationId"] : correlationId,
      details: isStringMap(body["details"]) ? body["details"] : undefined,
      operationDetails: Array.isArray(body["operationDetails"]) ? body["operationDetails"].map(String) : undefined,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
      response: body,
    }),
  };
}

function orderPath(orderId: string, action: string): string {
  if (typeof orderId !== "string" || orderId === "") {
    throw new ValidationError([{ path: "orderId", code: "REQUIRED", message: "must be a non-empty string" }], "Dolyame request");
  }
  return `/v1/orders/${encodeURIComponent(orderId)}/${action}`;
}

function throwIfInvalid(issues: ValidationIssue[], subject: string): void {
  if (issues.length > 0) throw new ValidationError(issues, subject);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
