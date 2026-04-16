// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCLocalSimulationBase} from "../helpers/IBCLocalSimulationBase.sol";
import {IBCClient} from "../../contracts/core/IBCClient.sol";
import {IBCClientTypes} from "../../contracts/core/IBCClientTypes.sol";
import {IBCEVMProofBoundary} from "../../contracts/core/IBCEVMProofBoundary.sol";
import {IBCEVMTypes} from "../../contracts/core/IBCEVMTypes.sol";

contract MockIBCClient is IBCClient {
    bytes32 internal trustedRoot;

    function setTrustedRoot(bytes32 root) external {
        trustedRoot = root;
    }

    function status(uint256) external pure returns (IBCClientTypes.Status) {
        return IBCClientTypes.Status.Active;
    }

    function trustedStateRoot(uint256, bytes32) external view returns (bytes32) {
        return trustedRoot;
    }

    function trustedPacketCommitment(uint256, bytes32) external pure returns (address) {
        return address(0);
    }

    function verifyMembership(
        uint256,
        bytes32,
        bytes32,
        bytes32,
        uint256,
        uint256,
        bytes32[] calldata
    ) external pure returns (bool) {
        return false;
    }

    function verifyNonMembership(uint256, bytes32, bytes32, bytes32, bytes calldata) external pure returns (bool) {
        return false;
    }
}

contract EVMProofBoundaryHarness is IBCEVMProofBoundary {
    constructor(address client_) IBCEVMProofBoundary(client_) {}

    function checkStorageProofBoundary(IBCEVMTypes.StorageProof calldata proof) external view returns (bool) {
        return _verifyTrustedEVMStorageProofBoundary(proof);
    }

    function checkStorageProof(IBCEVMTypes.StorageProof calldata proof) external view returns (bool) {
        return _verifyTrustedEVMStorageProof(proof);
    }

    function trustedStateRootFor(uint256 sourceChainId, bytes32 consensusStateHash) external view returns (bytes32) {
        return _trustedStateRoot(sourceChainId, consensusStateHash);
    }
}

contract EVMProofBoundaryTest is IBCLocalSimulationBase {
    EVMProofBoundaryHarness internal boundary;
    MockIBCClient internal mockClient;
    EVMProofBoundaryHarness internal mockBoundary;

    function setUp() public override {
        super.setUp();
        boundary = new EVMProofBoundaryHarness(address(clientB));
        mockClient = new MockIBCClient();
        mockBoundary = new EVMProofBoundaryHarness(address(mockClient));
    }

    function testTrustedStateRootMatchesConsensusState() public {
        (, uint256 sequence) = _sendLock(15 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);

        bytes32 trustedRoot = boundary.trustedStateRootFor(CHAIN_A, finalized.consensusStateHash);
        assertEq(trustedRoot, finalized.sourceCheckpoint.stateRoot);
    }

    function testEVMProofBoundaryAcceptsTrustedStateRootMetadata() public {
        (, uint256 sequence) = _sendLock(15 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);

        bytes[] memory accountProof = new bytes[](1);
        accountProof[0] = hex"01";
        bytes[] memory storageProof = new bytes[](1);
        storageProof[0] = hex"02";

        IBCEVMTypes.StorageProof memory proof = IBCEVMTypes.StorageProof({
            sourceChainId: CHAIN_A,
            consensusStateHash: finalized.consensusStateHash,
            stateRoot: finalized.sourceCheckpoint.stateRoot,
            account: address(packetsA),
            storageKey: keccak256("packet-slot"),
            expectedValue: abi.encode(finalized.sourceCheckpoint.packetRoot),
            accountProof: accountProof,
            storageProof: storageProof
        });

        assertTrue(boundary.checkStorageProofBoundary(proof));
    }

    function testEVMProofBoundaryRejectsWrongTrustedStateRoot() public {
        (, uint256 sequence) = _sendLock(15 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);

        bytes[] memory accountProof = new bytes[](1);
        accountProof[0] = hex"01";
        bytes[] memory storageProof = new bytes[](1);
        storageProof[0] = hex"02";

        IBCEVMTypes.StorageProof memory proof = IBCEVMTypes.StorageProof({
            sourceChainId: CHAIN_A,
            consensusStateHash: finalized.consensusStateHash,
            stateRoot: keccak256("wrong-root"),
            account: address(packetsA),
            storageKey: keccak256("packet-slot"),
            expectedValue: abi.encode(finalized.sourceCheckpoint.packetRoot),
            accountProof: accountProof,
            storageProof: storageProof
        });

        assertFalse(boundary.checkStorageProofBoundary(proof));
    }

    function testVerifyTrustedEVMStorageProofAcceptsSingleLeafAccountAndStorageProof() public {
        bytes32 stateRoot;
        bytes[] memory accountProof;
        bytes[] memory storageProof;
        bytes32 storageKey = keccak256("packet-slot");
        bytes32 storageWord = keccak256("packet-leaf");
        address account = address(0xBEEF);
        bytes memory expectedTrieValue;

        (stateRoot, accountProof, storageProof, expectedTrieValue) = _buildSyntheticStorageProof(account, storageKey, storageWord);
        mockClient.setTrustedRoot(stateRoot);

        IBCEVMTypes.StorageProof memory proof = IBCEVMTypes.StorageProof({
            sourceChainId: CHAIN_A,
            consensusStateHash: bytes32(uint256(1)),
            stateRoot: stateRoot,
            account: account,
            storageKey: storageKey,
            expectedValue: expectedTrieValue,
            accountProof: accountProof,
            storageProof: storageProof
        });

        assertTrue(mockBoundary.checkStorageProof(proof));
    }

    function testVerifyTrustedEVMStorageProofRejectsWrongStorageValue() public {
        bytes32 stateRoot;
        bytes[] memory accountProof;
        bytes[] memory storageProof;
        bytes32 storageKey = keccak256("packet-slot");
        bytes32 storageWord = keccak256("packet-leaf");
        address account = address(0xBEEF);
        bytes memory expectedTrieValue;

        (stateRoot, accountProof, storageProof, expectedTrieValue) = _buildSyntheticStorageProof(account, storageKey, storageWord);
        mockClient.setTrustedRoot(stateRoot);

        IBCEVMTypes.StorageProof memory proof = IBCEVMTypes.StorageProof({
            sourceChainId: CHAIN_A,
            consensusStateHash: bytes32(uint256(1)),
            stateRoot: stateRoot,
            account: account,
            storageKey: storageKey,
            expectedValue: _rlpEncodeBytes(abi.encodePacked(keccak256("wrong-word"))),
            accountProof: accountProof,
            storageProof: storageProof
        });

        assertFalse(mockBoundary.checkStorageProof(proof));
        assertFalse(_equalBytes(expectedTrieValue, proof.expectedValue));
    }

    function _buildSyntheticStorageProof(address account, bytes32 storageKey, bytes32 storageWord)
        internal
        pure
        returns (
            bytes32 stateRoot,
            bytes[] memory accountProof,
            bytes[] memory storageProof,
            bytes memory expectedTrieValue
        )
    {
        bytes memory storageTrieValue = _rlpEncodeBytes(abi.encodePacked(storageWord));
        bytes memory storageLeaf = _rlpEncodeList(_pair(_compactLeaf(_nibbles(abi.encodePacked(keccak256(abi.encodePacked(storageKey))))), storageTrieValue));
        bytes32 storageRoot = keccak256(storageLeaf);

        bytes memory accountValue = _accountValue(storageRoot);
        bytes memory accountLeaf =
            _rlpEncodeList(_pair(_compactLeaf(_nibbles(abi.encodePacked(keccak256(abi.encodePacked(account))))), accountValue));
        stateRoot = keccak256(accountLeaf);

        accountProof = new bytes[](1);
        accountProof[0] = accountLeaf;
        storageProof = new bytes[](1);
        storageProof[0] = storageLeaf;
        expectedTrieValue = storageTrieValue;
    }

    function _accountValue(bytes32 storageRoot) internal pure returns (bytes memory) {
        bytes memory empty = "";
        bytes memory nonce = hex"01";
        bytes memory codeHash = abi.encodePacked(keccak256(""));

        bytes[] memory items = new bytes[](4);
        items[0] = _rlpEncodeBytes(nonce);
        items[1] = _rlpEncodeBytes(empty);
        items[2] = _rlpEncodeBytes(abi.encodePacked(storageRoot));
        items[3] = _rlpEncodeBytes(codeHash);
        return _rlpEncodeList(items);
    }

    function _pair(bytes memory a, bytes memory b) internal pure returns (bytes[] memory items) {
        items = new bytes[](2);
        items[0] = _rlpEncodeBytes(a);
        items[1] = _rlpEncodeBytes(b);
    }

    function _compactLeaf(bytes memory nibbles_) internal pure returns (bytes memory compact) {
        require(nibbles_.length % 2 == 0, "ODD_PATH_NOT_SUPPORTED_IN_FIXTURE");
        compact = new bytes((nibbles_.length / 2) + 1);
        compact[0] = hex"20";
        for (uint256 i = 0; i < nibbles_.length; i += 2) {
            compact[(i / 2) + 1] = bytes1((uint8(nibbles_[i]) << 4) | uint8(nibbles_[i + 1]));
        }
    }

    function _nibbles(bytes memory raw) internal pure returns (bytes memory out) {
        out = new bytes(raw.length * 2);
        for (uint256 i = 0; i < raw.length; i++) {
            uint8 value = uint8(raw[i]);
            out[2 * i] = bytes1(value >> 4);
            out[2 * i + 1] = bytes1(value & 0x0f);
        }
    }

    function _rlpEncodeBytes(bytes memory raw) internal pure returns (bytes memory out) {
        if (raw.length == 1 && uint8(raw[0]) < 0x80) {
            return raw;
        }

        if (raw.length <= 55) {
            out = new bytes(1 + raw.length);
            out[0] = bytes1(uint8(0x80 + raw.length));
            for (uint256 i = 0; i < raw.length; i++) {
                out[i + 1] = raw[i];
            }
            return out;
        }

        bytes memory lengthBytes = _encodeLength(raw.length);
        out = new bytes(1 + lengthBytes.length + raw.length);
        out[0] = bytes1(uint8(0xb7 + lengthBytes.length));
        for (uint256 i = 0; i < lengthBytes.length; i++) {
            out[i + 1] = lengthBytes[i];
        }
        for (uint256 i = 0; i < raw.length; i++) {
            out[1 + lengthBytes.length + i] = raw[i];
        }
    }

    function _rlpEncodeList(bytes[] memory items) internal pure returns (bytes memory out) {
        bytes memory payload;
        for (uint256 i = 0; i < items.length; i++) {
            payload = bytes.concat(payload, items[i]);
        }

        if (payload.length <= 55) {
            out = new bytes(1 + payload.length);
            out[0] = bytes1(uint8(0xc0 + payload.length));
            for (uint256 i = 0; i < payload.length; i++) {
                out[i + 1] = payload[i];
            }
            return out;
        }

        bytes memory lengthBytes = _encodeLength(payload.length);
        out = new bytes(1 + lengthBytes.length + payload.length);
        out[0] = bytes1(uint8(0xf7 + lengthBytes.length));
        for (uint256 i = 0; i < lengthBytes.length; i++) {
            out[i + 1] = lengthBytes[i];
        }
        for (uint256 i = 0; i < payload.length; i++) {
            out[1 + lengthBytes.length + i] = payload[i];
        }
    }

    function _encodeLength(uint256 value) internal pure returns (bytes memory out) {
        uint256 temp = value;
        uint256 length;
        while (temp != 0) {
            length++;
            temp >>= 8;
        }
        out = new bytes(length);
        for (uint256 i = length; i > 0; i--) {
            out[i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }

    function _equalBytes(bytes memory a, bytes memory b) internal pure returns (bool) {
        return keccak256(a) == keccak256(b);
    }
}
