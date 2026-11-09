// Exercise the compiled/installed launcher with real native CLIs, without a model prompt.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(process.argv[2] ?? join(root, "dist/index.js"));
const codexRequire = createRequire(join(root, "codex/package.json"));
const codex = codexRequire.resolve("@openai/codex/bin/codex.js");
const { claudeCliPath } = await import("../dist/acp-agent.js");
const claude = await claudeCliPath();
const temporary = await mkdtemp(join(tmpdir(), "acp-launcher-smoke-"));

async function smoke(agent, executable, args) {
  const cwd = join(temporary, agent);
  await mkdir(cwd);
  const env = { ...process.env, CODEX_HOME: cwd, CLAUDE_CONFIG_DIR: cwd };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("OPENAI_") ||
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("ACP_WRAPPER_")
    ) {
      delete env[key];
    }
  }
  env.CODEX_CONFIG = JSON.stringify({
    model: "launcher-smoke",
    model_provider: "smoke",
    model_providers: {
      smoke: {
        name: "Local smoke",
        base_url: "http://127.0.0.1:9/v1",
        wire_api: "responses",
        requires_openai_auth: false,
      },
    },
  });
  if (agent === "codex") {
    await writeFile(
      join(cwd, "config.toml"),
      [
        'model = "launcher-smoke"',
        'model_provider = "smoke"',
        "[model_providers.smoke]",
        'name = "Local smoke"',
        'base_url = "http://127.0.0.1:9/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "",
      ].join("\n"),
    );
  }
  const child = spawn(process.execPath, [entry, executable, ...args], {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        request(message);
      }
    } catch (error) {
      console.error("Non-ACP stdout:", error.message);
    }
  });
  let id = 0;
  const request = async (method, params) => {
    const number = ++id;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${agent} ${method} timed out: ${stderr.slice(-2000)}`)),
          20000,
        );
        pending.set(number, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: number, method, params }) + "\n");
      });
    } finally {
      clearTimeout(timer);
      pending.delete(number);
    }
  };
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  try {
    const result = await request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "launcher-smoke", version: "1" },
      clientCapabilities: {
        _meta: {
          orchestratorBackgroundTasks: 1,
          jetbrains: {
            air: {
              version: 1,
              capabilities: ["asyncTasks", "nativeSubagentSessions", "sessionFailure"],
            },
          },
        },
      },
    });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.match(result.result.agentInfo.name, new RegExp(agent + "-agent-acp|" + agent + "-acp"));
    assert.equal(result.result._meta.orchestratorBackgroundTasks.version, 1);
    if (agent === "codex") {
      const session = await request("session/new", { cwd, mcpServers: [] });
      assert.equal(session.error, undefined, JSON.stringify(session.error));
      assert.equal(session.result.modes.currentModeId, "agent-full-access");
      await request("session/close", { sessionId: session.result.sessionId });
    }
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5000);
    const status = await exited;
    clearTimeout(timeout);
    assert.equal(status.code, 0, stderr.slice(-2000));
    console.log(
      `PASS: ${agent} native executable selection, ACP v1, background contract${agent === "codex" ? ", --yolo session mode" : ""}, clean exit`,
    );
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
      await exited;
    }
  }
}

try {
  await smoke("codex", codex, ["--yolo"]);
  await smoke("claude", claude, []);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
