# Agent Terminal Shared Session Migration

Lifecycle: active migration spec. This file contains changing consumer state; it is not the stable Platform architecture.

## Objective

Make Agent Terminal Web consume the current shared Session surfaces while retaining its Terminal product. The goal is one implementation of common Agent behavior, not identical products.

## Current baseline

As of 2026-08-28:

- Platform `v0.6.12` contains the shared Session workspace, mobile behavior, attachments, Side Chat, Subagent and Browser primitives needed for the migration.
- Personal pins `v0.6.12` and is the full-product canary.
- Agent Terminal pins `v0.6.12`. Its remote `main` uses the shared `SessionList`; local commit `2d26eec` adds an opt-in `SessionWorkspace` canary behind `?platformSession=1` while retaining the existing App Server UI as fallback. PTY Sessions are not part of the canary.
- Solvely Workbench is frozen and is not part of this migration.

Re-check both repositories before implementation; these version statements are migration state, not permanent facts.

## Ownership during migration

| Move to or keep in Platform | Keep in Agent Terminal |
| --- | --- |
| Transcript, Composer and execution detail behavior | Terminal/Text navigation and xterm/PTY |
| Attachment, preview and Markdown rendering contracts | Terminal shortcuts and terminal-specific Focus Mode |
| Side Chat and Subagent panels | PWA shell, memory and multi-host management |
| Session responsive layout and mobile-safe controls | Accounts, public sharing and host authorization |
| Browser Provider shared UI and product-neutral actions | Product-specific Browser binding and permissions |

## Sequence

1. Finish the opt-in canary adapter without deleting the existing detail implementation.
2. Verify transcript, Composer, queue, approvals, attachments, Side Chat, Subagents, Browser actions, mobile layout and multi-host behavior.
3. Obtain browser acceptance on desktop, iPad-width and phone-sized layouts using Agent Terminal's canary checklist.
4. Make the shared workspace the default while retaining an explicit fallback for the first accepted release.
5. Remove the corresponding duplicate App Server UI only after the default path remains accepted. Keep an explicit rollback commit or tag through that release.

Do not wait for the entire Agent Terminal product to become React before replacing the duplicated Session detail surface.

## Acceptance

- Existing Sessions load, page and continue without data migration or loss.
- Running, queued, interrupted, approval and completed states remain distinct.
- Attachment upload/open, file references, Markdown, math and visualization behavior match the shared contract.
- Side Chat refresh/close/delete and Subagent parent-child behavior pass their Platform invariants.
- Terminal/Text switching, PTY input, multi-host selection, memory and public-sharing behavior do not regress.
- Narrow-screen navigation, software keyboard, long code/table wrapping and touch-only controls remain usable.
- Agent Terminal no longer owns a second implementation of any migrated common surface.

## Out of scope

- Moving Agent Terminal product state, accounts, PTY or deployment into Platform.
- Migrating frozen Solvely Workbench.
- Extracting Data Skill Lab from Personal; it is a separate minimal-consumer project.
- Splitting Platform into multiple packages without a demonstrated consumer need.
