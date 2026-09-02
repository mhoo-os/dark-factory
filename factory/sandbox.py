"""Fail-closed sandbox execution boundary; provider calls stay behind a small protocol."""
from __future__ import annotations

from dataclasses import dataclass
import fnmatch
import hashlib
import json
import re
from typing import Any, Mapping, Protocol

from factory.profile_registry import resolve_profiles

SHA = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
IDENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$")
SAFE_REQUEST_REASONS = frozenset({
    "invalid_run_identity", "invalid_base_sha", "credential_scope_mismatch",
    "credential_expired_or_missing", "command_budget_invalid", "diff_budget_invalid",
    "command_not_allowed", "command_timeout_out_of_bounds", "command_output_out_of_bounds",
    "command_argument_invalid", "credential_reference_in_command",
})


class SandboxError(RuntimeError):
    pass


class SandboxTimeout(SandboxError):
    pass


class SandboxOOM(SandboxError):
    pass


class SandboxLost(SandboxError):
    pass


class OutputRejected(SandboxError):
    pass


@dataclass(frozen=True)
class CredentialLease:
    """An opaque broker reference; the credential value is never part of a receipt."""

    credential_ref: str
    repository: str
    base_sha: str
    scopes: tuple[str, ...]
    issued_at: int
    expires_at: int


@dataclass(frozen=True)
class CommandSpec:
    argv: tuple[str, ...]
    purpose: str
    timeout_seconds: int
    max_output_bytes: int


@dataclass(frozen=True)
class SandboxRequest:
    dispatch_id: str
    run_id: str
    repository: str
    base_sha: str
    execution_profile: str
    validation_profile: str
    credential: CredentialLease
    commands: tuple[CommandSpec, ...]
    allowed_paths: tuple[str, ...]
    max_files: int
    max_changed_lines: int
    now: int


@dataclass(frozen=True)
class Workspace:
    repository: str
    base_sha: str
    head_sha: str


@dataclass(frozen=True)
class RuntimeOutput:
    stdout: str
    stderr: str
    exit_code: int
    redacted: bool = True


@dataclass(frozen=True)
class RuntimeDiff:
    base_sha: str
    head_sha: str
    changed_files: tuple[str, ...]
    changed_lines: int
    patch: str
    redacted: bool = True


@dataclass(frozen=True)
class Artifact:
    name: str
    digest: str
    size_bytes: int
    redacted: bool = True


@dataclass(frozen=True)
class SandboxEvent:
    sequence: int
    dispatch_id: str
    run_id: str
    sandbox_id: str
    event_type: str
    details: Mapping[str, Any]


class SandboxRuntime(Protocol):
    def start(self, sandbox_id: str, *, repository: str, base_sha: str, credential: CredentialLease) -> Workspace: ...
    def execute(self, sandbox_id: str, argv: tuple[str, ...], *, timeout_seconds: int) -> RuntimeOutput: ...
    def diff(self, sandbox_id: str, *, base_sha: str) -> RuntimeDiff: ...
    def artifacts(self, sandbox_id: str, *, names: tuple[str, ...]) -> tuple[Artifact, ...]: ...
    def destroy(self, sandbox_id: str) -> None: ...


@dataclass(frozen=True)
class CommandReceipt:
    purpose: str
    status: str
    exit_code: int | None
    stdout: str
    stderr: str
    stdout_digest: str
    stderr_digest: str
    truncated: bool


@dataclass(frozen=True)
class SandboxReceipt:
    status: str
    reason: str
    dispatch_id: str
    run_id: str
    sandbox_id: str
    repository: str
    base_sha: str
    head_sha: str | None
    commands: tuple[CommandReceipt, ...]
    diff: RuntimeDiff | None
    artifacts: tuple[Artifact, ...]
    events: tuple[SandboxEvent, ...]
    cleaned_up: bool
    digest: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status, "reason": self.reason, "dispatch_id": self.dispatch_id,
            "run_id": self.run_id, "sandbox_id": self.sandbox_id, "repository": self.repository,
            "base_sha": self.base_sha, "head_sha": self.head_sha,
            "commands": [item.__dict__ for item in self.commands],
            "diff": self.diff.__dict__ if self.diff else None,
            "artifacts": [item.__dict__ for item in self.artifacts],
            "events": [item.__dict__ for item in self.events], "cleaned_up": self.cleaned_up,
            "digest": self.digest,
        }


def _digest(value: Any) -> str:
    data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _bounded(value: str, limit: int) -> tuple[str, bool, str]:
    raw = value.encode("utf-8")
    digest = _digest({"text": value})
    if len(raw) <= limit:
        return value, False, digest
    return raw[:limit].decode("utf-8", errors="ignore"), True, digest


def _validate(request: SandboxRequest, profile: Any) -> None:
    if not IDENT.fullmatch(request.dispatch_id) or not IDENT.fullmatch(request.run_id):
        raise SandboxError("invalid_run_identity")
    if not SHA.fullmatch(request.base_sha):
        raise SandboxError("invalid_base_sha")
    lease = request.credential
    if (lease.repository, lease.base_sha) != (request.repository, request.base_sha):
        raise SandboxError("credential_scope_mismatch")
    if not IDENT.fullmatch(lease.credential_ref) or not lease.scopes or not (lease.issued_at <= request.now < lease.expires_at):
        raise SandboxError("credential_expired_or_missing")
    execution = profile.execution
    limits = execution["limits"]
    if not request.commands or len(request.commands) > 32:
        raise SandboxError("command_budget_invalid")
    if not request.allowed_paths or request.max_files < 1 or request.max_changed_lines < 1:
        raise SandboxError("diff_budget_invalid")
    for command in request.commands:
        if not command.purpose or not IDENT.fullmatch(command.purpose):
            raise SandboxError("command_argument_invalid")
        if not command.argv or command.argv[0] not in execution["allowed_tools"]:
            raise SandboxError("command_not_allowed")
        if command.timeout_seconds < 1 or command.timeout_seconds > min(900, limits["timeout_seconds"]):
            raise SandboxError("command_timeout_out_of_bounds")
        if command.max_output_bytes < 1 or command.max_output_bytes > 262144:
            raise SandboxError("command_output_out_of_bounds")
        if any(not isinstance(arg, str) or "\x00" in arg for arg in command.argv):
            raise SandboxError("command_argument_invalid")
        if lease.credential_ref in command.argv:
            raise SandboxError("credential_reference_in_command")


class SandboxAdapter:
    """Run one exact-base sandbox lap and persist safe events before side effects."""

    def __init__(self, runtime: SandboxRuntime, event_sink: Any):
        self.runtime = runtime
        self.event_sink = event_sink

    def run(self, request: SandboxRequest) -> SandboxReceipt:
        sandbox_id = "sb-" + _digest({"dispatch_id": request.dispatch_id, "run_id": request.run_id})[7:31]
        events: list[SandboxEvent] = []
        sequence = 0

        def record(event_type: str, **details: Any) -> None:
            nonlocal sequence
            sequence += 1
            event = SandboxEvent(sequence, request.dispatch_id, request.run_id, sandbox_id, event_type, details)
            self.event_sink.append(event)
            events.append(event)

        status, reason, head_sha = "contract-rejected", "", None
        commands: list[CommandReceipt] = []
        diff: RuntimeDiff | None = None
        artifacts: tuple[Artifact, ...] = ()
        started = False
        cleaned_up = True
        record("request_received", repository=request.repository, base_sha=request.base_sha)
        try:
            try:
                profile = resolve_profiles(request.repository, request.execution_profile, request.validation_profile)
                _validate(request, profile)
            except (KeyError, TypeError, ValueError, SandboxError) as error:
                candidate = str(error) if isinstance(error, SandboxError) else ""
                reason = candidate if candidate in SAFE_REQUEST_REASONS else "profile_rejected"
                record("request_rejected", reason=reason)
            else:
                status = "running"
                record("sandbox_starting")
                try:
                    started = True
                    workspace = self.runtime.start(
                        sandbox_id, repository=request.repository, base_sha=request.base_sha, credential=request.credential
                    )
                    if (workspace.repository, workspace.base_sha) != (request.repository, request.base_sha) or not SHA.fullmatch(workspace.head_sha):
                        raise SandboxError("workspace_identity_mismatch")
                    head_sha = workspace.head_sha
                    record("checkout_verified", head_sha=head_sha)
                    profile = resolve_profiles(request.repository, request.execution_profile, request.validation_profile)
                    for index, command in enumerate(request.commands, 1):
                        record("command_started", index=index, purpose=command.purpose)
                        command_status, exit_code = "passed", None
                        stdout = stderr = ""
                        stdout_digest = stderr_digest = _digest({"text": ""})
                        truncated = False
                        try:
                            output = self.runtime.execute(sandbox_id, command.argv, timeout_seconds=command.timeout_seconds)
                            if not output.redacted:
                                raise OutputRejected("unredacted_runtime_output")
                            stdout, out_truncated, stdout_digest = _bounded(output.stdout, command.max_output_bytes)
                            stderr, err_truncated, stderr_digest = _bounded(output.stderr, command.max_output_bytes)
                            truncated = out_truncated or err_truncated
                            exit_code = output.exit_code
                            if output.exit_code != 0:
                                command_status, status, reason = "failed", "command-failed", "command_nonzero"
                        except SandboxTimeout:
                            command_status, status, reason = "timed-out", "timed-out", "command_timeout"
                        except SandboxOOM:
                            command_status, status, reason = "oom", "oom", "command_oom"
                        except SandboxLost:
                            command_status, status, reason = "sandbox-lost", "sandbox-lost", "sandbox_disconnected"
                        except OutputRejected:
                            command_status, status, reason = "output-rejected", "output-rejected", "unredacted_output"
                        except SandboxError:
                            command_status, status, reason = "contract-failed", "contract-failed", "runtime_contract_error"
                        except Exception:
                            command_status, status, reason = "runtime-failed", "runtime-failed", "runtime_error"
                        commands.append(CommandReceipt(command.purpose, command_status, exit_code, stdout, stderr, stdout_digest, stderr_digest, truncated))
                        record("command_completed", index=index, status=command_status, stdout_digest=stdout_digest, stderr_digest=stderr_digest, truncated=truncated)
                        if command_status != "passed":
                            break
                    if status == "running":
                        raw_diff = self.runtime.diff(sandbox_id, base_sha=request.base_sha)
                        if not raw_diff.redacted:
                            raise OutputRejected("unredacted_diff")
                        if raw_diff.base_sha != request.base_sha or not SHA.fullmatch(raw_diff.head_sha):
                            raise SandboxError("diff_identity_mismatch")
                        if raw_diff.changed_lines < 0 or raw_diff.changed_lines > min(request.max_changed_lines, profile.execution["limits"]["max_changed_lines"]):
                            raise SandboxError("changed_lines_exceeded")
                        if len(set(raw_diff.changed_files)) > min(request.max_files, profile.execution["limits"]["max_files"]):
                            raise SandboxError("changed_files_exceeded")
                        if any(not path or path.startswith("/") or ".." in path.split("/") for path in raw_diff.changed_files):
                            raise SandboxError("scope_violation")
                        if any(not any(fnmatch.fnmatch(path, pattern) for pattern in request.allowed_paths) for path in raw_diff.changed_files):
                            raise SandboxError("scope_violation")
                        patch, truncated, _ = _bounded(raw_diff.patch, 262144)
                        diff = RuntimeDiff(raw_diff.base_sha, raw_diff.head_sha, tuple(sorted(set(raw_diff.changed_files))), raw_diff.changed_lines, patch, True)
                        head_sha = raw_diff.head_sha
                        record("diff_captured", head_sha=head_sha, changed_files=len(diff.changed_files), changed_lines=diff.changed_lines, truncated=truncated)
                        names = tuple(profile.execution["artifacts"])
                        artifacts = self.runtime.artifacts(sandbox_id, names=names)
                        if any(item.name not in names or not isinstance(item.size_bytes, int) or isinstance(item.size_bytes, bool) or item.size_bytes < 0 or not item.redacted for item in artifacts):
                            raise SandboxError("artifact_contract_failed")
                        record("artifacts_captured", count=len(artifacts))
                        status, reason = "passed", "completed"
                except SandboxTimeout:
                    status, reason = "timed-out", "sandbox_timeout"
                except SandboxOOM:
                    status, reason = "oom", "sandbox_oom"
                except SandboxLost:
                    status, reason = "sandbox-lost", "sandbox_disconnected"
                except OutputRejected:
                    status, reason = "output-rejected", "unredacted_output"
                except SandboxError:
                    status, reason = "contract-failed", "runtime_contract_error"
                except Exception:
                    status, reason = "runtime-failed", "runtime_error"
        finally:
            if started:
                cleaned_up = False
                record("cleanup_started")
                try:
                    self.runtime.destroy(sandbox_id)
                    cleaned_up = True
                    record("cleanup_completed")
                except Exception:
                    status, reason = "cleanup-failed", "cleanup_failed"
                    record("cleanup_failed")

        payload = {
            "status": status, "reason": reason, "dispatch_id": request.dispatch_id, "run_id": request.run_id,
            "sandbox_id": sandbox_id, "repository": request.repository, "base_sha": request.base_sha,
            "head_sha": head_sha, "commands": [item.__dict__ for item in commands],
            "diff": diff.__dict__ if diff else None, "artifacts": [item.__dict__ for item in artifacts],
            "cleaned_up": cleaned_up,
        }
        return SandboxReceipt(status, reason, request.dispatch_id, request.run_id, sandbox_id, request.repository, request.base_sha, head_sha, tuple(commands), diff, artifacts, tuple(events), cleaned_up, _digest(payload))
