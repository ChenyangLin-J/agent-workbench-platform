# Platform Release and Consumer Adoption

This workflow applies when publishing `@agent-workbench/platform`, testing an unreleased Platform commit in a consumer, or adopting a new tag in a consumer.

Release and consumer acceptance are decoupled. Platform publishes a stable tag when its own tests pass. A consumer verifies a tag only when it chooses to adopt it; consumers that keep their current pin are unaffected.

## Truth sources

- `package.json` and `package-lock.json`: package version and dependency lock.
- `.github/workflows/test.yml`: push and pull-request tests plus impact classification.
- `.github/workflows/release.yml`: explicit publication of a tested `main` commit.
- Git tags and GitHub Releases: published package history and the surfaces each release changed.
- Consumer repositories: pinned tag, integration tests and adoption evidence.

Do not infer a release from a local checkout, README version example, or another consumer's dependency.

## Compatibility policy

| Change | Version policy | Consumer handling |
| --- | --- | --- |
| Backwards-compatible fix | Patch | A consumer may auto-adopt within its pinned minor only after its own tests pass |
| Additive contract or meaningful new behavior | Minor | Product-level impact review and explicit adoption |
| Breaking export, state, envelope or adapter contract | Major | Migration plan and coordinated consumer changes |
| Documentation only | No package bump | Link/fact validation; no package release expected |

During `0.x`, this repository still treats patch releases as compatible for automation. Any change that requires a consumer edit must not be shipped as a patch.

## Before merge

1. Run `git status --short` and isolate the intended diff.
2. Check public exports, Runtime/Feature state, persisted envelopes, UI actions, capability schema/lock, Browser lifecycle, credential/path safety and consumer adapters.
3. Run `npm test` for every package-bearing change.
4. Add or update project-free and project-scoped fixtures for changed shared behavior.
5. Update the stable contract or active spec when ownership, behavior or migration scope changed.
6. For changes under `src/`, `scripts/`, `package.json`, or `package-lock.json`, set a new compatible version in both package files. Never reuse an existing tag.

The package version reserves the commit's eventual stable tag; merging does not publish it. If two unreleased commits need different contents, each still receives its own version so either SHA can be published later without moving a tag.

When the bundled Codex/App Server version changes, the Runtime fixtures must
also cover both a fresh Session's first Turn and a Host restart between Session
creation and that first Turn. Existing-Session resume evidence does not replace
either case.

## Impact classification

Every push and pull request runs Platform tests and classifies the changed surfaces. The result names the exact commit SHA and lists the consumers whose mounted contracts may have changed. It is adoption guidance, not a release gate. Repository workflow, tests and documentation alone affect no consumer.

Run the same classifier locally with an explicit comparison base:

```bash
node .github/scripts/consumer-impact.mjs --base <previous-tag> --head HEAD
```

Path classification is deliberately conservative. Version-only package metadata is ignored, while dependency/export changes are treated as a public package contract. Root-barrel-only changes are traced to their re-exported source module when `src/index.js` remains a pure analyzable barrel. A file such as `src/session-client.js` can contain both full-consumer and Minimal Host behavior, so a narrower result requires an explicit reason:

```bash
CONSUMER_IMPACT_OVERRIDE=personal \
CONSUMER_IMPACT_REASON='Only new full-consumer exports; Minimal Host imports are unchanged.' \
node .github/scripts/consumer-impact.mjs --base <base> --head HEAD
```

The output retains both the recommendation and the override reason.

A push to Platform `main` also dispatches impacted Personal and Datamama GitLab preflights when the corresponding trigger URL/token secrets are configured. These are early breakage signals only; they never block or authorize a release. Missing configuration is reported in the workflow summary.

## Publish a stable release

Stable publication is an explicit GitHub Actions `workflow_dispatch`, not a side effect of pushing `main`. Supply:

- the exact 40-character `main` commit SHA to publish;
- an impact override and reason only when the conservative recommendation is too broad.

The release job installs dependencies, runs `npm test`, recomputes impact from the preceding stable tag, and then:

- reads the version from `package.json`;
- verifies the selected commit is reachable from `main`;
- exits idempotently when the matching tag already points to that exact commit;
- fails rather than moving a matching tag that points elsewhere;
- otherwise creates and pushes the annotated `vX.Y.Z` tag and GitHub Release, recording the consumers to verify on adoption and the changed surfaces in both.

Do not manually move, overwrite, or delete a published tag to repair a release. Fix forward with a new version.

## Consumer adoption

Platform tests prove the shared contract; they do not prove a consumer product is usable. When a consumer decides to adopt a tag, it reads the adoption guidance in every Release since its current pin and runs the matching evidence in its own repository before changing the pin:

| Affected surface | Consumer evidence on adoption |
| --- | --- |
| Full-consumer Session Client or Host Kit behavior not mounted by Minimal Host | Personal `core:accept` |
| Minimal Host request/UI/Environment behavior used by a constrained product | Datamama `accept_platform_candidate.sh`; add its `full` gate when Environment, adapter or deployment composition changed |
| Persistence, Resource, Runtime, authentication, path authorization or breaking adapter contracts | Targeted tests plus the affected consumer's full gate; record any production canary separately |
| Project-free Runtime, capability isolation, Profile/lock or minimal host composition | Data Skill Lab baseline/candidate run with isolated Runtime and capability evidence |
| Session surface currently migrating into Agent Terminal | Agent Terminal App Server, PTY, multi-host, desktop and narrow-screen regression |
| Pure internal implementation with unchanged public behavior | Platform tests; no consumer run required |

Adoption evidence records the Platform tag/SHA and consumer commit together and stays in the consumer repository or its Change. Shared state-machine cases already covered by Platform fixtures must not be duplicated in a consumer; consumer tests cover package mounting, adapters and product-owned side effects. Production acceptance remains separate. A Platform workflow must not rewrite a consumer's formal dependency or compatibility statement.

A consumer may also test an unreleased `main` commit before it is tagged, for example to co-develop a feature:

- Personal runs `npm run core:accept:candidate -- --platform-ref <full-sha>` or uses `--platform-path` for a local Platform worktree. It builds and tests an isolated copy without rewriting Personal's formal dependency.
- Datamama runs `./scripts/accept_platform_candidate.sh --platform-ref <sha-or-tag>` or uses `--platform-path`. Its contract gate does not deploy production or replace the selected Run.
- Other consumers keep equivalent entry points in their own repositories.

Such pre-release testing is optional and never a precondition for publishing.

## Repository closeout

After promotion and consumer adoption, give every temporary branch, linked worktree and retained artifact an explicit disposition:

- inspect `git worktree list` and each worktree's status; never remove a dirty worktree as routine cleanup;
- verify a clean worktree's commit is reachable from the retained branch or patch-equivalent after squash before proposing removal;
- do not classify a branch as redundant from merge ancestry alone when the repository uses squash merges;
- keep consumer release checkouts, backups, Runs and evidence under that consumer's retention policy rather than deleting them from Platform release automation;
- remove or archive a completed file from `docs/specs/` once its current contract has moved to stable architecture/operations documentation.

Repository cleanup is a separate, reviewable action. A successful release or a clean worktree is evidence that cleanup may be safe; it is not deletion authorization.

## Rollback

- Consumer problem: restore the last accepted tag in that consumer and rerun its smoke checks.
- Platform release problem: keep the immutable tag and publish a new compatible fix.
- Persisted-contract problem: stop adoption until forward/backward reading is proven; do not delete consumer data or rewrite it from Platform.
- UI migration problem: restore the consumer's previous surface until the shared path passes; remove duplicate code only after acceptance.
