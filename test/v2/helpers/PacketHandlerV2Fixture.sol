// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BesuLightClientTypes} from "../../../contracts/v2/clients/BesuLightClientTypes.sol";
import {IBesuLightClient} from "../../../contracts/v2/clients/IBesuLightClient.sol";
import {IBCChannelKeeperV2} from "../../../contracts/v2/core/IBCChannelKeeperV2.sol";
import {IBCChannelTypes} from "../../../contracts/v2/core/IBCChannelTypes.sol";
import {IBCConnectionKeeperV2} from "../../../contracts/v2/core/IBCConnectionKeeperV2.sol";
import {IBCConnectionTypes} from "../../../contracts/v2/core/IBCConnectionTypes.sol";
import {IBCEVMTypesV2} from "../../../contracts/v2/core/IBCEVMTypesV2.sol";
import {IBCPacketAcknowledgementReceiverV2, IBCPacketReceiverV2, IBCPacketTimeoutReceiverV2} from
    "../../../contracts/v2/core/IBCPacketReceiverV2.sol";
import {IBCPacketHandlerSlotsV2} from "../../../contracts/v2/core/IBCPacketHandlerSlotsV2.sol";
import {IBCPacketHandlerV2} from "../../../contracts/v2/core/IBCPacketHandlerV2.sol";
import {IBCPacketStoreSlotsV2} from "../../../contracts/v2/core/IBCPacketStoreSlotsV2.sol";
import {IBCPacketStoreV2} from "../../../contracts/v2/core/IBCPacketStoreV2.sol";
import {IBCPacketLibV2} from "../../../contracts/v2/core/IBCPacketLibV2.sol";
import {PacketProofBuilderV2} from "../../../contracts/v2/test/PacketProofBuilderV2.sol";

contract MockBesuLightClient is IBesuLightClient {
    mapping(uint256 => mapping(uint256 => bytes32)) internal roots;
    mapping(uint256 => mapping(uint256 => uint256)) internal timestamps;

    function setTrustedStateRoot(uint256 sourceChainId, uint256 height, bytes32 root) external {
        roots[sourceChainId][height] = root;
    }

    function setTrustedTimestamp(uint256 sourceChainId, uint256 height, uint256 timestamp) external {
        timestamps[sourceChainId][height] = timestamp;
    }

    function status(uint256) external pure returns (BesuLightClientTypes.ClientStatus) {
        return BesuLightClientTypes.ClientStatus.Active;
    }

    function initializeTrustAnchor(
        uint256,
        BesuLightClientTypes.TrustedHeader calldata,
        BesuLightClientTypes.ValidatorSet calldata
    ) external pure {}

    function updateClient(
        BesuLightClientTypes.HeaderUpdate calldata,
        BesuLightClientTypes.ValidatorSet calldata
    ) external pure returns (bytes32) {
        return bytes32(0);
    }

    function trustedStateRoot(uint256 sourceChainId, uint256 height) external view returns (bytes32) {
        return roots[sourceChainId][height];
    }

    function trustedTimestamp(uint256 sourceChainId, uint256 height) external view returns (uint256) {
        return timestamps[sourceChainId][height];
    }

    function trustedHeader(uint256 sourceChainId, uint256 height)
        external
        view
        returns (BesuLightClientTypes.TrustedHeader memory)
    {
        bytes32 root = roots[sourceChainId][height];
        return BesuLightClientTypes.TrustedHeader({
            sourceChainId: sourceChainId,
            height: height,
            headerHash: bytes32(0),
            parentHash: bytes32(0),
            stateRoot: root,
            timestamp: timestamps[sourceChainId][height],
            validatorsHash: bytes32(0),
            exists: root != bytes32(0)
        });
    }

    function validatorSet(uint256, uint256)
        external
        pure
        returns (BesuLightClientTypes.ValidatorSet memory validatorSet_)
    {
        validatorSet_.epoch = 0;
        validatorSet_.activationHeight = 0;
        validatorSet_.validators = new address[](0);
    }
}

contract RecordingPacketReceiverV2 is IBCPacketReceiverV2 {
    address public immutable packetHandler;
    uint256 public receiveCount;
    bytes32 public lastPacketId;
    bytes32 public lastAcknowledgementHash;

    constructor(address packetHandler_) {
        packetHandler = packetHandler_;
    }

    function onRecvPacketV2(IBCPacketLibV2.Packet calldata, bytes32 packetId)
        external
        returns (bytes memory acknowledgement)
    {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        receiveCount += 1;
        lastPacketId = packetId;
        acknowledgement = abi.encodePacked("ok:", packetId);
        lastAcknowledgementHash = keccak256(acknowledgement);
    }
}

contract RecordingAcknowledgementAppV2 is IBCPacketAcknowledgementReceiverV2, IBCPacketTimeoutReceiverV2 {
    address public immutable packetHandler;
    uint256 public acknowledgementCount;
    uint256 public timeoutCount;
    bytes32 public lastPacketId;
    bytes32 public lastAcknowledgementHash;
    bytes32 public lastTimedOutPacketId;

    constructor(address packetHandler_) {
        packetHandler = packetHandler_;
    }

    function onAcknowledgementPacketV2(
        IBCPacketLibV2.Packet calldata,
        bytes32 packetId,
        bytes calldata acknowledgement
    ) external {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        acknowledgementCount += 1;
        lastPacketId = packetId;
        lastAcknowledgementHash = keccak256(acknowledgement);
    }

    function onTimeoutPacketV2(IBCPacketLibV2.Packet calldata, bytes32 packetId) external {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        timeoutCount += 1;
        lastTimedOutPacketId = packetId;
    }
}

abstract contract PacketHandlerV2Fixture is Test {
    uint256 internal constant CHAIN_A = 100;
    uint256 internal constant CHAIN_B = 200;
    uint256 internal constant TRUSTED_HEIGHT_A = 11;
    uint256 internal constant TRUSTED_HEIGHT_B = 22;

    MockBesuLightClient internal clientB;
    MockBesuLightClient internal clientA;
    IBCConnectionKeeperV2 internal connectionKeeperB;
    IBCConnectionKeeperV2 internal connectionKeeperA;
    IBCChannelKeeperV2 internal channelKeeperB;
    IBCChannelKeeperV2 internal channelKeeperA;
    IBCPacketHandlerV2 internal handlerB;
    IBCPacketHandlerV2 internal handlerA;
    RecordingPacketReceiverV2 internal receiver;
    RecordingAcknowledgementAppV2 internal sourceApp;
    IBCPacketStoreV2 internal localPacketStore;
    PacketProofBuilderV2 internal proofBuilder;

    struct BuiltPacketStorageProof {
        bytes32 stateRoot;
        bytes32 leafSlot;
        bytes32 pathSlot;
        bytes[] accountProof;
        bytes[] leafStorageProof;
        bytes[] pathStorageProof;
        bytes expectedLeafTrieValue;
        bytes expectedPathTrieValue;
    }

    struct BuiltSingleStorageProof {
        bytes32 stateRoot;
        bytes[] accountProof;
        bytes[] storageProof;
        bytes expectedTrieValue;
    }

    function setUp() public virtual {
        clientB = new MockBesuLightClient();
        clientA = new MockBesuLightClient();
        connectionKeeperB = new IBCConnectionKeeperV2(CHAIN_B, address(clientB), address(this));
        connectionKeeperA = new IBCConnectionKeeperV2(CHAIN_A, address(clientA), address(this));
        _openConnections();
        channelKeeperB = new IBCChannelKeeperV2(CHAIN_B, address(connectionKeeperB), address(this));
        channelKeeperA = new IBCChannelKeeperV2(CHAIN_A, address(connectionKeeperA), address(this));
        handlerB = new IBCPacketHandlerV2(CHAIN_B, address(clientB), address(channelKeeperB), address(this));
        handlerA = new IBCPacketHandlerV2(CHAIN_A, address(clientA), address(channelKeeperA), address(this));
        receiver = new RecordingPacketReceiverV2(address(handlerB));
        sourceApp = new RecordingAcknowledgementAppV2(address(handlerA));
        handlerA.setPortApplication(address(sourceApp), address(sourceApp));
        _openRoutes();
        localPacketStore = new IBCPacketStoreV2(CHAIN_A);
        handlerA.setTrustedPacketStore(CHAIN_A, address(localPacketStore));
        localPacketStore.commitPacket(_packet());
        proofBuilder = new PacketProofBuilderV2();
    }

    function _packet() internal view returns (IBCPacketLibV2.Packet memory) {
        return IBCPacketLibV2.Packet({
            sequence: 1,
            source: IBCPacketLibV2.Endpoint({
                chainId: CHAIN_A,
                port: address(sourceApp),
                channel: bytes32("channel-a")
            }),
            destination: IBCPacketLibV2.Endpoint({
                chainId: CHAIN_B,
                port: address(receiver),
                channel: bytes32("channel-b")
            }),
            data: IBCPacketLibV2.encodeTransferData(
                IBCPacketLibV2.TransferData({
                    sender: address(0x1234),
                    recipient: address(0x5678),
                    asset: address(0xABCDEF),
                    amount: 25 ether,
                    action: IBCPacketLibV2.ACTION_LOCK_MINT,
                    memo: bytes32(0)
                })
            ),
            timeout: IBCPacketLibV2.Timeout({height: uint64(TRUSTED_HEIGHT_B), timestamp: 0})
        });
    }

    function _openConnections() internal {
        connectionKeeperB.openConnectionUnsafe(
            bytes32("connection-b"),
            bytes32(uint256(CHAIN_A)),
            bytes32(uint256(CHAIN_B)),
            bytes32("connection-a"),
            0,
            bytes("ibc")
        );
        connectionKeeperA.openConnectionUnsafe(
            bytes32("connection-a"),
            bytes32(uint256(CHAIN_B)),
            bytes32(uint256(CHAIN_A)),
            bytes32("connection-b"),
            0,
            bytes("ibc")
        );
    }

    function _openRoutes() internal {
        channelKeeperB.openChannelRouteUnsafe(
            bytes32("channel-b"),
            bytes32("connection-b"),
            CHAIN_A,
            address(sourceApp),
            address(receiver),
            bytes32("channel-a"),
            IBCChannelTypes.Order.Unordered,
            "ics-v2"
        );
        channelKeeperA.openChannelRouteUnsafe(
            bytes32("channel-a"),
            bytes32("connection-a"),
            CHAIN_B,
            address(receiver),
            address(sourceApp),
            bytes32("channel-b"),
            IBCChannelTypes.Order.Unordered,
            "ics-v2"
        );
    }

    function _packetProofs(
        IBCPacketLibV2.Packet memory packet,
        address packetStore,
        uint256 trustedHeight,
        BuiltPacketStorageProof memory built
    )
        internal
        pure
        returns (IBCEVMTypesV2.StorageProof memory leafProof, IBCEVMTypesV2.StorageProof memory pathProof)
    {
        leafProof = IBCEVMTypesV2.StorageProof({
            sourceChainId: packet.source.chainId,
            trustedHeight: trustedHeight,
            stateRoot: built.stateRoot,
            account: packetStore,
            storageKey: built.leafSlot,
            expectedValue: built.expectedLeafTrieValue,
            accountProof: built.accountProof,
            storageProof: built.leafStorageProof
        });
        pathProof = IBCEVMTypesV2.StorageProof({
            sourceChainId: packet.source.chainId,
            trustedHeight: trustedHeight,
            stateRoot: built.stateRoot,
            account: packetStore,
            storageKey: built.pathSlot,
            expectedValue: built.expectedPathTrieValue,
            accountProof: built.accountProof,
            storageProof: built.pathStorageProof
        });
    }

    function _singleProof(
        uint256 sourceChainId,
        uint256 trustedHeight,
        address account,
        bytes32 storageKey,
        BuiltSingleStorageProof memory built
    ) internal pure returns (IBCEVMTypesV2.StorageProof memory proof) {
        proof = IBCEVMTypesV2.StorageProof({
            sourceChainId: sourceChainId,
            trustedHeight: trustedHeight,
            stateRoot: built.stateRoot,
            account: account,
            storageKey: storageKey,
            expectedValue: built.expectedTrieValue,
            accountProof: built.accountProof,
            storageProof: built.storageProof
        });
    }

    function _buildPacketStorageProof(address packetStore, IBCPacketLibV2.Packet memory packet)
        internal
        view
        returns (BuiltPacketStorageProof memory built)
    {
        PacketProofBuilderV2.BuiltPacketStorageProof memory builtByHelper =
            proofBuilder.buildPacketStorageProof(packetStore, packet);
        built = BuiltPacketStorageProof({
            stateRoot: builtByHelper.stateRoot,
            leafSlot: builtByHelper.leafSlot,
            pathSlot: builtByHelper.pathSlot,
            accountProof: builtByHelper.accountProof,
            leafStorageProof: builtByHelper.leafStorageProof,
            pathStorageProof: builtByHelper.pathStorageProof,
            expectedLeafTrieValue: builtByHelper.expectedLeafTrieValue,
            expectedPathTrieValue: builtByHelper.expectedPathTrieValue
        });
    }

    function _buildSingleStorageProof(address account, bytes32 storageKey, bytes32 storageWord)
        internal
        view
        returns (BuiltSingleStorageProof memory built)
    {
        PacketProofBuilderV2.BuiltSingleStorageProof memory builtByHelper =
            proofBuilder.buildSingleStorageProof(account, storageKey, storageWord);
        built = BuiltSingleStorageProof({
            stateRoot: builtByHelper.stateRoot,
            accountProof: builtByHelper.accountProof,
            storageProof: builtByHelper.storageProof,
            expectedTrieValue: builtByHelper.expectedTrieValue
        });
    }
}
