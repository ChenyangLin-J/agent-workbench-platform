import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchConfiguration,
  dispatchConsumerPreflights,
  pipelineTriggerBody,
} from "../.github/scripts/dispatch-consumer-preflights.mjs";

test("consumer dispatch configuration contains no implicit credentials", () => {
  assert.deepEqual(dispatchConfiguration("personal", {}), {
    consumer: "personal",
    url: "",
    token: "",
    ref: "main",
  });
});

test("GitLab trigger body binds the exact candidate SHA", () => {
  const candidateSha = "a".repeat(40);
  const body = pipelineTriggerBody({ token: "secret", ref: "main", candidateSha });
  assert.equal(body.get("token"), "secret");
  assert.equal(body.get("ref"), "main");
  assert.equal(body.get("variables[PLATFORM_CANDIDATE_SHA]"), candidateSha);
  assert.throws(() => pipelineTriggerBody({ token: "x", ref: "main", candidateSha: "main" }), /full commit SHA/);
});

test("consumer dispatch skips missing configuration and dispatches configured consumers", async () => {
  const calls = [];
  const result = await dispatchConsumerPreflights({
    consumers: "personal,datamama,data-skill-lab",
    candidateSha: "b".repeat(40),
    environment: {
      PERSONAL_GITLAB_TRIGGER_URL: "https://gitlab.example/api/v4/projects/1/trigger/pipeline",
      PERSONAL_GITLAB_TRIGGER_TOKEN: "personal-token",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ id: 42, web_url: "https://gitlab.example/p/42" }) };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body.get("variables[PLATFORM_CANDIDATE_SHA]"), "b".repeat(40));
  assert.deepEqual(result.results, [
    { consumer: "personal", dispatched: true, pipelineId: 42, webUrl: "https://gitlab.example/p/42" },
    { consumer: "datamama", dispatched: false, reason: "trigger-not-configured" },
  ]);
});
