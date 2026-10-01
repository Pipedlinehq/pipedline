# ONBOARDING — Intake, provisioning, go-live

**Onboarding is the bottleneck, not the code.** At hundreds of venues, time-to-live per
restaurant is the metric that decides whether this business works. Every hour of manual setup
multiplies by the number of restaurants you sell.

## 1. Sequence

```
Sold ─► Brand intake ─► Provision (automated) ─► Content build ─► Review ─► Live on subdomain
                                                                              │
                                              DNS handover ─► Custom domain ─┘ ─► Redirects live
```

**Live on the subdomain first, always.** Nothing waits on DNS. A restaurant can be sold on
Monday and live on Wednesday; the custom domain lands whenever they find their GoDaddy password.

## 2. Brand intake — what to capture

You asked what else is vital beyond typography/colour/logo. This is the full set; the wizard
should be multi-session, resumable, and show progress, because no owner completes this in one
sitting.

### Identity & legal
Legal entity name, trading name, ABN/ACN, registered address, primary contact (name, role,
mobile, email), billing contact, GST registration status.

### Brand
Logo (SVG preferred + raster + mark-only variant for favicons/avatars), colour palette
(primary, secondary, accent, surface, text — with a "pick from logo" helper), typography
(heading + body from a curated allowlist), tone-of-voice sample (3–4 sentences in their voice,
used to steer generated copy), brand adjectives, photography set (hero, food, room, team) with
a stock fallback library, and **layout skeleton choice** shown as live previews with their own
brand applied — not abstract thumbnails.

### Venue (per location)
Address, geocode, phone, public email, timezone, trading hours per day per service type,
holiday/exception calendar, capacity, cuisine tags, price band, licensed status, parking,
accessibility, dietary/allergen policy statement.

### Service configuration
Which services: dine-in · pickup · delivery · catering · functions. This is what drives module
enablement — the answer here is literally which modules get toggled on.

### Operations
Kitchen prep times by course, pacing caps (covers per slot, orders per slot), stations and
which sections route to them, table/floor plan (see below), existing POS, existing booking
system, existing ESP and list size + consent provenance.

### Menu — the labour-heavy item
Structured menu with sections, items, descriptions, prices, modifiers, dietary tags,
allergens, prep times. **Ingest from their existing PDF/website via LLM extraction, then
require human confirmation item by item.** This single step is the difference between a
4-hour onboarding and a 20-minute one, and it is worth building properly before venue #10.

### Floor plan (if dine-in)
Areas, tables with their **own labels**, seat ranges, shapes, positions, and the table
combinations their room actually supports. Guided visual editor; offer a starting template by
room shape.

### Comms
Marketing sending domain + DNS records, SMS sender ID and A2P registration details (**start
this on day one — it has real lead time and is the most common launch-slipper**), quiet hours,
consent provenance for any imported list, unsubscribe copy.

### Integrations & payments
Square OAuth connect (merchant + location ids), payout account, Google Business Profile claim,
social handles, review platform links.

### Content & policies
About/story copy, FAQ, cancellation policy, deposit policy, allergen disclaimer, privacy
policy, terms.

### Migration
**Existing site URL + sitemap for the 301 redirect map** — the single biggest cause of traffic
collapse in a website migration, and the step most likely to be skipped under deadline.
Historical customer list (with consent provenance), historical transactions if extractable.

### Criota
Default creator offer template, attribution codes, which venues participate.

## 3. Provisioning — automated, idempotent, resumable

One job, driven off the completed intake:

```
create org + venue rows
seed brand tokens + chosen skeleton
seed default pages from skeleton + intake copy
import menu → sections/items/modifiers
seed floor plan (if dine-in)
enable modules per declared services
create subdomain + attach to Vercel project
create Resend sending domain → surface DNS records
provision Twilio subaccount + number → start A2P registration
generate Square OAuth link → await connect
seed loyalty program defaults
import + map 301 redirects
seed staff accounts + send invites
```

Every step idempotent with a recorded status, so a failed step is retried rather than the whole
onboarding restarted. A platform-side status board shows every in-flight onboarding and what
each is blocked on — at 30 concurrent onboardings this board is how the business is run.

## 4. Go-live checklist (gated, not advisory)

Menu confirmed by owner · hours confirmed · Square connected and a test payment taken ·
transactional email delivering · SMS sender approved · booking test end-to-end · KDS screen
paired and receiving · loyalty enrolment tested · redirects mapped · structured data validating ·
Core Web Vitals within budget · staff trained and logged in.

## 5. Self-serve is the destination

Everything above is designed to be owner-completable. Early venues will need you in the loop —
that's fine and useful. But measure **manual-touch minutes per onboarding** from venue #1 and
drive it down deliberately. If it doesn't fall, hundreds of restaurants isn't reachable
regardless of how good the software is.
