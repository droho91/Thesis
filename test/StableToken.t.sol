// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StableToken} from "../contracts/StableToken.sol";

contract StableTokenTest is Test {
    StableToken internal stable;

    address internal user = address(0x3333);

    function setUp() public {
        stable = new StableToken("Stable USD", "sUSD");
    }

    function testOwnerCanMint() public {
        stable.mint(user, 100 ether);
        assertEq(stable.balanceOf(user), 100 ether);
    }

    function testMintRevertsIfNotOwner() public {
        vm.expectRevert(bytes("ONLY_OWNER"));
        vm.prank(user);
        stable.mint(user, 1 ether);
    }

    function testMintRevertsForZeroAmount() public {
        vm.expectRevert(bytes("AMOUNT_ZERO"));
        stable.mint(user, 0);
    }

    function testMintRevertsForZeroAddress() public {
        vm.expectRevert(bytes("TO_ZERO"));
        stable.mint(address(0), 1 ether);
    }
}
