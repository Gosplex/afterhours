/* AfterHours landing page */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (window.lucide) window.lucide.createIcons();

  // ------------------------------------------------------------------ nav

  const nav = $("nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 20);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  $("menuBtn").addEventListener("click", () => {
    const open = !nav.classList.contains("open");
    nav.classList.toggle("open", open);
    $("menuBtn").setAttribute("aria-expanded", String(open));
  });
  $("navLinks").addEventListener("click", (e) => {
    if (e.target.closest("a")) {
      nav.classList.remove("open");
      $("menuBtn").setAttribute("aria-expanded", "false");
    }
  });

  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // ------------------------------------------------------------------ hero time-lapse

  const polar = (min, r) => {
    const a = (min / 1440) * Math.PI * 2 - Math.PI / 2;
    return [150 + r * Math.cos(a), 150 + r * Math.sin(a)];
  };
  const arc = (a, b, r) => {
    const [x1, y1] = polar(a, r);
    const [x2, y2] = polar(b, r);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${b - a > 720 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };

  (function buildDial() {
    let s = "";
    for (let h = 0; h < 24; h++) {
      const major = h % 6 === 0;
      const [x1, y1] = polar(h * 60, 140);
      const [x2, y2] = polar(h * 60, major ? 124 : 132);
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-opacity="${major ? 0.5 : 0.25}" stroke-width="${major ? 3 : 2}"/>`;
    }
    s += `<path d="${arc(240, 570, 112)}" stroke="var(--h-accent)" stroke-opacity="0.22" stroke-width="12" fill="none" stroke-linecap="round"/>`;
    s += `<path d="${arc(960, 1200, 112)}" stroke="var(--h-accent)" stroke-opacity="0.22" stroke-width="12" fill="none" stroke-linecap="round"/>`;
    s += `<path d="${arc(570, 960, 112)}" stroke="var(--h-accent)" stroke-width="18" fill="none" stroke-linecap="round"/>`;
    s += `<g id="heroHand"><line x1="150" y1="58" x2="150" y2="6" stroke="var(--h-accent)" stroke-width="5" stroke-linecap="round"/><circle cx="150" cy="38" r="8" fill="var(--h-accent)"/></g>`;
    $("heroDial").innerHTML = s;
    $("heroDial").style.color = "var(--h-text)";
  })();

  const fmtClock = (min, withSpace) => {
    const h24 = Math.floor(min / 60) % 24;
    const m = Math.floor(min % 60);
    const h = h24 % 12 || 12;
    return `${h}:${String(m).padStart(2, "0")}${withSpace ? " " : ""}${h24 < 12 ? "am" : "pm"}`;
  };

  const hero = $("hero");
  const chip = $("chip");
  let phase = "night";

  function setPhase(next) {
    if (next === phase) return;
    phase = next;
    hero.dataset.phase = next;
    document.body.dataset.heroPhase = next;
    const day = next === "day";
    $("shotDay").classList.toggle("hide", !day);
    $("shotNight").classList.toggle("hide", day);
    $("dialState").textContent = day ? "Market open" : "After hours";
    $("chipTitle").textContent = day ? "Market-hours limit 60%" : "Overnight limit 40%";
    $("chipSub").textContent = day ? "Full borrowing power on tNVDA" : "0.30% fee funds the gap reserve";
    $("chipIcon").innerHTML = `<i data-lucide="${day ? "sun" : "moon-star"}"></i>`;
    if (window.lucide) window.lucide.createIcons({ nodes: [$("chipIcon")] });
    chip.classList.remove("swap");
    void chip.offsetWidth;
    chip.classList.add("swap");
  }

  function renderTime(min) {
    $("heroHand").setAttribute("transform", `rotate(${((min / 1440) * 360).toFixed(2)} 150 150)`);
    $("heroClock").textContent = `${fmtClock(min)}.`;
    $("dialTime").textContent = `${fmtClock(min, true)} ET`;
    setPhase(min >= 570 && min < 960 ? "day" : "night");
  }

  function nyMinutes() {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
    return (Number(p.find((x) => x.type === "hour").value) % 24) * 60 + Number(p.find((x) => x.type === "minute").value);
  }

  if (reduceMotion) {
    renderTime(nyMinutes());
  } else {
    // Day runs at 40 min/s, night at 110 min/s: one full trading day every ~20 seconds.
    let minute = 14 * 60 + 40;
    let last = null;
    let visible = true;
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(hero);
    const frame = (t) => {
      if (last != null && visible && !document.hidden) {
        const dt = Math.min(0.05, (t - last) / 1000);
        const speed = minute >= 570 && minute < 960 ? 40 : 110;
        minute = (minute + dt * speed) % 1440;
        renderTime(minute);
      }
      last = t;
      requestAnimationFrame(frame);
    };
    renderTime(minute);
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ feature cards

  document.querySelectorAll("[data-ltv]").forEach((b) =>
    b.addEventListener("click", () => {
      const open = b.dataset.ltv === "open";
      document.querySelectorAll("[data-ltv]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      $("ltvOpen").style.opacity = open ? "1" : "0";
      $("ltvClosed").style.opacity = open ? "0" : "1";
    }),
  );

  new IntersectionObserver(
    (entries, obs) => entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        obs.unobserve(e.target);
      }
    }),
    { threshold: 0.5 },
  ).observe($("reserveCard"));

  // ------------------------------------------------------------------ opening bell

  const STEPS = [
    { x: 110, y: 70, reveal: 112, clock: "4:00 pm", price: "$185.00",
      g: ["1.40", "", "Keeps the full limit on a price that's about to freeze."],
      a: ["1.40", "good", "Overnight limit kicks in. The existing loan stays safe."] },
    { x: 280, y: 70, reveal: 282, clock: "11:40 pm", price: "$185.00, frozen",
      g: ["1.40", "", "Relies on a frozen price. Any off-hours print can move it."],
      a: ["1.40", "good", "Liquidations are off while the market is closed."] },
    { x: 430, y: 190, reveal: 440, clock: "9:30:00 am", price: "$129.50, down 30%",
      g: ["0.98", "bad", "Liquidated in the first block, at the worst price of the day."],
      a: ["0.98", "", "Waits for a real opening price, then 15 seconds of grace."] },
    { x: 470, y: 189, reveal: 474, clock: "9:30:15 am", price: "$129.50",
      g: ["Gone", "bad", "Already liquidated at the first print."],
      a: ["1.22", "good", "Liquidation runs normally: half repaid, 6% bonus to the liquidator."] },
    { x: 560, y: 189, reveal: 600, clock: "On a 60% gap", price: "Collateral < debt",
      g: ["−$1,000", "bad", "The shortfall lands on lenders."],
      a: ["$0 lost", "good", "The gap reserve covers the $1,000 shortfall."] },
  ];

  const rect = $("revealRect");
  let revealNow = 112;
  let revealAnim = null;
  function animateReveal(to) {
    cancelAnimationFrame(revealAnim);
    if (reduceMotion) {
      revealNow = to;
      rect.setAttribute("width", to);
      return;
    }
    const from = revealNow;
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      revealNow = from + (to - from) * e;
      rect.setAttribute("width", revealNow.toFixed(1));
      if (k < 1) revealAnim = requestAnimationFrame(step);
    };
    revealAnim = requestAnimationFrame(step);
  }

  function setLane(id, [hf, cls, text]) {
    $(`${id}Hf`).textContent = hf;
    $(`${id}Text`).textContent = text;
    $(id).className = `lane${cls ? " " + cls : ""}`;
  }

  let activeStep = -1;
  function showStep(i) {
    if (i === activeStep) return;
    activeStep = i;
    const s = STEPS[i];
    document.querySelectorAll(".step").forEach((el) => el.classList.toggle("active", Number(el.dataset.step) === i));
    $("cursor").style.transform = `translateX(${s.x}px)`;
    $("dot").style.transform = `translate(${s.x}px, ${s.y}px)`;
    $("bellClock").textContent = s.clock;
    $("bellPrice").textContent = `tNVDA ${s.price}`;
    setLane("laneG", s.g);
    setLane("laneA", s.a);
    animateReveal(s.reveal);
  }
  showStep(0);

  const stepObserver = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && showStep(Number(e.target.dataset.step))),
    { rootMargin: "-45% 0px -45% 0px" },
  );
  document.querySelectorAll(".step").forEach((el) => stepObserver.observe(el));

  // ------------------------------------------------------------------ gallery

  const SHOTS = [
    { id: "open", icon: "sun", label: "Market open", src: "assets/shot-open.webp", kind: "browser",
      title: "Borrowing during the session", text: "Health factor, both borrow limits on one bar, and every stock's open and overnight limit side by side. The 24-hour dial shows exactly where New York is in its trading day." },
    { id: "closed", icon: "moon", label: "After hours", src: "assets/shot-closed.webp", kind: "browser",
      title: "The interface turns to night", text: "When the market closes, limits tighten and the whole app changes with it. A borrower above the overnight limit is told plainly: that's fine, the loan is safe, new borrowing waits for the open." },
    { id: "gap", icon: "trending-down", label: "Opening gap", src: "assets/shot-gap.webp", kind: "browser",
      title: "A 30% gap at the open", text: "Health factor drops to 0.98 and turns red, but liquidation waits. A countdown shows the grace period, and the borrower gets a clear last chance to repay." },
    { id: "console", icon: "sparkles", label: "Demo console", src: "assets/shot-console.webp", kind: "browser",
      title: "Replay a trading week", text: "The demo console triggers real onchain events in one click each: close the market, gap a stock, pay a dividend, split shares. Judges can run the full story in two minutes." },
    { id: "feed", icon: "activity", label: "Live activity", src: "assets/shot-feed.webp", kind: "browser",
      title: "Every event, in plain words", text: "Activity is read straight from contract events: after-hours borrows, liquidations, dividends paying down loans, splits and reserve payouts." },
    { id: "mobile", icon: "smartphone", label: "Mobile", src: "assets/shot-mobile.webp", kind: "phone",
      title: "Works on a phone", text: "The same app, fully responsive. Check your position at 3am from bed." },
  ];

  $("tabs").innerHTML = SHOTS.map((s, i) => `<button class="tab" role="tab" type="button" aria-selected="${i === 0}" data-shot="${s.id}"><i data-lucide="${s.icon}"></i>${s.label}</button>`).join("");
  if (window.lucide) window.lucide.createIcons({ nodes: [$("tabs")] });

  function showShot(id) {
    const s = SHOTS.find((x) => x.id === id);
    document.querySelectorAll("[data-shot]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.shot === id)));
    $("galleryStage").dataset.kind = s.kind;
    if (s.kind === "browser") {
      const img = $("galleryImg");
      img.style.opacity = "0";
      setTimeout(() => {
        img.src = s.src;
        img.alt = s.title;
        img.style.objectFit = s.id === "feed" ? "contain" : "cover";
        img.style.background = "#e8edf4";
        img.style.opacity = "1";
      }, reduceMotion ? 0 : 180);
    }
    $("galleryTitle").textContent = s.title;
    $("galleryText").textContent = s.text;
  }
  $("galleryImg").style.transition = "opacity 300ms";
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-shot]");
    if (b) showShot(b.dataset.shot);
  });
  showShot("open");

  // ------------------------------------------------------------------ onchain

  const C = window.AFTERHOURS_CONFIG;
  const ABI = window.AFTERHOURS_ABI;
  const ethers = window.ethers;

  function setLive(on, text) {
    ["navPulse", "heroPulse"].forEach((id) => $(id).classList.toggle("off", !on));
    $("navLiveText").textContent = text;
  }

  if (!C || !C.contracts || !ethers) {
    $("onchainLede").textContent = "Deploy the contracts with ./start.sh and this section fills in with live numbers from the pool.";
    $("addNetwork").hidden = true;
    return;
  }

  const net = C.network;
  const local = Number(net.chainId) === 31337;
  $("heroChain").innerHTML = local ? `<strong>Local chain</strong> demo` : `Live on <strong>${net.name}</strong>`;
  if (local) $("addNetwork").hidden = true;
  $("contractsSub").textContent = `${net.name}, chain ID ${net.chainId}`;
  const explorer = net.explorer ? net.explorer.replace(/\/$/, "") : null;

  const rows = [
    ["AfterHours pool", C.contracts.pool],
    ["Market oracle", C.contracts.oracle],
    ["USDG (test)", C.contracts.usdg],
    ["Demo console", C.contracts.demo],
  ];
  $("contractRows").innerHTML = rows
    .map(([name, addr]) => `<div class="contract-row"><div><div>${name}</div><div class="addr">${addr}</div></div><span class="icon-btns">
        <button class="icon-btn" type="button" data-copy="${addr}" aria-label="Copy ${name} address"><i data-lucide="copy"></i></button>
        ${explorer ? `<a class="icon-btn" href="${explorer}/address/${addr}" target="_blank" rel="noopener" aria-label="View ${name} on explorer"><i data-lucide="external-link"></i></a>` : ""}
      </span></div>`)
    .join("");
  if (window.lucide) window.lucide.createIcons({ nodes: [$("contractRows")] });
  $("contractRows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast("Address copied");
    } catch {
      toast("Copy failed. Select the address manually.");
    }
  });

  $("addNetwork").addEventListener("click", async () => {
    const eth = window.ethereum;
    if (!eth) return toast("No browser wallet found");
    const chainId = "0x" + Number(net.chainId).toString(16);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
      toast(`Switched to ${net.name}`);
    } catch (err) {
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId, chainName: net.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [net.rpcUrl], blockExplorerUrls: explorer ? [explorer] : undefined }],
        });
        toast(`${net.name} added to your wallet`);
      } catch {
        toast("Wallet request cancelled");
      }
    }
  });

  const network = ethers.Network.from(Number(net.chainId));
  const rpc = new ethers.JsonRpcProvider(net.rpcUrl, network, { staticNetwork: network });
  const pool = new ethers.Contract(C.contracts.pool, ABI.POOL, rpc);

  const shown = {};
  function countTo(id, value, fmt) {
    const el = $(id);
    const from = shown[id] ?? 0;
    shown[id] = value;
    if (reduceMotion || from === value) return (el.textContent = fmt(value));
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 1100);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (value - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const usd = (n) => n >= 1e6
    ? `$${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`
    : `$${Math.round(n).toLocaleString("en-US")}`;

  async function refresh() {
    try {
      const [p, block] = await Promise.all([pool.getPoolState(), rpc.getBlockNumber()]);
      countTo("stLent", Number(ethers.formatUnits(p.totalSupplyAssets, 6)), usd);
      countTo("stBorrowed", Number(ethers.formatUnits(p.totalBorrows, 6)), usd);
      countTo("stReserve", Number(ethers.formatUnits(p.gapReserve, 6)), usd);
      $("stMarket").textContent = p.marketOpen ? "Open" : "After hours";
      $("blockNote").textContent = `Block ${block.toLocaleString("en-US")}, updated live`;
      setLive(true, local ? "Local chain live" : `${net.name.replace(" Testnet", "")} live`);
    } catch (e) {
      setLive(false, "Chain unreachable");
      $("blockNote").textContent = "Can't reach the chain right now.";
    }
  }
  refresh();
  setInterval(refresh, 4000);
})();
