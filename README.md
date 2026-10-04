# AfterHours

**Borrow USDG against your tokenized stocks, around the clock, on Robinhood Chain.**

Tokenized stocks are arriving onchain, but they mostly sit idle. In traditional finance, borrowing against a portfolio is a huge business, but it's reserved for wealthy clients and only works during market hours. Generic DeFi lending can't safely accept stocks either, because stocks don't behave like crypto: markets close, prices gap at the open, and splits and dividends change balances.

AfterHours is a lending market designed around how equities actually trade.

## What makes it different

| Feature | What it does |
|---|---|
| Market-hours LTV | Each stock has a higher borrow limit while the market is open (NVDA 60%) and a tighter one overnight or when the price is stale (NVDA 40%). |
| Gap reserve | Borrowing after hours costs a 0.30% fee that funds a reserve. If an opening gap creates bad debt, the reserve absorbs it before lenders lose anything. |
| No liquidations on frozen prices | Liquidations only run while the market is open, on a price published after the open, and after a short grace period (15s in the demo). |
| Dividends repay your loan | Dividends on deposited stock pay down the depositor's debt first; any excess becomes claimable USDG. |
| Split-proof collateral | Positions are tracked in token shares, so a 2-for-1 split doubles your share count, halves the price, and leaves your health factor exactly where it was. |
| USDG native | Borrowing and lending are denominated in Paxos USDG (a test mock on testnet). |

## Quick start

You need macOS or Linux (or WSL), `git`, `curl`, and `python3` or Node.js. The script installs Foundry for you if it's missing.

```bash
chmod +x start.sh
./start.sh            # local chain + deploy + web app at http://localhost:5173
```

The landing page opens at http://localhost:5173 and the app at http://localhost:5173/app.html. In the app, click **Connect**, choose **Instant demo wallet**, then open the **Demo console**.

### Deploy to Robinhood Chain testnet

1. Create a throwaway wallet and get testnet ETH from https://faucet.testnet.chain.robinhood.com
2. Copy `.env.example` to `.env` and set `PRIVATE_KEY`.
3. Run:

```bash
./start.sh robinhood          # add VERIFY=1 to verify on Blockscout
```

The script checks your balance, deploys every contract, seeds 2,000,000 USDG of lender liquidity and a 50,000 USDG gap reserve, writes the addresses to `frontend/config.js`, and serves the app.

On testnet, the instant demo wallet needs a little ETH for gas. Either use the "Send 0.005 ETH from browser wallet" button in the wallet menu, or run `./start.sh fund <demo-wallet-address>`.

Other commands: `./start.sh arbitrum-sepolia`, `./start.sh serve`, `./start.sh test`.

### Hosting the web app

`frontend/` is static. After deploying, upload the folder (including the generated `config.js`) to Vercel, Netlify, Cloudflare Pages or GitHub Pages. The landing page reads live stats and contract addresses from the same `config.js`, so it lights up automatically once you deploy. Update the "Source" link in the landing page footer to your GitHub repo.

## Two-minute demo script

Open the demo console and run the story in order.

1. **Get a starter portfolio.** "Here's a user holding tokenized NVIDIA, Apple, Tesla and the S&P 500."
2. **Borrow against NVIDIA.** One transaction deposits 30 tNVDA and borrows half its value. Point at the health factor (1.40) and the borrow bar with two markers: the market-hours limit and the overnight limit.
3. **Close the market.** The interface turns to night. "Limits drop to overnight levels. This user is now above the overnight limit, but that's fine: we never liquidate someone just because the clock moved. New borrowing simply waits for the open."
4. **NVIDIA opens 30% lower.** Health factor drops to 0.98. "On any other protocol, a bot liquidates this user instantly. AfterHours waits for a real opening price and gives a grace period." Point at the countdown.
5. **Liquidate after the grace period.** "Now the market has had time to find its price, so liquidation runs as normal: half the debt is repaid, and the liquidator takes collateral at a 6% discount." Mention the gap reserve: if the gap had been big enough to create bad debt, the reserve pays it before lenders.
6. **Pay a $5 dividend.** The loan shrinks by itself. "Your stocks pay down your debt."
7. **Split 2-for-1.** Share count doubles, price halves, health factor unchanged.

Close with the roadmap below.

## Architecture

```
contracts/src
  AfterHoursPool.sol   Lending pool: supply, collateral, borrow, repay, liquidate, dividends, gap reserve
  MarketOracle.sol     8-decimal prices + market session state, freshness and liquidation status
  StockToken.sol       Tokenized equity with share-based balances and native splits
  MockUSDG.sol         6-decimal USDG stand-in for testnet
  DemoController.sol   Testnet-only console: faucet, session, price moves, dividends, splits
contracts/test         Foundry tests (unit + fuzz)
contracts/script       Deploy.s.sol: deploys, configures, seeds, writes frontend/config.js
frontend/index.html    Landing page: time-lapse hero, opening-bell walkthrough, screenshots, live onchain stats
frontend/app.html      The app (ethers v6, no build step)
frontend/assets/       Real app screenshots used by the landing page
start.sh               One-command setup, deploy and serve
```

### Risk parameters (demo)

| Stock | LTV open | LTV overnight | Liquidation threshold | Liquidation bonus |
|---|---|---|---|---|
| tNVDA | 60% | 40% | 70% | 6% |
| tAAPL | 65% | 45% | 75% | 5% |
| tTSLA | 50% | 30% | 62% | 8% |
| tSPY | 70% | 55% | 78% | 4% |

Interest follows a kinked utilization curve (2% base, 8% slope to 80% utilization, 100% above). 10% of interest goes to protocol reserves. A liquidation can repay up to 50% of a loan, or all of it once the health factor is below 0.95.

### Engineering notes

- Internal cash accounting and virtual shares make the pool immune to donation and share-inflation attacks.
- Debt uses a borrow index (RAY precision) with rounding in the protocol's favor.
- Dividends use a per-share accumulator, so payouts cost the same gas no matter how many holders there are.
- OpenZeppelin `SafeERC20`, `ReentrancyGuard`, `Pausable` and `Ownable`; custom errors throughout.
- The frontend adds a 30% gas buffer to every write, because interest accrual can make a transaction slightly more expensive when mined than when estimated.

## Production path

- Replace MockUSDG with Paxos USDG and StockToken with Robinhood's stock tokens.
- Replace keeper-set prices with Chainlink Data Streams and an exchange-hours/holiday calendar feed.
- Remove DemoController; gate oracle keepers behind a multisig and timelock.
- Smart-account onboarding (ZeroDev) for passkey sign-up and gasless borrowing.
- Round-up and DCA features that feed directly into collateral.
- Independent audit before mainnet.

## Disclaimer

This is a hackathon build deployed with test tokens. It has not been audited and is not financial advice.
