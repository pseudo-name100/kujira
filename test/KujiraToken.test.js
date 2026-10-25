const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("KujiraToken", function () {
  it("mints the fixed supply once to the recipient", async function () {
    const [deployer, holder] = await ethers.getSigners();
    const token = await ethers.deployContract("KujiraToken", [holder.address]);
    const supply = ethers.parseEther("1000000000");
    expect(await token.totalSupply()).to.equal(supply);
    expect(await token.balanceOf(holder.address)).to.equal(supply);
    expect(await token.balanceOf(deployer.address)).to.equal(0n);
    expect(await token.symbol()).to.equal("KUJI");
  });

  it("rejects the zero address as recipient", async function () {
    const Token = await ethers.getContractFactory("KujiraToken");
    await expect(Token.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Token, "ZeroAddress");
  });

  it("has no owner or mint function", async function () {
    const [deployer] = await ethers.getSigners();
    const token = await ethers.deployContract("KujiraToken", [deployer.address]);
    expect(token.interface.getFunction("owner", [])).to.equal(null);
    expect(token.interface.getFunction("mint", [])).to.equal(null);
  });

  it("lets holders burn, shrinking total supply", async function () {
    const [deployer] = await ethers.getSigners();
    const token = await ethers.deployContract("KujiraToken", [deployer.address]);
    await token.burn(ethers.parseEther("1000"));
    expect(await token.totalSupply()).to.equal(ethers.parseEther("999999000"));
  });

  it("transfers the exact amount (no tax)", async function () {
    const [deployer, other] = await ethers.getSigners();
    const token = await ethers.deployContract("KujiraToken", [deployer.address]);
    await token.transfer(other.address, 12345n);
    expect(await token.balanceOf(other.address)).to.equal(12345n);
  });
});
