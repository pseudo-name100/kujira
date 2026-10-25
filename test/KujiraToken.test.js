const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const NONE = [ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress];

describe("KujiraToken", function () {
  it("mints the fixed supply once to the recipient", async function () {
    const [deployer, holder] = await ethers.getSigners();
    const token = await ethers.deployContract("KujiraToken", [holder.address, ...NONE]);
    const supply = ethers.parseEther("1000000000");
    expect(await token.totalSupply()).to.equal(supply);
    expect(await token.balanceOf(holder.address)).to.equal(supply);
    expect(await token.balanceOf(deployer.address)).to.equal(0n);
    expect(await token.symbol()).to.equal("KUJI");
  });

  it("rejects the zero address as recipient", async function () {
    const Token = await ethers.getContractFactory("KujiraToken");
    await expect(Token.deploy(ethers.ZeroAddress, ...NONE)).to.be.revertedWithCustomError(Token, "ZeroAddress");
  });

  it("has no owner or mint function", async function () {
    const [deployer] = await ethers.getSigners();
    const token = await ethers.deployContract("KujiraToken", [deployer.address, ...NONE]);
    expect(token.interface.getFunction("owner", [])).to.equal(null);
    expect(token.interface.getFunction("mint", [])).to.equal(null);
  });

  it("lets holders burn, shrinking total supply", async function () {
    const [deployer] = await ethers.getSigners();
    const token = await ethers.deployContract("KujiraToken", [deployer.address, ...NONE]);
    await token.burn(ethers.parseEther("1000"));
    expect(await token.totalSupply()).to.equal(ethers.parseEther("999999000"));
  });

  it("transfers the exact amount (no tax)", async function () {
    const [deployer, other] = await ethers.getSigners();
    const token = await ethers.deployContract("KujiraToken", [deployer.address, ...NONE]);
    await token.transfer(other.address, 12345n);
    expect(await token.balanceOf(other.address)).to.equal(12345n);
  });

  describe("launch tax", function () {
    const FACTORY = "0x640887A9ba3A9C53Ed27D0F7e8246A4F933f3424";
    const WETH = "0x4200000000000000000000000000000000000006";

    async function launched() {
      const [deployer, taxWallet, buyer] = await ethers.getSigners();
      const token = await ethers.deployContract("KujiraToken", [deployer.address, FACTORY, WETH, taxWallet.address]);
      const poolAddr = await token.pool();
      await impersonateAccount(poolAddr);
      await setBalance(poolAddr, ethers.parseEther("1"));
      const pool = await ethers.getSigner(poolAddr);
      return { token, deployer, taxWallet, buyer, pool };
    }

    it("derives the Uniswap pool address the factory will use", async function () {
      const [deployer, taxWallet] = await ethers.getSigners();
      const token = await ethers.deployContract("KujiraToken", [deployer.address, FACTORY, WETH, taxWallet.address]);
      const k = await token.getAddress();
      const [t0, t1] = k.toLowerCase() < WETH.toLowerCase() ? [k, WETH] : [WETH, k];
      const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24"], [t0, t1, 10000]));
      const expected = ethers.getCreate2Address(FACTORY, salt, "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54");
      expect(await token.pool()).to.equal(expected);
      expect(await token.taxRecipient()).to.equal(taxWallet.address);
    });

    it("has no tax before launch, and the launch liquidity starts the clock untaxed", async function () {
      const { token, deployer, pool } = await launched();
      expect(await token.launchTaxBps()).to.equal(0n);
      const amount = ethers.parseEther("550000000");
      await expect(token.transfer(pool.address, amount)).to.emit(token, "Launched");
      expect(await token.balanceOf(pool.address)).to.equal(amount);
      expect(await token.launchedAt()).to.be.greaterThan(0n);
      expect(await token.launchTaxBps()).to.equal(2500n);
      expect(deployer.address).to.not.equal(pool.address);
    });

    it("taxes buys from 25% falling to 0 over 30 minutes, paid to the tax wallet", async function () {
      const { token, taxWallet, buyer, pool } = await launched();
      await token.transfer(pool.address, ethers.parseEther("550000000"));
      const start = await token.launchedAt();
      const buy = ethers.parseEther("1000");

      // A buy one second after launch: 25% * (1799/1800)
      await time.setNextBlockTimestamp(start + 1n);
      await token.connect(pool).transfer(buyer.address, buy);
      const tax1 = (buy * ((2500n * 1799n) / 1800n)) / 10000n;
      expect(await token.balanceOf(taxWallet.address)).to.equal(tax1);
      expect(await token.balanceOf(buyer.address)).to.equal(buy - tax1);

      // Halfway: 12.5%
      await time.setNextBlockTimestamp(start + 900n);
      await token.connect(pool).transfer(buyer.address, buy);
      expect(await token.balanceOf(taxWallet.address)).to.equal(tax1 + (buy * 1250n) / 10000n);

      // After 30 minutes: nothing, ever again
      await time.setNextBlockTimestamp(start + 1800n);
      const before = await token.balanceOf(buyer.address);
      await token.connect(pool).transfer(buyer.address, buy);
      expect((await token.balanceOf(buyer.address)) - before).to.equal(buy);
      expect(await token.launchTaxBps()).to.equal(0n);
    });

    it("never taxes sells, wallet transfers, or the tax wallet's own buys", async function () {
      const { token, deployer, taxWallet, buyer, pool } = await launched();
      await token.transfer(pool.address, ethers.parseEther("550000000"));
      // sell into the pool
      await token.transfer(buyer.address, ethers.parseEther("100"));
      const poolBefore = await token.balanceOf(pool.address);
      await token.connect(buyer).transfer(pool.address, ethers.parseEther("100"));
      expect((await token.balanceOf(pool.address)) - poolBefore).to.equal(ethers.parseEther("100"));
      // wallet to wallet
      await token.transfer(buyer.address, 777n);
      expect(await token.balanceOf(buyer.address)).to.equal(777n);
      // the tax wallet buying
      await token.connect(pool).transfer(taxWallet.address, ethers.parseEther("10"));
      expect(await token.balanceOf(taxWallet.address)).to.equal(ethers.parseEther("10"));
      expect(deployer.address).to.not.equal(buyer.address);
    });

    it("needs WETH and a tax wallet when a factory is given", async function () {
      const [deployer] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("KujiraToken");
      await expect(Token.deploy(deployer.address, FACTORY, WETH, ethers.ZeroAddress)).to.be.revertedWithCustomError(Token, "ZeroAddress");
      await expect(Token.deploy(deployer.address, FACTORY, ethers.ZeroAddress, deployer.address)).to.be.revertedWithCustomError(Token, "ZeroAddress");
    });
  });
});
