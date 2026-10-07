# Safeguards

Each safeguard below names the mechanism that enforces it and the test that tries to break it. Tests are Daml Script scripts in `daml/intentta-redemption-test`. `S1` to `S7` are scenarios of `scripts/e2e.mjs`, on a single-participant Canton sandbox. `D1` to `D4` are scenarios of `scripts/decman/redeem.mjs`, on the four-participant network with DecMan nodes.

A test that expects a rejection for a specific reason asserts on the ledger's error message, so it cannot pass because the command failed for some unrelated reason.

## Attacks through direct contract calls

The tests in `Test/DirectCalls.daml` skip `ApproveRedemptionAction` and the governance engine and call the underlying choices and Registry contracts directly, giving each attacker the strongest authority they could have.

| Threat | Why it fails | Test |
|---|---|---|
| **Cash-only withdrawal.** Take the reserved cash without burning. | Executing an allocation needs the executor's, sender's and receiver's authority. The issuer is executor and sender, and its authority reaches the allocation only from inside `ApprovedRedemption_Redeem`, after the burn. | `test_reserved_cash_cannot_be_taken_without_burning`, S5, D3 |
| **Unauthorized burning.** Burn the investor's shares without them. | `Redeem` is controlled by the investor. A Registry burn offer burns nothing until the holder accepts it, and the Registry's burn/mint factory refuses to burn a holding whose owner is not an actor. | `test_shares_cannot_be_burned_without_the_investor`, S5, D3 |
| **Altered recipient or amount at approval.** Approve the request but fund someone else, or less. | `InvestorIntent_Approve` compares the allocation with the signed terms field by field: executor, sender, receiver, amount, instrument, settlement reference and deadline. | `test_direct_approve_rejects_mismatched_reservations` |
| **Altered terms at the vote.** Get the committee to vote on terms the investor did not sign. | `executeImpl` fetches the request and requires its terms to equal the proposal's. | `test_vote_is_bound_to_the_signed_terms` |
| **Duplicate approvals.** Approve one request twice. | `InvestorIntent_Approve` is consuming; the second execution finds no request. | `test_request_cannot_be_approved_twice` |
| **One reservation, two approvals.** Make an unfunded approval look funded by reusing a reservation or a slot. | The allocation's settlement reference and the slot both carry the request's contract id, which is unique. | `test_reservation_cannot_back_two_requests` |
| **Skipping the policy.** Approve directly without the limits being checked. | `InvestorIntent_Approve` requires a `ReservationSlot` for exactly this request, and only `RedemptionPolicy_Reserve` creates slots for the issuer. | `test_direct_approve_requires_a_policy_slot` |
| **Repeat payouts.** Settle the same approval twice. | `Redeem` is consuming and the allocation is consumed by the transfer. | `test_approval_pays_exactly_once`, S1, D1 |
| **Forged approval or receipt.** | Both need the issuer's and the investor's signatures. Only `InvestorIntent_Approve` and `Redeem` hold both. | `test_approvals_and_receipts_cannot_be_forged` |
| **Look-alike cash contracts.** Hand the investor an allocation or holdings from a contract that imitates the cash instrument. | The allocation at approval and settlement, and the payout holdings after the transfer, must be signed by the cash instrument's admin. | enforced in `checkReservation` and `ApprovedRedemption_Redeem` |
| **Requests in someone else's name.** | The investor is the signatory of `InvestorIntent`. | `test_malformed_requests_are_rejected` |
| **Redirected payout at settlement.** Settle without the named recipient, or as the recipient without the investor. | `Redeem` is controlled by the investor and the recipient together; the terms, including the recipient, are fixed in the approval. | `test_payout_to_a_separate_recipient` |
| **A member acting as the issuer.** | A member holds no authority of the issuer outside a vote; on the DecMan network the issuer is a decentralized party no single participant can sign for. | D3, `test_decentralized_issuer_is_set_up_by_vote` |

## Governance

| Property | Mechanism | Test |
|---|---|---|
| Approval needs 2 of 3 members | DecMan `GovernanceRules_ExecuteConfirmedAction` | `test_one_confirmation_cannot_approve`, `test_duplicate_confirmer_cannot_approve`, S1, D1 (refused by the DecMan node) |
| The investor gets no governance rights | The request is not a `GovernableAction`; the rules reject proposals from, and votes by, non-members | `test_investor_has_no_governance_rights` |
| Revocation needs a vote | `ApprovedRedemption_Revoke` is controlled by the issuer | `test_committee_revokes_approval` |

## Funding, expiry and limits

| Property | Mechanism | Test |
|---|---|---|
| No unfunded approval | The allocation and the approval are created in one transaction; a non-completed allocation aborts it | `test_unfunded_approval_is_rejected` |
| Bounded approval expiry | Expiry is the earlier of the investor's deadline and now plus `maxApprovalTtl`, which no policy can set above 7 days | `test_approval_expiry_is_bounded`, `test_expired_approval_cannot_settle`, S6 |
| Per-redemption limit | `RedemptionPolicy_Reserve` | `test_policy_limits` |
| Outstanding-reservation limit | `RedemptionPolicy_Reserve` against the running total of open slots | `test_policy_limits` |
| Budget is released only against evidence, and only once | Release consumes the slot and requires a matching receipt or a cleanup item | `test_budget_release_needs_evidence` |
| Expired or withdrawn requests cannot be approved | Time check and consumed contract | `test_withdrawn_or_expired_request_cannot_be_approved` |

## Failure, cancellation and retries

| Property | Mechanism | Test |
|---|---|---|
| Payout unavailable: shares are not burned | Burn and transfer are in one transaction | `test_payout_unavailable_does_not_burn`, S2 |
| Burn fails: cash is not paid | Same | `test_failed_burn_does_not_pay_and_retry_succeeds` |
| Safe retries | A failed settlement leaves the approval active and unchanged; a successful one consumes it | `test_failed_burn_does_not_pay_and_retry_succeeds`, `test_bad_settlement_inputs_fail_cleanly` |
| Cancel and redeem are mutually exclusive | Both are consuming choices on the same contract | `test_cancel_then_redeem`, `test_redeem_then_cancel`, S4 (submitted concurrently) |
| Authorization cancellation is separate from cash cleanup | Cancel creates a `ReservationCleanup`; the cash moves only in `ReservationCleanup_Release` | `test_cancel_then_redeem`, S3, D2 (cancelled on the investor's participant, cleaned up from a member's) |
| Only the investor cancels their approval | Controller | `test_only_the_investor_cancels` |

## What is trusted

- **The Registry and token-standard packages.** The kit relies on the Registry to burn the stated amount and on the cash instrument's allocation to move the stated amount. It re-checks the result of the cash leg but takes the burn's amount from the Registry's own validation.
- **The committee, up to the threshold.** Two colluding members can approve a redemption the fund should not pay, as they could approve any other action of the governance party. They cannot change what an investor signed, burn an investor's shares, or pay an investor less than the approval says.
- **The issuer as sender.** It can withdraw a reservation before settlement. The investor then keeps their shares.
- **Keepers.** A keeper can release budget early for an approval that is already dead, which is harmless, and cannot release it for a live one.

Reporting a vulnerability: see [SECURITY.md](../SECURITY.md).
