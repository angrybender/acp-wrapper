#!/usr/bin/env node

import { existsSync } from "node:fs";
import { selectAgent, runNativeCli } from "./agent-launcher.js";
import { claudeLaunchOptions } from "./claude-launch-options.js";

try {
  const selected = await selectAgent(process.argv.slice(2));
  if (!selected) {
    // Keep the original no-path invocation, --version and --cli behavior.
    await import("./claude-entry.js");
  } else if (selected.nativeCli) {
    process.exitCode = await runNativeCli(selected.path, selected.args);
  } else {
    process.argv = [process.argv[0], process.argv[1], ...selected.args];
    if (selected.agent === "claude") {
      process.env.CLAUDE_CODE_EXECUTABLE = selected.path;
      process.env.ACP_WRAPPER_CLAUDE_ARGS = JSON.stringify(selected.args);
      claudeLaunchOptions(); // Reject incompatible flags before accepting ACP.
      await import("./claude-entry.js");
    } else {
      process.env.CODEX_PATH = selected.path;
      const backend = new URL("../codex/dist/index.js", import.meta.url);
      if (!existsSync(backend)) {
        throw new Error(
          "Codex ACP backend is missing. Reinstall with install.py, or build codex/ with npm ci --ignore-scripts and npm run build.",
        );
      }
      await import(backend.href);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
