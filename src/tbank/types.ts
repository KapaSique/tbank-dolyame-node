import type { Receipt } from "./receipt-types.js";

/**
 * Payment statuses from the "Справочник статусов" page and the OpenAPI response enums.
 * Responses may contain statuses added later, hence `string & {}` in the payload types.
 */
export const TBANK_PAYMENT_STATUSES = [
  "NEW",
  "FORM_SHOWED",
  "PREAUTHORIZING",
  "AUTHORIZING",
  "3DS_CHECKING",
  "3DS_CHECKED",
  "AUTHORIZED",
  "AUTH_FAIL",
  "PAY_CHECKING",
  "CONFIRM_CHECKING",
  "CONFIRMING",
  "CONFIRMED",
  "REVERSING",
  "PARTIAL_REVERSED",
  "REVERSED",
  "REFUNDING",
  "ASYNC_REFUNDING",
  "PARTIAL_REFUNDED",
  "REFUNDED",
  "CANCELED",
  "DEADLINE_EXPIRED",
  "ATTEMPTS_EXPIRED",
  "REJECTED",
] as const;

export type TbankPaymentStatus = (typeof TBANK_PAYMENT_STATUSES)[number] | (string & {});

/** `O` one-stage (charge immediately), `T` two-stage (hold, then Confirm). */
export type PayType = "O" | "T";

export interface InitRequest {
  /** Kopecks. Must equal the sum of `Receipt.Items[].Amount`. */
  Amount: number;
  /** Unique per operation, <= 50 chars. */
  OrderId: string;
  /** <= 140 chars, shown on the payment form. */
  Description?: string;
  /** <= 255 chars. Needed to save cards / recurrent payments. */
  CustomerKey?: string;
  Recurrent?: "Y";
  /** Overrides the terminal setting. */
  PayType?: PayType;
  Language?: "ru" | "en";
  /** Per-payment webhook URL; overrides the terminal setting. */
  NotificationURL?: string;
  SuccessURL?: string;
  FailURL?: string;
  /** ISO 8601 with offset, `YYYY-MM-DDTHH24:MI:SS+03:00`; between 1 minute and 90 days ahead. */
  RedirectDueDate?: string;
  /** Free-form string pairs: <= 20 pairs, key <= 20 chars, value <= 100 chars. */
  DATA?: Record<string, string>;
  Receipt?: Receipt;
}

export interface TbankResponseBase {
  TerminalKey: string;
  /** `"0"` on success. */
  ErrorCode: string;
  Message?: string;
  Details?: string;
}

export interface InitResponse extends TbankResponseBase {
  Success: true;
  Amount: number;
  OrderId: string;
  Status: TbankPaymentStatus;
  /** Normalised to a string (notifications deliver it as a number). */
  PaymentId: string;
  /** Redirect the buyer here. Treat the host as data: it is not guaranteed to be constant. */
  PaymentURL?: string;
}

export interface GetStateRequest {
  PaymentId: string | number;
  IP?: string;
}

export interface TbankParam {
  Key: string;
  Value: string;
}

export interface GetStateResponse extends TbankResponseBase {
  Success: true;
  Amount: number;
  OrderId: string;
  Status: TbankPaymentStatus;
  PaymentId: string;
  RebillId?: string;
  Params?: TbankParam[];
}

export interface ConfirmRequest {
  PaymentId: string | number;
  /** Kopecks, <= the authorised amount. Defaults to the Init amount. */
  Amount?: number;
  IP?: string;
  Receipt?: Receipt;
}

export interface ConfirmResponse extends TbankResponseBase {
  Success: true;
  OrderId: string;
  Status: TbankPaymentStatus;
  PaymentId: string;
  Params?: TbankParam[];
}

export interface CancelRequest {
  PaymentId: string | number;
  /** Kopecks for a partial cancel/refund. Omit for a full one. */
  Amount?: number;
  IP?: string;
  /** Required for a partial cancel when an online cash register is connected. */
  Receipt?: Receipt;
  /**
   * Idempotency key (<= 255 chars). With it, repeating the same cancel returns the current
   * operation state instead of cancelling twice, so the client may retry the call.
   */
  ExternalRequestId?: string;
  /** SBP refunds: bank code in the SBP classifier. */
  QrMemberId?: string;
}

export interface CancelResponse extends TbankResponseBase {
  Success: true;
  OrderId: string;
  Status: TbankPaymentStatus;
  PaymentId: string;
  OriginalAmount: number;
  NewAmount: number;
  ExternalRequestId?: string;
}

export interface CheckOrderPayment {
  PaymentId: string;
  Status: TbankPaymentStatus;
  /** Documented as a string (`"true"`/`"false"`) in this method. */
  Success: string;
  /** Kopecks. */
  Amount?: number;
  RRN?: string;
  ErrorCode?: string;
  Message?: string;
}

export interface CheckOrderResponse extends TbankResponseBase {
  Success: true;
  OrderId: string;
  Payments: CheckOrderPayment[];
}

export type TbankStatusKind =
  | "pending"
  | "authorized"
  | "paid"
  | "refunded"
  | "canceled"
  | "failed"
  | "unknown";

/**
 * Coarse meaning of a status, derived from the status descriptions in the documentation.
 *
 *   authorized  money is held, not yet debited (two-stage: call Confirm or Cancel)
 *   paid        `CONFIRMED`: money debited. The only status after which goods should ship
 *   unknown     `PAY_CHECKING` / `CONFIRM_CHECKING` (the bank lost track after a timeout): poll GetState
 */
export function tbankStatusKind(status: string): TbankStatusKind {
  switch (status) {
    case "NEW":
    case "FORM_SHOWED":
    case "PREAUTHORIZING":
    case "AUTHORIZING":
    case "3DS_CHECKING":
    case "3DS_CHECKED":
    case "CONFIRMING":
      return "pending";
    case "AUTHORIZED":
      return "authorized";
    case "CONFIRMED":
      return "paid";
    case "PARTIAL_REFUNDED":
    case "REFUNDING":
    case "ASYNC_REFUNDING":
    case "REFUNDED":
      return "refunded";
    case "CANCELED":
    case "REVERSING":
    case "PARTIAL_REVERSED":
    case "REVERSED":
      return "canceled";
    case "REJECTED":
    case "AUTH_FAIL":
    case "DEADLINE_EXPIRED":
    case "ATTEMPTS_EXPIRED":
      return "failed";
    default:
      return "unknown";
  }
}
