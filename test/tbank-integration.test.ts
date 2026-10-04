import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  TbankClient,
  TransportError,
  buildReceipt,
  tbankStatusKind,
  unwrap,
  type TbankNotification,
} from "../src/index.js";
import { createExpressApp } from "../examples/express-webhook.js";
import { createWebhookServer } from "../examples/node-http-webhook.js";
import { createFakeBank, type FakeBank } from "./fake-bank.js";
import { listen, noSleep, type RunningServer } from "./helpers.js";

const TERMINAL = "TEST_TERMINAL_KEY";
const PASSWORD = "TEST_PASSWORD";

let bank: FakeBank;
let bankServer: RunningServer;
let client: TbankClient;

before(async () => {
  bank = createFakeBank(TERMINAL, PASSWORD);
  bankServer = await listen(bank.server);
  client = new TbankClient({ terminalKey: TERMINAL, password: PASSWORD, baseUrl: bankServer.url, retry: noSleep, timeoutMs: 2000 });
});

after(async () => {
  await bankServer.close();
});

const receiptFor = (amount: number) =>
  buildReceipt({
    ffd: "1.05",
    taxation: "usn_income",
    email: "buyer@shop.example",
    items: [{ name: "Hoodie", price: amount, quantity: 1, tax: "none" }],
    expectedAmount: amount,
  });

test("two-stage flow over real HTTP: init -> pay (hold) -> confirm -> partial refund", async () => {
  const init = unwrap(
    await client.init({ Amount: 500000, OrderId: "two-stage-1", PayType: "T", Receipt: receiptFor(500000) }),
  );
  assert.equal(init.Status, "NEW");
  assert.match(init.PaymentURL ?? "", /^https:\/\/pay\.example\.com\//);

  bank.pay(init.PaymentId);
  const held = unwrap(await client.getState({ PaymentId: init.PaymentId }));
  assert.equal(held.Status, "AUTHORIZED");
  assert.equal(tbankStatusKind(held.Status), "authorized");

  const confirmed = unwrap(await client.confirm({ PaymentId: init.PaymentId }));
  assert.equal(confirmed.Status, "CONFIRMED");
  assert.equal(tbankStatusKind(confirmed.Status), "paid");

  const refund = unwrap(await client.cancel({ PaymentId: init.PaymentId, Amount: 120000, ExternalRequestId: "refund-1" }));
  assert.equal(refund.Status, "PARTIAL_REFUNDED");
  assert.equal(refund.OriginalAmount, 500000);
  assert.equal(refund.NewAmount, 380000);

  assert.ok(bank.calls.every((call) => call.tokenValid), "the bank verified every Token");
});

test("one-stage flow: pay -> CONFIRMED immediately -> full refund", async () => {
  const init = unwrap(await client.init({ Amount: 150000, OrderId: "one-stage-1", PayType: "O" }));
  bank.pay(init.PaymentId);
  assert.equal(unwrap(await client.getState({ PaymentId: init.PaymentId })).Status, "CONFIRMED");
  const refunded = unwrap(await client.cancel({ PaymentId: init.PaymentId }));
  assert.equal(refunded.Status, "REFUNDED");
});

test("releasing a hold and cancelling an unpaid payment", async () => {
  const held = unwrap(await client.init({ Amount: 90000, OrderId: "hold-1", PayType: "T" }));
  bank.pay(held.PaymentId);
  assert.equal(unwrap(await client.cancel({ PaymentId: held.PaymentId })).Status, "REVERSED");

  const unpaid = unwrap(await client.init({ Amount: 90000, OrderId: "unpaid-1", PayType: "T" }));
  assert.equal(unwrap(await client.cancel({ PaymentId: unpaid.PaymentId })).Status, "CANCELED");
});

test("business refusals come back as typed failures, not as thrown HTTP errors", async () => {
  const init = unwrap(await client.init({ Amount: 10000, OrderId: "refusal-1", PayType: "T" }));
  const tooEarly = await client.confirm({ PaymentId: init.PaymentId }); // still NEW, not AUTHORIZED
  assert.ok(!tooEarly.ok);
  assert.equal(tooEarly.error.errorCode, "4");
  assert.equal(tooEarly.error.httpStatus, 200);

  const unknown = await client.getState({ PaymentId: "000" });
  assert.ok(!unknown.ok);
  assert.equal(unknown.error.errorCode, "8");
});

test("a wrong password is rejected by the bank's token check", async () => {
  const wrong = new TbankClient({ terminalKey: TERMINAL, password: "WRONG", baseUrl: bankServer.url, retry: noSleep });
  const result = await wrong.init({ Amount: 10000, OrderId: "wrong-pass-1" });
  assert.ok(!result.ok);
  assert.equal(result.error.bankMessage, "Wrong token");
  assert.equal(bank.calls.at(-1)?.tokenValid, false);
});

test("GetState survives a transient 500 over real HTTP; Init does not retry", async () => {
  const init = unwrap(await client.init({ Amount: 10000, OrderId: "retry-1", PayType: "T" }));

  const before = bank.calls.length;
  bank.failNext("/v2/GetState", 2);
  const state = unwrap(await client.getState({ PaymentId: init.PaymentId }));
  assert.equal(state.Status, "NEW");
  assert.equal(bank.calls.length - before, 3);

  const beforeInit = bank.calls.length;
  bank.failNext("/v2/Init", 1);
  const failed = await client.init({ Amount: 10000, OrderId: "retry-2" });
  assert.ok(!failed.ok);
  assert.equal(failed.error.httpStatus, 500);
  assert.equal(bank.calls.length - beforeInit, 1);
});

test("a stalled server hits the timeout and the error says the outcome is unknown", async () => {
  bank.stall("/v2/Confirm");
  await assert.rejects(client.confirm({ PaymentId: "1" }, { timeoutMs: 100 }), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.kind, "timeout");
    assert.equal(error.outcomeUnknown, true);
    return true;
  });
});

test("a refused connection is a network error that never reached the server", async () => {
  const dead = await listen((await import("node:http")).createServer());
  const url = dead.url;
  await dead.close();
  const offline = new TbankClient({ terminalKey: TERMINAL, password: PASSWORD, baseUrl: url, retry: noSleep, timeoutMs: 500 });
  await assert.rejects(offline.init({ Amount: 10000, OrderId: "offline-1" }), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.kind, "network");
    assert.equal(error.code, "ECONNREFUSED");
    assert.equal(error.outcomeUnknown, false);
    return true;
  });
});

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}

for (const flavour of ["node:http", "express"] as const) {
  test(`webhook example (${flavour}): answers exactly OK for a valid notification and rejects tampering`, async () => {
    const init = unwrap(await client.init({ Amount: 77000, OrderId: `hook-${flavour}`, PayType: "O" }));
    bank.pay(init.PaymentId);

    const received: TbankNotification[] = [];
    const options = { password: PASSWORD, onNotification: (n: TbankNotification) => void received.push(n) };
    const hook =
      flavour === "node:http"
        ? await listen(createWebhookServer(options))
        : await listen((await import("node:http")).createServer(createExpressApp(options)));
    try {
      const url = `${hook.url}/webhooks/tbank`;
      const good = bank.notification(init.PaymentId, { Data: { Source: "shop.example" } });

      const ok = await postJson(url, good);
      assert.equal(ok.status, 200);
      assert.equal(ok.text, "OK");
      assert.equal(received.length, 1);
      assert.equal(received[0]?.Status, "CONFIRMED");
      assert.equal(received[0]?.OrderId, `hook-${flavour}`);

      const tampered = await postJson(url, { ...good, Amount: 1 });
      assert.equal(tampered.status, 400);
      assert.notEqual(tampered.text, "OK");

      const { Token: _token, ...unsigned } = good;
      assert.equal((await postJson(url, unsigned)).status, 400);
      assert.equal((await postJson(url, [1, 2, 3])).status, 400);
      assert.equal(received.length, 1, "nothing but the valid notification reached the handler");
    } finally {
      await hook.close();
    }
  });
}
