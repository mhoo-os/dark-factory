import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { releaseLease, setExecutionState, type ExecutionJob } from "./ledger";
import { SandboxExecutionAdapter } from "./sandbox";

function jobFrom(event: WorkflowEvent<ExecutionJob>): ExecutionJob {
  const job = event.payload;
  if (!job?.executionId || !job.repository || !job.identifier) throw new Error("workflow payload is invalid");
  return job;
}

export class ExecutionWorkflow extends WorkflowEntrypoint<Env, ExecutionJob> {
  async run(event: WorkflowEvent<ExecutionJob>, step: WorkflowStep): Promise<unknown> {
    const job = jobFrom(event);
    await step.do("mark-running", () => setExecutionState(this.env.DB, job.executionId, "running"));
    const result = await step.do("bounded-ground-execution", { retries: { limit: 1, delay: "30 seconds" }, timeout: "16 minutes" }, () => new SandboxExecutionAdapter(this.env).run(job));
    await step.do("reconcile-result", async () => {
      const state = result.held ? "needs-human" : result.success ? "succeeded" : "failed";
      await setExecutionState(this.env.DB, job.executionId, state, result);
      await releaseLease(this.env.DB, job.repository, job.executionId);
      return state;
    });
    return result;
  }
}
