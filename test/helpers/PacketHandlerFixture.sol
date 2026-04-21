// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BesuLightClientTypes} from "../../contracts/clients/BesuLightClientTypes.sol";
import {IBesuLightClient} from "../../contracts/clients/IBesuLightClient.sol";
import {IBCChannelKeeper} from "../../contracts/core/IBCChannelKeeper.sol";
import {IBCChannelTypes} from "../../contracts/core/IBCChannelTypes.sol";
import {IBCConnectionKeeper} from "../../contracts/core/IBCConnectionKeeper.sol";
import {IBCConnectionTypes} from "../../contracts/core/IBCConnectionTypes.sol";
import {IBCEVMTypes} from "../../contracts/core/IBCEVMTypes.sol";
import {IBCPacketAcknowledgementReceiver, IBCPacketReceiver, IBCPacketTimeoutReceiver} from
    "../../contracts/core/IBCPacketReceiver.sol";
import {IBCPacketHandlerSlots} from "../../contracts/core/IBCPacketHandlerSlots.sol";
import {IBCPacketHandler} from "../../contracts/core/IBCPacketHandler.sol";
import {IBCPacketStoreSlots} from "../../contracts/core/IBCPacketStoreSlots.sol";
import {IBCPacketStore} from "../../contracts/core/IBCPacketStore.sol";
import {IBCPacketLib} from "../../contracts/core/IBCPacketLib.sol";
import {PacketProofBuilder} from "../../contracts/test/PacketProofBuilder.sol";

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

    function beginRecovery(uint256) external pure {}

    function recoverClient(
        uint256,
        BesuLightClientTypes.TrustedHeader calldata,
        BesuLightClientTypes.ValidatorSet calldata
    ) external pure {}

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

contract RecordingPacketReceiver is IBCPacketReceiver {
    address public immutable packetHandler;
    uint256 public receiveCount;
    bytes32 public lastPacketId;
    bytes32 public lastAcknowledgementHash;

    constructor(address packetHandler_) {
        packetHandler = packetHandler_;
    }

    function onRecvPacket(IBCPacketLib.Packet calldata, bytes32 packetId)
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

contract RecordingAcknowledgementApp is IBCPacketAcknowledgementReceiver, IBCPacketTimeoutReceiver {
    address public immutable packetHandler;
    uint256 public acknowledgementCount;
    uint256 public timeoutCount;
    bytes32 public lastPacketId;
    bytes32 public lastAcknowledgementHash;
    bytes32 public lastTimedOutPacketId;

    constructor(address packetHandler_) {
        packetHandler = packetHandler_;
    }

    function onAcknowledgementPacket(
        IBCPacketLib.Packet calldata,
        bytes32 packetId,
        bytes calldata acknowledgement
    ) external {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        acknowledgementCount += 1;
        lastPacketId = packetId;
        lastAcknowledgementHash = keccak256(acknowledgement);
    }

    function onTimeoutPacket(IBCPacketLib.Packet calldata, bytes32 packetId) external {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        timeoutCount += 1;
        lastTimedOutPacketId = packetId;
    }
}

abstract contract PacketHandlerFixture is Test {
    uint256 internal constant CHAIN_A = 100;
    uint256 internal constant CHAIN_B = 200;
    uint256 internal constant TRUSTED_HEIGHT_A = 11;
    uint256 internal constant TRUSTED_HEIGHT_B = 22;

    MockBesuLightClient internal clientB;
    MockBesuLightClient internal clientA;
    IBCConnectionKeeper internal connectionKeeperB;
    IBCConnectionKeeper internal connectionKeeperA;
    IBCChannelKeeper internal channelKeeperB;
    IBCChannelKeeper internal channelKeeperA;
    IBCPacketHandler internal handlerB;
    IBCPacketHandler internal handlerA;
    RecordingPacketReceiver internal receiver;
    RecordingAcknowledgementApp internal sourceApp;
    IBCPacketStore internal localPacketStore;
    PacketProofBuilder internal proofBuilder;

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
        connectionKeeperB = new IBCConnectionKeeper(CHAIN_B, address(clientB), address(this));
        connectionKeeperA = new IBCConnectionKeeper(CHAIN_A, address(clientA), address(this));
        _openConnections();
        channelKeeperB = new IBCChannelKeeper(CHAIN_B, address(connectionKeeperB), address(this));
        channelKeeperA = new IBCChannelKeeper(CHAIN_A, address(connectionKeeperA), address(this));
        handlerB = new IBCPacketHandler(CHAIN_B, address(clientB), address(channelKeeperB), address(this));
        handlerA = new IBCPacketHandler(CHAIN_A, address(clientA), address(channelKeeperA), address(this));
        receiver = new RecordingPacketReceiver(address(handlerB));
        sourceApp = new RecordingAcknowledgementApp(address(handlerA));
        handlerA.setPortApplication(address(sourceApp), address(sourceApp));
        _openRoutes();
        localPacketStore = new IBCPacketStore(CHAIN_A);
        handlerA.setTrustedPacketStore(CHAIN_A, address(localPacketStore));
        localPacketStore.commitPacket(_packet());
        proofBuilder = new PacketProofBuilder();
    }

    function _packet() internal view returns (IBCPacketLib.Packet memory) {
        return IBCPacketLib.Packet({
            sequence: 1,
            source: IBCPacketLib.Endpoint({
                chainId: CHAIN_A,
                port: address(sourceApp),
                channel: bytes32("channel-a")
            }),
            destination: IBCPacketLib.Endpoint({
                chainId: CHAIN_B,
                port: address(receiver),
                channel: bytes32("channel-b")
            }),
            data: IBCPacketLib.encodeTransferData(
                IBCPacketLib.TransferData({
                    sender: address(0x1234),
                    recipient: address(0x5678),
                    asset: address(0xABCDEF),
                    amount: 25 ether,
                    action: IBCPacketLib.ACTION_LOCK_MINT,
                    memo: bytes32(0)
                })
            ),
            timeout: IBCPacketLib.Timeout({height: uint64(TRUSTED_HEIGHT_B), timestamp: 0})
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
            "ics-004"
        );
        channelKeeperA.openChannelRouteUnsafe(
            bytes32("channel-a"),
            bytes32("connection-a"),
            CHAIN_B,
            address(receiver),
            address(sourceApp),
            bytes32("channel-b"),
            IBCChannelTypes.Order.Unordered,
            "ics-004"
        );
    }

    function _packetProofs(
        IBCPacketLib.Packet memory packet,
        address packetStore,
        uint256 trustedHeight,
        BuiltPacketStorageProof memory built
    )
        internal
        pure
        returns (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof)
    {
        leafProof = IBCEVMTypes.StorageProof({
            sourceChainId: packet.source.chainId,
            trustedHeight: trustedHeight,
            stateRoot: built.stateRoot,
            account: packetStore,
            storageKey: built.leafSlot,
            expectedValue: built.expectedLeafTrieValue,
            accountProof: built.accountProof,
            storageProof: built.leafStorageProof
        });
        pathProof = IBCEVMTypes.StorageProof({
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
    ) internal pure returns (IBCEVMTypes.StorageProof memory proof) {
        proof = IBCEVMTypes.StorageProof({
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

    function _buildPacketStorageProof(address packetStore, IBCPacketLib.Packet memory packet)
        internal
        view
        returns (BuiltPacketStorageProof memory built)
    {
        PacketProofBuilder.BuiltPacketStorageProof memory builtByHelper =
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
        PacketProofBuilder.BuiltSingleStorageProof memory builtByHelper =
            proofBuilder.buildSingleStorageProof(account, storageKey, storageWord);
        built = BuiltSingleStorageProof({
            stateRoot: builtByHelper.stateRoot,
            accountProof: builtByHelper.accountProof,
            storageProof: builtByHelper.storageProof,
            expectedTrieValue: builtByHelper.expectedTrieValue
        });
    }
}
