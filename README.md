# Outfitly

Pinterest for outfits where everything is shoppable: scroll complete looks, tap one, see every piece with its price, and buy it.

This repository is built step by step with Claude Code.

## How to work in this repo

1. Open Claude Code in this repository.
2. Type `/status` to see where we are and what's next.
3. Type `/start-phase 1` (or just write "start phase 1"). Claude Code finds the next unfinished step, plans it and waits for your OK, then builds, tests, reviews and opens a pull request — and asks before moving to the next step. Use `/start-step 1.3` to jump to one specific step.
4. If something breaks, type `/stuck`.
5. Test it the way Claude Code explains, merge the pull request, and start the next step in a fresh session.

## Key files

| File | What it is |
| --- | --- |
| `CLAUDE.md` | Rules and locked tech stack. Claude Code reads it automatically. |
| `docs/BUILD_PLAN.md` | What Outfitly is, the data model, and every phase and step with its "Done when" checklist |
| `docs/PROGRESS.md` | Current step, what's done, decisions, known issues, measured numbers |
| `.claude/commands/` | The `/start-phase`, `/start-step`, `/stuck` and `/status` shortcuts |
| `.claude/agents/step-reviewer.md` | The reviewer that checks every step before its pull request |

## Version 1 (Phases 1–5)

Feed, look page, saves and boards, product list with prices, creator upload, Instagram-style personal / creator / business accounts, Google-ready web pages with link-in-bio. Expansion (Phases 6–9) starts after V1 is live.
