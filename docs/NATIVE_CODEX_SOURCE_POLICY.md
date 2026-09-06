# MHO-253 pure native policy packet

This packet depends on PR #32 at `886a59de22ef7e7be7c8550b26db83d66b77b0e8` and is stacked against `feat/MHO-253-native-candidate`. It preserves that head and its canonical attempt, grant, and immutable receipt design. There is no new executor, Worker route, database schema, process launch, credential read, or runtime configuration installation here. Every returned result has `liveExecutionAllowed: false` and `publicationAllowed: false`.

## Launch proposal

`native/launch-policy.mjs` accepts the exact persisted PR #32 `NativeIntent`, its trusted digest, an explicit model, a disposable environment identifier, an empty inherited environment, and an artifact observation. It refuses altered identity, expired or extended deadlines, extra fields, policy drift, mutable paths, symlinks, inherited environment, and mismatched binary observations. It preserves attempt zero and the original deadline; it cannot authorize another attempt.

The discovery pin is Codex 0.145.0, Darwin arm64, SHA-256 `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590`. The proposed content-addressed path is not installed or inspected by this function. No Linux or guest artifact is verified. An observation supplied by a caller is not filesystem attestation, and a digest is not a signature. Production callers must obtain identity, approved model, and artifact facts through trusted control-plane and verifier paths, never candidate output.

`requiredLaunchProfile()` is a declarative acceptance descriptor, **not a valid rendered Codex configuration**. `PROFILE_DIGEST` binds that descriptor, not installed configuration bytes. The proposed argv and environment are inert data. Rendering the permission profile, proving precedence and all tool surfaces, and binding actual config bytes remain future gates. The descriptor excludes legacy sandbox overrides and requires controller credentials to be inaccessible to candidate tools. The proposed `CODEX_HOME` is for a future controller arrangement; its isolation is unproved.

This pure function does not check D1 leases, STOP, cancellation, or current grants. A future authorized adapter must reuse PR #32 `currentNativeGrant` immediately before any launch and preserve existing immutable receipt and no-resend rules. Passing this validator alone never permits launch.

## Synthetic JSONL observations

`native/codex-jsonl.mjs` accepts at most 65,536 bytes, 8,192 bytes per line, and 256 events. The accepted synthetic sequence is `thread.started`, `turn.started`, zero or more `item.*` events, then exactly one terminal event. UTF-8 and JSON must be valid and the last line must end in a newline. Truncation, unknown events, order changes, thread mismatch, duplicate terminals, and trailing events return an ambiguous observation. Raw item bodies and error messages are discarded.

The grammar is a test contract, not a verified complete Codex 0.145.0 event schema. Only synthetic `allowance_exhausted` requests human attention. No output can assign an attempt, commit, permission, or retry. Attempt and request identity come from the trusted caller. Nonnegative safe token counters with cached input no greater than input are marked `OBSERVED`; absent or malformed counters stay `UNKNOWN`. Billing always remains `UNKNOWN`. A `completed` result means only that the bounded transcript contained a completion event; it does not update canonical run state, prove successful work, establish available allowance, or authorize publication.

## Fake-credential acceptance contract

`native/containment-contract.mjs` checks completeness of 20 synthetic receipt cases: credential reads/writes/enumeration, link and path escapes, parent environment/file descriptors/memory, sockets and agents, Docker, management network, repository config, hooks, MCP, file tools, browser connectors, detached descendants, and teardown. Receipts must bind the same disposable environment, intent, profile, and fixed fake-canary digest, with unique case identifiers and evidence digests.

These are labels and validation rules only: no probe or hostile candidate runs. Missing, duplicated, foreign, malformed, or non-synthetic evidence fails the contract. Even all 20 synthetic passes leave containment `UNPROVED`. Evidence digests are opaque references, not proof that tests occurred. Real containment requires an approved disposable environment and independently verified fake-credential probes across every surface, including teardown, before any real credential or candidate is considered.

## Validation and remaining gates

Run `npm run test:native-policy` for the pure tests and a 95% line, branch, and function floor on all three new modules. The existing coverage command includes this suite. The parent packet's mock executor remains separate.

The mock runner and its D1 integration test use a test-only logical deadline clock. Child startup and filesystem latency cannot consume the synthetic two-second attempt window; expiry is advanced explicitly, while grant-monitor, process cleanup, I/O, and test-watchdog timers remain real. Readiness signals synchronize descendant cancellation and expiry and verify SIGKILL after the stubborn fixture installs its SIGTERM handler. A slow-preflight regression exceeds two wall seconds without advancing logical time. Runtime deadline validation, expiry/cancellation enforcement, cleanup limits, and coverage floors are unchanged. The readiness-only fixture edit updates both the runner hash and canonical intent hash together; PR #32 remains the historical parent, and existing immutable receipts are not rewritten.

MHO-253 remains incomplete: host selection/capacity, immutable guest artifact and actual configuration verification, all-surface isolation, auth brokerage, allowance/accounting semantics, current-grant runtime integration, and explicit live-execution authority remain unproved. This packet does not provision a guest, authenticate, query an account, change task permissions, merge, deploy, or enable live execution.
