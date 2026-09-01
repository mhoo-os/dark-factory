# Factory conversation trajectory audit
`factory/conversation_trajectory.py` provides redacted, provider-neutral Tier 1
checks and deterministic Tier 2 sampling bound to the exact policy digests.
Raw content, private reasoning, arguments, and tool output are rejected; results
are observer-only and cannot route, approve, merge, change state, or enable autonomy.
