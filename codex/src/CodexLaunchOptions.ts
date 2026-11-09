import {resolve} from "node:path";
import {parse} from "smol-toml";
import type {JsonObject} from "./CodexAcpClient";
import type {JsonValue} from "./app-server/serde_json/JsonValue";

export type CodexLaunchOptions = {config: JsonObject | undefined; startupArgs: string[]};

/** Translate interactive CLI switches into App Server config and ACP defaults. */
export function codexLaunchOptions(args: string[], env: NodeJS.ProcessEnv = process.env): CodexLaunchOptions {
    const config: JsonObject = env["CODEX_CONFIG"] ? JSON.parse(env["CODEX_CONFIG"]) : {};
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("CODEX_CONFIG must be a JSON object.");
    const startupArgs: string[] = [];
    const directories: string[] = [];
    const setMode = (sandbox: string) => {
        const modes: Record<string, string> = {"read-only": "read-only", "workspace-write": "workspace-write", "danger-full-access": "agent-full-access"};
        if (!modes[sandbox]) throw new Error(`Unsupported sandbox: ${sandbox}`);
        env["INITIAL_AGENT_MODE"] = modes[sandbox];
    };
    const scalar = (key: string, value: string) => {
        startupArgs.push("-c", `${key}=${JSON.stringify(value)}`);
        config[key] = value;
    };
    const approval = (value: string) => {
        if (!["on-request", "never", "untrusted"].includes(value)) throw new Error(`Unsupported approval policy: ${value}`);
        env["ACP_WRAPPER_APPROVAL_POLICY"] = value;
        scalar("approval_policy", value);
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        const [flag, inline] = arg.split(/=(.*)/s, 2);
        const value = () => {
            const result = inline ?? args[++i];
            if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value.`);
            return result;
        };
        switch (flag) {
            case "--yolo":
            case "--dangerously-bypass-approvals-and-sandbox":
                if (inline !== undefined) throw new Error(`${flag} does not take a value.`);
                scalar("sandbox_mode", "danger-full-access");
                setMode("danger-full-access");
                approval("never");
                break;
            case "--full-auto":
                scalar("sandbox_mode", "workspace-write");
                setMode("workspace-write");
                approval("on-request");
                break;
            case "--approve-for-me":
            case "--not-so-yolo":
                scalar("sandbox_mode", "workspace-write");
                env["INITIAL_AGENT_MODE"] = "agent";
                approval("on-request");
                break;
            case "--model":
            case "-m":
                scalar("model", value());
                break;
            case "--sandbox":
            case "-s": {
                const sandbox = value();
                scalar("sandbox_mode", sandbox);
                setMode(sandbox);
                break;
            }
            case "--ask-for-approval":
            case "-a":
                approval(value());
                break;
            case "--config":
            case "-c": {
                const override = value();
                if (!override.includes("=")) throw new Error(`${flag} requires key=value.`);
                startupArgs.push("-c", override);
                const separator = override.indexOf("=");
                const key = override.slice(0, separator).trim();
                const raw = override.slice(separator + 1).trim();
                mergeOverride(config, key, raw);
                if (["model", "sandbox_mode", "approval_policy", "model_provider"].includes(key)) {
                    const parsed = config[key];
                    if (typeof parsed !== "string") throw new Error(`${key} must be a string.`);
                    if (key === "sandbox_mode") setMode(parsed);
                    if (key === "approval_policy") {
                        if (!["on-request", "never", "untrusted"].includes(parsed)) throw new Error(`Unsupported approval policy: ${parsed}`);
                        env["ACP_WRAPPER_APPROVAL_POLICY"] = parsed;
                    }
                }
                break;
            }
            case "--enable":
            case "--disable": {
                const feature = value();
                startupArgs.push(flag, feature);
                mergeOverride(config, `features.${JSON.stringify(feature)}`, String(flag === "--enable"));
                break;
            }
            case "--search":
                scalar("web_search", "live");
                break;
            case "--add-dir":
                directories.push(resolve(value()));
                break;
            case "--cd":
            case "-C":
            case "--listen":
            case "--stdio":
                throw new Error(`${flag} is controlled by ACP; use cli for native CLI commands.`);
            default:
                // New native App Server switches keep their original argv boundaries.
                startupArgs.push(arg);
                break;
        }
    }
    if (directories.length) env["ACP_WRAPPER_CODEX_DIRS"] = JSON.stringify(directories);
    return {config: Object.keys(config).length ? config : undefined, startupArgs};
}

/** Match Codex's TOML-value parsing, including its fallback to an unquoted string. */
function mergeOverride(config: JsonObject, key: string, raw: string): void {
    let value: JsonValue;
    try {
        const document = parse(`value = ${raw}`, {unsafeKeyBehaviour: "throw"});
        if (Object.keys(document).length !== 1 || !("value" in document)) throw new Error("Not one TOML value");
        value = JSON.parse(JSON.stringify(document["value"])) as JsonValue;
    } catch {
        value = raw;
    }
    const keys = parse(`${key} = 0`, {unsafeKeyBehaviour: "throw"});
    const assign = (target: JsonObject, tree: Record<string, unknown>) => {
        for (const [name, child] of Object.entries(tree)) {
            if (child && typeof child === "object" && !Array.isArray(child)) {
                const current = target[name];
                const next: JsonObject = current && typeof current === "object" && !Array.isArray(current) ? current : {};
                target[name] = next;
                assign(next, child as Record<string, unknown>);
            } else {
                target[name] = value;
            }
        }
    };
    assign(config, keys);
}
