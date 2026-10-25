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
  ];
  const POD_ABI = [
    "function totalStaked() view returns (uint256)",
    "function periodFinish() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function earned(address) view returns (uint256)",
    "function stake(uint256)",
    "function withdraw(uint256)",
    "function claim()",
  ];
  const DROP_ABI = [
    "function claimed(uint256,address) view returns (bool)",
    "function rounds(uint256) view returns (bytes32 merkleRoot, uint64 deadline, uint16 stakeBonusBps, bool closed, uint256 reserved, uint256 paid)",
    "function claim(uint256,uint256,bytes32[])",
    "function claimAndStake(uint256,uint256,bytes32[])",
  ];

  // Ranks by KUJI held (wallet + Pod), out of a 1,000,000,000 supply.
  const TIERS = [
    { name: "Krill", min: 0, line: "Small, but the whole sea runs on you." },
    { name: "Fish", min: 10_000, line: "Swimming with the current." },
    { name: "Dolphin", min: 100_000, line: "Quick, clever, never alone." },
    { name: "Orca", min: 1_000_000, line: "Feared by everything near the surface." },
    { name: "Kujira", min: 10_000_000, line: "The deep itself moves when you do." },
  ];

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
    liquidity: "Paired on an Ink DEX. LP tokens burned or locked.",
    stakingRewards: "Paid to the Pod over time from a fixed pool.",
    airdrop: "Locked in the Drop, released in claim rounds.",
  };
  const ALLOC_NAMES = { liquidity: "Liquidity", stakingRewards: "Pod rewards", airdrop: "The Drop" };

  const TELEGRAM_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.9 4.3 18.7 19.4c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.2-8.3c.4-.4-.1-.6-.6-.2L6.2 13.1 1.3 11.6c-1.1-.3-1.1-1.1.2-1.6L20.6 2.7c.9-.3 1.7.2 1.3 1.6Z"/></svg>';

  async function loadSite() {
    const [s, links] = await Promise.all(
      ["data/site.json", "links.json"].map((f) => fetch(f, { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})))
    );
    site = { lists: [], ...s };
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
      ["buy", '<span class="glyph">買</span>', "Buy"],
      ["telegram", TELEGRAM_SVG, "Telegram"],
      ["chart", '<span class="glyph">潮</span>', "Chart"],
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
        `<li data-tier="${i}"><b>${t.name}</b><span>${i === 0 ? "Any KUJI" : fmtNum(t.min) + "+ KUJI"}</span></li>`
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
      link("Drop (airdrop pool)", c.KujiraDrop);
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

  async function connect() {
    const eth = window.ethereum;
    if (!eth) {
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
      eth.on?.("accountsChanged", () => location.reload());
      eth.on?.("chainChanged", () => location.reload());
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
        tweet: `The Kujira breached and the spray reached me 🐋 ${fmtNum(num(hits[0].amount))} $KUJI in the Drop on Ink. Check yours:`,
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
      return;
    }
    if (open.length === 0) {
      box.innerHTML = `<p class="muted">The water is still. No round is open right now. Follow @KujiraToken for the next one.</p>`;
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

  // ------------------------------------------------------------------ Pod + rank

  async function renderPod() {
    if (!launched()) return;
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, reader);
    const [total, finish] = await Promise.all([pod.totalStaked(), pod.periodFinish()]);
    $("pod-total").textContent = fmt(total);
    $("pod-end").textContent = finish > 0n ? date(finish) : "–";
    if (!account) return;
    const token = new ethers.Contract(data.contracts.KujiraToken, TOKEN_ABI, reader);
    const [mine, earned, bal] = await Promise.all([pod.balanceOf(account), pod.earned(account), token.balanceOf(account)]);
    $("pod-mine").textContent = fmt(mine);
    $("pod-earned").textContent = fmt(earned);
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
      document.fonts.load('800 80px "Poppins"'),
      document.fonts.load('300 30px "Poppins"'),
      document.fonts.load('600 26px "Poppins"'),
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
    g.font = '600 26px "Poppins"';
    g.fillText(kicker.toUpperCase(), x, 210);
    g.fillStyle = "#e6eef1";
    let size = 96;
    g.font = `800 ${size}px "Poppins"`;
    while (g.measureText(title.toUpperCase()).width > W - x - 60 && size > 40) {
      size -= 4;
      g.font = `800 ${size}px "Poppins"`;
    }
    g.fillText(title.toUpperCase(), x, 210 + size + 20);
    g.fillStyle = "#c9d4d8";
    g.font = '300 30px "Poppins"';
    wrap(g, sub.toUpperCase(), x, 210 + size + 90, W - x - 60, 42);

    g.fillStyle = "#8199a3";
    g.font = '600 24px "Poppins"';
    g.fillText(short(address), x, H - 70);
    g.fillStyle = "#e6eef1";
    g.textAlign = "right";
    g.fillText("KUJIRA.INK · 鯨", W - 60, H - 70);
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

  $("connect").onclick = connect;
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
      // Reconnect silently if the wallet already authorised this page.
      const accts = await window.ethereum?.request({ method: "eth_accounts" }).catch(() => []);
      if (accts?.length) connect();
    })
    .catch((e) => notice(errText(e), "err"));
})();
