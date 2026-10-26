// Kujira page: airdrop checker and claims, Pod staking, whale rank and share cards, and live
// sonar stats. Reads data/site.json (token split, airdrop lists) and data/<network>.json
// (contracts, started rounds), both written by scripts/build-site.js. Before launch only
// site.json exists, so everything that needs contracts waits quietly.
(() => {
  const { ethers } = window;
  const $ = (id) => document.getElementById(id);

  const TOKEN_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function launchedAt() view returns (uint64)",
  ];
  const POD_ABI = [
    "function totalStaked() view returns (uint256)",
    "function periodFinish() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function earned(address) view returns (uint256)",
    "function stake(uint256)",
    "function withdraw(uint256)",
    "function claim()",
    "function poke(address)",
    "function multiplierOf(address) view returns (uint256)",
    "function appliedMultiplierOf(address) view returns (uint256)",
    "function stakedSince(address) view returns (uint256)",
  ];
  const DROP_ABI = [
    "function claimed(uint256,address) view returns (bool)",
    "function rounds(uint256) view returns (bytes32 merkleRoot, uint64 deadline, uint16 stakeBonusBps, bool closed, uint256 reserved, uint256 paid)",
    "function claim(uint256,uint256,bytes32[])",
    "function claimAndStake(uint256,uint256,bytes32[])",
  ];
  const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"];

  // Ranks by KUJI held (wallet + Pod). `boost` is the Pod size bonus for staking that much.
  const TIERS = [
    { name: "Krill", min: 0, boost: "", line: "Small, but the whole sea runs on you." },
    { name: "Fish", min: 10_000, boost: "", line: "Swimming with the current." },
    { name: "Dolphin", min: 100_000, boost: "+0.10×", line: "Quick, clever, never alone." },
    { name: "Orca", min: 1_000_000, boost: "+0.25×", line: "Feared by everything near the surface." },
    { name: "Kujira", min: 10_000_000, boost: "+0.50×", line: "The deep itself moves when you do." },
  ];
  const TIME_STEP = 30 * 24 * 60 * 60;
  const MAX_TIME_STEPS = 4;
  const x = (bps) => (Number(bps) / 10000).toFixed(2).replace(/0$/, "") + "×";

  const network = new URLSearchParams(location.search).get("network") || "ink";
  let site = { lists: [] };
  let data, reader, signer, account;
  const shardCache = {};

  const num = (wei) => Number(ethers.formatEther(wei));
  const fmtNum = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 0 });
  const fmt = (wei) => fmtNum(num(wei)) + " KUJI";
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const date = (ts) => new Date(Number(ts) * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
  const launched = () => Boolean(data);

  function notice(text, kind = "") {
    const el = $("notice");
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "notice " + kind;
  }

  function errText(e) {
    if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "Cancelled in your wallet.";
    return e?.reason || e?.shortMessage || e?.message || String(e);
  }

  async function send(label, fn) {
    notice(`${label}: confirm in your wallet…`);
    try {
      const tx = await fn();
      notice(`${label}: waiting for confirmation…`);
      await tx.wait();
      await refresh();
      notice(`${label}: done.`, "ok");
      return true;
    } catch (e) {
      await refresh();
      notice(`${label} failed: ${errText(e)}`, "err");
      return false;
    }
  }

  // ------------------------------------------------------------------ static data

  const ALLOC_NOTES = {
    liquidity: "In a 1% Uniswap pool, locked forever. The pool fee funds the project.",
    stakingRewards: "Paid to the Pod over time from a fixed pool.",
    airdrop: "Locked in the Drop, released in claim rounds.",
  };
  const ALLOC_NAMES = { liquidity: "Liquidity", stakingRewards: "Pod rewards", airdrop: "The Drop" };

  const TELEGRAM_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.9 4.3 18.7 19.4c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.2-8.3c.4-.4-.1-.6-.6-.2L6.2 13.1 1.3 11.6c-1.1-.3-1.1-1.1.2-1.6L20.6 2.7c.9-.3 1.7.2 1.3 1.6Z"/></svg>';

  async function loadSite() {
    const [s, links, config] = await Promise.all(
      ["data/site.json", "links.json", "config.json"].map((f) =>
        fetch(f, { cache: "no-store" }).then((r) => (r.ok ? r.json() : {}))
      )
    );
    site = { lists: [], ...s, config };
    $("alloc").innerHTML = Object.entries(site.allocations || {})
      .map(
        ([k, pct]) =>
          `<li><div class="label"><b>${ALLOC_NAMES[k] || k}</b><span>${pct}%</span></div>` +
          `<div class="track"><div class="fill" style="width:${pct}%"></div></div>` +
          `<div class="note">${ALLOC_NOTES[k] || ""}</div></li>`
      )
      .join("");
    // Optional links from links.json, added to the links band.
    const extra = [
      ["buy", "", "Buy"],
      ["telegram", TELEGRAM_SVG, "Telegram"],
      ["chart", "", "Chart"],
    ];
    for (const [key, icon, label] of extra) {
      if (!links[key]) continue;
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = links[key];
      a.rel = "noopener";
      a.innerHTML = `${icon}<span>${label}</span>`;
      li.append(a);
      key === "buy" ? $("social").prepend(li) : $("social").append(li);
    }
    $("tiers").innerHTML = TIERS.map(
      (t, i) =>
        `<li data-tier="${i}"><b>${t.name}</b><span>${i === 0 ? "Any KUJI" : fmtNum(t.min) + "+ KUJI"}</span>` +
        `<span class="tier-boost">${t.boost || "&nbsp;"}</span></li>`
    ).join("");
  }

  async function loadData() {
    if (!site.networks?.includes(network)) return; // not launched on this network yet
    const res = await fetch(`data/${network}.json`, { cache: "no-store" });
    if (!res.ok) return;
    data = await res.json();
    reader = new ethers.JsonRpcProvider(data.rpc, data.chainId, { staticNetwork: true });
    const c = data.contracts;
    const link = (label, addr) =>
      `<li>${label}<br><a href="${data.explorer}/address/${addr}" rel="noopener" class="addr">${addr.slice(0, 8)}…${addr.slice(-6)}</a></li>`;
    $("contracts").innerHTML =
      link("KUJI token", c.KujiraToken) +
      link("Pod (staking)", c.KujiraPod) +
      link("Drop (airdrop pool)", c.KujiraDrop) +
      (c.KujiraLiquidityLock ? link("Liquidity lock (1% pool fee)", c.KujiraLiquidityLock) : "") +
      (data.launch ? link("Uniswap pool (KUJI/ETH, 1%)", data.launch.pool) : "");
    watchLaunchTax().catch(() => {});
  }

  // During the first 30 minutes after the pool opens, show the launch tax on buys as it
  // falls (KujiraToken.launchTaxBps: 25% at the start, linear to 0).
  async function watchLaunchTax() {
    const token = new ethers.Contract(data.contracts.KujiraToken, TOKEN_ABI, reader);
    const start = Number(await token.launchedAt());
    if (!start) return;
    const end = start + 30 * 60;
    const banner = $("tax-banner");
    const tick = () => {
      const left = end - Date.now() / 1000;
      if (left <= 0) {
        banner.hidden = true;
        clearInterval(timer);
        return;
      }
      const pct = (25 * left) / 1800;
      const m = Math.floor(left / 60), s = Math.floor(left % 60);
      banner.hidden = false;
      banner.textContent = `Launch tax on buys right now: ${pct.toFixed(1)}%, falling to 0 in ${m}:${String(s).padStart(2, "0")}. It stops sniper bots and never comes back. Uniswap may show more KUJI than you'll receive while it lasts.`;
    };
    const timer = setInterval(tick, 1000);
    tick();
  }

  // ------------------------------------------------------------------ wallet

  async function ensureChain(eth) {
    const hex = "0x" + data.chainId.toString(16);
    if ((await eth.request({ method: "eth_chainId" })) === hex) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: data.chainName,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [data.rpc],
          blockExplorerUrls: [data.explorer],
        }],
      });
    }
  }

  // Privy (wallets, email, X) when site/config.json has an App ID, else the browser wallet.
  let privy;
  async function loadPrivy() {
    if (!site.config?.privyAppId) return null;
    if (!privy) {
      privy = import("./wallet/wallet.js")
        .then(() => {
          window.KujiraPrivy.start({
            appId: site.config.privyAppId,
            chainId: data?.chainId ?? 57073,
            logo: new URL("img/logo-192.png", location.href).href,
          });
          return window.KujiraPrivy;
        })
        .catch(() => null); // fall back to the browser wallet
    }
    return privy;
  }
  const remember = (on) => {
    try {
      on ? localStorage.setItem("kujira.privy", "1") : localStorage.removeItem("kujira.privy");
    } catch {}
  };
  const remembered = () => {
    try {
      return localStorage.getItem("kujira.privy") === "1";
    } catch {
      return false;
    }
  };

  async function walletProvider({ silent = false } = {}) {
    const p = await loadPrivy();
    if (p) {
      // If Privy can't start (blocked, offline, bad App ID), fall back to the browser wallet
      // rather than leaving the button doing nothing.
      const ready = await Promise.race([p.whenReady().then(() => true), new Promise((r) => setTimeout(() => r(false), 12000))]);
      if (ready) {
        const session = await p.connect({ silent });
        if (session) remember(true);
        return session?.provider || null;
      }
      if (!silent) notice("Login service didn't respond; using your browser wallet instead.");
    }
    return window.ethereum || null;
  }

  // One connection attempt at a time: a second tap, or the silent reconnect on page load,
  // joins the attempt in flight instead of starting another.
  let connecting = null;
  function connect(opts = {}) {
    if (connecting) return connecting;
    const btn = $("connect");
    const label = btn.textContent;
    if (!account) btn.textContent = "Connecting…";
    connecting = connectNow(opts).finally(() => {
      connecting = null;
      if (!account) btn.textContent = label === "Connecting…" ? "Connect" : label;
    });
    return connecting;
  }

  async function connectNow({ silent = false } = {}) {
    if (account && !silent) {
      if (confirm("Disconnect this wallet?")) {
        remember(false);
        (await loadPrivy())?.disconnect();
        location.reload();
      }
      return;
    }
    let eth;
    try {
      eth = await walletProvider({ silent });
    } catch (e) {
      notice(`Couldn't connect: ${errText(e)}`, "err");
      return;
    }
    if (!eth) {
      if (silent) return;
      const here = location.href.replace(/^https?:\/\//, "");
      notice("No wallet found. Open this page in your wallet app's browser.");
      $("rounds").innerHTML =
        `<p class="muted">No wallet found. Open this page in your wallet app's built-in browser, ` +
        `or <a href="https://metamask.app.link/dapp/${here}">open it in MetaMask</a>.</p>`;
      return;
    }
    try {
      const [addr] = await eth.request({ method: "eth_requestAccounts" });
      if (launched()) {
        await ensureChain(eth);
        signer = await new ethers.BrowserProvider(eth).getSigner();
        account = await signer.getAddress();
      } else {
        account = ethers.getAddress(addr); // before launch: just read the address
      }
      $("connect").textContent = short(account);
      $("connect").classList.add("addr");
      // Wallets often repeat these events while connecting; reload only on a real change.
      eth.on?.("accountsChanged", (accts) => {
        const next = accts?.[0];
        if (!next || next.toLowerCase() !== account.toLowerCase()) location.reload();
      });
      eth.on?.("chainChanged", (id) => {
        if (launched() && Number(id) !== data.chainId) location.reload();
      });
      if (!$("check-addr").value) $("check-addr").value = account;
      notice("");
      checkWallet(account);
      await refresh();
    } catch (e) {
      notice(`Couldn't connect: ${errText(e)}`, "err");
    }
  }

  // ------------------------------------------------------------------ airdrop lists

  // Proofs are split by the address's first byte; fetch only the slice an address is in.
  async function listEntry(dir, address) {
    const url = `${dir}/${address.slice(2, 4).toLowerCase()}.json`;
    shardCache[url] ||= fetch(url, { cache: "no-store" }).then((res) => (res.ok ? res.json() : {}));
    return (await shardCache[url])[address];
  }

  // "Are you in the Drop?": works for any address, before or after launch.
  async function checkWallet(input) {
    const box = $("check-result");
    let address;
    try {
      address = ethers.getAddress(String(input).trim().toLowerCase());
    } catch {
      box.innerHTML = `<p class="muted">That doesn't look like a wallet address.</p>`;
      return;
    }
    if (!site.lists.length) {
      box.innerHTML = `<p class="muted">The first list hasn't been published yet.</p>`;
      return;
    }
    box.innerHTML = `<p class="muted">Listening for ${short(address)}…</p>`;
    const hits = [];
    for (const l of site.lists) {
      const e = await listEntry(l.dir, address);
      if (e) hits.push({ ...l, amount: BigInt(e.amount) });
    }
    if (!hits.length) {
      box.innerHTML =
        `<p class="muted">${short(address)} isn't on ${site.lists.length > 1 ? "any list" : `the round ${site.lists[0].round} list`} yet. ` +
        `Later rounds look at different wallets. Follow @KujiraToken.</p>`;
      return;
    }
    const startedRounds = new Set((data?.rounds || []).map((r) => r.round));
    box.innerHTML = hits
      .map(
        (h) =>
          `<div class="hit"><span class="pill ok">Round ${h.round}</span>` +
          `<p class="amount">${fmt(h.amount)}</p>` +
          `<p class="muted">${
            startedRounds.has(h.round)
              ? "Claims are open. Connect this wallet below. First come, first served."
              : "Claims open at launch. First come, first served, so be early."
          }</p></div>`
      )
      .join("");
    const btn = document.createElement("button");
    btn.className = "btn solid";
    btn.textContent = "Make my share card";
    btn.onclick = () =>
      showCard({
        kicker: `Kujira Drop · Round ${hits[0].round}`,
        title: fmtNum(num(hits[0].amount)) + " KUJI",
        sub: "The spray reached me.",
        address,
        tweet: `The Kujira breached and the spray reached me 🐋 ${fmtNum(num(hits[0].amount))} $KUJI in the Drop on Ink. First come, first served. Check yours:`,
      });
    box.append(btn);
  }

  async function renderRounds() {
    const box = $("rounds");
    if (!launched()) return;
    const now = Date.now() / 1000;
    const open = data.rounds.filter((r) => !r.closed && r.deadline > now);
    if (!account) {
      box.innerHTML = `<p class="muted">${open.length ? "A round is open. Connect your wallet to claim." : "No round is open right now."}</p>`;
      if (!open.length) await renderDropCap(box);
      return;
    }
    if (open.length === 0) {
      box.innerHTML = `<p class="muted">The water is still. No round is open right now. Follow @KujiraToken for the next one.</p>`;
      await renderDropCap(box);
      return;
    }
    const drop = new ethers.Contract(data.contracts.KujiraDrop, DROP_ABI, reader);
    box.innerHTML = "";
    for (const r of open) {
      const mine = await listEntry(r.dir, account);
      const div = document.createElement("div");
      div.className = "round";
      const head = `<span class="pill">Round ${r.round} · closes ${date(r.deadline)}</span>`;
      if (!mine) {
        div.innerHTML = `${head}<p class="muted">This wallet isn't on the round ${r.round} list.</p>`;
        box.append(div);
        continue;
      }
      const amount = BigInt(mine.amount);
      const bonus = (amount * BigInt(r.stakeBonusBps)) / 10000n;
      const state = await drop.rounds(r.roundId);
      const left = state.reserved - state.paid;
      const pctClaimed = Number((state.paid * 1000n) / state.reserved) / 10;
      const progress =
        `<div class="track"><div class="fill" style="width:${pctClaimed}%"></div></div>` +
        `<p class="muted">${pctClaimed}% of this round claimed. First come, first served.</p>`;
      if (await drop.claimed(r.roundId, account)) {
        div.innerHTML = `${head}<p class="amount">${fmt(amount)}</p><span class="pill ok">Claimed</span>`;
        box.append(div);
        continue;
      }
      if (left < amount) {
        div.innerHTML = `${head}<p class="amount">${fmt(amount)}</p><p class="muted">This round has been fully claimed. Watch @KujiraToken for the next one.</p>`;
        box.append(div);
        continue;
      }
      const canStake = left >= amount + bonus;
      div.innerHTML =
        `${head}<p class="amount">${fmt(amount)}</p>` +
        `<div class="actions"><button class="btn">Claim</button>` +
        (canStake ? `<button class="btn solid">Claim &amp; stake +${r.stakeBonusBps / 100}%</button>` : "") +
        `</div>` +
        (canStake
          ? `<p class="muted">Claim &amp; stake puts ${fmt(amount + bonus)} in the Pod, earning rewards. Withdraw any time.</p>`
          : "") +
        progress;
      const [plain, staked] = div.querySelectorAll("button");
      const d = new ethers.Contract(data.contracts.KujiraDrop, DROP_ABI, signer);
      plain.onclick = () => send("Claim", () => d.claim(r.roundId, amount, mine.proof));
      if (staked) staked.onclick = () => send("Claim & stake", () => d.claimAndStake(r.roundId, amount, mine.proof));
      box.append(div);
    }
  }

  // The Drop never outgrows the market: a round opens only once buyers have taken enough
  // KUJI out of the launch pool (scripts/airdrop/gate.js). Shows how close the next one is.
  async function renderDropCap(box) {
    const L = data.launch, next = data.nextRound;
    if (!L || !next) return;
    const drop = new ethers.Contract(data.contracts.KujiraDrop, DROP_ABI, reader);
    const pool = new ethers.Contract(L.pool, POOL_ABI, reader);
    let committed = 0n;
    for (const r of data.rounds) {
      const st = await drop.rounds(r.roundId);
      committed += st.closed ? st.paid : st.reserved;
    }
    const [sqrtX96] = await pool.slot0();
    // Launch curve, in floats (plenty for a progress bar). x = L(1/s0 - 1/s) for KUJI as
    // token0, x = L(s0 - s) as token1, where s is the sqrt price.
    const liq = Number(L.liquidity), s = Number(sqrtX96) / 2 ** 96;
    const s0 = Math.sqrt(1.0001 ** (L.kujiIs0 ? L.tickLower : L.tickUpper));
    const bought = Math.max(0, L.kujiIs0 ? liq * (1 / s0 - 1 / s) : liq * (s0 - s)) / 1e18;
    const need = (Number(committed + BigInt(next.reserve)) / 1e18) * (10000 / data.dropCapBps);
    // Market cap, in launch dollars, once `need` KUJI has been bought.
    const sNeed = L.kujiIs0 ? 1 / (1 / s0 - (need * 1e18) / liq) : s0 - (need * 1e18) / liq;
    const ethPerKuji = L.kujiIs0 ? sNeed * sNeed : 1 / (sNeed * sNeed);
    const capUsd = ethPerKuji * 1e9 * L.ethUsdAtLaunch;
    const pct = Math.min(100, (bought / need) * 100);
    const p = document.createElement("div");
    p.className = "cap";
    p.innerHTML =
      `<p class="muted">Round ${next.round} opens once buyers have taken ${fmtNum(need)} KUJI out of the pool` +
      (sNeed > 0 && isFinite(capUsd) ? `, about a $${fmtNum(capUsd)} market cap` : "") +
      `. The Drop never hands out more than the market has already absorbed.</p>` +
      `<div class="track"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>` +
      `<p class="muted">${fmtNum(bought)} of ${fmtNum(need)} KUJI so far.</p>`;
    box.append(p);
  }

  // ------------------------------------------------------------------ Pod + rank

  async function renderPod() {
    if (!launched()) return;
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, reader);
    const [total, finish] = await Promise.all([pod.totalStaked(), pod.periodFinish()]);
    $("pod-total").textContent = fmt(total);
    $("pod-end").textContent = finish > 0n ? date(finish) : "–";
    if (!account) return;
    const token = new ethers.Contract(data.contracts.KujiraToken, TOKEN_ABI, reader);
    const [mine, earned, bal, live, applied, since, head] = await Promise.all([
      pod.balanceOf(account),
      pod.earned(account),
      token.balanceOf(account),
      pod.multiplierOf(account),
      pod.appliedMultiplierOf(account),
      pod.stakedSince(account),
      reader.getBlock("latest"),
    ]);
    $("pod-mine").textContent = fmt(mine);
    $("pod-earned").textContent = fmt(earned);
    $("pod-boost").textContent = mine > 0n ? x(applied) : "–";
    // The time boost grows on its own but only counts once applied (poke).
    $("poke").hidden = !(live > applied);
    $("poke").textContent = `Refresh boost to ${x(live)}`;
    const note = $("boost-note");
    note.hidden = mine === 0n;
    if (mine > 0n) {
      const age = head.timestamp - Number(since); // chain time, not the phone's clock
      const steps = Math.floor(age / TIME_STEP);
      const days = Math.max(1, Math.ceil(((steps + 1) * TIME_STEP - age) / 86400));
      note.textContent =
        steps >= MAX_TIME_STEPS
          ? "Full time boost reached. Stay staked to keep it."
          : `Next +0.25× in ${days} ${days === 1 ? "day" : "days"}. Withdrawing restarts the clock.`;
    }
    $("wallet-bal").textContent = fmt(bal);
    $("stake").disabled = bal === 0n;
    $("withdraw").disabled = mine === 0n;
    $("claim-rewards").disabled = earned === 0n;
    $("max").onclick = () => ($("amount").value = ethers.formatEther(bal));
    renderRank(num(bal + mine));
  }

  function renderRank(held) {
    const i = TIERS.findLastIndex((t) => held >= t.min);
    const tier = TIERS[i];
    const next = TIERS[i + 1];
    document.querySelectorAll("#tiers li").forEach((li) => li.classList.toggle("me", Number(li.dataset.tier) === i));
    const panel = $("rank-panel");
    if (held === 0) {
      panel.innerHTML = `<p class="muted">This wallet holds no KUJI yet. Even krill start somewhere.</p>`;
      return;
    }
    const pct = next ? Math.min(100, ((held - tier.min) / (next.min - tier.min)) * 100) : 100;
    panel.innerHTML =
      `<p class="rank-name">${tier.name}</p>` +
      `<p class="muted">${tier.line}</p>` +
      `<p class="held">${fmtNum(held)} KUJI held</p>` +
      (next
        ? `<div class="track"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>` +
          `<p class="muted">${fmtNum(next.min - held)} KUJI to ${next.name}</p>`
        : `<p class="muted">The highest rank in the deep.</p>`);
    const btn = document.createElement("button");
    btn.className = "btn solid";
    btn.textContent = "Make my rank card";
    btn.onclick = () =>
      showCard({
        kicker: "Kujira · Rank in the pod",
        title: tier.name,
        sub: `${fmtNum(held)} KUJI · ${tier.line}`,
        address: account,
        tweet: `I'm ${/^[AEIOU]/.test(tier.name) ? "an" : "a"} ${tier.name} in the Kujira pod 🐋 $KUJI on Ink. Find your rank:`,
      });
    panel.append(btn);
  }

  // ------------------------------------------------------------------ share cards

  const markImg = new Image();
  markImg.src = "img/mark-800.webp";

  async function drawCard({ kicker, title, sub, address }) {
    await Promise.all([
      document.fonts.load('400 80px "Dela"'),
      document.fonts.load('400 30px "Zen"'),
      document.fonts.load('700 26px "Zen"'),
      document.fonts.load('400 24px "Dela"', "鯨"),
      markImg.decode().catch(() => {}),
    ]);
    const W = 1200, H = 675;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");

    const bg = g.createRadialGradient(W * 0.3, -100, 50, W * 0.4, H * 0.4, 1000);
    bg.addColorStop(0, "#0e6080");
    bg.addColorStop(0.45, "#03202d");
    bg.addColorStop(1, "#000");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // marine snow + glow
    for (let i = 0; i < 90; i++) {
      const x = (i * 137.5) % W, y = (i * 251.3) % H, r = 0.8 + ((i * 7) % 5) * 0.4;
      g.fillStyle = i % 6 === 0 ? "rgba(140,235,255,0.7)" : "rgba(220,235,240,0.25)";
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }

    // coin
    const cx = 300, cy = 330, R = 210;
    g.save();
    g.shadowColor = "rgba(63,198,234,0.55)";
    g.shadowBlur = 70;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = "#000";
    g.fill();
    g.restore();
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.clip();
    if (markImg.complete && markImg.naturalWidth) g.drawImage(markImg, cx - R * 1.12, cy - R * 1.12, R * 2.24, R * 2.24);
    g.restore();
    g.strokeStyle = "rgba(63,198,234,0.6)";
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, R + 14, 0, Math.PI * 2);
    g.stroke();

    // text
    const x = 580;
    g.fillStyle = "#3fc6ea";
    g.font = '700 24px "Zen"';
    g.fillText(kicker.toUpperCase(), x, 210);
    g.fillStyle = "#eef6f8";
    let size = 92;
    g.font = `400 ${size}px "Dela"`;
    while (g.measureText(title).width > W - x - 60 && size > 40) {
      size -= 4;
      g.font = `400 ${size}px "Dela"`;
    }
    g.fillText(title, x, 210 + size + 20);
    g.fillStyle = "#c3d3d9";
    g.font = '400 30px "Zen"';
    wrap(g, sub, x, 210 + size + 90, W - x - 60, 44);

    g.fillStyle = "#7f99a3";
    g.font = '500 24px "Zen"';
    g.fillText(short(address), x, H - 70);
    g.fillStyle = "#eef6f8";
    g.textAlign = "right";
    g.fillText("kujira.ink · 鯨", W - 60, H - 70);
    return c;
  }

  function wrap(g, text, x, y, maxW, lh) {
    let line = "";
    for (const word of text.split(" ")) {
      const test = line ? line + " " + word : word;
      if (g.measureText(test).width > maxW && line) {
        g.fillText(line, x, y);
        line = word;
        y += lh;
      } else line = test;
    }
    if (line) g.fillText(line, x, y);
  }

  async function showCard(card) {
    const canvas = await drawCard(card);
    const url = canvas.toDataURL("image/png");
    $("card-img").src = url;
    $("card-post").href =
      "https://x.com/intent/tweet?" + new URLSearchParams({ text: card.tweet, url: "https://kujira.ink" });
    $("card-save").onclick = async () => {
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const file = new File([blob], "kujira.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text: card.tweet + " https://kujira.ink" });
          return;
        } catch {}
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = "kujira.png";
      a.click();
    };
    $("card-dialog").showModal();
  }
  $("card-close").onclick = () => $("card-dialog").close();

  // ------------------------------------------------------------------ sonar

  async function renderSonar() {
    if (!launched()) return;
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, reader);
    const drop = new ethers.Contract(data.contracts.KujiraDrop, DROP_ABI, reader);
    const [staked, rounds, holders] = await Promise.all([
      pod.totalStaked(),
      Promise.all(data.rounds.map((r) => drop.rounds(r.roundId))),
      fetch(`${data.explorer}/api/v2/tokens/${data.contracts.KujiraToken}`)
        .then((r) => (r.ok ? r.json() : {}))
        .then((t) => Number(t.holders_count ?? t.holders ?? NaN))
        .catch(() => NaN),
    ]);
    $("s-holders").textContent = Number.isFinite(holders) ? holders.toLocaleString("en-US") : "—";
    $("s-staked").textContent = compact(num(staked));
    const reserved = rounds.reduce((s, r) => s + r.reserved, 0n);
    const paid = rounds.reduce((s, r) => s + r.paid, 0n);
    $("s-drop").textContent = reserved > 0n ? `${(Number((paid * 1000n) / reserved) / 10).toFixed(1)}%` : "—";
    $("s-note").textContent = "Live from Ink. Refreshes every 30 seconds.";
  }
  const compact = (n) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

  // ------------------------------------------------------------------ actions

  function amountInput() {
    try {
      const v = ethers.parseEther($("amount").value.trim().replace(",", "."));
      if (v > 0n) return v;
    } catch {}
    notice("Enter an amount of KUJI first.", "err");
    return null;
  }

  async function refresh() {
    try {
      await Promise.all([renderRounds(), renderPod(), renderSonar()]);
    } catch (e) {
      notice(`Couldn't load data: ${errText(e)}`, "err");
    }
  }

  $("connect").onclick = () => connect();
  $("check").onclick = () => checkWallet($("check-addr").value);
  $("check-addr").addEventListener("keydown", (e) => e.key === "Enter" && checkWallet($("check-addr").value));
  $("stake").onclick = async () => {
    const v = amountInput();
    if (!v || !signer) return;
    const token = new ethers.Contract(data.contracts.KujiraToken, TOKEN_ABI, signer);
    if ((await token.allowance(account, data.contracts.KujiraPod)) < v) {
      if (!(await send("Approve", () => token.approve(data.contracts.KujiraPod, v)))) return;
    }
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, signer);
    await send("Stake", () => pod.stake(v));
  };
  $("withdraw").onclick = () => {
    const v = amountInput();
    if (!v || !signer) return;
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, signer);
    send("Withdraw", () => pod.withdraw(v));
  };
  $("poke").onclick = () => {
    if (!signer) return;
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, signer);
    send("Refresh boost", () => pod.poke(account));
  };
  $("claim-rewards").onclick = () => {
    if (!signer) return;
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, signer);
    send("Claim rewards", () => pod.claim());
  };

  loadSite()
    .then(loadData)
    .then(async () => {
      await refresh();
      if (launched()) setInterval(() => renderSonar().catch(() => {}), 30000);
      // Reconnect silently if this visitor connected before.
      if (site.config?.privyAppId) {
        if (remembered()) connect({ silent: true });
      } else {
        const accts = await window.ethereum?.request({ method: "eth_accounts" }).catch(() => []);
        if (accts?.length) connect({ silent: true });
      }
    })
    .catch((e) => notice(errText(e), "err"));
})();
