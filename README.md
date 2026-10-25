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

## Contracts

- `contracts/KujiraToken.sol`: ERC-20 with burn and ERC-2612 `permit` (gasless approvals). Fixed supply, no owner.
- `contracts/KujiraPod.sol`: staking. `fundRewards(amount, duration)` streams a deposit
  linearly to stakers in proportion to their stake. A new deposit before a period ends rolls
  the unstreamed remainder into the new period. If nobody is staked, the stream pauses
  instead of stranding the rewards. `recoverERC20` can rescue other tokens sent by mistake,
  never KUJI.
- OpenZeppelin `VestingWallet`: holds the team allocation.

Default split (edit `scripts/tokenomics.js` before deploying):

| Bucket | % | Where it goes |
| --- | --- | --- |
| Liquidity | 70 | Stays with the deployer to pair on a DEX. Burn or lock the LP tokens afterwards. |
| Staking rewards | 15 | Deposited into the Pod, streamed over 180 days |
| Team | 10 | `VestingWallet`: 180-day cliff, then linear over 365 days |
| Community | 5 | Stays with the deployer for airdrops and giveaways |

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
npx hardhat verify --network ink <VestingWallet> <TEAM_ADDRESS> <start> <duration>
```

## Launch checklist

1. Deploy and verify all three contracts on Ink Sepolia, stake and claim from a second wallet.
2. Deploy and verify on mainnet.
3. Create the KUJI/ETH pool on an Ink DEX with the liquidity allocation.
4. Burn the LP tokens (send them to `0x000000000000000000000000000000000000dEaD`) or lock them
   with a public locker, and post the transaction.
5. Optionally hand Pod ownership to a multisig (`transferOwnership`, then `acceptOwnership`
   from the multisig) or renounce it once no more reward rounds are planned.
6. Post the contract addresses, verification links, LP burn/lock tx and vesting contract on
   X (@KujiraToken) and the website so people can check everything themselves.

## Notes

- The ticker `KUJI` is already used by the Kujira Cosmos chain's token. Consider a different
  symbol to avoid confusion on aggregators; change it in `KujiraToken.sol`.
- These contracts have tests but no professional audit. Get one before holding significant value.
- Staking rewards and team allocations can raise securities questions in some jurisdictions.
  Talk to a lawyer before marketing yields.
