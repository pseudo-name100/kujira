// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Kujira
/// @notice Fixed-supply ERC-20 for Ink. The entire supply is minted once in the
///         constructor and there is no owner, so after deployment nobody can mint
///         more, pause transfers, blacklist wallets, or change fees (there are none).
///         Holders can burn their own tokens, and ERC-2612 permit allows gasless approvals.
contract KujiraToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    error ZeroAddress();

    constructor(address recipient) ERC20("Kujira", "KUJI") ERC20Permit("Kujira") {
        if (recipient == address(0)) revert ZeroAddress();
        _mint(recipient, TOTAL_SUPPLY);
    }
}
