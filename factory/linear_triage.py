#!/usr/bin/env python3
"""Fail-closed Linear-to-GitHub triage for one Mhoo Dark Factory candidate."""
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

ROOT = Path(__file__).resolve().parents[1]
TEAM_ID = os.environ.get("LINEAR_FACTORY_TEAM_ID", "085d25a0-104f-4e80-82fb-b0ea7c476b0b")
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

    @property
    def bridge_key(self) -> str:
        return hashlib.sha256(f"{self.id}\0{self.candidate_key}".encode()).hexdigest()


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


def remote_stop_requested() -> None:
    result = subprocess.run(
        ["gh", "issue", "list", "--repo", f"{ORG}/dark-factory", "--state", "open", "--label", "factory:stop", "--limit", "1", "--json", "number"],
        cwd=ROOT, text=True, capture_output=True,
    )
    if result.returncode:
        raise TriageError("remote stop state is unreadable")
    if json.loads(result.stdout):
        raise TriageError("remote factory:stop is present")


def extract(description: str, field: str) -> str:
    pattern = rf"(?im)^\s*[-*]\s*{re.escape(field)}\s*:\s*`?([^`\n]+?)`?\s*$"
    match = re.search(pattern, description or "")
    if not match:
        raise TriageError(f"candidate has no {field}")
    return match.group(1).strip()


def candidate_from(issue: dict[str, Any]) -> Candidate:
    labels = tuple(label["name"] for label in issue["labels"]["nodes"])
    if not {"Candidate", "Queued"}.issubset(labels):
        raise TriageError("candidate lacks Candidate and Queued labels")
    if issue["state"]["name"] != "Todo" or issue["state"]["type"] != "unstarted":
        raise TriageError("candidate is not in Todo")
    candidate_key = extract(issue.get("description") or "", "Candidate key")
    repository = extract(issue.get("description") or "", "Repository target")
    if not re.fullmatch(r"mhoo-os/[A-Za-z0-9_.-]+", repository):
        raise TriageError("repository target must be an explicit mhoo-os/<repository>")
    return Candidate(
        id=issue["id"], identifier=issue["identifier"], title=issue["title"],
        description=issue.get("description") or "", url=issue["url"],
        priority=issue.get("priority") or 3, state_id=issue["state"]["id"],
        state_name=issue["state"]["name"], labels=labels, candidate_key=candidate_key,
        repository=repository,
    )


def marker(candidate: Candidate) -> str:
    return f"<!-- {MARKER} key={candidate.bridge_key} linear={candidate.identifier} candidate={candidate.candidate_key} -->"


def issue_body(candidate: Candidate) -> str:
    return "\n".join((
        marker(candidate), "", "## Factory execution intake", "",
        f"- Linear candidate: [{candidate.identifier}]({candidate.url})",
        f"- Candidate key: `{candidate.candidate_key}`",
        f"- Intake key: `{candidate.bridge_key}`", "",
        "Linear remains the operational queue. This issue is an execution intake only.",
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


def in_progress_state_id() -> str:
    query = "query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }"
    states = graphql(query, {"teamId": TEAM_ID})["workflowStates"]["nodes"]
    matches = [state["id"] for state in states if state["name"] == "In Progress" and state["type"] == "started"]
    if len(matches) != 1:
        raise TriageError("MHOO In Progress state is not uniquely available")
    return matches[0]


def update_linear(candidate: Candidate, github_url: str) -> None:
    mutation = "mutation($issueId: String!, $stateId: String!, $body: String!) { issueUpdate(id: $issueId, input: { stateId: $stateId }) { success } commentCreate(input: { issueId: $issueId, body: $body }) { success } }"
    body = f"Factory intake created one GitHub execution issue: {github_url}\n\nIntake key: `{candidate.bridge_key}`"
    data = graphql(mutation, {"issueId": candidate.id, "stateId": in_progress_state_id(), "body": body})
    if not data["issueUpdate"]["success"] or not data["commentCreate"]["success"]:
        raise TriageError("Linear did not confirm the intake return")


def eligible_issues() -> list[dict[str, Any]]:
    query = """query($teamId: ID!) {
      issues(first: 50, filter: { team: { id: { eq: $teamId } }, state: { type: { eq: \"unstarted\" } } }) {
        nodes { id identifier title description url priority state { id name type } labels { nodes { name } } }
      }
    }"""
    return graphql(query, {"teamId": TEAM_ID})["issues"]["nodes"]


def select(issues: list[dict[str, Any]]) -> Candidate | None:
    candidates: list[Candidate] = []
    for issue in issues:
        try:
            candidates.append(candidate_from(issue))
        except TriageError:
            continue
    candidates.sort(key=lambda item: (item.priority, item.identifier))
    return candidates[0] if candidates else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--fixture", type=Path, help="offline Linear nodes JSON for tests")
    args = parser.parse_args()
    try:
        if (ROOT / ".factory/STOP").exists():
            raise TriageError("local .factory/STOP is present")
        remote_stop_requested()
        issues = json.loads(args.fixture.read_text()) if args.fixture else eligible_issues()
        candidate = select(issues)
        if candidate is None:
            print(json.dumps({"action": "noop", "reason": "no eligible Linear candidate"}))
            return 0
        existing = existing_issue(candidate)
        plan = {"candidate": candidate.identifier, "repository": candidate.repository, "github_execution_issue": existing, "action": "unchanged" if existing else "create"}
        if args.dry_run:
            print(json.dumps(plan, sort_keys=True))
            return 0
        github_url = existing or create_issue(candidate)
        update_linear(candidate, github_url)
        print(json.dumps({**plan, "github_execution_issue": github_url}, sort_keys=True))
        return 0
    except (TriageError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"TRIAGE_STOP: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
