import { isIPv4 } from "node:net";
import { WebhookError } from "../errors.js";
import type { DolyameResult } from "./client.js";
import { canonicalDolyameStatus } from "./status.js";
import {
  DOLYAME_STATUSES,
  type DolyameClientInfo,
  type DolyameOrderInfo,
  type DolyamePaymentScheduleItem,
  type DolyameStatus,
} from "./types.js";

/** Notification body as documented on the "Webhooks" page. */
export interface DolyameWebhook {
  /** Your order id (what you passed as `order.id`). */
  id: string;
  status: DolyameStatus;
  amount: number;
  residual_amount: number;
  demo?: boolean;
  /** Personal data is masked by the sender (`t**@y*.ru`, `И.`). */
  client_info?: DolyameClientInfo;
  payment_schedule?: DolyamePaymentScheduleItem[];
  /** Correlation id of the notification. */
  cid: string;
  /** Hex digest. The signing input is not specified in the public documentation; see the README. */
  signature: string;
  [field: string]: unknown;
}

/**
 * Parses and shape-checks a webhook body. This does NOT authenticate it: combine with
 * {@link isDolyameWebhookIp} and {@link confirmDolyameWebhook}.
 */
export function parseDolyameWebhook(raw: string | Buffer | object): DolyameWebhook {
  let body: unknown = raw;
  if (typeof raw === "string" || Buffer.isBuffer(raw)) {
    try {
      body = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      throw new WebhookError("invalid_json", "body is not valid JSON");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WebhookError("not_an_object", "body must be a JSON object", body);
  }
  const payload = body as Record<string, unknown>;

  for (const key of ["id", "cid", "signature"] as const) {
    if (typeof payload[key] !== "string" || payload[key] === "") {
      throw new WebhookError("invalid_shape", `"${key}" must be a non-empty string`, payload);
    }
  }
  for (const key of ["amount", "residual_amount"] as const) {
    if (typeof payload[key] !== "number" || !Number.isFinite(payload[key])) {
      throw new WebhookError("invalid_shape", `"${key}" must be a number`, payload);
    }
  }
  const status = payload["status"];
  if (typeof status !== "string") {
    throw new WebhookError("invalid_shape", '"status" must be a string', payload);
  }
  if (!(DOLYAME_STATUSES as readonly string[]).includes(status)) {
    throw new WebhookError("unknown_status", `unknown status ${JSON.stringify(status)}`, payload);
  }
  return payload as DolyameWebhook;
}

/** Source networks of Dolyame notifications, per the "Webhooks" documentation page. */
export const DOLYAME_WEBHOOK_IP_RANGES = ["91.194.226.0/23", "91.218.132.0/22", "212.233.80.0/22"] as const;

/**
 * True when `ip` belongs to one of the documented source networks. Accepts IPv4 and
 * IPv4-mapped IPv6 (`::ffff:91.194.226.5`, which is what many servers report).
 * Behind a reverse proxy or CDN pass the address your proxy vouches for, never a raw client header.
 */
export function isDolyameWebhookIp(ip: string, ranges: readonly string[] = DOLYAME_WEBHOOK_IP_RANGES): boolean {
  const address = ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  return ranges.some((range) => ipv4InCidr(address, range));
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  if (!network || !isIPv4(ip) || !isIPv4(network) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(network) & mask) >>> 0);
}

function toInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

export interface DolyameInfoSource {
  info(orderId: string): Promise<DolyameResult<DolyameOrderInfo>>;
}

export interface DolyameWebhookCheck {
  /** Does the order's actual status equal the one in the notification? */
  matches: boolean;
  /** Authoritative status from `info`. Store this one, not the webhook's. */
  actual: DolyameStatus;
  info: DolyameOrderInfo;
}

/**
 * The verification step the documentation puts first: ask the API for the order's status
 * ("check that the status from the notification is current"). Treat the webhook as a wake-up call
 * and `info` as the truth. Throws `DolyameError` when `info` fails.
 */
export async function confirmDolyameWebhook(
  client: DolyameInfoSource,
  webhook: Pick<DolyameWebhook, "id" | "status">,
): Promise<DolyameWebhookCheck> {
  const result = await client.info(webhook.id);
  if (!result.ok) throw result.error;
  const actual = result.data.status;
  return {
    matches: canonicalDolyameStatus(actual) === canonicalDolyameStatus(webhook.status),
    actual,
    info: result.data,
  };
}
