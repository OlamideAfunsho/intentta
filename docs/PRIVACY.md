# Privacy

Canton shares a contract only with its stakeholders, and shares each part of a transaction only with the parties that part concerns. This page says who sees what in a redemption, how that was verified, and what the operators of the participants hosting the issuer can see.

## Who sees what

| Data | Investor | Other investors, outsiders | Issuer | Cash admin | Registry operator |
|---|---|---|---|---|---|
| The request and its terms | yes (signs it) | no | yes | no | no |
| The committee proposal, confirmations, audit record | no | no | yes | no | no |
| The issuer's policy, limits and total reserved | no | no | yes | no | no |
| The approval | yes | no | yes | no | no |
| The reservation slot | as an input when the approval is validated | no | yes | no | no |
| The cash allocation for this payout | yes | no | yes | yes | yes |
| The issuer's other cash holdings | no | no | yes | yes | yes |
| The burn (amount, holder, request id) | yes | no | yes (as registrar) | no | yes |
| The receipt | yes | no | yes | no | no |
| The cleanup after a cancellation | its creation, nothing after | no | yes | the withdrawal | the withdrawal |

Two design choices keep the investor's view this narrow:

- **The cash is reserved before the request is touched.** `ApproveRedemptionAction` creates the allocation in its own part of the transaction and only then exercises the request. The investor is a stakeholder of the request, not of the action, so they see the finished allocation for their own payout but not which of the issuer's holdings funded it, how much change came back, or the policy's running total.
- **Cleanup is the issuer's contract.** `ReservationCleanup` is signed by the issuer alone. The investor sees it being created, because their own cancellation creates it, and nothing after that: not the withdrawal, not the policy update.

The investor does learn the party ids of the keepers, because the approval names who may expire it. They are committee members' party ids, not their votes; the proposal and confirmations are not visible to the investor.

The cash admin, as registrar of the cash instrument, sees every holding and allocation of that instrument. That is the Registry's model and applies to any use of the instrument. It does not see requests, approvals or receipts.

The Registry operator is an observer on the Registry's own contracts. In the recorded run its transaction history contains holdings, allocations, burn offers and executed burns, so it learns that a holder burned an amount under a given reference, and that an allocation was made and executed. It holds none of the kit's contracts: no request, approval, receipt, policy or cleanup item. This is determined by the Registry's templates, not by this kit.

## How it was verified

**Party-scoped queries.** `Test/Privacy.daml` runs a redemption and, at each stage, counts what each party's active contract set contains for every template in the kit and in DecMan's governance. Another investor, an outsider, the cash admin and the registry operator must see none of the kit's contracts. The investor must see their request, then their approval, then their receipt, and never the policy, a slot, a proposal, the rules or the audit record.

**Transaction history on one participant.** Scenario S7 of `scripts/e2e.mjs` reads each party's update stream from the beginning of the ledger, after the other scenarios have run. It asserts that the outsider, the second investor and the registry operator received no event of any kit template; that the cash admin's history contains no kit contract; and that the first investor's history contains no policy, reservation slot, proposal, confirmation, rules or audit contract, even as a witnessed event. The list of templates in each party's history is in `evidence/local-e2e.json`.

**Across participants.** Scenario D4 of `scripts/decman/redeem.mjs` runs on the four-participant network, where the investors and Registry parties are on participant 4 and the issuer is hosted on participants 1 to 3. It reads the full history of every party on participant 4 and of the issuer on participant 2, and asserts:

- participant 4 holds no policy, slot, proposal, confirmation, rules or audit contract, for any party it hosts;
- the second investor, the outsider, the cash admin and the registry operator hold no redemption contract at all;
- participant 2, which hosts the issuer, holds the investors' requests, the approvals, the receipts, the policy, the slots, the cleanup items and the rules.

The last point is the next section, observed and not only reasoned.

## What operators hosting the issuer can see

A participant stores, in clear, every contract and transaction view that any party it hosts is entitled to. Its operator can read all of it.

The issuer is a DecMan decentralized party, hosted on the participant of every committee member. So each committee member's participant operator can see everything the issuer can see:

- every investor's request, with the investor's party id and the full terms;
- every approval, receipt and cleanup item;
- the redemption policy, its limits and the total currently reserved;
- every proposal, confirmation and audit record of the committee;
- the issuer's cash holdings and every allocation made from them;
- as share registrar, every holding of the share instrument, which means every investor's position.

D4 confirms this for the kit's contracts on participant 2. It follows from hosting the issuer and holds for any DecMan-governed party; DecMan's documentation says the same. An issuer that wants fewer operators to see investor positions has to host the governance party on fewer participants, or keep positions with a party the committee does not host.

These operators cannot see anything the issuer is not a party to: an investor's holdings of other instruments, or redemptions with other issuers.

The DecMan node next to each participant adds nothing to this. It reads through the participant's Ledger API as the member and the governance party, and stores its own workflow state and an audit log.

The investor's participant operator sees what the investor sees: their requests, approvals, receipts and holdings, plus the contracts disclosed to them at settlement.

Synchronizer operators (sequencer and mediator) see encrypted payloads and which participants take part in a transaction, not contract contents or amounts.

## What is on the wire at settlement

To submit the settlement, the investor's participant is handed these contracts as explicit disclosures: the share and cash instruments' factories and configurations, the allocation, and the holding the allocation locks. The last one reveals the size of one issuer holding, which equals the payout because the allocation splits the exact amount before locking it.
