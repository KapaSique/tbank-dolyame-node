import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAllowedPaymentUrl, fromKopecks, isAllowedPaymentUrl, lineAmount, tbankStatusKind, toKopecks, unwrap } from "../src/index.js";

test("toKopecks converts exactly where plain float math fails", () => {
  assert.equal(19.99 * 100, 1998.9999999999998); // the trap
  assert.equal(toKopecks(19.99), 1999);
  assert.equal(toKopecks("19.99"), 1999);
  assert.equal(toKopecks("0.1"), 10);
  assert.equal(toKopecks(1234), 123400);
  assert.equal(toKopecks(0), 0);
});

test("toKopecks rejects values that are not money", () => {
  for (const bad of [-1, "1.005", 1.005, "abc", "", NaN, Infinity, 1e21, "1,5"]) {
    assert.throws(() => toKopecks(bad as number), RangeError, String(bad));
  }
});

test("fromKopecks is the inverse and rejects fractions", () => {
  assert.equal(fromKopecks(1999), 19.99);
  assert.equal(fromKopecks(5), 0.05);
  assert.throws(() => fromKopecks(10.5), RangeError);
  assert.throws(() => fromKopecks(-1), RangeError);
});

test("lineAmount rounds half up with integer arithmetic", () => {
  assert.equal(lineAmount(129900, 2), 259800);
  assert.equal(lineAmount(1, 0.5), 1); // 0.5 kopeck -> 1
  assert.equal(lineAmount(33300, 0.333), 11089);
  assert.equal(lineAmount(10, 0.1 + 0.2), 3); // float noise in the quantity is absorbed
  assert.throws(() => lineAmount(100, 0.1234567), RangeError);
  assert.throws(() => lineAmount(1.5, 1), RangeError);
});

test("unwrap returns data or throws the carried error", () => {
  assert.equal(unwrap({ ok: true, data: 7, httpStatus: 200 }), 7);
  const error = new Error("business failure");
  assert.throws(() => unwrap({ ok: false, error }), error);
});

test("tbankStatusKind groups statuses by what a merchant may do next", () => {
  assert.equal(tbankStatusKind("NEW"), "pending");
  assert.equal(tbankStatusKind("AUTHORIZED"), "authorized");
  assert.equal(tbankStatusKind("CONFIRMED"), "paid");
  assert.equal(tbankStatusKind("PARTIAL_REFUNDED"), "refunded");
  assert.equal(tbankStatusKind("REVERSED"), "canceled");
  assert.equal(tbankStatusKind("REJECTED"), "failed");
  assert.equal(tbankStatusKind("DEADLINE_EXPIRED"), "failed");
  assert.equal(tbankStatusKind("PAY_CHECKING"), "unknown");
  assert.equal(tbankStatusKind("SOMETHING_NEW"), "unknown");
});

const allowed = ["pay.example.com", "*.pay-mirror.example"];

test("payment URL guard accepts exact hosts and wildcard subdomains over https", () => {
  assert.equal(isAllowedPaymentUrl("https://pay.example.com/abc123", allowed), true);
  assert.equal(isAllowedPaymentUrl("https://PAY.example.com/abc123", allowed), true);
  assert.equal(isAllowedPaymentUrl("https://eu.pay-mirror.example/x", allowed), true);
  assert.equal(isAllowedPaymentUrl("https://a.b.pay-mirror.example/x", allowed), true);
});

test("payment URL guard rejects look-alikes, downgrades, ports and credentials", () => {
  for (const url of [
    "http://pay.example.com/abc",
    "https://pay.example.com.evil.test/abc",
    "https://evilpay.example.com/abc",
    "https://pay-mirror.example/abc", // wildcard does not cover the apex
    "https://evilpay-mirror.example/abc",
    "https://pay.example.com:8443/abc",
    "https://user:pass@pay.example.com/abc",
    "javascript:alert(1)",
    "not a url",
    "",
  ]) {
    assert.equal(isAllowedPaymentUrl(url, allowed), false, url);
  }
  assert.throws(() => assertAllowedPaymentUrl("https://other.example/x", allowed), /allow-list: other\.example/);
  assert.equal(assertAllowedPaymentUrl("https://pay.example.com/x", allowed).host, "pay.example.com");
});
