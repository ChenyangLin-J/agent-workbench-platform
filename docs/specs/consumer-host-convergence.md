# Consumer Host Convergence

Lifecycle: active migration. This spec closes the gap between low-level Platform contracts and the built-in Minimal Host without introducing product objects into Platform.

## Problem

Full products can import shared React surfaces, but still need to rebuild request identity, optimistic state, authoritative snapshot reconciliation and event recovery. The Minimal Host implements the same concerns in its private browser entry. A consumer that starts from the closed Minimal Host cannot inject rich product extensions without depending on internal DOM or request behavior.

The missing unit is a product-neutral Host Kit: headless Session application controllers used by the built-in Minimal Host and available to full consumers. Consumers continue to own HTTP transport, stores, authorization, product context, paths, lifecycle and deployment.

## Target contract

Platform owns:

- client operation identity and retry-safe mutation state;
- authoritative Session snapshot plus optimistic message reconciliation;
- event replay, reconnect and polling coordination;
- Edit/Fork intent, queue and request state transitions;
- resource stage/commit/promotion coordination;
- stable React extension inputs that do not require DOM selectors.

Consumers own:

- endpoint construction, authentication and process lifecycle;
- persistence implementations and retention;
- product navigation, objects, labels and business extensions;
- local path authorization and external side effects.

The built-in Minimal Host must consume the same exported controllers. It may compose them with Environment-specific transport and storage, but it must not remain an unrelated reference implementation.

## Current milestone

The first slice exports `SessionClientOperationController` from `@agent-workbench/platform/session-client`. It assigns an idempotency key to a JSON-safe mutation payload, reuses that key when the same target and payload are retried after an uncertain response, and forgets it only after the caller confirms acceptance or explicitly discards it.

Minimal Host Session creation and Turn submission use this controller with the existing server-side reservation ledger. This closes the end-to-end retry gap for the built-in browser client and establishes the first reusable Host Kit boundary. `SessionWorkspace` also owns whole-detail file/directory drag routing, including Finder's opaque preview phase, so consumers no longer need a DOM event bridge after adopting this release. Consumer-specific stores remain adapters until they can adopt a released package containing these changes.

The next additive Host Kit slice exports authoritative-snapshot/optimistic-item reconciliation plus a transport-injected Session event controller from the same entry. The controller owns active-Turn, request, queue, live Agent delta, reconnect recovery and polling transitions. Consumers inject EventSource construction, snapshot/list refresh, extension recovery, product-event routing and error presentation. Both project-free and project-scoped fixtures exercise the same state transitions; unknown product context remains untouched.

## UI behavior

Reviewable interface reference: [Consumer Host Convergence UI](../mockups/consumer-host-convergence.html).

The Composer has one editing state: the textarea remains visible and no formatted-preview/edit step exists. An ordinary sentence uses the clipboard's plain text exactly, so multiplication asterisks and similar punctuation are not escaped in the submitted prompt. Headings, lists, tables, fenced code, blockquotes, and multi-paragraph rich content become Markdown attachments; long unstructured text keeps the existing plain-text attachment threshold. While a request is in flight, existing submitting states remain unchanged. If transport fails before a response is known, or the server reports that an identical reservation is still pending, the Composer restores the same user-visible draft; sending the unchanged request again reuses its operation identity. Changing the target or payload creates a new operation. A confirmed accepted response clears the retained identity.

## Remaining migration

1. Adopt the released reconciliation and event slice in Personal, delete its corresponding implementation, and reduce consumer tests to adapter/boot coverage.
2. Move Minimal Host's remaining React-owned refresh scheduling behind the exported application controller so both built-in and full consumers compose the same complete path.
3. Expose resource lifecycle coordination independently from filesystem storage and product authorization.
4. Make Minimal Host extensions injectable without consumer DOM or `fetch` patches.
5. Adopt each released slice in Personal and another independent consumer before deleting its previous implementation.

DataMama migration is intentionally separate from Platform implementation: its production branch and release lifecycle remain consumer-owned. Replace consumer patches only in an isolated worktree and only after the corresponding Platform contract has browser acceptance.

## Acceptance

- Repeating the same Session mutation after an unknown transport outcome sends the same valid idempotency key and body.
- A changed payload or target receives a new key.
- Accepted and explicitly discarded operations do not leak into later requests.
- The controller is browser-safe, product-free and covered through its public export.
- Authoritative snapshots replace canonical fields without dropping optimistic/live messages or a non-terminal known active Turn.
- Request, queue, delta, active-Turn and reconnect transitions behave identically with no context and with injected product context.
- Product events, extension recovery, transport and queue-failure presentation stay consumer callbacks.
- Minimal Host uses the export for Session creation and Turn submission.
- Plain rich-text paste preserves literal punctuation and remains in the editable Composer; structurally complex paste becomes an attachment and no Composer preview is rendered.
- Existing project-free Platform tests and Minimal Host browser smoke remain green.
- A Platform canary and a consumer's formal pin are recorded as separate states; no shared migration is called adopted from canary evidence alone.
