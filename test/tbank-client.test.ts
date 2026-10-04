import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProtocolError,
  TBANK_PRODUCTION_URL,
  TBANK_TEST_URL,
  TbankClient,
  TbankError,
  TransportError,
  ValidationError,
  buildReceipt,
  signToken,
  unwrap,
  verifyToken,
  type InitRequest,
  type TbankClientOptions,
} from "../src/index.js";
import { fakeTransport, hangingTransport, jsonResponse, noSleep } from "./helpers.js";

const PASSWORD = "TEST_PASSWORD";
const common = { terminalKey: "TEST_TERMINAL_KEY", password: PASSWORD, retry: noSleep };

function client(script: Parameters<typeof fakeTransport>[0], extra: Partial<TbankClientOptions> = {}) {
  const fake = fakeTransport(script);
  return { ...fake, tbank: new TbankClient({ ...common, transport: fake.transport, ...extra }) };
}

const initRequest = (overrides: Partial<InitRequest> = {}): InitRequest => ({
  Amount: 289800,
  OrderId: "order-1001",
  Description: "Order 1001",
  PayType: "T",
  NotificationURL: "https://shop.example/webhooks/tbank",
  SuccessURL: "https://shop.example/paid",
  FailURL: "https://shop.example/failed",
  DATA: { Source: "shop.example" },
  Receipt: buildReceipt({
    ffd: "1.05",
    taxation: "usn_income",
    email: "buyer@shop.example",
    items: [
      { name: "T-shirt", price: 129900, quantity: 2, tax: "none" },
      { name: "Delivery", price: 30000, quantity: 1, tax: "none", paymentObject: "service" },
    ],
    expectedAmount: 289800,
  }),
  ...overrides,
});

const initOk = {
  Success: true,
  ErrorCode: "0",
  TerminalKey: "TEST_TERMINAL_KEY",
  Status: "NEW",
  PaymentId: "6001001001",
  OrderId: "order-1001",
  Amount: 289800,
  PaymentURL: "https://pay.example.com/Xy12",
};

test("init builds a signed JSON POST to /v2/Init with the documented fields", async () => {
  const { tbank, requests } = client([jsonResponse(initOk)]);
  const result = await tbank.init(initRequest());

  assert.equal(requests.length, 1);
  const sent = requests[0];
  assert.ok(sent?.json);
  assert.equal(sent.url, `${TBANK_PRODUCTION_URL}/v2/Init`);
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.json["TerminalKey"], "TEST_TERMINAL_KEY");
  assert.equal(sent.json["Amount"], 289800);
  assert.equal(sent.json["OrderId"], "order-1001");
  assert.equal(sent.json["PayType"], "T");
  assert.equal((sent.json["Receipt"] as { Items: unknown[] }).Items.length, 2);
  assert.deepEqual(sent.json["DATA"], { Source: "shop.example" });
  // The Token is the SHA-256 over root scalars + Password; the password itself is never sent.
  assert.equal(verifyToken(sent.json, PASSWORD), true);
  assert.equal(JSON.stringify(sent.json).includes(PASSWORD), false);

  assert.ok(result.ok);
  assert.equal(result.data.PaymentURL, "https://pay.example.com/Xy12");
  assert.equal(result.data.Status, "NEW");
});

test("the base URL accepts a /v2 suffix and the documented test host", async () => {
  const withSuffix = client([jsonResponse(initOk)], { baseUrl: `${TBANK_TEST_URL}/v2/` });
  await withSuffix.tbank.init(initRequest());
  assert.equal(withSuffix.requests[0]?.url, "https://rest-api-test.tinkoff.ru/v2/Init");

  const custom = client([jsonResponse({ ...initOk, Status: "NEW" })], { baseUrl: "https://acq.example.test" });
  await custom.tbank.getState({ PaymentId: 6001001001 });
  assert.equal(custom.requests[0]?.url, "https://acq.example.test/v2/GetState");
});

test("PaymentId delivered as a number is normalised to a string", async () => {
  const { tbank } = client([jsonResponse({ ...initOk, PaymentId: 6001001001 })]);
  const result = await tbank.init(initRequest());
  assert.ok(result.ok);
  assert.equal(result.data.PaymentId, "6001001001");
});

test("HTTP 200 with Success=false is a typed failure carrying ErrorCode, Message and Details", async () => {
  const { tbank } = client([
    jsonResponse({ Success: false, ErrorCode: "20", Message: "Order id already used", Details: "OrderId order-1001", TerminalKey: "TEST_TERMINAL_KEY" }),
  ]);
  const result = await tbank.init(initRequest());
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.error instanceof TbankError);
  assert.equal(result.error.errorCode, "20");
  assert.equal(result.error.bankMessage, "Order id already used");
  assert.equal(result.error.details, "OrderId order-1001");
  assert.equal(result.error.httpStatus, 200);
  assert.throws(() => unwrap(result), TbankError);
});

test("Success=true with a non-zero ErrorCode is not treated as success", async () => {
  const { tbank } = client([jsonResponse({ ...initOk, ErrorCode: "7" })]);
  const result = await tbank.init(initRequest());
  assert.ok(!result.ok);
  assert.equal(result.error.errorCode, "7");
});

test("an HTTP 5xx error body becomes a failure result with Causes as details", async () => {
  const { tbank, requests } = client([jsonResponse({ Success: false, ErrorCode: "9999", Message: "Internal error", Causes: ["db down", "retry later"] }, 500)]);
  const result = await tbank.init(initRequest());
  assert.ok(!result.ok);
  assert.equal(result.error.httpStatus, 500);
  assert.equal(result.error.details, "db down; retry later");
  assert.equal(requests.length, 1, "Init must not be retried automatically");
});

test("an HTML or empty answer is a ProtocolError, not a silent failure", async () => {
  const html = { status: 502, headers: {}, body: "<html>Bad gateway</html>" };
  await assert.rejects(client([html]).tbank.init(initRequest()), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.httpStatus, 502);
    assert.match(error.bodySnippet, /Bad gateway/);
    return true;
  });
  await assert.rejects(client([jsonResponse(["a"])]).tbank.init(initRequest()), ProtocolError);
  await assert.rejects(client([jsonResponse({ unrelated: true }, 404)]).tbank.init(initRequest()), ProtocolError);
});

test("invalid requests are rejected before anything is sent", async () => {
  const { tbank, requests } = client([jsonResponse(initOk)]);
  const rejected = async (request: InitRequest): Promise<string[]> => {
    try {
      await tbank.init(request);
      return [];
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      return error.issues.map((issue) => issue.path);
    }
  };
  assert.deepEqual(await rejected(initRequest({ Amount: 289801 })), ["Items"], "receipt total != Amount");
  assert.deepEqual(await rejected(initRequest({ Amount: 0, Receipt: undefined })), ["Amount"]);
  assert.deepEqual(await rejected(initRequest({ OrderId: "x".repeat(51) })), ["OrderId"]);
  assert.deepEqual(await rejected(initRequest({ NotificationURL: "ftp://x" })), ["NotificationURL"]);
  assert.deepEqual(await rejected(initRequest({ RedirectDueDate: "2026-10-04T12:28:00Z" })), ["RedirectDueDate"]);
  assert.deepEqual(await rejected(initRequest({ DATA: { k: "v".repeat(101) } })), ["DATA.k"]);
  assert.equal(requests.length, 0);
});

test("validation can be switched off for requests the library does not model", async () => {
  const { tbank, requests } = client([jsonResponse(initOk)], { validate: false });
  await tbank.init(initRequest({ Amount: 289801 }));
  assert.equal(requests.length, 1);
});

test("validation errors surface as promise rejections, not synchronous throws", async () => {
  const { tbank } = client([jsonResponse(initOk)]);
  const promise = tbank.init(initRequest({ Amount: -5 }));
  assert.ok(promise instanceof Promise);
  await assert.rejects(promise, ValidationError);
});

test("getState sends PaymentId as a string and retries transient failures", async () => {
  const stateOk = { ...initOk, Status: "CONFIRMED" };
  const { tbank, requests } = client([
    jsonResponse({ Success: false, ErrorCode: "9999", Message: "Internal" }, 500),
    Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    jsonResponse(stateOk),
  ]);
  const result = await tbank.getState({ PaymentId: 6001001001 });
  assert.ok(result.ok);
  assert.equal(result.data.Status, "CONFIRMED");
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.json?.["PaymentId"], "6001001001");
  assert.equal(verifyToken(requests[2]?.json ?? {}, PASSWORD), true);
});

test("a lost Init response is reported as outcome-unknown and never repeated", async () => {
  const { tbank, requests } = client([Object.assign(new Error("reset"), { code: "ECONNRESET" })]);
  await assert.rejects(tbank.init(initRequest()), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.outcomeUnknown, true);
    return true;
  });
  assert.equal(requests.length, 1);
});

test("confirm is a single attempt; cancel is retried only with an ExternalRequestId", async () => {
  const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  const cancelOk = { Success: true, ErrorCode: "0", TerminalKey: "TEST_TERMINAL_KEY", Status: "REFUNDED", PaymentId: "6001001001", OrderId: "order-1001", OriginalAmount: 289800, NewAmount: 0 };

  const confirm = client([reset, jsonResponse({ Success: true, ErrorCode: "0", Status: "CONFIRMED", PaymentId: "1", OrderId: "o", TerminalKey: "t" })]);
  await assert.rejects(confirm.tbank.confirm({ PaymentId: "6001001001" }), TransportError);
  assert.equal(confirm.requests.length, 1);

  const bare = client([reset, jsonResponse(cancelOk)]);
  await assert.rejects(bare.tbank.cancel({ PaymentId: "6001001001" }), TransportError);
  assert.equal(bare.requests.length, 1);

  const keyed = client([reset, jsonResponse(cancelOk)]);
  const result = await keyed.tbank.cancel({ PaymentId: "6001001001", ExternalRequestId: "refund-7f3a" });
  assert.ok(result.ok);
  assert.equal(result.data.NewAmount, 0);
  assert.equal(keyed.requests.length, 2);
  assert.equal(keyed.requests[1]?.json?.["ExternalRequestId"], "refund-7f3a");
  assert.equal(verifyToken(keyed.requests[1]?.json ?? {}, PASSWORD), true);
});

test("confirm and cancel validate amounts and receipts they carry", async () => {
  const { tbank, requests } = client([jsonResponse({})]);
  await assert.rejects(tbank.confirm({ PaymentId: "1", Amount: 0 }), ValidationError);
  const receipt = buildReceipt({ ffd: "1.05", taxation: "osn", email: "buyer@shop.example", items: [{ name: "A", price: 5000, quantity: 1, tax: "none" }] });
  await assert.rejects(tbank.cancel({ PaymentId: "1", Amount: 4000, Receipt: receipt }), ValidationError);
  assert.equal(requests.length, 0);
});

test("checkOrder accepts the string Success the method documents", async () => {
  const { tbank } = client([
    jsonResponse({ Success: "true", ErrorCode: "0", TerminalKey: "TEST_TERMINAL_KEY", OrderId: "order-1001", Payments: [{ PaymentId: "6001001001", Status: "NEW", Success: "true" }] }),
  ]);
  const result = await tbank.checkOrder({ OrderId: "order-1001" });
  assert.ok(result.ok);
  assert.equal(result.data.Payments[0]?.PaymentId, "6001001001");
});

test("per-call and client timeouts abort the request", async () => {
  const slow = new TbankClient({ ...common, transport: hangingTransport, timeoutMs: 5000 });
  await assert.rejects(slow.init(initRequest(), { timeoutMs: 15 }), (error: unknown) => error instanceof TransportError && error.kind === "timeout");
});

test("the token over the real request body equals the independently computed one", async () => {
  const { tbank, requests } = client([jsonResponse(initOk)]);
  await tbank.init(initRequest());
  const body = requests[0]?.json ?? {};
  const { Token, Receipt: _receipt, DATA: _data, ...rootFields } = body;
  assert.equal(Token, signToken(rootFields, PASSWORD));
});

test("the constructor refuses missing credentials", () => {
  assert.throws(() => new TbankClient({ terminalKey: "", password: "x" }), TypeError);
  assert.throws(() => new TbankClient({ terminalKey: "t", password: "" }), TypeError);
});
