import assert from "node:assert/strict";
import test from "node:test";

import { buildAcceptanceSet } from "../.github/scripts/build-acceptance-set.mjs";

test("acceptance set binds every consumer result to one Platform SHA", () => {
  const platformCommit = "a".repeat(40);
  const personal = { consumer: "personal", platformCommit };
  assert.deepEqual(buildAcceptanceSet({
    platformCommit,
    acceptances: [personal],
    reference: "GitLab artifact 42",
  }), {
    schema: "agent-workbench.consumer-acceptance-set/v1",
    platformCommit,
    reference: "GitLab artifact 42",
    acceptances: [personal],
  });
  assert.throws(() => buildAcceptanceSet({
    platformCommit,
    acceptances: [{ consumer: "personal", platformCommit: "b".repeat(40) }],
  }), /different Platform commit/);
  assert.throws(() => buildAcceptanceSet({
    platformCommit,
    acceptances: [personal, personal],
  }), /Duplicate acceptance/);
});
