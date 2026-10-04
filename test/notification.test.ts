import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOTIFICATION_OK_RESPONSE,
  NotificationError,
  parseNotification,
  signToken,
  verifyNotification,
} from "../src/index.js";

const PASSWORD = "TEST_PASSWORD_11111";

function signedNotification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    TerminalKey: "TEST_TERMINAL_KEY",
    OrderId: "order-1001",
    Success: true,
    Status: "CONFIRMED",
    PaymentId: 123456789,
    ErrorCode: "0",
    Amount: 10000,
    CardId: 61234567,
    Pan: "220138******0013",
    ExpDate: "1230",
    Data: { Source: "shop.example" },
    ...overrides,
  };
  return { ...body, Token: signToken(body, PASSWORD) };
}

test("a correctly signed notification is accepted (Data object is excluded from the signature)", () => {
  assert.equal(verifyNotification(signedNotification(), PASSWORD), true);
});

test("tampering with any signed field is detected", () => {
  for (const [field, value] of [
    ["Amount", 1],
    ["Status", "REJECTED"],
    ["OrderId", "order-1002"],
    ["Success", false],
    ["PaymentId", 987654321],
  ] as const) {
    const body = { ...signedNotification(), [field]: value };
    assert.equal(verifyNotification(body, PASSWORD), false, `${field} change must invalidate the token`);
  }
});

test("a notification without Token, with an empty Token or with a non-string Token is rejected", () => {
  const { Token: _token, ...unsigned } = signedNotification() as Record<string, unknown>;
  assert.equal(verifyNotification(unsigned, PASSWORD), false);
  assert.equal(verifyNotification({ ...unsigned, Token: "" }, PASSWORD), false);
  assert.equal(verifyNotification({ ...unsigned, Token: 42 }, PASSWORD), false);
});

test("a wrong password and non-object inputs are rejected", () => {
  assert.equal(verifyNotification(signedNotification(), "other-password"), false);
  assert.equal(verifyNotification(null, PASSWORD), false);
  assert.equal(verifyNotification("{}", PASSWORD), false);
  assert.equal(verifyNotification([], PASSWORD), false);
});

test("a parameter the bank adds later is part of the signature and cannot be smuggled in", () => {
  const original = signedNotification();
  assert.equal(verifyNotification({ ...original, NewBankField: "x" }, PASSWORD), false);
  assert.equal(verifyNotification(signedNotification({ NewBankField: "x" }), PASSWORD), true);
});

test("parseNotification parses string and Buffer bodies and returns the typed payload", () => {
  const raw = JSON.stringify(signedNotification());
  const fromString = parseNotification(raw, PASSWORD);
  const fromBuffer = parseNotification(Buffer.from(raw, "utf8"), PASSWORD);
  assert.equal(fromString.Status, "CONFIRMED");
  assert.equal(fromBuffer.OrderId, "order-1001");
});

test("parseNotification reports why it refused a body", () => {
  const reasonOf = (input: string | object, password = PASSWORD): string | undefined => {
    try {
      parseNotification(input, password);
      return undefined;
    } catch (error) {
      assert.ok(error instanceof NotificationError);
      return error.reason;
    }
  };
  assert.equal(reasonOf("{not json"), "invalid_json");
  assert.equal(reasonOf("[1,2]"), "not_an_object");
  const { Token: _token, ...unsigned } = signedNotification() as Record<string, unknown>;
  assert.equal(reasonOf(unsigned), "missing_token");
  assert.equal(reasonOf(signedNotification(), "wrong"), "invalid_token");
  assert.equal(reasonOf({ ...signedNotification(), Amount: 5 }), "invalid_token");
});

test("the acknowledgement is exactly OK", () => {
  assert.equal(NOTIFICATION_OK_RESPONSE, "OK");
});
