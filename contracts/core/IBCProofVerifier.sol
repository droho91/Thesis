// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCClient} from "./IBCClient.sol";
import {IBCClientTypes} from "./IBCClientTypes.sol";
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
        bytes32 leaf = PacketLib.leafHashCalldata(packet);
        return ibcClient.verifyMembership(
            packet.sourceChainId,
            proof.consensusStateHash,
            leaf,
            proof.leafIndex,
            proof.siblings
        );
    }
}
