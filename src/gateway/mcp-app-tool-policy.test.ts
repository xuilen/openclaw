import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareMcpAppExtensionRuntime } from "./mcp-app-extension-runtime.js";
import { prepareModelCreatedAppToolCall } from "./mcp-app-operations.js";
import { appCatalog, appView, runtime } from "./server-methods/mcp-app.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  loadConfig: vi.fn(),
  projection: vi.fn(),
  approval: vi.fn(),
  storageRead: vi.fn(() => {
    throw new Error("Unexpected synchronous session storage read");
  }),
}));

// mock-isolation: Supply the already acquired MCP transport, without opening external servers.
vi.mock("../agents/agent-bundle-mcp-manager-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-bundle-mcp-manager-api.js")>()),
  acquireSessionMcpRuntime: mocks.acquire,
}));
// mock-isolation: The fixture owns the borrowed runtime lease.
vi.mock("../agents/agent-bundle-mcp-manager-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-bundle-mcp-manager-cleanup.js")>()),
  releaseSessionMcpRuntime: async (lease: { releaseLease: () => void }) => lease.releaseLease(),
}));
// mock-isolation: Configuration loading is external; policy evaluation consumes the real config.
vi.mock("../agents/agent-bundle-mcp-runtime-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-bundle-mcp-runtime-config.js")>()),
  loadSessionMcpConfig: mocks.loadConfig,
}));
// mock-isolation: Select the built-in transport without preparing native harness credentials.
vi.mock("../agents/thinking-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/thinking-runtime.js")>()),
  resolveEffectiveAgentRuntime: () => "openclaw",
}));
// mock-isolation: No installed-plugin snapshot is needed for the built-in coding profile.
vi.mock("../plugins/current-plugin-metadata-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-state.js")>()),
  getGatewayPluginMetadataSnapshot: () => undefined,
}));
// mock-isolation: Session facts are prepared in memory, as they are at this retained-resource boundary.
vi.mock("./session-row-projection-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-row-projection-access.js")>()),
  getSessionRowProjection: mocks.projection,
}));
// mock-isolation: Guard against accidentally replacing prepared facts with synchronous disk reads.
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  loadExactSessionEntryReadOnly: mocks.storageRead,
  loadSessionEntryByIdReadOnly: mocks.storageRead,
  loadSessionEntryReadOnly: mocks.storageRead,
}));
// mock-isolation: Approval delivery is external; approval requirements and rechecks remain real.
vi.mock("./mcp-app-tool-approval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-app-tool-approval.js")>()),
  requestMcpAppToolApproval: mocks.approval,
}));

type AppPath = "model-created" | "standalone";
const sessionKey = "agent:main:app-policy";
const toolName = "read_progress";
const projectedName = "fixture__read_progress";
const dispose: Array<() => Promise<void>> = [];

function fixture() {
  const config: OpenClawConfig = {
    agents: { defaults: { model: "openai/test-model", workspace: "/test/app-policy" } },
    tools: { profile: "coding" },
    mcp: {
      apps: { enabled: true },
      servers: { fixture: { command: "fixture-mcp", codex: { defaultToolsApprovalMode: "auto" } } },
    },
  };
  const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1, lifecycleRevision: "first" };
  const target = {
    agentId: "main",
    canonicalKey: sessionKey,
    entry,
    generation: Symbol("database"),
    storeKey: sessionKey,
    storeKeys: [sessionKey],
    storePath: "/test/main/sessions",
  };
  const projection = { sharingTarget: () => target };
  const controller = new AbortController();
  const assertCurrent = () => controller.signal.throwIfAborted();
  const retain = () => ({ signal: controller.signal, assertCurrent, release: () => {} });
  const contextParams = makeContextParams();
  const context = createGatewayRequestContext(contextParams);
  context.getRuntimeConfig = () => config;
  dispose.push(() => contextParams.runtime.scheduler.stop());
  const catalog = appCatalog("fixture", [
    {
      toolName,
      uiVisibility: ["app"],
      codexAnnotations: { readOnlyHint: true },
    },
  ]);
  const owner = runtime();
  owner.sessionKey = sessionKey;
  owner.getCatalog.mockResolvedValue(catalog);
  owner.peekCatalog.mockReturnValue(catalog);
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "app-policy", method: "mcp.app.callTool" },
    params: {},
    respond: vi.fn(),
    isWebchatConnect: () => true,
    client: {
      connect: gatewayConnect(["operator.write"]),
      authenticatedUserProfile: gatewayProfile("reviewer", "Reviewer"),
    },
    context,
    sessionAccessAuthority: {
      target: { agentId: "main", sessionKey, sessionId: entry.sessionId },
      sandboxRequired: false,
      assertCurrent,
      retain,
      retainSession: retain,
      release: () => {},
    },
  };
  const request = { options, toolName, input: {}, assertCurrent };
  mocks.projection.mockReturnValue(projection);
  mocks.loadConfig.mockReturnValue({ loaded: { mcpServers: config.mcp!.servers } });
  mocks.acquire.mockResolvedValue({ runtime: owner, releaseLease: () => {} });

  async function openStandalone() {
    const active = await prepareMcpAppExtensionRuntime(options);
    dispose.push(() => active.dispose());
    return active;
  }
  async function prepare(path: AppPath) {
    if (path === "model-created") {
      const view = appView(owner, {
        serverName: "fixture",
        requesterId: "reviewer",
        allowedAppToolNames: new Set([toolName]),
      });
      return prepareModelCreatedAppToolCall({ runtime: owner, view }, request);
    }
    const active = await openStandalone();
    expect(active.catalog.tools.map((tool) => tool.toolName)).toEqual([toolName]);
    const retained = active.retainViewAuthority(active.catalog.tools);
    dispose.push(async () => retained.release());
    return retained.prepareToolCall(request);
  }
  return { config, controller, prepare, openStandalone };
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const release of dispose.splice(0).toReversed()) {
    await release();
  }
  expect(mocks.storageRead).not.toHaveBeenCalled();
});

describe.each<AppPath>(["model-created", "standalone"])("MCP App policy via %s", (path) => {
  it("admits an App-only tool through the coding profile's plugin allowance", async () => {
    const test = fixture();
    const assertExecutionCurrent = await test.prepare(path);
    expect(assertExecutionCurrent).toBeTypeOf("function");
    expect(() => assertExecutionCurrent?.()).not.toThrow();
    expect(mocks.approval).not.toHaveBeenCalled();
  });

  it.each(["bundle-mcp", "group:plugins"])("preserves explicit %s denial", async (deny) => {
    const test = fixture();
    // Admit the exact name so this regression isolates ownership-based denial.
    test.config.tools!.alsoAllow = [projectedName];
    test.config.tools!.deny = [deny];
    if (path === "standalone") {
      expect((await test.openStandalone()).catalog.tools).toEqual([]);
    } else {
      await expect(test.prepare(path)).rejects.toThrow("current tool policy");
    }
    expect(mocks.approval).not.toHaveBeenCalled();
  });

  it("rechecks plugin denial after preparation", async () => {
    const test = fixture();
    test.config.tools!.alsoAllow = [projectedName];
    const assertExecutionCurrent = await test.prepare(path);
    test.config.tools!.deny = ["group:plugins"];
    expect(() => assertExecutionCurrent?.()).toThrow("current tool policy");
  });

  it("rejects revoked request authority before execution", async () => {
    const test = fixture();
    const assertExecutionCurrent = await test.prepare(path);
    test.controller.abort(new Error("fixture authority revoked"));
    expect(() => assertExecutionCurrent?.()).toThrow("fixture authority revoked");
  });
});
