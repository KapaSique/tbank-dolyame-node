import { NotificationError } from "../errors.js";
import { verifyToken } from "./token.js";
import type { TbankPaymentStatus } from "./types.js";

/** The only accepted acknowledgement: HTTP 200 with the exact body `OK` (no tags, upper case). */
export const NOTIFICATION_OK_RESPONSE = "OK";

/**
 * Payment notification delivered to `NotificationURL`.
 * Modelled on the documentation's token example and sample payloads; the index signature keeps
 * parameters the bank adds later (they take part in the signature, so they must not be dropped).
 */
export interface TbankNotification {
  TerminalKey: string;
  OrderId: string;
  Success: boolean;
  Status: TbankPaymentStatus;
  /** Delivered as a JSON number in the documented samples. */
  PaymentId: number | string;
  ErrorCode: string;
  /** Kopecks. */
  Amount?: number;
  CardId?: number | string;
  Pan?: string;
  ExpDate?: string;
  RebillId?: number | string;
  /** Echo of the `DATA` object from Init (note the capitalisation). */
  Data?: Record<string, unknown>;
  Token: string;
  [parameter: string]: unknown;
}

/**
 * True when `body` (an already parsed JSON object) carries a valid `Token` for `password`.
 * Uses a constant-time comparison. Missing, malformed or tampered tokens return false.
 *
 * Pass the object exactly as received: every root-level scalar field is part of the signature,
 * including fields this library does not know about.
 */
export function verifyNotification(body: unknown, password: string): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  return verifyToken(body as Record<string, unknown>, password);
}

/**
 * Parse (string / Buffer / object) and verify in one step.
 * @throws NotificationError with a machine-readable `reason`; answer HTTP 400 and do not touch the order.
 */
export function parseNotification(raw: string | Buffer | object, password: string): TbankNotification {
  let body: unknown = raw;
  if (typeof raw === "string" || Buffer.isBuffer(raw)) {
    try {
      body = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      throw new NotificationError("invalid_json");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new NotificationError("not_an_object");
  }
  const token = (body as Record<string, unknown>)["Token"];
  if (typeof token !== "string" || token.length === 0) throw new NotificationError("missing_token");
  if (!verifyToken(body as Record<string, unknown>, password)) throw new NotificationError("invalid_token");
  return body as TbankNotification;
}
