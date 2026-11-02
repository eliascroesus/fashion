---
description: Work through a whole phase step by step (e.g. /start-phase 1)
argument-hint: <phase number, e.g. 1>
---

We are building Outfitly. Work through **Phase $ARGUMENTS** of `docs/BUILD_PLAN.md`, one step at a time.

1. Read `CLAUDE.md` and `docs/PROGRESS.md`. If the previous phase's gate is not passed, stop and tell me what's missing.
2. Find the first step in Phase $ARGUMENTS that is not marked done in `docs/PROGRESS.md`.
3. Do that step exactly as `/start-step` describes: plan mode and wait for my OK, build only that step, make typecheck / lint / tests pass, report every "Done when" item as PASS/FAIL, run the `step-reviewer` sub-agent and fix its findings, tell me in plain language how to test it, update `docs/PROGRESS.md`, commit on its own branch and open a pull request.
4. Then stop and ask me: "Step X.Y is done. Have you tested it and merged the pull request? Shall I start Step X.Z?" Do not start the next step until I say yes.
5. When I say yes: switch to `main`, pull the latest, and repeat from step 2.
6. Every 2 steps (or sooner if this session is getting long), tell me: "Good moment to start a fresh session — type /start-phase $ARGUMENTS there and I'll pick up from PROGRESS.md."
7. When every step of the phase is done, go through the phase gate checklist with me, item by item.
