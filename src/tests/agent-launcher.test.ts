import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeCli, selectAgent } from "../agent-launcher.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "acp-launcher-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function executable(name: string, version: string) {
  const file = join(directory, name);
  await writeFile(
    file,
    `#!${process.execPath}\nif(process.argv[2]==='--version') console.log(${JSON.stringify(version)}); else { const fs=require('node:fs'); fs.writeFileSync(process.env.ARGV_CAPTURE,JSON.stringify(process.argv.slice(2))); process.exitCode=7; }\n`,
  );
  await chmod(file, 0o755);
  return file;
}

describe("native agent selection", () => {
  it.each([[], ["--version"], ["--cli", "--version"], ["--help"]])(
    "retains no-path Claude entry %j",
    async (...argv) => {
      expect(await selectAgent(argv as string[])).toBeUndefined();
    },
  );

  it.each([
    ["codex-cli 0.160.1", "codex"],
    ["2.1.90 (Claude Code)", "claude"],
  ])("probes %s through a path with spaces", async (version, agent) => {
    const path = await executable("native agent", version);
    expect(await selectAgent([path, "--yolo", "--model", "some model"])).toEqual({
      agent,
      path,
      args: ["--yolo", "--model", "some model"],
      nativeCli: false,
    });
  });

  it("identifies the target of a renamed symlink and resolves PATH", async () => {
    const target = await executable("native", "codex-cli 0.160.1");
    const alias = join(directory, "my-agent");
    await symlink(target, alias);
    vi.stubEnv("PATH", directory);
    expect((await selectAgent(["my-agent", "-c", "model='literal'"]))?.agent).toBe("codex");
  });

  it.each(["Something else 1.0", "@agentclientprotocol/codex-acp 2.2.2"])(
    "rejects non-native version %s",
    async (version) => {
      const file = await executable("codex", version);
      await expect(selectAgent([file])).rejects.toThrow("Unsupported agent");
    },
  );

  it("rejects missing and non-executable paths", async () => {
    await expect(selectAgent([join(directory, "missing")])).rejects.toThrow("not executable");
    const file = await executable("claude", "2.1.90 (Claude Code)");
    await chmod(file, 0o644);
    await expect(selectAgent([file])).rejects.toThrow("not executable");
  });

  it.each([
    ["--version"],
    ["--model", "x", "--help"],
    ["--cli", "--version"],
    ["cli", "--version"],
    ["login", "status"],
    ["logout"],
    ["exec", "a prompt"],
  ])("delegates native mode %j", async (...argv) => {
    const file = await executable("codex", "codex-cli 0.160.1");
    expect((await selectAgent([file, ...(argv as string[])]))?.nativeCli).toBe(true);
  });

  it("forwards argv literally and preserves the native exit code", async () => {
    const file = await executable("codex", "codex-cli 0.160.1");
    const capture = join(directory, "argv.json");
    vi.stubEnv("ARGV_CAPTURE", capture);
    const args = [
      "exec",
      "space and quotes ' \"",
      "$(touch should-not-exist)",
      "--config=model='a=b'",
    ];
    expect(await runNativeCli(file, args)).toBe(7);
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual(args);
  });
});
