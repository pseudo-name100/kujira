const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const e = (n) => ethers.parseEther(String(n));

async function deploy() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const token = await ethers.deployContract("KujiraToken", [owner.address]);
  const pod = await ethers.deployContract("KujiraPod", [await token.getAddress(), owner.address]);
  for (const u of [alice, bob, carol]) {
    await token.transfer(u.address, e(20_000_000));
    await token.connect(u).approve(await pod.getAddress(), ethers.MaxUint256);
  }
  await token.approve(await pod.getAddress(), ethers.MaxUint256);
  return { owner, alice, bob, carol, token, pod };
}

// Rewards round down per second, so allow a small tolerance.
const close = (a, b, tol = e("0.01")) => expect(a).to.be.closeTo(b, tol);

describe("KujiraPod", function () {
  describe("rewards", function () {
    it("streams rewards to a single staker", async function () {
      const { alice, token, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(100));
      await pod.fundRewards(e(1000), 10 * DAY);
      await time.increase(5 * DAY);
      close(await pod.earned(alice.address), e(500));
      await time.increase(10 * DAY);
      await pod.connect(alice).exit();
      close(await token.balanceOf(alice.address), e(20_001_000));
    });

    it("splits rewards pro rata for unboosted stakes", async function () {
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
      await time.increase(20 * DAY);
      await pod.connect(alice).stake(e(100));
      await time.increase(10 * DAY);
      await pod.connect(alice).exit();
      close(await token.balanceOf(alice.address), e(20_001_000));
    });

    it("rolls leftover rewards into a new funding", async function () {
      const { alice, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(100));
      await pod.fundRewards(e(1000), 10 * DAY);
      await time.increase(5 * DAY);
      await pod.fundRewards(e(500), 10 * DAY);
      await time.increase(10 * DAY);
      close(await pod.earned(alice.address), e(1500));
    });

    it("never pays out more than was funded, boosts included", async function () {
      const { alice, bob, carol, token, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(7));
      await pod.connect(carol).stake(e(12_000_000)); // Kujira size boost
      await pod.fundRewards(e(333_333), 200 * DAY);
      await time.increase(40 * DAY);
      await pod.poke(carol.address);
      await pod.connect(bob).stake(e(1_300_000));
      await time.increase(70 * DAY);
      await pod.poke(alice.address);
      await pod.connect(alice).exit();
      await time.increase(100 * DAY);
      await pod.connect(bob).exit();
      await pod.connect(carol).exit();
      expect(await pod.totalStaked()).to.equal(0n);
      expect(await pod.totalBoosted()).to.equal(0n);
      const paid =
        (await token.balanceOf(alice.address)) +
        (await token.balanceOf(bob.address)) +
        (await token.balanceOf(carol.address)) -
        e(60_000_000);
      expect(paid).to.be.lte(e(333_333));
      close(paid, e(333_333), e(1));
    });
  });

  describe("whale boosts", function () {
    it("applies size bonuses by tier", async function () {
      const { alice, pod } = await loadFixture(deploy);
      expect(await pod.sizeBonus(e(99_999))).to.equal(0n);
      expect(await pod.sizeBonus(e(100_000))).to.equal(1000n);
      expect(await pod.sizeBonus(e(1_000_000))).to.equal(2500n);
      expect(await pod.sizeBonus(e(10_000_000))).to.equal(5000n);
      await pod.connect(alice).stake(e(1_000_000));
      expect(await pod.boostedBalanceOf(alice.address)).to.equal(e(1_250_000));
      expect(await pod.appliedMultiplierOf(alice.address)).to.equal(12500n);
    });

    it("pays whales more per KUJI staked", async function () {
      const { alice, bob, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(1_000_000)); // 1.25x
      await pod.connect(bob).stake(e(10_000_000)); // 1.5x
      await pod.fundRewards(e(1_625_000), 10 * DAY);
      await time.increase(10 * DAY);
      // boosted: 1.25M vs 15M of 16.25M total
      close(await pod.earned(alice.address), e(125_000), e(1));
      close(await pod.earned(bob.address), e(1_500_000), e(1));
    });

    it("adds 0.25x per 30 days staked, up to 1x, once poked", async function () {
      const { alice, bob, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(100));
      await time.increase(30 * DAY);
      expect(await pod.multiplierOf(alice.address)).to.equal(12500n);
      expect(await pod.appliedMultiplierOf(alice.address)).to.equal(10000n); // not applied yet
      await pod.connect(bob).poke(alice.address); // anyone can poke
      expect(await pod.appliedMultiplierOf(alice.address)).to.equal(12500n);
      await time.increase(200 * DAY);
      await pod.poke(alice.address);
      expect(await pod.appliedMultiplierOf(alice.address)).to.equal(20000n); // capped
    });

    it("tops out at 2.5x for a Kujira-size stake held 120 days", async function () {
      const { alice, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(10_000_000));
      await time.increase(120 * DAY);
      await pod.poke(alice.address);
      expect(await pod.appliedMultiplierOf(alice.address)).to.equal(25000n);
    });

    it("blends the clock when topping up, so a small early stake can't lend its age", async function () {
      const { alice, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(1));
      await time.increase(120 * DAY);
      await pod.connect(alice).stake(e(9_999_999)); // essentially a fresh stake
      expect(await pod.multiplierOf(alice.address)).to.equal(15000n); // size only
    });

    it("restarts the time boost on any withdrawal", async function () {
      const { alice, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(1000));
      await time.increase(90 * DAY);
      await pod.poke(alice.address);
      expect(await pod.appliedMultiplierOf(alice.address)).to.equal(17500n);
      await pod.connect(alice).withdraw(e(1));
      expect(await pod.appliedMultiplierOf(alice.address)).to.equal(10000n);
    });

    it("drops the size boost when a stake falls below a tier", async function () {
      const { alice, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(1_000_000));
      await pod.connect(alice).withdraw(e(1));
      expect(await pod.appliedMultiplierOf(alice.address)).to.equal(11000n); // Dolphin
    });

    it("keeps total boosted equal to the sum of boosted balances", async function () {
      const { alice, bob, carol, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(150_000));
      await pod.connect(bob).stake(e(2_000_000));
      await time.increase(61 * DAY);
      await pod.poke(alice.address);
      await pod.connect(carol).stake(e(11_000_000));
      await pod.connect(bob).withdraw(e(1_500_000));
      const sum =
        (await pod.boostedBalanceOf(alice.address)) +
        (await pod.boostedBalanceOf(bob.address)) +
        (await pod.boostedBalanceOf(carol.address));
      expect(await pod.totalBoosted()).to.equal(sum);
    });
  });

  describe("access and inputs", function () {
    it("lets stakers withdraw at any time", async function () {
      const { alice, token, pod } = await loadFixture(deploy);
      await pod.connect(alice).stake(e(100));
      await pod.connect(alice).withdraw(e(40));
      expect(await pod.balanceOf(alice.address)).to.equal(e(60));
      expect(await token.balanceOf(alice.address)).to.equal(e(19_999_940));
      await expect(pod.connect(alice).withdraw(e(61))).to.be.reverted;
    });

    it("stakeFor credits the beneficiary, who alone can withdraw", async function () {
      const { alice, bob, token, pod } = await loadFixture(deploy);
      await pod.connect(bob).stakeFor(alice.address, e(50));
      expect(await pod.balanceOf(alice.address)).to.equal(e(50));
      expect(await pod.balanceOf(bob.address)).to.equal(0n);
      await expect(pod.connect(bob).withdraw(e(50))).to.be.reverted;
      await pod.connect(alice).withdraw(e(50));
      expect(await token.balanceOf(alice.address)).to.equal(e(20_000_050));
      await expect(pod.stakeFor(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(pod, "ZeroAddress");
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
});
