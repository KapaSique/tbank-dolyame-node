import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpRequest, HttpResponse, Transport } from "../src/index.js";

export interface RecordedRequest extends HttpRequest {
  json: Record<string, unknown> | undefined;
}

/**
 * A transport that records every request and answers from a script.
 * A script entry is a ready response or a function; an `Error` entry is thrown.
 */
export function fakeTransport(
  script: Array<HttpResponse | Error | ((request: HttpRequest) => HttpResponse | Promise<HttpResponse>)>,
): { transport: Transport; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const transport: Transport = async (request) => {
    requests.push({ ...request, json: request.body ? (JSON.parse(request.body) as Record<string, unknown>) : undefined });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if (step === undefined) throw new Error("fakeTransport: empty script");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  };
  return { transport, requests };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

/** Never resolves; rejects with an AbortError as soon as the library aborts the request. */
export const hangingTransport: Transport = (request) =>
  new Promise((_, reject) => {
    request.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

export const noSleep = { sleep: () => Promise.resolve(), random: () => 0 };

export interface TestIdentity {
  cert: string;
  key: string;
}

/** Throwaway self-signed certificate generated with the openssl CLI (nothing sensitive is committed). */
export function generateIdentity(commonName: string): TestIdentity {
  const dir = mkdtempSync(join(tmpdir(), "tbank-dolyame-test-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "2",
        "-subj",
        `/CN=${commonName}`,
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
    return { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Starts `server` on an ephemeral 127.0.0.1 port. `close()` also drops keep-alive connections. */
export function listen(server: import("node:http").Server | import("node:https").Server, scheme: "http" | "https" = "http"): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("unexpected server address"));
        return;
      }
      resolve({
        url: `${scheme}://127.0.0.1:${address.port}`,
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
