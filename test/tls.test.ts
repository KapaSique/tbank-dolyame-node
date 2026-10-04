import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import tls from "node:tls";
import { after, before, test } from "node:test";
import {
  RUSSIAN_TRUSTED_ROOT_CA_PEM,
  RUSSIAN_TRUSTED_ROOT_CA_SHA256,
  TbankClient,
  TransportError,
  certificateFingerprint256,
  createMtlsAgent,
  createRussianTrustAgent,
  isBundledRootIntact,
  russianTrustCaBundle,
} from "../src/index.js";
import { generateIdentity, listen, noSleep, type RunningServer, type TestIdentity } from "./helpers.js";

// Pinned on purpose: also printed in the README. Compare with the official source before changing it:
//   https://www.gosuslugi.ru/crt   |   https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer
const PINNED_SHA256 = "D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31";

test("the bundled root certificate has the pinned SHA-256 fingerprint", () => {
  assert.equal(RUSSIAN_TRUSTED_ROOT_CA_SHA256, PINNED_SHA256);
  assert.equal(new X509Certificate(RUSSIAN_TRUSTED_ROOT_CA_PEM).fingerprint256, PINNED_SHA256);
  assert.equal(certificateFingerprint256(RUSSIAN_TRUSTED_ROOT_CA_PEM), PINNED_SHA256);
  assert.equal(isBundledRootIntact(), true);
});

test("it is the self-signed Russian Trusted Root CA, valid until 2032", () => {
  const root = new X509Certificate(RUSSIAN_TRUSTED_ROOT_CA_PEM);
  assert.match(root.subject, /CN=Russian Trusted Root CA/);
  assert.equal(root.subject, root.issuer);
  assert.equal(root.ca, true);
  assert.ok(root.verify(root.publicKey), "self-signature verifies");
  assert.equal(new Date(root.validTo).getUTCFullYear(), 2032);
});

test("the PEM shipped in certs/ is identical to the embedded constant", () => {
  const onDisk = readFileSync(new URL("../certs/russian-trusted-root-ca.pem", import.meta.url), "utf8");
  assert.equal(onDisk.trim(), RUSSIAN_TRUSTED_ROOT_CA_PEM.trim());
});

test("the problem this exists for: Node's bundled store does not contain the root", () => {
  const present = tls.rootCertificates.some((pem) => new X509Certificate(pem).fingerprint256 === PINNED_SHA256);
  assert.equal(present, false);
});

test("createRussianTrustAgent adds the root to Node's roots instead of replacing them", () => {
  const before = [...tls.rootCertificates];
  const agent = createRussianTrustAgent();
  const ca = agent.options.ca as string[];

  assert.ok(ca.includes(RUSSIAN_TRUSTED_ROOT_CA_PEM), "contains the Russian root");
  for (const pem of before) assert.ok(ca.includes(pem), "keeps every bundled root");
  assert.equal(ca.length, before.length + 1);
  assert.deepEqual(tls.rootCertificates, before, "the global list is not mutated");
  assert.equal(agent.options.keepAlive, true);
});

test("extra CAs are appended and agent options are passed through (ca stays managed)", () => {
  const extra = generateIdentity("extra-ca").cert;
  const agent = createRussianTrustAgent({ extraCa: [extra, Buffer.from(extra)], agentOptions: { maxSockets: 3, keepAlive: false } });
  const ca = agent.options.ca as string[];
  assert.equal(ca.length, tls.rootCertificates.length + 3);
  assert.equal(ca.at(-1), extra);
  assert.equal(agent.options.maxSockets, 3);
  assert.equal(agent.options.keepAlive, false);
  assert.equal(russianTrustCaBundle().length, tls.rootCertificates.length + 1);
});

test("createMtlsAgent passes client certificate, key and passphrase to the agent", () => {
  const identity = generateIdentity("client");
  const agent = createMtlsAgent({ cert: identity.cert, key: identity.key, passphrase: "secret" });
  assert.equal(agent.options.cert, identity.cert);
  assert.equal(agent.options.key, identity.key);
  assert.equal(agent.options.passphrase, "secret");
  assert.ok((agent.options.ca as string[]).includes(RUSSIAN_TRUSTED_ROOT_CA_PEM));

  const noRussian = createMtlsAgent({ cert: identity.cert, key: identity.key, trustRussianRoot: false });
  assert.equal((noRussian.options.ca as string[]).includes(RUSSIAN_TRUSTED_ROOT_CA_PEM), false);
  assert.equal("passphrase" in noRussian.options, false);
});

let server: RunningServer;
let serverIdentity: TestIdentity;

before(async () => {
  serverIdentity = generateIdentity("tls-test-server");
  const app = https.createServer({ key: serverIdentity.key, cert: serverIdentity.cert }, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Success: true, ErrorCode: "0", TerminalKey: "TEST_TERMINAL_KEY", OrderId: "o", PaymentId: "1", Status: "NEW", Amount: 1 }));
  });
  server = await listen(app, "https");
});

after(async () => {
  await server.close();
});

test("an untrusted server certificate fails as a TLS error that points at the trust store", async () => {
  const client = new TbankClient({ terminalKey: "TEST_TERMINAL_KEY", password: "p", baseUrl: server.url, agent: createRussianTrustAgent(), retry: noSleep, timeoutMs: 2000 });
  await assert.rejects(client.getState({ PaymentId: "1" }), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.kind, "tls");
    assert.equal(error.outcomeUnknown, false);
    assert.equal(error.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
    return true;
  });
});

test("the same server works once its root is added through extraCa", async () => {
  const agent = createRussianTrustAgent({ extraCa: [serverIdentity.cert] });
  const client = new TbankClient({ terminalKey: "TEST_TERMINAL_KEY", password: "p", baseUrl: server.url, agent, retry: noSleep, timeoutMs: 2000 });
  const result = await client.getState({ PaymentId: "1" });
  assert.ok(result.ok);
  assert.equal(result.data.Status, "NEW");
});
