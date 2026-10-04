/**
 * Dolyame partner API: create -> (buyer pays) -> webhook -> info -> commit.
 *
 *   DOLYAME_LOGIN=... DOLYAME_PASSWORD=... DOLYAME_CERT=cert.pem DOLYAME_KEY=key.pem \
 *     npx tsx examples/dolyame-order.ts
 *
 * The mTLS certificate is issued in the T-Business cabinet (T-API -> certificate for Dolyame).
 */
import { readFileSync } from "node:fs";
import {
  DolyameClient,
  canCommitDolyame,
  confirmDolyameWebhook,
  isDolyameWebhookIp,
  parseDolyameWebhook,
  shouldApplyDolyameStatus,
  unwrap,
  type DolyameCreateRequest,
} from "tbank-dolyame-node";

const login = process.env["DOLYAME_LOGIN"];
const password = process.env["DOLYAME_PASSWORD"];
const certPath = process.env["DOLYAME_CERT"];
const keyPath = process.env["DOLYAME_KEY"];
if (!login || !password || !certPath || !keyPath) throw new Error("Set DOLYAME_LOGIN, DOLYAME_PASSWORD, DOLYAME_CERT, DOLYAME_KEY");

const dolyame = new DolyameClient({
  login,
  password,
  tls: { cert: readFileSync(certPath), key: readFileSync(keyPath) },
});

const order: DolyameCreateRequest = {
  order: {
    id: "shop_1001", // unique, <= 30 characters per the docs; also your idempotency anchor
    amount: 2000,
    prepaid_amount: 200, // e.g. paid with loyalty points
    items: [{ name: "T-shirt", quantity: 2, price: 1100, sku: "TS-01" }],
  },
  client_info: { first_name: "Ivan", last_name: "Ivanov", phone: "+79991112233" },
  notification_url: "https://shop.example/webhooks/dolyame",
  success_url: "https://shop.example/paid",
  fail_url: "https://shop.example/failed",
};

const created = await dolyame.create(order);
if (!created.ok) {
  console.error(created.error.code, created.error.errorDetailCode, created.error.bankMessage, created.error.correlationId);
  process.exit(1);
}
console.log("send the buyer to", created.data.link, "(correlation id", created.correlationId, ")");

// --- in your webhook route (framework of your choice) -------------------------------------------
export async function onDolyameWebhook(remoteIp: string, rawBody: Buffer, storedStatus: Parameters<typeof shouldApplyDolyameStatus>[0]): Promise<void> {
  if (!isDolyameWebhookIp(remoteIp)) return; // documented source networks only
  const webhook = parseDolyameWebhook(rawBody);

  // The webhook is a wake-up call; `info` is the truth (this is the verification step the docs list first).
  const check = await confirmDolyameWebhook(dolyame, webhook);
  if (!shouldApplyDolyameStatus(storedStatus, check.actual)) return; // duplicate or out-of-order delivery

  if (canCommitDolyame(check.actual)) {
    // The buyer has paid the first part. Commit once you are ready to ship (within 72 h of create).
    unwrap(await dolyame.commit(webhook.id, { amount: 2000, prepaid_amount: 200, items: order.order.items }));
  }
}
