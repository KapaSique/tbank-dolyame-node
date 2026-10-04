/**
 * Build and validate 54-FZ receipts. Runs offline:  npx tsx examples/receipt.ts
 */
import { ValidationError, buildReceipt, collectReceiptIssues, toKopecks } from "tbank-dolyame-node";

// Money in kopecks. Convert rubles exactly: 19.99 * 100 is 1998.9999999999998 in floating point.
const hoodie = toKopecks("5990.00");
const delivery = toKopecks(300);

const receipt = buildReceipt({
  ffd: "1.2",
  taxation: "usn_income",
  phone: "+71234567890",
  items: [
    { name: "Hoodie", price: hoodie, quantity: 1, tax: "none" },
    { name: "Delivery", price: delivery, quantity: 1, tax: "none", paymentObject: "service" },
  ],
  expectedAmount: hoodie + delivery, // must equal the payment Amount
});
console.log(JSON.stringify(receipt, null, 2));

// A broken receipt reports every problem at once, before the bank sees it.
const broken = { ...receipt, Taxation: "simplified", Items: [{ ...receipt.Items[0], Amount: 1 }] };
console.log(collectReceiptIssues(broken, { ffd: "1.2" }));

try {
  buildReceipt({ ffd: "1.05", taxation: "osn", email: "buyer@shop.example", items: [{ name: "A", price: 100, quantity: 2, tax: "none" }], expectedAmount: 150 });
} catch (error) {
  if (error instanceof ValidationError) console.log(error.message);
}
