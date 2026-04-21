// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCEVMProofBoundary} from "./IBCEVMProofBoundary.sol";
import {IBCEVMTypes} from "./IBCEVMTypes.sol";
import {IBCPacketStoreSlots} from "./IBCPacketStoreSlots.sol";
import {IBCPacketLib} from "./IBCPacketLib.sol";

/// @title IBCProofVerifier
/// @notice IBC packet-proof helper bound to BesuLightClient trust-by-height.
abstract contract IBCProofVerifier is IBCEVMProofBoundary {
    constructor(address besuLightClient_) IBCEVMProofBoundary(besuLightClient_) {}

    function _verifyPacketStorageMembership(
        IBCPacketLib.Packet calldata packet,
        address trustedPacketStore,
        IBCEVMTypes.StorageProof calldata leafProof,
        IBCEVMTypes.StorageProof calldata pathProof
    ) internal view returns (bool) {
        bytes32 expectedLeaf = IBCPacketLib.leafHashCalldata(packet);
        bytes32 expectedPath = IBCPacketLib.commitmentPathCalldata(packet);

        if (trustedPacketStore == address(0)) return false;
        if (leafProof.sourceChainId != packet.source.chainId || pathProof.sourceChainId != packet.source.chainId) {
            return false;
        }
        if (leafProof.trustedHeight == 0 || leafProof.trustedHeight != pathProof.trustedHeight) return false;
        if (leafProof.stateRoot == bytes32(0) || leafProof.stateRoot != pathProof.stateRoot) return false;
        if (leafProof.account != trustedPacketStore || pathProof.account != trustedPacketStore) return false;

        if (leafProof.storageKey != IBCPacketStoreSlots.packetLeafAt(packet.sequence)) return false;
        if (pathProof.storageKey != IBCPacketStoreSlots.packetPathAt(packet.sequence)) return false;

        if (keccak256(leafProof.expectedValue) != keccak256(IBCEVMTypes.rlpEncodeWord(expectedLeaf))) return false;
        if (keccak256(pathProof.expectedValue) != keccak256(IBCEVMTypes.rlpEncodeWord(expectedPath))) return false;

        return _verifyTrustedEVMStorageProof(leafProof) && _verifyTrustedEVMStorageProof(pathProof);
    }
}
