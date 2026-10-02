# Pipedline

A free, open harness for a hospitality venue's AI assistant.

A model on its own can talk and draft. Pipedline supplies what it lacks to run a venue: a record
that persists (sales, customers, consent), exact definitions of the measures a venue needs,
guardrails (roles, yes-before-change, a log), work that happens with no chat open, and the tools
to do it over MCP, including setting the venue up. The owner confirms every change.

Optional plugins host things too (website, QR menu, ordering, delivery, loyalty), and third-party
services plug in the same way. A venue that keeps every tool it has and adds only Pipedline has
the whole product. The contract is `docs/PIPEDLINE.md`.

**Status: pre-release.** Built and tested against simulated providers and the Square sandbox. It
has never run a real venue and has never been deployed. Read `docs/STATUS.md` before relying on
anything.

- Direction: `docs/PIPEDLINE.md`
- Running it yourself: `docs/SELF_HOSTING.md`
- Writing a plugin: `docs/PLUGINS.md`
- Design: `docs/00_INDEX.md`
- Working in the code: `CLAUDE.md`
- What is verified and what is not: `docs/STATUS.md`

```bash
pnpm install
pnpm test          # service tests against an embedded Postgres (no Docker needed)
pnpm dev:stack     # local stack with simulated providers; see docs/STATUS.md "Run it"
```

## Licence

AGPL-3.0-only (`LICENSE`). You may run and modify it freely. If you offer it to others as a
hosted service, you must publish your changes under the same licence.
