/* AfterHours frontend. Plain JS + ethers v6, no build step. */
(() => {
  "use strict";

  const { ethers } = window;
  const C = window.AFTERHOURS_CONFIG;
  const ABI = window.AFTERHOURS_ABI;
  const $ = (id) => document.getElementById(id);

  if (!C || !C.contracts) {
    document.querySelector("main").innerHTML =
      '<div class="panel" style="margin-top:40px"><h2 class="section-title">Contracts not deployed yet</h2>' +
      '<p class="muted">Run <strong>./start.sh local</strong> (or <strong>./start.sh robinhood</strong>) from the project root. ' +
      "It deploys the contracts and writes frontend/config.js for you.</p></div>";
    return;
  }

  // ================================================================== setup

  const MAX = ethers.MaxUint256;
  const CHAIN_ID = Number(C.network.chainId);
  const IS_LOCAL = CHAIN_ID === 31337;
  const FAUCET_URL = CHAIN_ID === 46630 ? "https://faucet.testnet.chain.robinhood.com/" : null;
  const STORE = `afterhours:${CHAIN_ID}:${C.contracts.pool.toLowerCase()}`;

  const network = ethers.Network.from(CHAIN_ID);
  const rpc = new ethers.JsonRpcProvider(C.network.rpcUrl, network, { staticNetwork: network, pollingInterval: 500 });

  const read = {
    pool: new ethers.Contract(C.contracts.pool, ABI.POOL, rpc),
    demo: new ethers.Contract(C.contracts.demo, ABI.DEMO, rpc),
    usdg: new ethers.Contract(C.contracts.usdg, ABI.ERC20, rpc),
  };
  const errIface = new ethers.Interface(ABI.ERRORS);
  const eventIface = new ethers.Interface([...ABI.POOL_EVENTS, ...ABI.DEMO_EVENTS, ...ABI.ORACLE_EVENTS]);

  const S = {
    mode: null, // "burner" | "injected"
    signer: null,
    account: null,
    pool: null,
    acct: null,
    assets: [],
    usdgBal: 0n,
    ethBal: 0n,
    base: new Map(),
    symbols: new Map(),
    feed: [],
    seen: new Set(),
    lastLogBlock: null,
    blockTimes: new Map(),
    tab: "borrow",
    earnMode: "supply",
    coll: { token: null, mode: "deposit" },
    polling: false,
    eventsBusy: false,
    lastSession: null,
    netOk: true,
    wrongChain: false,
    story: new Set(storeGet("story", [])),
    busy: new Set(),
  };

  // ================================================================== storage helpers

  function storeGet(key, fallback) {
    try {
      const v = localStorage.getItem(`${STORE}:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  function storeSet(key, value) {
    try {
      localStorage.setItem(`${STORE}:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable: keep in memory */
    }
  }

  // ================================================================== formatting

  const units = (v, d) => Number(ethers.formatUnits(v, d));
  const wad = (v) => units(v, 18);

  function usd(n, opts = {}) {
    if (n == null || !isFinite(n)) return "—";
    const abs = Math.abs(n);
    if (opts.compact && abs >= 1e6) {
      return "$" + (n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "M";
    }
    const digits = opts.digits ?? (abs >= 10000 ? 0 : 2);
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }
  const qty = (n, d = 2) => (n || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
  const pct = (n, d = 1, min = 0) => `${(n * 100).toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: d })}%`;
  const rate = (n) => pct(n, 2, 2);
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  const ticker = (sym) => (sym || "").replace(/^t/, "");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function parseAmount(str, decimals) {
    const clean = String(str || "").replace(/[, _$]/g, "").trim();
    if (!clean || !/^\d*\.?\d*$/.test(clean)) return null;
    try {
      const v = ethers.parseUnits(clean.startsWith(".") ? "0" + clean : clean, decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }
  const toInput = (n, d) => {
    const f = Math.floor(n * 10 ** d) / 10 ** d;
    return f > 0 ? String(+f.toFixed(d)) : "";
  };

  const explorerTx = (h) => (C.network.explorer ? `${C.network.explorer.replace(/\/$/, "")}/tx/${h}` : null);

  // ================================================================== toasts

  const ICONS = {
    pending: '<span class="spinner"></span>',
    success: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
    error: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4.5v4.5M8 11.5v.5"/><circle cx="8" cy="8" r="6.5"/></svg>',
  };

  function toast(title, kind = "pending", sub = "", hash = null) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    $("toasts").appendChild(el);
    let timer = null;
    const api = {
      update(t, k, s, h) {
        el.className = `toast ${k}`;
        const link = h && explorerTx(h) ? `<a href="${explorerTx(h)}" target="_blank" rel="noopener">View</a>` : "";
        el.innerHTML = `<span class="t-icon">${ICONS[k]}</span><span>${esc(t)}${s ? `<span class="t-sub">${esc(s)}</span>` : ""}</span>${link}`;
        clearTimeout(timer);
        if (k !== "pending") timer = setTimeout(api.close, k === "error" ? 7000 : 4200);
        return api;
      },
      close() {
        el.remove();
      },
    };
    return api.update(title, kind, sub, hash);
  }

  // ================================================================== errors

  const LIQ_REASONS = [
    "",
    "The market is closed. Positions are protected until the open.",
    "Waiting for an opening price. Publish fresh prices first.",
    "The opening grace period is still running.",
    "The price is stale. Publish fresh prices first.",
  ];

  const ERROR_TEXT = {
    ExceedsBorrowLimit: "That would take you past your borrow limit. Try a smaller amount or add collateral.",
    InsufficientLiquidity: "The pool doesn't have that much USDG free right now.",
    PositionHealthy: "This position is healthy, so it can't be liquidated.",
    NothingToRepay: "There's no loan to repay.",
    NoDividends: "Nothing to pay out. Someone needs to have this stock deposited first.",
    ZeroAmount: "Enter an amount above zero.",
    InsufficientCollateral: "That's more than you have deposited.",
    InsufficientBalance: "Your balance is too low for that.",
    InsufficientAllowance: "The token approval is missing. Try again to approve it.",
    AssetDisabled: "This stock isn't accepting new deposits.",
    AssetNotListed: "This stock isn't listed in the pool.",
    EnforcedPause: "The pool is paused.",
    DemoDisabled: "The demo console is switched off on this deployment.",
    InvalidMove: "That price move is out of range.",
    UnknownAsset: "That stock isn't registered with the demo console.",
    NotKeeper: "The demo console isn't allowed to update prices.",
    ERC20InsufficientBalance: "Not enough USDG in your wallet.",
    ERC20InsufficientAllowance: "USDG approval is missing. Try again to approve it.",
  };

  function findRevertData(e) {
    const seen = new Set();
    const stack = [e];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== "object" || seen.has(x)) continue;
      seen.add(x);
      if (typeof x.data === "string" && x.data.startsWith("0x") && x.data.length >= 10) return x.data;
      for (const k of ["error", "info", "data", "cause"]) if (x[k]) stack.push(x[k]);
    }
    return null;
  }

  function friendlyError(e) {
    if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001 || e?.code === 4001) {
      return "Request cancelled in your wallet.";
    }
    if (e?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(e?.message || "")) {
      return "This wallet needs a little ETH for gas. Open the wallet menu to top up.";
    }
    let parsed = e?.revert;
    if (!parsed) {
      const data = findRevertData(e);
      if (data) {
        try {
          parsed = errIface.parseError(data);
        } catch {
          /* unknown selector */
        }
      }
    }
    if (parsed?.name) {
      if (parsed.name === "LiquidationsPaused") return LIQ_REASONS[Number(parsed.args[0])] || "Liquidations are paused.";
      return ERROR_TEXT[parsed.name] || parsed.name;
    }
    const msg = e?.shortMessage || e?.reason || e?.message || "Something went wrong.";
    return msg.length > 160 ? msg.slice(0, 157) + "…" : msg;
  }

  // ================================================================== transactions

  async function send(label, fn, done) {
    if (!S.signer) {
      openConnect();
      return false;
    }
    if (!(await ensureChain())) return false;
    const t = toast(label, "pending", S.mode === "injected" ? "Confirm in your wallet" : "Sending");
    try {
      const tx = await fn();
      t.update(label, "pending", "Waiting for confirmation", tx.hash);
      const rc = await tx.wait();
      if (!rc || rc.status !== 1) throw new Error("The transaction reverted.");
      t.update(done || label, "success", "", tx.hash);
      poll(true);
      setTimeout(pollEvents, 300);
      return true;
    } catch (e) {
      console.error(e);
      t.update(`${label} didn't go through`, "error", friendlyError(e));
      return false;
    }
  }

  async function ensureAllowance(tokenAddr, amount, symbol) {
    const current = await new ethers.Contract(tokenAddr, ABI.ERC20, rpc).allowance(S.account, C.contracts.pool);
    if (current >= amount) return true;
    return send(`Allow AfterHours to use your ${symbol}`, () => w.token(tokenAddr).approve(C.contracts.pool, MAX), `${symbol} approved`);
  }

  // Interest accrues per second, so a tx can need slightly more gas when mined than when
  // estimated. Every write gets a 30% buffer on top of the node's estimate.
  function buffered(contract) {
    return new Proxy(contract, {
      get(target, prop) {
        const fn = target[prop];
        if (typeof prop !== "string" || typeof fn !== "function" || !fn.estimateGas) return fn;
        return async (...args) => {
          const gas = await fn.estimateGas(...args);
          return fn(...args, { gasLimit: (gas * 13n) / 10n + 30000n });
        };
      },
    });
  }

  const w = {
    pool: () => buffered(new ethers.Contract(C.contracts.pool, ABI.POOL, S.signer)),
    demo: () => buffered(new ethers.Contract(C.contracts.demo, ABI.DEMO, S.signer)),
    token: (addr) => buffered(new ethers.Contract(addr, ABI.ERC20, S.signer)),
  };

  async function withBusy(key, btn, fn) {
    if (S.busy.has(key)) return;
    S.busy.add(key);
    const prev = btn ? btn.innerHTML : null;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>${prev}`;
    }
    try {
      return await fn();
    } finally {
      S.busy.delete(key);
      if (btn) {
        btn.innerHTML = prev;
        btn.disabled = false;
      }
      render();
    }
  }

  // ================================================================== wallet

  async function connectBurner(silent) {
    let pk = storeGet("burner", null);
    if (!pk) {
      pk = ethers.Wallet.createRandom().privateKey;
      storeSet("burner", pk);
    }
    const wallet = new ethers.Wallet(pk, rpc);
    S.mode = "burner";
    S.signer = wallet;
    S.account = wallet.address;
    storeSet("mode", "burner");
    if (IS_LOCAL) {
      try {
        const bal = await rpc.getBalance(wallet.address);
        if (bal < ethers.parseEther("1")) await rpc.send("anvil_setBalance", [wallet.address, "0x56BC75E2D63100000"]);
      } catch (e) {
        console.warn("Could not fund demo wallet on anvil", e);
      }
    }
    closeDialogs();
    await poll(true);
    if (!IS_LOCAL && S.ethBal === 0n && !silent) openAccount();
  }

  async function connectInjected(silent) {
    const eth = window.ethereum;
    if (!eth) {
      if (!silent) toast("No browser wallet found", "error", "Install MetaMask or use the instant demo wallet.");
      return;
    }
    try {
      const accounts = await eth.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" });
      if (!accounts || !accounts.length) return;
      S.mode = "injected";
      storeSet("mode", "injected");
      await ensureChain();
      const bp = new ethers.BrowserProvider(eth);
      S.signer = await bp.getSigner();
      S.account = await S.signer.getAddress();
      if (!eth.__afterhoursBound) {
        eth.__afterhoursBound = true;
        eth.on?.("accountsChanged", (accs) => {
          if (S.mode !== "injected") return;
          if (!accs.length) return disconnect();
          connectInjected(true);
        });
        eth.on?.("chainChanged", () => {
          if (S.mode === "injected") connectInjected(true);
        });
      }
      closeDialogs();
      poll(true);
    } catch (e) {
      if (!silent) toast("Couldn't connect", "error", friendlyError(e));
    }
  }

  async function ensureChain() {
    if (S.mode !== "injected") return true;
    const eth = window.ethereum;
    const current = parseInt(await eth.request({ method: "eth_chainId" }), 16);
    if (current === CHAIN_ID) {
      S.wrongChain = false;
      return true;
    }
    const hex = "0x" + CHAIN_ID.toString(16);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      const code = e?.code ?? e?.data?.originalError?.code;
      if (code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message || "")) {
        try {
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hex,
              chainName: C.network.name,
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [C.network.rpcUrl],
              blockExplorerUrls: C.network.explorer ? [C.network.explorer] : undefined,
            }],
          });
        } catch (e2) {
          S.wrongChain = true;
          toast(`Switch to ${C.network.name}`, "error", friendlyError(e2));
          return false;
        }
      } else {
        S.wrongChain = true;
        toast(`Switch to ${C.network.name}`, "error", friendlyError(e));
        return false;
      }
    }
    S.wrongChain = false;
    S.signer = await new ethers.BrowserProvider(eth).getSigner();
    return true;
  }

  function disconnect() {
    S.mode = null;
    S.signer = null;
    S.account = null;
    S.acct = null;
    storeSet("mode", null);
    closeDialogs();
    poll(true);
  }

  // ================================================================== data

  function normPool(p) {
    return {
      liquidity: units(p.liquidity, 6),
      totalBorrows: units(p.totalBorrows, 6),
      totalSupply: units(p.totalSupplyAssets, 6),
      util: wad(p.utilizationWad),
      borrowApr: wad(p.borrowRateWad),
      supplyApr: wad(p.supplyRateWad),
      gapReserve: units(p.gapReserve, 6),
      collateralValue: wad(p.totalCollateralValue),
      feeBps: Number(p.afterHoursFeeBps),
      open: p.marketOpen,
      lastOpenedAt: Number(p.lastOpenedAt),
      graceEndsAt: Number(p.graceEndsAt),
      grace: Number(p.openGracePeriod),
      paused: p.paused,
    };
  }

  function normAsset(a) {
    return {
      token: a.token,
      symbol: a.symbol,
      name: a.name,
      price: Number(a.price) / 1e8,
      updatedAt: Number(a.updatedAt),
      fresh: a.priceFresh,
      liqStatus: Number(a.liquidationStatus),
      ltvOpen: Number(a.ltvOpenBps) / 1e4,
      ltvClosed: Number(a.ltvClosedBps) / 1e4,
      liqT: Number(a.liqThresholdBps) / 1e4,
      bonus: Number(a.liqBonusBps) / 1e4,
      coll: units(a.userCollateral, 18),
      collValue: wad(a.userCollateralValue),
      wallet: units(a.walletBalance, 18),
      walletRaw: a.walletBalance,
      total: units(a.totalCollateral, 18),
    };
  }

  function normAccount(x) {
    const hfRaw = x.healthFactor;
    return {
      collateral: wad(x.collateralValue),
      borrowLimit: wad(x.borrowLimit),
      openLimit: wad(x.openBorrowLimit),
      closedLimit: wad(x.closedBorrowLimit),
      liqLimit: wad(x.liquidationLimit),
      debt: units(x.debt, 6),
      pendingDiv: units(x.pendingDividends, 6),
      credit: units(x.dividendCredit, 6),
      hf: hfRaw > 10n ** 30n ? Infinity : wad(hfRaw),
      avail: units(x.availableToBorrow, 6),
      availRaw: x.availableToBorrow,
      supplyBal: units(x.supplyBalance, 6),
    };
  }

  async function poll(force) {
    if (S.polling && !force) return;
    S.polling = true;
    try {
      const user = S.account || ethers.ZeroAddress;
      const [pool, assets] = await Promise.all([read.pool.getPoolState(), read.pool.getAssetViews(user)]);
      const bases = await Promise.all(assets.map((a) => read.demo.basePrice(a.token).catch(() => 0n)));
      let acct = null;
      if (S.account) {
        const [a, bal, eth] = await Promise.all([
          read.pool.getAccount(user),
          read.usdg.balanceOf(user),
          rpc.getBalance(user),
        ]);
        acct = normAccount(a);
        S.usdgBal = bal;
        S.ethBal = eth;
      }
      S.pool = normPool(pool);
      S.assets = assets.map(normAsset);
      S.assets.forEach((a, i) => {
        S.base.set(a.token.toLowerCase(), Number(bases[i]) / 1e8);
        S.symbols.set(a.token.toLowerCase(), a.symbol);
      });
      S.acct = acct;
      S.netOk = true;
      render();
    } catch (e) {
      console.error(e);
      S.netOk = false;
      renderChrome();
    } finally {
      S.polling = false;
    }
  }

  // ================================================================== activity feed

  async function getLogsChunked(from, to) {
    const address = [C.contracts.pool, C.contracts.demo, C.contracts.oracle];
    let span = 5000;
    const out = [];
    let start = from;
    while (start <= to) {
      const end = Math.min(to, start + span - 1);
      try {
        out.push(...(await rpc.getLogs({ address, fromBlock: start, toBlock: end })));
        start = end + 1;
      } catch (e) {
        if (span <= 200) throw e;
        span = Math.floor(span / 4);
      }
    }
    return out;
  }

  async function pollEvents() {
    if (S.eventsBusy) return;
    S.eventsBusy = true;
    try {
      const latest = await rpc.getBlockNumber();
      const from = S.lastLogBlock == null ? Math.max(Number(C.deployBlock || 0), latest - 20000) : S.lastLogBlock + 1;
      if (from > latest) return;
      const logs = await getLogsChunked(from, latest);
      S.lastLogBlock = latest;
      for (const log of logs) {
        const id = `${log.transactionHash}:${log.index}`;
        if (S.seen.has(id)) continue;
        let parsed;
        try {
          parsed = eventIface.parseLog(log);
        } catch {
          continue;
        }
        if (!parsed || parsed.name === "DividendDeclared" || parsed.name === "DividendApplied" && parsed.args.repaid === 0n && parsed.args.credited === 0n) continue;
        S.seen.add(id);
        S.feed.push({ id, block: log.blockNumber, index: log.index, hash: log.transactionHash, name: parsed.name, args: parsed.args });
      }
      S.feed.sort((a, b) => b.block - a.block || b.index - a.index);
      S.feed = S.feed.slice(0, 40);
      const missing = [...new Set(S.feed.map((f) => f.block))].filter((b) => !S.blockTimes.has(b)).slice(0, 12);
      await Promise.all(
        missing.map(async (b) => {
          try {
            const blk = await rpc.getBlock(b);
            if (blk) S.blockTimes.set(b, blk.timestamp);
          } catch {
            /* ignore */
          }
        }),
      );
      renderFeed();
    } catch (e) {
      console.warn("Activity feed unavailable", e);
    } finally {
      S.eventsBusy = false;
    }
  }

  const FEED_ICON = {
    market: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
    risk: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 2l6 11H2z"/><path d="M8 7v3"/></svg>',
    good: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
    flow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5"/></svg>',
  };

  function describe(f) {
    const a = f.args;
    const who = (addr) => (same(addr, S.account) ? "You" : short(addr));
    const sym = (addr) => S.symbols.get(String(addr).toLowerCase()) || "stock";
    const u6 = (v) => usd(units(v, 6));
    switch (f.name) {
      case "Supplied": return ["flow", `${who(a.user)} supplied ${u6(a.amount)} to lenders`];
      case "SupplyWithdrawn": return ["flow", `${who(a.user)} withdrew ${u6(a.amount)} from lending`];
      case "CollateralDeposited": return ["flow", `${who(a.user)} deposited ${qty(units(a.amount, 18))} ${sym(a.asset)}`];
      case "CollateralWithdrawn": return ["flow", `${who(a.user)} withdrew ${qty(units(a.amount, 18))} ${sym(a.asset)}`];
      case "Borrowed":
        return a.marketOpen
          ? ["flow", `${who(a.user)} borrowed ${u6(a.amount)}`]
          : ["market", `${who(a.user)} borrowed ${u6(a.amount)} after hours, ${u6(a.fee)} went to the gap reserve`];
      case "Repaid": return ["good", `${who(a.payer)} repaid ${u6(a.amount)}${same(a.payer, a.borrower) ? "" : ` for ${who(a.borrower)}`}`];
      case "Liquidated": return ["risk", `${who(a.liquidator)} liquidated ${same(a.liquidator, a.borrower) ? (who(a.liquidator) === "You" ? "your own position" : "their own position") : who(a.borrower)}: repaid ${u6(a.repaid)} for ${qty(units(a.seizedAmount, 18))} ${sym(a.asset)}`];
      case "BadDebtCovered":
        return a.socialized > 0n
          ? ["risk", `Gap reserve covered ${u6(a.fromGapReserve)} of bad debt; ${u6(a.socialized)} fell to lenders`]
          : ["good", `Gap reserve covered ${u6(a.fromGapReserve)} of bad debt. Lenders lost nothing`];
      case "DividendDistributed": return ["good", `${sym(a.asset)} paid a ${u6(a.amount)} dividend to everyone who deposited it`];
      case "DividendApplied":
        return a.repaid > 0n
          ? ["good", `Dividends paid down ${u6(a.repaid)} of ${who(a.user) === "You" ? "your" : who(a.user) + "'s"} loan`]
          : ["good", `${who(a.user)} received ${u6(a.credited)} in dividends`];
      case "DividendClaimed": return ["good", `${who(a.user)} claimed ${u6(a.amount)} in dividends`];
      case "GapReserveFunded": return ["good", `${u6(a.amount)} added to the gap reserve`];
      case "MarketStatusChanged": return ["market", a.open ? "Market opened" : "Market closed for the night"];
      case "PriceMoved": {
        const bps = Number(a.bps);
        return [bps < 0 ? "risk" : "market", `${sym(a.asset)} ${bps < 0 ? "fell" : "rose"} ${Math.abs(bps / 100)}% to ${usd(Number(a.newPrice) / 1e8)}`];
      }
      case "SplitExecuted": {
        const n = Number(a.numerator), d = Number(a.denominator);
        return ["market", n >= d ? `${sym(a.asset)} split ${n}-for-${d}` : `${sym(a.asset)} reverse split ${n}-for-${d}`];
      }
      case "PricesReset": return ["market", "Prices reset to their starting levels"];
      case "FaucetUsed": return ["flow", `${who(a.user)} picked up a starter portfolio`];
      default: return ["flow", f.name];
    }
  }

  function ago(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function renderFeed() {
    const el = $("feed");
    if (!S.feed.length) {
      el.innerHTML = '<li class="empty" style="display:block">No activity yet. Open the demo console to start the story.</li>';
      return;
    }
    el.innerHTML = S.feed
      .map((f) => {
        const [kind, text] = describe(f);
        const time = ago(S.blockTimes.get(f.block));
        const link = explorerTx(f.hash);
        return `<li><span class="feed-icon ${kind}">${FEED_ICON[kind]}</span><span>${esc(text)}</span><span class="feed-time">${link ? `<a href="${link}" target="_blank" rel="noopener">${time || "view"}</a>` : time}</span></li>`;
      })
      .join("");
  }

  // ================================================================== session dial

  const DIAL = { cx: 150, cy: 150 };
  const polar = (min, r) => {
    const ang = (min / 1440) * Math.PI * 2 - Math.PI / 2;
    return [DIAL.cx + r * Math.cos(ang), DIAL.cy + r * Math.sin(ang)];
  };
  const arc = (a, b, r) => {
    const [x1, y1] = polar(a, r);
    const [x2, y2] = polar(b, r);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${b - a > 720 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };

  function buildDial() {
    const ns = "http://www.w3.org/2000/svg";
    let s = `<circle class="dial-face" cx="150" cy="150" r="144" />`;
    for (let h = 0; h < 24; h++) {
      const major = h % 6 === 0;
      const [x1, y1] = polar(h * 60, 144);
      const [x2, y2] = polar(h * 60, major ? 130 : 136);
      s += `<line class="dial-tick${major ? " major" : ""}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    }
    const labels = [[0, "12am"], [360, "6am"], [720, "noon"], [1080, "6pm"]];
    for (const [m, t] of labels) {
      const [x, y] = polar(m, 98);
      s += `<text class="dial-label" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${t}</text>`;
    }
    s += `<g id="dialArcs">`;
    s += `<path class="dial-extended" d="${arc(240, 570, 118)}" stroke-width="10" fill="none" stroke-linecap="round" />`;
    s += `<path class="dial-extended" d="${arc(960, 1200, 118)}" stroke-width="10" fill="none" stroke-linecap="round" />`;
    s += `<path class="dial-session" d="${arc(570, 960, 118)}" stroke-width="14" fill="none" stroke-linecap="round" />`;
    s += `</g>`;
    s += `<g id="dialHand"><line class="dial-hand" x1="150" y1="44" x2="150" y2="4" /><circle class="dial-hub" cx="150" cy="32" r="5" /></g>`;
    const svg = $("dial");
    svg.insertAdjacentHTML("beforeend", s);
    svg.setAttribute("xmlns", ns);
  }

  function nyNow() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const h = Number(get("hour")) % 24;
    const m = Number(get("minute"));
    const sec = Number(get("second"));
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    return { day, minutes: h * 60 + m + sec / 60, h, m };
  }

  function realNyse(t) {
    const weekday = t.day >= 1 && t.day <= 5;
    const open = weekday && t.minutes >= 570 && t.minutes < 960;
    let minsTo;
    if (open) minsTo = 960 - t.minutes;
    else {
      let d = t.day, m = t.minutes, acc = 0;
      for (let i = 0; i < 8; i++) {
        const wd = d >= 1 && d <= 5;
        if (wd && m < 570) { acc += 570 - m; break; }
        acc += 1440 - m;
        m = 0;
        d = (d + 1) % 7;
      }
      minsTo = acc;
    }
    return { open, weekday, minsTo };
  }

  const dur = (mins) => {
    const h = Math.floor(mins / 60), m = Math.floor(mins % 60);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    return h ? `${h}h ${m}m` : `${m}m`;
  };

  function tick() {
    const t = nyNow();
    const deg = (t.minutes / 1440) * 360;
    $("dialHand")?.setAttribute("transform", `rotate(${deg.toFixed(2)} 150 150)`);
    const real = realNyse(t);
    $("dialArcs")?.setAttribute("opacity", real.weekday ? "1" : "0.45");
    const clock = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    $("nyseNote").innerHTML = real.open
      ? `New York ${clock}. NYSE regular session ends in <strong>${dur(real.minsTo)}</strong>.`
      : `New York ${clock}. NYSE opens in <strong>${dur(real.minsTo)}</strong>.`;
    if (S.pool) {
      $("overrideNote").textContent = S.pool.open !== real.open ? "The demo console is setting the session right now." : "";
      const now = Date.now() / 1000;
      const remaining = Math.ceil(S.pool.graceEndsAt - now);
      const showGrace = S.pool.open && remaining > 0 && S.pool.grace > 0;
      $("grace").classList.toggle("show", showGrace);
      if (showGrace) {
        $("graceText").textContent = `Liquidations resume in ${remaining}s`;
        $("graceFill").style.strokeDashoffset = String(50.27 * (1 - remaining / S.pool.grace));
      }
      renderStory();
      renderLiqStatus();
    }
  }

  // ================================================================== render

  function render() {
    renderChrome();
    renderSession();
    renderPosition();
    renderStocks();
    renderPanels();
    renderPool();
    renderStory();
    renderConsoleSelects();
    renderLiqStatus();
  }

  function renderChrome() {
    const chip = $("networkChip");
    chip.classList.toggle("warn", S.wrongChain || !S.netOk);
    $("networkName").textContent = !S.netOk ? "Network unreachable" : S.wrongChain ? `Switch to ${C.network.name}` : C.network.name;
    const btn = $("walletBtn");
    if (S.account) {
      btn.textContent = short(S.account);
      btn.className = "btn btn-ghost";
      btn.title = S.mode === "burner" ? "Instant demo wallet" : "Browser wallet";
    } else {
      btn.textContent = "Connect";
      btn.className = "btn btn-primary";
    }
  }

  function renderSession() {
    if (!S.pool) return;
    const session = S.pool.open ? "open" : "closed";
    if (S.lastSession && S.lastSession !== session) {
      document.body.classList.add("flipping");
      setTimeout(() => document.body.classList.remove("flipping"), 950);
    }
    S.lastSession = session;
    document.body.dataset.session = session;
    $("dialState").textContent = S.pool.open ? "Market open" : "After hours";
    $("dialSub").textContent = S.pool.open
      ? "Full borrowing power"
      : `Overnight limits, ${(S.pool.feeBps / 100).toFixed(2)}% gap fee`;
    document.querySelectorAll("[data-session-set]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.sessionSet === "open") === S.pool.open)));
  }

  function hfClass(hf) {
    if (!isFinite(hf)) return "idle";
    if (hf < 1) return "danger";
    if (hf < 1.25) return "caution";
    return "safe";
  }

  function renderPosition() {
    const a = S.acct;
    const p = S.pool;
    const hfEl = $("hfValue");
    const status = $("hfStatus");
    const actions = $("positionActions");
    actions.innerHTML = "";

    if (!a || !p) {
      hfEl.textContent = "No loan";
      hfEl.className = "hf-value idle";
      status.textContent = "Connect a wallet, deposit a tokenized stock, and borrow USDG against it.";
      actions.innerHTML = `<button class="btn btn-primary" type="button" data-action="connect">Connect</button>`;
      setBar(0, 0, 0, 0, 0);
      setFigures(null);
      return;
    }

    const emptyWallet = S.assets.every((x) => x.wallet === 0 && x.coll === 0) && S.usdgBal === 0n;
    if (emptyWallet) actions.innerHTML = `<button class="btn btn-primary" type="button" data-action="faucet">Get test stocks and USDG</button>`;
    else if (a.credit > 0.005) actions.innerHTML = `<button class="btn btn-quiet" type="button" data-action="claim">Claim ${usd(a.credit)} dividends</button>`;

    if (a.debt < 0.005) {
      hfEl.textContent = "No loan";
      hfEl.className = "hf-value idle";
      status.textContent = a.collateral > 0
        ? `You can borrow up to ${usd(a.avail)} right now.`
        : emptyWallet
          ? "Grab some test stocks to get started. It takes one click."
          : "Deposit a tokenized stock to start borrowing.";
    } else {
      hfEl.textContent = a.hf > 99 ? "99+" : a.hf.toFixed(2);
      hfEl.className = `hf-value ${hfClass(a.hf)}`;
      const graceLeft = Math.ceil(p.graceEndsAt - Date.now() / 1000);
      if (a.hf < 1 && !p.open) {
        status.innerHTML = `<strong>Below 1.0, but protected.</strong> Liquidations wait for the opening price and a ${p.grace}s grace period. Repay or add collateral before then.`;
      } else if (a.hf < 1 && graceLeft > 0) {
        status.innerHTML = `<strong>Liquidatable in ${graceLeft}s.</strong> The opening grace period gives you a last chance to repay.`;
      } else if (a.hf < 1) {
        status.innerHTML = `<strong>Liquidatable.</strong> Anyone can repay part of this loan and take your collateral at a discount.`;
      } else if (a.debt > a.borrowLimit + 0.01) {
        status.innerHTML = p.open
          ? `<strong>Above your borrow limit.</strong> New borrowing pauses until you repay or add collateral.`
          : `<strong>Above the overnight limit, and that's fine.</strong> Existing loans aren't liquidated for it. New borrowing waits for the open.`;
      } else {
        const drop = (1 - 1 / a.hf) * 100;
        status.innerHTML = `Liquidation only if your collateral falls about <strong>${drop.toFixed(0)}%</strong>, and never on a frozen overnight price.`;
      }
    }
    setBar(a.debt, a.openLimit, a.closedLimit, a.liqLimit, a.hf, a.borrowLimit);
    setFigures(a);
  }

  function setBar(debt, openLimit, closedLimit, liqLimit, hf, borrowLimit = 0) {
    const scale = liqLimit > 0 ? liqLimit : 1;
    const clamp = (v) => Math.max(0, Math.min(100, (v / scale) * 100));
    const fill = $("limitFill");
    fill.style.width = `${liqLimit > 0 ? clamp(debt) : 0}%`;
    const state = hf < 1 ? " liq" : debt > borrowLimit + 0.01 ? " over" : "";
    fill.className = `limit-fill${state}`;
    document.querySelector(".legend-swatch.fill").className = `legend-swatch fill${state}`;
    $("markOpen").style.left = `calc(${liqLimit > 0 ? clamp(openLimit) : 0}% - 1px)`;
    $("markClosed").style.left = `calc(${liqLimit > 0 ? clamp(closedLimit) : 0}% - 1px)`;
    $("markOpen").style.display = liqLimit > 0 ? "" : "none";
    $("markClosed").style.display = liqLimit > 0 ? "" : "none";
    $("legendDebt").textContent = `Borrowed ${usd(debt)}`;
    $("legendOpen").textContent = `Limit while open ${usd(openLimit)}`;
    $("legendClosed").textContent = `Overnight ${usd(closedLimit)}`;
    $("legendLiq").textContent = liqLimit > 0 ? `Bar ends at liquidation, ${usd(liqLimit)}` : "Bar ends at the liquidation point";
  }

  function setFigures(a) {
    const deposited = S.assets.filter((x) => x.coll > 0).length;
    $("figCollateral").textContent = usd(a ? a.collateral : 0);
    $("figCollateralFoot").textContent = `Across ${deposited} stock${deposited === 1 ? "" : "s"}`;
    $("figDebt").textContent = usd(a ? a.debt : 0);
    $("figDebtFoot").textContent = S.pool ? `${rate(S.pool.borrowApr)} APR` : "USDG";
    $("figAvail").textContent = usd(a ? a.avail : 0);
    $("figAvailFoot").textContent = S.pool && !S.pool.open ? "At overnight limits" : "At market-hours limits";
    $("figDiv").textContent = usd(a ? a.credit : 0);
    $("figDivFoot").innerHTML = a && a.credit > 0.005
      ? `<button type="button" data-action="claim">Claim to wallet</button>`
      : "Applied to your loan first";
  }

  function renderStocks() {
    const rows = $("stockRows");
    if (!S.assets.length) return;
    const canAct = !!S.account;
    rows.innerHTML = S.assets
      .map((x) => {
        const base = S.base.get(x.token.toLowerCase()) || 0;
        const delta = base ? x.price / base - 1 : 0;
        let sub = "";
        const moved = Math.abs(delta) > 0.0005 ? `${delta > 0 ? "+" : "−"}${pct(Math.abs(delta))} vs start` : "";
        if (S.pool?.open && !x.fresh) sub = `<div class="delta muted">Waiting for a fresh price</div>`;
        else if (!S.pool?.open) sub = `<div class="delta muted">Last price${moved ? `, ${moved}` : ""}</div>`;
        else if (moved) sub = `<div class="delta ${delta > 0 ? "up" : "down"}">${moved}</div>`;
        const openActive = x.fresh;
        return `<tr>
          <td><div class="ticker"><span class="ticker-badge">${esc(ticker(x.symbol))}</span><div><div class="ticker-sym">${esc(x.symbol)}</div><div class="ticker-name">${esc(x.name.replace(" (Tokenized)", ""))}</div></div></div></td>
          <td><div class="price">${usd(x.price, { digits: 2 })}</div>${sub}</td>
          <td>${canAct ? `<div>${qty(x.wallet)}</div><div class="small muted">${usd(x.wallet * x.price)}</div>` : '<span class="muted">—</span>'}</td>
          <td>${canAct ? `<div>${qty(x.coll)}</div><div class="small muted">${usd(x.collValue)}</div>` : '<span class="muted">—</span>'}</td>
          <td><span class="ltv-pair"><span class="${openActive ? "active" : "inactive"}">${pct(x.ltvOpen, 0)}</span> / <span class="${openActive ? "inactive" : "active"}">${pct(x.ltvClosed, 0)}</span></span></td>
          <td><span class="row-actions">
            <button class="btn btn-quiet btn-sm" type="button" data-coll="deposit" data-token="${x.token}" ${canAct && x.wallet > 0 ? "" : "disabled"}>Deposit</button>
            <button class="btn btn-ghost btn-sm" type="button" data-coll="withdraw" data-token="${x.token}" ${canAct && x.coll > 0 ? "" : "disabled"}>Withdraw</button>
          </span></td>
        </tr>`;
      })
      .join("");
    $("stocksSub").textContent = S.pool?.open
      ? "Market hours: the higher limit applies"
      : "After hours: the overnight limit applies";
  }

  // ------------------------------------------------------------------ action panel

  function row(label, value, cls = "") {
    return `<div class="preview-row"><span>${label}</span><span class="${cls}">${value}</span></div>`;
  }

  function hfText(hf) {
    if (!isFinite(hf)) return "No loan";
    return hf > 99 ? "99+" : hf.toFixed(2);
  }

  function renderPanels() {
    const a = S.acct;
    const p = S.pool;
    document.querySelectorAll("[data-pane]").forEach((el) => (el.hidden = el.dataset.pane !== S.tab));
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === S.tab)));
    if (!p) return;

    // Borrow
    const bIn = parseAmount($("borrowInput").value, 6);
    const bAmt = bIn ? units(bIn, 6) : 0;
    const fee = p.open ? 0 : (bAmt * p.feeBps) / 10000;
    $("borrowAvail").textContent = `Available ${usd(a ? a.avail : 0)}`;
    const callout = $("borrowCallout");
    if (a && a.debt > a.borrowLimit + 0.01 && !p.open) {
      callout.hidden = false;
      callout.className = "callout";
      callout.textContent = "You're above the overnight limit, so new borrowing waits for the market to open. Your loan is safe.";
    } else if (!p.open) {
      callout.hidden = false;
      callout.className = "callout";
      callout.textContent = `The market is closed. You can still borrow up to the overnight limit; a ${(p.feeBps / 100).toFixed(2)}% fee goes to the gap reserve that protects lenders from opening gaps.`;
    } else callout.hidden = true;

    let bPrev = "";
    if (a) {
      const newDebt = a.debt + bAmt;
      const newHf = newDebt > 0 ? a.liqLimit / newDebt : Infinity;
      bPrev += row("You receive", usd(bAmt - fee));
      if (!p.open) bPrev += row("After-hours fee", usd(fee));
      bPrev += row("Health factor", bAmt ? `${hfText(a.hf)} to ${hfText(newHf)}` : hfText(a.hf), bAmt && newHf < 1.25 ? "warn" : bAmt ? "after" : "");
      bPrev += row("Borrow APR", rate(p.borrowApr));
    } else bPrev = row("Borrow APR", rate(p.borrowApr));
    $("borrowPreview").innerHTML = bPrev;
    const bBtn = $("borrowBtn");
    if (!S.busy.has("borrow")) {
      if (!a) { bBtn.textContent = "Connect to borrow"; bBtn.disabled = false; }
      else if (bAmt > a.avail + 1e-6) { bBtn.textContent = "Above your limit"; bBtn.disabled = true; }
      else { bBtn.textContent = bAmt ? `Borrow ${usd(bAmt)}` : "Borrow USDG"; bBtn.disabled = !bAmt; }
    }

    // Repay
    const wallet = units(S.usdgBal, 6);
    const rIn = parseAmount($("repayInput").value, 6);
    const rAmt = rIn ? units(rIn, 6) : 0;
    $("repayOwed").textContent = `Owed ${usd(a ? a.debt : 0)}`;
    let rPrev = "";
    if (a) {
      const left = Math.max(0, a.debt - rAmt);
      const newHf = left > 0.005 ? a.liqLimit / left : Infinity;
      rPrev += row("Loan after", usd(left));
      rPrev += row("Health factor", rAmt ? `${hfText(a.hf)} to ${hfText(newHf)}` : hfText(a.hf), rAmt ? "after" : "");
      rPrev += row("USDG in wallet", usd(wallet));
    }
    $("repayPreview").innerHTML = rPrev;
    const rBtn = $("repayBtn");
    if (!S.busy.has("repay")) {
      if (!a) { rBtn.textContent = "Connect to repay"; rBtn.disabled = false; }
      else if (a.debt < 0.005) { rBtn.textContent = "No loan to repay"; rBtn.disabled = true; }
      else if (rAmt > wallet + 1e-6) { rBtn.textContent = "Not enough USDG"; rBtn.disabled = true; }
      else { rBtn.textContent = rAmt ? (rAmt >= a.debt - 0.005 ? "Repay in full" : `Repay ${usd(rAmt)}`) : "Repay USDG"; rBtn.disabled = !rAmt; }
    }

    // Earn
    const supplying = S.earnMode === "supply";
    document.querySelectorAll("[data-earn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.earn === S.earnMode)));
    $("earnLabel").textContent = supplying ? "Amount to supply" : "Amount to withdraw";
    $("earnBal").textContent = supplying ? `Wallet ${usd(wallet)}` : `Supplied ${usd(a ? a.supplyBal : 0)}`;
    const eIn = parseAmount($("earnInput").value, 6);
    const eAmt = eIn ? units(eIn, 6) : 0;
    let ePrev = row("Supply APR", rate(p.supplyApr), "after");
    if (a) {
      const after = supplying ? a.supplyBal + eAmt : Math.max(0, a.supplyBal - eAmt);
      ePrev += row("Your supply after", usd(after));
      ePrev += row("Yearly earnings", usd(after * p.supplyApr));
    }
    ePrev += row("Protected by the gap reserve", usd(p.gapReserve, { compact: true }));
    $("earnPreview").innerHTML = ePrev;
    const eBtn = $("earnBtn");
    if (!S.busy.has("earn")) {
      const limit = supplying ? wallet : a ? a.supplyBal : 0;
      if (!a) { eBtn.textContent = "Connect to earn"; eBtn.disabled = false; }
      else if (eAmt > limit + 1e-6) { eBtn.textContent = supplying ? "Not enough USDG" : "More than you supplied"; eBtn.disabled = true; }
      else { eBtn.textContent = supplying ? (eAmt ? `Supply ${usd(eAmt)}` : "Supply USDG") : eAmt ? `Withdraw ${usd(eAmt)}` : "Withdraw USDG"; eBtn.disabled = !eAmt; }
    }
  }

  function renderPool() {
    const p = S.pool;
    if (!p) return;
    const reserveCover = p.totalBorrows > 0 ? p.gapReserve / p.totalBorrows : 0;
    $("poolStats").innerHTML = `
      <div class="stat"><span>Lent by suppliers</span><strong>${usd(p.totalSupply, { compact: true })}</strong></div>
      <div class="stat" style="display:block"><div style="display:flex;justify-content:space-between"><span class="muted">Borrowed</span><strong>${usd(p.totalBorrows, { compact: true })}</strong></div><div class="util"><i style="width:${(p.util * 100).toFixed(2)}%"></i></div><div class="small muted" style="margin-top:4px">${pct(p.util)} of the pool is in use</div></div>
      <div class="stat"><span>Borrow APR</span><strong>${rate(p.borrowApr)}</strong></div>
      <div class="stat"><span>Supply APR</span><strong>${rate(p.supplyApr)}</strong></div>
      <div class="stat"><span>Gap reserve</span><strong>${usd(p.gapReserve)}</strong></div>
      <div class="stat"><span>Reserve covers</span><strong>${p.totalBorrows > 0 ? (reserveCover >= 1 ? `${reserveCover.toFixed(1)}× all borrows` : `${pct(reserveCover)} of borrows`) : "—"}</strong></div>
      <div class="stat"><span>Stock collateral</span><strong>${usd(p.collateralValue, { compact: true })}</strong></div>
      <div class="stat"><span>After-hours fee</span><strong>${(p.feeBps / 100).toFixed(2)}%</strong></div>`;
    $("poolSub").textContent = p.paused ? "Paused" : "USDG market";
  }

  // ------------------------------------------------------------------ demo console

  const nvda = () => S.assets.find((x) => x.symbol === "tNVDA") || S.assets[0];

  const STORY = [
    {
      id: "faucet", title: "Get a starter portfolio", desc: "25,000 USDG plus shares of every stock.", btn: "Claim",
      run: () => send("Claiming starter portfolio", () => w.demo().faucet(), "Starter portfolio received"),
    },
    {
      id: "borrow", title: "Borrow against NVIDIA", desc: "Deposits 30 tNVDA and borrows half its value, in one transaction.", btn: "Run",
      run: async () => {
        const n = nvda();
        if (!n || n.wallet < 1) {
          toast("Claim the starter portfolio first", "error", "You need some tNVDA in your wallet.");
          return false;
        }
        const shares = Math.min(30, Math.floor(n.wallet));
        const amt = ethers.parseUnits(String(shares), 18);
        const borrowUsd = Math.floor(shares * n.price * 0.5 * 100) / 100;
        if (!(await ensureAllowance(n.token, amt, n.symbol))) return false;
        return send(`Depositing ${shares} ${n.symbol} and borrowing ${usd(borrowUsd)}`,
          () => w.pool().depositAndBorrow(n.token, amt, ethers.parseUnits(borrowUsd.toFixed(2), 6)), `Borrowed ${usd(borrowUsd)}`);
      },
    },
    {
      id: "close", title: "Close the market", desc: "Limits drop to overnight levels. Your loan stays safe.", btn: "Close",
      run: () => send("Closing the market", () => w.demo().setMarketOpen(false), "Market closed"),
    },
    {
      id: "gap", title: "NVIDIA opens 30% lower", desc: "Bad news overnight. The market opens on a gapped price, then the grace period starts.", btn: "Open",
      run: () => send("Opening with a 30% gap", () => w.demo().openWithGap(nvda().token, -3000), "Market opened 30% lower"),
    },
    {
      id: "liquidate", title: "Liquidate after the grace period", desc: "Repay part of the loan and take tNVDA at a discount. Here you liquidate yourself.", btn: "Liquidate",
      run: () => liquidate(S.account, nvda().token),
    },
    {
      id: "dividend", title: "Pay a $5 NVIDIA dividend", desc: "It goes straight to paying down the loan.", btn: "Pay",
      run: async () => {
        const ok = await send("Paying a $5.00 dividend", () => w.demo().declareDividend(nvda().token, 5_000_000n), "Dividend paid");
        if (ok) await send("Applying the dividend to your loan", () => w.pool().settle(S.account), "Dividend applied to your loan");
        return ok;
      },
    },
    {
      id: "split", title: "Split NVIDIA 2-for-1", desc: "Share count doubles and the price halves. Your health factor doesn't move.", btn: "Split",
      run: () => send("Splitting 2-for-1", () => w.demo().split(nvda().token, 2, 1), "Split complete"),
    },
  ];

  function buildStory() {
    $("story").innerHTML = STORY.map((s) => `<li data-step="${s.id}"><span><span class="step-title">${esc(s.title)}</span><br><span class="step-desc">${esc(s.desc)}</span></span><button class="btn btn-quiet btn-sm" type="button" data-run="${s.id}">${esc(s.btn)}</button></li>`).join("") +
      `<li style="grid-template-columns:1fr auto;counter-increment:none" class="story-reset"><span class="step-desc">Run it again from the top.</span><button class="btn btn-ghost btn-sm" type="button" id="storyReset">Start over</button></li>`;
    const style = document.createElement("style");
    style.textContent = ".story li.story-reset::before{display:none}";
    document.head.appendChild(style);
  }

  function renderStory() {
    for (const s of STORY) {
      const li = document.querySelector(`[data-step="${s.id}"]`);
      if (!li) continue;
      li.classList.toggle("done", S.story.has(s.id));
      const btn = li.querySelector("button");
      if (S.busy.has(`story:${s.id}`)) continue;
      let label = s.btn;
      let disabled = !S.account || !S.pool;
      if (s.id === "liquidate" && S.pool) {
        const left = Math.ceil(S.pool.graceEndsAt - Date.now() / 1000);
        if (!S.pool.open) { disabled = true; label = "Market closed"; }
        else if (left > 0) { disabled = true; label = `${left}s`; }
      }
      btn.textContent = label;
      btn.disabled = disabled;
    }
  }

  let selectsBuilt = "";
  function renderConsoleSelects() {
    const key = S.assets.map((a) => a.token + a.symbol).join();
    if (!S.assets.length || key === selectsBuilt) return;
    selectsBuilt = key;
    const opts = S.assets.map((a) => `<option value="${a.token}">${esc(a.symbol)}</option>`).join("");
    for (const id of ["moveAsset", "caAsset", "liqAsset"]) {
      const el = $(id);
      const prev = el.value;
      el.innerHTML = opts;
      if (prev) el.value = prev;
    }
  }

  function renderLiqStatus() {
    const el = $("liqStatus");
    const btn = $("liquidateBtn");
    if (!S.pool || !S.assets.length) return;
    const asset = S.assets.find((a) => same(a.token, $("liqAsset").value)) || S.assets[0];
    const left = Math.ceil(S.pool.graceEndsAt - Date.now() / 1000);
    let msg = "";
    if (!S.pool.open) msg = "Market closed";
    else if (!asset.fresh) msg = "Needs a fresh price";
    else if (left > 0) msg = `Grace period, ${left}s`;
    else msg = "Open for liquidations";
    el.textContent = msg;
    if (!S.busy.has("liquidate")) btn.disabled = !S.account || !S.pool.open || left > 0;
  }

  async function liquidate(borrower, token) {
    const asset = S.assets.find((a) => same(a.token, token));
    const debtRaw = await read.pool.debtOf(borrower);
    if (debtRaw === 0n) {
      toast("Nothing to liquidate", "error", "That address has no loan.");
      return false;
    }
    if (!(await ensureAllowance(C.contracts.usdg, debtRaw * 2n, "USDG"))) return false;
    return send(`Liquidating ${same(borrower, S.account) ? "your position" : short(borrower)}`,
      () => w.pool().liquidate(borrower, token, MAX), `Liquidated, received discounted ${asset?.symbol || "stock"}`);
  }

  // ================================================================== dialogs

  function openConnect() {
    $("connectDialog").showModal();
  }

  function openAccount() {
    if (!S.account) return openConnect();
    $("acctAddr").textContent = S.account;
    const eth = units(S.ethBal, 18);
    $("acctStats").innerHTML = `
      <div class="stat"><span>Wallet type</span><strong>${S.mode === "burner" ? "Instant demo wallet" : "Browser wallet"}</strong></div>
      <div class="stat"><span>ETH for gas</span><strong>${eth.toLocaleString("en-US", { maximumFractionDigits: 5 })}</strong></div>
      <div class="stat"><span>USDG</span><strong>${usd(units(S.usdgBal, 6))}</strong></div>`;
    const low = !IS_LOCAL && eth < 0.0005;
    const callout = $("gasCallout");
    callout.hidden = !low;
    if (low) {
      callout.innerHTML = `This wallet needs a little testnet ETH for gas.${FAUCET_URL ? ` Get some from the <a href="${FAUCET_URL}" target="_blank" rel="noopener">Robinhood Chain faucet</a>` : " Use a faucet"}, or send it from your browser wallet.`;
    }
    $("topUpBtn").hidden = !(S.mode === "burner" && window.ethereum && !IS_LOCAL);
    $("accountDialog").showModal();
  }

  function openColl(token, mode) {
    const asset = S.assets.find((a) => same(a.token, token));
    if (!asset) return;
    S.coll = { token, mode };
    $("collTitle").textContent = `${mode === "deposit" ? "Deposit" : "Withdraw"} ${asset.symbol}`;
    $("collUnit").textContent = asset.symbol;
    $("collInput").value = "";
    $("collDialog").showModal();
    renderColl();
    setTimeout(() => $("collInput").focus(), 50);
  }

  function renderColl() {
    const asset = S.assets.find((a) => same(a.token, S.coll.token));
    const a = S.acct;
    if (!asset || !a) return;
    const deposit = S.coll.mode === "deposit";
    const max = deposit ? asset.wallet : asset.coll;
    $("collLabel").textContent = deposit ? "Shares to deposit" : "Shares to withdraw";
    $("collBal").textContent = deposit ? `In wallet ${qty(max, 4)}` : `Deposited ${qty(max, 4)}`;
    const v = parseAmount($("collInput").value, 18);
    const n = v ? units(v, 18) : 0;
    const sign = deposit ? 1 : -1;
    const ltv = asset.fresh ? asset.ltvOpen : asset.ltvClosed;
    const newLimit = Math.max(0, a.borrowLimit + sign * n * asset.price * ltv);
    const newLiq = Math.max(0, a.liqLimit + sign * n * asset.price * asset.liqT);
    const newHf = a.debt > 0.005 ? newLiq / a.debt : Infinity;
    let html = row("Value", usd(n * asset.price));
    html += row("Borrow limit", n ? `${usd(a.borrowLimit)} to ${usd(newLimit)}` : usd(a.borrowLimit), n ? "after" : "");
    if (a.debt > 0.005) html += row("Health factor", n ? `${hfText(a.hf)} to ${hfText(newHf)}` : hfText(a.hf), n && newHf < 1.1 ? "warn" : n ? "after" : "");
    $("collPreview").innerHTML = html;
    const btn = $("collBtn");
    if (S.busy.has("coll")) return;
    const tooRisky = !deposit && a.debt > 0.005 && newLimit < a.debt;
    if (n > max + 1e-9) { btn.textContent = "More than you have"; btn.disabled = true; }
    else if (tooRisky) { btn.textContent = "Repay first to withdraw this much"; btn.disabled = true; }
    else { btn.textContent = `${deposit ? "Deposit" : "Withdraw"} ${n ? qty(n, 4) + " " : ""}${asset.symbol}`; btn.disabled = !n; }
  }

  function closeDialogs() {
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  }

  function toggleConsole(open) {
    $("console").classList.toggle("open", open);
    $("console").setAttribute("aria-hidden", String(!open));
    $("scrim").classList.toggle("show", open);
  }

  // ================================================================== events

  function bind() {
    $("walletBtn").addEventListener("click", () => (S.account ? openAccount() : openConnect()));
    $("networkChip").addEventListener("click", () => S.wrongChain && ensureChain().then(() => poll(true)));
    $("useBurner").addEventListener("click", () => connectBurner(false));
    $("useInjected").addEventListener("click", () => connectInjected(false));
    $("disconnectBtn").addEventListener("click", disconnect);
    $("copyAddr").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(S.account);
        toast("Address copied", "success");
      } catch {
        toast("Couldn't copy", "error", "Select the address and copy it manually.");
      }
    });
    $("topUpBtn").addEventListener("click", async () => {
      const target = S.account;
      const prevMode = S.mode;
      try {
        const eth = window.ethereum;
        await eth.request({ method: "eth_requestAccounts" });
        S.mode = "injected";
        const ok = await ensureChain();
        S.mode = prevMode;
        S.wrongChain = false;
        if (!ok) return;
        const signer = await new ethers.BrowserProvider(eth).getSigner();
        const t = toast("Sending 0.005 ETH", "pending", "Confirm in your wallet");
        const tx = await signer.sendTransaction({ to: target, value: ethers.parseEther("0.005") });
        t.update("Sending 0.005 ETH", "pending", "Waiting for confirmation", tx.hash);
        await tx.wait();
        t.update("Demo wallet topped up", "success", "", tx.hash);
        S.signer = new ethers.Wallet(storeGet("burner"), rpc);
        poll(true);
        closeDialogs();
      } catch (e) {
        S.mode = prevMode;
        toast("Top-up didn't go through", "error", friendlyError(e));
      }
    });

    document.querySelectorAll("dialog").forEach((d) => {
      d.addEventListener("click", (e) => {
        if (e.target === d || e.target.closest("[data-close]")) d.close();
      });
    });

    document.addEventListener("click", (e) => {
      const act = e.target.closest("[data-action]");
      if (!act) return;
      const a = act.dataset.action;
      if (a === "connect") openConnect();
      if (a === "faucet") withBusy("faucet", act, () => send("Claiming starter portfolio", () => w.demo().faucet(), "Starter portfolio received").then((ok) => ok && markStory("faucet")));
      if (a === "claim") withBusy("claim", act, () => send("Claiming dividends", () => w.pool().claimDividends(), "Dividends claimed"));
    });

    // tabs
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => { S.tab = t.dataset.tab; renderPanels(); }));
    document.querySelectorAll("[data-earn]").forEach((b) => b.addEventListener("click", () => { S.earnMode = b.dataset.earn; $("earnInput").value = ""; renderPanels(); }));
    ["borrowInput", "repayInput", "earnInput"].forEach((id) => $(id).addEventListener("input", renderPanels));
    $("collInput").addEventListener("input", renderColl);

    // max buttons
    document.querySelectorAll("[data-max]").forEach((b) =>
      b.addEventListener("click", () => {
        const a = S.acct;
        if (!a) return openConnect();
        const wallet = units(S.usdgBal, 6);
        if (b.dataset.max === "borrow") $("borrowInput").value = toInput(a.avail * 0.999, 2);
        if (b.dataset.max === "repay") $("repayInput").value = toInput(Math.min(a.debt, wallet) + (wallet > a.debt ? 0.01 : 0), 2);
        if (b.dataset.max === "earn") $("earnInput").value = toInput(S.earnMode === "supply" ? wallet : a.supplyBal, 2);
        renderPanels();
      }),
    );
    $("collMax").addEventListener("click", () => {
      const asset = S.assets.find((x) => same(x.token, S.coll.token));
      if (!asset) return;
      $("collInput").value = toInput(S.coll.mode === "deposit" ? asset.wallet : asset.coll, 6);
      $("collInput").dataset.max = "1";
      renderColl();
    });
    $("collInput").addEventListener("input", () => delete $("collInput").dataset.max);

    // actions
    $("borrowBtn").addEventListener("click", () => {
      if (!S.account) return openConnect();
      const amt = parseAmount($("borrowInput").value, 6);
      if (!amt) return;
      withBusy("borrow", $("borrowBtn"), async () => {
        const ok = await send(`Borrowing ${usd(units(amt, 6))}`, () => w.pool().borrow(amt), `Borrowed ${usd(units(amt, 6))}`);
        if (ok) $("borrowInput").value = "";
      });
    });

    $("repayBtn").addEventListener("click", () => {
      if (!S.account) return openConnect();
      const amt = parseAmount($("repayInput").value, 6);
      if (!amt || !S.acct) return;
      const full = units(amt, 6) >= S.acct.debt - 0.005;
      withBusy("repay", $("repayBtn"), async () => {
        if (!(await ensureAllowance(C.contracts.usdg, amt * 2n, "USDG"))) return;
        const ok = await send(full ? "Repaying in full" : `Repaying ${usd(units(amt, 6))}`, () => w.pool().repay(S.account, full ? MAX : amt), full ? "Loan repaid" : "Repaid");
        if (ok) $("repayInput").value = "";
      });
    });

    $("earnBtn").addEventListener("click", () => {
      if (!S.account) return openConnect();
      const amt = parseAmount($("earnInput").value, 6);
      if (!amt || !S.acct) return;
      const supplying = S.earnMode === "supply";
      withBusy("earn", $("earnBtn"), async () => {
        let ok;
        if (supplying) {
          if (!(await ensureAllowance(C.contracts.usdg, amt, "USDG"))) return;
          ok = await send(`Supplying ${usd(units(amt, 6))}`, () => w.pool().supply(amt), "Supplied");
        } else {
          const all = units(amt, 6) >= S.acct.supplyBal - 0.005;
          ok = await send(`Withdrawing ${usd(units(amt, 6))}`, () => w.pool().withdrawSupply(all ? MAX : amt), "Withdrawn");
        }
        if (ok) $("earnInput").value = "";
      });
    });

    $("stockRows").addEventListener("click", (e) => {
      const b = e.target.closest("[data-coll]");
      if (b) openColl(b.dataset.token, b.dataset.coll);
    });

    $("collBtn").addEventListener("click", () => {
      const asset = S.assets.find((x) => same(x.token, S.coll.token));
      const amt = parseAmount($("collInput").value, 18);
      if (!asset || !amt) return;
      const deposit = S.coll.mode === "deposit";
      const useMax = !!$("collInput").dataset.max;
      withBusy("coll", $("collBtn"), async () => {
        let ok;
        if (deposit) {
          const send_ = useMax ? asset.walletRaw : amt;
          if (!(await ensureAllowance(asset.token, send_, asset.symbol))) return;
          ok = await send(`Depositing ${qty(units(send_, 18), 4)} ${asset.symbol}`, () => w.pool().depositCollateral(asset.token, send_), `${asset.symbol} deposited`);
        } else {
          ok = await send(`Withdrawing ${asset.symbol}`, () => w.pool().withdrawCollateral(asset.token, useMax ? MAX : amt), `${asset.symbol} withdrawn`);
        }
        if (ok) closeDialogs();
      });
    });

    // demo console
    $("consoleBtn").addEventListener("click", () => toggleConsole(true));
    $("consoleClose").addEventListener("click", () => toggleConsole(false));
    $("scrim").addEventListener("click", () => toggleConsole(false));
    document.addEventListener("keydown", (e) => e.key === "Escape" && toggleConsole(false));

    $("story").addEventListener("click", (e) => {
      if (e.target.id === "storyReset") {
        return withBusy("story:reset", e.target, async () => {
          const ok = await send("Resetting prices", () => w.demo().resetPrices(), "Prices reset");
          if (ok && !S.pool.open) await send("Opening the market", () => w.demo().setMarketOpen(true), "Market opened");
          S.story.clear();
          storeSet("story", []);
          renderStory();
        });
      }
      const b = e.target.closest("[data-run]");
      if (!b) return;
      if (!S.account) return openConnect();
      const step = STORY.find((s) => s.id === b.dataset.run);
      withBusy(`story:${step.id}`, b, async () => {
        const ok = await step.run();
        if (ok) markStory(step.id);
      });
    });

    document.querySelectorAll("[data-session-set]").forEach((b) =>
      b.addEventListener("click", () => {
        const open = b.dataset.sessionSet === "open";
        withBusy("session", b, () => send(open ? "Opening the market" : "Closing the market", () => w.demo().setMarketOpen(open), open ? "Market opened" : "Market closed"));
      }),
    );
    $("refreshPricesBtn").addEventListener("click", (e) => withBusy("refresh", e.currentTarget, () => send("Publishing fresh prices", () => w.demo().refreshPrices(), "Prices published")));
    document.querySelectorAll("[data-move]").forEach((b) =>
      b.addEventListener("click", () => {
        const bps = Number(b.dataset.move);
        const token = $("moveAsset").value;
        const sym = S.symbols.get(token.toLowerCase());
        withBusy(`move${bps}`, b, () => send(`Moving ${sym} ${bps > 0 ? "+" : "−"}${Math.abs(bps / 100)}%`, () => w.demo().movePrice(token, bps), `${sym} price updated`));
      }),
    );
    $("gapOpenBtn").addEventListener("click", (e) => {
      const token = $("moveAsset").value;
      withBusy("gapopen", e.currentTarget, () => send("Opening with a 30% gap", () => w.demo().openWithGap(token, -3000), "Market opened on a gap"));
    });
    $("resetPricesBtn").addEventListener("click", (e) => withBusy("reset", e.currentTarget, () => send("Resetting prices", () => w.demo().resetPrices(), "Prices reset")));
    $("dividendBtn").addEventListener("click", (e) => {
      const per = parseAmount($("divAmount").value, 6);
      if (!per) return toast("Enter a dividend amount", "error", "For example 2.50 USDG per share.");
      const token = $("caAsset").value;
      withBusy("div", e.currentTarget, () => send(`Paying ${usd(units(per, 6))} per share`, () => w.demo().declareDividend(token, per), "Dividend paid"));
    });
    document.querySelectorAll("[data-split]").forEach((b) =>
      b.addEventListener("click", () => {
        const [n, d] = b.dataset.split.split(",").map(Number);
        const token = $("caAsset").value;
        withBusy(`split${n}${d}`, b, () => send(`Splitting ${n}-for-${d}`, () => w.demo().split(token, n, d), "Split complete"));
      }),
    );
    $("liqAsset").addEventListener("change", renderLiqStatus);
    $("liquidateBtn").addEventListener("click", (e) => {
      const raw = $("liqBorrower").value.trim();
      const borrower = raw || S.account;
      if (!borrower || !ethers.isAddress(borrower)) return toast("Enter a valid address", "error", "Or leave it blank to use your own.");
      withBusy("liquidate", e.currentTarget, () => liquidate(ethers.getAddress(borrower), $("liqAsset").value));
    });
  }

  function markStory(id) {
    S.story.add(id);
    storeSet("story", [...S.story]);
    renderStory();
  }

  // ================================================================== boot

  async function boot() {
    buildDial();
    buildStory();
    bind();
    tick();
    $("networkName").textContent = C.network.name;
    await poll(true);
    pollEvents();
    const mode = storeGet("mode", null);
    if (mode === "burner") connectBurner(true);
    else if (mode === "injected") connectInjected(true);
    setInterval(() => poll(false), 2000);
    setInterval(pollEvents, 4000);
    setInterval(tick, 1000);
    setInterval(renderFeed, 15000);
  }

  boot();
})();
