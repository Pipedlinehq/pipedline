/**
 * Square payloads for the adapter's tests, built from the shapes and examples published at
 * developer.squareup.com/reference/square (Payment, Order, OrderLineItem, Tender, PaymentRefund,
 * Location, and the payment.updated / refund.updated webhook events), read on 2026-10-01.
 *
 * They are NOT recordings of Square. Nothing here has been checked against a Square account.
 */
export const MERCHANT_ID = '6SSW7HV8K2ST5';
export const LOCATION_ID = 'L88917AVBK2S5';
export const OUR_APPLICATION_ID = 'sq0idp-OURAPPLICATIONID';
export const FINGERPRINT = 'sq-1-Hxim77tbdcbGejOejnoAklBVJed2YFLTmirfl8Q5XZzObTc8qY_U8RkwzoNL8dCEcQ';

/** A card payment taken at the till, with a tip, for an itemised order. */
export function cardPayment(over: Record<string, unknown> = {}) {
  return {
    id: 'bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY',
    created_at: '2026-09-26T01:34:33.524Z',
    updated_at: '2026-09-26T01:34:34.339Z',
    amount_money: { amount: 5310, currency: 'AUD' },
    tip_money: { amount: 500, currency: 'AUD' },
    total_money: { amount: 5810, currency: 'AUD' },
    approved_money: { amount: 5810, currency: 'AUD' },
    status: 'COMPLETED',
    delay_duration: 'PT36H',
    delay_action: 'CANCEL',
    source_type: 'CARD',
    card_details: {
      status: 'CAPTURED',
      card: { card_brand: 'VISA', last_4: '1111', exp_month: 11, exp_year: 2028, fingerprint: FINGERPRINT, card_type: 'DEBIT', prepaid_type: 'NOT_PREPAID', bin: '411111' },
      entry_method: 'EMV',
      cvv_status: 'CVV_ACCEPTED',
      avs_status: 'AVS_ACCEPTED',
      auth_result_code: '2Nkw7q',
      statement_description: 'SQ *OAK DINER',
      card_payment_timeline: { authorized_at: '2026-09-26T01:34:33.680Z', captured_at: '2026-09-26T01:34:34.340Z' },
    },
    location_id: LOCATION_ID,
    order_id: 'd7eKah653Z579f3gVtjlxpSlmUcZY',
    customer_id: 'W92WH6P11H4Z77CTET0RNTGFW8',
    buyer_email_address: 'Square.Guest@example.com',
    team_member_id: 'TMoK_ogh6rH1o4dV',
    employee_id: 'TMoK_ogh6rH1o4dV',
    receipt_number: 'bP9m',
    receipt_url: 'https://squareup.com/receipt/preview/bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY',
    application_details: { square_product: 'SQUARE_POS', application_id: 'sq0ids-Pw67AZAlLVB7hsRmwlJPuA' },
    version_token: '56pRkL3slrzet2iQrTp9n0bdJVYTB9YEWdTNjQfZOPV6o',
    ...over,
  };
}

/** The order that payment paid for: two lines, a modifier, a 10% discount, GST included in the prices. */
export function itemisedOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'd7eKah653Z579f3gVtjlxpSlmUcZY',
    location_id: LOCATION_ID,
    customer_id: 'W92WH6P11H4Z77CTET0RNTGFW8',
    state: 'COMPLETED',
    version: 4,
    created_at: '2026-09-26T01:20:11.000Z',
    updated_at: '2026-09-26T01:34:34.500Z',
    closed_at: '2026-09-26T01:34:34.500Z',
    line_items: [
      {
        uid: '945986d1-9586-11e6-ad5a-28cfe92138cf',
        name: 'Wagyu rump',
        variation_name: '250g',
        quantity: '1',
        catalog_object_id: 'CATALOGVARIATIONRUMP250',
        item_type: 'ITEM',
        modifiers: [{ uid: 'mod-1', catalog_object_id: 'CATALOGMODPEPPER', name: 'Pepper sauce', quantity: '1', base_price_money: { amount: 300, currency: 'AUD' }, total_price_money: { amount: 300, currency: 'AUD' } }],
        base_price_money: { amount: 4800, currency: 'AUD' },
        variation_total_price_money: { amount: 4800, currency: 'AUD' },
        gross_sales_money: { amount: 5100, currency: 'AUD' },
        total_tax_money: { amount: 417, currency: 'AUD' },
        total_discount_money: { amount: 510, currency: 'AUD' },
        total_money: { amount: 4590, currency: 'AUD' },
      },
      {
        uid: 'a8f4168c-9586-11e6-bdf0-28cfe92138cf',
        name: 'Fries',
        quantity: '2',
        catalog_object_id: 'CATALOGVARIATIONFRIES',
        item_type: 'ITEM',
        base_price_money: { amount: 400, currency: 'AUD' },
        variation_total_price_money: { amount: 800, currency: 'AUD' },
        gross_sales_money: { amount: 800, currency: 'AUD' },
        total_tax_money: { amount: 65, currency: 'AUD' },
        total_discount_money: { amount: 80, currency: 'AUD' },
        total_money: { amount: 720, currency: 'AUD' },
      },
    ],
    discounts: [{ uid: 'locals-night', name: 'Locals night', type: 'FIXED_PERCENTAGE', percentage: '10', applied_money: { amount: 590, currency: 'AUD' }, scope: 'ORDER' }],
    tenders: [
      {
        id: 'bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY',
        location_id: LOCATION_ID,
        type: 'CARD',
        amount_money: { amount: 5810, currency: 'AUD' },
        tip_money: { amount: 500, currency: 'AUD' },
        // Tender.card_details is documented as a TenderCardDetails; its inner fields could not be
        // read from the reference (the page did not load). The adapter never reads it. It is here
        // so the tests prove a fingerprint nested anywhere in an order is removed.
        card_details: { status: 'CAPTURED', card: { card_brand: 'VISA', last_4: '1111', fingerprint: FINGERPRINT }, entry_method: 'EMV' },
        payment_id: 'bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY',
      },
    ],
    total_money: { amount: 5810, currency: 'AUD' },
    total_tax_money: { amount: 482, currency: 'AUD' },
    total_discount_money: { amount: 590, currency: 'AUD' },
    total_tip_money: { amount: 500, currency: 'AUD' },
    total_service_charge_money: { amount: 0, currency: 'AUD' },
    ...over,
  };
}

/** A cash sale rung up as a custom amount: a payment with an order that has one un-named line. */
export function cashPayment(over: Record<string, unknown> = {}) {
  return {
    id: 'KkAkhdMsgzn59SM8A89WgKwekxLZY',
    created_at: '2026-09-26T02:10:00.000Z',
    updated_at: '2026-09-26T02:10:00.100Z',
    amount_money: { amount: 1850, currency: 'AUD' },
    total_money: { amount: 1850, currency: 'AUD' },
    status: 'COMPLETED',
    source_type: 'CASH',
    cash_details: { buyer_supplied_money: { amount: 2000, currency: 'AUD' }, change_back_money: { amount: 150, currency: 'AUD' } },
    location_id: LOCATION_ID,
    order_id: 'haOyDuHiqtAXMk0d8pDKXpL7Jg4F',
    application_details: { square_product: 'SQUARE_POS', application_id: 'sq0ids-Pw67AZAlLVB7hsRmwlJPuA' },
    version_token: 'bhC3b8qKJvNDdxqKzXaeDsAjS1oMFuAKxGgT32HbE6S6o',
    ...over,
  };
}

/** The webhook body Square documents for payment.updated, for our payment. */
export function paymentUpdatedEvent(payment: Record<string, unknown>, eventId = '6a8f5f28-54a1-4eb0-a98a-3111513fd4fc') {
  return {
    merchant_id: MERCHANT_ID,
    type: 'payment.updated',
    event_id: eventId,
    created_at: '2026-09-26T01:40:00.308Z',
    data: { type: 'payment', id: payment.id, object: { payment } },
  };
}

/** The webhook body Square documents for refund.updated. It names the refund; the payment is inside. */
export function refundUpdatedEvent(paymentId: string, eventId = 'bc316346-6691-4243-88ed-6d651a0d0c47') {
  return {
    merchant_id: MERCHANT_ID,
    type: 'refund.updated',
    event_id: eventId,
    created_at: '2026-09-27T22:14:16.421Z',
    data: {
      type: 'refund',
      id: `${paymentId}_ptNBVqHYxt5gAdfcobBe4u1AZsXhoz06KTtuq9Ls24P`,
      object: {
        refund: {
          id: `${paymentId}_ptNBVqHYxt5gAdfcobBe4u1AZsXhoz06KTtuq9Ls24P`,
          created_at: '2026-09-27T21:27:41.836Z',
          updated_at: '2026-09-27T22:14:16.381Z',
          amount_money: { amount: 1000, currency: 'AUD' },
          status: 'COMPLETED',
          location_id: LOCATION_ID,
          order_id: 'haOyDuHiqtAXMk0d8pDKXpL7Jg4F',
          payment_id: paymentId,
          version: 10,
        },
      },
    },
  };
}

export interface StubRequest {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: any;
}

/** A stand-in for fetch that answers from a function and remembers every request made. */
export function stubSquare(answer: (req: StubRequest) => { status?: number; body: unknown }): { fetch: typeof fetch; calls: StubRequest[] } {
  const calls: StubRequest[] = [];
  const stub = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const req: StubRequest = {
      method: init?.method ?? 'GET',
      host: url.host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    const res = answer(req);
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: stub, calls };
}
