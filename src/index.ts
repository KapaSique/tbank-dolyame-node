// Shared
export * from "./errors.js";
export { unwrap, type Result } from "./result.js";
export { toKopecks, fromKopecks, lineAmount } from "./money.js";
export { isAllowedPaymentUrl, assertAllowedPaymentUrl } from "./payment-url.js";

// HTTP layer
export { createNodeTransport, type HttpRequest, type HttpResponse, type NodeTransportOptions, type Transport } from "./http/transport.js";
export { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_MS, type RetryPolicy } from "./http/send.js";

// TLS
export {
  RUSSIAN_TRUSTED_ROOT_CA_PEM,
  RUSSIAN_TRUSTED_ROOT_CA_SHA256,
  RUSSIAN_TRUSTED_ROOT_CA_SOURCES,
} from "./tls/russian-root-ca.js";
export {
  certificateFingerprint256,
  createMtlsAgent,
  createRussianTrustAgent,
  isBundledRootIntact,
  russianTrustCaBundle,
  type MtlsOptions,
  type RussianTrustOptions,
} from "./tls/agent.js";

// T-Bank
export {
  TBANK_PRODUCTION_URL,
  TBANK_TEST_URL,
  TbankClient,
  interpretResponse,
  type CallOptions,
  type CheckOrderRequest,
  type TbankClientOptions,
  type TbankResult,
} from "./tbank/client.js";
export { signToken, tokenInput, verifyToken } from "./tbank/token.js";
export {
  NOTIFICATION_OK_RESPONSE,
  parseNotification,
  verifyNotification,
  type TbankNotification,
} from "./tbank/notification.js";
export { buildReceipt, type BuildReceiptInput, type ReceiptItemInput } from "./tbank/receipt.js";
export {
  collectReceiptIssues,
  receiptItemsTotal,
  validateReceipt,
  type ReceiptValidationOptions,
} from "./tbank/receipt-validate.js";
export * from "./tbank/receipt-types.js";
export { TBANK_PAYMENT_STATUSES, tbankStatusKind } from "./tbank/types.js";
export type {
  CancelRequest,
  CancelResponse,
  CheckOrderPayment,
  CheckOrderResponse,
  ConfirmRequest,
  ConfirmResponse,
  GetStateRequest,
  GetStateResponse,
  InitRequest,
  InitResponse,
  PayType,
  TbankParam,
  TbankPaymentStatus,
  TbankStatusKind,
} from "./tbank/types.js";

// Dolyame
export {
  DOLYAME_BASE_URL,
  DolyameClient,
  interpretDolyameResponse,
  type DolyameCallOptions,
  type DolyameClientOptions,
  type DolyameResult,
} from "./dolyame/client.js";
export {
  DOLYAME_TERMINAL_STATUSES,
  DOLYAME_TRANSITIONS,
  canCancelDolyame,
  canCommitDolyame,
  canTransitionDolyame,
  canonicalDolyameStatus,
  isDolyameStatusReachable,
  isTerminalDolyameStatus,
  shouldApplyDolyameStatus,
  type DolyameLifecycleStatus,
} from "./dolyame/status.js";
export {
  DOLYAME_WEBHOOK_IP_RANGES,
  confirmDolyameWebhook,
  ipv4InCidr,
  isDolyameWebhookIp,
  parseDolyameWebhook,
  type DolyameInfoSource,
  type DolyameWebhook,
  type DolyameWebhookCheck,
} from "./dolyame/webhook.js";
export { DOLYAME_MAX_ORDER_ID_LENGTH } from "./dolyame/validate.js";
export { DOLYAME_STATUSES } from "./dolyame/types.js";
export type * from "./dolyame/types.js";
