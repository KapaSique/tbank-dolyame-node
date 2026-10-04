import http from "node:http";
import https from "node:https";

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Aborted by the library on timeout; a transport must honour it. */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  body: string;
}

/** Replace it in tests (or to add logging/proxying); the clients only depend on this shape. */
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export interface NodeTransportOptions {
  /**
   * Custom agent, e.g. `createRussianTrustAgent()` or an mTLS agent.
   * Use an `https.Agent` for https URLs and an `http.Agent` (or none) for http URLs.
   */
  agent?: http.Agent | undefined;
  /** Hard cap for the response body. Default 5 MiB. */
  maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Default transport on top of `node:https` / `node:http`. No redirects are followed. */
export function createNodeTransport(options: NodeTransportOptions = {}): Transport {
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return (request) =>
    new Promise<HttpResponse>((resolve, reject) => {
      const url = new URL(request.url);
      const headers: Record<string, string> = { ...request.headers };
      if (request.body !== undefined && !hasHeader(headers, "content-length")) {
        headers["content-length"] = String(Buffer.byteLength(request.body));
      }

      const onResponse = (res: http.IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy(new Error(`Response body exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: flattenHeaders(res.headers),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      };

      const common = {
        method: request.method,
        headers,
        ...(options.agent ? { agent: options.agent } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      };
      const req =
        url.protocol === "https:"
          ? https.request(url, common, onResponse)
          : http.request(url, common, onResponse);
      req.on("error", reject);
      req.end(request.body);
    });
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    flat[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}
