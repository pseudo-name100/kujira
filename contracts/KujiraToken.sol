// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Kujira
/// @notice Fixed-supply ERC-20 for Ink. The entire supply is minted once in the
///         constructor and there is no owner, so after deployment nobody can mint
///         more, pause transfers, blacklist wallets, or change the tax below.
///         Holders can burn their own tokens, and ERC-2612 permit allows gasless approvals.
///
///         Launch tax, against sniper bots: for the first 30 minutes after the pool opens,
///         KUJI leaving KUJI's 1% Uniswap v3 pool (buys, and LP fee collections) pays a tax
///         that starts at 25% and falls every second to 0. It goes to `taxRecipient`. After
///         that there is no tax on anything, ever. The pool address is derived from the
///         Uniswap factory in the constructor, so nothing else can be taxed. Sells aren't
///         taxed: Uniswap v3 rejects a token that delivers less than it was sent into the pool.
///         The clock starts with the first KUJI sent to the pool's address, so no KUJI may
///         leave the deployer before the launch liquidity goes in.
contract KujiraToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    uint256 public constant LAUNCH_TAX_BPS = 2_500; // 25% at the first second
    uint256 public constant LAUNCH_TAX_DURATION = 30 minutes;
    uint24 public constant POOL_FEE = 10_000; // the 1% tier
    /// @dev Uniswap v3's pool init code hash, the same on every chain it's deployed to.
    bytes32 internal constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;

    /// @notice The KUJI/WETH 1% Uniswap v3 pool, or zero when deployed without a launch tax.
    address public immutable pool;
    address public immutable taxRecipient;
    /// @notice When liquidity first went into the pool: the launch tax counts down from here.
    uint64 public launchedAt;

    error ZeroAddress();

    event Launched(uint64 at);

    /// @param factory Uniswap v3 factory, or zero for no launch tax (test networks).
    constructor(address recipient, address factory, address weth, address taxRecipient_)
        ERC20("Kujira", "KUJI")
        ERC20Permit("Kujira")
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (factory != address(0)) {
            if (weth == address(0) || taxRecipient_ == address(0)) revert ZeroAddress();
            (address token0, address token1) = address(this) < weth ? (address(this), weth) : (weth, address(this));
            pool = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                hex"ff", factory, keccak256(abi.encode(token0, token1, POOL_FEE)), POOL_INIT_CODE_HASH
                            )
                        )
                    )
                )
            );
            taxRecipient = taxRecipient_;
        }
        _mint(recipient, TOTAL_SUPPLY);
    }

    /// @notice The launch tax on a buy right now, in basis points (0 before launch and after
    ///         the first 30 minutes).
    function launchTaxBps() public view returns (uint256) {
        uint256 start = launchedAt;
        if (start == 0 || block.timestamp >= start + LAUNCH_TAX_DURATION) return 0;
        return (LAUNCH_TAX_BPS * (start + LAUNCH_TAX_DURATION - block.timestamp)) / LAUNCH_TAX_DURATION;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (pool != address(0)) {
            // The first KUJI into the pool is the launch liquidity: start the clock, untaxed.
            if (to == pool && launchedAt == 0) {
                launchedAt = uint64(block.timestamp);
                emit Launched(launchedAt);
            } else if (from == pool && to != taxRecipient) {
                uint256 tax = (value * launchTaxBps()) / 10_000;
                if (tax > 0) {
                    super._update(from, taxRecipient, tax);
                    value -= tax;
                }
            }
        }
        super._update(from, to, value);
    }
}
