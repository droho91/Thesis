// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBankPolicyEngine
/// @notice institutional policy surface. The transport layer should prove facts; this interface
///         decides whether an institution is willing to act on those facts.
interface IBankPolicyEngine {
    function canMintVoucher(
        uint256 sourceChainId,
        address beneficiary,
        address canonicalAsset,
        uint256 amount
    ) external view returns (bool allowed, bytes32 policyCode);

    function canUnlockCanonical(
        uint256 sourceChainId,
        address beneficiary,
        address canonicalAsset,
        uint256 amount
    ) external view returns (bool allowed, bytes32 policyCode);

    function canAcceptCollateral(address account, address collateralAsset, uint256 amount)
        external
        view
        returns (bool allowed, bytes32 policyCode);

    function canBorrow(address account, address debtAsset, uint256 amount)
        external
        view
        returns (bool allowed, bytes32 policyCode);

    function noteVoucherMinted(uint256 sourceChainId, address beneficiary, address canonicalAsset, uint256 amount)
        external;

    function noteVoucherBurned(address account, address canonicalAsset, uint256 amount) external;

    function noteCanonicalUnlocked(uint256 sourceChainId, address beneficiary, address canonicalAsset, uint256 amount)
        external;

    function noteCollateralAccepted(address account, address collateralAsset, uint256 amount) external;

    function noteCollateralReleased(address account, address collateralAsset, uint256 amount) external;

    function noteDebtBorrowed(address account, address debtAsset, uint256 amount) external;

    function noteDebtRepaid(address account, address debtAsset, uint256 amount) external;

    function noteDebtWrittenOff(address account, address debtAsset, uint256 amount) external;
}
