// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title KujiraPod
/// @notice Stake KUJI, earn KUJI. Rewards come only from tokens the owner deposits up
///         front (no inflation); each deposit streams linearly over a chosen duration.
///         Rewards are shared by boosted stake, which favours whales who stay:
///           - size:  +0.10x from 100,000 KUJI, +0.25x from 1,000,000, +0.50x from 10,000,000
///           - time:  +0.25x for every 30 days staked, up to +1.00x at 120 days
///         so the most a stake can earn is 2.5x. Topping up blends the stake's start time
///         by amount; withdrawing anything restarts it. The time boost is applied whenever
///         the stake changes or anyone calls poke(), which can only raise it.
///         The owner can fund reward periods and nothing else: it cannot touch staked
///         tokens or rewards already funded. Stakers can withdraw at any time.
/// @dev Synthetix StakingRewards accounting over boosted balances. Staking and reward
///      token are the same. When nothing is staked the stream pauses instead of
///      stranding rewards.
contract KujiraPod is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000; // 1x

    uint256 public constant DOLPHIN = 100_000 ether;
    uint256 public constant ORCA = 1_000_000 ether;
    uint256 public constant KUJIRA = 10_000_000 ether;
    uint256 public constant DOLPHIN_BONUS = 1_000; // +0.10x
    uint256 public constant ORCA_BONUS = 2_500; // +0.25x
    uint256 public constant KUJIRA_BONUS = 5_000; // +0.50x

    uint256 public constant TIME_STEP = 30 days;
    uint256 public constant TIME_STEP_BONUS = 2_500; // +0.25x per step
    uint256 public constant MAX_TIME_BONUS = 10_000; // +1.00x

    /// Reward periods last between a week and two years.
    uint256 public constant MIN_DURATION = 7 days;
    uint256 public constant MAX_DURATION = 730 days;

    IERC20 public immutable token;

    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public stakedSince;

    uint256 public totalBoosted;
    mapping(address => uint256) public boostedBalanceOf;

    uint256 public rewardRate; // tokens per second
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored; // per boosted token, scaled by 1e18
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event BoostUpdated(address indexed user, uint256 multiplierBps, uint256 boostedBalance);
    event RewardFunded(uint256 amount, uint256 duration, uint256 rewardRate, uint256 periodFinish);
    event Recovered(address indexed token, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error RewardTooSmall();
    error BadDuration();
    error CannotSpeedUpOrSlowDown();
    error CannotRecoverStakingToken();

    constructor(IERC20 token_, address owner_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ----------------------------------------------------------------- boosts

    function sizeBonus(uint256 amount) public pure returns (uint256) {
        if (amount >= KUJIRA) return KUJIRA_BONUS;
        if (amount >= ORCA) return ORCA_BONUS;
        if (amount >= DOLPHIN) return DOLPHIN_BONUS;
        return 0;
    }

    function timeBonus(uint256 since) public view returns (uint256) {
        if (since == 0 || since >= block.timestamp) return 0;
        uint256 bonus = ((block.timestamp - since) / TIME_STEP) * TIME_STEP_BONUS;
        return bonus > MAX_TIME_BONUS ? MAX_TIME_BONUS : bonus;
    }

    /// @notice The multiplier `account` would have if poked now (BPS = 1x).
    function multiplierOf(address account) public view returns (uint256) {
        if (balanceOf[account] == 0) return BPS;
        return BPS + sizeBonus(balanceOf[account]) + timeBonus(stakedSince[account]);
    }

    /// @notice The multiplier `account` is currently earning at.
    function appliedMultiplierOf(address account) external view returns (uint256) {
        uint256 bal = balanceOf[account];
        return bal == 0 ? BPS : (boostedBalanceOf[account] * BPS) / bal;
    }

    // ----------------------------------------------------------------- views

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalBoosted == 0) return rewardPerTokenStored;
        uint256 last = lastTimeRewardApplicable();
        if (last <= lastUpdateTime) return rewardPerTokenStored;
        return rewardPerTokenStored + ((last - lastUpdateTime) * rewardRate * 1e18) / totalBoosted;
    }

    function earned(address account) public view returns (uint256) {
        return rewards[account]
            + (boostedBalanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18;
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

    /// @notice Withdraw some or all of your stake. This restarts your time boost.
    function withdraw(uint256 amount) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);
        balanceOf[msg.sender] -= amount; // reverts on underflow
        totalStaked -= amount;
        stakedSince[msg.sender] = balanceOf[msg.sender] == 0 ? 0 : block.timestamp;
        _syncBoost(msg.sender);
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claim() public nonReentrant {
        _updateReward(msg.sender);
        _syncBoost(msg.sender);
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

    /// @notice Apply `account`'s current time boost. Anyone can call it for anyone; since
    ///         the size part only changes when the stake does, this can only raise a boost.
    function poke(address account) external nonReentrant {
        _updateReward(account);
        _syncBoost(account);
    }

    // ----------------------------------------------------------------- owner

    /// @notice Deposit `amount` KUJI and stream it, plus any unstreamed remainder of the
    ///         current period, over the next `duration` seconds. Rewards already promised can
    ///         only be added to: while a period runs, a top-up can't end it sooner or pay out
    ///         slower, so the owner can't squeeze the pool into a moment or stall it.
    function fundRewards(uint256 amount, uint256 duration) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        _updateReward(address(0));

        uint256 leftover;
        if (block.timestamp < periodFinish) {
            leftover = (periodFinish - block.timestamp) * rewardRate;
        }
        uint256 rate = (amount + leftover) / duration;
        if (rate == 0) revert RewardTooSmall();
        // The 1% allowance absorbs rounding and the seconds between blocks.
        if (leftover > 0 && (block.timestamp + duration < periodFinish || rate * 100 < rewardRate * 99)) {
            revert CannotSpeedUpOrSlowDown();
        }

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
        uint256 old = balanceOf[account];
        // Blend the start time by amount, so a small early stake can't lend its age to a
        // large later one.
        stakedSince[account] =
            old == 0 ? block.timestamp : (stakedSince[account] * old + block.timestamp * amount) / (old + amount);
        balanceOf[account] = old + amount;
        totalStaked += amount;
        _syncBoost(account);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(account, amount);
    }

    function _syncBoost(address account) internal {
        uint256 multiplier = multiplierOf(account);
        uint256 boosted = (balanceOf[account] * multiplier) / BPS;
        totalBoosted = totalBoosted - boostedBalanceOf[account] + boosted;
        boostedBalanceOf[account] = boosted;
        emit BoostUpdated(account, multiplier, boosted);
    }

    function _updateReward(address account) internal {
        if (totalBoosted == 0 && lastUpdateTime < periodFinish && block.timestamp > lastUpdateTime) {
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
