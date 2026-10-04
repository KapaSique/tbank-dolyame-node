/**
 * Create a T-Bank payment (one- or two-stage) and read it back.
 *
 *   TBANK_TERMINAL_KEY=... TBANK_PASSWORD=... npx tsx examples/tbank-payment.ts
 *
 * Two-stage flow:  init (PayType "T") -> buyer pays -> notification AUTHORIZED -> confirm -> CONFIRMED
 *                  or cancel while AUTHORIZED to release the hold (REVERSED).
 * One-stage flow:  init (PayType "O") -> buyer pays -> notifications AUTHORIZED + CONFIRMED.
 * After CONFIRMED, `cancel` is a refund (REFUNDED / PARTIAL_REFUNDED).
 */
import {
  TBANK_PRODUCTION_URL,
  TbankClient,
  buildReceipt,
  createRussianTrustAgent,
  isAllowedPaymentUrl,
  tbankStatusKind,
  unwrap,
} from "tbank-dolyame-node";

const terminalKey = process.env["TBANK_TERMINAL_KEY"];
const password = process.env["TBANK_PASSWORD"];
if (!terminalKey || !password) throw new Error("Set TBANK_TERMINAL_KEY and TBANK_PASSWORD");

const client = new TbankClient({
  terminalKey,
  password,
  baseUrl: process.env["TBANK_BASE_URL"] ?? TBANK_PRODUCTION_URL,
  agent: createRussianTrustAgent(), // see README: the Russian Trusted Root CA is missing from Node's store
  ffd: "1.2", // the FFD version configured for your terminal in the cabinet
});

const amount = 289_800; // kopecks
const orderId = `order-${Date.now()}`;

const created = await client.init({
  Amount: amount,
  OrderId: orderId,
  Description: `Order ${orderId}`,
  PayType: "T",
  NotificationURL: "https://shop.example/webhooks/tbank",
  SuccessURL: "https://shop.example/paid",
  FailURL: "https://shop.example/failed",
  Receipt: buildReceipt({
    ffd: "1.2",
    taxation: "usn_income",
    email: "buyer@shop.example",
    items: [
      { name: "T-shirt", price: 129_900, quantity: 2, tax: "none" },
      { name: "Delivery", price: 30_000, quantity: 1, tax: "none", paymentObject: "service" },
    ],
    expectedAmount: amount,
  }),
});

if (!created.ok) {
  // HTTP 200 + Success=false lands here with ErrorCode / Message / Details.
  console.error(created.error.errorCode, created.error.bankMessage, created.error.details);
  process.exit(1);
}

const { PaymentId, PaymentURL } = created.data;
// The payment page host is data from the bank, not a constant: keep the allow-list in configuration.
if (!PaymentURL || !isAllowedPaymentUrl(PaymentURL, (process.env["PAYMENT_HOSTS"] ?? "").split(","))) {
  throw new Error(`Refusing to redirect to ${PaymentURL ?? "(no PaymentURL)"}`);
}
console.log("redirect the buyer to", PaymentURL);

// Later (webhook or polling): ask the bank for the truth.
const state = unwrap(await client.getState({ PaymentId }));
console.log(state.Status, tbankStatusKind(state.Status));

// Two-stage: after AUTHORIZED, charge (<= authorised amount) ...
// unwrap(await client.confirm({ PaymentId, Amount: amount }));
// ... or give the money back, safely repeatable thanks to ExternalRequestId:
// unwrap(await client.cancel({ PaymentId, ExternalRequestId: `cancel-${orderId}` }));
