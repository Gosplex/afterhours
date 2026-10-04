// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDG
/// @notice Testnet stand-in for Paxos' Global Dollar (USDG). 6 decimals, like the real token.
/// @dev On mainnet AfterHours points at the canonical USDG contract instead of this mock.
contract MockUSDG is ERC20, Ownable {
    mapping(address => bool) public minters;

    event MinterSet(address indexed minter, bool allowed);

    error NotMinter();

    constructor(address owner_) ERC20("Global Dollar (Testnet)", "USDG") Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        minters[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    function mint(address to, uint256 amount) external {
        if (!minters[msg.sender]) revert NotMinter();
        _mint(to, amount);
    }
}
