// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title StockToken
/// @notice A tokenized equity with native stock-split support.
/// @dev Balances are stored as internal "shares". The public ERC-20 balance is
///      shares * multiplier / 1e18. A 2-for-1 split doubles `multiplier`, so every
///      holder's balance doubles in one write with no loops. Protocols that need
///      split-proof accounting (like AfterHoursPool) track shares, not balances.
contract StockToken is Ownable {
    uint256 private constant WAD = 1e18;

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    /// @notice Tokens per share, WAD-scaled. Starts at 1e18 (1 token = 1 share).
    uint256 public multiplier = WAD;
    uint256 public totalShares;

    mapping(address => uint256) public sharesOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public minters;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event TransferShares(address indexed from, address indexed to, uint256 shares);
    event Split(uint256 numerator, uint256 denominator, uint256 newMultiplier);
    event MinterSet(address indexed minter, bool allowed);

    error NotMinter();
    error InsufficientBalance();
    error InsufficientAllowance();
    error InvalidSplit();
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, address owner_) Ownable(owner_) {
        name = name_;
        symbol = symbol_;
    }

    // ---------------------------------------------------------------- views

    function totalSupply() external view returns (uint256) {
        return totalShares * multiplier / WAD;
    }

    function balanceOf(address account) external view returns (uint256) {
        return sharesOf[account] * multiplier / WAD;
    }

    function sharesForAmount(uint256 amount) public view returns (uint256) {
        return amount * WAD / multiplier;
    }

    function amountForShares(uint256 shares) public view returns (uint256) {
        return shares * multiplier / WAD;
    }

    // ---------------------------------------------------------------- ERC-20

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, sharesForAmount(amount));
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _move(from, to, sharesForAmount(amount));
        return true;
    }

    // ---------------------------------------------------------------- share-native transfers

    function transferShares(address to, uint256 shares) external returns (bool) {
        _move(msg.sender, to, shares);
        return true;
    }

    /// @notice Moves an exact number of shares, charging the allowance in token units (rounded up).
    function transferSharesFrom(address from, address to, uint256 shares) external returns (bool) {
        uint256 amount = (shares * multiplier + WAD - 1) / WAD;
        _spendAllowance(from, amount);
        _move(from, to, shares);
        return true;
    }

    // ---------------------------------------------------------------- issuer actions

    function setMinter(address minter, bool allowed) external onlyOwner {
        minters[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    function mint(address to, uint256 amount) external {
        if (!minters[msg.sender]) revert NotMinter();
        if (to == address(0)) revert ZeroAddress();
        uint256 shares = sharesForAmount(amount);
        totalShares += shares;
        sharesOf[to] += shares;
        emit Transfer(address(0), to, amount);
        emit TransferShares(address(0), to, shares);
    }

    /// @notice Executes a numerator-for-denominator split (2,1 = 2-for-1; 1,10 = 1-for-10 reverse split).
    function split(uint256 numerator, uint256 denominator) external onlyOwner {
        if (numerator == 0 || denominator == 0) revert InvalidSplit();
        uint256 next = multiplier * numerator / denominator;
        if (next == 0) revert InvalidSplit();
        multiplier = next;
        emit Split(numerator, denominator, next);
    }

    // ---------------------------------------------------------------- internal

    function _spendAllowance(address from, uint256 amount) internal {
        uint256 current = allowance[from][msg.sender];
        if (current != type(uint256).max) {
            if (current < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = current - amount;
            }
        }
    }

    function _move(address from, address to, uint256 shares) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = sharesOf[from];
        if (bal < shares) revert InsufficientBalance();
        unchecked {
            sharesOf[from] = bal - shares;
        }
        sharesOf[to] += shares;
        emit Transfer(from, to, amountForShares(shares));
        emit TransferShares(from, to, shares);
    }
}
