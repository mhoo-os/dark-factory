#!/usr/bin/env python3
"""Fail-closed Linear-to-GitHub intake for one active Mhoo Dark Factory item."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from factory.admission import AdmissionDecision, admit_linear_issue

ROOT = Path(__file__).resolve().parents[1]
TEAM_ID = os.environ.get("LINEAR_FACTORY_TEAM_ID", "085d25a0-104f-4e80-82fb-b0ea7c476b0b")
PROJECT_ID = os.environ.get("LINEAR_FACTORY_PROJECT_ID", "2dab9206-cb92-49a4-aeef-95ec45280098")
ORG = "mhoo-os"
MARKER = "mhoo-dark-factory:v1"
CHECKOUT_HEAD_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)


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
    dry_run_authorization: dict[str, Any] | None

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


def admission_for(
    issue: dict[str, Any], *, dry_run: bool = False, checkout_head: str | None = None
) -> AdmissionDecision:
    return admit_linear_issue(
        issue,
        expected_project_id=PROJECT_ID,
        allow_dry_run_authorization=dry_run,
        current_checkout_head=checkout_head,
    )


def candidate_from(
    issue: dict[str, Any], *, dry_run: bool = False, checkout_head: str | None = None
) -> Candidate:
    admission = admission_for(issue, dry_run=dry_run, checkout_head=checkout_head)
    if admission.outcome != "admitted" or admission.contract is None:
        reasons = ",".join(admission.reasons) or admission.outcome
        raise TriageError(f"admission_{admission.outcome}:{reasons}")
    document = admission.contract.to_dict()
    target = document["target"]
    authorization = admission.contract.dry_run_authorization
    labels = tuple(label["name"] for label in issue["labels"]["nodes"])
    return Candidate(
        id=issue["id"], identifier=issue["identifier"], title=issue["title"],
        description=issue.get("description") or "", url=issue["url"],
        priority=issue.get("priority") or 3, state_id=issue["state"]["id"],
        state_name=issue["state"]["name"], labels=labels,
        candidate_key=admission.contract.dispatch_id, repository=target["repository"],
        dispatch_id=admission.contract.dispatch_id, contract_digest=admission.contract.digest,
        dry_run_authorization=dict(authorization) if authorization else None,
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


def eligible_issues() -> list[dict[str, Any]]:
    query = """query($teamId: ID!, $projectId: ID!) {
      issues(first: 50, filter: { team: { id: { eq: $teamId } }, project: { id: { eq: $projectId } } }) {
        nodes { id identifier title description url priority project { id } state { id name type } labels { nodes { name } } }
      }
    }"""
    return graphql(query, {"teamId": TEAM_ID, "projectId": PROJECT_ID})["issues"]["nodes"]


def admission_report(
    issues: list[dict[str, Any]], *, dry_run: bool = False, checkout_head: str | None = None
) -> list[dict[str, Any]]:
    report = []
    for issue in issues:
        decision = admission_for(issue, dry_run=dry_run, checkout_head=checkout_head)
        report.append({
            "issue": issue.get("identifier", "unknown"),
            "outcome": decision.outcome,
            "reasons": list(decision.reasons),
            "dispatch_id": decision.dispatch_id,
            "digest": decision.digest,
        })
    return report


def select(issues: list[dict[str, Any]], *, dry_run: bool = False, checkout_head: str | None = None) -> Candidate | None:
    candidates: list[Candidate] = []
    for issue in issues:
        try:
            candidates.append(candidate_from(issue, dry_run=dry_run, checkout_head=checkout_head))
        except TriageError:
            continue
    candidates.sort(key=lambda item: (item.priority, item.identifier))
    return candidates[0] if candidates else None


def pending_candidate(
    issues: list[dict[str, Any]], *, dry_run: bool = False, checkout_head: str | None = None
) -> tuple[Candidate, str | None] | None:
    candidates: list[Candidate] = []
    for issue in issues:
        try:
            candidates.append(candidate_from(issue, dry_run=dry_run, checkout_head=checkout_head))
        except TriageError:
            continue
    candidates.sort(key=lambda item: (item.priority, item.identifier))
    dry_run_candidates = [candidate for candidate in candidates if candidate.dry_run_authorization is not None]
    if dry_run_candidates:
        if len(dry_run_candidates) != 1:
            raise TriageError("dry_run_authorization_ambiguous")
        return dry_run_candidates[0], None
    for candidate in candidates:
        existing = existing_issue(candidate)
        if existing is None:
            return candidate, None
    return None


def clean_checkout_head() -> str:
    """Bind a temporary authorization to one clean checkout before any provider write path."""
    status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, text=True, capture_output=True)
    if status.returncode or status.stdout:
        raise TriageError("dry_run_authorization_checkout_not_clean")
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True)
    value = head.stdout.strip()
    if head.returncode or CHECKOUT_HEAD_PATTERN.fullmatch(value) is None:
        raise TriageError("dry_run_authorization_checkout_head_unreadable")
    return value.lower()


def plan_candidate(candidate: Candidate, *, dry_run: bool) -> dict[str, Any]:
    """Return the only plan allowed for a temporary B5 authorization before any writes."""
    if candidate.dry_run_authorization is not None:
        if not dry_run:
            raise TriageError("dry_run_authorization_requires_dry_run")
        return {
            "action": "approved-intake-dry-run",
            "candidate": candidate.identifier,
            "dispatch_id": candidate.dispatch_id,
            "contract_digest": candidate.contract_digest,
            "authorization_id": candidate.dry_run_authorization["authorization_id"],
            "repository": candidate.dry_run_authorization["repository"],
            "pr_number": candidate.dry_run_authorization["pr_number"],
            "linear_issue": candidate.dry_run_authorization["linear_issue"],
            "review_id": candidate.dry_run_authorization["review_id"],
            "checkout_head_sha": candidate.dry_run_authorization["checkout_head_sha"],
            "normal_dispatch": False,
            "provider_mutations": False,
        }
    existing = existing_issue(candidate)
    return {
        "candidate": candidate.identifier,
        "repository": candidate.repository,
        "github_execution_issue": existing,
        "action": "unchanged" if existing else "create",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--fixture", type=Path, help="offline Linear nodes JSON for tests")
    args = parser.parse_args()
    try:
        if (ROOT / ".factory/STOP").exists():
            raise TriageError("local .factory/STOP is present")
        checkout_head = clean_checkout_head() if args.dry_run else None
        issues = json.loads(args.fixture.read_text()) if args.fixture else eligible_issues()
        admitted = []
        for issue in issues:
            try:
                admitted.append(candidate_from(issue, dry_run=args.dry_run, checkout_head=checkout_head))
            except TriageError:
                continue
        remote_stop_requested({candidate.repository for candidate in admitted})
        selected = pending_candidate(issues, dry_run=args.dry_run, checkout_head=checkout_head)
        if selected is None:
            print(json.dumps({"action": "noop", "reason": "no_admitted_linear_contract", "admissions": admission_report(issues, dry_run=args.dry_run, checkout_head=checkout_head)}, sort_keys=True))
            return 0
        candidate, existing = selected
        plan = plan_candidate(candidate, dry_run=args.dry_run)
        if args.dry_run:
            print(json.dumps(plan, sort_keys=True))
            return 0
        if candidate.dry_run_authorization is not None:
            raise TriageError("dry_run_authorization_requires_dry_run")
        assert existing is not None or plan["action"] == "create"
        github_url = create_issue(candidate)
        update_linear(candidate, github_url)
        print(json.dumps({**plan, "github_execution_issue": github_url}, sort_keys=True))
        return 0
    except (TriageError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"TRIAGE_STOP: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
