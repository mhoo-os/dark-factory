# Mhoo Dark Factory

Cole-style factory tooling for Mhoo OS. Its scheduled intake reads only explicit
MHOO connector candidates from Linear and creates a single linked GitHub execution
issue in the candidate's declared `mhoo-os/<repository>` target.

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

Create a Linear candidate from the MHOO template, place it in `Todo`, and include:

```markdown
* Repository target: `mhoo-os/<repository>`
* Candidate key: `<stable-key>`
```

The factory fails closed when the candidate is ambiguous, the target is outside
`mhoo-os`, the local stop file exists, the Linear credential is unavailable, or the
remote GitHub stop label is present.
