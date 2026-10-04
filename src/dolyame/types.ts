/**
 * Types for the Dolyame partner API (https://partner.dolyame.ru, OpenAPI 3.1 at
 * https://dolyame.ru/api/bnpl/partners/swagger.json). Field names are the API's snake_case.
 * Money is in rubles as JSON numbers with at most two decimals; use `toKopecks` for arithmetic.
 */

export const DOLYAME_STATUSES = [
  "new",
  "approved",
  "rejected",
  "canceled",
  "wait_for_commit",
  "waiting_for_commit",
  "committed",
  "completed",
] as const;
export type DolyameStatus = (typeof DOLYAME_STATUSES)[number];

export interface DolyameMarkCode {
  mark_code_type: string;
  value: string;
}

export interface DolyameSectoralItemProp {
  /** `001`..`072`. */
  federal_id: string;
  /** `dd.MM.yyyy`. */
  date: string;
  number: string;
  value: string;
}

/** Fiscal parameters of an item. All optional when fiscalization is disabled for the shop. */
export interface DolyameItemReceipt {
  /** Tax rate. The OpenAPI schema does not enumerate the values. */
  tax: string;
  payment_method: string;
  payment_object?: string;
  /** Tag 2108. */
  measurement_unit?: string;
  item_code?: string;
  mark_code?: DolyameMarkCode;
  /** Must be `"0"`. */
  mark_processing_mode?: string;
  mark_quantity?: { numerator: number; denominator: number };
  sectoral_item_props?: DolyameSectoralItemProp[];
  /** Tag 1011. */
  timezone?: number;
}

export interface DolyameAgentData {
  agent_sign?: "bank_paying_agent" | "bank_paying_subagent" | "paying_agent" | "paying_subagent" | "attorney" | "commission_agent" | "another";
  operation_name?: string;
  phones?: string[];
  receiver_phones?: string[];
  transfer_phones?: string[];
  operator_name?: string;
  operator_address?: string;
  operator_inn?: string;
}

export interface DolyameSupplierInfo {
  phones?: string[];
  name?: string;
  inn?: string;
}

export interface DolyameItem {
  name: string;
  /** Whole units. */
  quantity: number;
  /** Price of one unit, rubles. */
  price: number;
  sku?: string;
  receipt?: DolyameItemReceipt;
  agent_data?: DolyameAgentData;
  supplier_info?: DolyameSupplierInfo;
}

export interface DolyameClientInfo {
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  /** `yyyy-MM-dd`. */
  birthdate?: string;
  /** `+79993334444`, no spaces or dashes. */
  phone?: string;
  email?: string;
}

export type DolyameFiscalizationSettings =
  | { type: "disabled" }
  | { type: "enabled"; params?: Record<string, unknown> };

export interface DolyameOrder {
  /** Your order id. The documentation asks for a unique value of at most 30 characters. */
  id: string;
  /** Rubles paid through Dolyame. `amount + prepaid_amount` must equal `sum(quantity * price)`. */
  amount: number;
  /** Rubles already paid another way (loyalty points, ...). Default 0. */
  prepaid_amount?: number;
  items: DolyameItem[];
}

export interface DolyameCreateRequest {
  order: DolyameOrder;
  client_info?: DolyameClientInfo;
  /** Webhook URL; the shop default is used when omitted. */
  notification_url?: string;
  fail_url?: string;
  success_url?: string;
  fiscalization_settings?: DolyameFiscalizationSettings;
  data?: Record<string, string>;
}

export interface DolyameCommitRequest {
  /** Must not exceed the amount given at create. A smaller amount recalculates the payment schedule. */
  amount: number;
  prepaid_amount?: number;
  items: DolyameItem[];
  fiscalization_settings?: DolyameFiscalizationSettings;
  data?: Record<string, string>;
}

export interface DolyameRefundRequest {
  /** Rubles returned through Dolyame. `amount + refunded_prepaid_amount` must equal the returned items' total. */
  amount: number;
  returned_items: DolyameItem[];
  refunded_prepaid_amount?: number;
  fiscalization_settings?: DolyameFiscalizationSettings;
  data?: Record<string, string>;
}

export interface DolyameCompleteDeliveryRequest {
  order?: { amount: number; prepaid_amount?: number; items: DolyameItem[] };
  fiscalization_settings?: DolyameFiscalizationSettings;
}

export interface DolyamePaymentScheduleItem {
  amount: number;
  /** `yyyy-MM-dd`. */
  payment_date: string;
  status: "scheduled" | "hold" | "paid";
}

export interface DolyameRefundInfoItem {
  refund_id: string;
  refunded_amount: number;
  refunded_prepaid_amount: number;
  returned_items?: DolyameItem[];
  /** `pending` = accepted, `processed` = money returned to the client. */
  status: "pending" | "processed";
}

/** Response of create / info / commit / cancel / refund / complete_delivery. */
export interface DolyameOrderInfo {
  status: DolyameStatus;
  amount: number;
  residual_amount: number;
  /** Where to send the buyer to pay. */
  link: string;
  payment_schedule?: DolyamePaymentScheduleItem[];
  refund_info?: {
    total_refunded_amount: number;
    total_refunded_prepaid_amount: number;
    items: DolyameRefundInfoItem[];
  };
  installment_info?: { loan_number?: string };
  create_data?: Record<string, string>;
  commit_data?: Record<string, string>;
  /** Returned by `info` only. */
  items?: DolyameItem[];
  /** ISO date-time. */
  end_cooling_period?: string;
}
