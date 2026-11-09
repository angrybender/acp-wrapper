import { spawn } from "node:child_process";
import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/** Native arguments are appended as an argv array; no shell command is built. */
export function claudeLaunchOptions(): Partial<Options> {
  const encoded = process.env.ACP_WRAPPER_CLAUDE_ARGS;
  if (!encoded) return {};
  const args: unknown = JSON.parse(encoded);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("ACP_WRAPPER_CLAUDE_ARGS must be a JSON array of strings.");
  }
  const forwarded: string[] = [];
  const options: Partial<Options> = {};
  const reserved = new Set([
    "--input-format",
    "--output-format",
    "--print",
    "-p",
    "--resume",
    "-r",
    "--continue",
    "-c",
    "--session-id",
    "--fork-session",
    "--sdk-url",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg: string = args[i];
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    if (reserved.has(flag))
      throw new Error(`${flag} is controlled by ACP; use --cli for native CLI commands.`);
    if (flag === "--yolo" || flag === "--dangerously-skip-permissions") {
      if (inline !== undefined) throw new Error(`${flag} does not take a value.`);
      options.permissionMode = "bypassPermissions";
      forwarded.push("--dangerously-skip-permissions");
      continue;
    }
    if (flag === "--permission-mode" || flag === "--model") {
      const value: string | undefined = inline ?? args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      if (flag === "--permission-mode") {
        if (
          !["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan", "auto"].includes(
            value,
          )
        ) {
          throw new Error(`Unsupported Claude permission mode: ${value}`);
        }
        options.permissionMode = value as PermissionMode;
      } else {
        options.model = value;
      }
      forwarded.push(flag, value);
      continue;
    }
    forwarded.push(arg);
  }
  if (forwarded.length) {
    options.spawnClaudeCodeProcess = ({ command, args, cwd, env, signal }) =>
      spawn(command, [...args, ...forwarded], { cwd, env, signal, stdio: "pipe" });
  }
  return options;
}
