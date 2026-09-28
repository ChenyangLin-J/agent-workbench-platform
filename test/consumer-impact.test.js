import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyChangedPaths,
  changedRootExportSources,
  parseConsumerList,
  rootExportMap,
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
