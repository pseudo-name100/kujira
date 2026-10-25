// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {KujiraPod} from "./KujiraPod.sol";

/// @title KujiraDrop
/// @notice Holds the fixed airdrop pool and releases it in claim-based rounds.
///         Each round is a Merkle list of (wallet, amount) with a claim deadline.
///         Claimers either take their tokens, or stake them in the Pod straight away
///         for a bonus. After the deadline, unclaimed tokens go back to the pool for
///         later rounds. KUJI only leaves this contract through claims or burns:
///         the owner can start rounds and burn unused pool, never withdraw it.
contract KujiraDrop is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_STAKE_BONUS_BPS = 10_000; // at most +100%

    struct Round {
        bytes32 merkleRoot;
        uint64 deadline;
        uint16 stakeBonusBps;
        bool closed;
        uint256 reserved; // list total plus the most the stake bonus can add
        uint256 paid;
    }

    IERC20 public immutable token;
    KujiraPod public immutable pod;

    Round[] public rounds;
    uint256 public totalReserved; // reserved by open rounds and not yet paid
    mapping(uint256 => mapping(address => bool)) public claimed;

    event RoundStarted(uint256 indexed id, bytes32 merkleRoot, uint256 total, uint64 deadline, uint16 stakeBonusBps);
    event Claimed(uint256 indexed id, address indexed account, uint256 amount, bool staked);
    event RoundClosed(uint256 indexed id, uint256 returnedToPool);
    event PoolBurned(uint256 amount);

    error ZeroAddress();
    error InvalidRound();
    error InsufficientPool();
    error BonusTooHigh();
    error RoundEnded();
    error RoundStillOpen();
    error AlreadyClaimed();
    error InvalidProof();
    error RoundExhausted();

    constructor(KujiraPod pod_, address owner_) Ownable(owner_) {
        if (address(pod_) == address(0)) revert ZeroAddress();
        pod = pod_;
        token = pod_.token();
    }

    // ----------------------------------------------------------------- views

    function roundCount() external view returns (uint256) {
        return rounds.length;
    }

    /// @notice Pool tokens not committed to any open round.
    function available() public view returns (uint256) {
        return token.balanceOf(address(this)) - totalReserved;
    }

    // ----------------------------------------------------------------- owner

    /// @param total Sum of all amounts in the Merkle list.
    function startRound(bytes32 merkleRoot, uint256 total, uint64 deadline, uint16 stakeBonusBps)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (merkleRoot == bytes32(0) || total == 0 || deadline <= block.timestamp) revert InvalidRound();
        if (stakeBonusBps > MAX_STAKE_BONUS_BPS) revert BonusTooHigh();
        uint256 reserve = total + (total * stakeBonusBps) / 10_000;
        if (reserve > available()) revert InsufficientPool();

        totalReserved += reserve;
        id = rounds.length;
        rounds.push(Round(merkleRoot, deadline, stakeBonusBps, false, reserve, 0));
        emit RoundStarted(id, merkleRoot, total, deadline, stakeBonusBps);
    }

    /// @notice Permanently burn pool tokens that no open round has reserved.
    function burnUnallocated(uint256 amount) external onlyOwner {
        if (amount > available()) revert InsufficientPool();
        ERC20Burnable(address(token)).burn(amount);
        emit PoolBurned(amount);
    }

    // --------------------------------------------------------------- anyone

    function claim(uint256 id, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        _useClaim(id, msg.sender, amount, proof);
        _pay(id, amount);
        token.safeTransfer(msg.sender, amount);
        emit Claimed(id, msg.sender, amount, false);
    }

    /// @notice Claim straight into the Pod with the round's stake bonus on top.
    function claimAndStake(uint256 id, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        _useClaim(id, msg.sender, amount, proof);
        uint256 total = amount + (amount * rounds[id].stakeBonusBps) / 10_000;
        _pay(id, total);
        token.forceApprove(address(pod), total);
        pod.stakeFor(msg.sender, total);
        emit Claimed(id, msg.sender, total, true);
    }

    /// @notice After the deadline, return the round's unclaimed tokens to the pool.
    function closeRound(uint256 id) external {
        if (id >= rounds.length) revert InvalidRound();
        Round storage r = rounds[id];
        if (r.closed) revert RoundEnded();
        if (block.timestamp <= r.deadline) revert RoundStillOpen();
        r.closed = true;
        uint256 unclaimed = r.reserved - r.paid;
        totalReserved -= unclaimed;
        emit RoundClosed(id, unclaimed);
    }

    // -------------------------------------------------------------- internal

    function _useClaim(uint256 id, address account, uint256 amount, bytes32[] calldata proof) internal {
        if (id >= rounds.length) revert InvalidRound();
        Round storage r = rounds[id];
        if (r.closed || block.timestamp > r.deadline) revert RoundEnded();
        if (claimed[id][account]) revert AlreadyClaimed();
        // Same leaf encoding as OpenZeppelin's StandardMerkleTree with ["address", "uint256"].
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        if (!MerkleProof.verifyCalldata(proof, r.merkleRoot, leaf)) revert InvalidProof();
        claimed[id][account] = true;
    }

    function _pay(uint256 id, uint256 amount) internal {
        Round storage r = rounds[id];
        // Only reachable if the list sums to more than `total`; first come, first served.
        if (r.paid + amount > r.reserved) revert RoundExhausted();
        r.paid += amount;
        totalReserved -= amount;
    }
}
