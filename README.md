# Pipedline

A free, open skeleton for a hospitality venue's operating system, built to be set up and run by
the venue's own AI assistant.

Every capability is a plugin a venue switches on: website, QR menu, online ordering, delivery,
loyalty, email and SMS, reviews, analytics. An MCP server lets the venue's assistant (Claude,
ChatGPT) read the venue's numbers, set the venue up, and act on its behalf, with the owner
confirming every change. Third-party services plug in the same way.

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
