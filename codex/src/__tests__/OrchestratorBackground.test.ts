import {describe, expect, it, vi} from "vitest";
import {CodexBackgroundTerminalTasks} from "../async-tasks/CodexBackgroundTerminalTasks";
import {ACPSessionConnection} from "../ACPSessionConnection";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {createCodexMockTestFixture, createTestSessionState} from "./acp-test-utils";

const capabilities = {_meta: {orchestratorBackgroundTasks: 1, jetbrains: {air: {
    version: 1, capabilities: ["asyncTasks", "nativeSubagentSessions", "sessionFailure"],
}}}};

async function fixture() {
    const f = createCodexMockTestFixture(); const server = f.getCodexAcpAgent(); const client = f.getCodexAcpClient();
    vi.spyOn(client.workloads, "enable").mockImplementation(async () => {client.workloads.enabled = true;});
    vi.spyOn(client.workloads, "snapshot").mockResolvedValue([]);
    vi.spyOn(client.workloads, "stopSession").mockResolvedValue();
    await server.initialize({protocolVersion: 1, clientCapabilities: capabilities});
    const state = createTestSessionState({sessionId: "thread-1"});
    vi.spyOn(state.asyncTasks, "drainSync").mockResolvedValue();
    // Install a live test session without a provider call.
    (server as any).sessions.set(state.sessionId, state);
    return {f, server, client, state};
}

describe("Negotiated orchestrator drain", () => {
    it("does not advertise strict drain without every AIR capability", async () => {
        const f = createCodexMockTestFixture(); const response = await f.getCodexAcpAgent().initialize({
            protocolVersion: 1, clientCapabilities: {_meta: {orchestratorBackgroundTasks: 1}},
        });
        expect(response._meta?.["orchestratorBackgroundTasks"]).toBeUndefined();
        await expect(f.getCodexAcpAgent().background({sessionId: "missing"})).rejects.toHaveProperty("code", -32600);
    });
    it("keeps a polling token stable and rejects stale close without cancelling", async () => {
        const {server, client} = await fixture();
        const first = await server.background({sessionId: "thread-1"});
        expect(await server.background({sessionId: "thread-1"})).toEqual(first);
        expect((await server.background({sessionId: "thread-1", close: true, token: "stale"})).closed).toBe(false);
        expect(client.workloads.stopSession).not.toHaveBeenCalled();
    });
    it("holds drain for a native process outside the terminal registry", async () => {
        const {server, client} = await fixture(); vi.mocked(client.workloads.snapshot).mockResolvedValue([[12345, "identity"]]);
        const state = await server.background({sessionId: "thread-1"});
        expect(state.pending).toBe(true);
        expect((await server.background({sessionId: "thread-1", close: true, token: state.token})).closed).toBe(false);
    });
    it("propagates registry failure rather than treating it as an empty registry", async () => {
        const {server, state} = await fixture(); vi.mocked(state.asyncTasks.drainSync).mockRejectedValue(new Error("registry lost"));
        await expect(server.background({sessionId: "thread-1"})).rejects.toThrow("registry lost");
    });
    it("refuses a failure-marked session", async () => {
        const {server, state} = await fixture(); (state as any).sessionFailure = {severity: "error"};
        await expect(server.background({sessionId: "thread-1"})).rejects.toHaveProperty("code", -32600);
    });
    it("seals an accepted close before awaiting teardown", async () => {
        const {server} = await fixture(); const state = await server.background({sessionId: "thread-1"});
        vi.spyOn(server, "closeSession").mockResolvedValue({});
        expect((await server.background({sessionId: "thread-1", close: true, token: state.token})).closed).toBe(true);
        await expect(server.prompt({sessionId: "thread-1", prompt: []})).rejects.toHaveProperty("code", -32600);
        await expect(server.background({sessionId: "thread-1"})).rejects.toHaveProperty("code", -32600);
    });
    it("bounds terminal history and rejects overflow", () => {
        const task = new CodexBackgroundTerminalTasks(true, "root", {} as CodexAppServerClient,
            new ACPSessionConnection({notify: vi.fn(), request: vi.fn()}, "root"), true);
        for (let i = 0; i < 8193; i++) (task as any).history.set(String(i), {id: String(i), state: "completed", autonomous: false});
        expect(() => task.snapshot()).toThrow("8192");
    });
});

function strictTasks() {
    const updates: any[] = [];
    const list = vi.fn().mockResolvedValue({data: [{itemId: "command-1", processId: "42", command: "sleep 20", osPid: 12345}], nextCursor: null});
    const terminate = vi.fn().mockResolvedValue({terminated: true});
    const workloads = {capture: vi.fn().mockResolvedValue(undefined), stopTask: vi.fn().mockResolvedValue(undefined), resolvePid: vi.fn()};
    const tasks = new CodexBackgroundTerminalTasks(true, "root", {
        threadBackgroundTerminalsList: list, threadBackgroundTerminalsTerminate: terminate,
    } as unknown as CodexAppServerClient, new ACPSessionConnection({
        notify: vi.fn(async (_method, params: any) => {updates.push(params.update);}), request: vi.fn(),
    }, "root"), true, workloads as any);
    return {tasks, list, terminate, workloads, updates};
}

describe("Strict terminal registry", () => {
    it("does not infer stopped from disappearance", async () => {
        const f = strictTasks(); await f.tasks.sync(); f.list.mockResolvedValue({data: [], nextCursor: null});
        await f.tasks.sync(); expect(f.tasks.snapshot().pending).toBe(true);
        expect(f.tasks.snapshot().tasks[0]?.state).toBe("running");
        expect(f.updates.filter(item => item.sessionUpdate === "async_task_state_update")).toEqual([]);
    });
    it("retains failed terminal results for model verification", async () => {
        const f = strictTasks(); await f.tasks.sync();
        await f.tasks.handleNotification({method: "item/completed", params: {threadId: "root", turnId: "turn", item: {
            type: "commandExecution", id: "command-1", status: "completed", exitCode: 7,
        }}} as any, "root");
        expect(f.tasks.snapshot()).toMatchObject({pending: false, tasks: [{id: "command-1", state: "failed"}]});
    });
    it("does not confirm stopped when process cleanup fails", async () => {
        const f = strictTasks(); await f.tasks.sync(); f.workloads.stopTask.mockRejectedValue(new Error("still alive"));
        await expect(f.tasks.stop("command-1")).rejects.toThrow("still alive");
        expect(f.tasks.snapshot().pending).toBe(true);
        expect(f.updates.filter(item => item.state === "stopped")).toEqual([]);
    });
    it("keeps termination events behind the OS stop confirmation", async () => {
        const f = strictTasks(); await f.tasks.sync();
        f.terminate.mockImplementation(async () => {
            await f.tasks.handleNotification({method: "item/completed", params: {threadId: "root", turnId: "turn", item: {
                type: "commandExecution", id: "command-1", status: "completed", exitCode: 137,
            }}} as any, "root");
            return {terminated: true};
        });
        expect(await f.tasks.stop("command-1")).toBe(true);
        expect(f.tasks.snapshot()).toMatchObject({pending: false, tasks: [{state: "stopped"}]});
        expect(f.workloads.stopTask).toHaveBeenCalledWith("root", "command-1", 12345);
    });
    it("accepts a verified OS stop when the native terminal has already reaped it", async () => {
        const f = strictTasks(); await f.tasks.sync();
        f.workloads.stopTask.mockResolvedValue(true); f.terminate.mockResolvedValue({terminated: false});
        expect(await f.tasks.stop("command-1")).toBe(true);
        expect(f.tasks.snapshot()).toMatchObject({pending: false, tasks: [{state: "stopped"}]});
    });

    it("claims only one concurrent stop", async () => {
        const f = strictTasks(); await f.tasks.sync();
        expect((await Promise.all([f.tasks.stop("command-1"), f.tasks.stop("command-1")])).sort()).toEqual([false, true]);
        expect(f.terminate).toHaveBeenCalledOnce();
    });
});

describe("Strict ownership after recovery", () => {
    it("does not silently resume unowned work after replacing the Codex client", async () => {
        const {server, client} = await fixture();
        client.workloads.enabled = false;
        await expect(server.background({sessionId: "thread-1"})).rejects.toHaveProperty("code", -32600);
        await expect(server.prompt({sessionId: "thread-1", prompt: []})).rejects.toHaveProperty("code", -32600);
    });
});
