import { ValidationError } from "../errors.js";
import { lineAmount } from "../money.js";
import type {
  PaymentMethod,
  PaymentObject,
  PaymentObjectFfd105,
  PaymentObjectFfd12,
  ReceiptFfd105,
  ReceiptFfd12,
  ReceiptItemFfd105,
  ReceiptItemFfd12,
  TaxRate,
  Taxation,
} from "./receipt-types.js";
import { validateReceipt } from "./receipt-validate.js";

export interface ReceiptItemInput {
  name: string;
  /** Price of one unit in kopecks. */
  price: number;
  /** Units; fractional values (weight) are allowed up to 6 decimals. */
  quantity: number;
  tax: TaxRate;
  /** Line total in kopecks. Default: price * quantity rounded half up. */
  amount?: number;
  /** Default `full_payment`. */
  paymentMethod?: PaymentMethod;
  /** Default `commodity`. Must belong to the chosen FFD version's list. */
  paymentObject?: PaymentObject;
  /** FFD 1.2 only. Default `шт` for whole quantities; required for fractional ones. */
  measurementUnit?: string;
}

export interface BuildReceiptInput<V extends "1.05" | "1.2" = "1.05" | "1.2"> {
  ffd: V;
  taxation: Taxation;
  email?: string;
  phone?: string;
  items: readonly ReceiptItemInput[];
  /** Payment `Amount` in kopecks; if given, the item sum is checked against it. */
  expectedAmount?: number;
}

/**
 * Builds and validates a receipt. Throws `ValidationError` (with every issue listed) instead of
 * letting the bank reject the payment with a generic message.
 */
export function buildReceipt(input: BuildReceiptInput<"1.05">): ReceiptFfd105;
export function buildReceipt(input: BuildReceiptInput<"1.2">): ReceiptFfd12;
export function buildReceipt(input: BuildReceiptInput): ReceiptFfd105 | ReceiptFfd12 {
  const common = {
    ...(input.email === undefined ? {} : { Email: input.email }),
    ...(input.phone === undefined ? {} : { Phone: input.phone }),
    Taxation: input.taxation,
  };

  const receipt: ReceiptFfd105 | ReceiptFfd12 =
    input.ffd === "1.2"
      ? { ...common, Items: input.items.map((item, index) => toItemFfd12(item, index)) }
      : { ...common, Items: input.items.map((item, index) => toItemFfd105(item, index)) };

  validateReceipt(receipt, {
    ffd: input.ffd,
    ...(input.expectedAmount === undefined ? {} : { expectedAmount: input.expectedAmount }),
  });
  return receipt;
}

function amountOf(item: ReceiptItemInput, index: number): number {
  if (item.amount !== undefined) return item.amount;
  try {
    return lineAmount(item.price, item.quantity);
  } catch (error) {
    throw new ValidationError(
      [{ path: `Items[${index}]`, code: "OUT_OF_RANGE", message: (error as Error).message }],
      "Receipt",
    );
  }
}

function toItemFfd105(item: ReceiptItemInput, index: number): ReceiptItemFfd105 {
  return {
    Name: item.name,
    Price: item.price,
    Quantity: item.quantity,
    Amount: amountOf(item, index),
    Tax: item.tax,
    PaymentMethod: item.paymentMethod ?? "full_payment",
    PaymentObject: (item.paymentObject ?? "commodity") as PaymentObjectFfd105,
  };
}

function toItemFfd12(item: ReceiptItemInput, index: number): ReceiptItemFfd12 {
  const unit = item.measurementUnit ?? (Number.isInteger(item.quantity) ? "шт" : undefined);
  return {
    Name: item.name,
    Price: item.price,
    Quantity: item.quantity,
    Amount: amountOf(item, index),
    Tax: item.tax,
    PaymentMethod: item.paymentMethod ?? "full_payment",
    PaymentObject: (item.paymentObject ?? "commodity") as PaymentObjectFfd12,
    // Left undefined for fractional quantities so validation reports the missing unit.
    MeasurementUnit: unit as string,
  };
}
