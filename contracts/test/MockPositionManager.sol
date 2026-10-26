// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test stand-in for Uniswap v3's NonfungiblePositionManager: positions are NFTs that
///      accrue fees in two tokens, and only the NFT's owner can collect them.
contract MockPositionManager is ERC721 {
    struct Position {
        address token0;
        address token1;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    mapping(uint256 => Position) public pos;
    uint256 public nextId = 1;

    constructor() ERC721("Mock Positions", "MPOS") {}

    function mint(address to, address token0, address token1, uint128 liquidity) external returns (uint256 id) {
        id = nextId++;
        pos[id] = Position(token0, token1, liquidity, 0, 0);
        _mint(to, id);
    }

    /// Simulate trading fees: the caller sends the tokens in.
    function accrue(uint256 id, uint128 a0, uint128 a1) external {
        IERC20(pos[id].token0).transferFrom(msg.sender, address(this), a0);
        IERC20(pos[id].token1).transferFrom(msg.sender, address(this), a1);
        pos[id].owed0 += a0;
        pos[id].owed1 += a1;
    }

    function positions(uint256 id)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        Position memory p = pos[id];
        return (0, address(0), p.token0, p.token1, 10_000, -887_200, 887_200, p.liquidity, 0, 0, p.owed0, p.owed1);
    }

    /// Make a position's collect revert, like one holding a hostile token would.
    mapping(uint256 => bool) public broken;

    function breakCollect(uint256 id) external {
        broken[id] = true;
    }

    function collect(CollectParams calldata c) external payable returns (uint256 a0, uint256 a1) {
        require(!broken[c.tokenId], "broken");
        require(_isAuthorized(ownerOf(c.tokenId), msg.sender, c.tokenId), "not approved");
        Position storage p = pos[c.tokenId];
        a0 = p.owed0 < c.amount0Max ? p.owed0 : c.amount0Max;
        a1 = p.owed1 < c.amount1Max ? p.owed1 : c.amount1Max;
        p.owed0 -= uint128(a0);
        p.owed1 -= uint128(a1);
        IERC20(p.token0).transfer(c.recipient, a0);
        IERC20(p.token1).transfer(c.recipient, a1);
    }

    /// Removing liquidity also needs owner or approval; the lock never grants either.
    function decreaseLiquidity(uint256 id, uint128 amount) external {
        require(_isAuthorized(ownerOf(id), msg.sender, id), "not approved");
        pos[id].liquidity -= amount;
    }
}

/// @dev Plain token for tests, standing in for WETH.
contract MockToken is ERC20 {
    constructor() ERC20("Mock WETH", "WETH") {
        _mint(msg.sender, 1_000_000 ether);
    }
}
