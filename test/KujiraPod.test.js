const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const e = (n) => ethers.parseEther(String(n));

async function deploy() {
  const [owner, alice, bob] = await ethers.getSigners();
  const token = await ethers.deployContract("KujiraToken", [owner.address]);
  const pod = await ethers.deployContract("KujiraPod", [await token.getAddress(), owner.address]);
  for (const u of [alice, bob]) {
    await token.transfer(u.address, e(1000));
    await token.connect(u).approve(await pod.getAddress(), ethers.MaxUint256);
  }
  await token.approve(await pod.getAddress(), ethers.MaxUint256);
  return { owner, alice, bob, token, pod };
}

// Rewards round down per second, so allow a small tolerance.
const close = (a, b) => expect(a).to.be.closeTo(b, e("0.01"));

describe("KujiraPod", function () {
  it("streams rewards to a single staker", async function () {
    const { alice, token, pod } = await loadFixture(deploy);
    await pod.connect(alice).stake(e(100));
    await pod.fundRewards(e(1000), 10 * DAY);
    await time.increase(5 * DAY);
    close(await pod.earned(alice.address), e(500));
    await time.increase(10 * DAY);
    await pod.connect(alice).exit();
    close(await token.balanceOf(alice.address), e(2000));
  });

  it("splits rewards pro rata", async function () {
    const { alice, bob, pod } = await loadFixture(deploy);
    await pod.connect(alice).stake(e(100));
    await pod.connect(bob).stake(e(300));
    await pod.fundRewards(e(400), 4 * DAY);
    await time.increase(4 * DAY);
    close(await pod.earned(alice.address), e(100));
    close(await pod.earned(bob.address), e(300));
  });

  it("pauses the stream while nobody is staked instead of stranding rewards", async function () {
    const { alice, token, pod } = await loadFixture(deploy);
    await pod.fundRewards(e(1000), 10 * DAY);
    await time.increase(20 * DAY); // whole period passes with no stakers
    await pod.connect(alice).stake(e(100));
    await time.increase(10 * DAY);
    await pod.connect(alice).exit();
    close(await token.balanceOf(alice.address), e(2000));
  });

  it("rolls leftover rewards into a new funding", async function () {
    const { alice, pod } = await loadFixture(deploy);
    await pod.connect(alice).stake(e(100));
    await pod.fundRewards(e(1000), 10 * DAY);
    await time.increase(5 * DAY);
    await pod.fundRewards(e(500), 10 * DAY); // 500 leftover + 500 new
    await time.increase(10 * DAY);
    close(await pod.earned(alice.address), e(1500));
  });

  it("never pays out more than was funded", async function () {
    const { alice, bob, token, pod } = await loadFixture(deploy);
    await pod.connect(alice).stake(e(7));
    await pod.fundRewards(e(333), 3 * DAY);
    await time.increase(DAY);
    await pod.connect(bob).stake(e(13));
    await time.increase(DAY);
    await pod.connect(alice).exit();
    await time.increase(5 * DAY);
    await pod.connect(bob).exit();
    expect(await pod.totalStaked()).to.equal(0n);
    const paid = (await token.balanceOf(alice.address)) + (await token.balanceOf(bob.address)) - e(2000);
    expect(paid).to.be.lte(e(333));
    close(paid, e(333));
  });

  it("lets stakers withdraw at any time", async function () {
    const { alice, token, pod } = await loadFixture(deploy);
    await pod.connect(alice).stake(e(100));
    await pod.connect(alice).withdraw(e(40));
    expect(await pod.balanceOf(alice.address)).to.equal(e(60));
    expect(await token.balanceOf(alice.address)).to.equal(e(940));
    await expect(pod.connect(alice).withdraw(e(61))).to.be.reverted;
  });

  it("restricts funding to the owner", async function () {
    const { alice, pod } = await loadFixture(deploy);
    await expect(pod.connect(alice).fundRewards(e(1), DAY)).to.be.revertedWithCustomError(
      pod,
      "OwnableUnauthorizedAccount"
    );
  });

  it("does not let the owner pull KUJI out", async function () {
    const { token, pod } = await loadFixture(deploy);
    await expect(pod.recoverERC20(await token.getAddress(), 1n)).to.be.revertedWithCustomError(
      pod,
      "CannotRecoverStakingToken"
    );
  });

  it("rejects zero amounts", async function () {
    const { alice, pod } = await loadFixture(deploy);
    await expect(pod.connect(alice).stake(0)).to.be.revertedWithCustomError(pod, "ZeroAmount");
    await expect(pod.fundRewards(0, DAY)).to.be.revertedWithCustomError(pod, "ZeroAmount");
    await expect(pod.fundRewards(e(1), 0)).to.be.revertedWithCustomError(pod, "ZeroAmount");
  });
});
