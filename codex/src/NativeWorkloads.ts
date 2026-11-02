import {createHash, randomUUID} from "node:crypto";
import {readFile, readdir, mkdir, writeFile, rename, lstat, readlink} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";
import type {JsonValue} from "./app-server/serde_json/JsonValue";

export const SCOPE_ENV = "ACP_WRAPPER_SCOPE";
export const RUN_ENV = "ACP_WRAPPER_RUN";
type Identity = {pid: number; parent: number; start: string; state: string; scope?: string | undefined; executable: string; runOwner?: string | undefined};
type Config = {[key: string]: JsonValue | undefined};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Tracks native shell work across setsid/reparenting without signalling unrelated process groups. */
export class NativeWorkloads {
    enabled = false;
    private scopes = new Map<string, string>();
    private taskProcesses = new Map<string, Map<number, Identity>>();

    static async stopRuns(owners: ReadonlySet<string>): Promise<void> {
        if (process.platform !== "linux" || owners.size === 0) return;
        const supervisor = new NativeWorkloads();
        await supervisor.terminate(async () => (await supervisor.processes())
            .filter(item => item.runOwner !== undefined && owners.has(item.runOwner))
            .map(item => [item.pid, item.start]));
    }

    async enable(): Promise<void> {
        if (process.platform !== "linux") throw new Error("Strict Codex background drain requires Linux /proc");
        await readFile(`/proc/${process.pid}/stat`);
        await readFile(`/proc/${process.pid}/environ`);
        this.enabled = true;
    }

    private scopeFile(sessionId: string): string {
        return path.join(process.env["CODEX_HOME"] ?? path.join(homedir(), ".codex"), "acp-wrapper-scopes",
            createHash("sha256").update(sessionId).digest("hex") + ".json");
    }

    async prepare(config: Config, sessionId?: string): Promise<{config: Config; scope?: string | undefined}> {
        if (!this.enabled) return {config};
        let scope = sessionId ? this.scopes.get(sessionId) : undefined;
        if (!scope && sessionId) {
            try {
                const file = this.scopeFile(sessionId);
                if (!(await lstat(file)).isFile()) throw new Error("Invalid workload ownership file");
                scope = JSON.parse(await readFile(file, "utf8")).scope;
                if (typeof scope !== "string" || !/^[a-f0-9-]{36}$/.test(scope)) throw new Error("Invalid workload ownership token");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
        scope ??= randomUUID();
        return {config: {...config, [`shell_environment_policy.set.${SCOPE_ENV}`]: scope}, scope};
    }

    async remember(sessionId: string, scope?: string): Promise<void> {
        if (!this.enabled || !scope) return;
        const file = this.scopeFile(sessionId);
        await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
        const temporary = file + "." + randomUUID();
        await writeFile(temporary, JSON.stringify({scope}), {mode: 0o600, flag: "wx"});
        await rename(temporary, file);
        this.scopes.set(sessionId, scope);
    }

    private async processes(): Promise<Identity[]> {
        const result: Identity[] = [];
        const entries = (await readdir("/proc")).filter(entry => /^[1-9][0-9]*$/.test(entry));
        for (let offset = 0; offset < entries.length; offset += 32) {
            const rows = await Promise.all(entries.slice(offset, offset + 32).map(async entry => {
                try {
                    const stat = await readFile(`/proc/${entry}/stat`, "utf8");
                    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                    if (fields[0] === "Z" || fields[0] === "X") return null;
                    const env = await readFile(`/proc/${entry}/environ`, "utf8");
                    return {pid: Number(entry), parent: Number(fields[1]), start: fields[19]!, state: fields[0]!,
                        executable: await readlink(`/proc/${entry}/exe`),
                        scope: env.split("\0").find(value => value.startsWith(SCOPE_ENV + "="))?.slice(SCOPE_ENV.length + 1),
                        runOwner: env.split("\0").find(value => value.startsWith(RUN_ENV + "="))?.slice(RUN_ENV.length + 1)};
                } catch (error) {
                    if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
                    return null;
                }
            }));
            for (const row of rows) if (row) result.push(row);
        }
        return result;
    }

    async snapshot(sessionId: string, includeInfrastructure = false): Promise<Array<[number, string]>> {
        if (!this.enabled) return [];
        const scope = this.scopes.get(sessionId);
        if (!scope) throw new Error("Native workload ownership was not initialized");
        return (await this.processes()).filter(item => item.scope === scope && (includeInfrastructure || !this.infrastructure(item)))
            .map(item => [item.pid, item.start] as [number, string]).sort((a, b) => a[0] - b[0]);
    }

    private infrastructure(item: Identity): boolean {
        return path.basename(item.executable) === "codex-code-mode-host" && item.executable.includes("/vendor/");
    }

    async resolvePid(sessionId: string, command: string): Promise<number | null> {
        if (!this.enabled) return null;
        const scope = this.scopes.get(sessionId);
        if (!scope) throw new Error("Native workload ownership was not initialized");
        const matches: number[] = [];
        const simple = !/[;&|<>$()\'"\\\n]/.test(command) ? command.trim().split(/\s+/) : null;
        for (const item of await this.processes()) {
            if (item.scope !== scope || this.infrastructure(item)) continue;
            try {
                const args = (await readFile(`/proc/${item.pid}/cmdline`, "utf8")).split("\0");
                const shell = args.some((arg, index) => ["-c", "-lc"].includes(args[index - 1] ?? "") && arg === command);
                const argv = args.filter((arg, index) => arg !== "" || index < args.length - 1);
                const executable = simple && argv.length === simple.length && path.basename(argv[0] ?? "") === path.basename(simple[0] ?? "")
                    && argv.slice(1).every((arg, index) => arg === simple[index + 1]);
                if (shell || executable) matches.push(item.pid);
            } catch (error) {if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;}
        }
        if (matches.length > 1) throw new Error("Ambiguous native terminal ownership; stop is unconfirmed");
        return matches[0] ?? null;
    }

    async capture(sessionId: string, taskId: string, osPid: number | null | undefined): Promise<void> {
        if (!this.enabled) return;
        if (!Number.isSafeInteger(osPid) || osPid! <= 0) throw new Error("Codex did not provide a native OS PID; stop is unconfirmed");
        const scope = this.scopes.get(sessionId);
        if (!scope) throw new Error("Native workload ownership was not initialized");
        const all = await this.processes();
        const key = sessionId + "\0" + taskId;
        const owned = this.taskProcesses.get(key) ?? new Map<number, Identity>();
        const root = all.find(item => item.pid === osPid);
        if (root && root.scope !== scope) throw new Error("Cannot establish ownership of native terminal process");
        // A dead root cannot acquire a new identity through PID reuse.
        if (root && owned.has(root.pid) && owned.get(root.pid)!.start !== root.start) {
            throw new Error("Native process identity changed; stop is unconfirmed");
        }
        if (root && (!owned.has(root.pid) || owned.get(root.pid)!.start === root.start)) owned.set(root.pid, root);
        let changed = true;
        while (changed) {
            changed = false;
            for (const item of all) {
                if (!owned.has(item.pid) && all.some(parent => parent.pid === item.parent && owned.get(parent.pid)?.start === parent.start)) {owned.set(item.pid, item); changed = true;}
            }
        }
        if (root && ![...owned.values()].some(item => item.scope === scope)) {
            throw new Error("Cannot establish ownership of native terminal process");
        }
        this.taskProcesses.set(key, owned);
    }

    private async terminate(identities: () => Promise<Array<[number, string]>>): Promise<void> {
        const deadline = Date.now() + 3000;
        do {
            const remaining = await identities();
            if (remaining.length === 0) return;
            const verified: number[] = [];
            for (const [pid, start] of remaining) {
                try {
                    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
                    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                    if (fields[19] === start && fields[0] !== "Z") verified.push(pid);
                } catch (error) {
                    if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
                }
            }
            // Freeze the complete verified tree before killing a child. Otherwise a shell
            // waiting for that child can run its next command between two kill calls.
            const frozen: number[] = [];
            try {
                for (const pid of verified) {
                    try {process.kill(pid, "SIGSTOP"); frozen.push(pid);}
                    catch (error) {if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;}
                }
                for (const pid of frozen) {
                    try {process.kill(pid, "SIGKILL");}
                    catch (error) {if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;}
                }
            } catch (error) {
                for (const pid of frozen) {try {process.kill(pid, "SIGCONT");} catch {}}
                throw error;
            }
            await pause(30);
        } while (Date.now() < deadline);
        if ((await identities()).length === 0) return;
        throw new Error("Native workload stop could not be confirmed");
    }

    async stopTask(sessionId: string, taskId: string, osPid?: number | null): Promise<boolean> {
        if (!this.enabled) return false;
        await this.capture(sessionId, taskId, osPid);
        const key = sessionId + "\0" + taskId;
        const owned = this.taskProcesses.get(key)!;
        if (owned.size === 0) return false;
        await this.terminate(async () => {
            await this.capture(sessionId, taskId, osPid);
            return (await this.processes()).filter(item => owned.get(item.pid)?.start === item.start)
                .map(item => [item.pid, item.start]);
        });
        this.taskProcesses.delete(key);
        return true;
    }

    async stopSession(sessionId: string): Promise<void> {
        if (!this.enabled || !this.scopes.has(sessionId)) return;
        await this.terminate(() => this.snapshot(sessionId, true));
    }

    async stopAll(): Promise<void> {
        for (const sessionId of this.scopes.keys()) await this.stopSession(sessionId);
    }
}
