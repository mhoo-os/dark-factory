# Mhoo Dark Factory conventions

This repository is the reference implementation for a bounded, multi-repository
factory. It does not own product planning, Workspace authority, provider facts, or
production cutover.

## Stack and commands

The implementation uses Python 3 and POSIX shell with no third-party runtime
dependency. Run:

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile factory/*.py
bash factory/tick.sh --dry-run
```

The dry run must not create or update a Linear issue, GitHub issue, branch, pull
request, or deployment.

## Where things live

| path | purpose |
|---|---|
| `factory/` | deterministic intake, state, dispatch, and validation machinery |
| `tests/` | unit and contract fixtures; new coverage belongs here |
| `.factory/` | local stop state, locks, decisions, and redacted evidence |
| `MISSION.md`, `FACTORY.md`, `FACTORY_RULES.md` | human-owned governance |

The dispatch contract is parsed and digested by `factory/dispatch_contract.py`;
admission and scheduling must consume its normalized result rather than re-reading
free-form issue prose.

## Code style

- Prefer small pure functions with explicit return values and fail-closed errors.
- Keep provider payloads untrusted; never log tokens, credentials, or raw restricted
  bodies.
- Use stable identifiers and canonical serialization for cross-process state.
- Explain a non-obvious safety rule at the point where it is enforced.

## Tests and dependencies

Every behavior change needs a focused fixture or regression test. Tests must cover
both the positive path and the relevant refusal or recovery path. The standard
library is the dependency policy; a new dependency requires a human-reviewed
justification and maintenance evidence.

Product scope belongs in `MISSION.md`. Unsupervised process rules belong in
`FACTORY_RULES.md`. Neither may be changed by an autonomous factory run.
