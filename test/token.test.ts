import assert from "node:assert/strict";
import { test } from "node:test";
import { signToken, tokenInput, verifyToken } from "../src/index.js";

// Vector from the official "Токен" page: https://developer.tbank.ru/eacq/intro/developer/token
const DOC_PASSWORD = "11111111111111";
const DOC_INIT = {
  TerminalKey: "MerchantTerminalKey",
  Amount: 19200,
  OrderId: "00000",
  Description: "Подарочная карта на 1000 рублей",
};
const DOC_INIT_TOKEN = "72dd466f8ace0a37a1f740ce5fb78101712bc0665d91a8108c7c8a0ccd426db2";

test("Init token matches the vector published in the documentation", () => {
  assert.equal(
    tokenInput({ ...DOC_INIT, Password: DOC_PASSWORD }),
    "19200Подарочная карта на 1000 рублей0000011111111111111MerchantTerminalKey",
  );
  assert.equal(signToken(DOC_INIT, DOC_PASSWORD), DOC_INIT_TOKEN);
});

test("nested objects (Receipt, DATA) and an existing Token do not take part in the signature", () => {
  const withNested = {
    ...DOC_INIT,
    DATA: { Phone: "+71234567890", Email: "buyer@shop.example" },
    Receipt: {
      Email: "buyer@shop.example",
      Taxation: "osn",
      Items: [{ Name: "Наименование товара 1", Price: 10000, Quantity: 1, Amount: 10000, Tax: "vat10" }],
    },
    Token: "stale-token",
  };
  assert.equal(signToken(withNested, DOC_PASSWORD), DOC_INIT_TOKEN);
});

test("notification token matches the vector from the documentation (booleans become 'true')", () => {
  const notification = {
    TerminalKey: "1234567890DEMO",
    OrderId: "000000",
    Success: true,
    Status: "AUTHORIZED",
    PaymentId: "0000000",
    ErrorCode: "0",
    Amount: "1111",
    CardId: "000000",
    Pan: "200000******0000",
    ExpDate: "1111",
    RebillId: "000000",
  };
  assert.equal(
    tokenInput({ ...notification, Password: "11111111111" }),
    "111100000001111000000200000******0000111111111110000000000000AUTHORIZEDtrue1234567890DEMO",
  );
  assert.equal(
    signToken(notification, "11111111111"),
    "1c0964277d0213349243065a0d5b838b8e90d2d25f740d0f2767836e710e80c8",
  );
});

test("numbers and strings sign identically (JSON delivers PaymentId as a number)", () => {
  assert.equal(signToken({ PaymentId: 123456789, Amount: 10000 }, "p"), signToken({ PaymentId: "123456789", Amount: "10000" }, "p"));
});

test("null and undefined values are skipped", () => {
  assert.equal(signToken({ A: "1", B: null, C: undefined }, "p"), signToken({ A: "1" }, "p"));
});

test("keys are ordered by code unit, not by locale", () => {
  // 'T' (84) sorts before 'm' (109) by code unit; localeCompare would put "PaymentId" first.
  assert.equal(tokenInput({ PaymentId: "1", PayType: "2" }), "21");
});

test("verifyToken accepts the right token in any letter case and rejects everything else", () => {
  const signed = { ...DOC_INIT, Token: DOC_INIT_TOKEN };
  assert.equal(verifyToken(signed, DOC_PASSWORD), true);
  assert.equal(verifyToken({ ...signed, Token: DOC_INIT_TOKEN.toUpperCase() }, DOC_PASSWORD), true);
  assert.equal(verifyToken({ ...signed, Amount: 19201 }, DOC_PASSWORD), false);
  assert.equal(verifyToken(signed, "wrong-password"), false);
  assert.equal(verifyToken({ ...DOC_INIT }, DOC_PASSWORD), false);
  assert.equal(verifyToken({ ...DOC_INIT, Token: "" }, DOC_PASSWORD), false);
  assert.equal(verifyToken({ ...DOC_INIT, Token: 123 }, DOC_PASSWORD), false);
});
