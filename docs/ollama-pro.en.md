# New Ollama Pro plans

[简体中文](ollama-pro.md)

This local fork integrates upstream v1.9.64 as version 1.9.65-ollama.1. Its quota source ID is `ollama-cloud`, separate from local `ollama` inference. It supports only new monthly USD-credit plans. Legacy session/weekly plans produce an explicit unsupported-plan message, not invented zero balances.

## Setup

1. Create your account's API key at [Ollama API Keys](https://ollama.com/settings/keys).
2. Open Settings → Cost → Quotas and find Ollama Cloud.
3. Save the key through the credential field, enable the source, select placement, and refresh. The credential target is `codingPlans.ollama-cloud`, referencing `OLLAMA_API_KEY`; the host environment variable is also supported.
4. Refresh defaults to five minutes. Manual refreshes reuse results within one minute and respect longer `Retry-After` responses.

Keys stay in the DSH credential store, never the ledger, repository, or browser state. Only the host sends read-only requests to fixed `https://ollama.com` endpoints, with redirects refused. Never put a key in a URL, commit, or chat.

## Meaning of the numbers

- Monthly allowance, remaining included credits, purchased balance, and reset date come from [Balance](https://docs.ollama.com/api/balance.md). Used included credits equal allowance minus remaining credits; zero allowance has no meaningful percentage.
- The sidebar shows the monthly allowance alongside the percentage, such as `$60`, converted using the display currency and exchange rate. Text-only mode keeps the percentage on the left and allowance on the right of the same row. It uses the official value rather than a hard-coded limit and excludes purchased credits. The narrow sidebar retains it in the tooltip.
- Costs, requests, and tokens for 24h, 7d, and 30d come from [Cloud usage](https://docs.ollama.com/api/cloud-usage.md). These official windows are not local calendar days/months. Actual boundaries are available in the card, and reporting can be delayed.
- Account usage can include other tools. It is not a DSH session bill and is never added to the local ledger or used to reclassify existing API/Plan calls.
- Missing metrics and failed windows are unavailable, not zero. Transient errors retain last-good balances and their original timestamp with a stale-data warning. Changing credentials or disabling the source clears the old account cache.
- USD values are converted using the current display currency. Purchased credits remain separate and never inflate the monthly quota percentage.

## Installation and maintenance

Source is maintained on this fork's `feature/ollama-quota` branch, without a new release tag or npm publication. The current deployment uses this verified local archive:

```sh
dsh plugin --profile web add ./dsh-cost-meter-1.9.65-ollama.1.tgz --ignore-scripts
```

Restart DSH and refresh the existing GUI. To roll back, install the pre-update `dsh-cost-meter-1.9.63-ollama.1.tgz`, restart, and refresh. Do not replace it with official 1.9.60 and lose the customizations. Never restore an old ledger over newer activity; restore individual configuration fields only if required.

The upstream remote is `upstream`; the feature branch is `feature/ollama-quota`. Merge upstream updates, build and test, then review before deploying a new pinned version. No scheduled synchronization or upstream pull request is created by this addition.
