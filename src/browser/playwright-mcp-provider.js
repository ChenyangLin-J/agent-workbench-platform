import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  cleanMcpErrorMessage,
  createSharedMcpHttpProxy,
  SharedOnDemandMcpBackend,
} from "./shared-mcp-provider.js";

const require = createRequire(import.meta.url);
const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_OUTPUT_MAX_SIZE = "52428800";
const PLAYWRIGHT_PROVIDER_ROOT = path.dirname(require.resolve("@playwright/mcp/package.json"));
const PLAYWRIGHT_PROVIDER_ENTRY = path.join(PLAYWRIGHT_PROVIDER_ROOT, "cli.js");

export const PLAYWRIGHT_MCP_TOOLS = Object.freeze(JSON.parse(
  readFileSync(new URL("./playwright-mcp-tools.json", import.meta.url), "utf8"),
));

export function createPlaywrightMcpProxy({
  cdpEndpoint,
  outputDir,
  ensureBrowser,
  createConnection,
  idleMs = DEFAULT_IDLE_MS,
  logger = () => {},
  providerId = "playwright",
  serverName = "agent-workbench-playwright-proxy",
  serverVersion = "0.1.0",
  clientName = "agent-workbench-playwright-client",
  instructions = "",
  unknownToolMessage = (name) => `Unknown browser tool: ${name || "(empty)"}`,
  unavailableMessage = "The shared browser is temporarily unavailable.",
} = {}) {
  if (!createConnection && (!cdpEndpoint || !outputDir || typeof ensureBrowser !== "function")) {
    throw new TypeError("cdpEndpoint, outputDir, and ensureBrowser are required without createConnection.");
  }
  const backend = new SharedOnDemandMcpBackend({
    providerId,
    idleMs,
    logger,
    serializeCalls: true,
    createConnection: createConnection || (() => createPlaywrightProviderConnection({
      ensureBrowser,
      cdpEndpoint,
      outputDir,
      clientName,
      serverVersion,
      logger,
    })),
  });
  const proxy = createSharedMcpHttpProxy({
    providerId,
    serverName,
    serverVersion,
    instructions,
    tools: PLAYWRIGHT_MCP_TOOLS,
    backend,
    logger,
    unknownToolMessage,
    unavailableMessage,
  });
  return {
    ...proxy,
    status: () => ({ ...backend.status(), cdpEndpoint: cdpEndpoint || null }),
    close: (reason) => backend.close(reason),
  };
}

export async function createPlaywrightProviderConnection({
  ensureBrowser,
  cdpEndpoint,
  outputDir,
  clientName = "agent-workbench-playwright-client",
  serverVersion = "0.1.0",
  logger = () => {},
} = {}) {
  if (typeof ensureBrowser !== "function") throw new TypeError("ensureBrowser must be a function.");
  if (!cdpEndpoint || !outputDir) throw new TypeError("cdpEndpoint and outputDir are required.");
  const resolvedOutputDir = path.resolve(outputDir);
  await ensureBrowser();
  await mkdir(resolvedOutputDir, { recursive: true, mode: 0o700 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      PLAYWRIGHT_PROVIDER_ENTRY,
      "--cdp-endpoint",
      cdpEndpoint,
      "--output-dir",
      resolvedOutputDir,
      "--output-max-size",
      DEFAULT_OUTPUT_MAX_SIZE,
      "--codegen",
      "none",
    ],
    cwd: resolvedOutputDir,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: clientName, version: serverVersion });
  try {
    await client.connect(transport);
    return {
      client,
      pid: transport.pid,
      redact: (result) => absolutePlaywrightArtifactLinks(result, resolvedOutputDir),
    };
  } catch (error) {
    await transport.close().catch(() => {});
    logger(`${providerIdFromClient(clientName)}-provider-start-failed`, {
      message: cleanMcpErrorMessage(error),
    });
    throw error;
  }
}

export function absolutePlaywrightArtifactLinks(value, outputDir) {
  if (typeof value === "string") return absolutePlaywrightArtifactText(value, outputDir);
  if (!value || typeof value !== "object") return value;
  return {
    ...value,
    content: Array.isArray(value.content)
      ? value.content.map((item) => item?.type === "text"
        ? { ...item, text: absolutePlaywrightArtifactText(item.text, outputDir) }
        : item)
      : value.content,
  };
}

function absolutePlaywrightArtifactText(value, outputDir) {
  const root = path.resolve(outputDir);
  return String(value ?? "").replace(/\]\(\.\/([^)\r\n]+)\)/g, (match, relativeName) => {
    const absolutePath = path.resolve(root, decodeSafe(relativeName));
    if (!isPathWithin(root, absolutePath)) return match;
    return `](${encodeLocalPath(absolutePath)})`;
  });
}

function decodeSafe(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function encodeLocalPath(value) {
  return value.split(path.sep).map((segment) => encodeURIComponent(segment)).join("/");
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function providerIdFromClient(clientName) {
  return String(clientName || "playwright").replace(/-client$/, "");
}
