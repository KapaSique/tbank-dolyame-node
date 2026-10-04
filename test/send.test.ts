import assert from "node:assert/strict";
import { test } from "node:test";
import { TransportError } from "../src/index.js";
import { send, type RetryPolicy } from "../src/http/send.js";
import { fakeTransport, hangingTransport, jsonResponse } from "./helpers.js";

const request = { method: "POST", url: "https://api.example.test/x", headers: {}, body: "{}" } as const;

function policy(overrides: Partial<RetryPolicy> = {}): { retry: RetryPolicy; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    retry: {
      retries: 2,
      baseDelayMs: 250,
      maxDelayMs: 4000,
      random: () => 0,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      ...overrides,
    },
  };
}

const netError = (code: string): Error => Object.assign(new Error(`socket problem ${code}`), { code });

test("a non-idempotent call gets exactly one attempt and reports that the outcome is unknown", async () => {
  const { transport, requests } = fakeTransport([netError("ECONNRESET"), jsonResponse({ ok: true })]);
  const { retry } = policy();
  await assert.rejects(send(transport, request, { timeoutMs: 1000, idempotent: false, retry }), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.kind, "network");
    assert.equal(error.code, "ECONNRESET");
    assert.equal(error.outcomeUnknown, true);
    return true;
  });
  assert.equal(requests.length, 1);
});

test("an idempotent call retries network errors with exponential backoff, then succeeds", async () => {
  const { transport, requests } = fakeTransport([netError("ECONNRESET"), netError("ETIMEDOUT"), jsonResponse({ ok: true })]);
  const { retry, delays } = policy();
  const response = await send(transport, request, { timeoutMs: 1000, idempotent: true, retry });
  assert.equal(response.status, 200);
  assert.equal(requests.length, 3);
  assert.deepEqual(delays, [125, 250]); // base * 2^attempt * (0.5 + 0.5 * random()), random() = 0
});

test("idempotent calls retry HTTP 5xx and give back the last response when attempts run out", async () => {
  const { transport, requests } = fakeTransport([jsonResponse({}, 503)]);
  const { retry } = policy();
  const response = await send(transport, request, { timeoutMs: 1000, idempotent: true, retry });
  assert.equal(response.status, 503);
  assert.equal(requests.length, 3);
});

test("a non-idempotent call never retries an HTTP 5xx", async () => {
  const { transport, requests } = fakeTransport([jsonResponse({}, 502), jsonResponse({ ok: true })]);
  const { retry } = policy();
  const response = await send(transport, request, { timeoutMs: 1000, idempotent: false, retry });
  assert.equal(response.status, 502);
  assert.equal(requests.length, 1);
});

test("HTTP 429 honours a short Retry-After and gives up on a long one", async () => {
  const short = fakeTransport([jsonResponse({}, 429, { "retry-after": "1" }), jsonResponse({ ok: true })]);
  const shortPolicy = policy();
  const ok = await send(short.transport, request, { timeoutMs: 1000, idempotent: true, retry: shortPolicy.retry });
  assert.equal(ok.status, 200);
  assert.deepEqual(shortPolicy.delays, [1000]);

  const long = fakeTransport([jsonResponse({}, 429, { "retry-after": "60" }), jsonResponse({ ok: true })]);
  const gaveUp = await send(long.transport, request, { timeoutMs: 1000, idempotent: true, retry: policy().retry });
  assert.equal(gaveUp.status, 429);
  assert.equal(long.requests.length, 1);
});

test("a timeout is enforced with AbortController and classified as outcome-unknown", async () => {
  await assert.rejects(
    send(hangingTransport, request, { timeoutMs: 20, idempotent: false, retry: policy().retry }),
    (error: unknown) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.kind, "timeout");
      assert.equal(error.outcomeUnknown, true);
      assert.match(error.message, /20 ms/);
      return true;
    },
  );
});

test("an idempotent call retries after a timeout", async () => {
  let calls = 0;
  const transport = (req: Parameters<typeof hangingTransport>[0]): ReturnType<typeof hangingTransport> => {
    calls += 1;
    return calls < 3 ? hangingTransport(req) : Promise.resolve(jsonResponse({ ok: true }));
  };
  const response = await send(transport, request, { timeoutMs: 15, idempotent: true, retry: policy().retry });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test("a caller abort stops immediately and is never retried", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const started = Date.now();
  await assert.rejects(
    send(hangingTransport, request, { timeoutMs: 5000, idempotent: true, retry: policy().retry, signal: controller.signal }),
    (error: unknown) => error instanceof TransportError && error.kind === "aborted",
  );
  assert.ok(Date.now() - started < 1000);
});

test("certificate problems are TLS failures: not retried, request not sent, hint about the Russian root", async () => {
  const { transport, requests } = fakeTransport([netError("SELF_SIGNED_CERT_IN_CHAIN")]);
  await assert.rejects(
    send(transport, request, { timeoutMs: 1000, idempotent: true, retry: policy().retry }),
    (error: unknown) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.kind, "tls");
      assert.equal(error.code, "SELF_SIGNED_CERT_IN_CHAIN");
      assert.equal(error.outcomeUnknown, false);
      assert.match(error.message, /createRussianTrustAgent\(\)/);
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test("an expired certificate is a TLS failure without the Russian-root hint", async () => {
  const { transport } = fakeTransport([netError("CERT_HAS_EXPIRED")]);
  await assert.rejects(
    send(transport, request, { timeoutMs: 1000, idempotent: false, retry: policy().retry }),
    (error: unknown) => error instanceof TransportError && error.kind === "tls" && !/createRussianTrustAgent/.test(error.message),
  );
});

test("DNS and refused connections are known not to have reached the server", async () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED"]) {
    const { transport } = fakeTransport([netError(code)]);
    await assert.rejects(
      send(transport, request, { timeoutMs: 1000, idempotent: false, retry: policy().retry }),
      (error: unknown) => error instanceof TransportError && error.kind === "network" && error.outcomeUnknown === false,
      code,
    );
  }
});
