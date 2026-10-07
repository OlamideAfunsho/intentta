# DecMan integration

The kit plugs into the Decentralization Manager at one extension point, the `GovernableAction` interface. Nothing in DecMan is changed.

## What is reused

- **`governance-core-v1-0.1.0.dar`**, DecMan's released governance engine. The issuer's `GovernanceRules` contract holds the committee and the threshold.
- **`governance-action-v1-0.1.0.dar`**, the `GovernableAction` interface. It is the kit's only build-time dependency on DecMan.
- **The DecMan node**, release image `v1.13.0`: onboarding of the decentralized party, the multi-party signing workflow that deploys the rules contract, the `/governance/confirm` and `/governance/execute` endpoints, and the UI.

## What is added

In the kit, two actions (`IntentTA.Redemption.Action`):

| Template | Label | When executed |
|---|---|---|
| `ApproveRedemptionAction` | `ApproveRedemption` | Opens a policy slot, reserves the payout, consumes the request, creates the `ApprovedRedemption`. |
| `RevokeRedemptionAction` | `RevokeRedemption` | Archives an unused approval and creates its cleanup item. |

In a separate package, `intentta-issuer-setup`, four actions that set up an issuer which is a decentralized party. Such a party cannot submit a command by itself, so everything it does before the first redemption also has to be voted:

| Template | Label | When executed |
|---|---|---|
| `RequestRegistrarServiceAction` | `RequestRegistrarService` | Asks a Registry provider to onboard the issuer as registrar. |
| `LaunchFundAction` | `LaunchFund` | Creates the share instrument and the redemption policy. |
| `OfferSharesAction` | `OfferShares` | Offers newly issued shares to a holder. |
| `AcceptCashAction` | `AcceptCash` | Accepts cash its registrar has offered to the treasury. |

All six follow DecMan's conventions for custom templates: the proposer is the only signatory, the governance party observes, and `executeImpl` needs no authority beyond those two.

The `description` of an `ApproveRedemptionAction` spells out the terms, so DecMan shows them to members before they confirm and records them in the audit trail:

```
Approve redemption DM-001: burn 100.0 FUNDSHARE held by 'investor::1220…'
and pay 100.0 TESTUSD to 'investor::1220…', valid until 2026-10-08T01:19:09Z
```

## The DecMan network

`scripts/decman/` brings up, on one machine:

| | |
|---|---|
| Canton | one synchronizer, four participants, in one container. The build is the one in Splice 0.6.12, which is what DecMan v1.13 is tested against. |
| Participants 1 to 3 | one per committee member. Together they host the issuer. |
| Participant 4 | the investors, the registry operator and the cash admin. |
| DecMan | three nodes, one per committee participant, in `--insecure` mode for local use. UIs on ports 8081 to 8083. |

```bash
sh scripts/decman/up.sh
```

does the following, each step through the DecMan API:

1. Connects the three nodes as peers.
2. Onboards `fund-issuer` as a decentralized party: node 1 proposes, nodes 2 and 3 accept. The result has three owner keys, threshold two, and confirmation permission on three participants.
3. Uploads the DARs, allocates one member party per participant, and deploys `GovernanceRules` (three members, threshold two) through DecMan's `/contracts` signing workflow.
4. Sets up the fund by vote: registrar onboarding, fund launch, share issuance to two investors, and delivery of 1000 TESTUSD to the treasury. Each is proposed by member 1, confirmed on nodes 1 and 2, executed on node 3.

Then

```bash
node scripts/decman/redeem.mjs
```

runs the redemption scenarios and writes `evidence/decman-e2e.json`.

## The calls

Proposing is a plain `create` by the member on their own participant (DecMan's "Path B").

Confirming, on each confirming member's node:

```bash
curl -X POST http://localhost:8081/governance/confirm -H 'Content-Type: application/json' -d '{
  "party_id": "fund-issuer::1220…",
  "rules_contract_id": "00cc…",
  "action": {"type": "governance_set_threshold", "new_threshold": 2},
  "governance_type": "core_domain",
  "proposal_cid": "00a7…"
}'
```

Executing, on any member's node:

```bash
curl -X POST http://localhost:8083/governance/execute -H 'Content-Type: application/json' -d '{
  "party_id": "fund-issuer::1220…",
  "rules_contract_id": "00cc…",
  "action": {"type": "governance_set_threshold", "new_threshold": 2},
  "governance_type": "core_domain",
  "proposal_cid": "00a7…",
  "confirmation_cids": ["00e9…", "00b0…"],
  "disclosed_contracts": [{"contract_id": "…", "blob": "…"}]
}'
```

Two things here differ from what DecMan's guide for custom templates says, and cost some time to find:

- **The `action` placeholder.** For `core_domain` the field is required by the schema and then ignored. The guide shows `{"type": "generic_vote", …}`; v1.13 rejects that variant on these endpoints. Any accepted variant works, and the scripts send a `governance_set_threshold` that is never applied.
- **Disclosed contracts.** `executeImpl` uses the cash instrument's allocation factory and configuration, which the issuer is not a stakeholder of. DecMan fetches Registry context by itself only for its built-in transfer proposals, so the caller passes the blobs. The scripts read them on the cash admin's participant.

## What the UI shows

The party page of each node shows the issuer's owners and threshold, the rules contract and its members, the hosting participants, the treasury holding, and an audit trail in which every `ApproveRedemptionAction` appears as proposed, confirmed twice and executed.

Confirmation and execution of the redemption actions were done through the REST endpoints, not by clicking in the UI. Execution needs the disclosed contracts above, which the UI has no way to supply for a custom action; DecMan's own end-to-end suite notes the same limit for its Registry flows.

## Version notes

- DecMan v1.13.0 is built for Canton protocol version 35. The Canton in Daml SDK 3.4.11 speaks 34, and DecMan's key export fails against it with a protobuf error. The network therefore runs the Canton build from Splice 0.6.12. The kit's DARs are compiled with SDK 3.4.11 and load on it unchanged.
- DecMan signs with the owner keys held by each participant. Canton exposes those only with `features.enable-preview-commands`, and DecMan's token carries no expiry, so `ledger-api.max-token-lifetime` is unbounded. Both are set in `scripts/decman/canton.conf`, with the unsafe shared-secret auth that `--insecure` expects. None of this is suitable outside a throwaway local network.

## The single-participant sandbox

The sandbox demo (`scripts/localnet.sh`, `scripts/committee.mjs`) does not run DecMan nodes. There the issuer is an ordinary party and the script submits the same two ledger commands a DecMan node submits, `GovernanceRules_ConfirmAction` and `GovernanceRules_ExecuteConfirmedAction`, on the same rules contract. It exists because it starts in a minute and needs no Docker.
