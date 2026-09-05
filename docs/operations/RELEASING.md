# Platform Candidate, Consumer Acceptance and Release

This workflow applies when testing a Platform candidate, publishing `@agent-workbench/platform`, or adopting a new tag in a consumer.

## Truth sources

- `package.json` and `package-lock.json`: package version and dependency lock.
- `.github/workflows/test.yml`: push and pull-request tests plus candidate impact output.
- A tested Git commit SHA: immutable development candidate shared with consumers before release.
- `.github/workflows/release.yml`: explicit promotion of an accepted candidate.
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

The package version reserves the candidate's eventual stable tag; merging does not publish it. More Platform work may continue on `main` while a consumer tests an earlier exact SHA. If two unreleased candidates need different contents, each still receives its own version so either SHA can be promoted later without moving a tag.

When the bundled Codex/App Server version changes, the Runtime fixtures must
also cover both a fresh Session's first Turn and a Host restart between Session
creation and that first Turn. Existing-Session resume evidence does not replace
either case.

## Candidate impact

Every push and pull request runs Platform tests and classifies the changed surfaces. The result names the exact candidate SHA and recommends only the consumers whose mounted contracts may have changed. Repository workflow, tests and documentation alone require no consumer gate.

Run the same classifier locally with an explicit comparison base:

```bash
node .github/scripts/consumer-impact.mjs --base <accepted-platform-ref> --head HEAD
```

Path classification is deliberately conservative. Version-only package metadata is ignored, while dependency/export changes are treated as a public package contract. A file such as `src/session-client.js` can contain both full-consumer and Minimal Host behavior, so a narrower result requires an explicit reason:

```bash
CONSUMER_IMPACT_OVERRIDE=personal \
CONSUMER_IMPACT_REASON='Only new full-consumer exports; Minimal Host imports are unchanged.' \
node .github/scripts/consumer-impact.mjs --base <base> --head HEAD
```

An override changes the required gate, but the output retains both the recommendation and the reason for review.

## Consumer candidate acceptance

Consumers test the exact Platform SHA before it becomes a stable tag:

- Personal runs `npm run core:accept:candidate -- --platform-ref <full-sha>` or uses `--platform-path` while co-developing locally. The command builds and tests an isolated copy; it does not rewrite Personal's formal dependency.
- Datamama runs `./scripts/accept_platform_candidate.sh --platform-ref <sha-or-tag>` or uses `--platform-path` for the current Platform worktree. Its contract gate does not deploy production or replace the selected Run.
- Other consumers keep equivalent candidate entry points in their own repositories.

Formal candidate acceptance records the Platform SHA and consumer commit together, including whether either worktree was dirty. A later unrelated Platform commit does not invalidate that pair. Re-run only when the selected Platform SHA changes or the consumer commit changes across an affected boundary.

### Automation boundary

The candidate workflow separates fast breakage detection from formal release evidence:

- Root-barrel-only changes are traced to their re-exported source module when `src/index.js` remains a pure analyzable barrel. Unknown root logic and unclassified paths remain conservative; a narrower override still requires a concrete review reason.
- A push to Platform `main` dispatches impacted Personal and Datamama GitLab preflights when the corresponding trigger URL/token secrets are configured. Missing configuration is reported in the workflow summary rather than silently treated as acceptance. Data Skill Lab and Agent Terminal keep their own gates until dispatch endpoints exist.
- Personal's candidate job mounts the exact Platform SHA in an isolated worktree and emits the Platform/consumer commits, dirty state, gate and skipped-test count.
- Datamama's automated GitLab job is a credential-free `quick` preflight. Formal Datamama evidence comes from `contract` or `full`: it runs every required browser case, creates an isolated Environment/Run from the candidate and routes a disposable Gateway and real browser through that Run. The candidate probe uses temporary Session storage and does not send a model Turn or change the selected production Run.
- Promotion accepts only a structured `agent-workbench.consumer-acceptance-set/v1` document for the selected Platform SHA. Every required entry must be formal, clean, mounted, have zero skipped required tests and name a full consumer commit; Datamama must additionally prove its Gateway and browser path.

Cross-repository artifact download remains an operator/CI-orchestrator concern. Platform dispatch does not possess consumer credentials or rewrite consumer dependencies, and a preflight artifact is never promoted merely because it exists.

## Promote a stable release

Stable publication is an explicit GitHub Actions `workflow_dispatch`, not a side effect of pushing `main`. Supply:

- the exact accepted 40-character candidate SHA;
- the structured acceptance-set JSON for that SHA (an empty `acceptances` array is valid when impact is `platform-only`);
- an impact override and reason only when the conservative recommendation is too broad.

Build the document from downloaded consumer artifacts instead of retyping their fields:

```bash
node .github/scripts/build-acceptance-set.mjs \
  --platform-commit <full-sha> \
  --reference '<pipeline or artifact reference>' \
  --output acceptance-set.json \
  personal-candidate-acceptance.json \
  datamama-candidate-acceptance.json
```

Paste the contents of `acceptance-set.json` into `acceptance_evidence`. The release validator rechecks its Platform SHA, consumer commits, clean-worktree flags, mounted-candidate flags, gate names and skipped-test counts before any tag is created.

The release job installs dependencies, runs `npm test`, recomputes impact from the preceding stable tag, verifies the structured evidence covers every required consumer, and then:

- reads the version from `package.json`;
- verifies the selected commit is reachable from `main`;
- exits idempotently when the matching tag already points to that exact commit;
- fails rather than moving a matching tag that points elsewhere;
- otherwise creates and pushes the annotated `vX.Y.Z` tag and GitHub Release.

Do not manually move, overwrite, or delete a published tag to repair a release. Fix forward with a new version.

## Stable consumer adoption

Platform tests prove the shared contract; they do not prove a consumer product is usable.

| Affected surface | Required consumer evidence |
| --- | --- |
| Full-consumer Session Client or Host Kit behavior not mounted by Minimal Host | Personal candidate `core:accept`; repeat the narrow gate on the promoted tag when adopting |
| Minimal Host request/UI/Environment behavior used by a constrained product | Datamama `accept_platform_candidate.sh`; add its `full` gate when Environment, adapter or deployment composition changed |
| Persistence, Resource, Runtime, authentication, path authorization or breaking adapter contracts | Targeted tests plus the affected Personal/Datamama full gate; record any production canary separately |
| Project-free Runtime, capability isolation, Profile/lock or minimal host composition | Data Skill Lab baseline/candidate run with isolated Runtime and capability evidence |
| Session surface currently migrating into Agent Terminal | Agent Terminal App Server, PTY, multi-host, desktop and narrow-screen regression |
| Pure internal implementation with unchanged public behavior | Platform tests; document why no consumer run is required |

A consumer that chooses to deploy pins the promoted tag for the already accepted SHA and verifies that the tag resolves to that SHA. Shared state-machine cases already covered by Platform fixtures must not be duplicated in a consumer; consumer tests cover package mounting, adapters and product-owned side effects. Production acceptance remains separate. A successful Platform workflow must not automatically rewrite a consumer's formal dependency or compatibility statement.

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
