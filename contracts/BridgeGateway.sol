// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title BridgeGateway
/// @notice Threshold-validator gateway for cross-chain message execution.
/// @dev One instance is deployed per destination-chain action:
///      - LOCK_TO_MINT on chain B (target = WrappedCollateral, selector = mintFromLockEvent)
///      - BURN_TO_UNLOCK on chain A (target = CollateralVault, selector = unlockFromBurnEvent)
contract BridgeGateway {
    uint8 public constant ACTION_LOCK_TO_MINT = 1;
    uint8 public constant ACTION_BURN_TO_UNLOCK = 2;

    address public owner;
    uint256 public immutable sourceChainId;
    uint256 public immutable destinationChainId;
    uint8 public immutable action;
    uint256 public immutable threshold;
    bytes4 public immutable targetSelector;
    bytes4 public immutable burnSelector;

    address public target;
    bool public targetInitialized;
    address public sourceEmitter;
    bool public sourceEmitterInitialized;
    bool public paused;
    uint256 public txCap;

    mapping(address => bool) public isValidator;
    uint256 public validatorCount;

    mapping(bytes32 => uint256) public attestCount;
    mapping(bytes32 => bool) public executed;
    mapping(bytes32 => mapping(address => bool)) public hasAttested;

    event TargetInitialized(address indexed target);
    event SourceEmitterInitialized(address indexed sourceEmitter);
    event PausedUpdated(bool paused);
    event TxCapUpdated(uint256 oldCap, uint256 newCap);
    event Attested(bytes32 indexed messageId, address indexed validator, uint256 count);
    event Executed(
        bytes32 indexed messageId,
        address indexed executor,
        bytes32 indexed srcTxHash,
        uint256 srcLogIndex,
        address user,
        uint256 amount
    );
    event BurnRequested(address indexed user, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier onlyValidator() {
        require(isValidator[msg.sender], "ONLY_VALIDATOR");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    constructor(
        uint256 _sourceChainId,
        uint256 _destinationChainId,
        uint8 _action,
        address[] memory _validators,
        uint256 _threshold,
        bytes4 _targetSelector,
        bytes4 _burnSelector,
        uint256 _txCap
    ) {
        require(_sourceChainId != 0 && _destinationChainId != 0, "BAD_CHAIN_ID");
        require(_sourceChainId != _destinationChainId, "SAME_CHAIN");
        require(_action == ACTION_LOCK_TO_MINT || _action == ACTION_BURN_TO_UNLOCK, "BAD_ACTION");
        require(_validators.length > 0, "NO_VALIDATORS");
        require(_threshold > 0 && _threshold <= _validators.length, "BAD_THRESHOLD");
        require(_targetSelector != bytes4(0), "BAD_SELECTOR");

        sourceChainId = _sourceChainId;
        destinationChainId = _destinationChainId;
        action = _action;
        threshold = _threshold;
        targetSelector = _targetSelector;
        burnSelector = _burnSelector;
        txCap = _txCap;
        owner = msg.sender;

        for (uint256 i = 0; i < _validators.length; i++) {
            address validator = _validators[i];
            require(validator != address(0), "VALIDATOR_ZERO");
            require(!isValidator[validator], "DUP_VALIDATOR");
            isValidator[validator] = true;
            validatorCount++;
        }
    }

    /// @notice Initialize destination contract target once.
    function initializeTarget(address _target) external onlyOwner {
        require(!targetInitialized, "TARGET_ALREADY_SET");
        require(_target != address(0), "TARGET_ZERO");
        target = _target;
        targetInitialized = true;
        emit TargetInitialized(_target);
    }

    /// @notice Initialize expected source-side event emitter once.
    /// @dev Locks the gateway to a specific source contract semantics:
    ///      - mint gateways expect lock events from the remote collateral vault
    ///      - unlock gateways expect burn-request events from the remote mint gateway
    function initializeSourceEmitter(address _sourceEmitter) external onlyOwner {
        require(!sourceEmitterInitialized, "SOURCE_EMITTER_ALREADY_SET");
        require(_sourceEmitter != address(0), "SOURCE_EMITTER_ZERO");
        sourceEmitter = _sourceEmitter;
        sourceEmitterInitialized = true;
        emit SourceEmitterInitialized(_sourceEmitter);
    }

    /// @notice Pause/unpause attestation and execution.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedUpdated(_paused);
    }

    /// @notice Update per-message amount cap. 0 = no cap.
    function setTxCap(uint256 newTxCap) external onlyOwner {
        uint256 oldCap = txCap;
        txCap = newTxCap;
        emit TxCapUpdated(oldCap, newTxCap);
    }

    /// @notice Compute deterministic cross-chain message id.
    function computeMessageId(
        bytes32 srcTxHash,
        uint256 srcLogIndex,
        address user,
        uint256 amount
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                bytes32("THESIS_BRIDGE_V2"),
                address(this),
                sourceEmitter,
                sourceChainId,
                destinationChainId,
                action,
                srcTxHash,
                srcLogIndex,
                user,
                amount
            )
        );
    }

    /// @notice Validator attests source-chain message payload.
    function attest(
        bytes32 srcTxHash,
        uint256 srcLogIndex,
        address user,
        uint256 amount
    ) external onlyValidator whenNotPaused returns (bytes32 messageId) {
        require(targetInitialized, "TARGET_NOT_SET");
        require(sourceEmitterInitialized, "SOURCE_EMITTER_NOT_SET");
        require(user != address(0), "USER_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        if (txCap > 0) require(amount <= txCap, "AMOUNT_ABOVE_CAP");

        messageId = computeMessageId(srcTxHash, srcLogIndex, user, amount);
        require(!executed[messageId], "ALREADY_EXECUTED");
        require(!hasAttested[messageId][msg.sender], "ALREADY_ATTESTED");

        hasAttested[messageId][msg.sender] = true;
        attestCount[messageId] += 1;

        emit Attested(messageId, msg.sender, attestCount[messageId]);
    }

    /// @notice Execute message after threshold attestations.
    function execute(
        bytes32 srcTxHash,
        uint256 srcLogIndex,
        address user,
        uint256 amount
    ) external whenNotPaused returns (bytes32 messageId) {
        require(targetInitialized, "TARGET_NOT_SET");
        require(sourceEmitterInitialized, "SOURCE_EMITTER_NOT_SET");
        require(user != address(0), "USER_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        if (txCap > 0) require(amount <= txCap, "AMOUNT_ABOVE_CAP");

        messageId = computeMessageId(srcTxHash, srcLogIndex, user, amount);
        require(!executed[messageId], "ALREADY_EXECUTED");
        require(attestCount[messageId] >= threshold, "INSUFFICIENT_ATTESTATIONS");

        executed[messageId] = true;
        (bool ok, bytes memory returnData) = target.call(abi.encodeWithSelector(targetSelector, user, amount, messageId));
        if (!ok) {
            _revertWithReason(returnData);
        }

        emit Executed(messageId, msg.sender, srcTxHash, srcLogIndex, user, amount);
    }

    /// @notice User asks gateway to burn wrapped collateral on destination chain.
    /// @dev Enabled only when burnSelector is configured (for LOCK_TO_MINT gateway on chain B).
    function requestBurn(uint256 amount) external whenNotPaused {
        require(targetInitialized, "TARGET_NOT_SET");
        require(burnSelector != bytes4(0), "BURN_DISABLED");
        require(amount > 0, "AMOUNT_ZERO");
        if (txCap > 0) require(amount <= txCap, "AMOUNT_ABOVE_CAP");

        (bool ok, bytes memory returnData) = target.call(abi.encodeWithSelector(burnSelector, msg.sender, amount));
        if (!ok) {
            _revertWithReason(returnData);
        }

        emit BurnRequested(msg.sender, amount);
    }

    function _revertWithReason(bytes memory returnData) private pure {
        if (returnData.length == 0) {
            revert("TARGET_CALL_FAILED");
        }
        assembly {
            revert(add(returnData, 32), mload(returnData))
        }
    }
}
