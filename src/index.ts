import { getSandbox } from "@cloudflare/sandbox";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import registryArtifact from "../factory/factory_registry.json";

export { Sandbox } from "@cloudflare/sandbox";

const CONTRACT_OPEN = "<!-- mhoo-factory-dispatch:v1 -->";
const CONTRACT_CLOSE = "<!-- /mhoo-factory-dispatch:v1 -->";
const ISSUE_STATES = new Set(["unstarted", "started"]);
const STALE_CONDITIONS = new Set([
  "planning_revision_changed",
  "planning_fingerprint_changed",
  "base_sha_changed",
]);
const SHA40 = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^mhoo-os\/[a-z0-9][a-z0-9._-]{0,99}$/;
const ISSUE_IDENTIFIER = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/;
const BRANCH = /^factory\/[a-z0-9][a-z0-9-]{0,127}$/;
const RUN_ID = /^run-v1-[0-9a-f]{32}$/;
const GITHUB_API_VERSION = "2022-11-28";
const MAX_PROVIDER_BODY_BYTES = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 30_000;
const GITHUB_EVENT_TYPES = new Set(["pull_request", "workflow_run"]);
const FACTORY_REGISTRY = registryArtifact as unknown as ObjectValue;
const ACTIVE_FACTORY_STATES = new Set(["pilot", "limited", "enabled"]);
const RISK_ORDER: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2 };
const AUTHORITY_ORDER: Readonly<Record<string, number>> = { "repository-local": 0, "cross-system": 1 };
const MERGE_ORDER: Readonly<Record<string, number>> = { human: 0, "auto-eligible": 1 };

type TransitionActor =
  | "admission"
  | "scheduler"
  | "workflow"
  | "validator"
  | "reconciler"
  | "external-github"
  | "external-linear"
  | "human-override"
  | "human-planning";

// Keep the Worker-side authorization table explicit. The Python reference
// implementation and this table must agree before a state write is allowed.
const TRANSITION_ACTORS: Readonly<Record<string, readonly TransitionActor[]>> = {
  "proposed->admitted": ["admission"],
  "proposed->not-admitted": ["admission"],
  "proposed->needs-human": ["admission", "human-override"],
  "not-admitted->proposed": ["human-planning", "human-override"],
  "admitted->queued": ["admission", "scheduler"],
  "admitted->blocked-by-dependency": ["scheduler"],
  "admitted->needs-replan": ["reconciler"],
  "admitted->needs-human": ["reconciler", "human-override"],
  "blocked-by-dependency->queued": ["scheduler", "reconciler"],
  "blocked-by-dependency->needs-replan": ["reconciler"],
  "blocked-by-dependency->needs-human": ["reconciler", "human-override"],
  "queued->blocked-by-dependency": ["scheduler", "reconciler"],
  "queued->leased": ["scheduler"],
  "queued->needs-replan": ["reconciler"],
  "queued->needs-human": ["scheduler", "reconciler", "human-override"],
  "queued->stopped": ["human-override"],
  "leased->running": ["workflow"],
  "leased->queued": ["reconciler"],
  "leased->needs-human": ["reconciler", "human-override"],
  "leased->stopped": ["human-override"],
  "running->validating": ["workflow"],
  "running->needs-replan": ["workflow", "reconciler"],
  "running->needs-human": ["workflow", "reconciler", "human-override"],
  "running->failed": ["workflow", "reconciler"],
  "running->stopped": ["human-override"],
  "validating->pr-open": ["workflow"],
  "validating->fixable-failure": ["validator"],
  "validating->failed": ["validator"],
  "validating->needs-human": ["validator", "reconciler", "human-override"],
  "validating->stopped": ["human-override"],
  "fixable-failure->running": ["workflow"],
  "fixable-failure->failed": ["workflow", "validator"],
  "fixable-failure->needs-human": ["workflow", "validator", "human-override"],
  "pr-open->pr-passed": ["validator"],
  "pr-open->pr-merged": ["external-github", "reconciler"],
  "pr-open->reconciliation-only": ["external-github", "external-linear", "reconciler"],
  "pr-open->needs-replan": ["external-linear", "reconciler"],
  "pr-open->needs-human": ["reconciler", "human-override"],
  "pr-open->pr-canceled": ["external-github", "human-override"],
  "pr-open->stopped": ["human-override"],
  "pr-passed->pr-merged": ["external-github", "reconciler"],
  "pr-passed->pr-open": ["external-github", "reconciler"],
  "pr-passed->needs-replan": ["reconciler"],
  "pr-passed->reconciliation-only": ["external-github", "external-linear", "reconciler"],
  "pr-passed->needs-human": ["reconciler", "human-override"],
  "pr-passed->pr-canceled": ["external-github", "human-override"],
  "reconciliation-only->pr-open": ["external-github", "external-linear", "reconciler"],
  "reconciliation-only->pr-merged": ["external-github", "reconciler"],
  "reconciliation-only->pr-canceled": ["external-github", "reconciler"],
  "reconciliation-only->needs-replan": ["reconciler"],
  "reconciliation-only->queued": ["reconciler"],
  "reconciliation-only->needs-human": ["reconciler", "human-override"],
  "needs-replan->proposed": ["human-planning", "human-override"],
  "needs-human->proposed": ["human-override"],
  "failed->proposed": ["human-override"],
  "stopped->queued": ["human-override"],
};

type ObjectValue = Record<string, unknown>;
type Contract = {
  contract_version: "v1";
  dispatch_id: string;
  linear: {
    project_id: string;
    issue_id: string;
    identifier: string;
    planning_revision: string;
    planning_fingerprint: string;
  };
  target: {
    repository: string;
    work_type: string;
    execution_profile: string;
    collision_group: string;
    base_sha: string;
  };
  dependencies: Array<{ issue_id: string; required_state: "completed" }>;
  risk: { risk_class: "low" | "medium" | "high"; authority_class: "repository-local" | "cross-system" };
  acceptance_criteria: string[];
  validation_profile: string;
  allowed_scope: { paths: string[]; max_files: number; max_changed_lines: number };
  merge_policy: "human" | "auto-eligible";
  stale_conditions: string[];
  factory_request: {
    credential_profile: string;
    concurrency: number;
    model_policy_key: string;
    escalation_class: string;
    effect_classes: string[];
  };
  registry: {
    factory_id: string;
    registry_version: string;
    registry_digest: string;
    entry_version: string;
  };
};

type RegistryBinding = {
  identity: Contract["registry"];
  factory: ObjectValue;
  repository: ObjectValue;
};

type DispatchJob = { kind: "dispatch"; dispatchId: string; runId: string; contractDigest: string; contract: Contract };
type GitHubReconciliationJob = {
  kind: "github-reconciliation";
  eventId: string;
  runId?: string;
  branch?: string;
  repository: string;
  prNumber?: number;
  action: string;
};
type Job = DispatchJob;
type QueueJob = DispatchJob | GitHubReconciliationJob;
type Run = {
  dispatch_id: string;
  run_id: string;
  contract_digest: string;
  profile_digest: string;
  factory_id: string;
  registry_version: string;
  registry_digest: string;
  registry_entry_version: string;
  contract_json: string;
  linear_issue_id: string;
  repository: string;
  collision_group: string;
  base_sha: string;
  current_state: string;
  workflow_id: string | null;
  lease_owner: string | null;
  lease_fence: number | null;
  lease_expires_at: string | null;
  branch: string | null;
  head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  created_at: string;
};

class AdmissionError extends Error {}

type IngressReceipt = { outcome: "inserted" | "duplicate" | "conflict"; handoffState: string | null; normalized: ObjectValue | null };
type AgentResult = {
  status: "passed" | "failed" | "needs-replan" | "needs-human";
  reason: string;
  cost_usd?: number;
  provider_usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost_usd: number };
  branch?: string;
  head_sha?: string;
  diff_digest?: string;
  validation_digest?: string;
  validation_bytes?: number;
  changed_files?: string[];
};
type PullRequest = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
};
type ValidationResult = {
  status: "passed" | "failed";
  exit_code: number;
  output_digest: string;
  output_bytes: number;
  reason: string;
  fixable: boolean;
};

const response = (body: ObjectValue, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function secret(env: Env, name: string): string | undefined {
  const value = Reflect.get(env, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type SandboxCredentials = { githubToken?: string; openRouterKey?: string };

function sandboxCredentials(env: Env, contract: Contract): SandboxCredentials {
  // The credential profile is an authorization boundary, not a label. In
  // particular, the `none` profile is deliberately an empty environment.
  if (contract.factory_request.credential_profile === "none") return {};
  if (contract.factory_request.credential_profile !== "github-linear-openrouter-v1") throw new Error("credential_profile_runtime_unsupported");
  const githubToken = secret(env, "GITHUB_TOKEN");
  const openRouterKey = secret(env, "OPENROUTER_API_KEY");
  if (!githubToken || !openRouterKey) throw new Error("execution_credentials_missing");
  return { githubToken, openRouterKey };
}

function sandboxRemote(repository: string, githubToken?: string): string {
  return githubToken
    ? `https://x-access-token:${encodeURIComponent(githubToken)}@github.com/${repository}.git`
    : `https://github.com/${repository}.git`;
}

function configInteger(env: Env, name: string, minimum: number, maximum: number): number | null {
  const parsed = Number(Reflect.get(env, name));
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function configMoney(env: Env, name: string, minimum: number, maximum: number): number | null {
  const parsed = Number(Reflect.get(env, name));
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as ObjectValue;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function textDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function records(value: unknown, reason: string): ObjectValue[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new AdmissionError(reason);
  }
  return value as ObjectValue[];
}

function strings(value: unknown, reason: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new AdmissionError(reason);
  }
  return value as string[];
}

function providerId(issue: ObjectValue, field: "project" | "team"): string {
  const nested = issue[field];
  const direct = issue[`${field}_id`] ?? issue[`${field}Id`];
  const value = nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as ObjectValue).id : direct;
  return text(value, `registry_${field}_identity_missing`);
}

function uniqueBy(items: ObjectValue[], key: string, reason: string): void {
  const values = items.map((item) => text(item[key], reason));
  if (new Set(values).size !== values.length) throw new AdmissionError(reason);
}

function nonNegativeNumber(value: unknown, reason: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new AdmissionError(reason);
  return value;
}

function inherentEffectClasses(contract: Omit<Contract, "registry"> | Contract): string[] {
  // A contract cannot omit the effects intrinsic to executing it. Repository
  // mutation is inherent, a non-empty sandbox profile can read providers, and
  // automatic merge would be an additional effect even if a caller hid it.
  return [
    "repository-write",
    ...(contract.factory_request.credential_profile === "none" ? [] : ["provider-read"]),
    ...(contract.merge_policy === "auto-eligible" ? ["merge"] : []),
  ];
}

function executionLimits(contract: Contract): { timeoutSeconds: number; costUsd: number } {
  const executions = records(FACTORY_REGISTRY.execution_profiles, "registry_execution_profiles_invalid");
  const execution = executions.find((item) => item.id === contract.target.execution_profile);
  const factories = records(FACTORY_REGISTRY.factories, "registry_factories_invalid");
  const factory = factories.find((item) => item.factory_id === contract.registry.factory_id);
  const limits = execution?.limits as ObjectValue | undefined;
  const capacity = factory?.capacity as ObjectValue | undefined;
  if (!limits || !capacity || typeof limits !== "object" || typeof capacity !== "object") throw new Error("registry_runtime_limits_invalid");
  const timeoutSeconds = Math.min(nonNegativeNumber(limits.timeout_seconds, "registry_timeout_invalid"), nonNegativeNumber(capacity.timeout_seconds, "registry_timeout_invalid"));
  const costUsd = Math.min(nonNegativeNumber(limits.cost_usd, "registry_cost_invalid"), nonNegativeNumber(capacity.cost_usd, "registry_cost_invalid"));
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || costUsd < 0) throw new Error("registry_runtime_limits_invalid");
  return { timeoutSeconds, costUsd };
}

function runtimeExecutionLimits(env: Env, contract: Contract): { timeoutSeconds: number; costUsd: number } {
  const registryLimits = executionLimits(contract);
  const configuredCost = configMoney(env, "MAX_COST_USD", 0.01, registryLimits.costUsd);
  if (configuredCost === null) throw new Error("cost_cap_config_invalid");
  return { ...registryLimits, costUsd: configuredCost };
}

async function resolveFactory(issue: ObjectValue, contract: Omit<Contract, "registry">): Promise<RegistryBinding> {
  if (FACTORY_REGISTRY.schema_version !== "v1") throw new AdmissionError("registry_schema_invalid");
  const registryVersion = text(FACTORY_REGISTRY.registry_version, "registry_version_invalid");
  const factories = records(FACTORY_REGISTRY.factories, "registry_factories_invalid");
  if (factories.length === 0) throw new AdmissionError("registry_factories_invalid");
  uniqueBy(factories, "factory_id", "registry_factory_id_ambiguous");
  const projectId = providerId(issue, "project");
  const teamId = providerId(issue, "team");
  const matches = factories.filter((factory) => {
    const linear = factory.linear;
    return linear && typeof linear === "object" && !Array.isArray(linear)
      && strings((linear as ObjectValue).project_ids, "registry_project_ids_invalid").includes(projectId);
  });
  if (matches.length === 0) throw new AdmissionError("registry_unknown_project");
  if (matches.length !== 1) throw new AdmissionError("registry_ambiguous_project");
  const factory = matches[0];
  if (!ACTIVE_FACTORY_STATES.has(String(factory.state))) throw new AdmissionError("registry_factory_disabled");
  const linear = factory.linear as ObjectValue;
  if (!strings(linear.team_ids, "registry_team_ids_invalid").includes(teamId)) throw new AdmissionError("registry_team_not_allowed");
  const state = issue.state;
  const stateType = state && typeof state === "object" && !Array.isArray(state) ? (state as ObjectValue).type : undefined;
  if (!strings(linear.eligible_state_types, "registry_state_types_invalid").includes(String(stateType))) throw new AdmissionError("registry_issue_state_not_allowed");
  if (!strings(linear.required_contract_versions, "registry_contract_versions_invalid").includes(contract.contract_version)) throw new AdmissionError("registry_contract_version_not_allowed");
  const requiredLabels = strings(linear.required_labels, "registry_required_labels_invalid");
  if (requiredLabels.some((label) => !labels(issue).includes(label))) throw new AdmissionError("registry_required_label_missing");

  const repositories = records(factory.repositories, "registry_repositories_invalid");
  uniqueBy(repositories, "repository", "registry_repository_ambiguous");
  const repositoryMatches = repositories.filter((item) => item.repository === contract.target.repository);
  if (repositoryMatches.length === 0) throw new AdmissionError("registry_repository_not_allowed");
  if (repositoryMatches.length !== 1) throw new AdmissionError("registry_repository_ambiguous");
  const repository = repositoryMatches[0];
  for (const [requested, allowed, reason] of [
    [contract.target.work_type, repository.work_types, "registry_work_type_not_allowed"],
    [contract.target.execution_profile, repository.execution_profiles, "registry_execution_profile_not_allowed"],
    [contract.validation_profile, repository.validation_profiles, "registry_validation_profile_not_allowed"],
    [contract.target.collision_group, repository.collision_groups, "registry_collision_group_not_allowed"],
  ] as const) {
    if (!strings(allowed, reason).includes(requested)) throw new AdmissionError(reason);
  }
  const scope = repository.scope as ObjectValue;
  const capacity = factory.capacity as ObjectValue;
  if (!scope || typeof scope !== "object" || !capacity || typeof capacity !== "object") throw new AdmissionError("registry_capacity_invalid");
  if (contract.allowed_scope.max_files > Number(scope.max_files) || contract.allowed_scope.max_files > Number(capacity.max_files)) throw new AdmissionError("registry_scope_max_files_exceeded");
  if (contract.allowed_scope.max_changed_lines > Number(scope.max_changed_lines) || contract.allowed_scope.max_changed_lines > Number(capacity.max_changed_lines)) throw new AdmissionError("registry_scope_max_changed_lines_exceeded");
  const allowedPaths = strings(scope.paths, "registry_scope_paths_invalid");
  if (contract.allowed_scope.paths.some((path) => !pathMatchesScope(path, allowedPaths))) throw new AdmissionError("registry_scope_path_not_allowed");
  const risk = factory.risk as ObjectValue;
  if ((RISK_ORDER[contract.risk.risk_class] ?? 99) > (RISK_ORDER[String(risk.maximum_risk_class)] ?? -1)) throw new AdmissionError("registry_risk_ceiling_exceeded");
  if ((AUTHORITY_ORDER[contract.risk.authority_class] ?? 99) > (AUTHORITY_ORDER[String(risk.maximum_authority_class)] ?? -1)) throw new AdmissionError("registry_authority_ceiling_exceeded");
  if ((MERGE_ORDER[contract.merge_policy] ?? 99) > (MERGE_ORDER[String(risk.merge_ceiling)] ?? -1)) throw new AdmissionError("registry_merge_ceiling_exceeded");
  if (contract.merge_policy !== "human" || risk.merge_ceiling !== "human") throw new AdmissionError("registry_human_merge_required");
  if (!strings(risk.autonomous_merge_exclusions, "registry_autonomous_merge_exclusions_invalid").includes(contract.target.repository)) throw new AdmissionError("registry_autonomous_merge_exclusion_missing");
  const credentials = factory.credentials as ObjectValue;
  if (!strings(credentials.sandbox_secret_profiles, "registry_credential_profiles_invalid").includes(contract.factory_request.credential_profile)) throw new AdmissionError("registry_credential_profile_not_allowed");
  const capacityCeilings = ["per_factory_concurrency", "global_concurrency", "per_repository_concurrency", "collision_group_concurrency"].map((field) => Number(capacity[field]));
  if (capacityCeilings.some((value) => !Number.isSafeInteger(value) || value < 1) || capacityCeilings.some((value) => contract.factory_request.concurrency > value)) throw new AdmissionError("registry_concurrency_ceiling_exceeded");
  if (!strings(factory.model_policy_keys, "registry_model_policy_keys_invalid").includes(contract.factory_request.model_policy_key)) throw new AdmissionError("registry_model_policy_not_allowed");
  if (contract.factory_request.escalation_class !== factory.escalation_ceiling) throw new AdmissionError("registry_escalation_ceiling_exceeded");
  const permitted = strings(risk.permitted_work_effect_classes, "registry_permitted_effects_invalid");
  const forbidden = strings(risk.forbidden_work_effect_classes, "registry_forbidden_effects_invalid");
  const requestedAndInherentEffects = [...new Set([...contract.factory_request.effect_classes, ...inherentEffectClasses(contract)])];
  if (requestedAndInherentEffects.some((item) => !permitted.includes(item))) throw new AdmissionError("registry_effect_class_not_permitted");
  if ((forbidden.includes("all") && requestedAndInherentEffects.length > 0) || requestedAndInherentEffects.some((item) => forbidden.includes(item))) throw new AdmissionError("registry_effect_class_forbidden");
  const executions = records(FACTORY_REGISTRY.execution_profiles, "registry_execution_profiles_invalid");
  const execution = executions.find((item) => item.id === contract.target.execution_profile);
  const limits = execution?.limits as ObjectValue | undefined;
  if (!limits || ["cost_usd", "timeout_seconds", "max_changed_lines", "max_files"].some((field) => Number(limits[field]) > Number(capacity[field])) || ["cost_usd", "timeout_seconds"].some((field) => !Number.isFinite(Number(limits[field])) || Number(limits[field]) < 0)) throw new AdmissionError("registry_profile_limit_exceeds_capacity");
  return {
    identity: {
      factory_id: text(factory.factory_id, "registry_factory_id_invalid"),
      registry_version: registryVersion,
      registry_digest: await digest(FACTORY_REGISTRY),
      entry_version: text(factory.entry_version, "registry_entry_version_invalid"),
    },
    factory,
    repository,
  };
}

async function assertCurrentRegistry(contract: Contract): Promise<RegistryBinding> {
  const factories = records(FACTORY_REGISTRY.factories, "registry_factories_invalid");
  const matches = factories.filter((item) => item.factory_id === contract.registry.factory_id);
  if (matches.length !== 1) throw new Error("registry_factory_identity_missing");
  if (!ACTIVE_FACTORY_STATES.has(String(matches[0].state))) throw new Error("registry_factory_disabled");
  const binding = await resolveFactory(
    {
      project: { id: contract.linear.project_id },
      team: { id: strings((matches[0].linear as ObjectValue).team_ids, "registry_team_ids_invalid")[0] },
      state: { type: strings((matches[0].linear as ObjectValue).eligible_state_types, "registry_state_types_invalid")[0] },
      labels: { nodes: strings((matches[0].linear as ObjectValue).required_labels, "registry_required_labels_invalid").map((name) => ({ name })) },
    },
    contract,
  );
  if (stable(binding.identity) !== stable(contract.registry)) throw new Error("registry_stale_re_admission_required");
  return binding;
}

async function profileDigest(contract: Contract): Promise<string> {
  const executions = records(FACTORY_REGISTRY.execution_profiles, "registry_execution_profiles_invalid");
  const validations = records(FACTORY_REGISTRY.validation_profiles, "registry_validation_profiles_invalid");
  const groups = records(FACTORY_REGISTRY.collision_groups, "registry_collision_groups_invalid");
  const execution = executions.find((item) => item.id === contract.target.execution_profile);
  const validation = validations.find((item) => item.id === contract.validation_profile);
  const collision = groups.find((item) => item.id === contract.target.collision_group);
  if (!execution || !validation || !collision) throw new Error("registry_profile_missing");
  return await digest({ registry: contract.registry, execution, validation, collision });
}

function repositoryPath(repository: string): string {
  return repository.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function boundedTextValue(value: string, limit = MAX_PROVIDER_BODY_BYTES): string {
  if (new TextEncoder().encode(value).byteLength > limit) throw new Error("provider_response_too_large");
  return value;
}

async function jsonResponse(responseValue: Response): Promise<ObjectValue | ObjectValue[]> {
  const body = boundedTextValue(await responseValue.text());
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") throw new Error("provider_response_invalid");
    return parsed as ObjectValue | ObjectValue[];
  } catch {
    throw new Error("provider_response_invalid");
  }
}

function object(value: unknown, keys: string[], label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdmissionError(`${label}_object_required`);
  const actual = Object.keys(value as ObjectValue).sort();
  if (actual.join("\0") !== [...keys].sort().join("\0")) throw new AdmissionError(`${label}_fields_invalid`);
  return value as ObjectValue;
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n]/.test(value)) {
    throw new AdmissionError(`${label}_invalid`);
  }
  return value;
}

function descriptionValue(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new AdmissionError(`${label}_invalid`);
  }
  return value;
}

function integer(value: unknown, label: string, max: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > max) {
    throw new AdmissionError(`${label}_invalid`);
  }
  return value;
}

async function contractFromDescription(description: unknown, issue: ObjectValue): Promise<Contract> {
  const source = descriptionValue(description, "description", 100_000);
  if (source.split(CONTRACT_OPEN).length - 1 !== 1 || source.split(CONTRACT_CLOSE).length - 1 !== 1) {
    throw new AdmissionError("contract_block_missing_or_ambiguous");
  }
  const start = source.indexOf(CONTRACT_OPEN) + CONTRACT_OPEN.length;
  const end = source.indexOf(CONTRACT_CLOSE);
  if (end <= start) throw new AdmissionError("contract_block_order_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(source.slice(start, end).trim()); } catch { throw new AdmissionError("contract_json_invalid"); }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && ("factory_id" in parsed || "registry" in parsed)) throw new AdmissionError("issue_factory_identity_forbidden");
  const parsedRoot = parsed as ObjectValue;
  const rootKeys = ["contract_version", "dispatch_id", "linear", "target", "dependencies", "risk", "acceptance_criteria", "validation_profile", "allowed_scope", "merge_policy", "stale_conditions", ...(parsedRoot?.factory_request === undefined ? [] : ["factory_request"])];
  const root = object(parsed, rootKeys, "contract");
  if (root.contract_version !== "v1") throw new AdmissionError("contract_version_unsupported");
  const projectId = providerId(issue, "project");
  const linear = object(root.linear, ["project_id", "issue_id", "identifier", "planning_revision", "planning_fingerprint"], "linear");
  const issueId = text(issue.id, "issue_id");
  const identifier = text(issue.identifier, "identifier", 32);
  if (linear.project_id !== projectId || linear.issue_id !== issueId || linear.identifier !== identifier) throw new AdmissionError("contract_linear_identity_mismatch");
  if (!/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/.test(identifier)) throw new AdmissionError("issue_identifier_invalid");
  const planningRevision = text(linear.planning_revision, "planning_revision");
  if (root.dispatch_id !== `${identifier}@${planningRevision}`) throw new AdmissionError("dispatch_id_not_bound_to_revision");
  if (!/^sha256:[0-9a-f]{64}$/.test(text(linear.planning_fingerprint, "planning_fingerprint", 71))) throw new AdmissionError("planning_fingerprint_invalid");
  const target = object(root.target, ["repository", "work_type", "execution_profile", "collision_group", "base_sha"], "target");
  const repository = text(target.repository, "repository");
  if (!REPOSITORY.test(repository)) throw new AdmissionError("repository_not_allowed");
  text(target.work_type, "work_type");
  const executionProfile = text(target.execution_profile, "execution_profile");
  const validationProfile = text(root.validation_profile, "validation_profile");
  if (executionProfile !== validationProfile) throw new AdmissionError("profile_mismatch");
  const collisionGroup = text(target.collision_group, "collision_group");
  if (!SHA40.test(text(target.base_sha, "base_sha", 40))) throw new AdmissionError("base_sha_invalid");
  if (!Array.isArray(root.dependencies) || root.dependencies.length > 50) throw new AdmissionError("dependencies_invalid");
  const dependencyIds = new Set<string>();
  for (const dependency of root.dependencies) {
    const item = object(dependency, ["issue_id", "required_state"], "dependency");
    const dependencyId = text(item.issue_id, "dependency_issue_id", 32);
    if (!ISSUE_IDENTIFIER.test(dependencyId) || dependencyIds.has(dependencyId)) throw new AdmissionError("dependency_issue_id_invalid");
    dependencyIds.add(dependencyId);
    if (item.required_state !== "completed") throw new AdmissionError("dependency_state_invalid");
  }
  const risk = object(root.risk, ["risk_class", "authority_class"], "risk");
  if (!["low", "medium", "high"].includes(String(risk.risk_class)) || !["repository-local", "cross-system"].includes(String(risk.authority_class))) throw new AdmissionError("risk_invalid");
  if (!Array.isArray(root.acceptance_criteria) || root.acceptance_criteria.length === 0 || root.acceptance_criteria.length > 50 || root.acceptance_criteria.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512)) throw new AdmissionError("acceptance_criteria_invalid");
  const scope = object(root.allowed_scope, ["paths", "max_files", "max_changed_lines"], "allowed_scope");
  if (!Array.isArray(scope.paths) || scope.paths.length === 0 || scope.paths.length > 100 || scope.paths.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512 || item.startsWith("/") || item.split("/").some((part) => part === "" || part === "." || part === ".."))) throw new AdmissionError("allowed_paths_invalid");
  integer(scope.max_files, "max_files", 12);
  integer(scope.max_changed_lines, "max_changed_lines", 500);
  if (!["human", "auto-eligible"].includes(String(root.merge_policy))) throw new AdmissionError("merge_policy_invalid");
  if (!Array.isArray(root.stale_conditions) || root.stale_conditions.length === 0 || root.stale_conditions.length > STALE_CONDITIONS.size || root.stale_conditions.some((item) => typeof item !== "string" || !STALE_CONDITIONS.has(item)) || new Set(root.stale_conditions).size !== root.stale_conditions.length) throw new AdmissionError("stale_conditions_invalid");
  const execution = records(FACTORY_REGISTRY.execution_profiles, "registry_execution_profiles_invalid").find((item) => item.id === executionProfile);
  if (!execution) throw new AdmissionError("registry_execution_profile_not_allowed");
  const rawRequest = root.factory_request === undefined ? {} : root.factory_request;
  if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) throw new AdmissionError("factory_request_invalid");
  const requestObject = rawRequest as ObjectValue;
  const requestKeys = Object.keys(requestObject);
  if (requestKeys.some((key) => !["credential_profile", "concurrency", "model_policy_key", "escalation_class", "effect_classes"].includes(key))) throw new AdmissionError("factory_request_fields_invalid");
  const concurrency = requestObject.concurrency === undefined ? 1 : integer(requestObject.concurrency, "factory_request_concurrency", 32);
  const contract: Omit<Contract, "registry"> = {
    contract_version: "v1",
    dispatch_id: text(root.dispatch_id, "dispatch_id", 192),
    linear: {
      project_id: text(linear.project_id, "contract_project_id"),
      issue_id: text(linear.issue_id, "contract_issue_id"),
      identifier: text(linear.identifier, "contract_identifier", 32),
      planning_revision: planningRevision,
      planning_fingerprint: text(linear.planning_fingerprint, "planning_fingerprint", 71),
    },
    target: {
      repository,
      work_type: text(target.work_type, "work_type"),
      execution_profile: executionProfile,
      collision_group: collisionGroup,
      base_sha: text(target.base_sha, "base_sha", 40),
    },
    dependencies: (root.dependencies as unknown[]).map((dependency) => {
      const item = dependency as ObjectValue;
      return { issue_id: text(item.issue_id, "dependency_issue_id"), required_state: "completed" as const };
    }),
    risk: {
      risk_class: risk.risk_class as Contract["risk"]["risk_class"],
      authority_class: risk.authority_class as Contract["risk"]["authority_class"],
    },
    acceptance_criteria: root.acceptance_criteria as string[],
    validation_profile: text(root.validation_profile, "validation_profile"),
    allowed_scope: {
      paths: scope.paths as string[],
      max_files: scope.max_files as number,
      max_changed_lines: scope.max_changed_lines as number,
    },
    merge_policy: root.merge_policy as Contract["merge_policy"],
    stale_conditions: root.stale_conditions as string[],
    factory_request: {
      credential_profile: requestObject.credential_profile === undefined ? "none" : text(requestObject.credential_profile, "factory_request_credential_profile", 128),
      concurrency,
      model_policy_key: requestObject.model_policy_key === undefined ? text(execution.model_policy, "registry_model_policy_invalid", 128) : text(requestObject.model_policy_key, "factory_request_model_policy", 128),
      escalation_class: requestObject.escalation_class === undefined ? "human" : text(requestObject.escalation_class, "factory_request_escalation", 64),
      effect_classes: requestObject.effect_classes === undefined ? [] : strings(requestObject.effect_classes, "factory_request_effect_classes_invalid"),
    },
  };
  const binding = await resolveFactory(issue, contract);
  return { ...contract, registry: binding.identity };
}

function issueFromPayload(payload: unknown): ObjectValue {
  if (!payload || typeof payload !== "object") throw new AdmissionError("payload_invalid");
  const root = payload as ObjectValue;
  if (root.type !== undefined && root.type !== "Issue") throw new AdmissionError("unsupported_event");
  const candidate = root.data ?? root.issue ?? root;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new AdmissionError("issue_payload_missing");
  return candidate as ObjectValue;
}

function labels(issue: ObjectValue): string[] {
  const value = issue.labels;
  const entries: unknown[] = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as ObjectValue).nodes) ? (value as ObjectValue).nodes as unknown[] : [];
  return entries.flatMap((entry: unknown) => entry && typeof entry === "object" && typeof (entry as ObjectValue).name === "string" ? [(entry as ObjectValue).name as string] : []);
}

async function admit(raw: string, env: Env): Promise<Job> {
  if (String(env.FACTORY_ENABLED) !== "true" || String(env.FACTORY_AUTONOMY) !== "1") throw new AdmissionError("factory_disabled");
  if (env.AUTO_MERGE !== "false") throw new AdmissionError("automatic_merge_must_be_disabled");
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new AdmissionError("invalid_json"); }
  const issue = issueFromPayload(payload);
  const state = issue.state && typeof issue.state === "object" ? (issue.state as ObjectValue).type : undefined;
  if (typeof state !== "string" || !ISSUE_STATES.has(state)) throw new AdmissionError("issue_not_eligible");
  if (!labels(issue).includes("factory:accepted")) throw new AdmissionError("factory_acceptance_label_missing");
  const contract = await contractFromDescription(issue.description, issue);
  const contractDigest = await digest(contract);
  const dispatchId = contract.dispatch_id;
  const runId = `run-v1-${(await digest({ dispatchId, contractDigest, baseSha: contract.target.base_sha })).slice(7, 39)}`;
  return { kind: "dispatch", dispatchId, runId, contractDigest, contract };
}

async function eventId(raw: string, header: string | null): Promise<string> { return header?.trim() || `body-${(await digest(raw)).slice(7)}`; }
async function ingress(db: D1Database, id: string, provider: string, type: string, payloadDigest: string, normalized: ObjectValue): Promise<IngressReceipt> {
  const normalizedJson = stable(normalized);
  if (normalizedJson.length > 8_192) throw new Error("normalized_event_too_large");
  const result = await db.prepare("INSERT OR IGNORE INTO factory_ingress_events(event_id,provider,event_type,payload_digest,handoff_state,received_at,updated_at,normalized_json) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id, provider, type, payloadDigest, "received", new Date().toISOString(), new Date().toISOString(), normalizedJson).run();
  if (result.meta.changes === 1) return { outcome: "inserted", handoffState: "received", normalized };
  const existing = await db.prepare("SELECT provider,event_type,payload_digest,handoff_state,normalized_json FROM factory_ingress_events WHERE event_id=?")
    .bind(id).first<{ provider: string; event_type: string; payload_digest: string; handoff_state: string; normalized_json: string | null }>();
  if (!existing) return { outcome: "conflict", handoffState: null, normalized: null };
  if (existing.provider !== provider || existing.event_type !== type || existing.payload_digest !== payloadDigest) {
    return { outcome: "conflict", handoffState: existing.handoff_state, normalized: null };
  }
  let stored: ObjectValue | null = null;
  if (typeof existing.normalized_json === "string") {
    try {
      const parsed: unknown = JSON.parse(existing.normalized_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as ObjectValue;
    } catch { /* an old or damaged selector is handled as unavailable */ }
  }
  return { outcome: "duplicate", handoffState: existing.handoff_state, normalized: stored };
}

async function runById(db: D1Database, runId: string): Promise<Run | null> {
  return await db.prepare("SELECT dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_issue_id,repository,collision_group,base_sha,current_state,workflow_id,lease_owner,lease_fence,lease_expires_at,branch,head_sha,pr_number,pr_url,created_at FROM factory_runs WHERE run_id=?").bind(runId).first<Run>();
}

async function runByBranch(db: D1Database, repository: string, branch: string): Promise<Run | null> {
  const rows = await db.prepare("SELECT dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_issue_id,repository,collision_group,base_sha,current_state,workflow_id,lease_owner,lease_fence,lease_expires_at,branch,head_sha,pr_number,pr_url,created_at FROM factory_runs WHERE repository=? AND branch=? ORDER BY updated_at DESC LIMIT 2").bind(repository, branch).all<Run>();
  if ((rows.results ?? []).length > 1) throw new Error("reconciliation_branch_ambiguous");
  return rows.results?.[0] ?? null;
}

async function insertRun(db: D1Database, job: Job): Promise<"inserted" | "duplicate" | "conflict"> {
  const c = job.contract;
  const active = await db.prepare("SELECT dispatch_id FROM factory_runs WHERE linear_issue_id=? AND current_state NOT IN ('not-admitted','failed','pr-merged','pr-canceled') LIMIT 1").bind(c.linear.issue_id).first<{ dispatch_id: string }>();
  if (active && active.dispatch_id !== job.dispatchId) return "conflict";
  const existing = await db.prepare("SELECT contract_digest,linear_issue_id FROM factory_runs WHERE dispatch_id=?")
    .bind(job.dispatchId).first<{ contract_digest: string; linear_issue_id: string }>();
  if (existing) return existing.contract_digest === job.contractDigest && existing.linear_issue_id === c.linear.issue_id ? "duplicate" : "conflict";
  const timestamp = new Date().toISOString();
  const admissionEventId = `admission:${job.dispatchId}`;
  const resolvedProfileDigest = await profileDigest(c);
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare("INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(job.dispatchId, job.runId, job.contractDigest, resolvedProfileDigest, c.registry.factory_id, c.registry.registry_version, c.registry.registry_digest, c.registry.entry_version, stable(c), c.linear.project_id, c.linear.issue_id, c.linear.identifier, c.target.repository, c.target.collision_group, c.target.base_sha, "admitted", timestamp, timestamp),
      db.prepare("INSERT INTO factory_events(event_id,dispatch_id,event_sequence,event_type,factory_id,registry_version,registry_digest,registry_entry_version,payload_digest,accepted,reason,received_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? FROM factory_runs WHERE dispatch_id=? AND current_state='admitted'")
        .bind(admissionEventId, job.dispatchId, 1, "state:admitted", c.registry.factory_id, c.registry.registry_version, c.registry.registry_digest, c.registry.entry_version, job.contractDigest, 1, "accepted", timestamp, job.dispatchId),
      db.prepare("INSERT INTO factory_transitions(dispatch_id,event_sequence,event_id,from_state,to_state,actor,factory_id,registry_version,registry_digest,registry_entry_version,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM factory_events WHERE event_id=?)")
        .bind(job.dispatchId, 1, admissionEventId, "proposed", "admitted", "admission", c.registry.factory_id, c.registry.registry_version, c.registry.registry_digest, c.registry.entry_version, timestamp, admissionEventId),
    ]);
  } catch (error) {
    const raced = await db.prepare("SELECT contract_digest,linear_issue_id FROM factory_runs WHERE dispatch_id=?")
      .bind(job.dispatchId).first<{ contract_digest: string; linear_issue_id: string }>();
    if (raced) return raced.contract_digest === job.contractDigest && raced.linear_issue_id === c.linear.issue_id ? "duplicate" : "conflict";
    const competing = await db.prepare("SELECT dispatch_id FROM factory_runs WHERE linear_issue_id=? AND current_state NOT IN ('not-admitted','failed','pr-merged','pr-canceled') LIMIT 1")
      .bind(c.linear.issue_id).first<{ dispatch_id: string }>();
    if (competing && competing.dispatch_id !== job.dispatchId) return "conflict";
    throw error;
  }
  if (results[0].meta.changes === 1 && results[1].meta.changes === 1 && results[2].meta.changes === 1) return "inserted";
  const committed = await db.prepare("SELECT contract_digest,linear_issue_id FROM factory_runs WHERE dispatch_id=?")
    .bind(job.dispatchId).first<{ contract_digest: string; linear_issue_id: string }>();
  if (committed?.contract_digest === job.contractDigest && committed.linear_issue_id === c.linear.issue_id) return "duplicate";
  return "conflict";
}

async function recordStep(db: D1Database, runId: string, stepKey: string, status: string, result: ObjectValue = {}): Promise<void> {
  await db.prepare("INSERT INTO factory_steps(run_id,step_key,status,result_json,factory_id,registry_version,registry_digest,registry_entry_version,updated_at) SELECT ?,?,?,?,factory_id,registry_version,registry_digest,registry_entry_version,? FROM factory_runs WHERE run_id=? ON CONFLICT(run_id,step_key) DO UPDATE SET status=excluded.status,result_json=excluded.result_json,factory_id=excluded.factory_id,registry_version=excluded.registry_version,registry_digest=excluded.registry_digest,registry_entry_version=excluded.registry_entry_version,updated_at=excluded.updated_at")
    .bind(runId, stepKey, status, stable(result), new Date().toISOString(), runId).run();
}

async function recordPrReceipt(db: D1Database, runId: string, pull: PullRequest): Promise<void> {
  const receiptId = `pr:${runId}:${pull.number}`;
  await db.prepare("INSERT OR REPLACE INTO factory_pr_receipts(receipt_id,dispatch_id,run_id,pr_number,pr_url,head_sha,factory_id,registry_version,registry_digest,registry_entry_version,created_at) SELECT ?,dispatch_id,run_id,?,?,?,factory_id,registry_version,registry_digest,registry_entry_version,? FROM factory_runs WHERE run_id=?")
    .bind(receiptId, pull.number, pull.html_url, pull.head.sha, new Date().toISOString(), runId).run();
}

async function recordLinearReconciliation(db: D1Database, runId: string, reconciliationId: string, state: string, reason: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO factory_linear_reconciliations(reconciliation_id,dispatch_id,run_id,state,reason,factory_id,registry_version,registry_digest,registry_entry_version,created_at) SELECT ?,dispatch_id,run_id,?,?,factory_id,registry_version,registry_digest,registry_entry_version,? FROM factory_runs WHERE run_id=?")
    .bind(reconciliationId, state, reason, new Date().toISOString(), runId).run();
}

type RunFields = {
  workflowId?: string | null;
  branch?: string | null;
  headSha?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  reconciledAt?: string | null;
};

async function updateRunMetadata(db: D1Database, runId: string, result: ObjectValue, leaseFence?: number, fields: RunFields = {}): Promise<void> {
  const now = new Date().toISOString();
  const set = ["result_json=COALESCE(?,result_json)", "updated_at=?"];
  const values: unknown[] = [stable(result), now];
  for (const [column, value] of [["workflow_id", fields.workflowId], ["branch", fields.branch], ["head_sha", fields.headSha], ["pr_number", fields.prNumber], ["pr_url", fields.prUrl], ["reconciled_at", fields.reconciledAt]] as const) {
    if (value !== undefined) {
      set.push(`${column}=?`);
      values.push(value);
    }
  }
  const where = ["run_id=?"];
  values.push(runId);
  if (leaseFence !== undefined) {
    where.push("lease_fence=?");
    values.push(leaseFence);
  }
  const statement = db.prepare(`UPDATE factory_runs SET ${set.join(",")} WHERE ${where.join(" AND ")}`).bind(...values);
  const changed = await statement.run();
  if (changed.meta.changes !== 1) throw new Error(leaseFence === undefined ? "run_missing" : "lease_fenced");
}

type TransitionPatch = {
  result?: ObjectValue;
  leaseFence?: number;
  leaseExpiredAt?: string;
  lease?: { owner: string; fence: number; expiresAt: string } | null;
  fields?: RunFields;
};

async function transitionRun(
  db: D1Database,
  runId: string,
  toState: string,
  actor: TransitionActor,
  eventId: string,
  patch: TransitionPatch = {},
): Promise<"applied" | "duplicate" | "noop"> {
  const run = await runById(db, runId);
  if (!run) throw new Error("run_missing");
  const existingEvent = await db.prepare("SELECT dispatch_id,event_type,accepted FROM factory_events WHERE event_id=?")
    .bind(eventId).first<{ dispatch_id: string; event_type: string; accepted: number }>();
  if (existingEvent) {
    if (existingEvent.dispatch_id !== run.dispatch_id || existingEvent.event_type !== `state:${toState}` || existingEvent.accepted !== 1) throw new Error("state_transition_event_conflict");
    return "duplicate";
  }
  if (run.current_state === toState) {
    if (patch.result) await updateRunMetadata(db, runId, patch.result, patch.leaseFence, patch.fields);
    return "noop";
  }
  const actors = TRANSITION_ACTORS[`${run.current_state}->${toState}`];
  if (!actors?.includes(actor)) throw new Error(`state_transition_denied:${run.current_state}->${toState}:${actor}`);
  if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(eventId)) throw new Error("state_transition_event_invalid");
  const sequenceRow = await db.prepare("SELECT COALESCE(MAX(event_sequence),0) AS sequence FROM factory_transitions WHERE dispatch_id=?")
    .bind(run.dispatch_id).first<{ sequence: number }>();
  const sequence = (sequenceRow?.sequence ?? 0) + 1;
  const now = new Date().toISOString();
  const resultJson = patch.result ? stable(patch.result) : null;
  const set = ["current_state=?", "result_json=COALESCE(?,result_json)", "updated_at=?"];
  const updateValues: unknown[] = [toState, resultJson, now];
  if (patch.lease !== undefined) {
    if (patch.lease === null) {
      set.push("lease_owner=NULL", "lease_fence=NULL", "lease_expires_at=NULL");
    } else {
      set.push("lease_owner=?", "lease_fence=?", "lease_expires_at=?");
      updateValues.push(patch.lease.owner, patch.lease.fence, patch.lease.expiresAt);
    }
  }
  for (const [column, value] of [["workflow_id", patch.fields?.workflowId], ["branch", patch.fields?.branch], ["head_sha", patch.fields?.headSha], ["pr_number", patch.fields?.prNumber], ["pr_url", patch.fields?.prUrl], ["reconciled_at", patch.fields?.reconciledAt]] as const) {
    if (value !== undefined) {
      set.push(`${column}=?`);
      updateValues.push(value);
    }
  }
  const where = ["run_id=?", "current_state=?"];
  updateValues.push(runId, run.current_state);
  if (patch.leaseFence !== undefined) {
    where.push("lease_fence=?");
    updateValues.push(patch.leaseFence);
  }
  if (patch.leaseExpiredAt !== undefined) {
    where.push("lease_expires_at<=?");
    updateValues.push(patch.leaseExpiredAt);
  }
  const payloadDigest = patch.result ? await digest(patch.result) : null;
  const results = await db.batch([
    db.prepare(`UPDATE factory_runs SET ${set.join(",")} WHERE ${where.join(" AND ")}`).bind(...updateValues),
    db.prepare("INSERT INTO factory_events(event_id,dispatch_id,event_sequence,event_type,factory_id,registry_version,registry_digest,registry_entry_version,payload_digest,accepted,reason,received_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? FROM factory_runs WHERE run_id=? AND current_state=? AND updated_at=?")
      .bind(eventId, run.dispatch_id, sequence, `state:${toState}`, run.factory_id, run.registry_version, run.registry_digest, run.registry_entry_version, payloadDigest, 1, "accepted", now, runId, toState, now),
    db.prepare("INSERT INTO factory_transitions(dispatch_id,event_sequence,event_id,from_state,to_state,actor,factory_id,registry_version,registry_digest,registry_entry_version,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM factory_events WHERE event_id=?)")
      .bind(run.dispatch_id, sequence, eventId, run.current_state, toState, actor, run.factory_id, run.registry_version, run.registry_digest, run.registry_entry_version, now, eventId),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1 || results[2].meta.changes !== 1) {
    throw new Error(patch.leaseFence === undefined ? "state_transition_raced" : "lease_fenced");
  }
  return "applied";
}

async function stopped(db: D1Database): Promise<boolean> { return (await db.prepare("SELECT value FROM control_flags WHERE key='stop'").first<{ value: string }>())?.value === "true"; }

async function dependenciesReady(job: Job, env: Env): Promise<"ready" | "blocked" | "unavailable"> {
  if (job.contract.dependencies.length === 0) return "ready";
  const token = secret(env, "LINEAR_API_KEY");
  if (!token) return "unavailable";
  const query = "query($ids:[ID!]!){issues(filter:{id:{in:$ids}}){nodes{id,state{type}}}}";
  try {
    const result = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: { ids: job.contract.dependencies.map((item) => item.issue_id) } }), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (!result.ok) return "unavailable";
    const body = await result.json() as ObjectValue;
    if (Array.isArray(body.errors) && body.errors.length > 0) return "unavailable";
    const nodes = (body.data as ObjectValue | undefined)?.issues && ((body.data as ObjectValue).issues as ObjectValue).nodes;
    if (!Array.isArray(nodes) || nodes.length !== job.contract.dependencies.length) return "unavailable";
    return nodes.every((node) => node && typeof node === "object" && ((node as ObjectValue).state as ObjectValue | undefined)?.type === "completed") ? "ready" : "blocked";
  } catch {
    return "unavailable";
  }
}

type ConcurrencyLimits = { global: number; factory: number; repository: number; collision: number };

function runtimeConcurrencyLimits(env: Env, factory: ObjectValue): ConcurrencyLimits {
  const capacity = factory.capacity as ObjectValue | undefined;
  if (!capacity || typeof capacity !== "object") throw new Error("registry_capacity_invalid");
  const values = {
    global: Number(capacity.global_concurrency),
    factory: Number(capacity.per_factory_concurrency),
    repository: Number(capacity.per_repository_concurrency),
    collision: Number(capacity.collision_group_concurrency),
  };
  if (Object.values(values).some((value) => !Number.isSafeInteger(value) || value < 1 || value > 32)) throw new Error("registry_concurrency_ceiling_invalid");
  const configuredGlobal = configInteger(env, "MAX_GLOBAL_CONCURRENCY", 1, 32);
  if (configuredGlobal === null || configuredGlobal > values.global) throw new Error("global_concurrency_config_invalid");
  return { ...values, global: configuredGlobal };
}

function capacityLeaseScopes(run: Run, limits: ConcurrencyLimits): string[][] {
  return [
    Array.from({ length: limits.global }, (_, index) => `global:${index + 1}`),
    Array.from({ length: limits.factory }, (_, index) => `factory:${run.factory_id}:${index + 1}`),
    Array.from({ length: limits.repository }, (_, index) => `repository:${run.repository}:${index + 1}`),
    Array.from({ length: limits.collision }, (_, index) => `collision:${run.collision_group}:${index + 1}`),
  ];
}

async function acquireLease(db: D1Database, run: Run, limits: ConcurrencyLimits): Promise<number | null> {
  const now = new Date();
  const expiry = new Date(now.getTime() + 30 * 60_000).toISOString();
  const reservation = await db.prepare("INSERT INTO factory_lease_reservations(run_id,created_at) VALUES(?,?)").bind(run.run_id, now.toISOString()).run();
  const reservationId = Number(reservation.meta.last_row_id);
  if (!Number.isSafeInteger(reservationId) || reservationId < 1) throw new Error("lease_reservation_failed");
  const acquired: string[] = [];
  let committed = false;
  try {
    for (const scope of capacityLeaseScopes(run, limits)) {
      let selected: string | null = null;
      for (const key of scope) {
        const result = await db.prepare("INSERT INTO factory_leases(lease_key,owner,dispatch_id,factory_id,registry_version,registry_digest,registry_entry_version,fence,expires_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(lease_key) DO UPDATE SET owner=excluded.owner,dispatch_id=excluded.dispatch_id,factory_id=excluded.factory_id,registry_version=excluded.registry_version,registry_digest=excluded.registry_digest,registry_entry_version=excluded.registry_entry_version,fence=factory_leases.fence+1,expires_at=excluded.expires_at WHERE factory_leases.expires_at<=?")
          .bind(key, "workflow", run.run_id, run.factory_id, run.registry_version, run.registry_digest, run.registry_entry_version, 0, expiry, now.toISOString()).run();
        if (result.meta.changes === 1) { selected = key; break; }
      }
      if (!selected) return null;
      acquired.push(selected);
    }
    await db.batch(acquired.map((key) => db.prepare("INSERT INTO factory_lease_members(reservation_id,lease_key) VALUES(?,?)").bind(reservationId, key)));
    committed = true;
    return reservationId;
  } finally {
    if (!committed) {
      if (acquired.length > 0) await db.prepare(`DELETE FROM factory_leases WHERE dispatch_id=? AND lease_key IN (${acquired.map(() => "?").join(",")})`).bind(run.run_id, ...acquired).run();
      await db.prepare("DELETE FROM factory_lease_reservations WHERE reservation_id=?").bind(reservationId).run();
    }
  }
}

async function releaseLease(db: D1Database, run: Run): Promise<void> {
  if (run.lease_fence === null) throw new Error("lease_missing");
  const members = await db.prepare("SELECT COUNT(*) AS count FROM factory_lease_members WHERE reservation_id=?").bind(run.lease_fence).first<{ count: number }>();
  const result = await db.prepare("DELETE FROM factory_leases WHERE dispatch_id=? AND lease_key IN (SELECT lease_key FROM factory_lease_members WHERE reservation_id=?)").bind(run.run_id, run.lease_fence).run();
  if ((members?.count ?? 0) !== result.meta.changes) throw new Error("lease_fenced");
  await db.batch([
    db.prepare("DELETE FROM factory_lease_members WHERE reservation_id=?").bind(run.lease_fence),
    db.prepare("UPDATE factory_runs SET lease_owner=NULL,lease_fence=NULL,lease_expires_at=NULL,updated_at=? WHERE run_id=? AND lease_fence=?").bind(new Date().toISOString(), run.run_id, run.lease_fence),
  ]);
}

async function renewLease(db: D1Database, run: Run): Promise<void> {
  if (run.lease_fence === null) throw new Error("lease_missing");
  const now = new Date();
  const expiry = new Date(now.getTime() + 30 * 60_000).toISOString();
  const members = await db.prepare("SELECT COUNT(*) AS count FROM factory_lease_members WHERE reservation_id=?").bind(run.lease_fence).first<{ count: number }>();
  const expected = members?.count ?? 0;
  const result = await db.prepare("UPDATE factory_leases SET expires_at=? WHERE dispatch_id=? AND lease_key IN (SELECT lease_key FROM factory_lease_members WHERE reservation_id=?) AND expires_at>?").bind(expiry, run.run_id, run.lease_fence, now.toISOString()).run();
  if (expected !== 4 || result.meta.changes !== expected) throw new Error("lease_fenced");
  const recorded = await db.prepare("UPDATE factory_runs SET lease_expires_at=?,updated_at=? WHERE run_id=? AND lease_fence=?").bind(expiry, now.toISOString(), run.run_id, run.lease_fence).run();
  if (recorded.meta.changes !== 1) throw new Error("lease_fenced");
}

async function markIngress(db: D1Database, id: string, state: string): Promise<void> {
  await db.prepare("UPDATE factory_ingress_events SET handoff_state=?,updated_at=? WHERE event_id=?").bind(state, new Date().toISOString(), id).run();
}

async function bindIngressRegistry(db: D1Database, id: string, job: Job): Promise<void> {
  const identity = job.contract.registry;
  const result = await db.prepare("UPDATE factory_ingress_events SET factory_id=?,registry_version=?,registry_digest=?,registry_entry_version=?,updated_at=? WHERE event_id=? AND handoff_state='processing'")
    .bind(identity.factory_id, identity.registry_version, identity.registry_digest, identity.entry_version, new Date().toISOString(), id).run();
  if (result.meta.changes !== 1) throw new Error("ingress_registry_binding_failed");
}

async function claimIngress(db: D1Database, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.prepare(
    "UPDATE factory_ingress_events SET handoff_state='processing',updated_at=? WHERE event_id=? AND (handoff_state='received' OR handoff_state LIKE 'retryable:%' OR handoff_state LIKE 'deferred:%' OR (handoff_state='processing' AND (updated_at IS NULL OR julianday(updated_at) < julianday(?) - 60.0 / 86400.0)))",
  ).bind(now, id, now).run();
  return result.meta.changes === 1;
}

function linearPayload(raw: string): ObjectValue {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new AdmissionError("invalid_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AdmissionError("payload_invalid");
  return parsed as ObjectValue;
}

function currentLinearTimestamp(raw: string, header: string | null): boolean {
  if (!header || !/^\d{10,16}$/.test(header.trim())) return false;
  const timestamp = Number(header);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 60_000) return false;
  try {
    const payload = JSON.parse(raw) as ObjectValue;
    return typeof payload.webhookTimestamp === "number" && Number.isSafeInteger(payload.webhookTimestamp) && Math.abs(payload.webhookTimestamp - timestamp) <= 60_000;
  } catch {
    return false;
  }
}

function linearSelectors(payload: ObjectValue): ObjectValue {
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new AdmissionError("issue_payload_missing");
  const issueId = (data as ObjectValue).id;
  const action = payload.action;
  if (typeof issueId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(issueId) || typeof action !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(action)) throw new AdmissionError("linear_selector_invalid");
  return { kind: "linear-issue", issue_id: issueId, action };
}

function githubSelectors(payload: ObjectValue, eventType: string): ObjectValue | null {
  const repository = payload.repository;
  const fullName = repository && typeof repository === "object" && !Array.isArray(repository) ? (repository as ObjectValue).full_name : undefined;
  const registered = records(FACTORY_REGISTRY.factories, "registry_factories_invalid")
    .filter((item) => ACTIVE_FACTORY_STATES.has(String(item.state)))
    .flatMap((item) => records(item.repositories, "registry_repositories_invalid"))
    .map((item) => item.repository);
  if (typeof fullName !== "string" || !REPOSITORY.test(fullName) || !registered.includes(fullName)) throw new AdmissionError("github_repository_invalid");
  const action = payload.action;
  if (typeof action !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(action)) throw new AdmissionError("github_action_invalid");
  if (eventType === "pull_request") {
    const pull = payload.pull_request;
    if (!pull || typeof pull !== "object" || Array.isArray(pull)) throw new AdmissionError("github_pull_request_missing");
    const number = (pull as ObjectValue).number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) throw new AdmissionError("github_pr_number_invalid");
    const body = typeof (pull as ObjectValue).body === "string" ? boundedTextValue((pull as ObjectValue).body as string) : "";
    const match = body.match(/<!-- mhoo-dark-factory-run:v1 run=(run-v1-[0-9a-f]{32}) -->/);
    if (!match) return null;
    return { kind: "github-pull-request", run_id: match[1], repository: fullName, pr_number: number, action };
  }
  const workflow = payload.workflow_run;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return null;
  const branch = (workflow as ObjectValue).head_branch;
  if (typeof branch !== "string" || !BRANCH.test(branch)) return null;
  const pullRequests = (workflow as ObjectValue).pull_requests;
  const first = Array.isArray(pullRequests) ? pullRequests[0] : undefined;
  const number = first && typeof first === "object" && !Array.isArray(first) ? (first as ObjectValue).number : undefined;
  return {
    kind: "github-branch",
    repository: fullName,
    branch,
    ...(typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? { pr_number: number } : {}),
    action,
  };
}

function dispatchJob(value: unknown): DispatchJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as ObjectValue;
  if (item.kind !== undefined && item.kind !== "dispatch") return null;
  if (typeof item.dispatchId !== "string" || item.dispatchId.length === 0 || item.dispatchId.length > 192 || typeof item.runId !== "string" || !RUN_ID.test(item.runId) || typeof item.contractDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.contractDigest) || !item.contract || typeof item.contract !== "object" || Array.isArray(item.contract)) return null;
  return { kind: "dispatch", dispatchId: item.dispatchId, runId: item.runId, contractDigest: item.contractDigest, contract: item.contract as Contract };
}

async function recoverStaleLeases(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare("SELECT run_id,repository,collision_group,lease_fence,current_state,workflow_id FROM factory_runs WHERE current_state IN ('leased','running','validating') AND lease_fence IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at<=? ORDER BY updated_at,run_id LIMIT 16").bind(now).all<{ run_id: string; repository: string; collision_group: string; lease_fence: number; current_state: string; workflow_id: string | null }>();
  for (const row of rows.results ?? []) {
    const targetState = row.current_state === "leased" ? "queued" : "needs-human";
    const reason = row.current_state === "leased" && row.workflow_id === null ? "stale_lease_requeued" : "stale_workflow_lease";
    const actor: TransitionActor = targetState === "queued" ? "reconciler" : row.current_state === "validating" ? "validator" : "reconciler";
    await transitionRun(env.DB, row.run_id, targetState, actor, `recovery:stale-lease:${row.run_id}:${row.lease_fence}`, {
      result: { reason, previous_state: row.current_state, previous_fence: row.lease_fence },
      leaseFence: row.lease_fence,
      leaseExpiredAt: now,
      lease: null,
    });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM factory_leases WHERE dispatch_id=? AND lease_key IN (SELECT lease_key FROM factory_lease_members WHERE reservation_id=?)").bind(row.run_id, row.lease_fence),
      env.DB.prepare("DELETE FROM factory_lease_members WHERE reservation_id=?").bind(row.lease_fence),
    ]);
    await recordStep(env.DB, row.run_id, "recovery-stale-lease", targetState, { reason, previous_state: row.current_state, previous_fence: row.lease_fence });
  }
}

async function schedule(env: Env, candidate: unknown): Promise<string> {
  const parsedJob = dispatchJob(candidate);
  if (!parsedJob) return "needs-human";
  let job = parsedJob;
  let run = await runById(env.DB, job.runId);
  if (!run) return "missing";
  let registryBinding: RegistryBinding | null = null;
  try {
    const contract = storedContract(run);
    registryBinding = await assertCurrentRegistry(contract);
    if (run.factory_id !== contract.registry.factory_id || run.registry_version !== contract.registry.registry_version || run.registry_digest !== contract.registry.registry_digest || run.registry_entry_version !== contract.registry.entry_version || run.profile_digest !== await profileDigest(contract) || run.dispatch_id !== job.dispatchId || run.contract_digest !== job.contractDigest || await digest(contract) !== run.contract_digest) throw new Error("dispatch_identity_conflict");
    job = { ...job, dispatchId: run.dispatch_id, runId: run.run_id, contractDigest: run.contract_digest, contract };
  } catch (error) {
    try {
      const reason = error instanceof Error ? error.message : "dispatch_identity_conflict";
      const stale = reason === "registry_stale_re_admission_required" || reason === "registry_factory_disabled";
      await transitionRun(env.DB, job.runId, stale ? "needs-replan" : "needs-human", "reconciler", `schedule:identity-conflict:${job.runId}`, { result: { reason } });
      return stale ? "needs-replan" : "needs-human";
    } catch {
      return "retryable";
    }
  }
  if (await stopped(env.DB) || String(env.FACTORY_ENABLED) !== "true" || String(env.FACTORY_AUTONOMY) !== "1") {
    if (["admitted", "blocked-by-dependency"].includes(run.current_state)) {
      await transitionRun(env.DB, job.runId, "queued", "scheduler", `schedule:queue-before-stop:${job.runId}`);
      run = await runById(env.DB, job.runId);
      if (!run) return "missing";
    }
    if (run.current_state === "queued") await transitionRun(env.DB, job.runId, "stopped", "human-override", `schedule:stop:${job.runId}`, { result: { reason: "factory_stopped_before_dispatch" } });
    return "stopped";
  }
  if (!["admitted", "queued", "blocked-by-dependency"].includes(run.current_state)) return "already-handled";
  const dependencyState = await dependenciesReady(job, env);
  if (dependencyState === "unavailable") return "retryable";
  if (dependencyState === "blocked") {
    await transitionRun(env.DB, job.runId, "blocked-by-dependency", "scheduler", `schedule:blocked:${job.runId}`);
    return "blocked-by-dependency";
  }
  if (run.current_state === "admitted" || run.current_state === "blocked-by-dependency") {
    await transitionRun(env.DB, job.runId, "queued", "scheduler", `schedule:queue:${job.runId}`);
    run = await runById(env.DB, job.runId);
    if (!run) return "missing";
  }
  let concurrencyLimits: ConcurrencyLimits;
  try {
    if (!registryBinding) throw new Error("registry_capacity_invalid");
    concurrencyLimits = runtimeConcurrencyLimits(env, registryBinding.factory);
    if (job.contract.factory_request.concurrency > concurrencyLimits.global || job.contract.factory_request.concurrency > concurrencyLimits.factory || job.contract.factory_request.concurrency > concurrencyLimits.repository || job.contract.factory_request.concurrency > concurrencyLimits.collision) throw new Error("registry_concurrency_ceiling_exceeded");
  } catch (error) {
    try {
      const reason = error instanceof Error ? error.message : "global_concurrency_config_invalid";
      await transitionRun(env.DB, job.runId, "needs-human", "scheduler", `schedule:invalid-concurrency:${job.runId}`, { result: { reason } });
      return "needs-human";
    } catch {
      return "retryable";
    }
  }
  const leaseFence = await acquireLease(env.DB, run, concurrencyLimits);
  if (leaseFence === null) return "repo-busy";
  const leaseExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  try {
    await transitionRun(env.DB, job.runId, "leased", "scheduler", `schedule:lease:${job.runId}:${leaseFence}`, {
      lease: { owner: "workflow", fence: leaseFence, expiresAt: leaseExpiresAt },
    });
  } catch {
    try { await releaseLease(env.DB, { ...run, lease_fence: leaseFence }); } catch { /* the competing state remains authoritative */ }
    return "already-handled";
  }
  try {
    const instance = await env.EXECUTION_WORKFLOW.create({ id: job.runId, params: job });
    await transitionRun(env.DB, job.runId, "running", "workflow", `schedule:running:${job.runId}:${leaseFence}`, { leaseFence, fields: { workflowId: instance.id } });
    return "dispatched";
  } catch {
    try {
      await transitionRun(env.DB, job.runId, "queued", "reconciler", `schedule:workflow-failed:${job.runId}:${leaseFence}`, { result: { reason: "workflow_create_failed" }, leaseFence, lease: null });
    } catch { /* the next recovery pass will surface any fenced write */ }
    try { await releaseLease(env.DB, { ...run, lease_fence: leaseFence }); } catch { /* the next recovery pass will surface the stale lease */ }
    return "retryable";
  }
}

async function acceptLinear(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const maxPayloadBytes = configInteger(env, "MAX_PAYLOAD_BYTES", 1, 1024 * 1024);
  if (maxPayloadBytes === null) return response({ error: "configuration_invalid" }, 503);
  if (new TextEncoder().encode(raw).byteLength > maxPayloadBytes) return response({ error: "payload_too_large" }, 413);
  const signature = request.headers.get("Linear-Signature");
  const secretValue = secret(env, "LINEAR_WEBHOOK_SECRET");
  if (!signature || !secretValue || !(await verifyHmac(secretValue, raw, signature))) return response({ error: "invalid_signature" }, 401);
  if (request.headers.get("Linear-Event") !== "Issue") return response({ error: "unsupported_event" }, 202);
  if (!currentLinearTimestamp(raw, request.headers.get("Linear-Timestamp"))) return response({ error: "stale_or_missing_timestamp" }, 401);
  const payload = linearPayload(raw);
  if (payload.type !== "Issue" || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) return response({ error: "unsupported_event" }, 202);
  const delivery = request.headers.get("Linear-Delivery");
  if (!delivery || !/^[A-Za-z0-9._:-]{1,256}$/.test(delivery)) return response({ error: "missing_delivery_id" }, 401);
  const id = await eventId(raw, delivery);
  const payloadDigest = await textDigest(raw);
  const receipt = await ingress(env.DB, id, "linear", "issue", payloadDigest, linearSelectors(payload));
  if (receipt.outcome === "conflict") return response({ accepted: false, reason: "event_id_payload_conflict" }, 409);
  if (String(env.FACTORY_ENABLED) !== "true" || String(env.FACTORY_AUTONOMY) !== "1") {
    await markIngress(env.DB, id, "deferred:factory_disabled");
    return response({ accepted: true, deferred: true, reason: "factory_disabled" }, 202);
  }
  const retryableHandoff = receipt.outcome === "inserted" || receipt.handoffState === "received" || receipt.handoffState?.startsWith("retryable:") || receipt.handoffState?.startsWith("deferred:");
  if (receipt.outcome === "duplicate" && !retryableHandoff) return response({ accepted: true, duplicate: true }, 200);
  if (!await claimIngress(env.DB, id)) return response({ accepted: true, duplicate: true, pending: true }, 202);
  let job: Job;
  try {
    job = await admit(raw, env);
  } catch (error) {
    const reason = error instanceof AdmissionError ? error.message : "admission_failed";
    await markIngress(env.DB, id, `rejected:${reason}`);
    return response({ accepted: false, reason }, 202);
  }
  try {
    const runResult = await insertRun(env.DB, job);
    if (runResult === "conflict") {
      await markIngress(env.DB, id, "rejected:conflicting_dispatch");
      return response({ accepted: false, reason: "conflicting_dispatch" }, 202);
    }
    await bindIngressRegistry(env.DB, id, job);
    await env.EXECUTION_QUEUE.send(job);
    await env.DB.prepare("UPDATE factory_ingress_events SET handoff_state='enqueued',enqueued_at=?,updated_at=? WHERE event_id=?").bind(new Date().toISOString(), new Date().toISOString(), id).run();
    return response({ accepted: true, executionId: job.runId, duplicate: runResult === "duplicate" }, 202);
  } catch {
    try { await markIngress(env.DB, id, "retryable:handoff_failed"); } catch { /* preserve the original retryable response */ }
    return response({ accepted: false, reason: "handoff_retryable" }, 503);
  }
}

async function acceptGithub(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const maxPayloadBytes = configInteger(env, "MAX_PAYLOAD_BYTES", 1, 1024 * 1024);
  if (maxPayloadBytes === null) return response({ error: "configuration_invalid" }, 503);
  if (new TextEncoder().encode(raw).byteLength > maxPayloadBytes) return response({ error: "payload_too_large" }, 413);
  const signature = request.headers.get("X-Hub-Signature-256");
  const secretValue = secret(env, "GITHUB_WEBHOOK_SECRET");
  if (!signature || !secretValue || !(await verifyGitHubHmac(secretValue, raw, signature))) return response({ error: "invalid_signature" }, 401);
  const eventType = request.headers.get("X-GitHub-Event");
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!eventType || !GITHUB_EVENT_TYPES.has(eventType) || !delivery || !/^[A-Za-z0-9._:-]{1,256}$/.test(delivery)) return response({ error: "unsupported_or_missing_event" }, 202);
  const payload = linearPayload(raw);
  const selectors = githubSelectors(payload, eventType);
  const id = await eventId(raw, delivery);
  const receipt = await ingress(env.DB, id, "github", eventType, await textDigest(raw), selectors ?? { kind: "github-unbound", event_type: eventType });
  if (receipt.outcome === "conflict") return response({ accepted: false, reason: "event_id_payload_conflict" }, 409);
  if (!selectors) {
    if (receipt.outcome === "inserted" || receipt.handoffState === "received" || receipt.handoffState?.startsWith("retryable:")) await markIngress(env.DB, id, "ignored:unbound_event");
    return response({ accepted: true, ignored: true }, 202);
  }
  const retryableHandoff = receipt.outcome === "inserted" || receipt.handoffState === "received" || receipt.handoffState?.startsWith("retryable:");
  if (receipt.outcome === "duplicate" && !retryableHandoff) return response({ accepted: true, duplicate: true }, 200);
  if (!await claimIngress(env.DB, id)) return response({ accepted: true, duplicate: true, pending: true }, 202);
  try {
    await env.EXECUTION_QUEUE.send(reconciliationJob(id, selectors));
    await env.DB.prepare("UPDATE factory_ingress_events SET handoff_state='enqueued',enqueued_at=?,updated_at=? WHERE event_id=?").bind(new Date().toISOString(), new Date().toISOString(), id).run();
    return response({ accepted: true, reconciliation: true, duplicate: receipt.outcome === "duplicate" }, 202);
  } catch {
    try { await markIngress(env.DB, id, "retryable:reconciliation_handoff_failed"); } catch { /* preserve the original retryable response */ }
    return response({ accepted: false, reason: "handoff_retryable" }, 503);
  }
}

async function verifyHmac(keyValue: string, body: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyValue), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const normalized = signature.trim();
  if (!/^[0-9a-f]{64}$/i.test(normalized)) return false;
  const supplied = new Uint8Array(normalized.match(/.{2}/g)!.map((pair) => parseInt(pair, 16)));
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= supplied[index] ^ expected[index];
  return difference === 0;
}

async function verifyGitHubHmac(keyValue: string, body: string, signature: string): Promise<boolean> {
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature.trim())) return false;
  return verifyHmac(keyValue, body, signature.trim().slice("sha256=".length));
}

type SandboxExecResult = { success: boolean; exitCode: number; stdout: string; stderr: string };

function agentResult(value: unknown): AgentResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_result_invalid");
  const item = value as ObjectValue;
  const status = item.status;
  const reason = item.reason;
  if (!["passed", "failed", "needs-replan", "needs-human"].includes(String(status)) || typeof reason !== "string" || reason.length === 0 || reason.length > 256) throw new Error("agent_result_invalid");
  const result: AgentResult = { status: status as AgentResult["status"], reason };
  if (item.branch !== undefined && (typeof item.branch !== "string" || !BRANCH.test(item.branch))) throw new Error("agent_branch_invalid");
  if (item.head_sha !== undefined && (typeof item.head_sha !== "string" || !SHA40.test(item.head_sha))) throw new Error("agent_head_invalid");
  if (item.diff_digest !== undefined && (typeof item.diff_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.diff_digest))) throw new Error("agent_diff_digest_invalid");
  if (item.validation_digest !== undefined && (typeof item.validation_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.validation_digest))) throw new Error("agent_validation_digest_invalid");
  if (item.validation_bytes !== undefined && (typeof item.validation_bytes !== "number" || !Number.isSafeInteger(item.validation_bytes) || item.validation_bytes < 0 || item.validation_bytes > MAX_PROVIDER_BODY_BYTES)) throw new Error("agent_validation_bytes_invalid");
  if (item.cost_usd !== undefined && (typeof item.cost_usd !== "number" || !Number.isFinite(item.cost_usd) || item.cost_usd < 0 || item.cost_usd > 1_000_000)) throw new Error("agent_cost_invalid");
  const providerUsage = item.provider_usage;
  if (providerUsage !== undefined) {
    if (!providerUsage || typeof providerUsage !== "object" || Array.isArray(providerUsage)) throw new Error("agent_provider_usage_invalid");
    const usage = providerUsage as ObjectValue;
    for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
      if (!Number.isSafeInteger(usage[field]) || Number(usage[field]) < 0) throw new Error("agent_provider_usage_invalid");
    }
    if (typeof usage.cost_usd !== "number" || !Number.isFinite(usage.cost_usd) || usage.cost_usd < 0 || usage.cost_usd > 1_000_000 || usage.total_tokens !== Number(usage.prompt_tokens) + Number(usage.completion_tokens)) throw new Error("agent_provider_usage_invalid");
    if (item.cost_usd !== usage.cost_usd) throw new Error("agent_provider_cost_mismatch");
  }
  if (item.changed_files !== undefined && (!Array.isArray(item.changed_files) || item.changed_files.length > 12 || item.changed_files.some((path) => typeof path !== "string" || path.length === 0 || path.length > 512 || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")))) throw new Error("agent_changed_files_invalid");
  if (result.status === "passed" && (!result.branch || !result.head_sha || item.cost_usd === undefined || providerUsage === undefined)) throw new Error("agent_success_identity_or_provider_cost_missing");
  Object.assign(result, Object.fromEntries(["branch", "head_sha", "diff_digest", "validation_digest", "validation_bytes", "changed_files", "cost_usd", "provider_usage"].filter((key) => item[key] !== undefined).map((key) => [key, item[key]])));
  return result;
}

function parseAgentResult(result: SandboxExecResult): AgentResult {
  const lines = boundedTextValue(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return { status: "needs-human", reason: result.success ? "agent_output_missing" : "sandbox_command_failed" };
  try {
    return agentResult(JSON.parse(last));
  } catch {
    return { status: "needs-human", reason: result.success ? "agent_output_invalid" : "sandbox_command_failed" };
  }
}

function validationCommand(profile: string): string {
  if (profile === "python-tests-v1") return "python3 -m py_compile factory/*.py && python3 -m unittest discover -s tests -v";
  throw new Error("unsupported_validation_profile");
}

function workflowTimeout(seconds: number): `${number} seconds` {
  return `${Math.max(1, Math.floor(seconds))} seconds`;
}

function remainingRunSeconds(run: Run, limits: { timeoutSeconds: number }): number {
  const started = Date.parse(run.created_at);
  if (!Number.isFinite(started)) throw new Error("run_deadline_invalid");
  const remaining = Math.floor((started + limits.timeoutSeconds * 1_000 - Date.now()) / 1_000);
  if (remaining < 1) throw new Error("workflow_deadline_exceeded");
  return remaining;
}

function pathMatchesScope(path: string, scopes: string[]): boolean {
  return scopes.some((scope) => scope === path || (scope.endsWith("/**") && path.startsWith(`${scope.slice(0, -3)}/`)) || (scope.endsWith("/*") && path.startsWith(`${scope.slice(0, -2)}/`) && !path.slice(scope.length - 1).includes("/")));
}

function protectedPath(path: string): boolean {
  return ["MISSION.md", "FACTORY.md", "FACTORY_RULES.md", "CLAUDE.md", "AGENTS.md"].includes(path) || path.startsWith("factory/") || path.startsWith(".github/") || path.startsWith(".factory/");
}

type GroundingResult = { status: "passed" | "failed"; reason: string; digest: string; bytes: number; file_count: number };
type ReviewResult = { status: "passed" | "failed"; reason: string; digest: string; bytes: number };

async function groundInSandbox(env: Env, job: Job): Promise<GroundingResult> {
  let credentials: SandboxCredentials;
  try { credentials = sandboxCredentials(env, job.contract); } catch (error) {
    const reason = error instanceof Error ? error.message : "grounding_credentials_missing";
    return { status: "failed", reason, digest: await textDigest(reason), bytes: 0, file_count: 0 };
  }
  const repository = job.contract.target.repository;
  const baseSha = job.contract.target.base_sha;
  const sandbox = getSandbox(env.Sandbox, `ground-${job.runId}`);
  try {
    const checkout = await sandbox.gitCheckout(sandboxRemote(repository, credentials.githubToken), { depth: 1, targetDir: "/workspace/project" });
    if (!checkout.success) return { status: "failed", reason: "grounding_checkout_failed", digest: await textDigest("grounding_checkout_failed"), bytes: 0, file_count: 0 };
    const exactBase = await sandbox.exec(`git -C /workspace/project fetch --depth=1 origin ${baseSha} && git -C /workspace/project checkout --detach ${baseSha}`, { timeout: 60_000 });
    if (!exactBase.success) return { status: "failed", reason: "grounding_base_unavailable", digest: await textDigest("grounding_base_unavailable"), bytes: 0, file_count: 0 };
    const status = await sandbox.exec("git -C /workspace/project status --porcelain=v1 --untracked-files=all", { timeout: 30_000 });
    const files = await sandbox.exec("git -C /workspace/project ls-files", { timeout: 30_000 });
    const output = boundedTextValue(`${status.stdout}\n${status.stderr}\n${files.stdout}\n${files.stderr}`);
    const fileCount = files.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).length;
    if (!status.success || !files.success || status.stdout.trim()) return { status: "failed", reason: "grounding_checkout_not_clean", digest: await textDigest(output), bytes: output.length, file_count: fileCount };
    return { status: "passed", reason: "grounded_exact_base", digest: await textDigest(output), bytes: output.length, file_count: fileCount };
  } catch {
    return { status: "failed", reason: "grounding_unavailable", digest: await textDigest("grounding_unavailable"), bytes: 0, file_count: 0 };
  } finally {
    try { await sandbox.destroy(); } catch { /* the failed cleanup remains an operational signal */ }
  }
}

async function executeInSandbox(env: Env, job: Job, remainingSeconds: number, remainingCostUsd: number, attempt = 0, findings: string[] = []): Promise<AgentResult> {
  let credentials: SandboxCredentials;
  try { credentials = sandboxCredentials(env, job.contract); } catch (error) {
    return { status: "needs-human", reason: error instanceof Error ? error.message : "execution_credentials_missing" };
  }
  if (!credentials.githubToken || !credentials.openRouterKey) return { status: "needs-human", reason: "execution_credentials_missing" };
  const limits = executionLimits(job.contract);
  const repository = job.contract.target.repository;
  const baseSha = job.contract.target.base_sha;
  const remote = sandboxRemote(repository, credentials.githubToken);
  const sandbox = getSandbox(env.Sandbox, `execution-${job.runId}`);
  try {
    const checkout = await sandbox.gitCheckout(remote, { depth: 1, targetDir: "/workspace/project" });
    if (!checkout.success) return { status: "needs-human", reason: "repository_checkout_failed" };
    const exactBase = await sandbox.exec(`git -C /workspace/project fetch --depth=1 origin ${baseSha} && git -C /workspace/project checkout --detach ${baseSha}`, { timeout: 60_000 });
    if (!exactBase.success) return { status: "needs-replan", reason: "base_sha_unavailable" };
    const result = await sandbox.exec(env.SANDBOX_COMMAND, {
      cwd: "/workspace/project",
      timeout: Math.min(limits.timeoutSeconds, remainingSeconds) * 1_000,
      env: {
        FACTORY_RUN_ID: job.runId,
        FACTORY_ISSUE: job.contract.linear.identifier,
        FACTORY_CONTRACT_JSON: stable(job.contract),
        FACTORY_REPOSITORY: repository,
        FACTORY_BASE_SHA: baseSha,
        FACTORY_ATTEMPT: String(attempt),
        FACTORY_FINDINGS_JSON: stable(findings.slice(0, 16)),
        FACTORY_VALIDATION_COMMAND: validationCommand(job.contract.validation_profile),
        FACTORY_MAX_ITERATIONS: "8",
        FACTORY_MAX_COMMANDS: "24",
        FACTORY_MAX_OUTPUT_BYTES: String(Math.min(Number(env.MAX_PAYLOAD_BYTES), MAX_PROVIDER_BODY_BYTES)),
        FACTORY_MAX_COST_USD: String(remainingCostUsd),
        FACTORY_TIMEOUT_SECONDS: String(Math.min(limits.timeoutSeconds, remainingSeconds)),
        GITHUB_TOKEN: credentials.githubToken,
        OPENROUTER_API_KEY: credentials.openRouterKey,
        OPENROUTER_MODEL: secret(env, "OPENROUTER_MODEL"),
      },
    }) as SandboxExecResult;
    return parseAgentResult(result);
  } catch {
    return { status: "needs-human", reason: "sandbox_execution_failed" };
  } finally {
    try { await sandbox.destroy(); } catch { /* evidence is recorded by the caller */ }
  }
}

async function validateInFreshSandbox(env: Env, job: Job, agent: AgentResult): Promise<ValidationResult> {
  if (!agent.branch || !agent.head_sha) return { status: "failed", exit_code: 78, output_digest: await textDigest("validation_identity_missing"), output_bytes: 0, reason: "validation_identity_missing", fixable: false };
  let credentials: SandboxCredentials;
  try { credentials = sandboxCredentials(env, job.contract); } catch (error) {
    const reason = error instanceof Error ? error.message : "validation_credentials_missing";
    return { status: "failed", exit_code: 78, output_digest: await textDigest(reason), output_bytes: 0, reason, fixable: false };
  }
  if (!credentials.githubToken) return { status: "failed", exit_code: 78, output_digest: await textDigest("validation_credentials_missing"), output_bytes: 0, reason: "validation_credentials_missing", fixable: false };
  const limits = executionLimits(job.contract);
  const repository = job.contract.target.repository;
  const sandbox = getSandbox(env.Sandbox, `validation-${job.runId}`);
  try {
    const checkout = await sandbox.gitCheckout(sandboxRemote(repository, credentials.githubToken), { branch: agent.branch, depth: 1, targetDir: "/workspace/project" });
    if (!checkout.success) return { status: "failed", exit_code: 78, output_digest: await textDigest("validation_checkout_failed"), output_bytes: 0, reason: "validation_checkout_failed", fixable: false };
    const head = await sandbox.exec("git -C /workspace/project rev-parse HEAD", { timeout: 30_000 });
    if (!head.success || head.stdout.trim() !== agent.head_sha) return { status: "failed", exit_code: 78, output_digest: await textDigest("validation_head_mismatch"), output_bytes: Math.min(MAX_PROVIDER_BODY_BYTES, head.stdout.length + head.stderr.length), reason: "validation_head_mismatch", fixable: false };
    const base = await sandbox.exec(`git -C /workspace/project fetch --depth=1 origin ${job.contract.target.base_sha} && git -C /workspace/project diff --check ${job.contract.target.base_sha} HEAD`, { timeout: 60_000 });
    const checks = await sandbox.exec(`sh -lc ${JSON.stringify(validationCommand(job.contract.validation_profile))}`, { cwd: "/workspace/project", timeout: limits.timeoutSeconds * 1_000 }) as SandboxExecResult;
    const output = `${base.stdout}\n${base.stderr}\n${checks.stdout}\n${checks.stderr}`;
    const passed = base.success && checks.success;
    const boundedOutput = boundedTextValue(output);
    return { status: passed ? "passed" : "failed", exit_code: passed ? 0 : (checks.exitCode || base.exitCode || 1), output_digest: await textDigest(boundedOutput), output_bytes: boundedOutput.length, reason: passed ? "validation_passed" : "validation_failed", fixable: !passed };
  } catch {
    return { status: "failed", exit_code: 78, output_digest: await textDigest("validation_unavailable"), output_bytes: 0, reason: "validation_unavailable", fixable: false };
  } finally {
    try { await sandbox.destroy(); } catch { /* the failed cleanup remains an operational signal */ }
  }
}

async function reviewInFreshSandbox(env: Env, job: Job, agent: AgentResult): Promise<ReviewResult> {
  if (!agent.branch || !agent.head_sha) return { status: "failed", reason: "review_identity_missing", digest: await textDigest("review_identity_missing"), bytes: 0 };
  let credentials: SandboxCredentials;
  try { credentials = sandboxCredentials(env, job.contract); } catch (error) {
    const reason = error instanceof Error ? error.message : "review_credentials_missing";
    return { status: "failed", reason, digest: await textDigest(reason), bytes: 0 };
  }
  if (!credentials.githubToken) return { status: "failed", reason: "review_credentials_missing", digest: await textDigest("review_credentials_missing"), bytes: 0 };
  const repository = job.contract.target.repository;
  const sandbox = getSandbox(env.Sandbox, `review-${job.runId}`);
  try {
    const checkout = await sandbox.gitCheckout(sandboxRemote(repository, credentials.githubToken), { branch: agent.branch, depth: 1, targetDir: "/workspace/project" });
    if (!checkout.success) return { status: "failed", reason: "review_checkout_failed", digest: await textDigest("review_checkout_failed"), bytes: 0 };
    const head = await sandbox.exec("git -C /workspace/project rev-parse HEAD", { timeout: 30_000 });
    const base = await sandbox.exec(`git -C /workspace/project fetch --depth=1 origin ${job.contract.target.base_sha}`, { timeout: 60_000 });
    const names = await sandbox.exec(`git -C /workspace/project diff --name-only ${job.contract.target.base_sha} HEAD`, { timeout: 30_000 });
    const stats = await sandbox.exec(`git -C /workspace/project diff --numstat ${job.contract.target.base_sha} HEAD`, { timeout: 30_000 });
    const whitespace = await sandbox.exec(`git -C /workspace/project diff --check ${job.contract.target.base_sha} HEAD`, { timeout: 30_000 });
    const output = boundedTextValue(`${head.stdout}\n${head.stderr}\n${base.stdout}\n${base.stderr}\n${names.stdout}\n${names.stderr}\n${stats.stdout}\n${stats.stderr}\n${whitespace.stdout}\n${whitespace.stderr}`);
    if (!head.success || head.stdout.trim() !== agent.head_sha || !base.success || !names.success || !stats.success || !whitespace.success) return { status: "failed", reason: "review_identity_or_diff_failed", digest: await textDigest(output), bytes: output.length };
    const changedFiles = names.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const lineCount = stats.stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean).reduce((total, row) => {
      const [added, removed] = row.split("\t");
      return total + (Number.isInteger(Number(added)) ? Number(added) : job.contract.allowed_scope.max_changed_lines + 1) + (Number.isInteger(Number(removed)) ? Number(removed) : 0);
    }, 0);
    if (changedFiles.length === 0 || changedFiles.length > job.contract.allowed_scope.max_files || lineCount > job.contract.allowed_scope.max_changed_lines || changedFiles.some((path) => !pathMatchesScope(path, job.contract.allowed_scope.paths) || protectedPath(path))) return { status: "failed", reason: "review_scope_violation", digest: await textDigest(output), bytes: output.length };
    return { status: "passed", reason: "independent_review_passed", digest: await textDigest(output), bytes: output.length };
  } catch {
    return { status: "failed", reason: "review_unavailable", digest: await textDigest("review_unavailable"), bytes: 0 };
  } finally {
    try { await sandbox.destroy(); } catch { /* the failed cleanup remains an operational signal */ }
  }
}

async function githubRequest(token: string, method: string, path: string, body?: ObjectValue): Promise<ObjectValue | ObjectValue[]> {
  const result = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": GITHUB_API_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!result.ok) throw new Error(`github_request_failed_${result.status}`);
  return await jsonResponse(result);
}

function pullRequest(value: unknown, expectedRepository: string): PullRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pull_request_invalid");
  const item = value as ObjectValue;
  const head = item.head as ObjectValue | undefined;
  const base = item.base as ObjectValue | undefined;
  const headRepo = head?.repo;
  const baseRepo = base?.repo;
  const headRepository = headRepo && typeof headRepo === "object" && !Array.isArray(headRepo) ? (headRepo as ObjectValue).full_name : undefined;
  const baseRepository = baseRepo && typeof baseRepo === "object" && !Array.isArray(baseRepo) ? (baseRepo as ObjectValue).full_name : undefined;
  if (!REPOSITORY.test(expectedRepository) || headRepository !== expectedRepository || baseRepository !== expectedRepository || typeof item.number !== "number" || !Number.isSafeInteger(item.number) || item.number < 1 || typeof item.html_url !== "string" || !/^https:\/\/github\.com\/mhoo-os\/[a-z0-9][a-z0-9._-]{0,99}\/pull\/[1-9][0-9]*$/.test(item.html_url) || (item.state !== "open" && item.state !== "closed") || typeof item.merged !== "boolean" || !head || typeof head.ref !== "string" || !BRANCH.test(head.ref) || typeof head.sha !== "string" || !SHA40.test(head.sha) || !base || typeof base.ref !== "string" || base.ref.length === 0 || base.ref.length > 256 || typeof base.sha !== "string" || !SHA40.test(base.sha)) throw new Error("pull_request_invalid");
  return { number: item.number, html_url: item.html_url, state: item.state, merged: item.merged, head: { ref: head.ref, sha: head.sha }, base: { ref: base.ref, sha: base.sha } };
}

async function publishPullRequest(env: Env, job: Job, agent: AgentResult): Promise<PullRequest> {
  const current = await assertCurrentRegistry(job.contract);
  const risk = current.factory.risk as ObjectValue;
  if (job.contract.merge_policy !== "human" || risk.merge_ceiling !== "human" || !strings(risk.autonomous_merge_exclusions, "registry_autonomous_merge_exclusions_invalid").includes(job.contract.target.repository)) throw new Error("registry_human_merge_required");
  const token = secret(env, "GITHUB_TOKEN");
  if (!token || !agent.branch || !agent.head_sha) throw new Error("publication_identity_missing");
  const repo = repositoryPath(job.contract.target.repository);
  const repositoryInfo = await githubRequest(token, "GET", `/repos/${repo}`);
  if (Array.isArray(repositoryInfo) || typeof repositoryInfo.default_branch !== "string" || !/^[A-Za-z0-9._/-]{1,256}$/.test(repositoryInfo.default_branch)) throw new Error("repository_default_branch_invalid");
  const defaultBranch = repositoryInfo.default_branch;
  const branchInfo = await githubRequest(token, "GET", `/repos/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
  const branchCommit = !Array.isArray(branchInfo) && branchInfo.commit && typeof branchInfo.commit === "object" && !Array.isArray(branchInfo.commit) ? branchInfo.commit as ObjectValue : undefined;
  if (!branchCommit || typeof branchCommit.sha !== "string" || !SHA40.test(branchCommit.sha)) throw new Error("repository_default_branch_invalid");
  if (branchCommit.sha !== job.contract.target.base_sha) throw new Error("publication_base_changed");
  const existingValue = await githubRequest(token, "GET", `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`mhoo-os:${agent.branch}`)}&per_page=10`);
  if (!Array.isArray(existingValue)) throw new Error("pull_request_list_invalid");
  if (existingValue.length > 1) throw new Error("duplicate_pull_requests");
  if (existingValue.length === 1) {
    const existing = pullRequest(existingValue[0], job.contract.target.repository);
    if (existing.state !== "open" || existing.merged) throw new Error("pull_request_terminal");
    if (existing.head.sha !== agent.head_sha) throw new Error("pull_request_head_mismatch");
    if (existing.base.ref !== defaultBranch || existing.base.sha !== job.contract.target.base_sha) throw new Error("publication_base_changed");
    return existing;
  }
  const marker = `<!-- mhoo-dark-factory-run:v1 run=${job.runId} dispatch=${job.dispatchId} -->`;
  const created = await githubRequest(token, "POST", `/repos/${repo}/pulls`, {
    title: `[Factory] ${job.contract.linear.identifier} bounded execution`,
    head: agent.branch,
    base: defaultBranch,
    body: `${marker}\n\nFactory execution for ${job.contract.linear.identifier}.\n\n- Factory: \`${job.contract.registry.factory_id}\`\n- Registry: \`${job.contract.registry.registry_version}\` / \`${job.contract.registry.registry_digest}\`\n- Run: \`${job.runId}\`\n- Contract digest: \`${job.contractDigest}\`\n- Base: \`${job.contract.target.base_sha}\`\n- Head: \`${agent.head_sha}\`\n\nAutomatic merge is disabled; human review is required.`,
  });
  const pull = pullRequest(created, job.contract.target.repository);
  if (pull.head.sha !== agent.head_sha) throw new Error("created_pull_request_head_mismatch");
  return pull;
}

async function linearGraphql(env: Env, query: string, variables: ObjectValue): Promise<ObjectValue> {
  const token = secret(env, "LINEAR_API_KEY");
  if (!token) throw new Error("linear_credentials_missing");
  const result = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (!result.ok) throw new Error("linear_request_failed");
  const body = await jsonResponse(result);
  if (Array.isArray(body) || (Array.isArray(body.errors) && body.errors.length > 0) || !body.data || typeof body.data !== "object") throw new Error("linear_response_invalid");
  return body.data as ObjectValue;
}

async function ensureLinearReceipt(env: Env, job: Job, pull: PullRequest, state = "pr-open", reason = "pr_published"): Promise<"created" | "existing"> {
  const marker = `<!-- mhoo-dark-factory-receipt:v1 run=${job.runId} -->`;
  const query = "query($issueId:ID!,$after:String){issue(id:$issueId){comments(first:50,after:$after){nodes{id body}pageInfo{hasNextPage endCursor}}}}";
  const nodes: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const data = await linearGraphql(env, query, { issueId: job.contract.linear.issue_id, after });
    const issue = data.issue as ObjectValue | undefined;
    const comments = issue?.comments as ObjectValue | undefined;
    const pageInfo = comments?.pageInfo as ObjectValue | undefined;
    if (!comments || !Array.isArray(comments.nodes) || !pageInfo || typeof pageInfo.hasNextPage !== "boolean") throw new Error("linear_receipts_pagination_invalid");
    nodes.push(...comments.nodes);
    if (!pageInfo.hasNextPage) break;
    if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0 || pageInfo.endCursor.length > 256) throw new Error("linear_receipts_pagination_invalid");
    after = pageInfo.endCursor;
    if (page === 9) throw new Error("linear_receipts_pagination_limit");
  }
  const body = `${marker}\n\nFactory execution for ${job.contract.linear.identifier}: ${state}.\n\n- Factory: \`${job.contract.registry.factory_id}\`\n- Registry: \`${job.contract.registry.registry_version}\` / \`${job.contract.registry.registry_digest}\`\n- Run: \`${job.runId}\`\n- Reason: \`${reason}\`\n- Contract digest: \`${job.contractDigest}\`\n- Repository: \`${job.contract.target.repository}\`\n- PR: ${pull.html_url}\n- PR head: \`${pull.head.sha}\`\n\nAutomatic merge is disabled; human review is required.`;
  const matches = nodes.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const value = item as ObjectValue;
    return typeof value.body === "string" && value.body.includes(marker);
  });
  if (matches.length > 1) throw new Error("duplicate_linear_receipts");
  if (matches.length === 1) {
    const existing = matches[0] as ObjectValue;
    if (typeof existing.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(existing.id)) throw new Error("linear_receipt_id_invalid");
    if (existing.body === body) return "existing";
    const mutation = "mutation($id:ID!,$body:String!){commentUpdate(id:$id,input:{body:$body}){success}}";
    const result = await linearGraphql(env, mutation, { id: existing.id, body });
    const updated = result.commentUpdate as ObjectValue | undefined;
    if (updated?.success !== true) throw new Error("linear_receipt_update_not_confirmed");
    return "existing";
  }
  const mutation = "mutation($issueId:ID!,$body:String!){commentCreate(input:{issueId:$issueId,body:$body}){success}}";
  const result = await linearGraphql(env, mutation, { issueId: job.contract.linear.issue_id, body });
  const created = result.commentCreate as ObjectValue | undefined;
  if (created?.success !== true) throw new Error("linear_receipt_not_confirmed");
  return "created";
}

function storedContract(run: Run): Contract {
  try {
    const parsed: unknown = JSON.parse(run.contract_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("contract_not_object");
    return parsed as Contract;
  } catch {
    throw new Error("stored_contract_invalid");
  }
}

async function linearPlanningSnapshot(env: Env, run: Run): Promise<Contract> {
  const query = "query($issueId:ID!){issue(id:$issueId){id identifier description project{id} team{id} state{type} labels{nodes{name}}}}";
  const data = await linearGraphql(env, query, { issueId: run.linear_issue_id });
  const issue = data.issue;
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) throw new Error("linear_issue_missing");
  const item = issue as ObjectValue;
  const project = item.project;
  if (!project || typeof project !== "object" || Array.isArray(project) || typeof (project as ObjectValue).id !== "string") throw new Error("linear_project_missing");
  return await contractFromDescription(item.description, item);
}

async function reconcileGithubEvent(env: Env, job: GitHubReconciliationJob): Promise<"processed" | "ignored"> {
  if ((!job.runId && !job.branch) || (job.runId !== undefined && !RUN_ID.test(job.runId)) || (job.branch !== undefined && !BRANCH.test(job.branch)) || !REPOSITORY.test(job.repository) || (job.prNumber !== undefined && (!Number.isSafeInteger(job.prNumber) || job.prNumber < 1)) || !/^[A-Za-z0-9._-]{1,64}$/.test(job.action)) throw new Error("reconciliation_job_invalid");
  const run = job.runId ? await runById(env.DB, job.runId) : await runByBranch(env.DB, job.repository, job.branch as string);
  if (!run) return "ignored";
  if (run.repository !== job.repository || (run.branch !== null && job.branch !== undefined && run.branch !== job.branch) || (run.pr_number !== null && job.prNumber !== undefined && run.pr_number !== job.prNumber)) throw new Error("reconciliation_identity_conflict");
  const stored = storedContract(run);
  await assertCurrentRegistry(stored);
  if (run.registry_digest !== stored.registry.registry_digest || run.profile_digest !== await profileDigest(stored)) throw new Error("reconciliation_registry_identity_conflict");
  const token = secret(env, "GITHUB_TOKEN");
  if (!token) throw new Error("github_credentials_missing");
  let prNumber = job.prNumber ?? run.pr_number ?? null;
  if (prNumber === null) {
    const branch = job.branch ?? run.branch;
    if (!branch) return "ignored";
    const candidates = await githubRequest(token, "GET", `/repos/${repositoryPath(job.repository)}/pulls?state=all&head=${encodeURIComponent(`mhoo-os:${branch}`)}&per_page=10`);
    if (!Array.isArray(candidates)) throw new Error("reconciliation_pull_request_list_invalid");
    if (candidates.length === 0) return "ignored";
    if (candidates.length > 1) throw new Error("duplicate_pull_requests");
    prNumber = pullRequest(candidates[0], job.repository).number;
  }
  const value = await githubRequest(token, "GET", `/repos/${repositoryPath(job.repository)}/pulls/${prNumber}`);
  const pull = pullRequest(value, job.repository);
  if (pull.number !== prNumber || pull.html_url !== `https://github.com/${job.repository}/pull/${prNumber}`) throw new Error("reconciliation_pr_identity_conflict");
  const contract = stored;
  if (await digest(contract) !== run.contract_digest) throw new Error("reconciliation_contract_digest_conflict");
  const currentContract = await linearPlanningSnapshot(env, run);
  const expectedBranch = run.branch ?? `factory/${contract.linear.identifier.toLowerCase()}-${run.run_id.slice(-12)}`;
  let state = run.current_state;
  let reason = "external_state_current";
  if (currentContract.linear.planning_revision !== contract.linear.planning_revision || currentContract.linear.planning_fingerprint !== contract.linear.planning_fingerprint) {
    state = "needs-replan";
    reason = "planning_snapshot_changed";
  } else if (pull.base.sha !== run.base_sha) {
    state = "needs-replan";
    reason = "github_base_changed";
  } else if (pull.head.ref !== expectedBranch) {
    state = "needs-human";
    reason = "github_branch_identity_unavailable";
  } else if (run.current_state === "pr-merged" || run.current_state === "pr-canceled") {
    state = run.current_state;
    reason = "terminal_pr_reopened_or_reappeared";
  } else if (!run.head_sha) {
    state = "needs-human";
    reason = "validated_head_missing";
  } else if (run.head_sha && run.head_sha !== pull.head.sha) {
    state = "reconciliation-only";
    reason = "github_head_changed_since_validation";
  } else if (pull.merged) {
    state = "pr-merged";
    reason = "github_pr_merged";
  } else if (pull.state === "closed") {
    state = "pr-canceled";
    reason = "github_pr_closed";
  } else {
    state = "pr-open";
  }
  await transitionRun(env.DB, run.run_id, state, "reconciler", `github:${job.eventId}`, {
    result: { reason, action: job.action, base_sha: pull.base.sha, head_sha: pull.head.sha },
    fields: { headSha: pull.head.sha, prNumber: pull.number, prUrl: pull.html_url, reconciledAt: new Date().toISOString() },
  });
  await recordStep(env.DB, run.run_id, "reconciliation", state, { reason, action: job.action, pr_number: pull.number, base_sha: pull.base.sha, head_sha: pull.head.sha });
  const dispatchJob: Job = { kind: "dispatch", dispatchId: run.dispatch_id, runId: run.run_id, contractDigest: run.contract_digest, contract };
  await ensureLinearReceipt(env, dispatchJob, pull, state, reason);
  await recordLinearReconciliation(env.DB, run.run_id, `github:${job.eventId}`, state, reason);
  return "processed";
}

function isGitHubReconciliationJob(value: unknown): value is GitHubReconciliationJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as ObjectValue;
  const runIdValid = item.runId === undefined || (typeof item.runId === "string" && RUN_ID.test(item.runId));
  const branchValid = item.branch === undefined || (typeof item.branch === "string" && BRANCH.test(item.branch));
  const prNumberValid = item.prNumber === undefined || (typeof item.prNumber === "number" && Number.isSafeInteger(item.prNumber) && item.prNumber > 0);
  return item.kind === "github-reconciliation" && typeof item.eventId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(item.eventId) && (item.runId !== undefined || item.branch !== undefined) && runIdValid && branchValid && prNumberValid && typeof item.repository === "string" && REPOSITORY.test(item.repository) && typeof item.action === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(item.action);
}

function reconciliationJob(eventId: string, selector: ObjectValue): GitHubReconciliationJob {
  const job = {
    kind: "github-reconciliation",
    eventId,
    ...(typeof selector.run_id === "string" ? { runId: selector.run_id } : {}),
    ...(typeof selector.branch === "string" ? { branch: selector.branch } : {}),
    repository: String(selector.repository),
    ...(typeof selector.pr_number === "number" ? { prNumber: selector.pr_number } : {}),
    action: String(selector.action),
  } as GitHubReconciliationJob;
  if (!isGitHubReconciliationJob(job)) throw new Error("github_selector_invalid");
  return job;
}

function workflowActor(fromState: string, toState: string): TransitionActor {
  if (toState === "stopped") return "human-override";
  if (fromState === "validating" && ["fixable-failure", "failed", "needs-human"].includes(toState)) return "validator";
  return "workflow";
}

async function rehydrateLinearJob(env: Env, selector: ObjectValue): Promise<Job> {
  if (selector.kind !== "linear-issue" || typeof selector.issue_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(selector.issue_id)) throw new Error("linear_selector_invalid");
  const query = "query($issueId:ID!){issue(id:$issueId){id identifier description project{id} team{id} state{type} labels{nodes{name}}}}";
  const data = await linearGraphql(env, query, { issueId: selector.issue_id });
  const issue = data.issue;
  if (!issue || typeof issue !== "object" || Array.isArray(issue) || (issue as ObjectValue).id !== selector.issue_id) throw new Error("linear_issue_missing");
  return await admit(JSON.stringify({ type: "Issue", data: issue }), env);
}

async function recoverIngress(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT event_id,provider,event_type,normalized_json,handoff_state FROM factory_ingress_events WHERE handoff_state='received' OR handoff_state LIKE 'retryable:%' OR handoff_state LIKE 'deferred:%' OR (handoff_state='processing' AND (updated_at IS NULL OR julianday(updated_at) < julianday(?) - 60.0 / 86400.0)) ORDER BY received_at,event_id LIMIT 8").bind(new Date().toISOString()).all<{ event_id: string; provider: string; event_type: string; normalized_json: string | null; handoff_state: string }>();
  for (const row of rows.results ?? []) {
    if (row.provider === "linear" && (String(env.FACTORY_ENABLED) !== "true" || String(env.FACTORY_AUTONOMY) !== "1")) continue;
    if (!await claimIngress(env.DB, row.event_id)) continue;
    let selector: ObjectValue | null = null;
    try {
      if (typeof row.normalized_json !== "string") throw new Error("normalized_selector_missing");
      const parsed: unknown = JSON.parse(row.normalized_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("normalized_selector_invalid");
      selector = parsed as ObjectValue;
      if (row.provider === "github") {
        if (selector.kind === "github-unbound") {
          await markIngress(env.DB, row.event_id, "ignored:unbound_event");
          continue;
        }
        if (selector.kind !== "github-pull-request" && selector.kind !== "github-branch") throw new Error("github_selector_invalid");
        await env.EXECUTION_QUEUE.send(reconciliationJob(row.event_id, selector));
      } else if (row.provider === "linear") {
        const job = await rehydrateLinearJob(env, selector);
        const runResult = await insertRun(env.DB, job);
        if (runResult === "conflict") throw new Error("conflicting_dispatch");
        await bindIngressRegistry(env.DB, row.event_id, job);
        await env.EXECUTION_QUEUE.send(job);
      } else {
        await markIngress(env.DB, row.event_id, "rejected:unsupported_provider");
        continue;
      }
      await env.DB.prepare("UPDATE factory_ingress_events SET handoff_state='enqueued',enqueued_at=COALESCE(enqueued_at,?),updated_at=? WHERE event_id=?").bind(new Date().toISOString(), new Date().toISOString(), row.event_id).run();
    } catch (error) {
      const reason = error instanceof AdmissionError ? error.message : "recovery_handoff_failed";
      if (row.provider === "linear" && (error instanceof AdmissionError || reason.startsWith("contract_") || reason.startsWith("issue_") || reason.startsWith("linear_") || reason.startsWith("human_"))) await markIngress(env.DB, row.event_id, `rejected:${reason}`);
      else if (row.provider === "github" && reason.startsWith("github_")) await markIngress(env.DB, row.event_id, `rejected:${reason}`);
      else await markIngress(env.DB, row.event_id, `retryable:${reason}`);
    }
  }
}

function scheduledRegistryProjectIds(): string[] {
  const ids = records(FACTORY_REGISTRY.factories, "registry_factories_invalid")
    .filter((factory) => ACTIVE_FACTORY_STATES.has(String(factory.state)))
    .flatMap((factory) => strings((factory.linear as ObjectValue).project_ids, "registry_project_ids_invalid"));
  if (new Set(ids).size !== ids.length) throw new Error("registry_project_ids_ambiguous");
  return ids;
}

async function intakeScheduledRegistryProjects(env: Env): Promise<void> {
  // Project authority is resolved from the signed-in issue and the canonical
  // registry. This only discovers candidates; `admit` still verifies every
  // project/team/label/contract boundary before a run is durable.
  const query = "query($projectId:ID!){issues(first:50,filter:{project:{id:{eq:$projectId}}}){nodes{id identifier description project{id} team{id} state{type} labels{nodes{name}}}}}";
  for (const projectId of scheduledRegistryProjectIds()) {
    const data = await linearGraphql(env, query, { projectId });
    const issues = (data.issues as ObjectValue | undefined)?.nodes;
    if (!Array.isArray(issues)) throw new Error("linear_scheduled_intake_invalid");
    for (const issue of issues.slice(0, 50)) {
      try {
        const job = await admit(JSON.stringify({ type: "Issue", data: issue }), env);
        const outcome = await insertRun(env.DB, job);
        if (outcome === "inserted") await env.EXECUTION_QUEUE.send(job);
      } catch (error) {
        // Most project issues are not opted in. Malformed or over-authority
        // candidates fail closed without preventing other registered factories
        // from being inspected on this scheduled pass.
        if (!(error instanceof AdmissionError)) throw error;
      }
    }
  }
}

export class ExecutionWorkflow extends WorkflowEntrypoint<Env, Job> {
  async run(event: Readonly<WorkflowEvent<Job>>, step: WorkflowStep): Promise<ObjectValue> {
    const job = event.payload;
    let run: Run | null = null;
    let published: PullRequest | null = null;
    let leaseHeld = false;
    const finish = async (state: string, reason: string, extra: ObjectValue = {}): Promise<ObjectValue> => {
      await step.do("finalize", async () => {
        const latest = await runById(this.env.DB, job.runId);
        if (!latest) throw new Error("run_missing");
        const fence = latest.lease_fence === null ? undefined : latest.lease_fence;
        await transitionRun(this.env.DB, job.runId, state, workflowActor(latest.current_state, state), `workflow:final:${job.runId}`, { result: { reason, ...extra }, leaseFence: fence });
        await recordStep(this.env.DB, job.runId, "final", state, { reason, ...extra });
        return { recorded: true };
      });
      return { status: state, runId: job.runId, reason };
    };
    try {
      run = await runById(this.env.DB, job.runId);
      if (!run || run.lease_fence === null) return { status: "needs-human", runId: job.runId, reason: "lease_missing" };
      const runtimeLimits = runtimeExecutionLimits(this.env, job.contract);
      const remainingTimeout = () => workflowTimeout(remainingRunSeconds(run as Run, runtimeLimits));
      leaseHeld = true;
      if (await stopped(this.env.DB)) {
        return await finish("stopped", "stop_requested_before_execution");
      }
      await renewLease(this.env.DB, run);

      const grounding = await step.do<GroundingResult>("ground", { retries: { limit: 1, delay: "30 seconds" }, timeout: remainingTimeout() }, async (): Promise<GroundingResult> => {
        const result = await groundInSandbox(this.env, job);
        await recordStep(this.env.DB, job.runId, "ground", result.status, { reason: result.reason, digest: result.digest, bytes: result.bytes, file_count: result.file_count });
        return result;
      });
      if (grounding.status !== "passed") {
        return await finish(grounding.reason === "grounding_base_unavailable" ? "needs-replan" : "needs-human", grounding.reason, { grounding_digest: grounding.digest, grounding_bytes: grounding.bytes });
      }

      const maxFixAttempts = Number(this.env.MAX_FIX_ATTEMPTS);
      if (!Number.isSafeInteger(maxFixAttempts) || maxFixAttempts < 0 || maxFixAttempts > 2) return await finish("needs-human", "fix_cap_invalid");
      let execution: AgentResult | null = null;
      let validation: ValidationResult | null = null;
      let review: ReviewResult | null = null;
      let cumulativeCostUsd = 0;
      for (let attempt = 0; attempt <= maxFixAttempts; attempt += 1) {
        const remainingCostUsd = runtimeLimits.costUsd - cumulativeCostUsd;
        if (!Number.isFinite(remainingCostUsd) || remainingCostUsd <= 0) return await finish("needs-human", "cost_cap_exhausted", { cost_usd: cumulativeCostUsd, cost_cap_usd: runtimeLimits.costUsd });
        if (await stopped(this.env.DB)) return await finish("stopped", "stop_requested_before_execution");
        await renewLease(this.env.DB, run);
        const findings = validation?.status === "failed" ? [validation.reason] : [];
        execution = await step.do<AgentResult>(`sandbox-execution-${attempt}`, { retries: { limit: 1, delay: "30 seconds" }, timeout: remainingTimeout() }, async (): Promise<AgentResult> => {
          // The provider request receives only the remaining authoritative budget;
          // it cannot start after previous attempts consumed the cap.
          const result = await executeInSandbox(this.env, job, remainingRunSeconds(run as Run, runtimeLimits), remainingCostUsd, attempt, findings);
          await recordStep(this.env.DB, job.runId, `sandbox-execution-${attempt}`, result.status, { reason: result.reason, branch: result.branch, head_sha: result.head_sha, diff_digest: result.diff_digest, validation_digest: result.validation_digest, validation_bytes: result.validation_bytes, provider_usage: result.provider_usage });
          return result;
        });
        if (execution.status === "needs-replan" || execution.status === "needs-human" || !execution.branch || !execution.head_sha || (execution.status === "failed" && execution.reason !== "validation_failed")) {
          const state = execution.status === "needs-replan" ? "needs-replan" : execution.status === "failed" ? "failed" : "needs-human";
          return await finish(state, execution.reason, { head_sha: execution.head_sha ?? null, branch: execution.branch ?? null });
        }
        cumulativeCostUsd += execution.cost_usd ?? Number.POSITIVE_INFINITY;
        if (!Number.isFinite(cumulativeCostUsd) || cumulativeCostUsd > runtimeLimits.costUsd) return await finish("needs-human", "cost_cap_exceeded", { cost_usd: cumulativeCostUsd, cost_cap_usd: runtimeLimits.costUsd });
        if (await stopped(this.env.DB)) return await finish("stopped", "stop_requested_before_validation", { head_sha: execution.head_sha, branch: execution.branch });
        await transitionRun(this.env.DB, job.runId, "validating", "workflow", `workflow:validating:${job.runId}:${attempt}`, { leaseFence: run.lease_fence ?? undefined });

        validation = await step.do<ValidationResult>(`independent-validation-${attempt}`, { retries: { limit: 1, delay: "30 seconds" }, timeout: remainingTimeout() }, async (): Promise<ValidationResult> => {
          const result = await validateInFreshSandbox(this.env, job, execution as AgentResult);
          await recordStep(this.env.DB, job.runId, `independent-validation-${attempt}`, result.status, { reason: result.reason, fixable: result.fixable, exit_code: result.exit_code, output_digest: result.output_digest, output_bytes: result.output_bytes });
          return result;
        });
        if (validation.status !== "passed") {
          if (validation.fixable && attempt < maxFixAttempts) {
            await transitionRun(this.env.DB, job.runId, "fixable-failure", "validator", `workflow:validation-fixable:${job.runId}:${attempt}`, { result: { reason: validation.reason, validation_digest: validation.output_digest, validation_bytes: validation.output_bytes }, leaseFence: run.lease_fence ?? undefined });
            await transitionRun(this.env.DB, job.runId, "running", "workflow", `workflow:validation-retry:${job.runId}:${attempt}`, { result: { reason: "bounded_fix_attempt", attempt: attempt + 1 }, leaseFence: run.lease_fence ?? undefined });
            continue;
          }
          return await finish("failed", validation.reason, { validation_digest: validation.output_digest, validation_bytes: validation.output_bytes, head_sha: execution.head_sha });
        }
        if (await stopped(this.env.DB)) return await finish("stopped", "stop_requested_before_review", { head_sha: execution.head_sha, branch: execution.branch });

        review = await step.do<ReviewResult>(`independent-review-${attempt}`, { retries: { limit: 1, delay: "30 seconds" }, timeout: remainingTimeout() }, async (): Promise<ReviewResult> => {
          const result = await reviewInFreshSandbox(this.env, job, execution as AgentResult);
          await recordStep(this.env.DB, job.runId, `independent-review-${attempt}`, result.status, { reason: result.reason, digest: result.digest, bytes: result.bytes });
          return result;
        });
        if (review.status !== "passed") {
          if (attempt < maxFixAttempts) {
            validation = { status: "failed", exit_code: 78, output_digest: review.digest, output_bytes: review.bytes, reason: review.reason, fixable: true };
            await transitionRun(this.env.DB, job.runId, "fixable-failure", "validator", `workflow:review-fixable:${job.runId}:${attempt}`, { result: { reason: review.reason, review_digest: review.digest, review_bytes: review.bytes }, leaseFence: run.lease_fence ?? undefined });
            await transitionRun(this.env.DB, job.runId, "running", "workflow", `workflow:review-retry:${job.runId}:${attempt}`, { result: { reason: "bounded_fix_attempt", attempt: attempt + 1 }, leaseFence: run.lease_fence ?? undefined });
            continue;
          }
          return await finish("needs-human", review.reason, { review_digest: review.digest, review_bytes: review.bytes, head_sha: execution.head_sha });
        }
        break;
      }
      if (!execution || !validation || validation.status !== "passed" || !review || review.status !== "passed") return await finish("needs-human", "workflow_evaluation_incomplete");
      if (await stopped(this.env.DB)) return await finish("stopped", "stop_requested_before_publication", { head_sha: execution.head_sha });
      await renewLease(this.env.DB, run);

      published = await step.do<PullRequest>("publish-pr", { retries: { limit: 1, delay: "30 seconds" }, timeout: remainingTimeout() }, async (): Promise<PullRequest> => {
        const pull = await publishPullRequest(this.env, job, execution);
        await recordStep(this.env.DB, job.runId, "publish-pr", "passed", { number: pull.number, url: pull.html_url, head_sha: pull.head.sha, base: pull.base.ref, base_sha: pull.base.sha });
        await recordPrReceipt(this.env.DB, job.runId, pull);
        return pull;
      });
      const receipt = await step.do<"created" | "existing">("linear-receipt", { retries: { limit: 1, delay: "30 seconds" }, timeout: remainingTimeout() }, async (): Promise<"created" | "existing"> => {
        const result = await ensureLinearReceipt(this.env, job, published as PullRequest);
        await recordStep(this.env.DB, job.runId, "linear-receipt", "passed", { outcome: result, pr_number: (published as PullRequest).number });
        await recordLinearReconciliation(this.env.DB, job.runId, `linear:${job.runId}:${(published as PullRequest).number}`, "pr-open", "pr_published");
        return result;
      });
      await step.do("finalize-pr", async () => {
        const pull = published as PullRequest;
        await transitionRun(this.env.DB, job.runId, "pr-open", "workflow", `workflow:publish:${job.runId}`, {
          result: { reason: "pr_published", validation_digest: validation.output_digest, validation_bytes: validation.output_bytes, review_digest: review?.digest, review_bytes: review?.bytes, linear_receipt: receipt },
          leaseFence: run?.lease_fence ?? undefined,
          fields: { branch: execution?.branch ?? null, headSha: pull.head.sha, prNumber: pull.number, prUrl: pull.html_url },
        });
        await recordStep(this.env.DB, job.runId, "final", "pr-open", { pr_number: pull.number, pr_url: pull.html_url, head_sha: pull.head.sha });
        return { recorded: true };
      });
      return { status: "pr-open", runId: job.runId, prUrl: (published as PullRequest).html_url };
    } catch (error) {
      const reason = error instanceof Error && ["publication_base_changed", "grounding_base_unavailable", "base_sha_unavailable", "fix_branch_base_changed", "workflow_deadline_exceeded"].includes(error.message) ? error.message : "workflow_step_failed";
      const state = reason === "publication_base_changed" || reason === "grounding_base_unavailable" || reason === "base_sha_unavailable" || reason === "fix_branch_base_changed" ? "needs-replan" : "needs-human";
      return await finish(state, reason, { pr_url: published?.html_url ?? null, pr_number: published?.number ?? null });
    } finally {
      if (leaseHeld) await step.do("release-lease", async () => {
        const latest = await runById(this.env.DB, job.runId);
        if (latest?.lease_fence !== null && latest?.lease_fence !== undefined) await releaseLease(this.env.DB, latest);
        await recordStep(this.env.DB, job.runId, "lease-release", "passed", { released: latest?.lease_fence !== null && latest?.lease_fence !== undefined });
        return { released: true };
      });
    }
  }
}

// These pure boundaries are exported only for local Worker-runtime tests. They
// are not attached to the public fetch surface.
export const __TEST_ONLY__ = {
  sandboxCredentials,
  inherentEffectClasses,
  capacityLeaseScopes,
  runtimeConcurrencyLimits,
  acquireLease,
  renewLease,
  releaseLease,
  remainingRunSeconds,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return response({ ok: true });
      if (url.pathname === "/ops/status") {
        const admin = secret(env, "FACTORY_ADMIN_SECRET");
        if (request.method !== "GET" || !admin || request.headers.get("Authorization") !== `Bearer ${admin}`) return response({ error: "forbidden" }, 403);
        return response({
          ok: true,
          stopped: await stopped(env.DB),
          automaticMerge: false,
          registryVersion: text(FACTORY_REGISTRY.registry_version, "registry_version_invalid"),
          registryDigest: await digest(FACTORY_REGISTRY),
          enabledFactories: records(FACTORY_REGISTRY.factories, "registry_factories_invalid").filter((item) => ACTIVE_FACTORY_STATES.has(String(item.state))).map((item) => item.factory_id),
        });
      }
      if (url.pathname === "/webhooks/linear" && request.method === "POST") return await acceptLinear(request, env);
      if (url.pathname === "/webhooks/github" && request.method === "POST") return await acceptGithub(request, env);
      if (url.pathname === "/controls/stop" || url.pathname === "/controls/resume") {
        const admin = secret(env, "FACTORY_ADMIN_SECRET");
        if (request.method !== "POST" || !admin || request.headers.get("Authorization") !== `Bearer ${admin}`) return response({ error: "forbidden" }, 403);
        await env.DB.prepare("INSERT INTO control_flags(key,value,updated_at) VALUES('stop',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(String(url.pathname.endsWith("/stop")), new Date().toISOString()).run();
        return response({ stopped: await stopped(env.DB) });
      }
      return response({ error: "not_found" }, 404);
    } catch {
      return response({ error: "control_plane_unavailable" }, 503);
    }
  },
  async queue(batch: MessageBatch<QueueJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (isGitHubReconciliationJob(message.body)) {
        try {
          await reconcileGithubEvent(env, message.body);
          await markIngress(env.DB, message.body.eventId, "processed");
          message.ack();
        } catch {
          try { await markIngress(env.DB, message.body.eventId, "retryable:reconciliation_failed"); } catch { /* queue retry remains authoritative */ }
          message.retry();
        }
        continue;
      }
      const result = await schedule(env, message.body as Job);
      if (["dispatched", "stopped", "blocked-by-dependency", "needs-replan", "already-handled", "needs-human"].includes(result)) message.ack();
      else message.retry();
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await recoverStaleLeases(env);
    if (await stopped(env.DB)) return;
    await recoverIngress(env);
    if (String(env.FACTORY_ENABLED) !== "true") return;
    if (String(env.FACTORY_AUTONOMY) === "1") await intakeScheduledRegistryProjects(env);
    const row = await env.DB.prepare("SELECT run_id,contract_json FROM factory_runs WHERE current_state IN ('admitted','queued','blocked-by-dependency') ORDER BY created_at LIMIT 1").first<{ run_id: string; contract_json: string }>();
    if (row) { const contract = JSON.parse(row.contract_json) as Contract; await schedule(env, { kind: "dispatch", dispatchId: contract.dispatch_id, runId: row.run_id, contractDigest: await digest(contract), contract }); }
  },
};
