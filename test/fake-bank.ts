import http from "node:http";
import { signToken, verifyToken } from "../src/index.js";
import { readBody } from "./helpers.js";

interface FakePayment {
  id: string;
  orderId: string;
  amount: number;
  status: string;
  payType: "O" | "T";
  refunded: number;
  held: number;
}

export interface FakeBank {
  server: http.Server;
  payments: Map<string, FakePayment>;
  /** Every request seen, with the token check result. */
  calls: Array<{ path: string; body: Record<string, unknown>; tokenValid: boolean }>;
  /** The buyer pays on the bank page: T -> AUTHORIZED, O -> CONFIRMED. */
  pay(paymentId: string): void;
  /** Make the next `count` calls to `path` answer with HTTP 500. */
  failNext(path: string, count: number): void;
  /** Never answer calls to `path`. */
  stall(path: string): void;
  /** A signed notification the way the bank would POST it. */
  notification(paymentId: string, extra?: Record<string, unknown>): Record<string, unknown>;
}

/**
 * A tiny stand-in for the bank that verifies the Token of every request, so the integration tests
 * exercise the real client over real HTTP. Error codes/messages here are invented for the test.
 */
export function createFakeBank(terminalKey: string, password: string): FakeBank {
  const payments = new Map<string, FakePayment>();
  const calls: FakeBank["calls"] = [];
  const failures = new Map<string, number>();
  const stalled = new Set<string>();
  let sequence = 5000;

  const fail = (code: string, message: string): Record<string, unknown> => ({
    Success: false,
    ErrorCode: code,
    Message: message,
    Details: "fake bank",
    TerminalKey: terminalKey,
  });
  const view = (p: FakePayment): Record<string, unknown> => ({
    Success: true,
    ErrorCode: "0",
    TerminalKey: terminalKey,
    OrderId: p.orderId,
    PaymentId: p.id,
    Status: p.status,
    Amount: p.amount,
  });

  const server = http.createServer(async (request, response) => {
    const path = request.url ?? "";
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    const tokenValid = verifyToken(body, password);
    calls.push({ path, body, tokenValid });

    if (stalled.has(path)) return; // client times out
    const remaining = failures.get(path) ?? 0;
    if (remaining > 0) {
      failures.set(path, remaining - 1);
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ Success: false, ErrorCode: "9999", Message: "Internal error", Causes: ["injected"] }));
      return;
    }
    const send = (json: Record<string, unknown>): void => {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(json));
    };

    if (!tokenValid || body["TerminalKey"] !== terminalKey) return send(fail("9999", "Wrong token"));

    const payment = payments.get(String(body["PaymentId"]));
    switch (path) {
      case "/v2/Init": {
        const id = String(sequence++);
        const created: FakePayment = {
          id,
          orderId: String(body["OrderId"]),
          amount: Number(body["Amount"]),
          status: "NEW",
          payType: body["PayType"] === "O" ? "O" : "T",
          refunded: 0,
          held: 0,
        };
        payments.set(id, created);
        return send({ ...view(created), PaymentURL: `https://pay.example.com/${id}` });
      }
      case "/v2/GetState":
        return payment ? send(view(payment)) : send(fail("8", "Payment not found"));
      case "/v2/Confirm": {
        if (!payment) return send(fail("8", "Payment not found"));
        if (payment.status !== "AUTHORIZED") return send(fail("4", "Cannot change payment status"));
        payment.status = "CONFIRMED";
        payment.amount = body["Amount"] === undefined ? payment.amount : Number(body["Amount"]);
        return send(view(payment));
      }
      case "/v2/Cancel": {
        if (!payment) return send(fail("8", "Payment not found"));
        const original = payment.amount - payment.refunded;
        const amount = body["Amount"] === undefined ? original : Number(body["Amount"]);
        if (amount > original) return send(fail("100", "Amount is greater than reserved"));
        const partial = amount < original;
        if (payment.status === "NEW") payment.status = "CANCELED";
        else if (payment.status === "AUTHORIZED") payment.status = partial ? "PARTIAL_REVERSED" : "REVERSED";
        else if (payment.status === "CONFIRMED" || payment.status === "PARTIAL_REFUNDED") payment.status = partial ? "PARTIAL_REFUNDED" : "REFUNDED";
        else return send(fail("4", "Cannot change payment status"));
        payment.refunded += amount;
        return send({ ...view(payment), OriginalAmount: original, NewAmount: original - amount });
      }
      default:
        return send(fail("1", "Unknown method"));
    }
  });

  return {
    server,
    payments,
    calls,
    pay(paymentId) {
      const payment = payments.get(paymentId);
      if (!payment) throw new Error(`no payment ${paymentId}`);
      payment.status = payment.payType === "T" ? "AUTHORIZED" : "CONFIRMED";
    },
    failNext(path, count) {
      failures.set(path, count);
    },
    stall(path) {
      stalled.add(path);
    },
    notification(paymentId, extra = {}) {
      const payment = payments.get(paymentId);
      if (!payment) throw new Error(`no payment ${paymentId}`);
      const body: Record<string, unknown> = {
        TerminalKey: terminalKey,
        OrderId: payment.orderId,
        Success: true,
        Status: payment.status,
        PaymentId: Number(payment.id),
        ErrorCode: "0",
        Amount: payment.amount,
        ...extra,
      };
      return { ...body, Token: signToken(body, password) };
    },
  };
}
