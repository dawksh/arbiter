// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Testnet research escrow. Resolver expiry intentionally splits 50/50.
contract ResearchEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum State {
        Created,
        Accepted,
        Funded,
        Submitted,
        Review,
        Disputed,
        Settled
    }
    enum Outcome {
        Inconclusive,
        Pass,
        Fail
    }

    struct Terms {
        address worker;
        address resolver;
        uint256 amount;
        bytes32 briefHash;
        bytes32 sourcesHash;
        bytes32 policyHash;
        uint64 submissionDeadline;
        uint64 evaluationPeriod;
        uint64 challengePeriod;
        uint64 resolutionPeriod;
    }

    struct Agreement {
        address client;
        Terms terms;
        State state;
        bytes32 submissionHash;
        bytes32 evidenceHash;
        Outcome outcome;
        uint64 evaluationDeadline;
        uint64 challengeDeadline;
        uint64 resolutionDeadline;
        uint256 workerPaid;
    }
    IERC20 public immutable token;
    address public immutable evaluator;
    uint256 public count;
    mapping(uint256 => Agreement) private agreements;
    event Changed(uint256 indexed id, State state, address indexed actor);
    event Paid(uint256 indexed id, uint256 workerAmount, uint256 clientAmount);
    error Invalid();
    error Unauthorized();

    constructor(address usdc, address relay) {
        if (usdc == address(0) || relay == address(0)) revert Invalid();
        token = IERC20(usdc);
        evaluator = relay;
    }

    function getAgreement(uint256 id) public view returns (Agreement memory) {
        if (id == 0 || id > count) revert Invalid();
        return agreements[id];
    }

    function create(Terms calldata t) external returns (uint256 id) {
        if (
            t.worker == address(0) || t.resolver == address(0) || t.worker == msg.sender || t.resolver == msg.sender
                || t.resolver == t.worker || t.amount == 0 || t.amount > 100e6 || t.briefHash == 0 || t.sourcesHash == 0
                || t.policyHash == 0 || t.submissionDeadline <= block.timestamp
                || t.submissionDeadline > block.timestamp + 30 days || t.evaluationPeriod == 0
                || t.evaluationPeriod > 7 days || t.challengePeriod == 0 || t.challengePeriod > 30 days
                || t.resolutionPeriod == 0 || t.resolutionPeriod > 30 days
        ) revert Invalid();
        id = ++count;
        Agreement storage a = agreements[id];
        a.client = msg.sender;
        a.terms = t;
        emit Changed(id, State.Created, msg.sender);
    }

    function accept(uint256 id) external {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.worker) revert Unauthorized();
        if (a.state != State.Created || block.timestamp >= a.terms.submissionDeadline) revert Invalid();
        a.state = State.Accepted;
        emit Changed(id, a.state, msg.sender);
    }

    function fund(uint256 id) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.client) revert Unauthorized();
        if (a.state != State.Accepted || block.timestamp >= a.terms.submissionDeadline) revert Invalid();
        a.state = State.Funded;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), a.terms.amount);
        if (token.balanceOf(address(this)) != beforeBalance + a.terms.amount) revert Invalid();
        emit Changed(id, a.state, msg.sender);
    }

    function submit(uint256 id, bytes32 contentHash) external {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.worker) revert Unauthorized();
        if (a.state != State.Funded || block.timestamp >= a.terms.submissionDeadline || contentHash == 0) {
            revert Invalid();
        }
        a.submissionHash = contentHash;
        a.state = State.Submitted;
        a.evaluationDeadline = uint64(block.timestamp) + a.terms.evaluationPeriod;
        emit Changed(id, a.state, msg.sender);
    }

    /// Explicit domain and commitment checks prevent cross-agreement/result reuse by the relay.
    function postEvaluation(
        uint256 id,
        address escrow,
        uint256 chainId,
        bytes32 policyHash,
        bytes32 submissionHash,
        bytes32 evidenceHash,
        Outcome outcome
    ) external {
        if (msg.sender != evaluator) revert Unauthorized();
        Agreement storage a = agreements[id];
        if (
            escrow != address(this) || chainId != block.chainid || a.state != State.Submitted
                || block.timestamp >= a.evaluationDeadline || policyHash != a.terms.policyHash
                || submissionHash != a.submissionHash || evidenceHash == 0
        ) revert Invalid();
        a.evidenceHash = evidenceHash;
        a.outcome = outcome;
        if (outcome == Outcome.Inconclusive) _dispute(a, uint64(block.timestamp));
        else a.state = State.Review;
        a.challengeDeadline = uint64(block.timestamp) + a.terms.challengePeriod;
        emit Changed(id, a.state, msg.sender);
    }

    function challenge(uint256 id) external {
        Agreement storage a = agreements[id];
        if (msg.sender != a.client && msg.sender != a.terms.worker) revert Unauthorized();
        if (a.state != State.Review || block.timestamp >= a.challengeDeadline) revert Invalid();
        _dispute(a, uint64(block.timestamp));
        emit Changed(id, a.state, msg.sender);
    }

    function settle(uint256 id) external nonReentrant {
        Agreement storage a = agreements[id];
        if (a.state != State.Review || block.timestamp < a.challengeDeadline) revert Invalid();
        _pay(id, a, a.outcome == Outcome.Pass ? a.terms.amount : 0);
    }

    function resolve(uint256 id, uint256 workerAmount) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.resolver) revert Unauthorized();
        if (a.state != State.Disputed || block.timestamp >= a.resolutionDeadline || workerAmount > a.terms.amount) {
            revert Invalid();
        }
        _pay(id, a, workerAmount);
    }

    function executeTimeout(uint256 id) external nonReentrant {
        Agreement storage a = agreements[id];
        if (a.state == State.Funded && block.timestamp >= a.terms.submissionDeadline) {
            _pay(id, a, 0);
        } else if (a.state == State.Submitted && block.timestamp >= a.evaluationDeadline) {
            // Anchor to expiry so a late executor cannot extend the resolver's deadline.
            _dispute(a, a.evaluationDeadline);
            emit Changed(id, a.state, msg.sender);
        } else if (a.state == State.Disputed && block.timestamp >= a.resolutionDeadline) {
            _pay(id, a, a.terms.amount / 2);
        } else {
            revert Invalid();
        }
    }

    function _dispute(Agreement storage a, uint64 start) private {
        a.state = State.Disputed;
        a.resolutionDeadline = start + a.terms.resolutionPeriod;
    }

    function _pay(uint256 id, Agreement storage a, uint256 workerAmount) private {
        a.state = State.Settled;
        a.workerPaid = workerAmount;
        if (workerAmount > 0) token.safeTransfer(a.terms.worker, workerAmount);
        uint256 refund = a.terms.amount - workerAmount;
        if (refund > 0) token.safeTransfer(a.client, refund);
        emit Paid(id, workerAmount, refund);
        emit Changed(id, a.state, msg.sender);
    }
}
