import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOLYAME_WEBHOOK_IP_RANGES,
  DolyameError,
  WebhookError,
  confirmDolyameWebhook,
  ipv4InCidr,
  isDolyameWebhookIp,
  parseDolyameWebhook,
  type DolyameInfoSource,
  type DolyameOrderInfo,
  type DolyameResult,
} from "../src/index.js";

// Shape of the "Wait for Commit" sample on https://dolyame.ru/develop/api/webhooks/ (values are the docs' samples).
const sample = {
  id: "test_id",
  status: "wait_for_commit",
  amount: 10000.56,
  residual_amount: 7500.42,
  demo: false,
  client_info: { first_name: "Иван", last_name: "И.", middle_name: "Иванович", email: "t**@y*.ru", phone: "+79003332211", birthdate: "1997-05-15" },
  payment_schedule: [
    { payment_date: "2026-05-01", amount: 2500.14, status: "hold" },
    { payment_date: "2026-05-15", amount: 2500.14, status: "scheduled" },
  ],
  cid: "faf356cf-7469-4597-a373-73185b1fb928",
  signature: "45f24a5a07af5c2e237a487cf86eb5d1dd1c0cb6a2824d65d9f1a8e2cc4fea9c",
};

test("the documented sample parses from string, Buffer and object", () => {
  const raw = JSON.stringify(sample);
  for (const input of [raw, Buffer.from(raw), sample]) {
    const webhook = parseDolyameWebhook(input);
    assert.equal(webhook.id, "test_id");
    assert.equal(webhook.status, "wait_for_commit");
    assert.equal(webhook.residual_amount, 7500.42);
    assert.equal(webhook.payment_schedule?.[0]?.status, "hold");
  }
});

test("minimal rejected/canceled payloads (no client_info, no schedule) are accepted", () => {
  const rejected = parseDolyameWebhook({ id: "o", status: "rejected", amount: 1, residual_amount: 0, demo: false, cid: "c", signature: "s" });
  assert.equal(rejected.status, "rejected");
});

test("malformed payloads are refused with a reason", () => {
  const reason = (input: string | object): string | undefined => {
    try {
      parseDolyameWebhook(input);
      return undefined;
    } catch (error) {
      assert.ok(error instanceof WebhookError);
      return error.reason;
    }
  };
  assert.equal(reason("{oops"), "invalid_json");
  assert.equal(reason("[]"), "not_an_object");
  assert.equal(reason({ ...sample, id: "" }), "invalid_shape");
  assert.equal(reason({ ...sample, amount: "10" }), "invalid_shape");
  assert.equal(reason({ ...sample, signature: undefined }), "invalid_shape");
  assert.equal(reason({ ...sample, status: 5 }), "invalid_shape");
  assert.equal(reason({ ...sample, status: "refunded" }), "unknown_status");
});

test("source IP check covers exactly the three documented networks, including IPv4-mapped IPv6", () => {
  assert.deepEqual([...DOLYAME_WEBHOOK_IP_RANGES], ["91.194.226.0/23", "91.218.132.0/22", "212.233.80.0/22"]);
  for (const ip of ["91.194.226.1", "91.194.227.254", "91.218.132.1", "91.218.135.254", "212.233.80.1", "212.233.83.254", "::ffff:91.194.226.9"]) {
    assert.equal(isDolyameWebhookIp(ip), true, ip);
  }
  for (const ip of ["91.194.228.1", "91.194.225.255", "91.218.136.1", "212.233.84.1", "127.0.0.1", "8.8.8.8", "::1", "not-an-ip", ""]) {
    assert.equal(isDolyameWebhookIp(ip), false, ip);
  }
});

test("ipv4InCidr handles edge masks", () => {
  assert.equal(ipv4InCidr("10.1.2.3", "10.1.2.3/32"), true);
  assert.equal(ipv4InCidr("10.1.2.4", "10.1.2.3/32"), false);
  assert.equal(ipv4InCidr("1.2.3.4", "0.0.0.0/0"), true);
  assert.equal(ipv4InCidr("1.2.3.4", "bad/24"), false);
  assert.equal(ipv4InCidr("1.2.3.4", "1.2.3.0/33"), false);
});

const info = (status: DolyameOrderInfo["status"]): DolyameResult<DolyameOrderInfo> => ({
  ok: true,
  data: { status, amount: 1, residual_amount: 1, link: "https://dolyame.example/x" },
  httpStatus: 200,
});

test("confirmDolyameWebhook asks info and treats it as the source of truth", async () => {
  const asked: string[] = [];
  const source = (status: DolyameOrderInfo["status"]): DolyameInfoSource => ({
    info: async (orderId) => {
      asked.push(orderId);
      return info(status);
    },
  });

  const match = await confirmDolyameWebhook(source("wait_for_commit"), { id: "o-1", status: "wait_for_commit" });
  assert.equal(match.matches, true);
  assert.deepEqual(asked, ["o-1"]);

  const aliasMatch = await confirmDolyameWebhook(source("waiting_for_commit"), { id: "o-1", status: "wait_for_commit" });
  assert.equal(aliasMatch.matches, true);

  const forged = await confirmDolyameWebhook(source("approved"), { id: "o-1", status: "committed" });
  assert.equal(forged.matches, false);
  assert.equal(forged.actual, "approved");
});

test("confirmDolyameWebhook surfaces an info failure instead of trusting the webhook", async () => {
  const failing: DolyameInfoSource = {
    info: async () => ({ ok: false, error: new DolyameError({ httpStatus: 404, code: "NOT_FOUND", message: "no such order", response: {} }) }),
  };
  await assert.rejects(confirmDolyameWebhook(failing, { id: "ghost", status: "committed" }), DolyameError);
});
