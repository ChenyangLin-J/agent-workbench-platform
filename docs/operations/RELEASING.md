# Platform Release and Consumer Canary

This workflow applies when publishing `@agent-workbench/platform` or adopting a new tag in a consumer.

## Truth sources

- `package.json` and `package-lock.json`: package version and dependency lock.
- `.github/workflows/test.yml`: push and pull-request tests.
- `.github/workflows/release.yml`: `main` release automation.
- Git tags and GitHub Releases: published package history.
- Consumer repositories: pinned tag, integration tests and acceptance evidence.

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

When the bundled Codex/App Server version changes, the Runtime fixtures must
also cover both a fresh Session's first Turn and a Host restart between Session
creation and that first Turn. Existing-Session resume evidence does not replace
either case.

## Publish

On a push to `main`, GitHub Actions installs dependencies and runs `npm test` again. The release job then:

- reads the version from `package.json`;
- exits without a release when the matching tag already covers all package-bearing files;
- fails when package-bearing files changed after an existing tag without a version bump;
- otherwise creates and pushes the annotated `vX.Y.Z` tag and GitHub Release.

Do not manually move, overwrite, or delete a published tag to repair a release. Fix forward with a new version.

## Consumer canary

Platform tests prove the shared contract; they do not prove a consumer product is usable.

| Affected surface | Required consumer evidence |
| --- | --- |
| Additive shared Session UI or Host Kit behavior with unchanged persistence, authorization and adapter contracts | Personal `npm run core:accept`: pinned-package build, adapter/Host tests and minimal real-browser flow |
| Persistence, Resource, Runtime, authentication, path authorization, breaking adapter contracts or Personal-owned product behavior | Targeted migration tests plus Personal `npm run check`; record any production canary separately |
| Project-free Runtime, capability isolation, Profile/lock or minimal host composition | Data Skill Lab baseline/candidate run with isolated Runtime and capability evidence |
| Session surface currently migrating into Agent Terminal | Agent Terminal App Server, PTY, multi-host, desktop and narrow-screen regression |
| Pure internal implementation with unchanged public behavior | Platform tests; document why no consumer run is required |

A consumer pins the published tag, updates its lockfile, and runs the narrowest gate required by the affected boundary. Shared state-machine cases already covered by Platform fixtures must not be duplicated in a consumer; consumer tests cover package mounting, adapters and product-owned side effects. Manual or production acceptance is recorded separately. A successful Platform workflow must not automatically rewrite a consumer's compatibility statement.

## Rollback

- Consumer problem: restore the last accepted tag in that consumer and rerun its smoke checks.
- Platform release problem: keep the immutable tag and publish a new compatible fix.
- Persisted-contract problem: stop adoption until forward/backward reading is proven; do not delete consumer data or rewrite it from Platform.
- UI migration problem: restore the consumer's previous surface until the shared path passes; remove duplicate code only after acceptance.
