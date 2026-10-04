/**
 * T-Bank notification receiver on Express 5.
 *
 *   npm i express
 *   TBANK_PASSWORD=... npx tsx examples/express-webhook.ts
 *
 * `verifyNotification(req.body, password)` needs the parsed JSON object exactly as sent: every
 * root-level scalar is part of the signature, so do not rename, drop or coerce fields before verifying.
 */
import express, { type Express } from "express";
import { pathToFileURL } from "node:url";
import { NOTIFICATION_OK_RESPONSE, verifyNotification, type TbankNotification } from "tbank-dolyame-node";

export interface ExpressWebhookOptions {
  password: string;
  /** Called only with verified notifications. Must be idempotent. */
  onNotification: (notification: TbankNotification) => void | Promise<void>;
}

export function createExpressApp(options: ExpressWebhookOptions): Express {
  const app = express();

  // `type: "*/*"`: parse as JSON whatever Content-Type the bank sends.
  app.post("/webhooks/tbank", express.json({ type: "*/*", limit: "64kb" }), async (req, res) => {
    if (!verifyNotification(req.body, options.password)) {
      res.sendStatus(400); // forged or corrupted: ignore the content completely
      return;
    }
    try {
      await options.onNotification(req.body as TbankNotification);
      res.type("text/plain").status(200).send(NOTIFICATION_OK_RESPONSE); // exactly "OK"
    } catch {
      res.sendStatus(500); // not handled: the bank will retry
    }
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const password = process.env["TBANK_PASSWORD"];
  if (!password) throw new Error("Set TBANK_PASSWORD");
  createExpressApp({
    password,
    onNotification: (notification) => {
      console.log("verified notification", notification.OrderId, notification.Status);
    },
  }).listen(3000, () => console.log("T-Bank webhook listening on http://localhost:3000/webhooks/tbank"));
}
