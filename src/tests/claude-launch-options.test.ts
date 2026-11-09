import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeLaunchOptions } from "../claude-launch-options.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.unstubAllEnvs());

describe("Claude native launch flags", () => {
  it("keeps SDK defaults without explicit native flags", () => {
    vi.stubEnv("ACP_WRAPPER_CLAUDE_ARGS", "");
    expect(claudeLaunchOptions()).toEqual({});
  });

  it.each(["--yolo", "--dangerously-skip-permissions"])("selects bypass mode for %s", (flag) => {
    vi.stubEnv("ACP_WRAPPER_CLAUDE_ARGS", JSON.stringify([flag, "--model", "some-model"]));
    expect(claudeLaunchOptions()).toMatchObject({
      permissionMode: "bypassPermissions",
      model: "some-model",
    });
    expect(claudeLaunchOptions().spawnClaudeCodeProcess).toBeTypeOf("function");
  });

  it.each(["--permission-mode=plan", "--model=some-model"])("accepts equals syntax %s", (flag) => {
    vi.stubEnv("ACP_WRAPPER_CLAUDE_ARGS", JSON.stringify([flag]));
    expect(claudeLaunchOptions()).toMatchObject(
      flag.includes("plan") ? { permissionMode: "plan" } : { model: "some-model" },
    );
  });

  it("forwards repeated flags and quoted values to the actual SDK subprocess without a shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-launch-"));
    try {
      const file = join(directory, "mock native.cjs");
      await writeFile(file, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
      const args = [
        "--allowedTools",
        "Read",
        "--allowedTools",
        "Bash(a b)",
        "--settings",
        "$(touch literal) 'quoted'",
      ];
      vi.stubEnv("ACP_WRAPPER_CLAUDE_ARGS", JSON.stringify(args));
      const spawnNative = claudeLaunchOptions().spawnClaudeCodeProcess!;
      const child = spawnNative({
        command: process.execPath,
        args: [file, "--sdk-generated"],
        cwd: directory,
        env: process.env,
        signal: new AbortController().signal,
      });
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      const code = await new Promise((resolve) => child.on("exit", resolve));
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual(["--sdk-generated", ...args]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["--model"],
    ["--permission-mode", "unknown"],
    ["--yolo=false"],
    ["--output-format=text"],
    ["--resume", "old"],
  ])("rejects invalid or ACP-owned flags %j", (...args) => {
    vi.stubEnv("ACP_WRAPPER_CLAUDE_ARGS", JSON.stringify(args));
    expect(() => claudeLaunchOptions()).toThrow();
  });
});
