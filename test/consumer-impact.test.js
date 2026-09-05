import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyChangedPaths,
  changedRootExportSources,
  parseConsumerList,
  rootExportMap,
  validateConsumerAcceptance,
} from "../.github/scripts/consumer-impact.mjs";

test("repository-only changes do not request consumer acceptance", () => {
  const impact = classifyChangedPaths([
    ".github/workflows/release.yml",
    "docs/operations/RELEASING.md",
    "package.json",
    "package-lock.json",
    "test/session-client.test.js",
  ]);
  assert.deepEqual(impact.consumers, []);
  assert.deepEqual(impact.surfaces, ["repository-workflow"]);
});

test("a real package contract change requests every consumer", () => {
  const impact = classifyChangedPaths(["package.json", "@package-contract"]);
  assert.deepEqual(impact.consumers, [
    "agent-terminal",
    "data-skill-lab",
    "datamama",
    "personal",
  ]);
});

test("an additive root export follows the source module consumer surface", () => {
  const base = "export { oldName } from './session-client.js';\n";
  const head = "export { oldName, newName } from './session-client.js';\n";
  assert.equal(rootExportMap(head).analyzable, true);
  assert.deepEqual(changedRootExportSources(base, head), ["src/session-client.js"]);
  const impact = classifyChangedPaths(["@public-export:src/session-client.js"]);
  assert.deepEqual(impact.consumers, ["datamama", "personal"]);
  assert.deepEqual(impact.surfaces, ["public-package-contract"]);
});

test("non-barrel root code remains conservative", () => {
  assert.equal(rootExportMap("export const value = 1;\n").analyzable, false);
  assert.equal(changedRootExportSources("", "export const value = 1;\n"), null);
});

test("runtime changes request every current consumer", () => {
  const impact = classifyChangedPaths(["src/runtime/core/session-kernel.js"]);
  assert.deepEqual(impact.consumers, [
    "agent-terminal",
    "data-skill-lab",
    "datamama",
    "personal",
  ]);
  assert.deepEqual(impact.surfaces, ["runtime-session-contract"]);
});

test("environment changes request constrained-host consumers", () => {
  const impact = classifyChangedPaths(["src/environment/minimal-host.js"]);
  assert.deepEqual(impact.consumers, ["data-skill-lab", "datamama"]);
});

test("an explicit narrower override requires a reason and remains visible", () => {
  assert.throws(
    () => classifyChangedPaths(["src/session-client.js"], { override: "personal" }),
    /requires --reason/,
  );
  const impact = classifyChangedPaths(["src/session-client.js"], {
    override: "personal",
    overrideReason: "Only new exports; Minimal Host imports are unchanged.",
  });
  assert.deepEqual(impact.recommendedConsumers, ["datamama", "personal"]);
  assert.deepEqual(impact.consumers, ["personal"]);
  assert.equal(impact.override.reason, "Only new exports; Minimal Host imports are unchanged.");
});

test("consumer override parsing rejects unknown names", () => {
  assert.deepEqual(parseConsumerList("personal,datamama,personal"), ["datamama", "personal"]);
  assert.deepEqual(parseConsumerList("none"), []);
  assert.throws(() => parseConsumerList("other"), /Unknown consumer/);
});

test("release acceptance must cover every required consumer", () => {
  const candidateSha = "a".repeat(40);
  const evidence = JSON.stringify({
    schema: "agent-workbench.consumer-acceptance-set/v1",
    platformCommit: candidateSha,
    reference: "consumer artifacts",
    acceptances: [
      {
        consumer: "personal",
        consumerCommit: "b".repeat(40),
        platformCommit: candidateSha,
        platformWorktreeDirty: false,
        consumerWorktreeDirty: false,
        ok: true,
        formalEvidence: true,
        gate: "core:accept",
        candidateMounted: true,
        skippedRequiredTests: 0,
      },
      {
        consumer: "datamama",
        consumerCommit: "c".repeat(40),
        platformCommit: candidateSha,
        platformWorktreeDirty: false,
        consumerWorktreeDirty: false,
        ok: true,
        formalEvidence: true,
        gate: "contract",
        candidateMounted: true,
        gatewayMounted: true,
        requiredBrowserTestsRan: true,
        skippedRequiredTests: 0,
      },
    ],
  });
  assert.deepEqual(validateConsumerAcceptance({
    required: "personal,datamama",
    evidence,
    candidateSha,
  }).acceptedConsumers, ["datamama", "personal"]);
  assert.deepEqual(validateConsumerAcceptance({
    required: "",
    evidence: JSON.stringify({
      schema: "agent-workbench.consumer-acceptance-set/v1",
      platformCommit: candidateSha,
      acceptances: [],
    }),
    candidateSha,
  }).acceptedConsumers, []);
  assert.throws(() => validateConsumerAcceptance({
    required: "personal,datamama",
    evidence: JSON.stringify({
      schema: "agent-workbench.consumer-acceptance-set/v1",
      platformCommit: candidateSha,
      acceptances: [JSON.parse(evidence).acceptances[0]],
    }),
    candidateSha,
  }), /Missing consumer acceptance: datamama/);
  assert.throws(() => validateConsumerAcceptance({
    required: "",
    evidence: "",
    candidateSha,
  }), /valid JSON/);
  assert.throws(() => validateConsumerAcceptance({
    required: "datamama",
    evidence: JSON.stringify({
      ...JSON.parse(evidence),
      acceptances: [{ ...JSON.parse(evidence).acceptances[1], gatewayMounted: false }],
    }),
    candidateSha,
  }), /candidate-mounted Gateway/);
});
