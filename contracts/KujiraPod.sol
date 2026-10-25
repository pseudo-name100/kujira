// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title KujiraPod
/// @notice Stake KUJI, earn KUJI. Rewards come only from tokens the owner deposits
///         up front (no inflation); each deposit streams linearly over a chosen duration.
///         The owner can fund reward periods and nothing else: it cannot touch staked
///         tokens or rewards already funded. Stakers can withdraw at any time.
/// @dev Synthetix StakingRewards model, adapted so staking and reward token can be the
///      same. When nobody is staked the stream pauses instead of stranding rewards.
contract KujiraPod is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;

    uint256 public rewardRate; // tokens per second
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored; // scaled by 1e18
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardFunded(uint256 amount, uint256 duration, uint256 rewardRate, uint256 periodFinish);
    event Recovered(address indexed token, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error RewardTooSmall();
    error CannotRecoverStakingToken();

    constructor(IERC20 token_, address owner_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ----------------------------------------------------------------- views

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        uint256 last = lastTimeRewardApplicable();
        if (last <= lastUpdateTime) return rewardPerTokenStored;
        return rewardPerTokenStored + ((last - lastUpdateTime) * rewardRate * 1e18) / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return rewards[account]
            + (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18;
    }

    // --------------------------------------------------------------- stakers

    function stake(uint256 amount) external nonReentrant {
        _stake(msg.sender, amount);
    }

    /// @notice Stake the caller's tokens on behalf of `account` (used by KujiraDrop's
    ///         claim-and-stake). Only `account` can withdraw them.
    function stakeFor(address account, uint256 amount) external nonReentrant {
        if (account == address(0)) revert ZeroAddress();
        _stake(account, amount);
    }

    function withdraw(uint256 amount) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);
        balanceOf[msg.sender] -= amount; // reverts on underflow
        totalStaked -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claim() public nonReentrant {
        _updateReward(msg.sender);
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            token.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        uint256 bal = balanceOf[msg.sender];
        if (bal > 0) withdraw(bal);
        claim();
    }

    // ----------------------------------------------------------------- owner

    /// @notice Deposit `amount` KUJI and stream it, plus any unstreamed remainder of the
    ///         current period, over the next `duration` seconds.
    function fundRewards(uint256 amount, uint256 duration) external onlyOwner nonReentrant {
        if (amount == 0 || duration == 0) revert ZeroAmount();
        _updateReward(address(0));

        uint256 leftover;
        if (block.timestamp < periodFinish) {
            leftover = (periodFinish - block.timestamp) * rewardRate;
        }
        uint256 rate = (amount + leftover) / duration;
        if (rate == 0) revert RewardTooSmall();

        token.safeTransferFrom(msg.sender, address(this), amount);

        rewardRate = rate;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardFunded(amount, duration, rate, periodFinish);
    }

    /// @notice Rescue tokens sent here by mistake. KUJI itself can never be pulled out.
    function recoverERC20(IERC20 other, uint256 amount) external onlyOwner {
        if (address(other) == address(token)) revert CannotRecoverStakingToken();
        other.safeTransfer(owner(), amount);
        emit Recovered(address(other), amount);
    }

    // -------------------------------------------------------------- internal

    function _stake(address account, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        _updateReward(account);
        totalStaked += amount;
        balanceOf[account] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(account, amount);
    }

    function _updateReward(address account) internal {
        if (totalStaked == 0 && lastUpdateTime < periodFinish && block.timestamp > lastUpdateTime) {
            // Nobody earned anything since the last update: shift the unstreamed
            // remainder forward so it starts streaming once someone stakes.
            periodFinish = block.timestamp + (periodFinish - lastUpdateTime);
            lastUpdateTime = block.timestamp;
        }
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }
}
