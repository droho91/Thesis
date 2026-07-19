// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {InstitutionalGovernanceTimelock} from "../../contracts/governance/InstitutionalGovernanceTimelock.sol";
import {InstitutionalIdentityRegistry} from "../../contracts/identity/InstitutionalIdentityRegistry.sol";

contract InstitutionalGovernanceTimelockTest is Test {
    uint256 internal constant MINIMUM_DELAY = 2 days;
    address internal constant IDENTITY_ISSUER = address(0x1550);

    InstitutionalGovernanceTimelock internal timelock;
    InstitutionalIdentityRegistry internal registry;

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(this);
        timelock = new InstitutionalGovernanceTimelock(MINIMUM_DELAY, proposers, executors, address(this));
        registry = new InstitutionalIdentityRegistry(address(timelock));
    }

    function testSensitiveRoleChangeRequiresScheduledDelay() public {
        bytes memory data = abi.encodeCall(
            registry.grantRole,
            (registry.IDENTITY_ISSUER_ROLE(), IDENTITY_ISSUER)
        );
        bytes32 salt = keccak256("grant-identity-issuer");
        timelock.schedule(address(registry), 0, data, bytes32(0), salt, MINIMUM_DELAY);

        vm.expectRevert();
        timelock.execute(address(registry), 0, data, bytes32(0), salt);
        assertFalse(registry.hasRole(registry.IDENTITY_ISSUER_ROLE(), IDENTITY_ISSUER));

        vm.warp(block.timestamp + MINIMUM_DELAY);
        timelock.execute(address(registry), 0, data, bytes32(0), salt);
        assertTrue(registry.hasRole(registry.IDENTITY_ISSUER_ROLE(), IDENTITY_ISSUER));
    }

    function testDirectAdministratorBypassIsRejected() public {
        bytes32 complianceRole = registry.COMPLIANCE_ROLE();
        vm.expectRevert();
        registry.grantRole(complianceRole, address(this));
    }
}
