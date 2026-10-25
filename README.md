# Kujira (KUJI)

> For a long time, the surface looked still. Something has been growing in the deep. 🐋

KUJI is a whale-incentive memecoin on [Ink](https://inkonchain.com), Kraken's OP Stack L2,
launched Ryoshi's way: no team tokens, liquidity burned or locked, everything else to holders.
The rug-pull levers are missing from the code:

| Common memecoin risk | KUJI |
| --- | --- |
| Owner can mint more | No owner, no mint function. 1,000,000,000 KUJI minted once at deploy. |
| Hidden buy/sell tax | None. Transfers move the exact amount. |
| Blacklist / pause / "anti-bot" switches | None. |
| Upgradeable proxy that can be swapped | Not upgradeable. |
| Team dumps on day one | There is no team allocation. |
| "Staking APY" paid by printing tokens | Rewards come only from a pool deposited up front. |

**Whale incentives.** The Pod pays bigger stakes and longer stays more, up to 2.5x, and the
Drop can run whale-only rounds for large holders. Whales are paid to stay rather than dump.

The utility is **the Pod** (`KujiraPod`): stake KUJI, earn KUJI. The owner can only add
rewards; it cannot touch staked tokens or rewards already deposited, and stakers can
withdraw whenever they want.

Distribution is **the Drop** (`KujiraDrop`): 25% of supply is locked in a contract and
released in claim-based airdrop rounds as the project grows. Round 1 goes to Ink DEX traders.

## Contracts

- `contracts/KujiraToken.sol`: ERC-20 with burn and ERC-2612 `permit` (gasless approvals). Fixed supply, no owner.
- `contracts/KujiraPod.sol`: staking with whale boosts. `fundRewards(amount, duration)` streams
  a deposit linearly to stakers in proportion to their *boosted* stake:

  | Boost | On top of 1x |
  | --- | --- |
  | Stake of 100,000+ / 1,000,000+ / 10,000,000+ KUJI | +0.10x / +0.25x / +0.50x |
  | Every 30 days staked, up to 120 days | +0.25x each, +1.00x max |

  So the most a stake earns is 2.5x. Topping up blends the stake's start time by amount (a
  small early stake can't lend its age to a big later one); withdrawing anything restarts it.
  The time boost is applied when the stake changes or when anyone calls `poke(account)`, which
  can only raise it; the site shows a "Refresh boost" button when one is due. A new deposit
  before a period ends rolls the unstreamed remainder in; if nobody is staked, the stream
  pauses instead of stranding rewards. `recoverERC20` can rescue other tokens, never KUJI.
- `contracts/KujiraDrop.sol`: airdrop pool. The owner starts rounds by publishing a Merkle
  root of (wallet, amount) plus a claim deadline; the round's total is reserved from the pool
  and can't exceed what's free. Claimers either `claim` the tokens or `claimAndStake` them
  into the Pod for a bonus (+25% by default, capped at +100%). After the deadline anyone can
  `closeRound` to return unclaimed tokens to the pool. The owner can burn unreserved pool
  tokens but can never withdraw them.

Split (edit `scripts/tokenomics.js` before deploying):

| Bucket | % | Where it goes |
| --- | --- | --- |
| Liquidity | 55 | Sent to `LIQUIDITY_ADDRESS` to pair on a DEX. Burn the LP tokens afterwards. |
| Pod rewards | 20 | Deposited into the Pod, streamed over 180 days |
| The Drop | 25 | Locked in the Drop, released in rounds |
| Team | 0 | None, Ryoshi's way |

## Running everything from a phone

Everything below runs in GitHub Actions, started from the **Actions** tab on github.com in a
phone browser. The workflows must be on the repository's default branch to show up there.

### One-time setup (Settings on github.com)

1. **Operator wallet.** Create a fresh wallet used only for this, and send it a little ETH on
   Ink (plus Ink Sepolia ETH from a faucet for testing). It deploys the contracts and starts
   airdrop rounds. It never holds the liquidity tokens.
2. **Secrets and variables > Actions > Secrets:** add `PRIVATE_KEY` (the operator wallet's key).
3. **Secrets and variables > Actions > Variables:** add `LIQUIDITY_ADDRESS` (your own wallet,
   receives the 55% to pair on a DEX).
4. **Pages:** set Source to **GitHub Actions**, then set Custom domain to `kujira.ink` and tick
   **Enforce HTTPS** once it's offered. At the domain registrar, add these DNS records:
   - `A` records for `kujira.ink` (host `@`): `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153`
   - `CNAME` for `www`: `pseudo-name100.github.io`
5. **Privy login (optional, recommended).** At dashboard.privy.io create an app, then:
   - Login methods: turn on **Wallet**, **Email** and **X (Twitter)**.
   - Allowed domains: add `https://kujira.ink`.
   - Copy the App ID into `site/config.json` (`"privyAppId": "..."`), editable on github.com.

   Without an App ID the site uses the browser's wallet, which doesn't work in X's in-app
   browser; with Privy, visitors can connect any wallet (including mobile wallets through
   WalletConnect) or sign in with email or X and get a wallet made for them.

### Workflows

| Workflow | What it does |
| --- | --- |
| **Deploy** | Runs the tests, deploys to the chosen network (type `DEPLOY` to confirm), saves the addresses to `deployments/`, and verifies the source on the explorer. Refuses to deploy twice to the same network. |
| **Airdrop** | `build-list`: finds Ink DEX routers and traders and builds the round's list. `start-round`: publishes it on-chain. `close-round`: after the deadline, returns unclaimed tokens to the pool. |
| **Claim page** | Rebuilds the claim page whenever deployments or airdrop files change. |
| **Test** | Runs the tests on every push. |

Test on `inkSepolia` first: Deploy, then Airdrop `start-round` for round 1, and claim from
the page with `?network=inkSepolia` added to its URL.

### The site (kujira.ink)

`site/` is a static page. Wallet connection goes through Privy (`wallet/`, bundled by
`scripts/build-site.js` and loaded only when someone taps Connect), falling back to the
browser's wallet if Privy isn't configured or can't be reached.

- **The Dive.** Scrolling is a descent: the water darkens from surface blue to black, a depth
  gauge reads the zone (Twilight, Midnight, Abyss, Hadal), marine snow drifts down and turns
  bioluminescent in the abyss (`site/dive.js`).
- **Whale song.** Tapping the whale plays a song synthesized in the browser (no audio file).
- **Sonar.** Live stats once launched: holders (from the explorer), KUJI staked, and how much
  of the Drop is claimed. Refreshes every 30 seconds.
- **Drop checker.** Anyone can paste an address to see if it's on a round's list, before or
  after launch, and make a share card for X.
- **Rank.** A connected wallet is ranked by KUJI held in the wallet plus the Pod: Krill (any),
  Fish (10,000+), Dolphin (100,000+), Orca (1,000,000+), Kujira (10,000,000+), with a share card.
- **Claim and stake.** Claim or claim-and-stake open rounds, and stake, withdraw or collect Pod
  rewards. The Pod panel shows your boost, when the next time step arrives, and a "Refresh
  boost" button when a higher boost is waiting to be applied.

The page reads `data/site.json` (token split, every airdrop list) and, after launch,
`data/<network>.json` (contracts and started rounds), both built from `deployments/` and
`airdrop/` by `scripts/build-site.js`.

## Running locally

```sh
npm install
cp .env.example .env   # add PRIVATE_KEY, LIQUIDITY_ADDRESS
npm ci --prefix wallet # Privy login bundle for the site
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

**Whale-only rounds** (`source: "kuji-holders"`, round 2 in the config is an example) snapshot
every holder's wallet balance plus Pod stake (`collect-kuji-holders.js`), leaving out contracts,
the burn address and the liquidity wallet. Holders at or above `minHeld` (1,000,000 KUJI, Orca
size) are listed, with shares by KUJI held counted up to `weightCap` (10,000,000). Announce the
snapshot date ahead of time: it's the reason to buy up to Orca and stake.

`node scripts/airdrop/build-list.js <round>` runs the right steps for either kind of round (the
Airdrop workflow's `build-list` uses it). Announce what triggers each later round (holder count,
volume, followers) before it happens.

## Launch checklist

1. Deploy on Ink Sepolia, start a test airdrop round, and claim and stake from the page.
2. Deploy on Ink mainnet.
3. From your liquidity wallet, create the KUJI/ETH pool on an Ink DEX.
4. Burn the LP tokens (send them to `0x000000000000000000000000000000000000dEaD`), Ryoshi's
   way, and post the transaction. (A public locker works too, but burning is permanent.)
5. Optionally hand Pod and Drop ownership to a multisig (`transferOwnership`, then `acceptOwnership`
   from the multisig) or renounce it once no more reward rounds are planned.
6. Post the contract addresses, verification links, LP burn/lock tx and airdrop contracts on
   X (@KujiraToken) and the website so people can check everything themselves.

## Notes

- The ticker `KUJI` is already used by the Kujira Cosmos chain's token. Consider a different
  symbol to avoid confusion on aggregators; change it in `KujiraToken.sol`.
- These contracts have tests but no professional audit. Get one before holding significant value.
- Staking rewards can raise securities questions in some jurisdictions.
  Talk to a lawyer before marketing yields.
