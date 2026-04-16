// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCClientTypes} from "./IBCClientTypes.sol";
import {IBCEVMProofBoundary} from "./IBCEVMProofBoundary.sol";
import {IBCEVMTypes} from "./IBCEVMTypes.sol";
import {IBCPathLib} from "./IBCPathLib.sol";
import {PacketLib} from "../libs/PacketLib.sol";
import {SourcePacketCommitmentSlots} from "../source/SourcePacketCommitmentSlots.sol";

/// @title IBCProofVerifier
/// @notice Core helper that verifies packet commitments against a trusted remote client.
abstract contract IBCProofVerifier is IBCEVMProofBoundary {
    constructor(address _ibcClient) IBCEVMProofBoundary(_ibcClient) {}

    function _verifyPacketMembership(
        PacketLib.Packet calldata packet,
        IBCClientTypes.MembershipProof calldata proof
    ) internal view returns (bool) {
        bytes32 path = IBCPathLib.packetCommitmentPath(packet.sourceChainId, packet.sourcePort, packet.sequence);
        bytes32 value = PacketLib.leafHashCalldata(packet);
        return ibcClient.verifyMembership(
            packet.sourceChainId,
            proof.consensusStateHash,
            path,
            value,
            packet.sequence,
            proof.leafIndex,
            proof.siblings
        );
    }

    function _verifyPacketNonMembership(
        uint256 sourceChainId,
        bytes32 consensusStateHash,
        bytes32 path,
        bytes32 value,
        bytes calldata proof
    ) internal view returns (bool) {
        return ibcClient.verifyNonMembership(sourceChainId, consensusStateHash, path, value, proof);
    }

    function _verifyPacketStorageMembership(
        PacketLib.Packet calldata packet,
        IBCEVMTypes.StorageProof calldata leafProof,
        IBCEVMTypes.StorageProof calldata pathProof
    ) internal view returns (bool) {
        bytes32 expectedLeaf = PacketLib.leafHashCalldata(packet);
        bytes32 expectedPath = IBCPathLib.packetCommitmentPath(packet.sourceChainId, packet.sourcePort, packet.sequence);

        if (leafProof.sourceChainId != packet.sourceChainId || pathProof.sourceChainId != packet.sourceChainId) {
            return false;
        }
        if (leafProof.consensusStateHash == bytes32(0) || leafProof.consensusStateHash != pathProof.consensusStateHash) {
            return false;
        }
        if (leafProof.stateRoot == bytes32(0) || leafProof.stateRoot != pathProof.stateRoot) return false;
        if (leafProof.account == address(0) || leafProof.account != pathProof.account) return false;
        if (
            leafProof.account
                != ibcClient.trustedPacketCommitment(leafProof.sourceChainId, leafProof.consensusStateHash)
        ) {
            return false;
        }

        if (leafProof.storageKey != SourcePacketCommitmentSlots.packetLeafAt(packet.sequence)) return false;
        if (pathProof.storageKey != SourcePacketCommitmentSlots.packetPathAt(packet.sequence)) return false;

        bytes memory expectedLeafValue = IBCEVMTypes.rlpEncodeWord(expectedLeaf);
        bytes memory expectedPathValue = IBCEVMTypes.rlpEncodeWord(expectedPath);
        if (keccak256(leafProof.expectedValue) != keccak256(expectedLeafValue)) return false;
        if (keccak256(pathProof.expectedValue) != keccak256(expectedPathValue)) return false;

        return _verifyTrustedEVMStorageProof(leafProof) && _verifyTrustedEVMStorageProof(pathProof);
    }
}
