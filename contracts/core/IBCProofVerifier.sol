// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCClient} from "./IBCClient.sol";
import {IBCClientTypes} from "./IBCClientTypes.sol";
import {IBCPathLib} from "./IBCPathLib.sol";
import {PacketLib} from "../libs/PacketLib.sol";

/// @title IBCProofVerifier
/// @notice Core helper that verifies packet commitments against a trusted remote client.
abstract contract IBCProofVerifier {
    IBCClient public immutable ibcClient;

    constructor(address _ibcClient) {
        require(_ibcClient != address(0), "CLIENT_ZERO");
        ibcClient = IBCClient(_ibcClient);
    }

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
}
