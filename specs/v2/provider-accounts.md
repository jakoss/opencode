# V2 Provider Account Selection

Status: **Proposed.** Design is open for review on [issue #51152](https://github.com/anomalyco/opencode/issues/51152). Nothing here is implemented yet.

## Purpose

A user may connect several accounts to one provider, including several GitHub Copilot accounts, and switch the active one. V2 already stores multiple credentials per integration and tracks one globally active credential. The missing capability is binding an account to a project through `opencode.json` or `opencode.jsonc`, so a work project uses its work account while a personal project uses its personal account, including when both have sessions running concurrently.

This is account selection. Multi-account credential storage already exists in Core `Credential` and is not re-specified here.

## Configuration Names An Account, Never A Token

A project binds an account with one field on a provider:

```jsonc
{
  "providers": {
    "github-copilot": {
      "account": "work",
    },
  },
}
```

The value is a locally stored account label. Configuration never carries a token, key, or refresh value. A committed project file stays shareable and contains nothing secret.

A label is portable where a credential ID is not. Credential IDs are machine-local, so a config naming one is meaningless on a teammate's machine. Labels are user-facing and already surfaced by `opencode auth` output.

Provider configuration folds in document order, and project documents fold after global ones, so a project file overrides a global binding for the same provider without any merge change. Core's `ConfigProviderPlugin` copies the field onto `Provider.Info`; the provider value is the only place downstream code reads it from, because `ModelResolver` depends on `Provider` and deliberately does not depend on `Config`.

## A Missing Or Ambiguous Account Fails

Resolution matches the configured label against the stored credentials for that provider's integration, case-insensitively. A unique match selects that credential. No match and more than one match are both failures.

There is no fallback to the active account. Silently using a different account spends the wrong Copilot entitlement, which is worse than a request that does not start. The failure names the provider, the configured label, the labels that do exist, and how to fix it, so the user can see which account is missing without reading source.

The same rule covers an account that was removed or renamed after the binding was written. Labels are not unique at write time and carry no rename history, so a rename breaks the binding loudly instead of quietly retargeting it. That is the intended trade.

## Selection Is Per Location, Not Global

Activation stays global and user-driven. Opening a project does not activate a credential, because global activation cannot express two concurrent projects on two accounts, and a second project would steal the first one's account mid-run.

Selection is therefore Location-scoped. Every Location resolves its own connection for the provider it is bound to, and two Locations bound to different accounts resolve different credentials for the same provider ID without coordinating. An unbound project uses the globally active account, which is today's behavior unchanged.

One selection point serves every request in that Location. The agent step, title generation, and compaction all resolve through `SessionRunnerModel` into `ModelResolver`, so they cannot disagree about which account is in use.

## Discovery Follows The Selected Account

Selecting a credential is not enough. Plugins that derive provider state from a connection must derive it from the Location's selected connection, not the globally active one.

GitHub Copilot is the case that makes this mandatory. Its model list, its endpoint, and the token used for free utility models all come from the OAuth credential. Its endpoint is per-credential, because `copilotBaseURL` reads `metadata.apiEndpoint` or `metadata.enterpriseUrl`, so a personal account and a GitHub Enterprise work account resolve different base URLs. A work project that discovered models through the personal account would send personal-issued requests to the wrong endpoint, or fail to reach it at all.

Provider availability must follow the same rule. Core drops a provider whose discovered state was produced by a connection that is no longer the one in use, so that one account's discovered endpoints and models are never combined with another's. The comparison is against the connection this Location uses. Comparing against the global active connection would drop a bound project's provider every time the user switched accounts elsewhere, and a bound project would lose its discovered models on any global switch.

Discovery re-runs when the selected account changes: the account's own refresh, removal, or replacement, and an edit to the project's binding. A config reload re-runs integration and provider registration but not plugin discovery, so a binding changed in configuration needs its own trigger or a project keeps using the account it was bound to before the edit.

## OAuth Refresh Applies To The Selected Account

Resolving a bound connection refreshes it exactly as an active connection is refreshed. Refresh is a property of resolving a credential, not of being active, so a work project's work credential refreshes on expiry without any change to global state. Refresh failures surface against the selected account.

## Boundaries

Stale provider session state after a mid-session auth switch is a separate concern from account selection. Selection decides which credential a request uses; it does not decide how long a provider keeps state that a new credential may not be entitled to reuse. That interaction is tracked on [issue #31236](https://github.com/anomalyco/opencode/issues/31236) and is not resolved here.

## Laws

- **Named, not embedded:** a binding names a locally stored account. Configuration never carries a token.
- **Exact or fail:** a configured account resolves to exactly one credential, or the request fails with an actionable error. It never falls back to another account.
- **Per-Location selection:** a Location selects its own account. Selection never changes global activation.
- **Unbound means active:** a provider with no binding uses the globally active account, exactly as before.
- **One selection per request:** every request in a Location, including titles and compaction, uses the same selected account.
- **Discovery coherence:** provider state discovered through one account is used only while that account is the one selected.
- **Refresh by selection:** an OAuth credential refreshes because it was selected, not because it is active.
