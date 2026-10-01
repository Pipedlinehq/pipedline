# Pipedline: the direction of record (2026-10-01)

Restaurant OS and Pipedline are the same thing. **Pipedline** is the name venues see
(pipedline.com); this repository is its engine. This file states the goal and what has to change
to reach it. Where it disagrees with an older doc, this file wins until that doc is updated.

## The goal

A free, open ecosystem in which a venue builds its own operating system from Pipedline plugins,
and the venue's own AI assistant does the building.

- **Free.** No plan, no per-venue fee, no paid tier of plugins.
- **Plugins.** Every capability (QR menu, ordering, loyalty, comms, analytics, reviews, delivery,
  website) is a plugin a venue switches on. Third-party services (Criota first) are plugins too.
- **Agentic self-integration.** A venue owner connects their assistant (Claude or ChatGPT) to
  Pipedline and says "set my venue up". The assistant reads what is available, asks the owner the
  few things only they know, proposes each step, and does it when the owner says yes. A person
  never has to be onboarded by us.
- **Where the money is:** courses on agent harnesses and data pipelines (bought by agencies,
  consultants and developers, not owners), and Criota.

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
