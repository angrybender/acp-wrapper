import {afterEach, describe, expect, it, vi} from "vitest";
import {spawn, type ChildProcess} from "node:child_process";
import {mkdtemp, rm, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {NativeWorkloads, SCOPE_ENV} from "../NativeWorkloads";

vi.mock("node:fs/promises", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {...actual, readFile: vi.fn(actual.readFile)};
});

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
    for (const child of children.splice(0)) {try {child.kill("SIGKILL");} catch {}}
    vi.unstubAllEnvs(); vi.mocked(readFile).mockRestore();
    for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});

async function scope() {
    const home = await mkdtemp(path.join(tmpdir(), "acp-native-test-"));
    directories.push(home); vi.stubEnv("CODEX_HOME", home);
    const workloads = new NativeWorkloads(); await workloads.enable();
    const prepared = await workloads.prepare({}); await workloads.remember("thread-1", prepared.scope);
    return {workloads, token: prepared.scope!};
}
async function child(token: string) {
    const proc = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
        env: {...process.env, [SCOPE_ENV]: token}, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(proc);
    await new Promise<void>((resolve, reject) => {proc.stdout!.once("data", () => resolve()); proc.once("error", reject);});
    return proc;
}

describe.skipIf(process.platform !== "linux")("Native workload ownership", () => {
    it("leaves ordinary client config untouched", async () => {
        const workloads = new NativeWorkloads(); const config = {model: "example"};
        expect(await workloads.prepare(config)).toEqual({config});
    });
    it("persists the ownership marker across ACP process restarts and keeps sessions distinct", async () => {
        const {workloads, token} = await scope();
        const other = await workloads.prepare({}); expect(other.scope).not.toBe(token);
        const restarted = new NativeWorkloads(); await restarted.enable();
        const loaded = await restarted.prepare({}, "thread-1"); expect(loaded.scope).toBe(token);
    });
    it("stops only the owned session and confirms absence", async () => {
        const {workloads, token} = await scope();
        const owned = await child(token); const unrelated = await child("unrelated");
        expect((await workloads.snapshot("thread-1")).map(item => item[0])).toContain(owned.pid);
        await workloads.stopSession("thread-1"); expect(await workloads.snapshot("thread-1")).toEqual([]);
        expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    });
    it("tolerates ESRCH when a terminal exits between enumeration and cmdline read", async () => {
        const {workloads, token} = await scope(); const owned = await child(token);
        const actual = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).readFile;
        vi.mocked(readFile).mockImplementation(((file: unknown, ...args: unknown[]) => {
            if (String(file) === `/proc/${owned.pid}/cmdline`) return Promise.reject(Object.assign(new Error("exited"), {code: "ESRCH"}));
            return (actual as any)(file, ...args);
        }) as typeof readFile);
        expect(await workloads.resolvePid("thread-1", "never-matches")).toBeNull();
        await workloads.stopSession("thread-1");
    });
    it("captures and stops a terminal while another terminal keeps running", async () => {
        const {workloads, token} = await scope();
        const first = await child(token); const second = await child(token);
        await workloads.capture("thread-1", "first", first.pid);
        await workloads.stopTask("thread-1", "first", first.pid);
        expect((await workloads.snapshot("thread-1")).map(item => item[0])).toEqual([second.pid]);
        await workloads.stopSession("thread-1");
    });
    it("refuses to signal a process without verified ownership", async () => {
        const {workloads} = await scope(); const unrelated = await child("unrelated");
        await expect(workloads.capture("thread-1", "unknown", unrelated.pid)).rejects.toThrow("ownership");
        expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    });
    it("refuses an unmarked ancestor even when it contains an owned child", async () => {
        const {workloads, token} = await scope(); await child(token);
        await expect(workloads.capture("thread-1", "unsafe-ancestor", process.pid)).rejects.toThrow("ownership");
    });
    it("keeps equal task IDs in different sessions independent", async () => {
        const {workloads, token} = await scope();
        const prepared = await workloads.prepare({}); await workloads.remember("thread-2", prepared.scope);
        const first = await child(token); const second = await child(prepared.scope!);
        await workloads.capture("thread-1", "same", first.pid);
        await workloads.capture("thread-2", "same", second.pid);
        await workloads.stopTask("thread-2", "same", second.pid);
        expect((await workloads.snapshot("thread-1")).map(item => item[0])).toContain(first.pid);
        await workloads.stopSession("thread-1");
    });

    it("fails closed for a missing OS PID and an unknown session", async () => {
        const {workloads} = await scope();
        await expect(workloads.capture("thread-1", "unknown", null)).rejects.toThrow("OS PID");
        await expect(workloads.snapshot("missing")).rejects.toThrow("not initialized");
    });
    it("stops a detached grandchild in a different process group", async () => {
        const {workloads, token} = await scope();
        const code = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`;
        const parent = spawn(process.execPath, ["-e", code], {env: {...process.env, [SCOPE_ENV]: token}, stdio: ["ignore", "pipe", "pipe"]});
        children.push(parent);
        const pid = await new Promise<number>(resolve => parent.stdout!.once("data", data => resolve(Number(String(data).trim()))));
        try {
            await workloads.capture("thread-1", "tree", parent.pid);
            await workloads.stopTask("thread-1", "tree", parent.pid);
            expect(await workloads.snapshot("thread-1")).toEqual([]);
        } finally {try {process.kill(pid, "SIGKILL");} catch {}}
    });
    it("resolves an exec-optimized simple command and refuses ambiguous ownership", async () => {
        const {workloads, token} = await scope();
        const first = spawn("/bin/sleep", ["60"], {env: {...process.env, [SCOPE_ENV]: token}});
        children.push(first);
        await new Promise<void>(resolve => first.once("spawn", resolve));
        expect(await workloads.resolvePid("thread-1", "sleep 60")).toBe(first.pid);
        const second = spawn("/bin/sleep", ["60"], {env: {...process.env, [SCOPE_ENV]: token}});
        children.push(second);
        await new Promise<void>(resolve => second.once("spawn", resolve));
        await expect(workloads.resolvePid("thread-1", "sleep 60")).rejects.toThrow("Ambiguous");
        await workloads.stopSession("thread-1");
    });

    it("prevents a waiting shell from executing its trailing command during stop", async () => {
        const {workloads, token} = await scope();
        const directory = directories[0]!;
        const output = path.join(directory, "must-not-exist");
        const parent = spawn("/bin/bash", ["-c", `sleep 30; printf AFTER_STOP > '${output}'`], {
            env: {...process.env, [SCOPE_ENV]: token}, stdio: "ignore",
        });
        children.push(parent);
        await new Promise<void>(resolve => parent.once("spawn", resolve));
        await vi.waitFor(async () => expect((await workloads.snapshot("thread-1")).length).toBeGreaterThan(1));
        await workloads.stopSession("thread-1");
        await expect(readFile(output)).rejects.toHaveProperty("code", "ENOENT");
    });

});

describe.skipIf(process.platform !== "linux")("App-server helper ownership", () => {
    it("cleans only helpers of the disconnected ACP runtime", async () => {
        const owned = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
            env: {...process.env, ACP_WRAPPER_RUN: "owned-run"}, stdio: ["ignore", "pipe", "pipe"],
        });
        const other = await child("unrelated"); children.push(owned);
        await new Promise<void>(resolve => owned.stdout!.once("data", () => resolve()));
        await NativeWorkloads.stopRuns(new Set(["owned-run"]));
        await vi.waitFor(() => expect(owned.signalCode).toBe("SIGKILL"));
        expect(() => process.kill(other.pid!, 0)).not.toThrow();
    });
});
