// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title LendingPoolMath
/// @notice Pure arithmetic and parameter invariants shared by the single-market lending pool.
library LendingPoolMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    function debtToSharesUp(uint256 debtAmount, uint256 borrowIndexE18) internal pure returns (uint256) {
        return (debtAmount * WAD + borrowIndexE18 - 1) / borrowIndexE18;
    }

    function sharesToDebt(uint256 shares, uint256 borrowIndexE18) internal pure returns (uint256) {
        return shares * borrowIndexE18 / WAD;
    }

    function assetsToLiquiditySharesUp(uint256 assets, uint256 totalShares, uint256 totalAssets)
        internal
        pure
        returns (uint256)
    {
        if (totalShares == 0 || totalAssets == 0) return assets;
        return (assets * totalShares + totalAssets - 1) / totalAssets;
    }

    function maxLiquidationRepay(uint256 debt, uint256 closeFactorBps) internal pure returns (uint256) {
        uint256 closeAmount = debt * closeFactorBps / BPS;
        return closeAmount == 0 && debt > 0 ? debt : closeAmount;
    }

    function utilizationRateBps(uint256 borrows, uint256 availableCash) internal pure returns (uint256) {
        uint256 supplied = availableCash + borrows;
        if (supplied == 0 || borrows == 0) return 0;
        uint256 utilization = borrows * BPS / supplied;
        return utilization > BPS ? BPS : utilization;
    }

    function borrowRateBps(
        uint256 borrows,
        uint256 availableCash,
        uint256 baseRateBps,
        uint256 kinkUtilizationBps,
        uint256 slope1Bps,
        uint256 slope2Bps
    ) internal pure returns (uint256) {
        uint256 utilization = utilizationRateBps(borrows, availableCash);
        if (utilization <= kinkUtilizationBps) {
            return baseRateBps + slope1Bps * utilization / kinkUtilizationBps;
        }
        uint256 excessUtilization = utilization - kinkUtilizationBps;
        return baseRateBps + slope1Bps + slope2Bps * excessUtilization / (BPS - kinkUtilizationBps);
    }

    function validateRiskThresholds(uint256 factorBps, uint256 thresholdBps) internal pure {
        require(factorBps <= BPS, "BAD_COLLATERAL_FACTOR");
        require(thresholdBps <= BPS, "BAD_LIQUIDATION_THRESHOLD");
        require(thresholdBps >= factorBps, "THRESHOLD_LT_FACTOR");
    }

    function validateLiquidationRiskParameters(uint256 haircutBps, uint256 thresholdBps, uint256 bonusBps)
        internal
        pure
    {
        require(
            haircutBps * thresholdBps * (BPS + bonusBps) <= BPS * BPS * BPS,
            "LIQUIDATION_RISK_INVARIANT"
        );
    }

    function validatePauseMask(uint256 actionMask, uint256 allPauseActions) internal pure {
        require(actionMask != 0 && (actionMask & ~allPauseActions) == 0, "BAD_PAUSE_MASK");
    }

    function validateStoredPauseMask(uint256 actionMask, uint256 allPauseActions) internal pure {
        require((actionMask & ~allPauseActions) == 0, "BAD_PAUSE_MASK");
    }
}
