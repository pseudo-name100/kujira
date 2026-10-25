# Kujira (KUJI)

> For a long time, the surface looked still. Something has been growing in the deep. 🐋

KUJI is a meme token on [Ink](https://inkonchain.com), Kraken's OP Stack L2. What makes it
better than most memecoins is that the rug-pull levers are missing from the code:

| Common memecoin risk | KUJI |
| --- | --- |
| Owner can mint more | No owner, no mint function. 1,000,000,000 KUJI minted once at deploy. |
| Hidden buy/sell tax | None. Transfers move the exact amount. |
| Blacklist / pause / "anti-bot" switches | None. |
| Upgradeable proxy that can be swapped | Not upgradeable. |
| Team dumps on day one | Team share sits in a vesting contract (cliff, then linear). |
| "Staking APY" paid by printing tokens | Rewards come only from a pool deposited up front. |

The utility is **the Pod** (`KujiraPod`): stake KUJI, earn KUJI. The owner can only add
rewards; it cannot touch staked tokens or rewards already deposited, and stakers can
withdraw whenever they want.

Distribution is **the Drop** (`KujiraDrop`): 10% of supply is locked in a contract and
released in small claim-based airdrop rounds as the project grows. Round 1 goes to Ink DEX
traders.

## Contracts

- `contracts/KujiraToken.sol`: ERC-20 with burn and ERC-2612 `permit` (gasless approvals). Fixed supply, no owner.
- `contracts/KujiraPod.sol`: staking. `fundRewards(amount, duration)` streams a deposit
  linearly to stakers in proportion to their stake. A new deposit before a period ends rolls
  the unstreamed remainder into the new period. If nobody is staked, the stream pauses
  instead of stranding the rewards. `recoverERC20` can rescue other tokens sent by mistake,
  never KUJI.
- `contracts/KujiraDrop.sol`: airdrop pool. The owner starts rounds by publishing a Merkle
  root of (wallet, amount) plus a claim deadline; the round's total is reserved from the pool
  and can't exceed what's free. Claimers either `claim` the tokens or `claimAndStake` them
  into the Pod for a bonus (+25% by default, capped at +100%). After the deadline anyone can
  `closeRound` to return unclaimed tokens to the pool. The owner can burn unreserved pool
  tokens but can never withdraw them.
- OpenZeppelin `VestingWallet`: holds the team allocation.

Default split (edit `scripts/tokenomics.js` before deploying):

| Bucket | % | Where it goes |
| --- | --- | --- |
| Liquidity | 65 | Stays with the deployer to pair on a DEX. Burn or lock the LP tokens afterwards. |
| Staking rewards | 15 | Deposited into the Pod, streamed over 180 days |
| Team | 10 | `VestingWallet`: 180-day cliff, then linear over 365 days |
| Airdrop | 10 | Locked in the Drop, released in rounds |

## Setup

```sh
npm install
cp .env.example .env   # add PRIVATE_KEY and TEAM_ADDRESS
npm test
```

## Deploy

Test on Ink Sepolia first (chain 763373). You need Sepolia ETH bridged to Ink Sepolia for gas.

```sh
npm run deploy:ink-sepolia
```

Then mainnet (chain 57073):

```sh
npm run deploy:ink
```

Addresses are written to `deployments/<network>.json`. Verify the source on Ink's Blockscout
explorer so anyone can read it:

```sh
npx hardhat verify --network ink <KujiraToken> <deployer>
npx hardhat verify --network ink <KujiraPod> <KujiraToken> <deployer>
npx hardhat verify --network ink <KujiraDrop> <KujiraPod> <deployer>
npx hardhat verify --network ink <VestingWallet> <TEAM_ADDRESS> <start> <duration>
```

## Airdrop rounds

Round settings live in `scripts/airdrop/config.js`. Round 1 defaults: 10M KUJI (a tenth of
the pool), 30-day claim window, +25% for claim-and-stake.

**Who qualifies for round 1:** wallets (not contracts) that sent at least 3 successful swaps
to the listed Ink DEX routers on at least 2 different days in the window, minus anything
over 5,000 swaps (bots) and the `exclude` list. Each wallet's share is weighted by active
days, capped at 10, so habitual traders get more but whales can't take the whole round.

1. Put the Ink DEX router addresses in `eligibility.routers`, taken from each DEX's own
   docs and checked on explorer.inkonchain.com. Add your own wallets to `exclude`.
2. `node scripts/airdrop/collect-dex-traders.js 1` reads Ink's explorer and writes
   `airdrop/round-1/traders.csv`.
3. `node scripts/airdrop/build-round.js 1` writes `allocations.csv` (to review and publish)
   and `claims.json` (Merkle root and each wallet's proof, for the claim page).
4. `ROUND=1 npx hardhat run scripts/airdrop/start-round.js --network ink` publishes the root.
5. Commit the `airdrop/round-1/` files so anyone can check the list against the on-chain root.
6. After the deadline, call `closeRound(0)` to return unclaimed tokens to the pool.

For later rounds, add a block to `config.js` with new criteria (for example Pod stakers,
KUJI holders, or wallets from an X campaign) and announce what triggers it (holder count,
volume, followers) before it happens.

## Launch checklist

1. Deploy and verify all contracts on Ink Sepolia, then stake, run a test airdrop round,
   and claim from a second wallet.
2. Deploy and verify on mainnet.
3. Create the KUJI/ETH pool on an Ink DEX with the liquidity allocation.
4. Burn the LP tokens (send them to `0x000000000000000000000000000000000000dEaD`) or lock them
   with a public locker, and post the transaction.
5. Optionally hand Pod and Drop ownership to a multisig (`transferOwnership`, then `acceptOwnership`
   from the multisig) or renounce it once no more reward rounds are planned.
6. Post the contract addresses, verification links, LP burn/lock tx, vesting and airdrop contracts on
   X (@KujiraToken) and the website so people can check everything themselves.

## Notes

- The ticker `KUJI` is already used by the Kujira Cosmos chain's token. Consider a different
  symbol to avoid confusion on aggregators; change it in `KujiraToken.sol`.
- Holders need a claim page (connect wallet, look up the proof in `claims.json`, call
  `claim` or `claimAndStake`). It isn't built yet.
- These contracts have tests but no professional audit. Get one before holding significant value.
- Staking rewards and team allocations can raise securities questions in some jurisdictions.
  Talk to a lawyer before marketing yields.
