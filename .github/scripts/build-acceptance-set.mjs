import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function buildAcceptanceSet({ platformCommit, acceptances, reference = null }) {
  const normalizedCommit = String(platformCommit || "").toLowerCase();
  if (!/^[a-f\d]{40}$/.test(normalizedCommit)) throw new Error("--platform-commit must be a full SHA.");
  const seen = new Set();
  const normalized = acceptances.map((acceptance) => {
    const consumer = String(acceptance?.consumer || "").trim();
    if (!consumer) throw new Error("Every acceptance needs a consumer.");
    if (seen.has(consumer)) throw new Error(`Duplicate acceptance: ${consumer}`);
    seen.add(consumer);
    if (String(acceptance.platformCommit || "").toLowerCase() !== normalizedCommit) {
      throw new Error(`${consumer} acceptance targets a different Platform commit.`);
    }
    return acceptance;
  });
  return {
    schema: "agent-workbench.consumer-acceptance-set/v1",
    platformCommit: normalizedCommit,
    ...(String(reference || "").trim() ? { reference: String(reference).trim() } : {}),
    acceptances: normalized,
  };
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const platformCommit = argument(argv, "--platform-commit");
  const reference = argument(argv, "--reference");
  const output = argument(argv, "--output");
  const optionValues = new Set(["--platform-commit", "--reference", "--output"]
    .flatMap((name) => {
      const index = argv.indexOf(name);
      return index === -1 ? [] : [index, index + 1];
    }));
  const files = argv.filter((_value, index) => !optionValues.has(index));
  if (!files.length && !platformCommit) throw new Error("Usage: build-acceptance-set.mjs --platform-commit <sha> [--reference <text>] [--output <file>] <acceptance.json>...");
  const acceptances = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.resolve(file), "utf8"))));
  const result = buildAcceptanceSet({ platformCommit, reference, acceptances });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await writeFile(path.resolve(output), serialized, "utf8");
  process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
