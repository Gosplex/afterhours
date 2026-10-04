// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockUSDG} from "../src/MockUSDG.sol";
import {StockToken} from "../src/StockToken.sol";
import {MarketOracle} from "../src/MarketOracle.sol";
import {AfterHoursPool} from "../src/AfterHoursPool.sol";
import {DemoController} from "../src/DemoController.sol";

contract AfterHoursTest is Test {
    MockUSDG usdg;
    MarketOracle oracle;
    AfterHoursPool pool;
    DemoController demo;
    StockToken nvda;
    StockToken spy;

    address owner = makeAddr("owner");
    address lender = makeAddr("lender");
    address alice = makeAddr("alice");
    address liquidator = makeAddr("liquidator");

    uint256 constant GRACE = 15;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.startPrank(owner);
        usdg = new MockUSDG(owner);
        oracle = new MarketOracle(owner, 1 hours, uint64(GRACE));
        pool = new AfterHoursPool(IERC20(address(usdg)), oracle, owner);
        demo = new DemoController(usdg, oracle, pool, owner);
        usdg.setMinter(address(demo), true);
        usdg.setMinter(owner, true);
        oracle.setKeeper(address(demo), true);
        oracle.setMarketOpen(true);

        nvda = _list("tNVDA", 100e8, 6000, 4000, 7000, 600, 100e18);
        spy = _list("tSPY", 500e8, 7000, 5500, 7800, 400, 20e18);

        usdg.mint(lender, 1_000_000e6);
        usdg.mint(liquidator, 1_000_000e6);
        usdg.mint(owner, 100_000e6);
        usdg.approve(address(pool), type(uint256).max);
        pool.fundGapReserve(10_000e6);
        vm.stopPrank();

        vm.startPrank(lender);
        usdg.approve(address(pool), type(uint256).max);
        pool.supply(1_000_000e6);
        vm.stopPrank();

        vm.prank(liquidator);
        usdg.approve(address(pool), type(uint256).max);

        vm.prank(alice);
        demo.faucet(); // 100 tNVDA, 20 tSPY, 25k USDG
        vm.startPrank(alice);
        nvda.approve(address(pool), type(uint256).max);
        spy.approve(address(pool), type(uint256).max);
        usdg.approve(address(pool), type(uint256).max);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + GRACE + 1);
    }

    function _list(string memory sym, uint256 price, uint16 o, uint16 c, uint16 l, uint16 b, uint256 faucetAmt)
        internal
        returns (StockToken t)
    {
        t = new StockToken(sym, sym, owner);
        t.setMinter(address(demo), true);
        t.transferOwnership(address(demo));
        oracle.setPrice(address(t), price);
        pool.listAsset(address(t), AfterHoursPool.AssetConfig(true, true, o, c, l, b));
        demo.addAsset(address(t), price, faucetAmt);
    }

    // ------------------------------------------------------------------ market-hours LTV

    function test_BorrowUsesOpenLtvWhenMarketOpen() public {
        vm.startPrank(alice);
        pool.depositCollateral(address(nvda), 100e18); // $10,000
        pool.borrow(6_000e6); // 60% open LTV
        vm.expectRevert(AfterHoursPool.ExceedsBorrowLimit.selector);
        pool.borrow(1e6);
        vm.stopPrank();
    }

    function test_ClosedMarketTightensLtvAndChargesGapFee() public {
        demo.setMarketOpen(false);
        vm.startPrank(alice);
        pool.depositCollateral(address(nvda), 100e18);
        vm.expectRevert(AfterHoursPool.ExceedsBorrowLimit.selector);
        pool.borrow(4_001e6); // above 40% closed LTV

        uint256 reserveBefore = pool.gapReserve();
        uint256 balBefore = usdg.balanceOf(alice);
        pool.borrow(4_000e6);
        vm.stopPrank();

        uint256 fee = 4_000e6 * 30 / 10_000;
        assertEq(usdg.balanceOf(alice) - balBefore, 4_000e6 - fee, "fee deducted from proceeds");
        assertEq(pool.gapReserve() - reserveBefore, fee, "fee funds gap reserve");
        assertEq(pool.debtOf(alice), 4_000e6, "debt is the full amount");
    }

    function test_StalePriceWhileOpenUsesClosedLtv() public {
        vm.prank(alice);
        pool.depositCollateral(address(nvda), 100e18);
        vm.warp(vm.getBlockTimestamp() + 2 hours); // beyond maxPriceAge
        vm.prank(alice);
        vm.expectRevert(AfterHoursPool.ExceedsBorrowLimit.selector);
        pool.borrow(5_000e6);
    }

    // ------------------------------------------------------------------ liquidation guards

    function _borrowMax() internal {
        vm.startPrank(alice);
        pool.depositCollateral(address(nvda), 100e18);
        pool.borrow(6_000e6);
        vm.stopPrank();
    }

    function test_NoLiquidationWhileMarketClosed() public {
        _borrowMax();
        demo.setMarketOpen(false);
        demo.movePrice(address(nvda), -2_000); // after-hours crash
        vm.prank(liquidator);
        vm.expectRevert(
            abi.encodeWithSelector(
                AfterHoursPool.LiquidationsPaused.selector, MarketOracle.LiquidationStatus.MarketClosed
            )
        );
        pool.liquidate(alice, address(nvda), 1_000e6);
    }

    function test_NoLiquidationOnPreOpenPrice() public {
        _borrowMax();
        demo.setMarketOpen(false);
        demo.movePrice(address(nvda), -2_000);
        vm.warp(vm.getBlockTimestamp() + 60);
        vm.prank(owner);
        oracle.setMarketOpen(true); // opened without a new price
        vm.warp(vm.getBlockTimestamp() + GRACE + 1);
        vm.prank(liquidator);
        vm.expectRevert(
            abi.encodeWithSelector(
                AfterHoursPool.LiquidationsPaused.selector, MarketOracle.LiquidationStatus.AwaitingOpeningPrice
            )
        );
        pool.liquidate(alice, address(nvda), 1_000e6);
    }

    function test_GracePeriodThenLiquidation() public {
        _borrowMax();
        demo.setMarketOpen(false);
        vm.warp(vm.getBlockTimestamp() + 60);
        demo.openWithGap(address(nvda), -1_500); // opens 15% lower: HF = 8500*0.7/6000 = 0.99

        vm.prank(liquidator);
        vm.expectRevert(
            abi.encodeWithSelector(
                AfterHoursPool.LiquidationsPaused.selector, MarketOracle.LiquidationStatus.OpeningGracePeriod
            )
        );
        pool.liquidate(alice, address(nvda), 1_000e6);

        vm.warp(vm.getBlockTimestamp() + GRACE + 1);
        uint256 debtBefore = pool.debtOf(alice);
        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = pool.liquidate(alice, address(nvda), type(uint256).max);

        assertEq(repaid, debtBefore / 2, "50% close factor");
        // repaid * 1.06 bonus / $85 opening price
        uint256 expected = repaid * 1e12 * 10_600 / 10_000 * 1e8 / 85e8;
        assertApproxEqAbs(nvda.balanceOf(liquidator), expected, 1e12);
        assertEq(seized, nvda.sharesForAmount(nvda.balanceOf(liquidator)));
    }

    function test_HealthyPositionCannotBeLiquidated() public {
        _borrowMax();
        vm.prank(liquidator);
        vm.expectRevert(AfterHoursPool.PositionHealthy.selector);
        pool.liquidate(alice, address(nvda), 1_000e6);
    }

    // ------------------------------------------------------------------ gap reserve

    function test_GapReserveAbsorbsBadDebtBeforeSuppliers() public {
        _borrowMax(); // $6,000 debt on $10,000
        demo.setMarketOpen(false);
        vm.warp(vm.getBlockTimestamp() + 60);
        demo.openWithGap(address(nvda), -5_000); // collateral now $5,000 < debt
        vm.warp(vm.getBlockTimestamp() + GRACE + 1);

        uint256 supplierBefore = pool.getPoolState().totalSupplyAssets;
        uint256 reserveBefore = pool.gapReserve();
        uint256 debtBefore = pool.debtOf(alice);

        vm.prank(liquidator);
        (uint256 repaid,) = pool.liquidate(alice, address(nvda), type(uint256).max);

        assertEq(pool.collateralShares(alice, address(nvda)), 0, "all collateral seized");
        assertEq(pool.debtOf(alice), 0, "bad debt written off");
        uint256 shortfall = debtBefore - repaid;
        assertApproxEqAbs(reserveBefore - pool.gapReserve(), shortfall, 2, "reserve covered shortfall");
        assertApproxEqAbs(pool.getPoolState().totalSupplyAssets, supplierBefore, 2, "suppliers made whole");
    }

    // ------------------------------------------------------------------ dividends

    function test_DividendRepaysDebtThenCreditsExcess() public {
        _borrowMax();
        demo.declareDividend(address(nvda), 50e6); // $50/share * 100 = $5,000
        AfterHoursPool.AccountView memory a = pool.getAccount(alice);
        assertEq(a.debt, 1_000e6, "view nets pending dividends");

        demo.declareDividend(address(nvda), 20e6); // +$2,000, $1,000 excess
        pool.settle(alice);
        assertEq(pool.debtOf(alice), 0);
        assertEq(pool.dividendCredit(alice), 1_000e6);

        uint256 bal = usdg.balanceOf(alice);
        vm.prank(alice);
        pool.claimDividends();
        assertEq(usdg.balanceOf(alice) - bal, 1_000e6);
    }

    function test_DividendsSplitProRata() public {
        vm.prank(alice);
        pool.depositCollateral(address(nvda), 75e18);
        vm.prank(alice);
        nvda.transfer(lender, 25e18);
        vm.startPrank(lender);
        nvda.approve(address(pool), type(uint256).max);
        pool.depositCollateral(address(nvda), 25e18);
        vm.stopPrank();

        demo.declareDividend(address(nvda), 1e6);
        assertEq(pool.getAccount(alice).dividendCredit, 75e6);
        assertEq(pool.getAccount(lender).dividendCredit, 25e6);
    }

    // ------------------------------------------------------------------ splits

    function test_SplitKeepsPositionValueAndHealth() public {
        _borrowMax();
        AfterHoursPool.AccountView memory before = pool.getAccount(alice);
        demo.split(address(nvda), 2, 1);
        AfterHoursPool.AccountView memory afterSplit = pool.getAccount(alice);

        assertEq(afterSplit.collateralValue, before.collateralValue);
        assertEq(afterSplit.healthFactor, before.healthFactor);
        AfterHoursPool.AssetView[] memory v = pool.getAssetViews(alice);
        assertEq(v[0].userCollateral, 200e18, "holder sees 2x shares");
        assertEq(v[0].price, 50e8, "price halves");
    }

    // ------------------------------------------------------------------ lending

    function test_SuppliersEarnInterest() public {
        _borrowMax();
        uint256 before = pool.getAccount(lender).supplyBalance;
        vm.warp(vm.getBlockTimestamp() + 365 days);
        assertGt(pool.getAccount(lender).supplyBalance, before);
        assertGt(pool.debtOf(alice), 6_000e6);
    }

    function test_RepayAndWithdrawAll() public {
        _borrowMax();
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.startPrank(alice);
        pool.repay(alice, type(uint256).max);
        assertEq(pool.debtOf(alice), 0);
        pool.withdrawCollateral(address(nvda), type(uint256).max);
        vm.stopPrank();
        assertEq(nvda.balanceOf(alice), 100e18);
    }

    function test_CannotWithdrawCollateralBelowLimit() public {
        _borrowMax();
        vm.prank(alice);
        vm.expectRevert(AfterHoursPool.ExceedsBorrowLimit.selector);
        pool.withdrawCollateral(address(nvda), 1e18);
    }

    function test_DepositAndBorrowInOneTx() public {
        vm.prank(alice);
        pool.depositAndBorrow(address(spy), 20e18, 5_000e6);
        assertEq(pool.debtOf(alice), 5_000e6);
    }

    function test_DonationDoesNotChangeShareAccounting() public {
        uint256 before = pool.getAccount(lender).supplyBalance;
        vm.prank(liquidator);
        usdg.transfer(address(pool), 500_000e6);
        assertEq(pool.getAccount(lender).supplyBalance, before);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_BorrowNeverExceedsActiveLimit(uint256 collateral, uint256 borrowAmt, bool open) public {
        collateral = bound(collateral, 1e18, 100e18);
        borrowAmt = bound(borrowAmt, 1e6, 20_000e6);
        if (!open) demo.setMarketOpen(false);

        vm.startPrank(alice);
        pool.depositCollateral(address(nvda), collateral);
        uint256 limit = collateral * 100 * (open ? 6000 : 4000) / 10_000 / 1e12; // USDG
        if (borrowAmt > limit) {
            vm.expectRevert(AfterHoursPool.ExceedsBorrowLimit.selector);
            pool.borrow(borrowAmt);
        } else {
            pool.borrow(borrowAmt);
            assertGe(pool.getAccount(alice).healthFactor, 1e18);
        }
        vm.stopPrank();
    }
}
