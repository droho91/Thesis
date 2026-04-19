// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCEVMProofBoundaryV2} from "./IBCEVMProofBoundaryV2.sol";
import {IBCEVMTypesV2} from "./IBCEVMTypesV2.sol";
import {IBCPacketStoreSlotsV2} from "./IBCPacketStoreSlotsV2.sol";
import {IBCPacketLibV2} from "./IBCPacketLibV2.sol";

/// @title IBCProofVerifierV2
/// @notice v2 packet-proof helper bound to BesuLightClient trust-by-height.
abstract contract IBCProofVerifierV2 is IBCEVMProofBoundaryV2 {
    constructor(address besuLightClient_) IBCEVMProofBoundaryV2(besuLightClient_) {}

    function _verifyPacketStorageMembership(
        IBCPacketLibV2.Packet calldata packet,
        address trustedPacketStore,
        IBCEVMTypesV2.StorageProof calldata leafProof,
        IBCEVMTypesV2.StorageProof calldata pathProof
    ) internal view returns (bool) {
        bytes32 expectedLeaf = IBCPacketLibV2.leafHashCalldata(packet);
        bytes32 expectedPath = IBCPacketLibV2.commitmentPathCalldata(packet);

        if (trustedPacketStore == address(0)) return false;
        if (leafProof.sourceChainId != packet.source.chainId || pathProof.sourceChainId != packet.source.chainId) {
            return false;
        }
        if (leafProof.trustedHeight == 0 || leafProof.trustedHeight != pathProof.trustedHeight) return false;
        if (leafProof.stateRoot == bytes32(0) || leafProof.stateRoot != pathProof.stateRoot) return false;
        if (leafProof.account != trustedPacketStore || pathProof.account != trustedPacketStore) return false;

        if (leafProof.storageKey != IBCPacketStoreSlotsV2.packetLeafAt(packet.sequence)) return false;
        if (pathProof.storageKey != IBCPacketStoreSlotsV2.packetPathAt(packet.sequence)) return false;

        if (keccak256(leafProof.expectedValue) != keccak256(IBCEVMTypesV2.rlpEncodeWord(expectedLeaf))) return false;
        if (keccak256(pathProof.expectedValue) != keccak256(IBCEVMTypesV2.rlpEncodeWord(expectedPath))) return false;

        return _verifyTrustedEVMStorageProof(leafProof) && _verifyTrustedEVMStorageProof(pathProof);
    }
}
