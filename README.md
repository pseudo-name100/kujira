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

Distribution is **the Drop** (`KujiraDrop`): 20% of supply is locked in a contract and
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
| Liquidity | 55 | Stays with the deployer to pair on a DEX. Burn or lock the LP tokens afterwards. |
| Staking rewards | 15 | Deposited into the Pod, streamed over 180 days |
| Team | 10 | `VestingWallet`: 180-day cliff, then linear over 365 days |
| Airdrop | 20 | Locked in the Drop, released in rounds |

## Running everything from a phone

Everything below runs in GitHub Actions, started from the **Actions** tab on github.com in a
phone browser. The workflows must be on the repository's default branch to show up there.

### One-time setup (Settings on github.com)

1. **Operator wallet.** Create a fresh wallet used only for this, and send it a little ETH on
   Ink (plus Ink Sepolia ETH from a faucet for testing). It deploys the contracts and starts
   airdrop rounds. It never holds the liquidity tokens.
2. **Secrets and variables > Actions > Secrets:** add `PRIVATE_KEY` (the operator wallet's key).
3. **Secrets and variables > Actions > Variables:** add `LIQUIDITY_ADDRESS` (your own wallet,
   receives the 55%) and `TEAM_ADDRESS` (receives the vested 10%).
4. **Pages:** set Source to **GitHub Actions**, then set Custom domain to `kujira.ink` and tick
   **Enforce HTTPS** once it's offered. At the domain registrar, add these DNS records:
   - `A` records for `kujira.ink` (host `@`): `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153`
   - `CNAME` for `www`: `pseudo-name100.github.io`

### Workflows

| Workflow | What it does |
| --- | --- |
| **Deploy** | Runs the tests, deploys to the chosen network (type `DEPLOY` to confirm), saves the addresses to `deployments/`, and verifies the source on the explorer. Refuses to deploy twice to the same network. |
| **Airdrop** | `build-list`: finds Ink DEX routers and traders and builds the round's list. `start-round`: publishes it on-chain. `close-round`: after the deadline, returns unclaimed tokens to the pool. |
| **Claim page** | Rebuilds the claim page whenever deployments or airdrop files change. |
| **Test** | Runs the tests on every push. |

Test on `inkSepolia` first: Deploy, then Airdrop `start-round` for round 1, and claim from
the page with `?network=inkSepolia` added to its URL.

### Claim page

`site/` is a static page that works in wallet apps' built-in browsers. Holders connect, see
whether they're on an open round's list, and tap **Claim** or **Claim & stake**. They can also
stake, withdraw and collect Pod rewards there. The page reads `deployments/<network>.json`
and the `claims.json` of every round started on that network.

## Running locally

```sh
npm install
cp .env.example .env   # add PRIVATE_KEY, TEAM_ADDRESS, LIQUIDITY_ADDRESS
npm test
npm run deploy:ink-sepolia
npx hardhat run scripts/verify.js --network inkSepolia
node scripts/build-site.js   # claim page in _site/
```

Addresses are written to `deployments/<network>.json`.

## Airdrop rounds

Round settings live in `scripts/airdrop/config.js`. Round 1: 80M KUJI reserved (out of the
200M pool), 30-day claim window, +25% for claim-and-stake.

**Who qualifies for round 1:** the 14,981 wallets that made at least 3 successful swaps through
Ink DEX routers on at least 2 different days between 2026-01-01 and 2026-10-25, minus
anything over 5,000 swaps (bots) and the `exclude` list. Every one of them is listed for
81,766 KUJI (`amountEach` in the config).

**First come, first served.** The listed amounts add up to about 1.22B KUJI, but the round
reserves 80M (plus up to 20M for stake bonuses). Payouts stop when the reserve is used up,
which is about the first 980 claims (fewer if claimers take the stake bonus); later claims
fail. The contract can never pay out more than the reserve, and the claim page shows how much
is left.

**Which routers count** is decided from on-chain data rather than a hand-made list.
`discover-routers.js` samples Uniswap v2/v3/v4 and Velodrome swap events across the window,
groups them by the contract the trader called, and keeps contracts that at least 10 different
wallets used (private bot contracts have a handful) and where at least 80% of recent
transactions are swaps (games, bridges and bots do other things too). The result is saved as
`airdrop/round-<n>/routers.json` for review; anything added to `eligibility.routers` counts too.

The steps (the Airdrop workflow runs them for you):

1. `node scripts/airdrop/discover-routers.js 1` writes `routers.json`.
2. `node scripts/airdrop/collect-dex-traders.js 1` reads each router's transactions from Ink's
   explorer and writes `traders.csv`.
3. `node scripts/airdrop/build-round.js 1` writes `allocations.csv` (to review and publish)
   and `claims.json` (Merkle root and each wallet's proof, for the claim page).
4. `ROUND=1 npx hardhat run scripts/airdrop/start-round.js --network ink` publishes the root.
5. After the deadline, `ROUND=1 npx hardhat run scripts/airdrop/close-round.js --network ink`
   returns unclaimed tokens to the pool.

The `airdrop/round-<n>/` files are committed so anyone can check the list against the
on-chain root.

For later rounds, add a block to `config.js` with new criteria (for example Pod stakers,
KUJI holders, or wallets from an X campaign) and announce what triggers it (holder count,
volume, followers) before it happens.

## Launch checklist

1. Deploy on Ink Sepolia, start a test airdrop round, and claim and stake from the page.
2. Deploy on Ink mainnet.
3. From your liquidity wallet, create the KUJI/ETH pool on an Ink DEX.
4. Burn the LP tokens (send them to `0x000000000000000000000000000000000000dEaD`) or lock them
   with a public locker, and post the transaction.
5. Optionally hand Pod and Drop ownership to a multisig (`transferOwnership`, then `acceptOwnership`
   from the multisig) or renounce it once no more reward rounds are planned.
6. Post the contract addresses, verification links, LP burn/lock tx, vesting and airdrop contracts on
   X (@KujiraToken) and the website so people can check everything themselves.

## Notes

- The ticker `KUJI` is already used by the Kujira Cosmos chain's token. Consider a different
  symbol to avoid confusion on aggregators; change it in `KujiraToken.sol`.
- These contracts have tests but no professional audit. Get one before holding significant value.
- Staking rewards and team allocations can raise securities questions in some jurisdictions.
  Talk to a lawyer before marketing yields.
