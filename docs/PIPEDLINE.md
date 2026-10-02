# Pipedline: the direction of record

Last changed 2026-10-02. **This file is the contract.** It says what Pipedline is, so that no
later piece of work quietly turns it into something else. Where it disagrees with an older
document, this file wins until that document is updated. Change it only by a decision of the
owner, and record the change in the log at the end.

## The object

**Pipedline is a harness for a hospitality venue's AI assistant.**

A model on its own can talk, plan and draft. It cannot hold a venue's records, does not know
what "repeat rate" means for a restaurant, has no rules about consent, and does nothing when no
chat is open. A harness is what surrounds the model and supplies those things. Pipedline is that,
for hospitality:

1. **A record that persists.** The sales ledger, customer identity and consent, in one place
   the venue controls.
2. **Exact definitions.** The measures a venue needs, each defined once, so every assistant
   gives the same answer.
3. **Hospitality parameters.** What to connect, what to measure, which consents to collect,
   in what order: the venue's whole data stack, planned against tested parameters.
4. **Guardrails.** Roles, yes-before-change, a log of everything done, autonomy in stages.
5. **Work with no chat open.** Schedules, incoming events, sending.
6. **Tools the assistant uses**, including setting the venue up, over MCP.

It is **not** an operating system that replaces a venue's till, ordering or booking stack. The
plugins that host things (website, QR menu, ordering, delivery, loyalty) exist and stay optional.
They are not the product, they are not why a venue comes, and nothing in the harness may depend
on a venue using them. A venue that keeps every tool it has and adds only Pipedline has the whole
product.

The test for any proposed work: **does it make a venue's own assistant more reliable at running
that venue?** If it only makes Pipedline a better website builder or ordering system, it is not
the priority.

## The terms

- **Free and open.** The software and every plugin are free. The code is AGPL-3.0-only.
- **Three ways to use it.** Run it yourself (free). Hosted, with your own assistant (free;
  anything that costs money to run is passed through at cost plus a stated percentage). Hosted,
  with our agent doing the work (usage at cost plus a percentage).
- **Agentic self-integration.** A venue owner connects their assistant (Claude or ChatGPT) and
  says "set my venue up". The assistant reads what is available, asks the owner the few things
  only they know, proposes each step, and does it when the owner says yes. Nobody is onboarded
  by us.
- **Plugins.** Capabilities are plugins a venue switches on. Third-party services (Criota first)
  are plugins too, and others may write them.
- **Its own venture.** Pipedline is not a person's brand. No individual is named on its site,
  in its messages or as its collector of data.
- **Where the money is:** courses on agent harnesses and data pipelines (bought by agencies,
  consultants and developers, not owners), usage on the hosted options, and Criota.

## What already fits

| Goal | Already in the engine |
|---|---|
| Plugins a venue switches on | Modules are toggleable per venue with a validated config (`venue_modules`, module contract) |
| Third-party plugins | Plug gateway, pinned and reviewed tool lists, the Criota plug with its outcomes boundary |
| The venue's own assistant | MCP server at `/api/mcp`, sign-in by OAuth or pasted key, scopes, roles, audit |
| Yes-before-change | Every write tool is `propose` then `commit`; approvals queue; hosted agents with modes |
| Data an agent can digest | Metric catalogue, `metrics_query`, event dictionary, digests |
| Consent and privacy | Consent purposes, per-org card hashing, nothing guest-level leaves an org |

27 assistant tools exist today. All of them are for **running** a venue. None is for **setting
one up**: onboarding is started by a platform admin and worked through console screens.

## What has to change

### 1. Self-serve start (no platform admin)
A person signs in by email at pipedline.com and gets an organisation and a first venue in draft.
Provisioning runs by itself. Platform admin stays for support and abuse, not for letting people in.
Needs: abuse limits (rate, verified email), a "draft until go-live" state, quotas per free org.

### 2. Setup tools over MCP
The assistant must be able to do everything the onboarding screens do:

| Tool | Does |
|---|---|
| `setup_status` | What is done, what is next, what only the owner can answer. The first thing an assistant calls. |
| `venue_describe` / `venue_update` | Name, address, hours, time zone, cuisine. |
| `plugins_list` | Every plugin: what it does, what it needs, what data it touches, whether it is on. |
| `plugin_enable` / `plugin_configure` / `plugin_disable` | Switch on with a config checked against the plugin's schema. |
| `connection_start` | Returns a sign-in link for the owner to open (Square and so on). The assistant never handles a password or token. |
| `connections_list` | What is connected, its health, what it can read and write. |
| `menu_import_start` / `menu_import_review` / `menu_import_confirm` | Bring a menu in from a link, a file or the till. |
| `site_preview` / `go_live_check` / `go_live` | What is missing before the venue is public; then publish. |
| `team_invite` | Add staff with a role. |

Every one that changes something is `propose` then `commit`, like the existing write tools.
`setup_status` returns the next step in plain words so an assistant with no prior knowledge can
drive the whole thing.

### 3. A public plugin catalogue
Each module and plug publishes a manifest: name, one-line purpose, what it needs, the tools it
adds, the data it reads and writes, its config schema, its consent implications. Served for
people (pipedline.com/plugins) and for agents (`/plugins.json`, `/llms.txt`), generated from the
module definitions so it cannot drift from the code.

### 4. Packaged for the assistants
One Pipedline plugin per assistant (Claude, ChatGPT): the connector address plus skills for the
recurring jobs (the seven in the Pipedline kit). Installing it is the whole of "getting started".
The exact packaging each assistant accepts is to be confirmed against its documentation.

### 5. Bring-your-own stack stays first-class
A venue that only wants answers from its existing till keeps its till. Read-only ledger ingest
(Square today) plus analytics plus the assistant is a complete, useful Pipedline with nothing
else switched on. Website, ordering and the rest are opt-in.

### 6. Free means the costs and duties are ours
Pipedline hosts venues' data and their connections. Before any real venue:

- the open items in `THREAT_MODEL.md` §12 (secret vault, data-handling terms, consent wording,
  incident plan);
- a production deployment (there has never been one), with backups and monitoring;
- per-org quotas, because free plus model usage plus outbound SMS can be abused;
- who pays for messages: a venue brings its own email, SMS and model keys, or usage is capped.

### 7. Open
Decide whether the engine's code is published, and under what licence. "Open ecosystem" at
minimum means the plugin contract, the manifests and the kit are public so others can write
plugins. Third-party plugins go through the existing review-and-pin step.

## What is deferred or cut by this direction

- Platform-admin-led onboarding as the main path (kept for support).
- Managed setup as a service (the earlier funnel step); courses replace it.
- Anything that assumes a paid plan.

## Order of work

1. Self-serve start and the setup tools (sections 1 and 2), tested by a scripted assistant that
   sets a venue up from nothing through MCP alone.
2. Plugin manifests and the catalogue (section 3).
3. Assistant packaging (section 4) and the Pipedline site pointing at it.
4. Production readiness (section 6), then the first real venue.

## Who runs the model, and what is charged (owner, 2026-10-01)

Pipedline is a harness for the venue's own LLM. Two ways to use it:

- **Bring your own assistant (free).** The venue connects Claude, ChatGPT or another assistant
  over MCP. Setup, brand kit, menu import and every job run on the venue's own subscription.
- **Hosted (usage-billed).** Pipedline runs the agent for the venue. The venue is billed what
  the usage cost plus a percentage, monthly. `llm_usage` already meters tokens per org.

Email, domains and the like must be self-serve inside the product, the way app-building platforms
do it: connect or buy a domain, switch on sending, no ticket to us.

Not yet designed: the billing itself (payment method, credits or invoice, tax), which other
metered costs are passed through (SMS, email volume, domains), and automated DNS for domains
and sending.

## Open source (owner, 2026-10-01)

The engine is published under **AGPL-3.0-only** (`LICENSE`). A venue or agency with its own
technical team may run the skeleton itself, with its own hosting, keys and agents, free and
without us. Anyone offering it as a hosted service must publish their changes. This is the third
way to use Pipedline, beside the two hosted ones above; it is what makes hosting a choice.

Before the repository is made public (none of this is done until `docs/STATUS.md` says so):

- fixture orgs and every document renamed away from any real business;
- the public repository starts from a clean snapshot: the private history, which contains
  business-specific planning documents, is not published;
- a check that no key, token or personal detail is in the published tree;
- a documented one-step way to run it with your own database and keys;
- the plugin contract written for outside authors.

## Open decisions (the owner's)

1. (settled: AGPL-3.0-only)
2. Usage billing: prepaid credits or monthly invoice; the percentage; which costs besides tokens are passed through.
3. Which real venue goes first, as a read-only shadow?

## Log of decisions

| Date | Decision |
|---|---|
| 2026-09-30 | v1 cut to website, QR, ordering, delivery and the hub; bookings, full kitchen display and own POS deferred. A separate unticked card checkbox for card recognition. |
| 2026-10-01 | Built: all v1 modules, console, venue site, MCP server, analytics. Square verified against the sandbox (adapter, ingest, sign-in, webhooks). |
| 2026-10-01 | Restaurant OS and Pipedline are one thing. Goal restated: free, plugin-based, set up by the venue's own assistant. Managed setup as a service dropped; courses replace it. |
| 2026-10-01 | Two hosted modes: your own assistant (free), our agent (usage at cost plus a percentage). Self-serve email and domains wanted, in-product. |
| 2026-10-01 | Run-it-yourself is the third, free way to use it. Licence: AGPL-3.0-only. |
| 2026-10-02 | Published at github.com/Pipedlinehq/pipedline as a clean snapshot. Self-serve start and 17 setup tools built. Self-hosting and plugin guides written by doing them. |
| 2026-10-02 | Hosted service live at app.pipedline.com (email only; sign-up page closed by default). |
| 2026-10-02 | Pipedline is its own venture: no individual named anywhere. |
| 2026-10-02 | **Positioning: a harness, not an OS.** The record, definitions, parameters, guardrails and tools around a venue's assistant are the product; the hosting plugins are optional. The data-stack guide becomes something the assistant runs (a planner over tested parameters), not prose. |
