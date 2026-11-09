import {afterEach, describe, expect, it, vi} from "vitest";
import {codexLaunchOptions} from "../CodexLaunchOptions";
import {AgentMode} from "../AgentMode";

afterEach(() => vi.unstubAllEnvs());

describe("native Codex flags in ACP", () => {
    it("preserves environment-only config and the old default mode", () => {
        const env = {CODEX_CONFIG: '{"model":"existing"}'};
        expect(codexLaunchOptions([], env)).toEqual({config: {model: "existing"}, startupArgs: []});
        expect(env).toEqual({CODEX_CONFIG: '{"model":"existing"}'});
    });

    it.each(["--yolo", "--dangerously-bypass-approvals-and-sandbox"])("applies %s to both native config and ACP mode", flag => {
        vi.stubEnv("INITIAL_AGENT_MODE", "read-only");
        vi.stubEnv("ACP_WRAPPER_APPROVAL_POLICY", "");
        const launch = codexLaunchOptions([flag]);
        expect(launch.config).toEqual({sandbox_mode: "danger-full-access", approval_policy: "never"});
        expect(launch.startupArgs).toContain('sandbox_mode="danger-full-access"');
        const mode = AgentMode.getInitialAgentMode();
        expect(mode.id).toBe("agent-full-access");
        expect(mode.approvalPolicy).toBe("never");
        expect(mode.sandboxPolicy).toEqual({type: "dangerFullAccess"});
    });

    it("retains config boundaries, repeated feature flags and values containing equals signs", () => {
        const env: NodeJS.ProcessEnv = {CODEX_CONFIG: '{"model":"old","features":{"x":true}}'};
        const args = ["-m", "new model", "-c", 'developer_instructions="keep a=b"', "--enable", "one", "--disable", "two", "--strict-config"];
        const result = codexLaunchOptions(args, env);
        expect(result.config).toMatchObject({model: "new model", features: {x: true}});
        expect(result.startupArgs).toEqual(["-c", 'model="new model"', "-c", 'developer_instructions="keep a=b"', "--enable", "one", "--disable", "two", "--strict-config"]);
    });

    it("supports separate sandbox and approval choices", () => {
        vi.stubEnv("INITIAL_AGENT_MODE", "agent");
        vi.stubEnv("ACP_WRAPPER_APPROVAL_POLICY", "");
        codexLaunchOptions(["--sandbox=workspace-write", "--ask-for-approval=never"]);
        const mode = AgentMode.getInitialAgentMode();
        expect(mode.id).toBe("workspace-write");
        expect(mode.approvalPolicy).toBe("never");
        expect(mode.sandboxPolicy.type).toBe("workspaceWrite");
    });

    it("reflects permission config overrides in the initial ACP mode", () => {
        const env: NodeJS.ProcessEnv = {};
        const launch = codexLaunchOptions(["-c", "sandbox_mode='read-only'", "-c", 'approval_policy="untrusted"'], env);
        expect(env["INITIAL_AGENT_MODE"]).toBe("read-only");
        expect(env["ACP_WRAPPER_APPROVAL_POLICY"]).toBe("untrusted");
        expect(launch.config).toEqual({sandbox_mode: "read-only", approval_policy: "untrusted"});
    });

    it("records all additional writable directories", () => {
        const env: NodeJS.ProcessEnv = {};
        codexLaunchOptions(["--add-dir", "/tmp/with space", "--add-dir=/tmp/other"], env);
        expect(JSON.parse(env["ACP_WRAPPER_CODEX_DIRS"]!)).toEqual(["/tmp/with space", "/tmp/other"]);
    });

    it("merges native TOML tables, arrays, quoted keys and feature flags over environment config", () => {
        const env: NodeJS.ProcessEnv = {CODEX_CONFIG: '{"features":{"keep":true,"multi_agent":false},"model_providers":{"local":{"name":"Keep"}}}'};
        const result = codexLaunchOptions(["--enable", "multi_agent", "--disable", "other",
            "-c", "model_providers.local.base_url='http://127.0.0.1:9/a=b'",
            "-c", 'sandbox_workspace_write.writable_roots=["/tmp/a b", "/tmp/c"]',
            "-c", 'model_providers."with.dot".wire_api=responses'], env);
        expect(result.config).toMatchObject({
            features: {keep: true, multi_agent: true, other: false},
            model_providers: {local: {name: "Keep", base_url: "http://127.0.0.1:9/a=b"}, "with.dot": {wire_api: "responses"}},
            sandbox_workspace_write: {writable_roots: ["/tmp/a b", "/tmp/c"]},
        });
    });

    it.each([["--model"], ["--yolo=false"], ["--sandbox", "invalid"], ["-a", "invalid"], ["--config", "no-equals"], ["--cd", "/tmp"], ["--listen=ws://127.0.0.1:0"]])("rejects invalid flags %j", (...args) => {
        expect(() => codexLaunchOptions(args, {})).toThrow();
    });
});
