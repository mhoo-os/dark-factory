#!/usr/bin/env python3
"""Fail-closed Linear-to-GitHub intake for one active Mhoo Dark Factory item."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from factory.admission import AdmissionDecision, admit_linear_issue
from factory.factory_registry import REGISTRY, active_intake_mappings

ROOT = Path(__file__).resolve().parents[1]
# Compatibility aliases for offline fixtures. Live intake enumerates every active
# registry mapping below and does not select a named foundation project.
_DEFAULT_MAPPING = active_intake_mappings()[0]
TEAM_ID = _DEFAULT_MAPPING[2]
PROJECT_ID = _DEFAULT_MAPPING[1]
ORG = "mhoo-os"
MARKER = "mhoo-dark-factory:v1"


class TriageError(RuntimeError):
    pass


@dataclass(frozen=True)
class Candidate:
    id: str
    identifier: str
    title: str
    description: str
    url: str
    priority: int
    state_id: str
    state_name: str
    labels: tuple[str, ...]
    candidate_key: str
    repository: str
    dispatch_id: str
    contract_digest: str

    @property
    def bridge_key(self) -> str:
        return hashlib.sha256(f"{self.id}\0{self.dispatch_id}\0{self.contract_digest}".encode()).hexdigest()


def graphql(query: str, variables: dict[str, Any]) -> dict[str, Any]:
    token = os.environ.get("LINEAR_API_KEY")
    if not token:
        raise TriageError("LINEAR_API_KEY is unavailable")
    request = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Authorization": token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode())
    except urllib.error.URLError as error:
        raise TriageError(f"Linear request failed: {error.reason}") from error
    if payload.get("errors"):
        raise TriageError("Linear GraphQL rejected the request")
    return payload["data"]


def gh(*args: str, stdin: str | None = None) -> str:
    completed = subprocess.run(["gh", *args], cwd=ROOT, input=stdin, text=True, capture_output=True)
    if completed.returncode:
        raise TriageError(completed.stderr.strip() or completed.stdout.strip() or "GitHub command failed")
    return completed.stdout


def remote_stop_requested(repositories: set[str]) -> None:
    for repository in sorted(repositories):
        result = subprocess.run(
            ["gh", "issue", "list", "--repo", repository, "--state", "open", "--label", "factory:stop", "--limit", "1", "--json", "number"],
            cwd=ROOT, text=True, capture_output=True,
        )
        if result.returncode:
            raise TriageError("remote stop state is unreadable")
        if json.loads(result.stdout):
            raise TriageError(f"remote factory:stop is present for {repository}")


def admission_for(issue: dict[str, Any]) -> AdmissionDecision:
    return admit_linear_issue(issue)


def candidate_from(issue: dict[str, Any]) -> Candidate:
    admission = admission_for(issue)
    if admission.outcome != "admitted" or admission.contract is None:
        reasons = ",".join(admission.reasons) or admission.outcome
        raise TriageError(f"admission_{admission.outcome}:{reasons}")
    document = admission.contract.to_dict()
    target = document["target"]
    labels = tuple(label["name"] for label in issue["labels"]["nodes"])
    return Candidate(
        id=issue["id"], identifier=issue["identifier"], title=issue["title"],
        description=issue.get("description") or "", url=issue["url"],
        priority=issue.get("priority") or 3, state_id=issue["state"]["id"],
        state_name=issue["state"]["name"], labels=labels,
        candidate_key=admission.contract.dispatch_id, repository=target["repository"],
        dispatch_id=admission.contract.dispatch_id, contract_digest=admission.contract.digest,
    )


def marker(candidate: Candidate) -> str:
    return f"<!-- {MARKER} key={candidate.bridge_key} linear={candidate.identifier} candidate={candidate.candidate_key} -->"


def issue_body(candidate: Candidate) -> str:
    return "\n".join((
        marker(candidate), "", "## Factory execution intake", "",
        f"- Linear issue: [{candidate.identifier}]({candidate.url})",
        f"- Intake key: `{candidate.bridge_key}`", "",
        f"- Dispatch: `{candidate.dispatch_id}`",
        f"- Contract digest: `{candidate.contract_digest}`", "",
        "Linear remains the operational queue. This issue is an execution intake only.", "",
        "## Linear description", "", candidate.description or "_No description provided._",
    ))


def existing_issue(candidate: Candidate) -> str | None:
    query = f'"{MARKER} key={candidate.bridge_key}" in:body'
    items = json.loads(gh("issue", "list", "--repo", candidate.repository, "--state", "all", "--search", query, "--limit", "2", "--json", "url"))
    if len(items) > 1:
        raise TriageError("duplicate GitHub execution issues found")
    return items[0]["url"] if items else None


def create_issue(candidate: Candidate) -> str:
    return gh(
        "issue", "create", "--repo", candidate.repository,
        "--title", f"[Factory] {candidate.identifier} — {candidate.title}",
        "--body-file", "-", stdin=issue_body(candidate),
    ).strip()


def update_linear(candidate: Candidate, github_url: str) -> None:
    mutation = "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }"
    body = f"Factory intake created one GitHub execution issue: {github_url}\n\nIntake key: `{candidate.bridge_key}`"
    data = graphql(mutation, {"issueId": candidate.id, "body": body})
    if not data["commentCreate"]["success"]:
        raise TriageError("Linear did not confirm the intake return")


def eligible_issues_for(team_id: str, project_id: str) -> list[dict[str, Any]]:
    query = """query($teamId: ID!, $projectId: ID!) {
      issues(first: 50, filter: { team: { id: { eq: $teamId } }, project: { id: { eq: $projectId } } }) {
        nodes { id identifier title description url priority project { id } team { id } state { id name type } labels { nodes { name } } }
      }
    }"""
    return graphql(query, {"teamId": team_id, "projectId": project_id})["issues"]["nodes"]


def eligible_issues() -> list[dict[str, Any]]:
    """Enumerate all active registry mappings rather than one historical pilot."""
    seen: set[str] = set()
    issues: list[dict[str, Any]] = []
    for _factory_id, project_id, team_id in active_intake_mappings():
        for item in eligible_issues_for(team_id, project_id):
            issue_id = item.get("id")
            if not isinstance(issue_id, str) or issue_id in seen:
                continue
            seen.add(issue_id)
            issues.append(item)
    return issues


def admission_report(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    report = []
    for issue in issues:
        decision = admission_for(issue)
        report.append({
            "issue": issue.get("identifier", "unknown"),
            "outcome": decision.outcome,
            "reasons": list(decision.reasons),
            "dispatch_id": decision.dispatch_id,
            "digest": decision.digest,
        })
    return report


def select(issues: list[dict[str, Any]]) -> Candidate | None:
    candidates: list[Candidate] = []
    for issue in issues:
        try:
            candidates.append(candidate_from(issue))
        except TriageError:
            continue
    candidates.sort(key=lambda item: (item.priority, item.identifier))
    return candidates[0] if candidates else None


def pending_candidate(issues: list[dict[str, Any]]) -> tuple[Candidate, str | None] | None:
    candidates: list[Candidate] = []
    for issue in issues:
        try:
            candidates.append(candidate_from(issue))
        except TriageError:
            continue
    candidates.sort(key=lambda item: (item.priority, item.identifier))
    for candidate in candidates:
        existing = existing_issue(candidate)
        if existing is None:
            return candidate, None
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--fixture", type=Path, help="offline Linear nodes JSON for tests")
    args = parser.parse_args()
    try:
        if (ROOT / ".factory/STOP").exists():
            raise TriageError("local .factory/STOP is present")
        issues = json.loads(args.fixture.read_text()) if args.fixture else eligible_issues()
        admitted = []
        for issue in issues:
            try:
                admitted.append(candidate_from(issue))
            except TriageError:
                continue
        remote_stop_requested({candidate.repository for candidate in admitted})
        selected = pending_candidate(issues)
        if selected is None:
            print(json.dumps({"action": "noop", "reason": "no_admitted_linear_contract", "admissions": admission_report(issues)}, sort_keys=True))
            return 0
        candidate, existing = selected
        plan = {"candidate": candidate.identifier, "repository": candidate.repository, "github_execution_issue": existing, "action": "unchanged" if existing else "create"}
        if args.dry_run:
            print(json.dumps(plan, sort_keys=True))
            return 0
        github_url = create_issue(candidate)
        update_linear(candidate, github_url)
        print(json.dumps({**plan, "github_execution_issue": github_url}, sort_keys=True))
        return 0
    except (TriageError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"TRIAGE_STOP: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
