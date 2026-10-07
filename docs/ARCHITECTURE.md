# Architecture

IntentTA is a Daml package that lets a fund issuer approve and fund one investor's redemption, and lets the investor then burn the shares and receive the cash in a single transaction. It is built from three existing pieces and adds only the contracts that tie them together.

| Piece | What it provides | How the kit uses it |
|---|---|---|
| DecMan `governance-core-v1` | `GovernanceRules`: a committee with an N-of-M threshold that executes any `GovernableAction` | The issuer is the governance party. `ApproveRedemptionAction` is a `GovernableAction`, so the stock engine and the stock DecMan confirm and execute endpoints drive it. |
| DA Registry `utility-registry-app-v0` | Instruments, holdings, `AllocationFactory`, `BurnOffer` | The share leg is a Registry burn offer, created by the issuer as registrar and accepted by the investor as holder. |
| Token Standard (CIP-0056) | `AllocationFactory`, `Allocation` interfaces | The cash leg is an allocation: created at approval, executed at settlement, withdrawn at cleanup. The kit touches cash only through these interfaces. |

## Parties

- **Issuer.** The fund. It is the DecMan governance party and the admin (registrar) of the share instrument. It acts only when the committee votes.
- **Committee members.** The members of the issuer's `GovernanceRules` contract, 2-of-3 in the demo. They propose, confirm and execute. The same parties are the policy's *keepers*, who may run housekeeping without a vote.
- **Investor.** Holds shares. Signs the request and completes the settlement. Has no role in governance.
- **Cash admin.** The admin of the cash instrument. It can be a different party from the issuer, as it would be for USDCx, and it is a different party in every test.

## Contracts

All templates below are in `daml/intentta-redemption`. A second, optional package, `daml/intentta-issuer-setup`, holds four governed actions for setting up an issuer that is a decentralized party; it is described in [DECMAN.md](DECMAN.md).

| Template | Signatories | Observers | Purpose |
|---|---|---|---|
| `InvestorIntent` | investor | issuer | The request: `RedemptionTerms` signed by the investor. |
| `ApproveRedemptionAction` | proposer | issuer | DecMan custom action that approves and funds one request. |
| `RevokeRedemptionAction` | proposer | issuer | DecMan custom action that revokes an unused approval. |
| `RedemptionPolicy` | issuer | none | Limits and the running total of reserved cash. |
| `ReservationSlot` | issuer | none | One open reservation, bound to one request. |
| `ApprovedRedemption` | issuer, investor | recipient | The funded, single-use right to redeem. |
| `RedemptionReceipt` | issuer, investor | recipient | Permanent record of a settlement. No choices. |
| `ReservationCleanup` | issuer | none | A cancelled approval's cash, waiting to be withdrawn. |

`RedemptionTerms` carries the issuer, the investor, the exact share and cash instruments, the share quantity, the payout amount, the payout recipient, the investor's deadline and a request id. Every later step compares against this record by value.

## Workflow

### 1. The investor requests

The investor creates an `InvestorIntent`. Nothing moves: no holding is locked or transferred, and the investor can withdraw the request with `InvestorIntent_Cancel`. The request is not a `GovernableAction`, and the investor is neither a member nor an additional proposer of the issuer's rules, so requesting gives no governance rights.

### 2. The issuer approves and reserves cash

A committee member creates an `ApproveRedemptionAction` naming the request and repeating its terms. Members confirm it through `GovernanceRules_ConfirmAction`. Once two have confirmed, any member executes it through `GovernanceRules_ExecuteConfirmedAction`, which runs the action with the issuer's authority.

Execution is one transaction with three steps:

1. `RedemptionPolicy_Reserve` checks the per-redemption limit and the outstanding-reservation cap, computes the approval's expiry as the earlier of the investor's deadline and now plus the policy's maximum lifetime, and creates a `ReservationSlot` for this request.
2. `AllocationFactory_Allocate` on the cash instrument's factory locks the exact payout in an allocation from the issuer to the recipient. Its settlement reference carries the request's contract id. If the result is not a completed allocation, the action aborts.
3. `InvestorIntent_Approve` consumes the request and creates the `ApprovedRedemption`.

If any step fails, none commits and the request stays pending. An `ApprovedRedemption` therefore never exists without its cash reservation.

`InvestorIntent_Approve` validates its inputs itself. It requires a policy-issued slot for exactly this request and these terms, and an allocation that is signed by the cash instrument's admin and matches the terms field by field. Calling it directly, outside the action, does not get around any check.

No relay service is involved. The proposer's tooling submits one command and exits, and each confirmation and the execution are single ledger commands from members.

### 3. The investor completes settlement

The investor exercises `ApprovedRedemption_Redeem`. In one transaction it:

1. checks the approval has not expired and that the allocation still matches the approved terms;
2. exercises `AllocationFactory_OfferBurn` as the issuer, creating a Registry `BurnOffer` for the share quantity;
3. exercises `BurnOffer_Accept` as the investor, burning the shares;
4. exercises `Allocation_ExecuteTransfer`, moving the reserved cash to the recipient;
5. checks that the recipient now holds exactly the payout, unlocked, in holdings signed by the cash instrument's admin;
6. creates the `RedemptionReceipt`.

The issuer's authority is available inside the choice because the issuer signed the `ApprovedRedemption`; the investor's because they control the choice. That pair is exactly what a burn offer plus an allocation transfer need, so no third party has to take part.

If the burn, the transfer or any check fails, the transaction is rejected as a whole: the shares stay with the investor, the cash stays reserved, and the approval stays active for a retry. There is no intermediate state in which the shares have moved to the issuer.

To submit the command, the investor's participant needs a few contracts it is not a stakeholder of: the Registry factories and instrument configurations, and the allocation with the holding it locks. These are passed as disclosed contracts. In production the Registry's off-ledger API serves them; the demo reads them as the instrument's registrar. None of them comes from the committee's tooling, which is why an approved redemption completes with that tooling switched off.

## Cancellation and cleanup

Authorization and cash are tracked on separate contracts.

| Event | Who | Effect on authorization | Effect on cash |
|---|---|---|---|
| `InvestorIntent_Cancel` | investor | request withdrawn | none was reserved |
| `ApprovedRedemption_Cancel` | investor | approval archived at once | still locked; `ReservationCleanup` created |
| `ApprovedRedemption_Expire` | keeper, after the deadline | approval archived | still locked; `ReservationCleanup` created |
| `ApprovedRedemption_Revoke` | issuer, by vote | approval archived | still locked; `ReservationCleanup` created |
| `ReservationCleanup_Release` | keeper | none | allocation withdrawn, cash unlocked, slot released |
| `ReservationCleanup_ReleaseSlotOnly` | keeper | none | slot released when the allocation is already gone |
| `RedemptionPolicy_ReleaseRedeemed` | keeper, with the receipt | none | slot of a settled redemption released |

Cancelling never depends on the cash side succeeding, so an investor can always withdraw their authorization. Every choice on `ApprovedRedemption` is consuming, so redeem, cancel, expire and revoke are mutually exclusive, and when two are submitted at once the ledger commits exactly one.

Keepers act without a vote, but only in ways that cannot move value to anyone but the issuer: they can close an approval that has already expired, withdraw a dead approval's cash back to the issuer, and release budget against a receipt or a cleanup item.

## A reservation is not a payment guarantee

A token-standard allocation can be withdrawn by its sender, and the issuer is the sender. The kit does not pretend otherwise. What it guarantees is the other direction: if the cash is not there at settlement, the shares are not burned. `test_payout_unavailable_does_not_burn` and scenario S2 of the sandbox run withdraw the allocation and then attempt to redeem.

When the issuer is a decentralized party, withdrawing is itself something only the committee can do, through a vote or the keepers' cleanup path. No single member can pull a reservation.

## Known limits

- **One policy state at a time.** A proposal records the policy's contract id and the issuer's cash holdings when it is created. If another approval executes first, those ids are stale and the proposal must be re-created. DecMan's own `TransferProposal` has the same property, for the same reason. Approvals are therefore sequential.
- **One policy per issuer and instrument pair.** The proposer chooses which policy contract a proposal names. The limits are only meaningful if the issuer keeps a single policy; creating one is itself an act of the issuer.
- **The recipient must take part.** A token-standard allocation needs the receiver's authority to execute. When the recipient is not the investor, both must submit the settlement, which on a real network means they share a participant or use a multi-party submission. `test_payout_to_a_separate_recipient` covers the rule.
- **Scope.** One share instrument and one cash instrument per policy. No subscriptions, NAV, KYC or fund accounting.
