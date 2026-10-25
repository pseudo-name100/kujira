// Privy login for kujira.ink, bundled to wallet.js by build.js. The page loads it only when
// site/config.json has a Privy App ID, and talks to it through window.KujiraPrivy:
//   start({ appId, chainId, logo })   mount Privy once
//   whenReady()                       resolves once Privy has loaded
//   connect({ silent }) -> { provider, address } log in (wallet, email or X) and return an
//                       EIP-1193 provider; with silent, only reuse an existing session
//   disconnect()
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useWallets, useLogin } from "@privy-io/react-auth";
import { ink, inkSepolia } from "viem/chains";

const CHAINS = { [ink.id]: ink, [inkSepolia.id]: inkSepolia };

// React state mirrored into a plain store the page can wait on.
let state = { ready: false, authenticated: false, wallets: [], login: null, logout: null };
const listeners = new Set();
const update = (next) => {
  state = next;
  listeners.forEach((f) => f());
};
const waitFor = (pred) =>
  new Promise((resolve) => {
    if (pred()) return resolve();
    const f = () => {
      if (pred()) {
        listeners.delete(f);
        resolve();
      }
    };
    listeners.add(f);
  });
let loginFailed = null;

function Bridge() {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { login } = useLogin({ onError: (err) => loginFailed?.(err) });
  useEffect(() => {
    update({ ready: ready && walletsReady, authenticated, wallets, login, logout });
  }, [ready, walletsReady, authenticated, wallets, login, logout]);
  return null;
}

// Prefer the user's own wallet (MetaMask, Rabby, ...) over a Privy-created one: airdrop
// lists are of wallets people already trade with.
const pickWallet = (ws) => ws.find((w) => w.walletClientType !== "privy") || ws[0];

let chain;

// silent: only reuse an existing session, never open the login window.
async function connect({ silent = false } = {}) {
  await waitFor(() => state.ready);
  if (!state.authenticated || state.wallets.length === 0) {
    if (silent) return null;
    const failed = new Promise((_, reject) => {
      loginFailed = (err) => reject(new Error(err === "exited_auth_flow" ? "Cancelled." : String(err)));
    });
    state.login();
    await Promise.race([waitFor(() => state.authenticated && state.wallets.length > 0), failed]);
    loginFailed = null;
  }
  const wallet = pickWallet(state.wallets);
  await wallet.switchChain(chain.id).catch(() => {});
  return { provider: await wallet.getEthereumProvider(), address: wallet.address };
}

function start({ appId, chainId, logo }) {
  if (start.done) return;
  start.done = true;
  chain = CHAINS[chainId] || ink;
  const el = document.createElement("div");
  document.body.append(el);
  createRoot(el).render(
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["wallet", "email", "twitter"],
        appearance: {
          theme: "dark",
          accentColor: "#3fc6ea",
          logo,
          landingHeader: "Enter the deep",
          walletChainType: "ethereum-only",
          showWalletLoginFirst: true,
        },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: chain,
        supportedChains: [ink, inkSepolia],
      }}
    >
      <Bridge />
    </PrivyProvider>
  );
}

window.KujiraPrivy = { start, connect, whenReady: () => waitFor(() => state.ready), disconnect: () => state.logout?.() };
