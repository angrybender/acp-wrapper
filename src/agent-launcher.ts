import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentLaunch = {
  agent: "claude" | "codex";
  path: string;
  args: string[];
  nativeCli: boolean;
};

async function executablePath(value: string): Promise<string> {
  const candidates =
    isAbsolute(value) || value.includes("/") || value.includes("\\")
      ? [resolve(value)]
      : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next PATH entry. An explicit path has just one candidate.
    }
  }
  throw new Error(`Agent executable not found or not executable: ${value}`);
}

/** Probe the supplied executable, rather than guessing from a symlink's name. */
export async function selectAgent(args: string[]): Promise<AgentLaunch | undefined> {
  const [target, ...remaining] = args;
  if (!target || target.startsWith("-")) return undefined;
  const path = await executablePath(target);
  let version: string;
  try {
    const result = await execFileAsync(path, ["--version"], {
      timeout: 5000,
      maxBuffer: 8192,
      windowsHide: true,
    });
    version = `${result.stdout}\n${result.stderr}`;
  } catch {
    throw new Error(`Cannot identify agent at ${path}: --version failed or timed out.`);
  }
  const agent = /(?:^|\n)\s*codex(?:-cli)?\s+\d/i.test(version)
    ? "codex"
    : /\bclaude code\b|(?:^|\n)\s*claude\s+\d/i.test(version)
      ? "claude"
      : undefined;
  if (!agent) throw new Error(`Unsupported agent at ${path}: expected Claude Code or Codex CLI.`);
  const cliFlag = remaining.includes("--cli");
  const cliCommand = agent === "codex" && remaining[0] === "cli";
  const passthrough = cliFlag || cliCommand;
  const nativeArgs = cliFlag
    ? remaining.filter((arg) => arg !== "--cli")
    : cliCommand
      ? remaining.slice(1)
      : remaining;
  const nativeCli =
    passthrough ||
    nativeArgs.some((arg) => ["--version", "-v", "-V", "--help", "-h"].includes(arg)) ||
    Boolean(nativeArgs[0] && !nativeArgs[0].startsWith("-"));
  return { agent, path, args: nativeArgs, nativeCli };
}

/** Preserve argument boundaries, stdio, exit status and termination signals. */
export async function runNativeCli(path: string, args: string[]): Promise<number> {
  const child = spawn(path, args, { stdio: "inherit" });
  const signals =
    process.platform === "win32"
      ? (["SIGINT", "SIGTERM"] as const)
      : (["SIGINT", "SIGTERM", "SIGHUP"] as const);
  const handlers = signals.map((signal) => {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        for (const [name, handler] of handlers) process.removeListener(name, handler);
        if (signal && process.platform !== "win32") process.kill(process.pid, signal);
        resolve(code ?? 1);
      });
    });
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
}
