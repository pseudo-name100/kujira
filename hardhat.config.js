require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ quiet: true });

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    ink: {
      url: process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com",
      chainId: 57073,
      accounts,
    },
    inkSepolia: {
      url: process.env.INK_SEPOLIA_RPC_URL || "https://rpc-gel-sepolia.inkonchain.com",
      chainId: 763373,
      accounts,
    },
  },
  // Ink's explorers are Blockscout, which accepts any API key.
  etherscan: {
    apiKey: { ink: "blockscout", inkSepolia: "blockscout" },
    customChains: [
      {
        network: "ink",
        chainId: 57073,
        urls: {
          apiURL: "https://explorer.inkonchain.com/api",
          browserURL: "https://explorer.inkonchain.com",
        },
      },
      {
        network: "inkSepolia",
        chainId: 763373,
        urls: {
          apiURL: "https://explorer-sepolia.inkonchain.com/api",
          browserURL: "https://explorer-sepolia.inkonchain.com",
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
