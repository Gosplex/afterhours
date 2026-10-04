// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MarketOracle} from "./MarketOracle.sol";
import {StockToken} from "./StockToken.sol";

/// @title AfterHoursPool
/// @notice Borrow USDG against tokenized stocks, around the clock.
///
///  What makes it different from a generic lending market:
///  1. Market-hours risk: each asset has an "open" LTV and a tighter "closed" LTV. When the
///     US market is closed (or the price is stale), new borrows use the closed LTV.
///  2. Gap reserve: borrows taken while the market is closed pay a small fee into a reserve
///     that absorbs bad debt from opening-bell price gaps before suppliers take any loss.
///  3. No liquidations on frozen prices: liquidations only run while the market is open, on
///     a price published after the open, and after a short opening grace period.
///  4. Dividends repay debt: dividends paid on deposited stock are applied to the
///     depositor's loan first; any excess becomes claimable USDG.
///  5. Split-proof collateral: positions are tracked in StockToken shares, so splits never
///     move anyone's health factor.
contract AfterHoursPool is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant USDG_TO_WAD = 1e12; // USDG has 6 decimals
    uint256 internal constant PRICE_SCALE = 1e8;
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;
    uint256 internal constant MAX_ASSETS = 16;

    // ------------------------------------------------------------------ types

    struct AssetConfig {
        bool listed;
        bool borrowEnabled; // false = asset can no longer be added as collateral
        uint16 ltvOpenBps;
        uint16 ltvClosedBps;
        uint16 liqThresholdBps;
        uint16 liqBonusBps;
    }

    struct RateModel {
        uint64 baseRateWad; // per year
        uint64 slope1Wad; // per year, up to kink
        uint64 slope2Wad; // per year, above kink
        uint64 kinkWad; // utilization
    }

    struct AccountView {
        uint256 collateralValue; // USD, WAD
        uint256 borrowLimit; // USD, WAD - uses the LTV for the current market state
        uint256 openBorrowLimit; // USD, WAD - what the limit would be with the market open
        uint256 closedBorrowLimit; // USD, WAD - what the limit would be with the market closed
        uint256 liquidationLimit; // USD, WAD
        uint256 debt; // USDG, after pending dividends are applied
        uint256 pendingDividends; // USDG not yet settled
        uint256 dividendCredit; // USDG claimable now (incl. pending excess)
        uint256 healthFactor; // WAD, type(uint256).max when no debt
        uint256 availableToBorrow; // USDG
        uint256 supplyBalance; // USDG
        uint256 supplyShares;
    }

    struct AssetView {
        address token;
        string symbol;
        string name;
        uint256 price; // 8 decimals
        uint256 updatedAt;
        bool priceFresh;
        uint8 liquidationStatus;
        uint16 ltvOpenBps;
        uint16 ltvClosedBps;
        uint16 liqThresholdBps;
        uint16 liqBonusBps;
        uint16 activeLtvBps;
        uint256 userCollateral; // token units
        uint256 userCollateralShares;
        uint256 userCollateralValue; // USD, WAD
        uint256 walletBalance; // token units
        uint256 walletAllowance;
        uint256 totalCollateral; // token units
        uint256 pendingDividend; // USDG
    }

    struct PoolView {
        uint256 liquidity; // USDG available to borrow / withdraw
        uint256 totalBorrows;
        uint256 totalSupplyAssets;
        uint256 utilizationWad;
        uint256 borrowRateWad; // APR
        uint256 supplyRateWad; // APR
        uint256 gapReserve;
        uint256 protocolReserves;
        uint256 dividendLiabilities;
        uint256 totalCollateralValue; // USD, WAD
        uint16 afterHoursFeeBps;
        uint16 reserveFactorBps;
        bool marketOpen;
        uint256 lastOpenedAt;
        uint256 lastClosedAt;
        uint256 graceEndsAt;
        uint256 openGracePeriod;
        uint256 maxPriceAge;
        bool paused;
        uint256 timestamp;
    }

    // ------------------------------------------------------------------ storage

    IERC20 public immutable usdg;
    MarketOracle public oracle;

    address[] public assetList;
    mapping(address => AssetConfig) public assetConfig;

    // Collateral (tracked in StockToken shares)
    mapping(address => mapping(address => uint256)) public collateralShares; // user => asset => shares
    mapping(address => uint256) public totalCollateralShares; // asset => shares

    // Dividends
    mapping(address => uint256) public accDividendPerShare; // asset => RAY-scaled USDG per share
    mapping(address => mapping(address => uint256)) internal _dividendCheckpoint; // user => asset
    mapping(address => uint256) public dividendCredit; // user => USDG claimable
    uint256 public unsettledDividends;
    uint256 public totalDividendCredit;

    // Lending
    uint256 public cash; // internal USDG accounting (donations are ignored)
    uint256 public totalSupplyShares;
    mapping(address => uint256) public supplyShares;
    uint256 public borrowIndex = RAY;
    uint256 public lastAccrual;
    uint256 public totalScaledDebt;
    mapping(address => uint256) public scaledDebt;
    uint256 public protocolReserves;
    uint256 public gapReserve;

    // Parameters
    RateModel public rateModel;
    uint16 public reserveFactorBps = 1_000; // 10% of interest
    uint16 public afterHoursFeeBps = 30; // 0.30% fee on closed-market borrows -> gap reserve
    uint16 public closeFactorBps = 5_000; // max 50% of debt per liquidation...
    uint64 public fullCloseHealthFactor = 0.95e18; // ...unless health factor is below this

    // ------------------------------------------------------------------ events

    event AssetListed(address indexed asset, AssetConfig config);
    event AssetConfigUpdated(address indexed asset, AssetConfig config);
    event Supplied(address indexed user, uint256 amount, uint256 shares);
    event SupplyWithdrawn(address indexed user, uint256 amount, uint256 shares);
    event CollateralDeposited(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event CollateralWithdrawn(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event Borrowed(address indexed user, uint256 amount, uint256 fee, bool marketOpen);
    event Repaid(address indexed payer, address indexed borrower, uint256 amount);
    event Liquidated(
        address indexed liquidator,
        address indexed borrower,
        address indexed asset,
        uint256 repaid,
        uint256 seizedAmount,
        uint256 seizedShares
    );
    event BadDebtCovered(address indexed borrower, uint256 fromGapReserve, uint256 socialized);
    event DividendDistributed(address indexed asset, uint256 amount, uint256 accPerShare);
    event DividendApplied(address indexed user, uint256 repaid, uint256 credited);
    event DividendClaimed(address indexed user, uint256 amount);
    event GapReserveFunded(address indexed from, uint256 amount);
    event ProtocolReservesWithdrawn(address indexed to, uint256 amount);
    event ParamsUpdated(uint16 reserveFactorBps, uint16 afterHoursFeeBps, uint16 closeFactorBps, uint64 fullCloseHf);
    event RateModelUpdated(RateModel model);
    event OracleUpdated(address oracle);

    // ------------------------------------------------------------------ errors

    error AssetNotListed();
    error AssetAlreadyListed();
    error AssetDisabled();
    error TooManyAssets();
    error InvalidConfig();
    error ZeroAmount();
    error InsufficientLiquidity();
    error InsufficientCollateral();
    error InsufficientBalance();
    error ExceedsBorrowLimit();
    error PositionHealthy();
    error LiquidationsPaused(MarketOracle.LiquidationStatus status);
    error NothingToRepay();
    error NoDividends();

    // ------------------------------------------------------------------ constructor

    constructor(IERC20 usdg_, MarketOracle oracle_, address owner_) Ownable(owner_) {
        usdg = usdg_;
        oracle = oracle_;
        lastAccrual = block.timestamp;
        rateModel = RateModel({baseRateWad: 0.02e18, slope1Wad: 0.08e18, slope2Wad: 1.0e18, kinkWad: 0.8e18});
    }

    // ================================================================== admin

    function listAsset(address asset, AssetConfig calldata cfg) external onlyOwner {
        if (assetConfig[asset].listed) revert AssetAlreadyListed();
        if (assetList.length >= MAX_ASSETS) revert TooManyAssets();
        _validate(cfg);
        AssetConfig memory c = cfg;
        c.listed = true;
        assetConfig[asset] = c;
        assetList.push(asset);
        emit AssetListed(asset, c);
    }

    function setAssetConfig(address asset, AssetConfig calldata cfg) external onlyOwner {
        if (!assetConfig[asset].listed) revert AssetNotListed();
        _validate(cfg);
        AssetConfig memory c = cfg;
        c.listed = true;
        assetConfig[asset] = c;
        emit AssetConfigUpdated(asset, c);
    }

    function setParams(uint16 reserveFactor, uint16 afterHoursFee, uint16 closeFactor, uint64 fullCloseHf)
        external
        onlyOwner
    {
        if (reserveFactor > 5_000 || afterHoursFee > 500 || closeFactor == 0 || closeFactor > BPS) {
            revert InvalidConfig();
        }
        _accrue();
        reserveFactorBps = reserveFactor;
        afterHoursFeeBps = afterHoursFee;
        closeFactorBps = closeFactor;
        fullCloseHealthFactor = fullCloseHf;
        emit ParamsUpdated(reserveFactor, afterHoursFee, closeFactor, fullCloseHf);
    }

    function setRateModel(RateModel calldata model) external onlyOwner {
        if (model.kinkWad == 0 || model.kinkWad >= WAD) revert InvalidConfig();
        _accrue();
        rateModel = model;
        emit RateModelUpdated(model);
    }

    function setOracle(MarketOracle oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleUpdated(address(oracle_));
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function withdrawProtocolReserves(address to, uint256 amount) external onlyOwner nonReentrant {
        _accrue();
        if (amount > protocolReserves || amount > cash) revert InsufficientLiquidity();
        protocolReserves -= amount;
        cash -= amount;
        usdg.safeTransfer(to, amount);
        emit ProtocolReservesWithdrawn(to, amount);
    }

    // ================================================================== suppliers

    function supply(uint256 amount) external nonReentrant whenNotPaused returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        shares = amount * (totalSupplyShares + VIRTUAL_SHARES) / (_totalSupplyAssets() + VIRTUAL_ASSETS);
        if (shares == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        cash += amount;
        totalSupplyShares += shares;
        supplyShares[msg.sender] += shares;
        emit Supplied(msg.sender, amount, shares);
    }

    /// @param amount USDG to withdraw; type(uint256).max withdraws everything available.
    function withdrawSupply(uint256 amount) external nonReentrant returns (uint256 shares) {
        _accrue();
        uint256 assets = _totalSupplyAssets();
        uint256 userShares = supplyShares[msg.sender];
        uint256 balance = userShares * (assets + VIRTUAL_ASSETS) / (totalSupplyShares + VIRTUAL_SHARES);
        if (amount == type(uint256).max) amount = balance;
        if (amount == 0) revert ZeroAmount();
        if (amount > balance) revert InsufficientBalance();
        if (amount > _liquidity()) revert InsufficientLiquidity();

        shares = Math.mulDiv(
            amount, totalSupplyShares + VIRTUAL_SHARES, assets + VIRTUAL_ASSETS, Math.Rounding.Ceil
        );
        if (shares > userShares) shares = userShares;

        supplyShares[msg.sender] = userShares - shares;
        totalSupplyShares -= shares;
        cash -= amount;
        usdg.safeTransfer(msg.sender, amount);
        emit SupplyWithdrawn(msg.sender, amount, shares);
    }

    // ================================================================== collateral

    function depositCollateral(address asset, uint256 amount) public nonReentrant whenNotPaused {
        _depositCollateral(msg.sender, asset, amount);
    }

    function withdrawCollateral(address asset, uint256 amount) external nonReentrant {
        AssetConfig memory cfg = assetConfig[asset];
        if (!cfg.listed) revert AssetNotListed();
        _accrue();
        _settle(msg.sender);

        StockToken token = StockToken(asset);
        uint256 userShares = collateralShares[msg.sender][asset];
        uint256 shares = amount == type(uint256).max
            ? userShares
            : Math.mulDiv(amount, WAD, token.multiplier(), Math.Rounding.Ceil);
        if (shares == 0) revert ZeroAmount();
        if (shares > userShares) revert InsufficientCollateral();

        collateralShares[msg.sender][asset] = userShares - shares;
        totalCollateralShares[asset] -= shares;
        _checkpoint(msg.sender, asset);

        if (_debtOf(msg.sender) > 0) {
            (, uint256 limit,) = _accountLimits(msg.sender);
            if (_debtOf(msg.sender) * USDG_TO_WAD > limit) revert ExceedsBorrowLimit();
        }

        token.transferShares(msg.sender, shares);
        emit CollateralWithdrawn(msg.sender, asset, token.amountForShares(shares), shares);
    }

    // ================================================================== borrowing

    function borrow(uint256 amount) public nonReentrant whenNotPaused {
        _borrow(msg.sender, amount);
    }

    /// @notice One-click: post collateral and borrow in a single transaction.
    function depositAndBorrow(address asset, uint256 collateralAmount, uint256 borrowAmount)
        external
        nonReentrant
        whenNotPaused
    {
        if (collateralAmount > 0) _depositCollateral(msg.sender, asset, collateralAmount);
        if (borrowAmount > 0) _borrow(msg.sender, borrowAmount);
    }

    /// @param amount USDG to repay; type(uint256).max repays the full debt.
    function repay(address borrower, uint256 amount) external nonReentrant returns (uint256 paid) {
        _accrue();
        _settle(borrower);
        uint256 debt = _debtOf(borrower);
        if (debt == 0) revert NothingToRepay();
        paid = amount > debt ? debt : amount;
        if (paid == 0) revert ZeroAmount();

        usdg.safeTransferFrom(msg.sender, address(this), paid);
        cash += paid;
        _reduceDebt(borrower, paid, debt);
        emit Repaid(msg.sender, borrower, paid);
    }

    // ================================================================== liquidation

    /// @notice Repay part of an unhealthy loan and seize collateral at a discount.
    /// @dev Only runs while the market is open, on a post-open price, after the grace period.
    function liquidate(address borrower, address asset, uint256 repayAmount)
        external
        nonReentrant
        returns (uint256 repaid, uint256 seizedShares)
    {
        AssetConfig memory cfg = assetConfig[asset];
        if (!cfg.listed) revert AssetNotListed();
        MarketOracle.LiquidationStatus status = oracle.liquidationStatus(asset);
        if (status != MarketOracle.LiquidationStatus.Enabled) revert LiquidationsPaused(status);

        _accrue();
        _settle(borrower);

        uint256 debt = _debtOf(borrower);
        uint256 hf = _healthFactor(borrower, debt);
        if (hf >= WAD) revert PositionHealthy();

        uint256 maxRepay = hf < fullCloseHealthFactor ? debt : debt * closeFactorBps / BPS;
        repaid = repayAmount > maxRepay ? maxRepay : repayAmount;
        if (repaid == 0) revert ZeroAmount();

        StockToken token = StockToken(asset);
        (uint256 price,) = oracle.getPrice(asset);
        uint256 userShares = collateralShares[borrower][asset];

        uint256 seizeValue = repaid * USDG_TO_WAD * (BPS + cfg.liqBonusBps) / BPS;
        seizedShares = token.sharesForAmount(seizeValue * PRICE_SCALE / price);
        if (seizedShares > userShares) {
            seizedShares = userShares;
            uint256 collateralValue = token.amountForShares(userShares) * price / PRICE_SCALE;
            repaid = collateralValue * BPS / (BPS + cfg.liqBonusBps) / USDG_TO_WAD;
        }
        if (seizedShares == 0 || repaid == 0) revert InsufficientCollateral();

        usdg.safeTransferFrom(msg.sender, address(this), repaid);
        cash += repaid;
        _reduceDebt(borrower, repaid, debt);

        collateralShares[borrower][asset] = userShares - seizedShares;
        totalCollateralShares[asset] -= seizedShares;
        _checkpoint(borrower, asset);
        token.transferShares(msg.sender, seizedShares);

        emit Liquidated(msg.sender, borrower, asset, repaid, token.amountForShares(seizedShares), seizedShares);

        _absorbBadDebtIfEmpty(borrower);
    }

    // ================================================================== dividends

    /// @notice Pay a dividend on all `asset` held as collateral. Applied to each holder's
    ///         debt first, then credited as claimable USDG.
    function distributeDividend(address asset, uint256 amount) external nonReentrant {
        if (!assetConfig[asset].listed) revert AssetNotListed();
        uint256 total = totalCollateralShares[asset];
        if (total == 0 || amount == 0) revert NoDividends();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        cash += amount;
        unsettledDividends += amount;
        accDividendPerShare[asset] += amount * RAY / total;
        emit DividendDistributed(asset, amount, accDividendPerShare[asset]);
    }

    function settle(address user) external nonReentrant {
        _accrue();
        _settle(user);
    }

    function claimDividends() external nonReentrant returns (uint256 amount) {
        _accrue();
        _settle(msg.sender);
        amount = dividendCredit[msg.sender];
        if (amount == 0) revert NoDividends();
        dividendCredit[msg.sender] = 0;
        totalDividendCredit -= amount;
        cash -= amount;
        usdg.safeTransfer(msg.sender, amount);
        emit DividendClaimed(msg.sender, amount);
    }

    function fundGapReserve(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        cash += amount;
        gapReserve += amount;
        emit GapReserveFunded(msg.sender, amount);
    }

    // ================================================================== views

    function assetCount() external view returns (uint256) {
        return assetList.length;
    }

    function getAssets() external view returns (address[] memory) {
        return assetList;
    }

    function debtOf(address user) public view returns (uint256) {
        (uint256 index,) = _projectedIndex();
        return Math.mulDiv(scaledDebt[user], index, RAY, Math.Rounding.Ceil);
    }

    function getAccount(address user) external view returns (AccountView memory a) {
        (a.collateralValue, a.borrowLimit, a.liquidationLimit) = _accountLimits(user);
        (a.openBorrowLimit, a.closedBorrowLimit) = _openClosedLimits(user);

        uint256 gross = debtOf(user);
        a.pendingDividends = _pendingDividends(user);
        uint256 applied = a.pendingDividends > gross ? gross : a.pendingDividends;
        a.debt = gross - applied;
        a.dividendCredit = dividendCredit[user] + (a.pendingDividends - applied);

        uint256 debtWad = a.debt * USDG_TO_WAD;
        a.healthFactor = debtWad == 0 ? type(uint256).max : a.liquidationLimit * WAD / debtWad;

        uint256 headroom = a.borrowLimit > debtWad ? (a.borrowLimit - debtWad) / USDG_TO_WAD : 0;
        uint256 liq = _projectedLiquidity();
        a.availableToBorrow = headroom > liq ? liq : headroom;

        a.supplyShares = supplyShares[user];
        a.supplyBalance =
            a.supplyShares * (_projectedTotalSupplyAssets() + VIRTUAL_ASSETS) / (totalSupplyShares + VIRTUAL_SHARES);
    }

    function getAssetViews(address user) external view returns (AssetView[] memory views) {
        uint256 n = assetList.length;
        views = new AssetView[](n);
        for (uint256 i; i < n; ++i) {
            address asset = assetList[i];
            AssetConfig memory cfg = assetConfig[asset];
            StockToken token = StockToken(asset);
            AssetView memory v = views[i];
            v.token = asset;
            v.symbol = token.symbol();
            v.name = token.name();
            (v.price, v.updatedAt) = oracle.getPrice(asset);
            v.priceFresh = oracle.isPriceFresh(asset);
            v.liquidationStatus = uint8(oracle.liquidationStatus(asset));
            v.ltvOpenBps = cfg.ltvOpenBps;
            v.ltvClosedBps = cfg.ltvClosedBps;
            v.liqThresholdBps = cfg.liqThresholdBps;
            v.liqBonusBps = cfg.liqBonusBps;
            v.activeLtvBps = v.priceFresh ? cfg.ltvOpenBps : cfg.ltvClosedBps;
            v.userCollateralShares = collateralShares[user][asset];
            v.userCollateral = token.amountForShares(v.userCollateralShares);
            v.userCollateralValue = v.userCollateral * v.price / PRICE_SCALE;
            v.totalCollateral = token.amountForShares(totalCollateralShares[asset]);
            if (user != address(0)) {
                v.walletBalance = token.balanceOf(user);
                v.walletAllowance = token.allowance(user, address(this));
            }
            v.pendingDividend = _pendingDividendFor(user, asset);
        }
    }

    function getPoolState() external view returns (PoolView memory p) {
        (uint256 index, uint256 newReserves) = _projectedIndex();
        p.totalBorrows = Math.mulDiv(totalScaledDebt, index, RAY, Math.Rounding.Ceil);
        p.protocolReserves = protocolReserves + newReserves;
        p.gapReserve = gapReserve;
        p.dividendLiabilities = unsettledDividends + totalDividendCredit;
        p.liquidity = _projectedLiquidity();
        p.totalSupplyAssets = _projectedTotalSupplyAssets();
        uint256 denom = p.totalBorrows + p.liquidity;
        p.utilizationWad = denom == 0 ? 0 : p.totalBorrows * WAD / denom;
        p.borrowRateWad = _borrowRate(p.utilizationWad);
        p.supplyRateWad = p.borrowRateWad * p.utilizationWad / WAD * (BPS - reserveFactorBps) / BPS;
        for (uint256 i; i < assetList.length; ++i) {
            address asset = assetList[i];
            (uint256 price,) = oracle.getPrice(asset);
            p.totalCollateralValue +=
                StockToken(asset).amountForShares(totalCollateralShares[asset]) * price / PRICE_SCALE;
        }
        p.afterHoursFeeBps = afterHoursFeeBps;
        p.reserveFactorBps = reserveFactorBps;
        p.marketOpen = oracle.marketOpen();
        p.lastOpenedAt = oracle.lastOpenedAt();
        p.lastClosedAt = oracle.lastClosedAt();
        p.graceEndsAt = oracle.graceEndsAt();
        p.openGracePeriod = oracle.openGracePeriod();
        p.maxPriceAge = oracle.maxPriceAge();
        p.paused = paused();
        p.timestamp = block.timestamp;
    }

    // ================================================================== internal: actions

    function _depositCollateral(address user, address asset, uint256 amount) internal {
        AssetConfig memory cfg = assetConfig[asset];
        if (!cfg.listed) revert AssetNotListed();
        if (!cfg.borrowEnabled) revert AssetDisabled();
        if (amount == 0) revert ZeroAmount();
        _accrue();
        _settle(user);

        StockToken token = StockToken(asset);
        uint256 shares = token.sharesForAmount(amount);
        if (shares == 0) revert ZeroAmount();
        token.transferSharesFrom(user, address(this), shares);

        collateralShares[user][asset] += shares;
        totalCollateralShares[asset] += shares;
        _checkpoint(user, asset);
        emit CollateralDeposited(user, asset, amount, shares);
    }

    function _borrow(address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        _settle(user);
        if (amount > _liquidity()) revert InsufficientLiquidity();

        bool open = oracle.marketOpen();
        uint256 fee = open ? 0 : amount * afterHoursFeeBps / BPS;

        uint256 index = borrowIndex;
        uint256 scaled = Math.mulDiv(amount, RAY, index, Math.Rounding.Ceil);
        scaledDebt[user] += scaled;
        totalScaledDebt += scaled;

        (, uint256 limit,) = _accountLimits(user);
        if (_debtOf(user) * USDG_TO_WAD > limit) revert ExceedsBorrowLimit();

        cash -= amount - fee;
        gapReserve += fee;
        usdg.safeTransfer(user, amount - fee);
        emit Borrowed(user, amount, fee, open);
    }

    function _reduceDebt(address borrower, uint256 amount, uint256 currentDebt) internal {
        uint256 scaled = scaledDebt[borrower];
        uint256 reduce = amount >= currentDebt ? scaled : amount * RAY / borrowIndex;
        if (reduce > scaled) reduce = scaled;
        scaledDebt[borrower] = scaled - reduce;
        totalScaledDebt -= reduce;
    }

    function _absorbBadDebtIfEmpty(address borrower) internal {
        uint256 debt = _debtOf(borrower);
        if (debt == 0) return;
        for (uint256 i; i < assetList.length; ++i) {
            if (collateralShares[borrower][assetList[i]] != 0) return;
        }
        uint256 fromReserve = debt > gapReserve ? gapReserve : debt;
        gapReserve -= fromReserve;
        uint256 socialized = debt - fromReserve;
        // Reserve-covered debt: cash earmarked for the reserve now backs suppliers instead.
        // Socialized remainder: suppliers absorb it through a lower share price.
        uint256 scaled = scaledDebt[borrower];
        scaledDebt[borrower] = 0;
        totalScaledDebt -= scaled;
        emit BadDebtCovered(borrower, fromReserve, socialized);
    }

    // ================================================================== internal: dividends

    function _settle(address user) internal {
        uint256 owed;
        for (uint256 i; i < assetList.length; ++i) {
            address asset = assetList[i];
            uint256 accrued = collateralShares[user][asset] * accDividendPerShare[asset] / RAY;
            uint256 checkpoint = _dividendCheckpoint[user][asset];
            if (accrued > checkpoint) owed += accrued - checkpoint;
            _dividendCheckpoint[user][asset] = accrued;
        }
        if (owed == 0) return;
        if (owed > unsettledDividends) owed = unsettledDividends;
        unsettledDividends -= owed;

        uint256 debt = _debtOf(user);
        uint256 repaid = owed > debt ? debt : owed;
        if (repaid > 0) _reduceDebt(user, repaid, debt);
        uint256 credited = owed - repaid;
        if (credited > 0) {
            dividendCredit[user] += credited;
            totalDividendCredit += credited;
        }
        emit DividendApplied(user, repaid, credited);
    }

    function _checkpoint(address user, address asset) internal {
        _dividendCheckpoint[user][asset] = collateralShares[user][asset] * accDividendPerShare[asset] / RAY;
    }

    function _pendingDividendFor(address user, address asset) internal view returns (uint256) {
        uint256 accrued = collateralShares[user][asset] * accDividendPerShare[asset] / RAY;
        uint256 checkpoint = _dividendCheckpoint[user][asset];
        return accrued > checkpoint ? accrued - checkpoint : 0;
    }

    function _pendingDividends(address user) internal view returns (uint256 total) {
        for (uint256 i; i < assetList.length; ++i) {
            total += _pendingDividendFor(user, assetList[i]);
        }
        if (total > unsettledDividends) total = unsettledDividends;
    }

    // ================================================================== internal: risk

    function _debtOf(address user) internal view returns (uint256) {
        return Math.mulDiv(scaledDebt[user], borrowIndex, RAY, Math.Rounding.Ceil);
    }

    /// @return collateralValue USD WAD, borrowLimit USD WAD (current-state LTV), liquidationLimit USD WAD
    function _accountLimits(address user)
        internal
        view
        returns (uint256 collateralValue, uint256 borrowLimit, uint256 liquidationLimit)
    {
        for (uint256 i; i < assetList.length; ++i) {
            address asset = assetList[i];
            uint256 shares = collateralShares[user][asset];
            if (shares == 0) continue;
            AssetConfig memory cfg = assetConfig[asset];
            (uint256 price,) = oracle.getPrice(asset);
            uint256 value = StockToken(asset).amountForShares(shares) * price / PRICE_SCALE;
            uint256 ltv = oracle.isPriceFresh(asset) ? cfg.ltvOpenBps : cfg.ltvClosedBps;
            collateralValue += value;
            borrowLimit += value * ltv / BPS;
            liquidationLimit += value * cfg.liqThresholdBps / BPS;
        }
    }

    function _openClosedLimits(address user) internal view returns (uint256 openLimit, uint256 closedLimit) {
        for (uint256 i; i < assetList.length; ++i) {
            address asset = assetList[i];
            uint256 shares = collateralShares[user][asset];
            if (shares == 0) continue;
            AssetConfig memory cfg = assetConfig[asset];
            (uint256 price,) = oracle.getPrice(asset);
            uint256 value = StockToken(asset).amountForShares(shares) * price / PRICE_SCALE;
            openLimit += value * cfg.ltvOpenBps / BPS;
            closedLimit += value * cfg.ltvClosedBps / BPS;
        }
    }

    function _healthFactor(address user, uint256 debt) internal view returns (uint256) {
        if (debt == 0) return type(uint256).max;
        (,, uint256 liquidationLimit) = _accountLimits(user);
        return liquidationLimit * WAD / (debt * USDG_TO_WAD);
    }

    function _validate(AssetConfig calldata cfg) internal pure {
        if (
            cfg.ltvClosedBps > cfg.ltvOpenBps || cfg.ltvOpenBps >= cfg.liqThresholdBps
                || cfg.liqThresholdBps >= BPS || cfg.liqBonusBps > 2_000
                || uint256(cfg.liqThresholdBps) * (BPS + cfg.liqBonusBps) / BPS >= BPS
        ) revert InvalidConfig();
    }

    // ================================================================== internal: interest

    function _accrue() internal {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0) return;
        lastAccrual = block.timestamp;
        if (totalScaledDebt == 0) return;

        uint256 borrowsBefore = totalScaledDebt * borrowIndex / RAY;
        uint256 rate = _borrowRate(_utilization(borrowsBefore, _liquidity()));
        uint256 newIndex = borrowIndex + borrowIndex * (rate * dt / 365 days) / WAD;
        uint256 borrowsAfter = totalScaledDebt * newIndex / RAY;
        protocolReserves += (borrowsAfter - borrowsBefore) * reserveFactorBps / BPS;
        borrowIndex = newIndex;
    }

    function _projectedIndex() internal view returns (uint256 index, uint256 newReserves) {
        index = borrowIndex;
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0 || totalScaledDebt == 0) return (index, 0);
        uint256 borrowsBefore = totalScaledDebt * index / RAY;
        uint256 rate = _borrowRate(_utilization(borrowsBefore, _liquidity()));
        index = index + index * (rate * dt / 365 days) / WAD;
        newReserves = (totalScaledDebt * index / RAY - borrowsBefore) * reserveFactorBps / BPS;
    }

    function _borrowRate(uint256 utilization) internal view returns (uint256) {
        RateModel memory m = rateModel;
        if (utilization <= m.kinkWad) {
            return m.baseRateWad + uint256(m.slope1Wad) * utilization / m.kinkWad;
        }
        return m.baseRateWad + m.slope1Wad + uint256(m.slope2Wad) * (utilization - m.kinkWad) / (WAD - m.kinkWad);
    }

    function _utilization(uint256 borrows, uint256 liquidity) internal pure returns (uint256) {
        uint256 denom = borrows + liquidity;
        return denom == 0 ? 0 : borrows * WAD / denom;
    }

    /// @dev USDG that can leave the pool: cash minus everything earmarked for someone else.
    function _liquidity() internal view returns (uint256) {
        uint256 earmarked = protocolReserves + gapReserve + unsettledDividends + totalDividendCredit;
        return cash > earmarked ? cash - earmarked : 0;
    }

    function _projectedLiquidity() internal view returns (uint256) {
        (, uint256 newReserves) = _projectedIndex();
        uint256 earmarked =
            protocolReserves + newReserves + gapReserve + unsettledDividends + totalDividendCredit;
        return cash > earmarked ? cash - earmarked : 0;
    }

    function _totalSupplyAssets() internal view returns (uint256) {
        uint256 gross = cash + totalScaledDebt * borrowIndex / RAY;
        uint256 owed = protocolReserves + gapReserve + unsettledDividends + totalDividendCredit;
        return gross > owed ? gross - owed : 0;
    }

    function _projectedTotalSupplyAssets() internal view returns (uint256) {
        (uint256 index, uint256 newReserves) = _projectedIndex();
        uint256 gross = cash + totalScaledDebt * index / RAY;
        uint256 owed = protocolReserves + newReserves + gapReserve + unsettledDividends + totalDividendCredit;
        return gross > owed ? gross - owed : 0;
    }
}
