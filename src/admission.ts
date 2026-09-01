import type { ExecutionJob } from "./ledger";
import { sha256Hex } from "./crypto";

export class AdmissionError extends Error {}

type LinearIssue = {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  priority?: number;
  state?: { type?: string; name?: string };
  project?: { id?: string; slugId?: string; name?: string } | null;
  projectId?: string | null;
  labels?: Array<{ name?: string }> | { nodes?: Array<{ name?: string }> };
};

function issueFromEvent(payload: Record<string, unknown>): LinearIssue {
  const candidate = (payload.data ?? payload.issue ?? payload) as LinearIssue;
  if (!candidate || typeof candidate !== "object") throw new AdmissionError("issue payload is missing");
  return candidate;
}

function labelsOf(issue: LinearIssue): string[] {
  const labels = Array.isArray(issue.labels) ? issue.labels : issue.labels?.nodes ?? [];
  return labels.map((label) => label.name ?? "").filter(Boolean);
}

type AdmissionConfig = { LINEAR_PROJECT_ID: string; LINEAR_PROJECT_SLUG: string; ALLOWED_REPOSITORY_PREFIX: string; FACTORY_ENABLED: string; FACTORY_AUTONOMY: string; AUTO_MERGE: string };

export async function admitLinear(raw: string, env: AdmissionConfig): Promise<ExecutionJob> {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { throw new AdmissionError("invalid JSON"); }
  const issue = issueFromEvent(payload);
  if (env.FACTORY_ENABLED !== "true" || env.FACTORY_AUTONOMY !== "1") throw new AdmissionError("factory is not enabled for autonomous dispatch");
  if (env.AUTO_MERGE !== "false") throw new AdmissionError("automatic merge must remain disabled");
  if (!env.LINEAR_PROJECT_ID && !env.LINEAR_PROJECT_SLUG) throw new AdmissionError("LINEAR project identity is not configured");
  if (!issue.id || !issue.identifier || !issue.title || !issue.url) throw new AdmissionError("required issue fields are missing");
  const projectId = issue.project?.id ?? issue.projectId ?? null;
  const projectMatches = (Boolean(env.LINEAR_PROJECT_ID) && projectId === env.LINEAR_PROJECT_ID)
    || (Boolean(env.LINEAR_PROJECT_SLUG) && (issue.project?.slugId === env.LINEAR_PROJECT_SLUG || issue.project?.name === env.LINEAR_PROJECT_SLUG));
  if (!projectMatches) throw new AdmissionError("issue is outside the configured Linear project");
  if (!labelsOf(issue).includes("factory:accepted")) throw new AdmissionError("issue is not explicitly factory:accepted");
  if (["completed", "canceled", "cancelled"].includes(issue.state?.type ?? "")) throw new AdmissionError("issue is not active");
  const description = issue.description ?? "";
  const repositoryMatch = description.match(/Repository target:\s*`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?/i);
  if (!repositoryMatch) throw new AdmissionError("Repository target is missing");
  const repository = repositoryMatch[1];
  if (!repository.startsWith(env.ALLOWED_REPOSITORY_PREFIX || "mhoo-os/")) throw new AdmissionError("repository is outside the allowed organization");
  const priority = issue.priority ?? 3;
  if (![1, 2, 3, 4].includes(priority)) throw new AdmissionError("invalid Linear priority");
  return {
    executionId: `linear-${issue.id}`,
    linearIssueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description,
    url: issue.url,
    repository,
    priority
  };
}

export async function eventId(raw: string, header: string | null): Promise<string> {
  return header?.trim() || `body-${await sha256Hex(raw)}`;
}
