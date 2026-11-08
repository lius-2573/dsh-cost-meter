# New Ollama Pro plans

[简体中文](ollama-pro.md)

This fork builds on upstream v1.9.60. Its quota source ID is `ollama-cloud`, separate from local `ollama` inference. It supports only new monthly USD-credit plans. Legacy session/weekly plans produce an explicit unsupported-plan message, not invented zero balances.

## Setup

1. Create your account's API key at [Ollama API Keys](https://ollama.com/settings/keys).
2. Open Settings → Cost → Quotas and find Ollama Cloud.
3. Save the key through the credential field, enable the source, select placement, and refresh. The credential target is `codingPlans.ollama-cloud`, referencing `OLLAMA_API_KEY`; the host environment variable is also supported.
4. Refresh defaults to five minutes. Manual refreshes reuse results within one minute and respect longer `Retry-After` responses.

Keys stay in the DSH credential store, never the ledger, repository, or browser state. Only the host sends read-only requests to fixed `https://ollama.com` endpoints, with redirects refused. Never put a key in a URL, commit, or chat.

## Meaning of the numbers

- Monthly allowance, remaining included credits, purchased balance, and reset date come from [Balance](https://docs.ollama.com/api/balance.md). Used included credits equal allowance minus remaining credits; zero allowance has no meaningful percentage.
- Costs, requests, and tokens for 24h, 7d, and 30d come from [Cloud usage](https://docs.ollama.com/api/cloud-usage.md). These official windows are not local calendar days/months. Actual boundaries are available in the card, and reporting can be delayed.
- Account usage can include other tools. It is not a DSH session bill and is never added to the local ledger or used to reclassify existing API/Plan calls.
- Missing metrics and failed windows are unavailable, not zero. Transient errors retain last-good balances and their original timestamp with a stale-data warning. Changing credentials or disabling the source clears the old account cache.
- USD values are converted using the current display currency. Purchased credits remain separate and never inflate the monthly quota percentage.

## Installation and maintenance

After the fork tag is pushed:

```sh
dsh plugin --profile web add github:lius-2573/dsh-cost-meter#v1.9.61-ollama.1
```

A tested local `.tgz` package can also be installed using the official DSH CLI. Restart DSH and refresh the existing GUI. To roll back, install `dsh-cost-meter@1.9.60`, restart, and refresh; restore the pre-install snapshot if configuration recovery is needed. Never clear session history or the ledger.

The upstream remote is `upstream`; the feature branch is `feature/ollama-quota`. Merge upstream updates, build and test, then review before deploying a new pinned version. No scheduled synchronization or upstream pull request is created by this addition.
