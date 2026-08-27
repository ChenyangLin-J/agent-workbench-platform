import assert from "node:assert/strict";
import test from "node:test";
import {
  absolutePlaywrightArtifactLinks,
  createPlaywrightMcpProxy,
  PLAYWRIGHT_MCP_TOOLS,
  SharedOnDemandMcpBackend,
} from "../src/browser/provider.js";

test("shared browser backend starts once, serializes calls, and stops when idle", async (t) => {
  let starts = 0;
  let closes = 0;
  let running = 0;
  let peakRunning = 0;
  const backend = new SharedOnDemandMcpBackend({
    providerId: "browser-test",
    idleMs: 20,
    serializeCalls: true,
    createConnection: async () => ({
      pid: ++starts,
      client: {
        async callTool({ name }) {
          running += 1;
          peakRunning = Math.max(peakRunning, running);
          await new Promise((resolve) => setTimeout(resolve, 8));
          running -= 1;
          return { content: [{ type: "text", text: name }] };
        },
        async close() { closes += 1; },
      },
    }),
  });
  t.after(() => backend.close("test"));

  const results = await Promise.all([
    backend.callTool({ name: "browser_navigate" }),
    backend.callTool({ name: "browser_snapshot" }),
  ]);
  assert.equal(starts, 1);
  assert.equal(peakRunning, 1);
  assert.deepEqual(results.map((result) => result.content[0].text), ["browser_navigate", "browser_snapshot"]);
  await waitFor(() => backend.status().state === "stopped");
  assert.equal(closes, 1);
});

test("Agent and Personal browser hosts keep independent connections and CDP endpoints", async (t) => {
  const starts = [];
  function host(name, cdpEndpoint) {
    return createPlaywrightMcpProxy({
      cdpEndpoint,
      outputDir: `/tmp/${name}-output`,
      ensureBrowser: async () => {},
      createConnection: async () => {
        starts.push(name);
        return {
          client: {
            async callTool() { return { content: [{ type: "text", text: name }] }; },
            async close() {},
          },
        };
      },
      providerId: name,
    });
  }
  const agent = host("agent", "http://127.0.0.1:9222");
  const personal = host("personal", "http://127.0.0.1:49222");
  t.after(() => Promise.all([agent.close("test"), personal.close("test")]));

  assert.equal(agent.status().state, "stopped");
  assert.equal(personal.status().state, "stopped");
  const [agentResult, personalResult] = await Promise.all([
    agent.backend.callTool({ name: "browser_snapshot" }),
    personal.backend.callTool({ name: "browser_snapshot" }),
  ]);
  assert.equal(agentResult.content[0].text, "agent");
  assert.equal(personalResult.content[0].text, "personal");
  assert.deepEqual(starts.sort(), ["agent", "personal"]);
  assert.equal(agent.status().cdpEndpoint, "http://127.0.0.1:9222");
  assert.equal(personal.status().cdpEndpoint, "http://127.0.0.1:49222");
});

test("shared Playwright tool discovery remains manifest-only", () => {
  assert.ok(PLAYWRIGHT_MCP_TOOLS.length > 0);
  assert.ok(PLAYWRIGHT_MCP_TOOLS.some((tool) => tool.name === "browser_navigate"));
  assert.ok(PLAYWRIGHT_MCP_TOOLS.some((tool) => tool.name === "browser_snapshot"));
});

test("Playwright artifact links use the configured absolute output directory", () => {
  const result = absolutePlaywrightArtifactLinks({
    content: [
      { type: "text", text: "- [Screenshot](./capture%20one.png)" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ],
  }, "/tmp/paw browser-output");

  assert.equal(result.content[0].text, "- [Screenshot](/tmp/paw%20browser-output/capture%20one.png)");
  assert.equal(result.content[1].type, "image");
});

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
