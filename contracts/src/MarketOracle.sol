// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MarketOracle
/// @notice Equity price feed that knows whether the underlying market is trading.
/// @dev Prices use 8 decimals (Chainlink convention). A price only counts as "fresh" if
///      the market is open, it was published after the current session opened, and it is
///      younger than `maxPriceAge`. AfterHoursPool uses this to pick conservative LTVs and
///      to block liquidations on frozen or pre-open prices.
///      Production path: keepers are replaced by Chainlink Data Streams + a market-hours feed.
contract MarketOracle is Ownable {
    uint8 public constant PRICE_DECIMALS = 8;

    enum LiquidationStatus {
        Enabled,
        MarketClosed,
        AwaitingOpeningPrice,
        OpeningGracePeriod,
        PriceStale
    }

    struct PriceData {
        uint128 price;
        uint64 updatedAt;
    }

    mapping(address => PriceData) internal _prices;
    mapping(address => bool) public keepers;

    bool public marketOpen;
    uint64 public lastOpenedAt;
    uint64 public lastClosedAt;
    uint64 public maxPriceAge;
    uint64 public openGracePeriod;

    event KeeperSet(address indexed keeper, bool allowed);
    event PriceUpdated(address indexed asset, uint256 price, uint256 previousPrice);
    event MarketStatusChanged(bool open, uint256 timestamp);
    event SplitApplied(address indexed asset, uint256 numerator, uint256 denominator, uint256 newPrice);
    event ParamsUpdated(uint64 maxPriceAge, uint64 openGracePeriod);

    error NotKeeper();
    error InvalidPrice();
    error LengthMismatch();

    modifier onlyKeeper() {
        if (!keepers[msg.sender] && msg.sender != owner()) revert NotKeeper();
        _;
    }

    constructor(address owner_, uint64 maxPriceAge_, uint64 openGracePeriod_) Ownable(owner_) {
        maxPriceAge = maxPriceAge_;
        openGracePeriod = openGracePeriod_;
        lastClosedAt = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------- admin

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setParams(uint64 maxPriceAge_, uint64 openGracePeriod_) external onlyOwner {
        maxPriceAge = maxPriceAge_;
        openGracePeriod = openGracePeriod_;
        emit ParamsUpdated(maxPriceAge_, openGracePeriod_);
    }

    // ---------------------------------------------------------------- keeper

    function setMarketOpen(bool open) external onlyKeeper {
        if (open == marketOpen) return;
        marketOpen = open;
        if (open) lastOpenedAt = uint64(block.timestamp);
        else lastClosedAt = uint64(block.timestamp);
        emit MarketStatusChanged(open, block.timestamp);
    }

    function setPrice(address asset, uint256 price) public onlyKeeper {
        if (price == 0 || price > type(uint128).max) revert InvalidPrice();
        uint256 previous = _prices[asset].price;
        _prices[asset] = PriceData(uint128(price), uint64(block.timestamp));
        emit PriceUpdated(asset, price, previous);
    }

    function setPrices(address[] calldata assets, uint256[] calldata prices) external onlyKeeper {
        if (assets.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < assets.length; ++i) {
            setPrice(assets[i], prices[i]);
        }
    }

    /// @notice Rescales a price after a stock split so collateral value is unchanged.
    function applySplit(address asset, uint256 numerator, uint256 denominator) external onlyKeeper {
        PriceData storage p = _prices[asset];
        uint256 next = uint256(p.price) * denominator / numerator;
        if (next == 0) revert InvalidPrice();
        p.price = uint128(next);
        emit SplitApplied(asset, numerator, denominator, next);
    }

    // ---------------------------------------------------------------- views

    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt) {
        PriceData memory p = _prices[asset];
        return (p.price, p.updatedAt);
    }

    function isPriceFresh(address asset) public view returns (bool) {
        PriceData memory p = _prices[asset];
        return marketOpen && p.updatedAt >= lastOpenedAt && block.timestamp - p.updatedAt <= maxPriceAge;
    }

    function graceEndsAt() public view returns (uint256) {
        return uint256(lastOpenedAt) + openGracePeriod;
    }

    function liquidationStatus(address asset) public view returns (LiquidationStatus) {
        if (!marketOpen) return LiquidationStatus.MarketClosed;
        PriceData memory p = _prices[asset];
        if (p.updatedAt < lastOpenedAt) return LiquidationStatus.AwaitingOpeningPrice;
        if (block.timestamp < graceEndsAt()) return LiquidationStatus.OpeningGracePeriod;
        if (block.timestamp - p.updatedAt > maxPriceAge) return LiquidationStatus.PriceStale;
        return LiquidationStatus.Enabled;
    }
}
