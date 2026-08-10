import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_SHARED_MCP_IDLE_MS = 60_000;

export class SharedOnDemandMcpBackend {
  constructor({
    providerId = "mcp",
    createConnection,
    idleMs = DEFAULT_SHARED_MCP_IDLE_MS,
    logger = () => {},
    serializeCalls = false,
  }) {
    if (typeof createConnection !== "function") {
      throw new TypeError("createConnection must be a function.");
    }
    this.providerId = cleanProviderId(providerId);
    this.createConnection = createConnection;
    this.idleMs = Math.max(1, Number(idleMs) || DEFAULT_SHARED_MCP_IDLE_MS);
    this.logger = logger;
    this.serializeCalls = Boolean(serializeCalls);
    this.connection = null;
    this.starting = null;
    this.closing = null;
    this.activeCalls = 0;
    this.idleTimer = null;
    this.callTail = Promise.resolve();
  }

  status() {
    return {
      activeCalls: this.activeCalls,
      idleMs: this.idleMs,
      providerPid: this.connection?.pid || null,
      serialized: this.serializeCalls,
      state: this.closing
        ? "stopping"
        : this.connection
          ? "running"
          : this.starting
            ? "starting"
            : "stopped",
    };
  }

  callTool(params) {
    this.cancelIdleStop();
    this.activeCalls += 1;

    const execute = async () => {
      const connection = await this.getConnection();
      try {
        const result = await connection.client.callTool(params);
        return connection.redact ? connection.redact(result) : result;
      } catch (error) {
        if (!connection.redact) throw error;
        throw new Error(connection.redact(String(error?.message || error)));
      }
    };

    let operation;
    if (this.serializeCalls) {
      operation = this.callTail.then(execute, execute);
      this.callTail = operation.catch(() => {});
    } else {
      operation = execute();
    }

    return operation.finally(() => {
      this.activeCalls -= 1;
      this.scheduleIdleStop();
    });
  }

  async getConnection() {
    if (this.closing) await this.closing;
    if (this.connection) return this.connection;
    if (this.starting) return this.starting;

    const starting = this.createConnection();
    this.starting = starting;
    try {
      const connection = await starting;
      this.connection = connection;
      this.logger(`${this.providerId}-provider-started`, {
        pid: connection.pid || null,
      });
      return connection;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  scheduleIdleStop() {
    if (this.activeCalls || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.close("idle").catch((error) => {
        this.logger(`${this.providerId}-provider-stop-failed`, {
          message: cleanMcpErrorMessage(error),
        });
      });
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  cancelIdleStop() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async close(reason = "manual") {
    this.cancelIdleStop();
    if (this.closing) return this.closing;

    const closing = (async () => {
      let connection = this.connection;
      if (!connection && this.starting) {
        try {
          connection = await this.starting;
        } catch {
          return;
        }
      }
      this.connection = null;
      if (!connection) return;
      await connection.client.close();
      this.logger(`${this.providerId}-provider-stopped`, {
        pid: connection.pid || null,
        reason,
      });
    })();
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = null;
    }
  }
}

export function createSharedMcpHttpProxy({
  providerId,
  serverName = `agent-web-${providerId}-proxy`,
  serverVersion = "1.0.0",
  instructions = "",
  tools,
  backend,
  logger = () => {},
  unknownToolMessage = (name) => `Unknown tool: ${name || "(empty)"}`,
  unavailableMessage = "The MCP provider is temporarily unavailable.",
} = {}) {
  if (!backend || typeof backend.callTool !== "function") {
    throw new TypeError("backend must provide callTool().");
  }
  if (!Array.isArray(tools) || !tools.length) {
    throw new TypeError("tools must be a non-empty array.");
  }

  const cleanId = cleanProviderId(providerId);
  const toolNames = new Set(tools.map((tool) => String(tool?.name || "")).filter(Boolean));

  return {
    backend,
    tools,
    async handlePost(req, res, body) {
      const requestBody = body && typeof body !== "function" ? body : req.body;
      const mcpServer = createProxyServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, requestBody);
      } catch (error) {
        logger(`${cleanId}-mcp-request-failed`, {
          message: cleanMcpErrorMessage(error),
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      } finally {
        await mcpServer.close().catch(() => {});
      }
    },
    handleUnsupported(_req, res) {
      res.set("Allow", "POST");
      res.status(405).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      });
    },
  };

  function createProxyServer() {
    const mcpServer = new Server(
      {
        name: serverName,
        version: serverVersion,
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: String(instructions || ""),
      },
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = String(request.params.name || "");
      if (!toolNames.has(name)) return toolError(unknownToolMessage(name));

      try {
        return await backend.callTool({
          name,
          arguments: request.params.arguments || {},
        });
      } catch (error) {
        logger(`${cleanId}-tool-call-failed`, {
          name,
          message: cleanMcpErrorMessage(error),
        });
        return toolError(unavailableMessage);
      }
    });

    return mcpServer;
  }
}

export function toolError(text) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError: true,
  };
}

export function cleanMcpErrorMessage(error) {
  return String(error?.message || "Unknown error")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);
}

function cleanProviderId(value) {
  const cleaned = String(value || "mcp")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "mcp";
}
