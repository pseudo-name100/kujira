const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const e = (n) => ethers.parseEther(String(n));

async function deploy() {
  const [lp, fees, stranger, newFees] = await ethers.getSigners();
  const kuji = await ethers.deployContract("KujiraToken", [lp.address, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress]);
  const weth = await ethers.deployContract("MockToken");
  const npm = await ethers.deployContract("MockPositionManager");
  const lock = await ethers.deployContract("KujiraLiquidityLock", [
    await npm.getAddress(),
    await kuji.getAddress(),
    fees.address,
  ]);
  const [k, w] = [await kuji.getAddress(), await weth.getAddress()];
  // token0/token1 sorted like Uniswap
  const [t0, t1] = k.toLowerCase() < w.toLowerCase() ? [kuji, weth] : [weth, kuji];
  await npm.mint(lp.address, await t0.getAddress(), await t1.getAddress(), 1_000_000n);
  const id = 1n;
  await npm.connect(lp)["safeTransferFrom(address,address,uint256)"](lp.address, await lock.getAddress(), id);
  for (const t of [t0, t1]) await t.approve(await npm.getAddress(), ethers.MaxUint256);
  return { lp, fees, stranger, newFees, kuji, weth, npm, lock, t0, t1, id };
}

describe("KujiraLiquidityLock", function () {
  it("records a KUJI position sent to it and owns it", async function () {
    const { npm, lock, id } = await loadFixture(deploy);
    expect(await npm.ownerOf(id)).to.equal(await lock.getAddress());
    expect(await lock.lockedCount()).to.equal(1n);
    expect(await lock.lockedPositions(0)).to.equal(id);
  });

  it("sends fees to the fee recipient, whoever triggers it", async function () {
    const { fees, stranger, npm, lock, t0, t1, id } = await loadFixture(deploy);
    await npm.accrue(id, e(10), e(3));
    await lock.connect(stranger).collect(id);
    expect(await t0.balanceOf(fees.address)).to.equal(e(10));
    expect(await t1.balanceOf(fees.address)).to.equal(e(3));
    await npm.accrue(id, e(1), e(1));
    await lock.collectAll();
    expect(await t0.balanceOf(fees.address)).to.equal(e(11));
  });

  it("has no way to remove liquidity or move the NFT", async function () {
    const { lp, npm, lock, id } = await loadFixture(deploy);
    const fns = lock.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    for (const banned of ["decreaseLiquidity", "transferFrom", "safeTransferFrom", "approve", "setApprovalForAll", "withdraw", "release"]) {
      expect(fns).to.not.include(banned);
    }
    // The previous owner can't touch it either.
    await expect(npm.connect(lp).decreaseLiquidity(id, 1n)).to.be.revertedWith("not approved");
    await expect(
      npm.connect(lp)["safeTransferFrom(address,address,uint256)"](await lock.getAddress(), lp.address, id)
    ).to.be.reverted;
  });

  it("can list a position that arrived through a plain transfer", async function () {
    const { lp, npm, lock, kuji, weth } = await loadFixture(deploy);
    await npm.mint(lp.address, await kuji.getAddress(), await weth.getAddress(), 5n); // id 2
    await npm.connect(lp).transferFrom(lp.address, await lock.getAddress(), 2n); // no callback
    expect(await lock.lockedCount()).to.equal(1n);
    await lock.track(2n);
    await lock.track(2n); // no duplicates
    expect(await lock.lockedCount()).to.equal(2n);
    await expect(lock.track(99n)).to.be.reverted;
  });

  it("only lets the fee recipient hand over the role", async function () {
    const { fees, stranger, newFees, npm, lock, t0, id } = await loadFixture(deploy);
    await expect(lock.connect(stranger).setFeeRecipient(stranger.address)).to.be.revertedWithCustomError(
      lock,
      "NotFeeRecipient"
    );
    await lock.connect(fees).setFeeRecipient(newFees.address);
    await npm.accrue(id, e(5), 0n);
    await lock.collect(id);
    expect(await t0.balanceOf(newFees.address)).to.equal(e(5));
  });

  it("rejects NFTs from other contracts and positions without KUJI", async function () {
    const { lp, npm, lock, weth } = await loadFixture(deploy);
    await expect(lock.onERC721Received(lp.address, lp.address, 1n, "0x")).to.be.revertedWithCustomError(
      lock,
      "NotPositionManager"
    );
    const other = await ethers.deployContract("MockToken");
    await npm.mint(lp.address, await weth.getAddress(), await other.getAddress(), 1n); // id 2, no KUJI
    await expect(
      npm.connect(lp)["safeTransferFrom(address,address,uint256)"](lp.address, await lock.getAddress(), 2n)
    ).to.be.revertedWithCustomError(lock, "NotKujiraPosition");
  });
});
