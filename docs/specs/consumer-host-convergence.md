# Consumer Host Composition

Lifecycle: active design for storage-independent resource coordination and configurable built-in Minimal Host extensions. Common Session application assembly and client orchestration are implemented and documented in [`../session-application.md`](../session-application.md).

## Current boundary

Minimal Host and Agent Web consume the same exported `SessionApplication` and `createSessionHostController`. Platform owns selection protection, operation identity, snapshot/event reconciliation, recovery, the Session list, finder, transcript, execution records, Composer and responsive drawer. Hosts supply transport adapters and authorized product actions.

The lower-level `@agent-workbench/platform/session-client` exports remain available for embedded consumers: `SessionClientOperationController`, authoritative-snapshot/optimistic-item reconciliation and `createSessionEventController`. They accept transport, product-event, extension-recovery and error callbacks without importing product state.

Generic React extension slots are available to full consumers. The built-in Minimal Host composes its own Environment transport, upload helpers and extensions in `src/environment/host-client.jsx`; these are not yet a general configuration API for injecting arbitrary product extensions into a deployed Minimal Host.

Consumers own their package pin, authorization, stores, paths, Runtime lifecycle and deployment. Adoption in one consumer does not upgrade another. Read the consumer's current package, lockfile and acceptance evidence rather than a version snapshot in this design.

## Remaining design

### Resource lifecycle coordination

Expose common staging, acceptance, commit and output-promotion coordination without coupling it to filesystem storage or a product endpoint. Resource identities and lifecycle semantics are defined by [`session-resources-and-storage.md`](session-resources-and-storage.md); its reference store and migration helpers do not by themselves provide a portable browser/Host coordinator.

The coordinator should accept authorized ResourceStore and transport adapters, preserve staged resources when a submission fails, and commit references only after acceptance. Unknown outcomes must retain the same operation identity. Consumers continue to own retention, physical storage, path access and external effects.

### Built-in Minimal Host extension configuration

Define an explicit composition entry for consumers that need to configure the deployed Minimal Host instead of mounting `SessionApplication` themselves. It should inject supported product actions and React slots through public contracts, without DOM selectors, patched `fetch`, or imports from private Host modules.

Reuse the existing application and controllers. Keep a project-free Host valid without requiring product objects. Extension loading, capability declarations and authorization must remain consumer-controlled; discovery and planning must not start processes or execute product effects.

## Implementation and adoption gate

These designs require their own reviewed scope before implementation. They do not reopen the completed Agent Web shared-UI migration or authorize consumer data migration.

- Publish new contracts additively and exercise them through public exports in project-free and project-scoped fixtures.
- Verify resource failure/retry/acceptance through injected storage and transport adapters, including cross-Session rejection and preserved staged resources.
- Verify configurable extensions in a mounted Minimal Host without private DOM or request patches.
- Let each affected consumer accept and pin a released contract before deleting its corresponding compatibility adapter.
- Keep ResourceStore migration, source retirement and deployment authorization with their owning consumer.

Release mechanics and consumer acceptance remain in [`../operations/RELEASING.md`](../operations/RELEASING.md). Physical microphone, real-device keyboard/touch and push acceptance belong to the consumer's ongoing product verification, not this composition design.
