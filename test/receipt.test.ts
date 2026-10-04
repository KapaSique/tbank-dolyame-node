import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAYMENT_OBJECTS_FFD105,
  PAYMENT_OBJECTS_FFD12,
  TAXATIONS,
  TAX_RATES,
  ValidationError,
  buildReceipt,
  collectReceiptIssues,
  receiptItemsTotal,
  validateReceipt,
  type Receipt,
  type ReceiptFfd105,
  type ReceiptFfd12,
} from "../src/index.js";

const goodFfd105 = (): ReceiptFfd105 => ({
  Email: "buyer@shop.example",
  Taxation: "usn_income",
  Items: [
    { Name: "T-shirt", Price: 129900, Quantity: 2, Amount: 259800, Tax: "none" },
    { Name: "Delivery", Price: 30000, Quantity: 1, Amount: 30000, Tax: "none", PaymentObject: "service" },
  ],
});

const goodFfd12 = (): ReceiptFfd12 => ({
  Phone: "+71234567890",
  Taxation: "osn",
  Items: [
    {
      Name: "Cheese",
      Price: 45000,
      Quantity: 0.35,
      Amount: 15750,
      Tax: "vat22",
      PaymentMethod: "full_payment",
      PaymentObject: "commodity",
      MeasurementUnit: "кг",
    },
  ],
});

const codes = (receipt: unknown, options = {}): string[] => collectReceiptIssues(receipt, options).map((i) => `${i.path}:${i.code}`);

test("valid FFD 1.05 and FFD 1.2 receipts pass, including the amount cross-check", () => {
  assert.deepEqual(collectReceiptIssues(goodFfd105(), { ffd: "1.05", expectedAmount: 289800 }), []);
  assert.deepEqual(collectReceiptIssues(goodFfd12(), { ffd: "1.2", expectedAmount: 15750 }), []);
  assert.deepEqual(collectReceiptIssues(goodFfd105()), []);
  assert.equal(receiptItemsTotal(goodFfd105()), 289800);
});

test("sum of item amounts must equal the payment Amount", () => {
  assert.deepEqual(codes(goodFfd105(), { expectedAmount: 289801 }), ["Items:SUM_MISMATCH"]);
});

test("Amount must equal Price * Quantity for every item", () => {
  const receipt = goodFfd105();
  (receipt.Items[0] as { Amount: number }).Amount = 259799;
  assert.deepEqual(codes(receipt), ["Items[0].Amount:AMOUNT_MISMATCH"]);
});

test("rounding tolerance can be raised for fractional quantities only when asked", () => {
  const receipt = goodFfd12();
  (receipt.Items[0] as { Amount: number }).Amount = 15749;
  assert.deepEqual(codes(receipt), ["Items[0].Amount:AMOUNT_MISMATCH"]);
  assert.deepEqual(codes(receipt, { roundingToleranceKopecks: 1 }), []);
});

test("fractional quantities are multiplied without float noise (rounded half up)", () => {
  const receipt = buildReceipt({
    ffd: "1.2",
    taxation: "osn",
    email: "buyer@shop.example",
    items: [{ name: "Tea", price: 33300, quantity: 0.333, tax: "vat22", measurementUnit: "кг" }],
  });
  assert.equal(receipt.Items[0]?.Amount, 11089); // 333 * 33.3 = 110.889 rubles -> 11089 kopecks
});

test("buyer contact is required: Email or Phone", () => {
  const receipt = goodFfd105();
  delete receipt.Email;
  assert.deepEqual(codes(receipt), ["Email:CONTACT_REQUIRED"]);
  assert.deepEqual(codes({ ...receipt, Email: "not-an-email" }), ["Email:INVALID_FORMAT"]);
  assert.deepEqual(codes({ ...receipt, Phone: "89991112233" }), ["Phone:INVALID_FORMAT"]);
  assert.deepEqual(codes({ ...receipt, Phone: "+79991112233" }), []);
});

test("Taxation, Tax, PaymentMethod and PaymentObject are checked against the documented enums", () => {
  const receipt = goodFfd105();
  const bad = {
    ...receipt,
    Taxation: "simplified",
    Items: [{ ...receipt.Items[0], Tax: "vat20", PaymentMethod: "paid", PaymentObject: "goods" }],
  };
  assert.deepEqual(codes(bad).sort(), [
    "Items[0].PaymentMethod:INVALID_ENUM",
    "Items[0].PaymentObject:INVALID_ENUM",
    "Items[0].Tax:INVALID_ENUM",
    "Taxation:INVALID_ENUM",
  ]);
  assert.ok(TAXATIONS.includes("usn_income") && TAX_RATES.includes("vat22") && TAX_RATES.includes("vat122"));
});

test("PaymentObject lists differ by FFD version", () => {
  const receipt = goodFfd105();
  (receipt.Items[0] as { PaymentObject?: string }).PaymentObject = "composite";
  assert.deepEqual(codes(receipt, { ffd: "1.05" }), []);
  assert.deepEqual(codes(receipt, { ffd: "1.2" }), [
    "Items[0].PaymentMethod:REQUIRED",
    "Items[0].PaymentObject:INVALID_ENUM",
    "Items[0].MeasurementUnit:REQUIRED",
    "Items[1].PaymentMethod:REQUIRED",
    "Items[1].MeasurementUnit:REQUIRED",
  ]);
  const marked = goodFfd12();
  (marked.Items[0] as { PaymentObject?: string }).PaymentObject = "goods_with_marking_code";
  assert.deepEqual(codes(marked, { ffd: "1.2" }), []);
  assert.deepEqual(codes(marked, { ffd: "1.05" }), ["Items[0].PaymentObject:INVALID_ENUM"]);
  assert.equal(PAYMENT_OBJECTS_FFD105.length, 13);
  assert.equal(PAYMENT_OBJECTS_FFD12.length, 31);
});

test("FFD 1.2 requires PaymentMethod, PaymentObject and MeasurementUnit on every item", () => {
  const receipt = goodFfd105();
  assert.deepEqual(codes(receipt, { ffd: "1.2" }), [
    "Items[0].PaymentMethod:REQUIRED",
    "Items[0].PaymentObject:REQUIRED",
    "Items[0].MeasurementUnit:REQUIRED",
    "Items[1].PaymentMethod:REQUIRED",
    "Items[1].MeasurementUnit:REQUIRED",
  ]);
});

test("Items: count, name length, quantity digits and money fields", () => {
  const item = { Name: "x", Price: 1, Quantity: 1, Amount: 1, Tax: "none" as const };
  const tooMany = { ...goodFfd105(), Items: Array.from({ length: 101 }, () => item) };
  assert.ok(codes(tooMany).includes("Items:TOO_MANY_ITEMS"));
  assert.deepEqual(codes({ ...goodFfd105(), Items: [] }), ["Items:REQUIRED"]);

  const bad = {
    ...goodFfd105(),
    Items: [{ Name: "n".repeat(129), Price: 1.5, Quantity: 123456, Amount: -1, Tax: "none" }],
  };
  assert.deepEqual(codes(bad).sort(), [
    "Items[0].Amount:OUT_OF_RANGE",
    "Items[0].Name:TOO_LONG",
    "Items[0].Price:OUT_OF_RANGE",
    "Items[0].Quantity:OUT_OF_RANGE",
  ]);
  assert.deepEqual(codes({ ...goodFfd105(), Items: [{ ...item, Quantity: 0.1234567 }] }), ["Items[0].Quantity:OUT_OF_RANGE"]);
});

test("Payments: Electronic is required, must equal the payment Amount, and all kinds must sum to the items", () => {
  const withPayments = (payments: object): Receipt => ({ ...goodFfd105(), Payments: payments as never });
  assert.deepEqual(codes(withPayments({ Cash: 289800 })), ["Payments.Electronic:REQUIRED"]);
  assert.deepEqual(codes(withPayments({ Electronic: 289800 }), { expectedAmount: 289800 }), []);
  assert.deepEqual(codes(withPayments({ Electronic: 289700, Cash: 100 }), { expectedAmount: 289800 }), ["Payments.Electronic:SUM_MISMATCH"]);
  assert.deepEqual(codes(withPayments({ Electronic: 100 })), ["Payments:SUM_MISMATCH"]);
});

test("agent receipts: AgentSign drives which AgentData fields and SupplierInfo are required", () => {
  const withAgent = (agent: object, supplier?: object): Receipt => {
    const receipt = goodFfd105();
    Object.assign(receipt.Items[0] as object, { AgentData: agent, ...(supplier ? { SupplierInfo: supplier } : {}) });
    return receipt;
  };
  const supplier = { Phones: ["+74951234567"], Name: "Supplier LLC", Inn: "7701234567" };

  assert.deepEqual(codes(withAgent({ AgentSign: "commission_agent" })), ["Items[0].SupplierInfo:REQUIRED"]);
  assert.deepEqual(codes(withAgent({ AgentSign: "commission_agent" }, supplier)), []);
  assert.deepEqual(codes(withAgent({ AgentSign: "paying_agent", Phones: ["+74951234567"] }, supplier)), [
    "Items[0].AgentData.ReceiverPhones:REQUIRED",
  ]);
  assert.deepEqual(codes(withAgent({ AgentSign: "bank_paying_agent" }, supplier)).sort(), [
    "Items[0].AgentData.OperationName:REQUIRED",
    "Items[0].AgentData.OperatorAddress:REQUIRED",
    "Items[0].AgentData.OperatorInn:REQUIRED",
    "Items[0].AgentData.OperatorName:REQUIRED",
    "Items[0].AgentData.Phones:REQUIRED",
    "Items[0].AgentData.TransferPhones:REQUIRED",
  ]);
  assert.deepEqual(codes(withAgent({ AgentSign: "attorney" }, { ...supplier, Inn: "123" })), ["Items[0].SupplierInfo.Inn:INVALID_FORMAT"]);
});

test("FFD 1.2 marking fields are validated", () => {
  const receipt = goodFfd12();
  Object.assign(receipt.Items[0] as object, {
    MarkProcessingMode: "1",
    MarkCode: { MarkCodeType: "GS1M" },
    MarkQuantity: { Numerator: 2, Denominator: 2 },
  });
  assert.deepEqual(codes(receipt).sort(), [
    "Items[0].MarkCode.Value:REQUIRED",
    "Items[0].MarkProcessingMode:INVALID_ENUM",
    "Items[0].MarkQuantity.Numerator:OUT_OF_RANGE",
  ]);
});

test("validateReceipt throws one ValidationError that lists every problem", () => {
  const broken = { Taxation: "nope", Items: [{ Name: "", Price: -1 }] };
  assert.throws(
    () => validateReceipt(broken),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.issues.length >= 5);
      assert.match(error.message, /Taxation/);
      assert.match(error.message, /Items\[0\]\.Price/);
      return true;
    },
  );
  assert.deepEqual(codes("not an object"), ["Receipt:INVALID_TYPE"]);
});

test("buildReceipt fills defaults and returns a receipt that validates", () => {
  const ffd105 = buildReceipt({
    ffd: "1.05",
    taxation: "usn_income",
    email: "buyer@shop.example",
    items: [{ name: "Hoodie", price: 599000, quantity: 1, tax: "none" }],
    expectedAmount: 599000,
  });
  assert.deepEqual(ffd105.Items[0], {
    Name: "Hoodie",
    Price: 599000,
    Quantity: 1,
    Amount: 599000,
    Tax: "none",
    PaymentMethod: "full_payment",
    PaymentObject: "commodity",
  });

  const ffd12 = buildReceipt({
    ffd: "1.2",
    taxation: "osn",
    phone: "+79990001122",
    items: [{ name: "Delivery", price: 25000, quantity: 1, tax: "vat22", paymentObject: "service" }],
  });
  assert.equal(ffd12.Items[0]?.MeasurementUnit, "шт");
});

test("buildReceipt refuses a mismatching total and a fractional item without a unit", () => {
  assert.throws(
    () =>
      buildReceipt({
        ffd: "1.05",
        taxation: "osn",
        email: "buyer@shop.example",
        items: [{ name: "A", price: 100, quantity: 2, tax: "none" }],
        expectedAmount: 150,
      }),
    /SUM_MISMATCH|sum to 200/,
  );
  assert.throws(
    () =>
      buildReceipt({
        ffd: "1.2",
        taxation: "osn",
        email: "buyer@shop.example",
        items: [{ name: "Cheese", price: 100, quantity: 0.5, tax: "none" }],
      }),
    /MeasurementUnit/,
  );
});
