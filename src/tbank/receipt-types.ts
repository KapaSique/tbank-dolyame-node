/**
 * 54-FZ receipt model for the `Receipt` object of Init / Confirm / Cancel.
 * Field names and enums follow the T-Bank EACQ v2 documentation (OpenAPI 1.36); all money is in kopecks.
 */

export const TAXATIONS = ["osn", "usn_income", "usn_income_outcome", "esn", "patent"] as const;
export type Taxation = (typeof TAXATIONS)[number];

export const TAX_RATES = [
  "none",
  "vat0",
  "vat5",
  "vat7",
  "vat10",
  "vat22",
  "vat105",
  "vat107",
  "vat110",
  "vat122",
] as const;
export type TaxRate = (typeof TAX_RATES)[number];

export const PAYMENT_METHODS = [
  "full_prepayment",
  "prepayment",
  "advance",
  "full_payment",
  "partial_payment",
  "credit",
  "credit_payment",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Tag 1212 values accepted by FFD 1.05 receipts. */
export const PAYMENT_OBJECTS_FFD105 = [
  "commodity",
  "excise",
  "job",
  "service",
  "gambling_bet",
  "gambling_prize",
  "lottery",
  "lottery_prize",
  "intellectual_activity",
  "payment",
  "agent_commission",
  "composite",
  "another",
] as const;
export type PaymentObjectFfd105 = (typeof PAYMENT_OBJECTS_FFD105)[number];

/** Tag 1212 values accepted by FFD 1.2 receipts. */
export const PAYMENT_OBJECTS_FFD12 = [
  "commodity",
  "excise",
  "job",
  "service",
  "gambling_bet",
  "gambling_prize",
  "lottery",
  "lottery_prize",
  "intellectual_activity",
  "payment",
  "agent_commission",
  "contribution",
  "property_rights",
  "unrealization",
  "tax_reduction",
  "trade_fee",
  "resort_tax",
  "pledge",
  "income_decrease",
  "ie_pension_insurance_without_payments",
  "ie_pension_insurance_with_payments",
  "ie_medical_insurance_without_payments",
  "ie_medical_insurance_with_payments",
  "social_insurance",
  "casino_chips",
  "agent_payment",
  "excisable_goods_without_marking_code",
  "excisable_goods_with_marking_code",
  "goods_without_marking_code",
  "goods_with_marking_code",
  "another",
] as const;
export type PaymentObjectFfd12 = (typeof PAYMENT_OBJECTS_FFD12)[number];

export type PaymentObject = PaymentObjectFfd105 | PaymentObjectFfd12;

export const AGENT_SIGNS = [
  "bank_paying_agent",
  "bank_paying_subagent",
  "paying_agent",
  "paying_subagent",
  "attorney",
  "commission_agent",
  "another",
] as const;
export type AgentSign = (typeof AGENT_SIGNS)[number];

export type FfdVersion = "1.05" | "1.2";

/** `"auto"` accepts what either version accepts; use it when the terminal's FFD version is not known to the code. */
export type FfdMode = FfdVersion | "auto";

export interface ReceiptAgentData {
  /** Tag 1222. */
  AgentSign?: AgentSign;
  /** Tag 1044, <= 24 chars. Required for bank paying (sub)agents. */
  OperationName?: string;
  /** Tag 1073, `+{digits}`, <= 19 chars each. */
  Phones?: string[];
  /** Tag 1074. Required for paying (sub)agents. */
  ReceiverPhones?: string[];
  /** Tag 1075. Required for bank paying (sub)agents. */
  TransferPhones?: string[];
  /** Tag 1026, <= 64 chars. */
  OperatorName?: string;
  /** Tag 1005, <= 243 chars. */
  OperatorAddress?: string;
  /** Tag 1016, <= 12 chars. */
  OperatorInn?: string;
}

export interface ReceiptSupplierInfo {
  /** Tag 1171. */
  Phones?: string[];
  /** Tag 1225. Together with `4 + length` of every phone it must fit in 239 chars. */
  Name?: string;
  /** Tag 1226, 10..12 digits. */
  Inn?: string;
}

export interface ReceiptPayments {
  /** Tag 1031, kopecks. */
  Cash?: number;
  /** Tag 1081, kopecks. Required whenever `Payments` is present; must equal the Init `Amount`. */
  Electronic: number;
  /** Tag 1215, kopecks. */
  AdvancePayment?: number;
  /** Tag 1216, kopecks. */
  Credit?: number;
  /** Tag 1217, kopecks. */
  Provision?: number;
}

export interface ReceiptAddUserProp {
  /** Tag 1085, 1..64 chars. */
  Name: string;
  /** Tag 1086, 1..256 chars. */
  Value: string;
}

interface ReceiptItemBase {
  /** Tag 1030, <= 128 chars. */
  Name: string;
  /** Tags 1078/1079. Price of one unit, kopecks. */
  Price: number;
  /** Tag 1023. Up to 5 integer and 6 fractional digits. */
  Quantity: number;
  /** Tag 1043. `Price * Quantity` in kopecks. */
  Amount: number;
  /** Tag 1199. */
  Tax: TaxRate;
  /** Tag 1214. Default `full_payment` on the bank side for FFD 1.05. */
  PaymentMethod?: PaymentMethod;
  AgentData?: ReceiptAgentData;
  SupplierInfo?: ReceiptSupplierInfo;
}

export interface ReceiptItemFfd105 extends ReceiptItemBase {
  /** Tag 1212. Default `commodity` on the bank side. */
  PaymentObject?: PaymentObjectFfd105;
  /** Tag 1162, <= 300 chars. Format depends on the cash register provider. */
  Ean13?: string;
  ShopCode?: string;
}

export interface ReceiptMarkCode {
  /** e.g. `GS1M`, `EAN13`, `RAWCODE`, `UNKNOWN`. */
  MarkCodeType: string;
  Value: string;
}

export interface ReceiptMarkQuantity {
  /** Tag 1293. Strictly less than the denominator. */
  Numerator: number;
  /** Tag 1294. */
  Denominator: number;
}

export interface ReceiptSectoralItemProp {
  /** Tag 1262. */
  FederalId: string;
  /** Tag 1263, `YYYY-MM-DD` per the Init docs. */
  Date: string;
  /** Tag 1264, <= 32 chars. */
  Number: string;
  /** Tag 1265, <= 256 chars. */
  Value: string;
}

export interface ReceiptItemFfd12 extends ReceiptItemBase {
  /** Required by the FFD 1.2 schema. */
  PaymentMethod: PaymentMethod;
  /** Tag 1212. Required by the FFD 1.2 schema. */
  PaymentObject: PaymentObjectFfd12;
  /** Tag 2108, <= 16 chars, e.g. `шт`. Required for FFD 1.2. */
  MeasurementUnit: string;
  /** Tag 1191, <= 64 chars. */
  UserData?: string;
  /** Tag 1229. */
  Excise?: number;
  /** Tag 1230, <= 3 chars. */
  CountryCode?: string;
  /** Tag 1231, <= 32 chars. */
  DeclarationNumber?: string;
  /** Tag 2102. Must be `"0"`. */
  MarkProcessingMode?: string;
  /** Tag 1163. */
  MarkCode?: ReceiptMarkCode;
  MarkQuantity?: ReceiptMarkQuantity;
  SectoralItemProps?: ReceiptSectoralItemProp[];
}

export type ReceiptItem = ReceiptItemFfd105 | ReceiptItemFfd12;

interface ReceiptBase {
  /** Tag 1008. Required when `Phone` is absent. <= 64 chars. */
  Email?: string;
  /** Tag 1008, `+{digits}`. Required when `Email` is absent. <= 64 chars. */
  Phone?: string;
  /** Tag 1055. */
  Taxation: Taxation;
  Payments?: ReceiptPayments;
  /** Tag 1084. */
  AddUserProp?: ReceiptAddUserProp;
}

export interface ReceiptFfd105 extends ReceiptBase {
  Items: ReceiptItemFfd105[];
  /** Tag 1192, <= 16 chars (lower-case `a` in the FFD 1.05 schema). */
  additionalCheckProps?: string;
}

export interface ReceiptClientInfo {
  /** Tag 1243, `DD.MM.YYYY`. */
  Birthdate?: string;
  /** Tag 1244. */
  Citizenship?: string;
  /** Tag 1245. */
  DocumentCode?: string;
  /** Tag 1246. */
  DocumentData?: string;
  /** Tag 1254, <= 256 chars. */
  Address?: string;
}

export interface ReceiptFfd12 extends ReceiptBase {
  Items: ReceiptItemFfd12[];
  ClientInfo?: ReceiptClientInfo;
  /** Tag 1227. */
  Customer?: string;
  /** Tag 1228. */
  CustomerInn?: string;
  OperatingCheckProps?: { Name: string; Value: string; Timestamp: string };
  SectoralCheckProps?: { FederalId: string; Date: string; Number: string; Value: string }[];
  /** Tag 1192, <= 16 chars (capital `A` in the FFD 1.2 schema). */
  AdditionalCheckProps?: string;
}

export type Receipt = ReceiptFfd105 | ReceiptFfd12;
