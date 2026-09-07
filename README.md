# Mhoo Dark Factory

Cole-style factory tooling for Mhoo OS. Its scheduled intake resolves issues through
the human-owned trusted Factory Registry and accepts only entries that contain one explicit Factory Dispatch
Contract v1 block. Deterministic admission validates that contract and, when
the factory is enabled for that stage, creates one linked GitHub execution issue
in the contract's declared `mhoo-os/<repository>` target.

The initial schedule is **triage-only**: it does not edit product code, merge pull
requests, or change repository protection. Target repositories must earn their own
factory configuration and validation gates before they can be dispatched for code work.

## Repository scope and starting point

Source owner: [`mhoo-os/dark-factory`](https://github.com/mhoo-os/dark-factory),
under the human-owned [mission](MISSION.md) and [factory rules](FACTORY_RULES.md).
This repository owns bounded execution machinery for approved Linear contracts.
It does not own product planning, Workspace identity, provider facts, or production
cutover. Start with [AGENTS.md](AGENTS.md) before changing source or running probes.

The documented [autonomy level is 0](FACTORY.md). Source and CI receipts are not
runtime, recovery, containment, or pilot approval. The upstream reusable skill is
preserved separately with its exact revision and license in [UPSTREAM.md](UPSTREAM.md).

### Evidence snapshot — 2026-09-07

Remote default branch `main` was verified at
`db5474c6e0ce7d0ffa361fa16674062bfa3380aa` (PR #30). The following open PRs are
separate source lanes, not merged-main behavior:

| Work | Existing source evidence | Remaining boundary |
| --- | --- | --- |
| [MHO-253](https://linear.app/mhoo/issue/MHO-253), native workflow | [PR #36](https://github.com/mhoo-os/dark-factory/pull/36), `e19f3733fcef4b2b94500d32e174feb14d6514dd`; [PR #37](https://github.com/mhoo-os/dark-factory/pull/37), `084745db851901f8c3d830bc23615add8cf34487` | Paired review and synthetic repair receipts are source proof. Real adapters, executor custody, stopping, accounting and pilot evidence remain separate. |
| [MHO-219](https://linear.app/mhoo/issue/MHO-219), readiness | [PR #35](https://github.com/mhoo-os/dark-factory/pull/35), `e3e489bc4dcf6e0ed396a5961f1935bf5a5e56dd` | Recovery preparation is not remote D1 restore, binding or runtime acceptance. |

PR states and heads were read back for this snapshot; prior CI success is retained
historical evidence, not a new test result. Recheck affected evidence when the head,
base, configuration, environment, acceptance contract or authority changes. Reuse
unchanged receipts rather than rerunning completed work. Historical MHO-199–223
foundation references in the mission are not fresh dispatches. Legacy retirement
[MHO-249](https://linear.app/mhoo/issue/MHO-249) stays with its existing cross-repo
owners; this repository's setup grants no cleanup or migration authority.

### Development commands

Commands below come from [package.json](package.json) and the
[verification workflow](.github/workflows/verify.yml). CI uses Node 24; Python 3
is also required. Run only checks relevant to an authorized change, after reading
its existing evidence. These are command references, not onboarding instructions
to execute everything.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked dependencies when needed. |
| `npm run typecheck` | Generate Wrangler types, then run TypeScript checking; may write generated files. |
| `npm run test:python` | Python unittest suite. |
| `npm run test:sandbox` | Sandbox agent Node tests. |
| `npm run test:contract` | Migration, registry and Worker contract Node tests. |
| `npm run test:worker` | Vitest Worker suite. |
| `npm run test:coverage` | Contract tests and Vitest coverage; used by CI. |
| `npm test` | Combined Python, sandbox, contract and Worker suites. |
| `npm run build` | Wrangler deployment dry run with `--containers-rollout=none`; artifact validation, not publication. |

For an authorized runnable-code change, also follow the constitution's applicable
validation and end-to-end requirements. A documentation-only change needs link,
command-reference and diff review; do not repeat runtime probes to validate prose.

## Operator commands

The following existing operator actions require their own scope and authorization;
setup documentation does not authorize credential storage or timer installation.

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
