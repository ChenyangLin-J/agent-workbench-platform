import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DISPATCHABLE_CONSUMERS = ["personal", "datamama"];

export function dispatchConfiguration(consumer, environment = process.env) {
  const prefix = consumer.replaceAll("-", "_").toUpperCase();
  return {
    consumer,
    url: String(environment[`${prefix}_GITLAB_TRIGGER_URL`] || "").trim(),
    token: String(environment[`${prefix}_GITLAB_TRIGGER_TOKEN`] || "").trim(),
    ref: String(environment[`${prefix}_GITLAB_REF`] || "main").trim(),
  };
}

export function pipelineTriggerBody({ token, ref, candidateSha }) {
  if (!/^[a-f\d]{40}$/i.test(String(candidateSha || ""))) {
    throw new Error("Platform candidate SHA must be a full commit SHA.");
  }
  const body = new URLSearchParams();
  body.set("token", token);
  body.set("ref", ref);
  body.set("variables[PLATFORM_CANDIDATE_SHA]", candidateSha.toLowerCase());
  return body;
}

export async function dispatchConsumerPreflights({
  consumers,
  candidateSha,
  environment = process.env,
  fetchImpl = fetch,
} = {}) {
  const requested = [...new Set(String(consumers || "").split(",").map((item) => item.trim()).filter(Boolean))];
  const results = [];
  for (const consumer of requested.filter((item) => DISPATCHABLE_CONSUMERS.includes(item))) {
    const config = dispatchConfiguration(consumer, environment);
    if (!config.url || !config.token) {
      results.push({ consumer, dispatched: false, reason: "trigger-not-configured" });
      continue;
    }
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: pipelineTriggerBody({ ...config, candidateSha }),
    });
    if (!response.ok) {
      throw new Error(`${consumer} GitLab trigger failed with HTTP ${response.status}.`);
    }
    const payload = await response.json();
    results.push({
      consumer,
      dispatched: true,
      pipelineId: payload.id || null,
      webUrl: payload.web_url || null,
    });
  }
  return { candidateSha: candidateSha.toLowerCase(), results };
}

function appendSummary(file, result) {
  if (!file) return;
  const lines = ["## Consumer candidate dispatch", "", `- Candidate: \`${result.candidateSha}\``];
  if (!result.results.length) lines.push("- No GitLab consumer dispatch required.");
  for (const item of result.results) {
    if (item.dispatched) lines.push(`- ${item.consumer}: dispatched${item.webUrl ? ` ([pipeline](${item.webUrl}))` : ""}`);
    else lines.push(`- ${item.consumer}: not dispatched (${item.reason})`);
  }
  lines.push("");
  appendFileSync(file, lines.join("\n"));
}

async function main() {
  const result = await dispatchConsumerPreflights({
    consumers: process.env.CONSUMER_DISPATCH_CONSUMERS,
    candidateSha: process.env.CONSUMER_DISPATCH_CANDIDATE,
  });
  console.log(JSON.stringify(result, null, 2));
  appendSummary(process.env.GITHUB_STEP_SUMMARY, result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
