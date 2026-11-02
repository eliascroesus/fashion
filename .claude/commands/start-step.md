---
description: Start one build step from docs/BUILD_PLAN.md (e.g. /start-step 2.3)
argument-hint: <step number, e.g. 2.3>
---

We are building Outfitly. Today's task is **Step $ARGUMENTS only**.

1. Read `CLAUDE.md`, `docs/PROGRESS.md`, and Step $ARGUMENTS in `docs/BUILD_PLAN.md` (plus the data-model table and anything the step references). If PROGRESS.md says an earlier step is unfinished or its phase gate is not passed, stop and tell me before doing anything.
2. Read the existing code this step touches.
3. Plan mode: show me a short plan — files you will create or change, database migrations, any new packages (must be in the locked stack), and how you will test it. Wait for my OK before writing code.
4. Build it. Follow the locked stack and rules in CLAUDE.md. Do not build anything from later steps.
5. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` until all pass. Then go through every "Done when" item of the step and report PASS/FAIL with evidence.
6. Run the `step-reviewer` sub-agent on your changes for Step $ARGUMENTS and fix what it finds.
7. Tell me, in plain language, exactly how to test it myself (on my phone or in the browser).
8. Update `docs/PROGRESS.md`, commit on a branch named `phase-<phase>-step-<step with dash>` (e.g. `phase-2-step-2-3`), push, and open a pull request with the checklist results in the description.
