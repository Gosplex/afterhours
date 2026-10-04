// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {MockUSDG} from "./MockUSDG.sol";
import {StockToken} from "./StockToken.sol";
import {MarketOracle} from "./MarketOracle.sol";
import {AfterHoursPool} from "./AfterHoursPool.sol";

/// @title DemoController
/// @notice Testnet-only "director's console". Lets anyone replay real-world market events
///         (session open/close, opening gaps, dividends, splits) in a single transaction so
///         the protocol can be demoed live. It holds keeper rights on the oracle and minter
///         rights on the mock tokens. The owner can switch it off; it is never deployed on mainnet.
contract DemoController is Ownable {
    uint256 internal constant BPS = 10_000;

    MockUSDG public immutable usdg;
    MarketOracle public immutable oracle;
    AfterHoursPool public immutable pool;

    address[] public assets;
    mapping(address => uint256) public basePrice;
    mapping(address => uint256) public faucetAmount;
    uint256 public usdgFaucetAmount = 25_000e6;
    bool public demoEnabled = true;

    event FaucetUsed(address indexed user);
    event PriceMoved(address indexed asset, int256 bps, uint256 newPrice);
    event DividendDeclared(address indexed asset, uint256 perToken, uint256 total);
    event SplitExecuted(address indexed asset, uint256 numerator, uint256 denominator);
    event PricesReset();
    event DemoToggled(bool enabled);

    error DemoDisabled();
    error InvalidMove();
    error UnknownAsset();

    modifier whenDemo() {
        if (!demoEnabled) revert DemoDisabled();
        _;
    }

    constructor(MockUSDG usdg_, MarketOracle oracle_, AfterHoursPool pool_, address owner_) Ownable(owner_) {
        usdg = usdg_;
        oracle = oracle_;
        pool = pool_;
    }

    // ---------------------------------------------------------------- admin

    function addAsset(address asset, uint256 price, uint256 faucetAmount_) external onlyOwner {
        assets.push(asset);
        basePrice[asset] = price;
        faucetAmount[asset] = faucetAmount_;
    }

    function setDemoEnabled(bool enabled) external onlyOwner {
        demoEnabled = enabled;
        emit DemoToggled(enabled);
    }

    function setUsdgFaucetAmount(uint256 amount) external onlyOwner {
        usdgFaucetAmount = amount;
    }

    // ---------------------------------------------------------------- user helpers

    /// @notice Mints a starter portfolio: USDG plus a few shares of every listed stock.
    function faucet() external whenDemo {
        usdg.mint(msg.sender, usdgFaucetAmount);
        for (uint256 i; i < assets.length; ++i) {
            StockToken(assets[i]).mint(msg.sender, faucetAmount[assets[i]]);
        }
        emit FaucetUsed(msg.sender);
    }

    // ---------------------------------------------------------------- market events

    /// @notice Opens or closes the market. Opening publishes a fresh opening price for every asset.
    function setMarketOpen(bool open) public whenDemo {
        oracle.setMarketOpen(open);
        if (open) _refreshPrices();
    }

    /// @notice Opens the market with `asset` gapping by `bps` (e.g. -2500 = down 25%).
    function openWithGap(address asset, int256 bps) external whenDemo {
        oracle.setMarketOpen(true);
        _refreshPrices();
        _move(asset, bps);
    }

    function movePrice(address asset, int256 bps) external whenDemo {
        _move(asset, bps);
    }

    function refreshPrices() external whenDemo {
        _refreshPrices();
    }

    function resetPrices() external whenDemo {
        for (uint256 i; i < assets.length; ++i) {
            oracle.setPrice(assets[i], basePrice[assets[i]]);
        }
        emit PricesReset();
    }

    /// @notice Declares a cash dividend of `perToken` USDG (6 decimals) per share held as collateral.
    function declareDividend(address asset, uint256 perToken) external whenDemo returns (uint256 total) {
        uint256 held = StockToken(asset).amountForShares(pool.totalCollateralShares(asset));
        total = held * perToken / 1e18;
        usdg.mint(address(this), total);
        usdg.approve(address(pool), total);
        pool.distributeDividend(asset, total);
        emit DividendDeclared(asset, perToken, total);
    }

    /// @notice Executes a stock split on the token and rescales the oracle price atomically.
    function split(address asset, uint256 numerator, uint256 denominator) external whenDemo {
        if (basePrice[asset] == 0) revert UnknownAsset();
        StockToken(asset).split(numerator, denominator);
        oracle.applySplit(asset, numerator, denominator);
        basePrice[asset] = basePrice[asset] * denominator / numerator;
        faucetAmount[asset] = faucetAmount[asset] * numerator / denominator;
        emit SplitExecuted(asset, numerator, denominator);
    }

    function getAssets() external view returns (address[] memory) {
        return assets;
    }

    // ---------------------------------------------------------------- internal

    function _refreshPrices() internal {
        for (uint256 i; i < assets.length; ++i) {
            (uint256 price,) = oracle.getPrice(assets[i]);
            oracle.setPrice(assets[i], price);
        }
    }

    function _move(address asset, int256 bps) internal {
        if (basePrice[asset] == 0) revert UnknownAsset();
        if (bps <= -int256(BPS) || bps > 10 * int256(BPS)) revert InvalidMove();
        (uint256 price,) = oracle.getPrice(asset);
        uint256 next = price * uint256(int256(BPS) + bps) / BPS;
        oracle.setPrice(asset, next);
        emit PriceMoved(asset, bps, next);
    }
}
