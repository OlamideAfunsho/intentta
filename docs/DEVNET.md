# DevNet

**Not run yet.** Every result in this repository comes from a local network. Nothing here is a DevNet result.

A DevNet run needs access that has not been arranged: a validator node or the use of one, Ledger and Admin API credentials for three committee participants, and DA Registry onboarding for the issuer.

## What the local DecMan network already settles

The run in [DECMAN.md](DECMAN.md) is local, but it is not a simulation of DecMan. It uses DecMan's release image, a decentralized issuer hosted across three participants, and the Canton build and protocol version DecMan targets. So these are no longer open:

- the kit's actions are accepted, confirmed and executed by unmodified DecMan nodes;
- a decentralized issuer, which cannot submit by itself, can be taken from nothing to a settled redemption entirely by vote;
- the settlement works with the investor on a different participant from every committee member;
- the DARs, compiled with SDK 3.4.11, load and run on the newer Canton.

## What only DevNet can show

| | Local DecMan network | DevNet |
|---|---|---|
| Synchronizer | one, in the same container | the global synchronizer, with real latency and traffic fees |
| Registry | the Registry contracts, with a local operator and provider | the DA Registry utility as deployed, with its operator, provider and credential requirements |
| Choice context and disclosures | read on the registrar's participant | the Registry's off-ledger token-standard API |
| Authentication | unsafe shared secret, DecMan `--insecure` | OAuth per participant; DecMan with Keycloak or Auth0 |
| Cash | synthetic TestUSD | synthetic TestUSD; USDCx if available |
| DecMan signing | owner keys exported from the participant | the same, or KMS |

## Steps

1. Confirm access and which Registry operator and provider parties serve DevNet.
2. Compare the package ids of `utility-registry-app-v0`, `utility-registry-holding-v0` and the `splice-api-token-*` packages vetted on DevNet with the ones pinned in `daml/dars/SHA256SUMS`. If DevNet runs a newer Registry, rebuild against it and re-run the tests first.
3. Three DecMan nodes, onboard the issuer, deploy `GovernanceRules`. This is `scripts/decman/onboard.mjs` and `govern.mjs` with real endpoints and credentials.
4. Onboard the issuer as registrar. `intentta-issuer-setup` does this by vote against a provider that has no credential requirements; DevNet's provider will have some, and DecMan's own `governance-utility-onboarding` package may be the better fit there.
5. Distribute the DARs with DecMan's `POST /dars/distribute`.
6. Launch the fund, issue shares, fund the treasury, run a redemption, and run the failure, cancellation and replay cases.

## Evidence to record

For each step: the update id, synchronizer id and record time, and the participant that submitted it. For the settlement, the exercised choices under one update id. Party-scoped history from the investor's participant and from a committee member's. It will be added as `evidence/devnet-e2e.json` in the same format as the local files.

## Open questions

- **Registry choice context.** Locally the context for a burn offer and for executing an allocation is built from known contract ids. On DevNet it has to come from the Registry's API, and the endpoints for those two operations need to be confirmed with the Registry operator.
- **Credential requirements.** The local instruments have none. A DevNet instrument may require holder or issuer credentials. The kit passes through whatever context it is given, but that path is untested.
- **USDCx.** The cash leg uses only the token-standard `AllocationFactory` and `Allocation` interfaces. An instrument that completes an allocation in one step should work; one that returns a pending allocation instruction is rejected at approval, by design. Untested against USDCx.
- **Traffic.** The approval transaction is large: it touches the rules, two confirmations, the policy, holdings, the allocation and the request. Its cost on the global synchronizer has not been measured.
