# Factory GitHub App authentication

The source now requests repository-scoped installation tokens instead of using
GITHUB_TOKEN. No personal-token fallback is supported. Configure GITHUB_APP_ID,
GITHUB_APP_INSTALLATION_ID, GITHUB_APP_REPOSITORY and GITHUB_APP_PRIVATE_KEY
(PKCS8 PEM) through the existing secret-management path. Never commit the key.
Tokens are requested per operation, expire within GitHub's returned lifetime,
and are not persisted. Long-running operations may need a fresh token on retry.

The registered Mhoo Factory Executor App is installed only on mhoo-os/dark-factory.
It has contents/pull_requests write and checks/statuses/metadata read. It has no
administration permission and is not in the protected-main push allowlist.
Branch protection, not the contents permission alone, excludes merges to main.

Live App authentication and repository scope were verified separately. This
source change is not deployed. A bot-authored PR and negative protected-main test
are still required before declaring the publication path operational. Do not
remove or weaken protections to make tests pass. Existing owner-authored PRs
remain owner-authored.

This does not wire the subscription-backed implementation executor: the legacy
OpenRouter credential profile remains in source and must stay disabled until a
separately verified execution path is selected. Factory activation is unchanged.
