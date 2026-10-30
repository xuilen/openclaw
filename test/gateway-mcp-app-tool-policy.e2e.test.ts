import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { McpAppDiscoverResult } from "../src/shared/mcp-app-extensions.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { withBuiltGateway } from "./helpers/built-gateway-proof.js";
import { readRequestText } from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const RESOURCE = "ui://policy-proof/app";
const PROGRESS = { content: [{ type: "text" as const, text: "Progress: 42%" }] };

async function startMcpServer(signal: AbortSignal) {
  const calls: string[] = [];
  const sessions = new Map<string, NodeStreamableHTTPServerTransport>();
  const servers: Server[] = [];
  const listener = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      http.createServer((request, response) => {
        void (async () => {
          const sessionId = request.headers["mcp-session-id"];
          let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
          if (!transport && !sessionId && request.method === "POST") {
            const server = new Server(
              { name: "policy-proof", version: "1" },
              { capabilities: { tools: {}, resources: {} } },
            );
            server.setRequestHandler("tools/list", async () => ({
              tools: [
                {
                  name: "show_app",
                  description: "Show the policy proof App.",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                  _meta: {
                    ui: { resourceUri: RESOURCE, visibility: ["model", "app"] },
                    "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
                  },
                },
                {
                  name: "read_progress",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                  _meta: { ui: { visibility: ["app"] } },
                },
              ],
            }));
            server.setRequestHandler("resources/read", async ({ params }) => ({
              contents: [
                {
                  uri: params.uri,
                  mimeType: "text/html;profile=mcp-app",
                  text: "<p>Progress App</p>",
                },
              ],
            }));
            server.setRequestHandler("tools/call", async ({ params }) => {
              calls.push(params.name);
              if (params.name === "read_progress") {
                return PROGRESS;
              }
              return { content: [{ type: "text", text: "Progress App opened" }] };
            });
            const created = new NodeStreamableHTTPServerTransport({
              sessionIdGenerator: randomUUID,
              onsessioninitialized: (id) => {
                sessions.set(id, created);
              },
            });
            servers.push(server);
            await server.connect(created);
            transport = created;
          }
          if (!transport) {
            response.writeHead(404).end();
            return;
          }
          await transport.handleRequest(request, response);
        })().catch(() => {
          if (!response.headersSent) {
            response.writeHead(500).end();
          }
        });
      }),
  });
  return {
    url: `http://127.0.0.1:${listener.claim.port}/mcp`,
    calls,
    close: () =>
      runQaGatewayFixture(
        async () => {
          await Promise.all(servers.map((server) => server.close()));
        },
        () => listener.listener.closeAllConnections(),
        listener.releaseListener,
        listener.claim.release,
      ),
  };
}

it(
  "enforces coding policy for standalone and model-created Apps over real MCP HTTP",
  { timeout: 120_000 },
  async ({ signal }) => {
    const mcp = await startMcpServer(signal);
    await runQaGatewayFixture(async () => {
      let modelToolCalls = 0;
      const modelId = "mcp-app-policy-model";
      const provider = await startOpenAiResponsesModelServer({
        modelId,
        bindError: "MCP App model fixture did not bind",
        onRequest: async (request, response) => {
          const body = asRecord(JSON.parse(await readRequestText(request)));
          const tools = Array.isArray(body.tools) ? body.tools.map(asRecord) : [];
          const show = tools.find((tool) => tool.name === "proof__show_app");
          if (show && modelToolCalls++ === 0) {
            expect(tools.some((tool) => tool.name === "proof__read_progress")).toBe(false);
            const item = {
              type: "function_call",
              id: "fc_show_app",
              call_id: "call_show_app",
              name: "proof__show_app",
              arguments: "{}",
            };
            writeOpenAiResponsesSse(response, [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: item.id,
                delta: item.arguments,
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.completed",
                response: {
                  id: "resp_show_app",
                  status: "completed",
                  output: [item],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]);
            return;
          }
          writeOpenAiResponsesText(response, {
            text: "The progress App is ready.",
            messageId: "msg_done",
            responseId: "resp_done",
          });
        },
      });
      await runQaGatewayFixture(async () => {
        const config = createOpenAiResponsesModelConfig({
          baseUrl: provider.baseUrl,
          providerId: "mock-openai",
          modelId,
          reasoning: false,
          toolProfile: "coding",
        });
        // Expose the selected tools directly; neither presentation option adds authority.
        config.tools = { ...config.tools, codeMode: false, toolSearch: false };
        config.mcp = {
          apps: { enabled: true },
          servers: {
            proof: {
              url: mcp.url,
              transport: "streamable-http",
              codex: { defaultToolsApprovalMode: "auto" },
            },
          },
        };
        await withBuiltGateway(
          {
            name: "mcp-app-tool-policy",
            signal,
            config,
            env: {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_SKIP_PROVIDERS: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              HTTP_PROXY: "",
              HTTPS_PROXY: "",
              ALL_PROXY: "",
              http_proxy: "",
              https_proxy: "",
              all_proxy: "",
              NO_PROXY: "127.0.0.1,localhost",
              no_proxy: "127.0.0.1,localhost",
            },
          },
          async (client) => {
            const sessionKey = "agent:main:mcp-app-standalone-policy";
            await client.request("sessions.create", { agentId: "main", key: sessionKey });
            const discovered = await client.request<McpAppDiscoverResult>("mcp.app.discover", {
              sessionKey,
            });
            expect(discovered.servers).toEqual([
              expect.objectContaining({
                serverName: "proof",
                entrypoints: expect.arrayContaining([
                  expect.objectContaining({ toolName: "show_app", entrypoint: { type: "global" } }),
                  expect.objectContaining({ toolName: "show_app", entrypoint: { type: "thread" } }),
                ]),
              }),
            ]);
            const launch = (key: string) =>
              client.request<{ viewId: string }>("mcp.app.launch", {
                sessionKey: key,
                serverName: "proof",
                toolName: "show_app",
                entrypointType: "global",
              });
            const read = (key: string, viewId: string) =>
              client.request("mcp.app.callTool", {
                sessionKey: key,
                viewId,
                toolName: "read_progress",
                arguments: {},
              });
            const standalone = await launch(sessionKey);
            expect(await read(sessionKey, standalone.viewId)).toMatchObject(PROGRESS);
            expect(mcp.calls).toEqual(["show_app", "read_progress"]);

            const deniedKey = "agent:main:mcp-app-explicit-deny";
            await client.request("sessions.create", {
              agentId: "main",
              key: deniedKey,
              toolOverrides: { mcpToolsDeny: { proof: ["read_progress"] } },
            });
            const denied = await launch(deniedKey);
            await expect(read(deniedKey, denied.viewId)).rejects.toThrow(
              /denied|not app-callable|not granted/i,
            );
            expect(mcp.calls).toEqual(["show_app", "read_progress", "show_app"]);
            await client.request("sessions.patch", {
              key: sessionKey,
              toolOverrides: { mcpServers: { proof: false } },
            });
            await expect(read(sessionKey, standalone.viewId)).rejects.toThrow(
              /denied|expired|unavailable|revoked/i,
            );
            expect(mcp.calls).toHaveLength(3);

            const modelKey = "agent:main:mcp-app-model-policy";
            await client.request("sessions.create", { agentId: "main", key: modelKey });
            await client.request(
              "agent",
              {
                agentId: "main",
                sessionKey: modelKey,
                idempotencyKey: randomUUID(),
                message: "Show the progress App.",
                deliver: false,
              },
              { expectFinal: true, timeoutMs: 60_000 },
            );
            const history = await client.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: modelKey,
            });
            const views = history.messages.flatMap((message) => {
              const details = asRecord(asRecord(message).details);
              const view = asRecord(asRecord(details.mcpAppPreview).mcpApp);
              return typeof view.viewId === "string" ? [view.viewId] : [];
            });
            expect(views).toHaveLength(1);
            const modelViewId = views[0];
            assert(modelViewId, "The model tool result must contain a real App view");
            expect(modelToolCalls).toBeGreaterThanOrEqual(2);
            expect(await read(modelKey, modelViewId)).toMatchObject(PROGRESS);
            expect(mcp.calls).toEqual([
              "show_app",
              "read_progress",
              "show_app",
              "show_app",
              "read_progress",
            ]);
            await client.request("sessions.patch", {
              key: modelKey,
              toolOverrides: { mcpToolsDeny: { proof: ["read_progress"] } },
            });
            await expect(read(modelKey, modelViewId)).rejects.toThrow(
              /denied|expired|unavailable|revoked/i,
            );
            expect(mcp.calls).toHaveLength(5);
          },
          { role: "operator", scopes: ["operator.admin", "operator.read", "operator.write"] },
        );
      }, provider.close);
    }, mcp.close);
  },
);
