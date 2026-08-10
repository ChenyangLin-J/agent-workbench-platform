# Agent Workbench Platform Rules

- Keep this package product-neutral. Product navigation, projects, tasks, memories, credentials, accounts, profiles, and deployment policy belong in consumer repositories.
- Preserve runtime isolation: consumers must supply their own connection, data directory, browser profile, and product context.
- Shared abstractions must be verified with both project-free and project-scoped Session fixtures.
- Browser Provider discovery must remain process-free; only real tool calls may start the provider.
- Stateful Browser Provider calls stay serialized, with zero idle instances and bounded teardown.
- Update current documentation directly; do not add V2, final, or latest variants.
