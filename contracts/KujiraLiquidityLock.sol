// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @dev The parts of Uniswap v3's NonfungiblePositionManager this contract uses.
interface INonfungiblePositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function ownerOf(uint256 tokenId) external view returns (address);

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

/// @title KujiraLiquidityLock
/// @notice Holds KUJI's Uniswap v3 liquidity positions forever. Once a position NFT is sent
///         here, nobody can remove its liquidity or move it again: this contract has no
///         function that decreases liquidity, transfers the NFT or approves anyone to.
///         The trading fees the position earns can be collected, and always go to
///         `feeRecipient`. Anyone may trigger a collection; only the current recipient can
///         hand the role to another address.
contract KujiraLiquidityLock is IERC721Receiver {
    INonfungiblePositionManager public immutable positionManager;
    address public immutable token; // KUJI

    address public feeRecipient;
    uint256[] public lockedPositions;

    event Locked(uint256 indexed tokenId, address indexed from, uint128 liquidity);
    event FeesCollected(uint256 indexed tokenId, address indexed recipient, uint256 amount0, uint256 amount1);
    event FeeRecipientChanged(address indexed previous, address indexed next);

    error ZeroAddress();
    error NotPositionManager();
    error NotKujiraPosition();
    error NotFeeRecipient();
    error NotOwned();

    constructor(INonfungiblePositionManager positionManager_, address token_, address feeRecipient_) {
        if (address(positionManager_) == address(0) || token_ == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        positionManager = positionManager_;
        token = token_;
        feeRecipient = feeRecipient_;
    }

    mapping(uint256 => bool) public isLocked;

    /// @notice Accepts KUJI positions sent with safeTransferFrom and records them.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        _record(tokenId, from);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Record a KUJI position that reached this contract through a plain transferFrom
    ///         (which skips onERC721Received). It was already locked; this lists it for collectAll.
    function track(uint256 tokenId) external {
        if (positionManager.ownerOf(tokenId) != address(this)) revert NotOwned();
        _record(tokenId, address(0));
    }

    function _record(uint256 tokenId, address from) internal {
        (,, address token0, address token1,,,, uint128 liquidity,,,,) = positionManager.positions(tokenId);
        if (token0 != token && token1 != token) revert NotKujiraPosition();
        if (isLocked[tokenId]) return;
        isLocked[tokenId] = true;
        lockedPositions.push(tokenId);
        emit Locked(tokenId, from, liquidity);
    }

    /// @notice Send a locked position's accumulated trading fees to the fee recipient.
    function collect(uint256 tokenId) public returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: feeRecipient,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit FeesCollected(tokenId, feeRecipient, amount0, amount1);
    }

    /// @notice Collect fees from every recorded position.
    function collectAll() external {
        for (uint256 i = 0; i < lockedPositions.length; i++) {
            collect(lockedPositions[i]);
        }
    }

    function setFeeRecipient(address next) external {
        if (msg.sender != feeRecipient) revert NotFeeRecipient();
        if (next == address(0)) revert ZeroAddress();
        emit FeeRecipientChanged(feeRecipient, next);
        feeRecipient = next;
    }

    function lockedCount() external view returns (uint256) {
        return lockedPositions.length;
    }
}
