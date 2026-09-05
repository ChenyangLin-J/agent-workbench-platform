import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const KNOWN_CONSUMERS = [
  "personal",
  "datamama",
  "data-skill-lab",
  "agent-terminal",
];

const ALL_CONSUMERS = [...KNOWN_CONSUMERS];

const RULES = [
  {
    surface: "repository-workflow",
    consumers: [],
    matches: (file) =>
      file.startsWith(".github/")
      || file.startsWith("docs/")
      || file.startsWith("test/")
      || ["AGENTS.md", "LICENSE", "README.md", "package.json", "package-lock.json"].includes(file),
  },
  {
    surface: "minimal-host-environment",
    consumers: ["datamama", "data-skill-lab"],
    matches: (file) =>
      file.startsWith("src/environment/")
      || file.startsWith("bin/")
      || file.startsWith("containers/")
      || [
        "scripts/smoke-docker-environment.mjs",
        "scripts/smoke-docker-data-adapters.mjs",
        "scripts/smoke-minimal-host-browser.mjs",
      ].includes(file),
  },
  {
    surface: "session-client",
    consumers: ["personal", "datamama"],
    matches: (file) => file === "src/session-client.js",
  },
  {
    surface: "shared-session-ui",
    consumers: ["personal", "datamama", "agent-terminal"],
    matches: (file) =>
      file.startsWith("src/ui/")
      || file.startsWith("src/features/")
      || file === "src/ui-hooks.js"
      || file === "src/browser/session-status-element.js"
      || file === "src/browser/session-ui-elements.js"
      || file === "src/browser/subagent-elements.js",
  },
  {
    surface: "runtime-session-contract",
    consumers: ALL_CONSUMERS,
    matches: (file) =>
      file.startsWith("src/runtime/")
      || ["src/runtime.js", "src/session.js", "src/subagents.js"].includes(file),
  },
  {
    surface: "session-resources",
    consumers: ALL_CONSUMERS,
    matches: (file) => [
      "src/attachments.js",
      "src/resources.js",
      "src/filesystem-resource-store.js",
      "src/file-preview.js",
    ].includes(file),
  },
  {
    surface: "browser-provider",
    consumers: ALL_CONSUMERS,
    matches: (file) => file.startsWith("src/browser/"),
  },
  {
    surface: "capability-contract",
    consumers: ["personal", "datamama", "data-skill-lab"],
    matches: (file) =>
      file.startsWith("capabilities/")
      || file.startsWith("schemas/")
      || file === "src/capabilities.js"
      || file === "src/plugins.js"
      || file.startsWith("src/capability-"),
  },
  {
    surface: "public-package-contract",
    consumers: ALL_CONSUMERS,
    matches: (file) => file === "src/index.js" || file === "@package-contract",
  },
  {
    surface: "package-tooling",
    consumers: ALL_CONSUMERS,
    matches: (file) => file.startsWith("scripts/") || file.startsWith("src/"),
  },
];

function normalizedFiles(files) {
  return [...new Set(files.map((file) => String(file).trim().replaceAll(path.sep, "/")))]
    .filter(Boolean)
    .sort();
}

export function parseConsumerList(value) {
  if (value === undefined || value === null || value === "") return null;
  if (String(value).trim() === "none") return [];
  const consumers = [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
  const unknown = consumers.filter((consumer) => !KNOWN_CONSUMERS.includes(consumer));
  if (unknown.length) throw new Error(`Unknown consumer(s): ${unknown.join(", ")}`);
  return consumers.sort();
}

export function parseAcceptanceEvidence(value) {
  let evidence;
  try {
    evidence = JSON.parse(String(value || ""));
  } catch {
    throw new Error("Acceptance evidence must be valid JSON.");
  }
  if (evidence?.schema !== "agent-workbench.consumer-acceptance-set/v1") {
    throw new Error("Acceptance evidence must use agent-workbench.consumer-acceptance-set/v1.");
  }
  if (!/^[a-f\d]{40}$/i.test(String(evidence.platformCommit || ""))) {
    throw new Error("Acceptance evidence platformCommit must be a full commit SHA.");
  }
  if (!Array.isArray(evidence.acceptances)) {
    throw new Error("Acceptance evidence acceptances must be an array.");
  }
  return evidence;
}

export function validateConsumerAcceptance({ required, evidence, candidateSha }) {
  const requiredConsumers = parseConsumerList(required) ?? [];
  const evidenceSet = parseAcceptanceEvidence(evidence);
  const normalizedCandidate = String(candidateSha || "").toLowerCase();
  if (!/^[a-f\d]{40}$/.test(normalizedCandidate)) {
    throw new Error("Candidate SHA must be a full commit SHA.");
  }
  if (evidenceSet.platformCommit.toLowerCase() !== normalizedCandidate) {
    throw new Error("Acceptance evidence platformCommit does not match the selected candidate.");
  }
  const acceptedConsumers = [];
  const seen = new Set();
  for (const acceptance of evidenceSet.acceptances) {
    const consumer = String(acceptance?.consumer || "").trim();
    if (!KNOWN_CONSUMERS.includes(consumer)) throw new Error(`Unknown acceptance consumer: ${consumer || "(missing)"}`);
    if (seen.has(consumer)) throw new Error(`Duplicate consumer acceptance: ${consumer}`);
    seen.add(consumer);
    if (acceptance.ok !== true) throw new Error(`${consumer} acceptance did not pass.`);
    if (acceptance.formalEvidence !== true) throw new Error(`${consumer} acceptance is preview-only.`);
    if (String(acceptance.platformCommit || "").toLowerCase() !== normalizedCandidate) {
      throw new Error(`${consumer} acceptance targets a different Platform commit.`);
    }
    if (!/^[a-f\d]{40}$/i.test(String(acceptance.consumerCommit || ""))) {
      throw new Error(`${consumer} acceptance consumerCommit must be a full commit SHA.`);
    }
    if (acceptance.platformWorktreeDirty !== false || acceptance.consumerWorktreeDirty !== false) {
      throw new Error(`${consumer} acceptance must come from clean worktrees.`);
    }
    if (acceptance.candidateMounted !== true) {
      throw new Error(`${consumer} acceptance must mount the selected candidate.`);
    }
    if (acceptance.skippedRequiredTests !== 0) {
      throw new Error(`${consumer} acceptance has skipped required tests.`);
    }
    if (typeof acceptance.gate !== "string" || !acceptance.gate.trim()) {
      throw new Error(`${consumer} acceptance gate is required.`);
    }
    if (consumer === "personal" && acceptance.gate !== "core:accept") {
      throw new Error("Personal acceptance must use the core:accept gate.");
    }
    if (consumer === "datamama") {
      if (!new Set(["contract", "full"]).has(acceptance.gate)) {
        throw new Error("Datamama acceptance must use the contract or full gate.");
      }
      if (acceptance.gatewayMounted !== true) {
        throw new Error("Datamama acceptance must verify the candidate-mounted Gateway path.");
      }
      if (acceptance.requiredBrowserTestsRan !== true) {
        throw new Error("Datamama acceptance must run every required browser test.");
      }
    }
    acceptedConsumers.push(consumer);
  }
  acceptedConsumers.sort();
  const missing = requiredConsumers.filter((consumer) => !acceptedConsumers.includes(consumer));
  if (missing.length) throw new Error(`Missing consumer acceptance: ${missing.join(", ")}`);
  return {
    requiredConsumers,
    acceptedConsumers,
    platformCommit: normalizedCandidate,
    reference: String(evidenceSet.reference || "").trim() || null,
  };
}

export function rootExportMap(source) {
  const exports = new Map();
  const expression = /export\s*\{([\s\S]*?)\}\s*from\s*["'](\.\/[^"']+)["']\s*;?/g;
  let residual = String(source || "");
  for (const match of String(source || "").matchAll(expression)) {
    const names = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();
    exports.set(match[2], names);
    residual = residual.replace(match[0], "");
  }
  residual = residual.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trim();
  return { exports, analyzable: residual === "" };
}

export function changedRootExportSources(baseSource, headSource) {
  const base = rootExportMap(baseSource);
  const head = rootExportMap(headSource);
  if (!base.analyzable || !head.analyzable) return null;
  const sources = new Set([...base.exports.keys(), ...head.exports.keys()]);
  return [...sources]
    .filter((source) => JSON.stringify(base.exports.get(source) || []) !== JSON.stringify(head.exports.get(source) || []))
    .map((source) => `src/${source.replace(/^\.\//, "")}`)
    .sort();
}

export function classifyChangedPaths(files, { override, overrideReason } = {}) {
  const changedPaths = normalizedFiles(files);
  const surfaces = new Set();
  const recommendedConsumers = new Set();

  for (const file of changedPaths) {
    if (file.startsWith("@public-export:")) {
      surfaces.add("public-package-contract");
      const sourcePath = file.slice("@public-export:".length);
      const sourceRule = RULES.find((candidate) =>
        !new Set(["repository-workflow", "public-package-contract", "package-tooling"]).has(candidate.surface)
        && candidate.matches(sourcePath));
      (sourceRule?.consumers || ALL_CONSUMERS).forEach((consumer) => recommendedConsumers.add(consumer));
      continue;
    }
    const rule = RULES.find((candidate) => candidate.matches(file));
    if (!rule) {
      surfaces.add("unknown");
      ALL_CONSUMERS.forEach((consumer) => recommendedConsumers.add(consumer));
      continue;
    }
    surfaces.add(rule.surface);
    rule.consumers.forEach((consumer) => recommendedConsumers.add(consumer));
  }

  const parsedOverride = parseConsumerList(override);
  if (parsedOverride && !String(overrideReason || "").trim()) {
    throw new Error("An impact override requires --reason or CONSUMER_IMPACT_REASON.");
  }

  return {
    schema: "agent-workbench.consumer-impact/v1",
    changedPaths,
    surfaces: [...surfaces].sort(),
    recommendedConsumers: [...recommendedConsumers].sort(),
    consumers: parsedOverride ?? [...recommendedConsumers].sort(),
    override: parsedOverride === null
      ? null
      : { consumers: parsedOverride, reason: String(overrideReason).trim() },
  };
}

export function changedRootExportSourcesBetween(base, head = "HEAD", { cwd = process.cwd() } = {}) {
  try {
    const baseSource = execFileSync("git", ["show", `${base}:src/index.js`], { cwd, encoding: "utf8" });
    const headSource = execFileSync("git", ["show", `${head}:src/index.js`], { cwd, encoding: "utf8" });
    return changedRootExportSources(baseSource, headSource);
  } catch {
    return null;
  }
}

export function changedPathsBetween(base, head = "HEAD", { cwd = process.cwd() } = {}) {
  if (!base) throw new Error("A base Git ref is required.");
  let output;
  try {
    output = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...${head}`],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    output = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMRD", base, head],
      { cwd, encoding: "utf8" },
    );
  }
  return output.split(/\r?\n/).filter(Boolean);
}

function packageContractAt(ref, cwd) {
  const manifest = JSON.parse(execFileSync(
    "git",
    ["show", `${ref}:package.json`],
    { cwd, encoding: "utf8" },
  ));
  return {
    name: manifest.name,
    type: manifest.type,
    files: manifest.files,
    bin: manifest.bin,
    exports: manifest.exports,
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
    engines: manifest.engines,
  };
}

export function packageContractChanged(base, head = "HEAD", { cwd = process.cwd() } = {}) {
  try {
    return JSON.stringify(packageContractAt(base, cwd)) !== JSON.stringify(packageContractAt(head, cwd));
  } catch {
    return true;
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function appendGithubOutput(file, result, candidateSha) {
  if (!file) return;
  appendFileSync(file, [
    `candidate_sha=${candidateSha}`,
    `consumers=${result.consumers.join(",")}`,
    `recommended_consumers=${result.recommendedConsumers.join(",")}`,
    `surfaces=${result.surfaces.join(",")}`,
    `impact_json=${JSON.stringify(result)}`,
    "",
  ].join("\n"));
}

function appendGithubSummary(file, result, base, candidateSha) {
  if (!file) return;
  const consumers = result.consumers.length ? result.consumers.join(", ") : "platform-only";
  const override = result.override
    ? `\nOverride: ${result.override.reason} (${result.recommendedConsumers.join(", ") || "none"} → ${consumers})\n`
    : "";
  appendFileSync(file, [
    "## Consumer impact",
    "",
    `- Candidate: \`${candidateSha}\``,
    `- Base: \`${base}\``,
    `- Surfaces: ${result.surfaces.join(", ") || "none"}`,
    `- Required consumers: ${consumers}`,
    override,
    "",
  ].join("\n"));
}

async function main() {
  if (process.argv.includes("--validate-acceptance")) {
    const result = validateConsumerAcceptance({
      required: process.env.CONSUMER_ACCEPTANCE_REQUIRED,
      evidence: process.env.CONSUMER_ACCEPTANCE_EVIDENCE,
      candidateSha: process.env.CONSUMER_ACCEPTANCE_CANDIDATE,
    });
    console.log(JSON.stringify(result, null, 2));
    const outputFile = argument("--github-output");
    if (outputFile) {
      appendFileSync(outputFile, [
        `accepted_consumers=${result.acceptedConsumers.join(",") || "platform-only"}`,
        `evidence_reference=${result.reference || "structured-inline"}`,
        "",
      ].join("\n"));
    }
    return;
  }
  const base = argument("--base") || process.env.CONSUMER_IMPACT_BASE;
  const head = argument("--head") || process.env.CONSUMER_IMPACT_HEAD || "HEAD";
  const override = argument("--consumers") ?? process.env.CONSUMER_IMPACT_OVERRIDE;
  const overrideReason = argument("--reason") ?? process.env.CONSUMER_IMPACT_REASON;
  const changedPaths = changedPathsBetween(base, head);
  if (changedPaths.includes("src/index.js")) {
    const exportSources = changedRootExportSourcesBetween(base, head);
    if (exportSources?.length) {
      changedPaths.splice(changedPaths.indexOf("src/index.js"), 1);
      changedPaths.push(...exportSources.map((source) => `@public-export:${source}`));
    }
  }
  if (
    changedPaths.some((file) => file === "package.json" || file === "package-lock.json")
    && packageContractChanged(base, head)
  ) {
    changedPaths.push("@package-contract");
  }
  const result = classifyChangedPaths(changedPaths, { override, overrideReason });
  const candidateSha = execFileSync("git", ["rev-parse", `${head}^{commit}`], { encoding: "utf8" }).trim();
  const payload = { ...result, base, candidateSha };
  console.log(JSON.stringify(payload, null, 2));
  appendGithubOutput(argument("--github-output"), result, candidateSha);
  appendGithubSummary(argument("--github-summary"), result, base, candidateSha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
