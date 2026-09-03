// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {
    IndependentMPTReference,
    MPTProofCorpus,
    MPTProofHarness
} from "../../contracts/test/MPTProofAssurance.sol";

contract MerklePatriciaProofAssuranceTest is Test {
    MPTProofHarness internal harness;
    MPTProofCorpus internal corpus;
    IndependentMPTReference internal referenceVerifier;

    function setUp() public {
        harness = new MPTProofHarness();
        corpus = new MPTProofCorpus();
        referenceVerifier = new IndependentMPTReference();
    }

    function testHashedBranchCorpusMatchesIndependentReference() public view {
        _assertPresent(corpus.hashedBranch());
    }

    function testExtensionAndBranchCorpusMatchesIndependentReference() public view {
        _assertPresent(corpus.extensionBranch());
    }

    function testInlineChildCorpusMatchesIndependentReference() public view {
        MPTProofCorpus.ProofVector memory vector = corpus.inlineBranch();
        _assertPresent(vector);

        bytes[] memory branchItems = harness.readList(vector.proof[0]);
        assertEq(branchItems[1], vector.proof[1], "inline child must retain its complete RLP encoding");
        assertLt(vector.proof[1].length, 32, "corpus child must exercise the inline-reference path");
    }

    function testAbsenceAtMissingBranchChildMatchesIndependentReference() public view {
        _assertAbsent(corpus.branchMissingChild());
    }

    function testAbsenceAtDivergentLeafMatchesIndependentReference() public view {
        _assertAbsent(corpus.divergentLeaf());
    }

    function testAbsenceAtDivergentExtensionMatchesIndependentReference() public view {
        _assertAbsent(corpus.divergentExtension());
    }

    function testRejectsMalformedAndNonCanonicalRlp() public {
        vm.expectRevert(bytes("RLP_TRAILING_BYTES"));
        harness.readList(hex"c000");

        vm.expectRevert(bytes("RLP_NON_CANONICAL_SINGLE_BYTE"));
        harness.readList(hex"c28101");

        vm.expectRevert(bytes("RLP_NON_CANONICAL_LONG_STRING"));
        harness.readList(hex"c3b80180");

        vm.expectRevert(bytes("RLP_NON_CANONICAL_LONG_LIST"));
        harness.readList(hex"f80180");

        vm.expectRevert(bytes("RLP_SHORT_LIST_OOB"));
        harness.readList(hex"c201");

        vm.expectRevert(bytes("RLP_BYTES32_LENGTH"));
        harness.toBytes32(hex"01");

        bytes32 expected = keccak256("fixed-width account storage root");
        assertEq(harness.toBytes32(abi.encodePacked(expected)), expected);
    }

    function testRejectsMalformedCompactPaths() public {
        vm.expectRevert(bytes("HEX_PREFIX_FLAG_INVALID"));
        harness.decodeCompact(hex"40");

        vm.expectRevert(bytes("HEX_PREFIX_PADDING_INVALID"));
        harness.decodeCompact(hex"01");

        vm.expectRevert(bytes("HEX_PREFIX_EMPTY"));
        harness.decodeCompact("");
    }

    function testRejectsCorruptedInlineChild() public view {
        MPTProofCorpus.ProofVector memory vector = corpus.inlineBranch();
        vector.proof[1][vector.proof[1].length - 1] ^= bytes1(uint8(1));
        assertFalse(harness.verify(vector.root, vector.key, vector.proof, vector.value));
        assertFalse(harness.verifyAbsence(vector.root, vector.key, vector.proof));
    }

    function testFuzzMalformedRlpDifferentialFailsClosed(bytes memory candidate, bytes memory key) public view {
        vm.assume(candidate.length > 0 && candidate.length <= 160);
        vm.assume(key.length <= 8);

        bytes[] memory proof = new bytes[](1);
        proof[0] = candidate;
        _assertDifferential(keccak256(candidate), key, proof);
    }

    function testFuzzMutatedCorpusDifferential(uint8 vectorSelector, uint16 rawOffset, bytes1 replacement) public view {
        MPTProofCorpus.ProofVector memory vector;
        if (vectorSelector % 3 == 0) vector = corpus.hashedBranch();
        else if (vectorSelector % 3 == 1) vector = corpus.extensionBranch();
        else vector = corpus.inlineBranch();

        uint256 proofIndex = uint256(rawOffset) % vector.proof.length;
        uint256 byteIndex = uint256(rawOffset) % vector.proof[proofIndex].length;
        vm.assume(vector.proof[proofIndex][byteIndex] != replacement);
        vector.proof[proofIndex][byteIndex] = replacement;
        if (proofIndex == 0) vector.root = keccak256(vector.proof[0]);

        _assertDifferential(vector.root, vector.key, vector.proof);
    }

    function _assertPresent(MPTProofCorpus.ProofVector memory vector) private view {
        assertTrue(harness.verify(vector.root, vector.key, vector.proof, vector.value));
        assertEq(harness.extract(vector.root, vector.key, vector.proof), vector.value);
        assertFalse(harness.verifyAbsence(vector.root, vector.key, vector.proof));

        (bool valid, bool found, bytes memory referenceValue) =
            referenceVerifier.evaluate(vector.root, vector.key, vector.proof);
        assertTrue(valid, "reference rejected corpus proof");
        assertTrue(found, "reference classified corpus member as absent");
        assertEq(referenceValue, vector.value, "reference extracted a different value");
    }

    function _assertAbsent(MPTProofCorpus.ProofVector memory vector) private view {
        assertEq(harness.extract(vector.root, vector.key, vector.proof).length, 0);
        assertTrue(harness.verifyAbsence(vector.root, vector.key, vector.proof));

        (bool valid, bool found,) = referenceVerifier.evaluate(vector.root, vector.key, vector.proof);
        assertTrue(valid, "reference rejected absence witness");
        assertFalse(found, "reference classified absent key as present");
    }

    function _assertDifferential(bytes32 root, bytes memory key, bytes[] memory proof) private view {
        (bool extractCallOk, bytes memory extractResult) = address(harness).staticcall(
            abi.encodeCall(MPTProofHarness.extract, (root, key, proof))
        );
        bytes memory productionValue;
        if (extractCallOk) productionValue = abi.decode(extractResult, (bytes));
        bool productionPresent = extractCallOk && productionValue.length != 0;

        (bool absenceCallOk, bytes memory absenceResult) = address(harness).staticcall(
            abi.encodeCall(MPTProofHarness.verifyAbsence, (root, key, proof))
        );
        bool productionAbsent = absenceCallOk && abi.decode(absenceResult, (bool));

        (bool referenceCallOk, bytes memory referenceResult) = address(referenceVerifier).staticcall(
            abi.encodeCall(IndependentMPTReference.evaluate, (root, key, proof))
        );
        bool referencePresent;
        bool referenceAbsent;
        bytes memory referenceValue;
        if (referenceCallOk) {
            (bool proofValid, bool found, bytes memory value) =
                abi.decode(referenceResult, (bool, bool, bytes));
            referencePresent = proofValid && found;
            referenceAbsent = proofValid && !found;
            referenceValue = value;
        }

        assertEq(productionPresent, referencePresent, "membership differential mismatch");
        assertEq(productionAbsent, referenceAbsent, "absence differential mismatch");
        if (productionPresent) assertEq(productionValue, referenceValue, "value differential mismatch");
    }
}
