import { ValidationError, type ValidationIssue } from "../errors.js";
import { lineAmount } from "../money.js";
import {
  AGENT_SIGNS,
  PAYMENT_METHODS,
  PAYMENT_OBJECTS_FFD105,
  PAYMENT_OBJECTS_FFD12,
  TAXATIONS,
  TAX_RATES,
  type FfdMode,
  type Receipt,
} from "./receipt-types.js";

export interface ReceiptValidationOptions {
  /**
   * FFD version of the terminal's cash register (set in the T-Bank cabinet).
   * `"1.2"` additionally requires PaymentMethod, PaymentObject and MeasurementUnit on every item and
   * uses the 1.2 PaymentObject list; `"1.05"` uses the 1.05 list; `"auto"` (default) accepts both lists.
   */
  ffd?: FfdMode;
  /** Init/Confirm `Amount` in kopecks. When set, the sum of item amounts must equal it exactly. */
  expectedAmount?: number;
  /**
   * Allowed difference between `Amount` and `Price * Quantity` in kopecks. Default 0 (the docs say
   * Amount is the product). Raise to 1 only if your cash register rounds fractional quantities differently.
   */
  roundingToleranceKopecks?: number;
}

const MAX_ITEMS = 100;
const PLUS_DIGITS = /^\+\d+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALL_PAYMENT_OBJECTS = new Set<string>([...PAYMENT_OBJECTS_FFD105, ...PAYMENT_OBJECTS_FFD12]);

type Obj = Record<string, unknown>;

/** Returns every problem found; an empty array means the receipt is acceptable. */
export function collectReceiptIssues(receipt: unknown, options: ReceiptValidationOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };
  const ffd = options.ffd ?? "auto";
  const tolerance = options.roundingToleranceKopecks ?? 0;

  if (!isObj(receipt)) {
    add("Receipt", "INVALID_TYPE", "must be an object");
    return issues;
  }

  checkEnum(receipt["Taxation"], TAXATIONS, "Taxation", add, true);

  const email = receipt["Email"];
  const phone = receipt["Phone"];
  if (email === undefined && phone === undefined) {
    add("Email", "CONTACT_REQUIRED", "Email or Phone of the buyer is required (tag 1008)");
  }
  if (email !== undefined && checkString(email, "Email", 64, add) && !EMAIL.test(email as string)) {
    add("Email", "INVALID_FORMAT", "is not a valid e-mail address");
  }
  if (phone !== undefined && checkString(phone, "Phone", 64, add) && !PLUS_DIGITS.test(phone as string)) {
    add("Phone", "INVALID_FORMAT", "must look like +71234567890 (plus sign and digits only)");
  }

  const items = receipt["Items"];
  let itemsTotal: number | undefined;
  if (!Array.isArray(items) || items.length === 0) {
    add("Items", "REQUIRED", "must be a non-empty array");
  } else {
    if (items.length > MAX_ITEMS) {
      add("Items", "TOO_MANY_ITEMS", `at most ${MAX_ITEMS} items are allowed, got ${items.length}`);
    }
    let total = 0;
    let totalIsExact = true;
    items.forEach((item: unknown, index) => {
      const path = `Items[${index}]`;
      checkItem(item, path, ffd, tolerance, add);
      const amount = isObj(item) ? item["Amount"] : undefined;
      if (isMoney(amount)) total += amount;
      else totalIsExact = false;
    });
    if (totalIsExact) itemsTotal = total;
  }

  if (itemsTotal !== undefined && options.expectedAmount !== undefined && itemsTotal !== options.expectedAmount) {
    add(
      "Items",
      "SUM_MISMATCH",
      `item amounts sum to ${itemsTotal} kopecks but the payment Amount is ${options.expectedAmount}`,
    );
  }

  checkPayments(receipt["Payments"], itemsTotal, options.expectedAmount, add);
  checkReceiptExtras(receipt, add);
  return issues;
}

/** Throws `ValidationError` listing all problems. Narrows `receipt` to `Receipt` on success. */
export function validateReceipt(receipt: unknown, options: ReceiptValidationOptions = {}): asserts receipt is Receipt {
  const issues = collectReceiptIssues(receipt, options);
  if (issues.length > 0) throw new ValidationError(issues, "Receipt");
}

/** Sum of item amounts in kopecks (throws on a malformed receipt). */
export function receiptItemsTotal(receipt: Receipt): number {
  return (receipt.Items as { Amount: number }[]).reduce((sum, item) => sum + item.Amount, 0);
}

type Add = (path: string, code: string, message: string) => void;

function checkItem(item: unknown, path: string, ffd: FfdMode, tolerance: number, add: Add): void {
  if (!isObj(item)) {
    add(path, "INVALID_TYPE", "must be an object");
    return;
  }
  if (checkString(item["Name"], `${path}.Name`, 128, add, true) && (item["Name"] as string).trim() === "") {
    add(`${path}.Name`, "REQUIRED", "must not be blank");
  }

  const price = item["Price"];
  const quantity = item["Quantity"];
  const amount = item["Amount"];
  const priceOk = checkMoney(price, `${path}.Price`, add);
  const amountOk = checkMoney(amount, `${path}.Amount`, add);
  const quantityOk = checkQuantity(quantity, `${path}.Quantity`, add);
  if (priceOk && amountOk && quantityOk) {
    const expected = lineAmount(price as number, quantity as number);
    if (Math.abs((amount as number) - expected) > tolerance) {
      add(
        `${path}.Amount`,
        "AMOUNT_MISMATCH",
        `Amount ${amount as number} differs from Price * Quantity = ${expected} (kopecks)`,
      );
    }
  }

  checkEnum(item["Tax"], TAX_RATES, `${path}.Tax`, add, true);

  const requireFfd12 = ffd === "1.2";
  checkEnum(item["PaymentMethod"], PAYMENT_METHODS, `${path}.PaymentMethod`, add, requireFfd12);
  const objects = ffd === "1.05" ? PAYMENT_OBJECTS_FFD105 : ffd === "1.2" ? PAYMENT_OBJECTS_FFD12 : [...ALL_PAYMENT_OBJECTS];
  checkEnum(item["PaymentObject"], objects, `${path}.PaymentObject`, add, requireFfd12);

  const unit = item["MeasurementUnit"];
  if (unit !== undefined || requireFfd12) checkString(unit, `${path}.MeasurementUnit`, 16, add, true);

  optionalString(item["Ean13"], `${path}.Ean13`, 300, add);
  optionalString(item["UserData"], `${path}.UserData`, 64, add);
  optionalString(item["CountryCode"], `${path}.CountryCode`, 3, add);
  optionalString(item["DeclarationNumber"], `${path}.DeclarationNumber`, 32, add);
  if (item["Excise"] !== undefined && !(typeof item["Excise"] === "number" && item["Excise"] >= 0)) {
    add(`${path}.Excise`, "OUT_OF_RANGE", "must be a non-negative number");
  }

  checkMarking(item, path, add);
  checkAgent(item["AgentData"], item["SupplierInfo"], path, add);
}

function checkQuantity(value: unknown, path: string, add: Add): boolean {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    add(path, "OUT_OF_RANGE", "must be a positive number");
    return false;
  }
  const text = String(value);
  if (/e/i.test(text)) {
    add(path, "OUT_OF_RANGE", "is too large or too small");
    return false;
  }
  const [whole = "", fraction = ""] = text.split(".");
  if (whole.length > 5 || fraction.length > 6) {
    add(path, "OUT_OF_RANGE", "allows at most 5 integer and 6 fractional digits (tag 1023)");
    return false;
  }
  return true;
}

function checkMarking(item: Obj, path: string, add: Add): void {
  const mode = item["MarkProcessingMode"];
  if (mode !== undefined && mode !== "0") {
    add(`${path}.MarkProcessingMode`, "INVALID_ENUM", 'must be "0" (tag 2102)');
  }
  const code = item["MarkCode"];
  if (code !== undefined) {
    if (!isObj(code)) {
      add(`${path}.MarkCode`, "INVALID_TYPE", "must be an object");
    } else {
      checkString(code["MarkCodeType"], `${path}.MarkCode.MarkCodeType`, undefined, add, true);
      checkString(code["Value"], `${path}.MarkCode.Value`, undefined, add, true);
    }
  }
  const quantity = item["MarkQuantity"];
  if (quantity !== undefined) {
    if (!isObj(quantity)) {
      add(`${path}.MarkQuantity`, "INVALID_TYPE", "must be an object");
    } else {
      const numerator = quantity["Numerator"];
      const denominator = quantity["Denominator"];
      if (typeof numerator !== "number" || typeof denominator !== "number" || numerator <= 0 || denominator <= 0) {
        add(`${path}.MarkQuantity`, "OUT_OF_RANGE", "Numerator and Denominator must be positive numbers");
      } else if (numerator >= denominator) {
        add(`${path}.MarkQuantity.Numerator`, "OUT_OF_RANGE", "must be strictly less than Denominator (tags 1293/1294)");
      }
    }
  }
  const props = item["SectoralItemProps"];
  if (props !== undefined) {
    if (!Array.isArray(props)) {
      add(`${path}.SectoralItemProps`, "INVALID_TYPE", "must be an array");
    } else {
      props.forEach((prop: unknown, index) => {
        const p = `${path}.SectoralItemProps[${index}]`;
        if (!isObj(prop)) {
          add(p, "INVALID_TYPE", "must be an object");
          return;
        }
        checkString(prop["FederalId"], `${p}.FederalId`, undefined, add, true);
        checkString(prop["Date"], `${p}.Date`, undefined, add, true);
        checkString(prop["Number"], `${p}.Number`, 32, add, true);
        checkString(prop["Value"], `${p}.Value`, 256, add, true);
      });
    }
  }
}

function checkAgent(agentData: unknown, supplierInfo: unknown, path: string, add: Add): void {
  if (agentData === undefined) {
    return;
  }
  if (!isObj(agentData)) {
    add(`${path}.AgentData`, "INVALID_TYPE", "must be an object");
    return;
  }
  const sign = agentData["AgentSign"];
  checkEnum(sign, AGENT_SIGNS, `${path}.AgentData.AgentSign`, add, false);
  if (sign === undefined) return;

  const bank = sign === "bank_paying_agent" || sign === "bank_paying_subagent";
  const paying = sign === "paying_agent" || sign === "paying_subagent";
  const a = `${path}.AgentData`;

  const phoneLists: [string, boolean][] = [
    ["Phones", bank || paying],
    ["ReceiverPhones", paying],
    ["TransferPhones", bank],
  ];
  for (const [name, required] of phoneLists) checkPhoneList(agentData[name], `${a}.${name}`, required, add);

  if (bank) {
    checkString(agentData["OperationName"], `${a}.OperationName`, 24, add, true);
    checkString(agentData["OperatorName"], `${a}.OperatorName`, 64, add, true);
    checkString(agentData["OperatorAddress"], `${a}.OperatorAddress`, 243, add, true);
    checkString(agentData["OperatorInn"], `${a}.OperatorInn`, 12, add, true);
  }

  const s = `${path}.SupplierInfo`;
  if (!isObj(supplierInfo)) {
    add(s, "REQUIRED", "is required when AgentData.AgentSign is set");
    return;
  }
  checkPhoneList(supplierInfo["Phones"], `${s}.Phones`, true, add);
  const phones = Array.isArray(supplierInfo["Phones"]) ? (supplierInfo["Phones"] as unknown[]) : [];
  const phonesBudget = phones.reduce<number>((sum, p) => sum + (typeof p === "string" ? p.length + 4 : 0), 0);
  if (checkString(supplierInfo["Name"], `${s}.Name`, undefined, add, true)) {
    const name = supplierInfo["Name"] as string;
    if (name.length + phonesBudget > 239) {
      add(`${s}.Name`, "TOO_LONG", "Name plus (phone length + 4) per phone must fit in 239 characters (tag 1225)");
    }
  }
  const inn = supplierInfo["Inn"];
  if (typeof inn !== "string" || !/^\d{10,12}$/.test(inn)) {
    add(`${s}.Inn`, "INVALID_FORMAT", "must be 10 to 12 digits (tag 1226)");
  }
}

function checkPhoneList(value: unknown, path: string, required: boolean, add: Add): void {
  if (value === undefined) {
    if (required) add(path, "REQUIRED", "is required for this AgentSign");
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    add(path, "INVALID_TYPE", "must be a non-empty array of phone numbers");
    return;
  }
  value.forEach((phone: unknown, index) => {
    if (typeof phone !== "string" || phone.length > 19 || !PLUS_DIGITS.test(phone)) {
      add(`${path}[${index}]`, "INVALID_FORMAT", "must look like +71234567890 and be at most 19 characters");
    }
  });
}

function checkPayments(
  payments: unknown,
  itemsTotal: number | undefined,
  expectedAmount: number | undefined,
  add: Add,
): void {
  if (payments === undefined) return;
  if (!isObj(payments)) {
    add("Payments", "INVALID_TYPE", "must be an object");
    return;
  }
  if (payments["Electronic"] === undefined) {
    add("Payments.Electronic", "REQUIRED", "is required when Payments is present");
  }
  let sum = 0;
  let sumIsExact = true;
  for (const key of ["Cash", "Electronic", "AdvancePayment", "Credit", "Provision"]) {
    const value = payments[key];
    if (value === undefined) continue;
    if (checkMoney(value, `Payments.${key}`, add)) sum += value as number;
    else sumIsExact = false;
  }
  if (
    expectedAmount !== undefined &&
    isMoney(payments["Electronic"]) &&
    payments["Electronic"] !== expectedAmount
  ) {
    add("Payments.Electronic", "SUM_MISMATCH", `must equal the payment Amount (${expectedAmount})`);
  }
  if (sumIsExact && itemsTotal !== undefined && sum !== itemsTotal) {
    add("Payments", "SUM_MISMATCH", `payment kinds sum to ${sum} but item amounts sum to ${itemsTotal}`);
  }
}

function checkReceiptExtras(receipt: Obj, add: Add): void {
  const info = receipt["ClientInfo"];
  if (info !== undefined) {
    if (!isObj(info)) add("ClientInfo", "INVALID_TYPE", "must be an object");
    else optionalString(info["Address"], "ClientInfo.Address", 256, add);
  }
  const prop = receipt["AddUserProp"];
  if (prop !== undefined) {
    if (!isObj(prop)) {
      add("AddUserProp", "INVALID_TYPE", "must be an object");
    } else {
      checkString(prop["Name"], "AddUserProp.Name", 64, add, true);
      checkString(prop["Value"], "AddUserProp.Value", 256, add, true);
    }
  }
  // Tag 1192 is spelled additionalCheckProps (FFD 1.05) and AdditionalCheckProps (FFD 1.2) in the docs.
  optionalString(receipt["additionalCheckProps"], "additionalCheckProps", 16, add);
  optionalString(receipt["AdditionalCheckProps"], "AdditionalCheckProps", 16, add);
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkMoney(value: unknown, path: string, add: Add): boolean {
  if (!isMoney(value)) {
    add(path, "OUT_OF_RANGE", "must be a non-negative integer number of kopecks");
    return false;
  }
  return true;
}

function checkString(value: unknown, path: string, maxLength: number | undefined, add: Add, required = false): boolean {
  if (value === undefined) {
    if (required) add(path, "REQUIRED", "is required");
    return false;
  }
  if (typeof value !== "string" || value.length === 0) {
    add(path, "INVALID_TYPE", "must be a non-empty string");
    return false;
  }
  if (maxLength !== undefined && value.length > maxLength) {
    add(path, "TOO_LONG", `must be at most ${maxLength} characters, got ${value.length}`);
    return false;
  }
  return true;
}

function optionalString(value: unknown, path: string, maxLength: number, add: Add): void {
  if (value !== undefined) checkString(value, path, maxLength, add);
}

function checkEnum(value: unknown, allowed: readonly string[], path: string, add: Add, required: boolean): void {
  if (value === undefined) {
    if (required) add(path, "REQUIRED", `is required (one of: ${allowed.join(", ")})`);
    return;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    add(path, "INVALID_ENUM", `${JSON.stringify(value)} is not allowed; expected one of: ${allowed.join(", ")}`);
  }
}
