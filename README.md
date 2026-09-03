# Mhoo Dark Factory

Cole-style factory tooling for Mhoo OS. Its scheduled intake resolves issues through
the human-owned trusted Factory Registry and accepts only entries that contain one explicit Factory Dispatch
Contract v1 block. Deterministic admission validates that contract and, when
the factory is enabled for that stage, creates one linked GitHub execution issue
in the contract's declared `mhoo-os/<repository>` target.

The initial schedule is **triage-only**: it does not edit product code, merge pull
requests, or change repository protection. Target repositories must earn their own
factory configuration and validation gates before they can be dispatched for code work.

## Operator commands

```bash
# Store the Linear personal API key in the macOS Keychain (never in this repository).
bash factory/store-linear-key.sh

# Inspect one scheduled-tick decision without changing Linear or GitHub.
bash factory/tick.sh --dry-run

# Install/status/remove the 30-minute timer.
bash factory/install-linear-trigger.sh --install
bash factory/install-linear-trigger.sh --status
bash factory/install-linear-trigger.sh --remove
```

Create a Linear candidate in the configured factory project, place it in `Todo` or
`In Progress`, and include exactly one machine-readable contract block:

```text
<!-- mhoo-factory-dispatch:v1 -->
{the complete Factory Dispatch Contract v1 JSON}
<!-- /mhoo-factory-dispatch:v1 -->
```

The factory fails closed when the project/team cannot resolve to exactly one enabled
registry entry, the issue identity is wrong, the contract
is missing or ambiguous, the target/profile is unsupported, the planning snapshot
is stale, the local stop file exists, the Linear credential is unavailable, or a
target repository's remote stop label is present. Admission does not invoke a
model or write to Linear, GitHub, or the execution queue.
