from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
import unittest

from factory.sandbox import (
    Artifact, CommandSpec, CredentialLease, RuntimeDiff, RuntimeOutput, SandboxAdapter,
    SandboxLost, SandboxOOM, SandboxRequest, SandboxTimeout, Workspace,
)

ROOT = Path(__file__).parents[1]
CASE = json.loads((ROOT / "tests/fixtures/sandbox_cases.json").read_text())["valid"]
BASE = CASE["base_sha"]
HEAD = "f" * 40


def request() -> SandboxRequest:
    return SandboxRequest(
        CASE["dispatch_id"], CASE["run_id"], CASE["repository"], BASE,
        CASE["execution_profile"], CASE["validation_profile"],
        CredentialLease(**CASE["credential"]),
        tuple(CommandSpec(tuple(item["argv"]), item["purpose"], item["timeout_seconds"], item["max_output_bytes"]) for item in CASE["commands"]),
        tuple(CASE["allowed_paths"]), CASE["max_files"], CASE["max_changed_lines"], CASE["now"],
    )


class Runtime:
    def __init__(self, mode: str = "ok"):
        self.mode, self.started, self.executed, self.destroyed = mode, 0, 0, 0

    def start(self, sandbox_id, *, repository, base_sha, credential):
        self.started += 1
        return Workspace(repository, "e" * 40 if self.mode == "identity" else base_sha, HEAD)

    def execute(self, sandbox_id, argv, *, timeout_seconds):
        self.executed += 1
        if self.mode == "timeout":
            raise SandboxTimeout()
        if self.mode == "oom":
            raise SandboxOOM()
        if self.mode == "lost":
            raise SandboxLost()
        if self.mode == "secret":
            return RuntimeOutput("SECRET_TOKEN", "", 0, False)
        if self.mode == "large":
            return RuntimeOutput("x" * 100, "", 0)
        return RuntimeOutput("APP_STARTED\nE2E_PASSED\n", "", 0)

    def diff(self, sandbox_id, *, base_sha):
        if self.mode == "diff-identity":
            return RuntimeDiff("e" * 40, HEAD, ("tests/fixture.py",), 1, "+bad\n")
        if self.mode == "scope":
            return RuntimeDiff(BASE, HEAD, ("secrets.txt",), 1, "+bad\n")
        return RuntimeDiff(BASE, HEAD, ("tests/fixture.py",), 1, "+edited\n")

    def artifacts(self, sandbox_id, *, names):
        return tuple(Artifact(name, "sha256:" + "a" * 64, 1) for name in names)

    def destroy(self, sandbox_id):
        self.destroyed += 1
        if self.mode == "cleanup":
            raise RuntimeError("provider detail must not escape")


class SandboxTests(unittest.TestCase):
    def run_case(self, mode="ok", req=None):
        sink, runtime = [], Runtime(mode)
        return SandboxAdapter(runtime, sink).run(req or request()), runtime, sink

    def test_fixture_covers_edit_test_diff_and_destroy(self):
        receipt, runtime, _ = self.run_case()
        self.assertEqual(receipt.status, "passed")
        self.assertEqual((runtime.started, runtime.executed, runtime.destroyed), (1, 2, 1))
        self.assertEqual(receipt.diff.changed_files, ("tests/fixture.py",))
        self.assertIn("cleanup_completed", [event.event_type for event in receipt.events])

    def test_output_is_bounded_and_digest_bound(self):
        receipt, _, _ = self.run_case("large")
        command = receipt.commands[0]
        self.assertLessEqual(len(command.stdout.encode()), 64)
        self.assertTrue(command.truncated)
        self.assertTrue(command.stdout_digest.startswith("sha256:"))

    def test_timeout_oom_and_loss_are_classified_and_cleaned(self):
        for mode, status in (("timeout", "timed-out"), ("oom", "oom"), ("lost", "sandbox-lost")):
            with self.subTest(mode=mode):
                receipt, runtime, sink = self.run_case(mode)
                self.assertEqual(receipt.status, status)
                self.assertEqual(runtime.destroyed, 1)
                self.assertGreaterEqual(len(sink), 3)

    def test_unredacted_output_is_rejected_without_leaking_it(self):
        receipt, _, sink = self.run_case("secret")
        serialized = json.dumps(receipt.to_dict()) + json.dumps([event.__dict__ for event in sink])
        self.assertEqual(receipt.status, "output-rejected")
        self.assertNotIn("SECRET_TOKEN", serialized)

    def test_identity_scope_command_and_credential_guards_fail_closed(self):
        for mode in ("identity", "diff-identity", "scope"):
            with self.subTest(mode=mode):
                receipt, runtime, _ = self.run_case(mode)
                self.assertEqual(receipt.status, "contract-failed")
                self.assertEqual(runtime.destroyed, 1)
        bad_command = replace(request(), commands=(CommandSpec(("curl", "example.invalid"), "implement", 1, 10),))
        receipt, runtime, _ = self.run_case(req=bad_command)
        self.assertEqual(receipt.status, "contract-rejected")
        self.assertEqual(runtime.started, 0)
        expired = replace(request(), credential=replace(request().credential, expires_at=100))
        self.assertEqual(self.run_case(req=expired)[0].status, "contract-rejected")

    def test_cleanup_failure_is_visible(self):
        receipt, _, _ = self.run_case("cleanup")
        self.assertEqual((receipt.status, receipt.reason, receipt.cleaned_up), ("cleanup-failed", "cleanup_failed", False))


if __name__ == "__main__":
    unittest.main()
