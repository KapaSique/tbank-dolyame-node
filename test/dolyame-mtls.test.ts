import assert from "node:assert/strict";
import https from "node:https";
import { after, before, test } from "node:test";
import { DolyameClient, TransportError, createRussianTrustAgent } from "../src/index.js";
import { generateIdentity, listen, noSleep, type RunningServer, type TestIdentity } from "./helpers.js";

interface Seen {
  authorized: boolean;
  clientCommonName: string | undefined;
  authorization: string | undefined;
  correlationId: string | undefined;
  path: string;
}

let server: RunningServer;
let serverIdentity: TestIdentity;
let clientIdentity: TestIdentity;
const seen: Seen[] = [];

before(async () => {
  serverIdentity = generateIdentity("dolyame-test-server");
  clientIdentity = generateIdentity("dolyame-test-client");

  // Requires a client certificate, like partner.dolyame.ru: no cert / wrong cert -> handshake is refused.
  const app = https.createServer(
    { key: serverIdentity.key, cert: serverIdentity.cert, requestCert: true, rejectUnauthorized: true, ca: [clientIdentity.cert] },
    (request, response) => {
      const socket = request.socket as import("node:tls").TLSSocket;
      const peer = socket.getPeerCertificate();
      seen.push({
        authorized: socket.authorized,
        clientCommonName: typeof peer.subject?.CN === "string" ? peer.subject.CN : undefined,
        authorization: request.headers["authorization"],
        correlationId: request.headers["x-correlation-id"] as string | undefined,
        path: request.url ?? "",
      });
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ status: "wait_for_commit", amount: 2000, residual_amount: 1500, link: "https://dolyame.example/pay/abc" }),
      );
    },
  );
  server = await listen(app, "https");
});

after(async () => {
  await server.close();
});

test("tls options reach the connection: the server sees our client certificate, Basic auth and correlation id", async () => {
  const dolyame = new DolyameClient({
    login: "test-login",
    password: "test-password",
    baseUrl: server.url,
    tls: { cert: clientIdentity.cert, key: clientIdentity.key, extraCa: [serverIdentity.cert] },
    retry: noSleep,
    timeoutMs: 3000,
  });
  const result = await dolyame.info("shop_1001");

  assert.ok(result.ok, "the handshake succeeded");
  assert.equal(result.data.status, "wait_for_commit");
  const last = seen.at(-1);
  assert.equal(last?.authorized, true);
  assert.equal(last?.clientCommonName, "dolyame-test-client");
  assert.equal(last?.path, "/v1/orders/shop_1001/info");
  assert.equal(last?.authorization, `Basic ${Buffer.from("test-login:test-password").toString("base64")}`);
  assert.match(last?.correlationId ?? "", /^[0-9a-f-]{36}$/);
});

test("a ready-made agent can be used instead of tls options", async () => {
  const { createMtlsAgent } = await import("../src/index.js");
  const agent = createMtlsAgent({ cert: clientIdentity.cert, key: clientIdentity.key, extraCa: [serverIdentity.cert] });
  const dolyame = new DolyameClient({ login: "l", password: "p", baseUrl: server.url, agent, retry: noSleep, timeoutMs: 3000 });
  assert.ok((await dolyame.info("shop_1002")).ok);
});

test("without a client certificate the connection is refused (a TransportError, nothing reaches the handler)", async () => {
  const before = seen.length;
  const dolyame = new DolyameClient({
    login: "l",
    password: "p",
    baseUrl: server.url,
    agent: createRussianTrustAgent({ extraCa: [serverIdentity.cert] }),
    retry: noSleep,
    timeoutMs: 3000,
  });
  await assert.rejects(dolyame.info("shop_1003"), (error: unknown) => error instanceof TransportError);
  assert.equal(seen.length, before);
});

test("a client certificate the server does not trust is refused as well", async () => {
  const before = seen.length;
  const stranger = generateIdentity("not-trusted");
  const dolyame = new DolyameClient({
    login: "l",
    password: "p",
    baseUrl: server.url,
    tls: { cert: stranger.cert, key: stranger.key, extraCa: [serverIdentity.cert] },
    retry: noSleep,
    timeoutMs: 3000,
  });
  await assert.rejects(dolyame.info("shop_1004"), (error: unknown) => error instanceof TransportError);
  assert.equal(seen.length, before);
});
