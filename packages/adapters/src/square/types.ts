/**
 * The parts of Square's API objects this adapter reads or writes, as documented at
 * developer.squareup.com/reference/square (checked 2026-10-01, API version 2026-09-16).
 * Every field is optional here on purpose: Square omits fields that do not apply, and an
 * adapter that assumes a field is present breaks on the first payment that lacks it.
 *
 * UNVERIFIED AGAINST SQUARE: built from the published reference, never run against a Square
 * account or sandbox.
 */
export interface SquareMoney {
  /** Smallest denomination of the currency (cents). Can be negative. */
  amount?: number;
  currency?: string;
}

export interface SquareError {
  category?: string;
  code?: string;
  detail?: string;
  field?: string;
}

export interface SquareCard {
  card_brand?: string;
  last_4?: string;
  /** "A Square-assigned identifier, based on the card number, to identify the card across multiple locations." */
  fingerprint?: string;
  card_type?: string;
  [k: string]: unknown;
}

export interface SquarePayment {
  id?: string;
  created_at?: string;
  updated_at?: string;
  /** APPROVED | PENDING | COMPLETED | CANCELED | FAILED */
  status?: string;
  /** Not including the tip. */
  amount_money?: SquareMoney;
  tip_money?: SquareMoney;
  /** amount_money + tip_money. */
  total_money?: SquareMoney;
  refunded_money?: SquareMoney;
  /** CARD | BANK_ACCOUNT | WALLET | BUY_NOW_PAY_LATER | SQUARE_ACCOUNT | CASH | EXTERNAL */
  source_type?: string;
  card_details?: { status?: string; card?: SquareCard; entry_method?: string; [k: string]: unknown };
  location_id?: string;
  order_id?: string;
  reference_id?: string;
  customer_id?: string;
  /** Deprecated by Square in favour of team_member_id. */
  employee_id?: string;
  team_member_id?: string;
  refund_ids?: string[];
  buyer_email_address?: string;
  note?: string;
  application_details?: { square_product?: string; application_id?: string };
  version_token?: string;
  [k: string]: unknown;
}

export interface SquareOrderLineItemModifier {
  uid?: string;
  catalog_object_id?: string;
  name?: string;
  quantity?: string;
  base_price_money?: SquareMoney;
  total_price_money?: SquareMoney;
}

export interface SquareOrderLineItem {
  uid?: string;
  name?: string;
  /** A decimal string: "1", "0.35". */
  quantity?: string;
  note?: string;
  catalog_object_id?: string;
  variation_name?: string;
  item_type?: string;
  modifiers?: SquareOrderLineItemModifier[];
  /** One unit, before modifiers. */
  base_price_money?: SquareMoney;
  /** Base price x quantity plus modifiers, before discounts. Read-only. */
  gross_sales_money?: SquareMoney;
  total_tax_money?: SquareMoney;
  total_discount_money?: SquareMoney;
  total_money?: SquareMoney;
}

export interface SquareOrderDiscount {
  uid?: string;
  catalog_object_id?: string;
  name?: string;
  /** FIXED_PERCENTAGE | FIXED_AMOUNT | VARIABLE_PERCENTAGE | VARIABLE_AMOUNT | UNKNOWN_DISCOUNT */
  type?: string;
  percentage?: string;
  amount_money?: SquareMoney;
  applied_money?: SquareMoney;
  /** OTHER_DISCOUNT_SCOPE | LINE_ITEM | ORDER */
  scope?: string;
}

export interface SquareFulfillment {
  uid?: string;
  /** PICKUP | SHIPMENT | DELIVERY | IN_STORE */
  type?: string;
  /** PROPOSED | RESERVED | PREPARED | COMPLETED | CANCELED | FAILED */
  state?: string;
  pickup_details?: {
    recipient?: { customer_id?: string; display_name?: string; email_address?: string; phone_number?: string };
    /** SCHEDULED | ASAP */
    schedule_type?: string;
    pickup_at?: string;
    prep_time_duration?: string;
    note?: string;
  };
}

export interface SquareTender {
  /** "The tender's unique ID. It is the associated payment ID." */
  id?: string;
  payment_id?: string;
  type?: string;
  amount_money?: SquareMoney;
  [k: string]: unknown;
}

export interface SquareOrder {
  id?: string;
  location_id?: string;
  reference_id?: string;
  customer_id?: string;
  line_items?: SquareOrderLineItem[];
  discounts?: SquareOrderDiscount[];
  fulfillments?: SquareFulfillment[];
  tenders?: SquareTender[];
  /** OPEN | COMPLETED | CANCELED | DRAFT */
  state?: string;
  version?: number;
  ticket_name?: string;
  total_money?: SquareMoney;
  total_tax_money?: SquareMoney;
  total_discount_money?: SquareMoney;
  total_tip_money?: SquareMoney;
  total_service_charge_money?: SquareMoney;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface SquareRefund {
  id?: string;
  /** PENDING | COMPLETED | REJECTED | FAILED */
  status?: string;
  amount_money?: SquareMoney;
  payment_id?: string;
  order_id?: string;
  location_id?: string;
}

export interface SquareLocation {
  id?: string;
  name?: string;
  timezone?: string;
  status?: string;
  merchant_id?: string;
  currency?: string;
}

/** The envelope Square posts to a webhook subscription. */
export interface SquareWebhookEvent {
  merchant_id?: string;
  location_id?: string;
  type?: string;
  event_id?: string;
  created_at?: string;
  data?: {
    type?: string;
    id?: string;
    object?: { payment?: SquarePayment; refund?: SquareRefund; [k: string]: unknown };
  };
}
