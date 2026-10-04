// Human-readable ABIs (ethers v6) for the AfterHours contracts.
(function (root) {
  const ERRORS = [
    "error AssetNotListed()",
    "error AssetAlreadyListed()",
    "error AssetDisabled()",
    "error TooManyAssets()",
    "error InvalidConfig()",
    "error ZeroAmount()",
    "error InsufficientLiquidity()",
    "error InsufficientCollateral()",
    "error InsufficientBalance()",
    "error ExceedsBorrowLimit()",
    "error PositionHealthy()",
    "error LiquidationsPaused(uint8 status)",
    "error NothingToRepay()",
    "error NoDividends()",
    "error EnforcedPause()",
    "error InsufficientAllowance()",
    "error NotMinter()",
    "error InvalidSplit()",
    "error NotKeeper()",
    "error InvalidPrice()",
    "error DemoDisabled()",
    "error InvalidMove()",
    "error UnknownAsset()",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  ];

  const POOL_EVENTS = [
    "event Supplied(address indexed user, uint256 amount, uint256 shares)",
    "event SupplyWithdrawn(address indexed user, uint256 amount, uint256 shares)",
    "event CollateralDeposited(address indexed user, address indexed asset, uint256 amount, uint256 shares)",
    "event CollateralWithdrawn(address indexed user, address indexed asset, uint256 amount, uint256 shares)",
    "event Borrowed(address indexed user, uint256 amount, uint256 fee, bool marketOpen)",
    "event Repaid(address indexed payer, address indexed borrower, uint256 amount)",
    "event Liquidated(address indexed liquidator, address indexed borrower, address indexed asset, uint256 repaid, uint256 seizedAmount, uint256 seizedShares)",
    "event BadDebtCovered(address indexed borrower, uint256 fromGapReserve, uint256 socialized)",
    "event DividendDistributed(address indexed asset, uint256 amount, uint256 accPerShare)",
    "event DividendApplied(address indexed user, uint256 repaid, uint256 credited)",
    "event DividendClaimed(address indexed user, uint256 amount)",
    "event GapReserveFunded(address indexed from, uint256 amount)",
  ];

  const DEMO_EVENTS = [
    "event FaucetUsed(address indexed user)",
    "event PriceMoved(address indexed asset, int256 bps, uint256 newPrice)",
    "event DividendDeclared(address indexed asset, uint256 perToken, uint256 total)",
    "event SplitExecuted(address indexed asset, uint256 numerator, uint256 denominator)",
    "event PricesReset()",
  ];

  const ORACLE_EVENTS = ["event MarketStatusChanged(bool open, uint256 timestamp)"];

  const POOL = [
    "function getPoolState() view returns (tuple(uint256 liquidity, uint256 totalBorrows, uint256 totalSupplyAssets, uint256 utilizationWad, uint256 borrowRateWad, uint256 supplyRateWad, uint256 gapReserve, uint256 protocolReserves, uint256 dividendLiabilities, uint256 totalCollateralValue, uint16 afterHoursFeeBps, uint16 reserveFactorBps, bool marketOpen, uint256 lastOpenedAt, uint256 lastClosedAt, uint256 graceEndsAt, uint256 openGracePeriod, uint256 maxPriceAge, bool paused, uint256 timestamp))",
    "function getAccount(address user) view returns (tuple(uint256 collateralValue, uint256 borrowLimit, uint256 openBorrowLimit, uint256 closedBorrowLimit, uint256 liquidationLimit, uint256 debt, uint256 pendingDividends, uint256 dividendCredit, uint256 healthFactor, uint256 availableToBorrow, uint256 supplyBalance, uint256 supplyShares))",
    "function getAssetViews(address user) view returns (tuple(address token, string symbol, string name, uint256 price, uint256 updatedAt, bool priceFresh, uint8 liquidationStatus, uint16 ltvOpenBps, uint16 ltvClosedBps, uint16 liqThresholdBps, uint16 liqBonusBps, uint16 activeLtvBps, uint256 userCollateral, uint256 userCollateralShares, uint256 userCollateralValue, uint256 walletBalance, uint256 walletAllowance, uint256 totalCollateral, uint256 pendingDividend)[])",
    "function debtOf(address user) view returns (uint256)",
    "function supply(uint256 amount) returns (uint256)",
    "function withdrawSupply(uint256 amount) returns (uint256)",
    "function depositCollateral(address asset, uint256 amount)",
    "function withdrawCollateral(address asset, uint256 amount)",
    "function borrow(uint256 amount)",
    "function depositAndBorrow(address asset, uint256 collateralAmount, uint256 borrowAmount)",
    "function repay(address borrower, uint256 amount) returns (uint256)",
    "function liquidate(address borrower, address asset, uint256 repayAmount) returns (uint256, uint256)",
    "function claimDividends() returns (uint256)",
    "function settle(address user)",
    "function fundGapReserve(uint256 amount)",
    ...POOL_EVENTS,
    ...ERRORS,
  ];

  const DEMO = [
    "function faucet()",
    "function setMarketOpen(bool open)",
    "function openWithGap(address asset, int256 bps)",
    "function movePrice(address asset, int256 bps)",
    "function refreshPrices()",
    "function resetPrices()",
    "function declareDividend(address asset, uint256 perToken) returns (uint256)",
    "function split(address asset, uint256 numerator, uint256 denominator)",
    "function basePrice(address asset) view returns (uint256)",
    "function demoEnabled() view returns (bool)",
    ...DEMO_EVENTS,
    ...ERRORS,
  ];

  const ORACLE = [
    "function marketOpen() view returns (bool)",
    "function graceEndsAt() view returns (uint256)",
    ...ORACLE_EVENTS,
    ...ERRORS,
  ];

  const ERC20 = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    ...ERRORS,
  ];

  root.AFTERHOURS_ABI = { ERRORS, POOL, DEMO, ORACLE, ERC20, POOL_EVENTS, DEMO_EVENTS, ORACLE_EVENTS };
})(typeof window !== "undefined" ? window : globalThis);
