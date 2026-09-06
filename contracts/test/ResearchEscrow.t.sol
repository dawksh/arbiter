// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ResearchEscrow as E} from "../src/ResearchEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert() external;
}

contract EscrowTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    E e;
    MockUSDC t;
    address client = address(1);
    address worker = address(2);
    address resolver = address(3);
    address relay = address(4);
    bytes32 constant H = keccak256("content");

    function setUp() public {
        t = new MockUSDC();
        e = new E(address(t), relay);
        t.mint(client, 100e6);
    }

    function terms(uint256 amount) internal view returns (E.Terms memory) {
        return E.Terms(worker, resolver, amount, H, H, H, uint64(block.timestamp + 100), 20, 30, 40);
    }

    function funded(uint256 amount) internal returns (uint256 id) {
        vm.prank(client);
        id = e.create(terms(amount));
        vm.prank(worker);
        e.accept(id);
        vm.startPrank(client);
        t.approve(address(e), amount);
        e.fund(id);
        vm.stopPrank();
    }

    function submitted() internal returns (uint256 id) {
        id = funded(10e6);
        vm.prank(worker);
        e.submit(id, H);
    }

    function evaluate(uint256 id, E.Outcome o) internal {
        vm.prank(relay);
        e.postEvaluation(id, address(e), block.chainid, H, H, H, o);
    }

    function testPayment() public {
        uint256 id = submitted();
        evaluate(id, E.Outcome.Pass);
        vm.warp(e.getAgreement(id).challengeDeadline);
        e.settle(id);
        require(t.balanceOf(worker) == 10e6);
        vm.expectRevert();
        e.settle(id);
    }

    function testRefund() public {
        uint256 id = submitted();
        evaluate(id, E.Outcome.Fail);
        vm.warp(e.getAgreement(id).challengeDeadline);
        e.settle(id);
        require(t.balanceOf(client) == 100e6);
    }

    function testChallengeResolution() public {
        uint256 id = submitted();
        evaluate(id, E.Outcome.Pass);
        vm.prank(client);
        e.challenge(id);
        vm.expectRevert();
        e.settle(id);
        vm.prank(resolver);
        e.resolve(id, 4e6);
        require(t.balanceOf(worker) == 4e6 && t.balanceOf(client) == 96e6);
    }

    function testNoSubmission() public {
        uint256 id = funded(10e6);
        vm.warp(e.getAgreement(id).terms.submissionDeadline);
        e.executeTimeout(id);
        require(t.balanceOf(client) == 100e6);
    }

    function testEvaluationOutageAndResolverTimeout() public {
        uint256 id = submitted();
        uint64 end = e.getAgreement(id).evaluationDeadline;
        vm.warp(end + 100);
        e.executeTimeout(id);
        require(e.getAgreement(id).resolutionDeadline == end + 40);
        e.executeTimeout(id);
        require(t.balanceOf(worker) == 5e6);
    }

    function testInconclusive() public {
        uint256 id = submitted();
        evaluate(id, E.Outcome.Inconclusive);
        require(e.getAgreement(id).state == E.State.Disputed);
    }

    function testUnauthorized() public {
        uint256 id = submitted();
        vm.expectRevert();
        e.postEvaluation(id, address(e), block.chainid, H, H, H, E.Outcome.Pass);
        evaluate(id, E.Outcome.Pass);
        vm.expectRevert();
        e.challenge(id);
        vm.prank(client);
        e.challenge(id);
        vm.expectRevert();
        e.resolve(id, 1);
    }

    function testBindingsAndDuplicate() public {
        uint256 id = submitted();
        vm.startPrank(relay);
        vm.expectRevert();
        e.postEvaluation(id, address(99), block.chainid, H, H, H, E.Outcome.Pass);
        vm.expectRevert();
        e.postEvaluation(id, address(e), block.chainid + 1, H, H, H, E.Outcome.Pass);
        vm.expectRevert();
        e.postEvaluation(id, address(e), block.chainid, bytes32(uint256(1)), H, H, E.Outcome.Pass);
        vm.expectRevert();
        e.postEvaluation(id, address(e), block.chainid, H, bytes32(uint256(1)), H, E.Outcome.Pass);
        vm.stopPrank();
        evaluate(id, E.Outcome.Pass);
        vm.prank(relay);
        vm.expectRevert();
        e.postEvaluation(id, address(e), block.chainid, H, H, H, E.Outcome.Pass);
    }

    function testDeadlineBoundaries() public {
        uint256 id = submitted();
        vm.warp(e.getAgreement(id).evaluationDeadline);
        vm.prank(relay);
        vm.expectRevert();
        e.postEvaluation(id, address(e), block.chainid, H, H, H, E.Outcome.Pass);
        e.executeTimeout(id);
        vm.warp(e.getAgreement(id).resolutionDeadline);
        vm.prank(resolver);
        vm.expectRevert();
        e.resolve(id, 1);
        e.executeTimeout(id);
    }

    function testChallengeBoundary() public {
        uint256 id = submitted();
        evaluate(id, E.Outcome.Pass);
        vm.warp(e.getAgreement(id).challengeDeadline - 1);
        vm.expectRevert();
        e.settle(id);
        vm.warp(e.getAgreement(id).challengeDeadline);
        vm.prank(worker);
        vm.expectRevert();
        e.challenge(id);
        e.settle(id);
    }

    function testAcceptanceFundingAndSubmissionGuards() public {
        vm.prank(client);
        uint256 id = e.create(terms(1e6));
        vm.prank(client);
        vm.expectRevert();
        e.fund(id);
        vm.expectRevert();
        e.accept(id);
        vm.prank(worker);
        e.accept(id);
        vm.prank(worker);
        vm.expectRevert();
        e.submit(id, H);
        vm.startPrank(client);
        t.approve(address(e), 1e6);
        e.fund(id);
        vm.stopPrank();
        vm.expectRevert();
        e.submit(id, H);
        vm.prank(worker);
        e.submit(id, H);
        vm.prank(worker);
        vm.expectRevert();
        e.submit(id, H);
    }

    function testLateSubmission() public {
        uint256 id = funded(1e6);
        vm.warp(e.getAgreement(id).terms.submissionDeadline);
        vm.prank(worker);
        vm.expectRevert();
        e.submit(id, H);
    }

    function testFuzzConservation(uint96 amount, uint96 award) public {
        uint256 a = uint256(amount) % 100e6 + 1;
        uint256 id = funded(a);
        vm.prank(worker);
        e.submit(id, H);
        evaluate(id, E.Outcome.Inconclusive);
        uint256 paid = uint256(award) % (a + 1);
        vm.prank(resolver);
        e.resolve(id, paid);
        require(t.balanceOf(worker) + t.balanceOf(client) == 100e6);
        require(t.balanceOf(address(e)) == 0);
    }

    function testOddTimeoutSplit() public {
        uint256 id = funded(3);
        vm.prank(worker);
        e.submit(id, H);
        evaluate(id, E.Outcome.Inconclusive);
        vm.warp(e.getAgreement(id).resolutionDeadline);
        e.executeTimeout(id);
        require(t.balanceOf(worker) == 1 && t.balanceOf(client) == 100e6 - 1);
    }
}
