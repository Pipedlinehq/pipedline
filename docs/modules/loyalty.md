# MODULE — `loyalty` (native, not Square Loyalty)

Org-scoped so a group's guest earns at one venue and burns at another.

## 1. Ledger, not a balance column

```sql
loyalty_programs(id, org_id, name, is_active,
                 earn_model,            -- 'points_per_dollar' | 'visits' | 'spend_tiers' | 'stamps'
                 points_per_dollar, points_rounding,
                 point_value_cents,     -- what a point is worth on redemption
                 expiry_months, expiry_policy,   -- 'rolling' | 'fixed' | 'none'
                 enrolment_bonus, birthday_bonus,
                 terms_url, created_at)

loyalty_accounts(id, org_id, program_id, customer_id, enrolled_at, tier_id, status)
-- UNIQUE(program_id, customer_id)

loyalty_transactions(id, org_id, account_id, occurred_at,
                     kind,        -- 'earn' | 'burn' | 'adjust' | 'expire' | 'transfer' | 'reverse'
                     points,      -- signed
                     source_transaction_id NULL,
                     reward_id NULL, venue_id, staff_id NULL,
                     idempotency_key UNIQUE,
                     note, created_at)
```

**Balance is `SUM(points)`, never a stored mutable column.** A mutable balance drifts the first
time a webhook replays or a job partially fails, and once it drifts you cannot tell whether the
guest is right or the system is. Materialise it as a view or a periodically-refreshed cache
column that is *derived and re-derivable*, never authoritative.

**`idempotency_key` is mandatory on every write.** Square replays webhooks. Two identical earn
events must collapse to one.

## 2. Tiers and rewards

```sql
loyalty_tiers(id, program_id, name, threshold_points, threshold_window_months,
              multiplier, perks jsonb, sort_order)
-- Bronze / Silver / Gold; multiplier boosts earn rate

rewards(id, org_id, program_id, name, description, image_url,
        cost_points, kind,        -- 'fixed_discount' | 'percent_discount' | 'free_item' | 'custom'
        value_cents, menu_item_id NULL,
        min_spend_cents, valid_venues[], valid_days[], valid_from, valid_to,
        max_redemptions_total, max_redemptions_per_customer, is_active)

redemptions(id, org_id, account_id, reward_id, code, status,
            issued_at, expires_at, redeemed_at, redeemed_venue_id,
            redeemed_staff_id, transaction_id NULL)
-- status: 'issued' | 'redeemed' | 'expired' | 'voided'
```

## 3. The counter-redemption seam (the hard part)

Online redemption is trivial. **In-venue redemption is the module's real design problem**,
because the POS is Square and Square does not know about your points.

Flow:
1. Guest identifies at the counter — phone number, QR in their confirmation email/SMS, or
   name lookup by staff.
2. Your staff screen (a phone-friendly web view, no app install) shows their balance and
   eligible rewards.
3. Staff selects a reward → your system issues a **single-use short code** and marks the
   redemption `issued` with a short expiry (~15 min).
4. Staff applies the matching discount in Square — either as a pre-configured Square discount,
   or pushed onto the open Square order via the Orders API if that path is available.
5. Square's payment webhook arrives → matched to the pending redemption by amount + venue +
   time window (and order id where available) → redemption marked `redeemed`, points burned,
   linked to the `transaction`.

**Points burn on confirmed payment, never on code issue.** Otherwise a cancelled order eats
the guest's points and you get the angriest support ticket in the product.

Design the whole flow to degrade gracefully: if the webhook never arrives, the redemption
expires and points are untouched. Staff can force-confirm with a reason, audit-logged.

## 4. Earning — where points come from

- **Online orders** — direct, at payment confirmation, from your own ledger.
- **In-venue Square payments** — from the webhook, *if the transaction resolves to a customer*.
  This is the identity problem: a card swipe with no email is an anonymous transaction.

Three ways to close that gap, in order of friction:
1. Guest gives phone/QR at the counter → staff attaches it before payment.
2. Card fingerprint from the Square payment matches a `customer_identity` recorded from a
   previous identified visit — automatic thereafter. **Requires confirming Square exposes a
   stable card fingerprint; see `VERIFY.md`.** If it does, this is the highest-leverage
   mechanism in the entire platform: one identified visit makes every future visit automatic.
   *Update 2026-09-30:* this route is opt-in only (`SCHEMA.md` §2a) and weaker than assumed.
   One venue's measured data: about 79% of in-store payments are contactless and the
   fingerprint alone recovers about 1 in 6; the account-level reference (PAR) covers about 74%
   of card payments but is undocumented in Square's API and restricted by card-scheme rules.
   Treat route 1 as the primary mechanism and this as a bonus for opted-in guests.
3. Receipt-based post-hoc claim (guest enters a receipt number later). Low uptake, but a
   cheap backstop.

## 5. Why not Square Loyalty

Worth being explicit, because it will come up in every sales call: Square Loyalty locks the
guest graph inside Square, is per-location by default (breaking groups), cannot express your
reward logic, and — decisively — **gives you no attribution join back to Criota**. The whole
reason to own loyalty is that it is the mechanism by which an anonymous walk-in becomes a
known, attributable customer.

## 6. Config surface

`earn_model` · `points_per_dollar` · `point_value` · `expiry_months` · `tiers[]`
· `enrolment_bonus` · `birthday_bonus` · `redemption_expiry_minutes`
· `allow_staff_force_confirm` · `identify_by[]` (phone/qr/name/card)
