// Kujira claim + staking page. Reads data/<network>.json, written by scripts/build-site.js.
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
    "function claim(uint256,uint256,bytes32[])",
    "function claimAndStake(uint256,uint256,bytes32[])",
  ];

  const network = new URLSearchParams(location.search).get("network") || "ink";
  let data, reader, signer, account;
  const claimsCache = {};

  const fmt = (wei) => {
    const n = Number(ethers.formatEther(wei));
    return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 2 }) + " KUJI";
  };
  const date = (ts) => new Date(Number(ts) * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });

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

  async function loadData() {
    const res = await fetch(`data/${network}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error("KUJI hasn't launched on this network yet.");
    data = await res.json();
    reader = new ethers.JsonRpcProvider(data.rpc, data.chainId, { staticNetwork: true });
    const c = data.contracts;
    const link = (label, addr) =>
      `<li>${label}: <a href="${data.explorer}/address/${addr}" rel="noopener">${addr.slice(0, 8)}…${addr.slice(-6)}</a></li>`;
    $("contracts").innerHTML =
      link("KUJI token", c.KujiraToken) +
      link("Pod (staking)", c.KujiraPod) +
      link("Drop (airdrop pool)", c.KujiraDrop) +
      (c.VestingWallet ? link("Team vesting", c.VestingWallet) : "");
  }

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
      $("rounds").innerHTML =
        `<p class="muted">No wallet found. Open this page in your wallet app's built-in browser, ` +
        `or <a href="https://metamask.app.link/dapp/${here}">open it in MetaMask</a>.</p>`;
      return;
    }
    try {
      await eth.request({ method: "eth_requestAccounts" });
      await ensureChain(eth);
      const provider = new ethers.BrowserProvider(eth);
      signer = await provider.getSigner();
      account = await signer.getAddress();
      $("connect").textContent = account.slice(0, 6) + "…" + account.slice(-4);
      eth.on?.("accountsChanged", () => location.reload());
      eth.on?.("chainChanged", () => location.reload());
      notice("");
      await refresh();
    } catch (e) {
      notice(`Couldn't connect: ${errText(e)}`, "err");
    }
  }

  async function roundClaims(r) {
    if (!claimsCache[r.file]) {
      claimsCache[r.file] = fetch(r.file, { cache: "no-store" }).then((res) => res.json());
    }
    return claimsCache[r.file];
  }

  async function renderRounds() {
    const box = $("rounds");
    const now = Date.now() / 1000;
    const open = data.rounds.filter((r) => !r.closed && r.deadline > now);
    if (!account) return;
    if (open.length === 0) {
      box.innerHTML = `<p class="muted">No airdrop round is open right now. Follow @KujiraToken for the next one.</p>`;
      return;
    }
    const drop = new ethers.Contract(data.contracts.KujiraDrop, DROP_ABI, reader);
    box.innerHTML = "";
    for (const r of open) {
      const claims = await roundClaims(r);
      const mine = claims.claims[account];
      const div = document.createElement("div");
      div.className = "round";
      const head = `<span class="pill">Round ${r.round} · closes ${date(r.deadline)}</span>`;
      if (!mine) {
        div.innerHTML = `${head}<p class="muted" style="margin-top:8px">This wallet isn't on the round ${r.round} list.</p>`;
        box.append(div);
        continue;
      }
      const amount = BigInt(mine.amount);
      const bonus = (amount * BigInt(r.stakeBonusBps)) / 10000n;
      if (await drop.claimed(r.roundId, account)) {
        div.innerHTML = `${head}<p class="amount">${fmt(amount)}</p><span class="pill ok">Claimed</span>`;
        box.append(div);
        continue;
      }
      div.innerHTML =
        `${head}<p class="amount">${fmt(amount)}</p>` +
        `<div class="actions"><button class="btn">Claim</button>` +
        `<button class="btn primary">Claim &amp; stake +${r.stakeBonusBps / 100}%</button></div>` +
        `<p class="muted" style="margin:10px 0 0">Claim &amp; stake puts ${fmt(amount + bonus)} in the Pod, earning rewards. Withdraw any time.</p>`;
      const [plain, staked] = div.querySelectorAll("button");
      const d = new ethers.Contract(data.contracts.KujiraDrop, DROP_ABI, signer);
      plain.onclick = () => send("Claim", () => d.claim(r.roundId, amount, mine.proof));
      staked.onclick = () => send("Claim & stake", () => d.claimAndStake(r.roundId, amount, mine.proof));
      box.append(div);
    }
  }

  async function renderPod() {
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
  }

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
      await Promise.all([renderRounds(), renderPod()]);
    } catch (e) {
      notice(`Couldn't load data: ${errText(e)}`, "err");
    }
  }

  $("connect").onclick = connect;
  $("stake").onclick = async () => {
    const v = amountInput();
    if (!v) return;
    const token = new ethers.Contract(data.contracts.KujiraToken, TOKEN_ABI, signer);
    if ((await token.allowance(account, data.contracts.KujiraPod)) < v) {
      if (!(await send("Approve", () => token.approve(data.contracts.KujiraPod, v)))) return;
    }
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, signer);
    await send("Stake", () => pod.stake(v));
  };
  $("withdraw").onclick = () => {
    const v = amountInput();
    if (!v) return;
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, signer);
    send("Withdraw", () => pod.withdraw(v));
  };
  $("claim-rewards").onclick = () => {
    const pod = new ethers.Contract(data.contracts.KujiraPod, POD_ABI, signer);
    send("Claim rewards", () => pod.claim());
  };

  loadData()
    .then(async () => {
      await refresh();
      // Reconnect silently if the wallet already authorised this page.
      const accts = await window.ethereum?.request({ method: "eth_accounts" }).catch(() => []);
      if (accts?.length) connect();
    })
    .catch((e) => {
      notice(errText(e));
      $("connect").disabled = true;
    });
})();
