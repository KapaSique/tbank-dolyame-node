import type { ValidationIssue } from "../errors.js";
import { toKopecks } from "../money.js";
import type {
  DolyameCommitRequest,
  DolyameCompleteDeliveryRequest,
  DolyameCreateRequest,
  DolyameRefundRequest,
} from "./types.js";

/** Documentation ("Тестовая заявка"): the order name must be unique and at most 30 characters. */
export const DOLYAME_MAX_ORDER_ID_LENGTH = 30;

type Add = (path: string, code: string, message: string) => void;
type Obj = Record<string, unknown>;

function collector(): { issues: ValidationIssue[]; add: Add } {
  const issues: ValidationIssue[] = [];
  return {
    issues,
    add: (path, code, message) => {
      issues.push({ path, code, message });
    },
  };
}

export function collectCreateIssues(request: DolyameCreateRequest): ValidationIssue[] {
  const { issues, add } = collector();
  const order = (request as { order?: unknown }).order;
  if (!isObj(order)) {
    add("order", "REQUIRED", "is required");
    return issues;
  }
  const id = order["id"];
  if (typeof id !== "string" || id === "") {
    add("order.id", "REQUIRED", "must be a non-empty string");
  } else if (id.length > DOLYAME_MAX_ORDER_ID_LENGTH) {
    add(
      "order.id",
      "TOO_LONG",
      `the documentation asks for at most ${DOLYAME_MAX_ORDER_ID_LENGTH} characters, got ${id.length}`,
    );
  }
  checkTotals(order["amount"], order["prepaid_amount"], order["items"], "order", "amount", "items", add);
  checkClientInfo(request.client_info, add);
  for (const key of ["notification_url", "fail_url", "success_url"] as const) {
    const value = request[key];
    if (value !== undefined && !isHttpUrl(value)) add(key, "INVALID_FORMAT", "must be an absolute http(s) URL");
  }
  checkFiscalization(request.fiscalization_settings, add);
  return issues;
}

export function collectCommitIssues(request: DolyameCommitRequest): ValidationIssue[] {
  const { issues, add } = collector();
  checkTotals(request.amount, request.prepaid_amount, request.items, "", "amount", "items", add);
  checkFiscalization(request.fiscalization_settings, add);
  return issues;
}

export function collectRefundIssues(request: DolyameRefundRequest): ValidationIssue[] {
  const { issues, add } = collector();
  checkTotals(
    request.amount,
    request.refunded_prepaid_amount,
    request.returned_items,
    "",
    "amount",
    "returned_items",
    add,
    "refunded_prepaid_amount",
  );
  checkFiscalization(request.fiscalization_settings, add);
  return issues;
}

export function collectCompleteDeliveryIssues(request: DolyameCompleteDeliveryRequest): ValidationIssue[] {
  const { issues, add } = collector();
  const order = request.order;
  if (order !== undefined) {
    checkTotals(order.amount, order.prepaid_amount, order.items, "order", "amount", "items", add);
  }
  checkFiscalization(request.fiscalization_settings, add);
  return issues;
}

/** `amount + prepaid === sum(quantity * price)`, checked in integer kopecks. */
function checkTotals(
  amount: unknown,
  prepaid: unknown,
  items: unknown,
  prefix: string,
  amountKey: string,
  itemsKey: string,
  add: Add,
  prepaidKey = "prepaid_amount",
): void {
  const at = (key: string): string => (prefix === "" ? key : `${prefix}.${key}`);
  const amountKopecks = rubles(amount, at(amountKey), add, true);
  const prepaidKopecks = prepaid === undefined ? 0 : rubles(prepaid, at(prepaidKey), add, false);

  if (!Array.isArray(items) || items.length === 0) {
    add(at(itemsKey), "REQUIRED", "must be a non-empty array");
    return;
  }
  let total = 0;
  let totalIsExact = true;
  items.forEach((item: unknown, index) => {
    const path = `${at(itemsKey)}[${index}]`;
    if (!isObj(item)) {
      add(path, "INVALID_TYPE", "must be an object");
      totalIsExact = false;
      return;
    }
    if (typeof item["name"] !== "string" || item["name"].trim() === "") {
      add(`${path}.name`, "REQUIRED", "must be a non-empty string");
    }
    const quantity = item["quantity"];
    const quantityOk = typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity >= 1;
    if (!quantityOk) add(`${path}.quantity`, "OUT_OF_RANGE", "must be a whole number >= 1");
    const price = rubles(item["price"], `${path}.price`, add, true);
    if (item["sku"] !== undefined && typeof item["sku"] !== "string") {
      add(`${path}.sku`, "INVALID_TYPE", "must be a string");
    }
    if (quantityOk && price !== undefined) total += (quantity as number) * price;
    else totalIsExact = false;
  });

  if (totalIsExact && amountKopecks !== undefined && prepaidKopecks !== undefined) {
    if (amountKopecks + prepaidKopecks !== total) {
      add(
        at(amountKey),
        "SUM_MISMATCH",
        `${amountKey} (${amountKopecks / 100}) + ${prepaidKey} (${prepaidKopecks / 100}) must equal the items total (${total / 100})`,
      );
    }
  }
}

function rubles(value: unknown, path: string, add: Add, required: boolean): number | undefined {
  if (value === undefined) {
    if (required) add(path, "REQUIRED", "is required");
    return undefined;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    add(path, "INVALID_TYPE", "must be an amount in rubles");
    return undefined;
  }
  try {
    return toKopecks(value);
  } catch {
    add(path, "OUT_OF_RANGE", "must be a non-negative amount in rubles with at most 2 decimals");
    return undefined;
  }
}

function checkClientInfo(info: unknown, add: Add): void {
  if (info === undefined) return;
  if (!isObj(info)) {
    add("client_info", "INVALID_TYPE", "must be an object");
    return;
  }
  const phone = info["phone"];
  if (phone !== undefined && (typeof phone !== "string" || !/^\+\d{10,15}$/.test(phone))) {
    add("client_info.phone", "INVALID_FORMAT", "must look like +79991112233 (no spaces or dashes)");
  }
  const birthdate = info["birthdate"];
  if (birthdate !== undefined && (typeof birthdate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(birthdate))) {
    add("client_info.birthdate", "INVALID_FORMAT", "must be yyyy-MM-dd");
  }
  const email = info["email"];
  if (email !== undefined && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email))) {
    add("client_info.email", "INVALID_FORMAT", "is not a valid e-mail address");
  }
}

function checkFiscalization(settings: unknown, add: Add): void {
  if (settings === undefined) return;
  const type = isObj(settings) ? settings["type"] : undefined;
  if (type !== "enabled" && type !== "disabled") {
    add("fiscalization_settings.type", "INVALID_ENUM", 'must be "enabled" or "disabled"');
  }
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
