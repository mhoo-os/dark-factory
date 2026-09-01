import { getSandbox } from "@cloudflare/sandbox";
import type { ExecutionJob } from "./ledger";

export type SandboxResult = { success: boolean; exitCode: number | null; stdout: string; stderr: string; held?: boolean };
type SandboxEnv = Pick<Env, "Sandbox" | "SANDBOX_COMMAND"> & { GITHUB_TOKEN?: string; OPENROUTER_API_KEY?: string; OPENROUTER_MODEL?: string };

export class SandboxExecutionAdapter {
  constructor(private readonly env: SandboxEnv) {}

  async run(job: ExecutionJob): Promise<SandboxResult> {
    if (!this.env.SANDBOX_COMMAND) {
      return { success: false, exitCode: null, stdout: "", stderr: "SANDBOX_COMMAND is not configured; execution is held", held: true };
    }
    if (!this.env.GITHUB_TOKEN) {
      return { success: false, exitCode: null, stdout: "", stderr: "GITHUB_TOKEN is not configured; execution is held", held: true };
    }
    if (!this.env.OPENROUTER_API_KEY || !this.env.OPENROUTER_MODEL) {
      return { success: false, exitCode: null, stdout: "", stderr: "OpenRouter credentials/model are not configured; execution is held", held: true };
    }
    const sandbox = getSandbox(this.env.Sandbox, `execution-${job.executionId}`);
    const remote = `https://x-access-token:${this.env.GITHUB_TOKEN}@github.com/${job.repository}.git`;
    await sandbox.gitCheckout(remote, { depth: 1, targetDir: "/workspace/project" });
    await sandbox.exec("git -C /workspace/project remote set-url origin https://github.com/" + job.repository + ".git", { timeout: 30_000 });
    return await sandbox.exec(this.env.SANDBOX_COMMAND, {
      cwd: "/workspace/project",
      timeout: 15 * 60 * 1000,
      env: {
        FACTORY_ISSUE: job.identifier,
        FACTORY_ISSUE_TITLE: job.title,
        FACTORY_ISSUE_DESCRIPTION: job.description,
        FACTORY_ISSUE_URL: job.url,
        FACTORY_REPOSITORY: job.repository,
        FACTORY_MAX_ITERATIONS: "8",
        FACTORY_MAX_COMMANDS: "24",
        OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
        OPENROUTER_MODEL: this.env.OPENROUTER_MODEL
      }
    });
  }
}
