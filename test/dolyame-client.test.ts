import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOLYAME_BASE_URL,
  DolyameClient,
  DolyameError,
  ProtocolError,
  TransportError,
  ValidationError,
  unwrap,
  type DolyameClientOptions,
  type DolyameCreateRequest,
} from "../src/index.js";
import { fakeTransport, jsonResponse, noSleep } from "./helpers.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const orderInfo = {
  status: "approved",
  amount: 2000,
  residual_amount: 1500,
  link: "https://dolyame.example/pay/abc",
};

function make(script: Parameters<typeof fakeTransport>[0], extra: Partial<DolyameClientOptions> = {}) {
  const fake = fakeTransport(script);
  const dolyame = new DolyameClient({ login: "test-login", password: "test-password", transport: fake.transport, retry: noSleep, ...extra });
  return { ...fake, dolyame };
}

const createRequest = (overrides: Partial<DolyameCreateRequest["order"]> = {}): DolyameCreateRequest => ({
  order: {
    id: "shop_1001",
    amount: 2000,
    prepaid_amount: 200,
    items: [{ name: "T-shirt", quantity: 2, price: 1100, sku: "TS-01" }],
    ...overrides,
  },
  client_info: { first_name: "Ivan", phone: "+79991112233", email: "buyer@shop.example" },
  notification_url: "https://shop.example/webhooks/dolyame",
  success_url: "https://shop.example/paid",
  fail_url: "https://shop.example/failed",
});

test("create sends Basic auth, a UUID v4 X-Correlation-ID and the order as JSON", async () => {
  const { dolyame, requests } = make([jsonResponse(orderInfo)]);
  const result = await dolyame.create(createRequest());

  const sent = requests[0];
  assert.ok(sent);
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, `${DOLYAME_BASE_URL}/v1/orders/create`);
  assert.equal(sent.headers["authorization"], `Basic ${Buffer.from("test-login:test-password").toString("base64")}`);
  assert.match(sent.headers["x-correlation-id"] ?? "", UUID_V4);
  assert.equal(sent.headers["content-type"], "application/json");
  assert.deepEqual(sent.json, createRequest() as unknown as Record<string, unknown>);

  assert.ok(result.ok);
  assert.equal(result.data.link, "https://dolyame.example/pay/abc");
  assert.equal(result.correlationId, sent.headers["x-correlation-id"]);
});

test("every call gets a fresh correlation id unless you supply your own UUID v4", async () => {
  const { dolyame, requests } = make([jsonResponse(orderInfo)]);
  await dolyame.info("shop_1001");
  await dolyame.info("shop_1001");
  assert.notEqual(requests[0]?.headers["x-correlation-id"], requests[1]?.headers["x-correlation-id"]);

  const mine = "6f1f5f0e-7a1c-4c53-9a54-0f3c8e3d9b21";
  const custom = await dolyame.info("shop_1001", { correlationId: mine });
  assert.equal(requests[2]?.headers["x-correlation-id"], mine);
  assert.ok(custom.ok && custom.correlationId === mine);

  await assert.rejects(dolyame.info("shop_1001", { correlationId: "not-a-uuid" }), ValidationError);
});

test("info is a GET without a body and URL-encodes the order id", async () => {
  const { dolyame, requests } = make([jsonResponse(orderInfo)]);
  await dolyame.info("shop 1/2");
  const sent = requests[0];
  assert.equal(sent?.method, "GET");
  assert.equal(sent?.url, `${DOLYAME_BASE_URL}/v1/orders/shop%201%2F2/info`);
  assert.equal(sent?.body, undefined);
  assert.equal(sent?.headers["content-type"], undefined);
});

test("commit, cancel, refund and completeDelivery hit the documented endpoints", async () => {
  const { dolyame, requests } = make([jsonResponse({ ...orderInfo, status: "committed" })]);
  const items = [{ name: "T-shirt", quantity: 2, price: 1100 }];
  unwrap(await dolyame.commit("o1", { amount: 2000, prepaid_amount: 200, items }));
  unwrap(await dolyame.cancel("o1"));
  unwrap(await dolyame.refund("o1", { amount: 1000, refunded_prepaid_amount: 100, returned_items: [{ name: "T-shirt", quantity: 1, price: 1100 }] }));
  unwrap(await dolyame.completeDelivery("o1", { order: { amount: 2000, prepaid_amount: 200, items } }));
  unwrap(await dolyame.completeDelivery("o1"));

  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.url.slice(DOLYAME_BASE_URL.length)}`),
    [
      "POST /v1/orders/o1/commit",
      "POST /v1/orders/o1/cancel",
      "POST /v1/orders/o1/refund",
      "POST /v1/orders/o1/complete_delivery",
      "POST /v1/orders/o1/complete_delivery",
    ],
  );
  assert.equal(requests[1]?.body, undefined, "cancel has no body");
  assert.equal(requests[2]?.json?.["refunded_prepaid_amount"], 100);
});

test("an HTTP 422 business error is a typed failure with the documented fields", async () => {
  const { dolyame } = make([
    jsonResponse(
      {
        code: "UNPROCESSABLE_ENTITY",
        errorDetailCode: "NOT_ENOUGH_MONEY",
        message: "Not enough money",
        correlationId: "11111111-1111-4111-8111-111111111111",
        details: { reason: "limit" },
        operationDetails: ["step-1"],
      },
      422,
    ),
  ]);
  const result = await dolyame.create(createRequest());
  assert.ok(!result.ok);
  const { error } = result;
  assert.ok(error instanceof DolyameError);
  assert.equal(error.httpStatus, 422);
  assert.equal(error.code, "UNPROCESSABLE_ENTITY");
  assert.equal(error.errorDetailCode, "NOT_ENOUGH_MONEY");
  assert.equal(error.bankMessage, "Not enough money");
  assert.equal(error.correlationId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(error.details, { reason: "limit" });
  assert.deepEqual(error.operationDetails, ["step-1"]);
  assert.throws(() => unwrap(result), DolyameError);
});

test("an error body without a correlationId falls back to the id we sent", async () => {
  const { dolyame, requests } = make([jsonResponse({ code: "NOT_FOUND", message: "No such order" }, 404)]);
  const result = await dolyame.info("missing");
  assert.ok(!result.ok);
  assert.equal(result.error.code, "NOT_FOUND");
  assert.equal(result.error.correlationId, requests[0]?.headers["x-correlation-id"]);
});

test("HTTP 429 exposes Retry-After; non-idempotent calls are not retried", async () => {
  const { dolyame, requests } = make([jsonResponse({ code: "TOO_MANY_REQUESTS", message: "slow down" }, 429, { "retry-after": "30" }), jsonResponse(orderInfo)]);
  const result = await dolyame.create(createRequest());
  assert.ok(!result.ok);
  assert.equal(result.error.retryAfterSeconds, 30);
  assert.equal(requests.length, 1);
});

test("info is retried on 5xx and network errors; create/commit/cancel/refund/complete are single attempts", async () => {
  const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  const unavailable = jsonResponse({ code: "INTERNAL_ERROR", message: "boom" }, 503);

  const reading = make([unavailable, reset, jsonResponse(orderInfo)]);
  const read = await reading.dolyame.info("o1");
  assert.ok(read.ok);
  assert.equal(reading.requests.length, 3);

  const writes: Array<(d: DolyameClient) => Promise<unknown>> = [
    (d) => d.create(createRequest()),
    (d) => d.commit("o1", { amount: 2000, prepaid_amount: 200, items: [{ name: "T-shirt", quantity: 2, price: 1100 }] }),
    (d) => d.cancel("o1"),
    (d) => d.refund("o1", { amount: 1100, returned_items: [{ name: "T-shirt", quantity: 1, price: 1100 }] }),
    (d) => d.completeDelivery("o1"),
  ];
  for (const write of writes) {
    const single = make([unavailable, jsonResponse(orderInfo)]);
    const outcome = (await write(single.dolyame)) as { ok: boolean };
    assert.equal(outcome.ok, false);
    assert.equal(single.requests.length, 1);
  }

  const lost = make([reset, jsonResponse(orderInfo)]);
  await assert.rejects(lost.dolyame.create(createRequest()), (error: unknown) => error instanceof TransportError && error.outcomeUnknown);
  assert.equal(lost.requests.length, 1);
});

test("the HTML 400 the host returns without a client certificate is a ProtocolError with a hint", async () => {
  const nginx = {
    status: 400,
    headers: { "content-type": "text/html" },
    body: "<html><head><title>400 No required SSL certificate was sent</title></head><body>nginx</body></html>",
  };
  const { dolyame } = make([nginx]);
  await assert.rejects(dolyame.info("o1"), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.httpStatus, 400);
    assert.match(error.message, /mTLS client certificate/);
    assert.match(error.bodySnippet, /No required SSL certificate/);
    return true;
  });
});

test("a 2xx answer without a status is a ProtocolError", async () => {
  await assert.rejects(make([jsonResponse({ hello: "world" })]).dolyame.info("o1"), ProtocolError);
});

test("create validates the order locally: ids, totals, items and contact data", async () => {
  const { dolyame, requests } = make([jsonResponse(orderInfo)]);
  const paths = async (request: DolyameCreateRequest): Promise<string[]> => {
    try {
      await dolyame.create(request);
      return [];
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      return error.issues.map((i) => `${i.path}:${i.code}`);
    }
  };

  assert.deepEqual(await paths(createRequest({ id: "x".repeat(31) })), ["order.id:TOO_LONG"]);
  assert.deepEqual(await paths(createRequest({ amount: 2001 })), ["order.amount:SUM_MISMATCH"]);
  assert.deepEqual(await paths(createRequest({ prepaid_amount: 0 })), ["order.amount:SUM_MISMATCH"]);
  assert.deepEqual(await paths(createRequest({ items: [] })), ["order.items:REQUIRED"]);
  assert.deepEqual(await paths(createRequest({ items: [{ name: "x", quantity: 0, price: 1 }] })), ["order.items[0].quantity:OUT_OF_RANGE"]);
  assert.deepEqual(await paths(createRequest({ items: [{ name: "x", quantity: 1, price: 1.005 }] })), ["order.items[0].price:OUT_OF_RANGE"]);
  assert.deepEqual(await paths({ ...createRequest(), client_info: { phone: "8 999 111-22-33" } }), ["client_info.phone:INVALID_FORMAT"]);
  assert.deepEqual(await paths({ ...createRequest(), success_url: "/relative" }), ["success_url:INVALID_FORMAT"]);
  assert.equal(requests.length, 0);
});

test("totals are checked in kopecks, so float-unfriendly prices are accepted", async () => {
  const { dolyame } = make([jsonResponse(orderInfo)]);
  // 3 * 19.99 === 59.97 only in exact arithmetic (JS gives 59.96999999999999)
  const result = await dolyame.create(createRequest({ amount: 59.97, prepaid_amount: 0, items: [{ name: "Sticker", quantity: 3, price: 19.99 }] }));
  assert.ok(result.ok);
});

test("commit and refund totals follow the documented formulas", async () => {
  const { dolyame, requests } = make([jsonResponse(orderInfo)]);
  const items = [{ name: "T-shirt", quantity: 2, price: 1100 }];
  await assert.rejects(dolyame.commit("o1", { amount: 2000, items }), ValidationError); // 2000 + 0 != 2200
  await assert.rejects(dolyame.refund("o1", { amount: 1100, refunded_prepaid_amount: 100, returned_items: [{ name: "T-shirt", quantity: 1, price: 1100 }] }), ValidationError);
  assert.equal(requests.length, 0);
  // Documented example: refund of 1 shirt = 1000 through Dolyame + 100 prepaid.
  unwrap(await dolyame.refund("o1", { amount: 1000, refunded_prepaid_amount: 100, returned_items: [{ name: "T-shirt", quantity: 1, price: 1100 }] }));
});

test("validation can be disabled", async () => {
  const { dolyame, requests } = make([jsonResponse(orderInfo)], { validate: false });
  await dolyame.create(createRequest({ amount: 1 }));
  assert.equal(requests.length, 1);
});

test("construction requires mTLS material (or an explicit transport) and a sane login", () => {
  assert.throws(() => new DolyameClient({ login: "l", password: "p" }), /mTLS is mandatory/);
  assert.throws(() => new DolyameClient({ login: "a:b", password: "p", transport: async () => jsonResponse({}) }), /':'/);
  assert.throws(() => new DolyameClient({ login: "", password: "p", transport: async () => jsonResponse({}) }), TypeError);
});

test("the base URL is configurable", async () => {
  const { dolyame, requests } = make([jsonResponse(orderInfo)], { baseUrl: "https://dolyame-stub.example.test/" });
  await dolyame.info("o1");
  assert.equal(requests[0]?.url, "https://dolyame-stub.example.test/v1/orders/o1/info");
});
