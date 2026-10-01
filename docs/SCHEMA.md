# SCHEMA — The spine

> The spine is what every module hangs off. Get it right once; modules are replaceable, this is not.
> Convention: every table carries `org_id`; venue-scoped tables also carry `venue_id`. Every index
> leads with the tenant column. All timestamps `timestamptz`, all money in integer minor units
> (cents) with an explicit `currency`.

## 1. Tenancy

```sql
orgs(id, slug, legal_name, trading_name, abn, country, currency,
     status, plan, created_at)

venues(id, org_id, slug, name, timezone, address_line1, address_line2,
       suburb, state, postcode, lat, lng, phone, email,
       status, opened_at, created_at)

domains(id, org_id, venue_id NULL, host UNIQUE, is_primary,
        provider_domain_id, verified_at, created_at)
-- venue_id NULL = org-level site (a group's brand site)

trading_hours(id, venue_id, day_of_week, opens_at, closes_at, service_type)
hour_exceptions(id, venue_id, date, closed, opens_at, closes_at, reason)
-- public holidays, private events, kitchen closures
```

## 2. Identity — the asset

The hardest and most valuable part. A guest appears as a walk-in card swipe, an online pickup
order, a booking phone number, and an email subscriber. All four are one person.

```sql
customers(id, org_id, primary_email, primary_phone, first_name, last_name,
          birthday, created_at, first_seen_venue_id,
          -- attribution, stamped ONCE at creation, never updated:
          acquisition_source,      -- 'criota' | 'organic' | 'walk-in' | 'referral' | 'meta' | 'google'
          acquisition_creator_id,  -- Criota creator, nullable
          acquisition_campaign_id,
          acquisition_code,        -- the promo/offer code used
          acquisition_landing_path,
          acquisition_at)

customer_identities(id, org_id, customer_id, kind, value, verified_at, source, created_at)
-- kind: 'email' | 'phone' | 'card_fingerprint' | 'loyalty_qr' | 'square_customer_id' | 'device_id'
-- UNIQUE(org_id, kind, value)  ← this is the join key that merges a walk-in to a subscriber
-- card kinds: consent-gated and stored as a per-org keyed hash; see §2a

customer_merges(id, org_id, winner_customer_id, loser_customer_id, merged_at, merged_by, reason)
-- merges happen; keep the audit trail so reporting can be re-derived
```

**Why `customer_identities` is a separate table:** identity arrives incrementally and out of
order. A card fingerprint from an in-venue Square payment has no email attached. Later that
person books with a phone number, later still they subscribe with an email. Each new identity
either matches an existing customer (merge) or creates one. A single `customers` table with
email/phone columns cannot represent this and will silently fragment your guest graph — which
is the exact asset Criota needs.

**Attribution is write-once.** If a customer's first touch was a Criota creator's video, that
fact must survive every later interaction. Columns are stamped at INSERT and never updated;
subsequent campaign touches go to `customer_touchpoints`, not here.

```sql
customer_touchpoints(id, org_id, customer_id, occurred_at, channel, campaign_id,
                     creator_id, code, metadata jsonb)
-- every subsequent marketing touch; feeds multi-touch attribution later
```

## 2a. Consent and card identifiers (added 2026-09-30)

Added after research into the card-scheme rules and Australian privacy law
(not legal advice; a privacy lawyer signs off the wording before launch). Consent is part of
the identity spine, not only of `comms`.

```sql
consents(id, org_id, customer_id, purpose, status,
         wording_version, source, source_detail, ip, consented_at, revoked_at)
-- purpose: 'card_recognition' | 'marketing_email' | 'marketing_sms' | 'ad_platform_sharing'
-- one row per purpose; each is its own unticked box, never bundled into terms

consent_wordings(version, purpose, text, effective_from)
-- the exact words shown, so "what did this guest agree to" is answerable
```

**The card checkbox (decided 2026-09-30).** A separate, unticked box at sign-up and at QR or
online checkout. Starting wording, for a privacy lawyer to settle:

> Recognise this card, including on my phone, when I shop here again. Add those purchases to my
> profile, and use them to measure which offers, ads and creators bring me in. Creators and
> advertisers see totals only, never my details.

That one box covers recognition and the attribution that depends on it, because the wording
says so. It covers **this venue only**. It does not cover matching the card at another venue,
and it does not settle whether we, a separate company from the venue, may hold the card
reference on the venue's behalf at all: that is question 4 of the six drafted for Square
(`VERIFY.md` #12). Until Square answers, nothing here may depend on card recognition.

Rules, each enforced in code rather than by convention:

1. **A card identifier becomes an identity only with `card_recognition` consent.** No consent,
   no `customer_identities` row of a card kind. Revoking deletes those rows.
2. **Card identifiers are stored as a per-org keyed hash, never raw.** Square documents its card
   `fingerprint` as identifying a card "across multiple locations within a single application".
   We are one application connected to every venue, so a raw value would be the same string at
   every venue: a cross-merchant join key sitting in our database. `HMAC(org_secret, value)`
   makes that join impossible by construction, not by policy.
3. **Strip card identifiers from `transactions.raw` at ingest.** The raw provider payload
   carries them. An anonymous payment keeps its amount, lines and time; it does not keep a
   handle that could identify the guest later.
4. **No back-fill.** Recognition starts at `consented_at`. Because of rule 3 there is nothing
   earlier to match against.
5. **Nothing guest-level leaves an org.** Criota and any other plug receive per-venue outcomes
   above a minimum cohort size (`modules/hub.md` §7). No cross-org join on any identity kind.
6. **One-step unlink, unsubscribe and delete**, per purpose.

Consequence for the design: automatic recognition of a returning card is an opted-in feature
for known guests, not a background sweep over every tap. The main dine-in identity route is a
guest action (QR order, loyalty QR, phone at the counter).

## 3. Transactions — the ledger

```sql
transactions(id, org_id, venue_id, occurred_at,
             source,          -- 'square' | 'online-order' | 'pos' | 'manual'
             external_ref,    -- Square payment id; UNIQUE(org_id, source, external_ref)
             customer_id NULL,
             channel,         -- 'dine-in' | 'pickup' | 'delivery' | 'catering'
             subtotal, discount_total, tax_total, tip_total, total, currency,
             tender_type, staff_id NULL, table_id NULL,
             status,          -- 'pending' | 'completed' | 'refunded' | 'voided'
             raw jsonb, ingested_at)

transaction_lines(id, org_id, transaction_id, line_no, menu_item_id NULL,
                  name_snapshot, qty, unit_price, modifiers jsonb,
                  discount_amount, tax_amount, total)

transaction_attributions(id, org_id, transaction_id, customer_id,
                         creator_id NULL, campaign_id NULL, code NULL,
                         model, confidence, attributed_at)
-- what Criota reads. Separate table so attribution logic can be re-run/versioned
-- without mutating the immutable ledger.
```

**`UNIQUE(org_id, source, external_ref)`** is your idempotency guarantee. Square will replay
webhooks. Without this constraint you will double-count revenue and double-award loyalty points,
and you will find out from a customer, not a test.

**`name_snapshot` on lines** — menu items get renamed and deleted; a two-year-old receipt must
still render. Never join historical lines to live menu rows for display.

## 4. Events — the analytics stream

```sql
events(id, org_id, venue_id NULL, customer_id NULL, session_id,
       name, occurred_at, source, properties jsonb,
       utm_source, utm_medium, utm_campaign, creator_id, code)
```

One append-only stream: page views, menu views, add-to-cart, checkout started, booking started,
booking confirmed, code redeemed, email opened, SMS clicked. First-party, so no cookie-consent
cliff and no ad-blocker gap. This plus `transactions` is the entire attribution substrate.

Partition by month once volume justifies it; hundreds of venues will get there.

## 5. Staff & access

```sql
staff(id, org_id, user_id, first_name, last_name, email, phone, status)
staff_venues(staff_id, venue_id, role)
-- role: 'owner' | 'manager' | 'host' | 'kitchen' | 'front-of-house' | 'read-only'
```

Roles are per-venue: a group manager runs two sites, a host runs one. Platform-side admin
(you) is a separate `platform_admins` table — never a role inside a tenant's org, or a
compromised restaurant account escalates across tenants.

## 6. Brand & content

```sql
brands(id, org_id, venue_id NULL,      -- venue_id set = per-venue override
       tokens jsonb,                    -- typography, colour, radius, spacing, imagery
       logo_svg_url, logo_raster_url, logo_mark_url,
       layout_skeleton, tone_of_voice, updated_at)

pages(id, org_id, venue_id NULL, slug, title, blocks jsonb,
      seo_title, seo_description, og_image_url, published_at)
```

## 7. Modules

```sql
modules(key PRIMARY KEY, name, description, config_schema_version)
venue_modules(venue_id, module_key, enabled, config jsonb, version, enabled_at)
```

## 8. Audit

```sql
audit_log(id, org_id, venue_id NULL, actor_type, actor_id, action,
          entity_type, entity_id, before jsonb, after jsonb, ip, occurred_at)
```

Append-only. Covers staff actions, config changes, refunds, loyalty adjustments, comms sends.
Restaurants dispute point balances and refunds; this is the answer.
