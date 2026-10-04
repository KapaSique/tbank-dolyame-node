/**
 * T-Bank notification receiver on plain node:http (no framework).
 *
 *   TBANK_PASSWORD=... npx tsx examples/node-http-webhook.ts
 *
 * Rules the bank imposes (see "Уведомления" in the docs):
 *   - answer HTTP 200 with the body exactly `OK` (upper case, no tags) *only when you handled it*;
 *   - anything else makes the bank retry (hourly for 24 h, then daily for a month);
 *   - the answer is awaited for 10 seconds, so do heavy work after you have persisted the event.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import {
  NOTIFICATION_OK_RESPONSE,
  NotificationError,
  parseNotification,
  tbankStatusKind,
  type TbankNotification,
} from "tbank-dolyame-node";

export interface WebhookOptions {
  password: string;
  /** Called only with verified notifications. Must be idempotent: the bank can deliver the same event twice. */
  onNotification: (notification: TbankNotification) => void | Promise<void>;
}

export function createWebhookServer(options: WebhookOptions): http.Server {
  return http.createServer((request, response) => {
    void handle(request, response, options);
  });
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse, options: WebhookOptions): Promise<void> {
  if (request.method !== "POST" || request.url !== "/webhooks/tbank") {
    response.writeHead(404).end();
    return;
  }
  try {
    const notification = parseNotification(await readBody(request, 64 * 1024), options.password);
    await options.onNotification(notification);
    response.writeHead(200, { "content-type": "text/plain" }).end(NOTIFICATION_OK_RESPONSE);
  } catch (error) {
    if (error instanceof NotificationError) {
      // Forged, corrupted or foreign: do not touch any order. 400 is fine, the bank will not accept it anyway.
      response.writeHead(400).end();
    } else {
      // Our own failure: let the bank retry later.
      response.writeHead(500).end();
    }
  }
}

function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.destroy(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** What a real handler does: compare with YOUR order, then act once. */
export async function exampleOnNotification(notification: TbankNotification): Promise<void> {
  const kind = tbankStatusKind(notification.Status);
  // 1. Load the order by notification.OrderId and compare notification.Amount with the amount you created
  //    (the docs require this check; do not ship goods on a mismatch).
  // 2. Act only on the transition you care about, idempotently:
  if (kind === "authorized") {
    // two-stage payment: money is held -> call client.confirm({ PaymentId }) when you are ready to charge
  } else if (kind === "paid") {
    // CONFIRMED: money is debited -> mark the order as paid / ship, once
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const password = process.env["TBANK_PASSWORD"];
  if (!password) throw new Error("Set TBANK_PASSWORD");
  createWebhookServer({ password, onNotification: exampleOnNotification }).listen(3000, () => {
    console.log("T-Bank webhook listening on http://localhost:3000/webhooks/tbank");
  });
}
