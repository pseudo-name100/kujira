const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { buildTree } = require("../scripts/airdrop/lib");

const DAY = 24 * 60 * 60;
const e = (n) => ethers.parseEther(String(n));

async function deploy() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const token = await ethers.deployContract("KujiraToken", [owner.address]);
  const pod = await ethers.deployContract("KujiraPod", [await token.getAddress(), owner.address]);
  const drop = await ethers.deployContract("KujiraDrop", [await pod.getAddress(), owner.address]);
  await token.transfer(await drop.getAddress(), e(1000));

  const list = buildTree([
    { address: alice.address, amount: e(100) },
    { address: bob.address, amount: e(200) },
  ]);
  const deadline = (await time.latest()) + 30 * DAY;
  await drop.startRound(list.root, list.total, deadline, 2500);
  const proof = (a) => list.claims[a.address].proof;
  return { owner, alice, bob, carol, token, pod, drop, list, deadline, proof };
}

describe("KujiraDrop", function () {
  it("reserves the list total plus the max stake bonus", async function () {
    const { drop } = await loadFixture(deploy);
    expect(await drop.totalReserved()).to.equal(e(375)); // 300 + 25%
    expect(await drop.available()).to.equal(e(625));
  });

  it("pays a plain claim once", async function () {
    const { alice, token, drop, proof } = await loadFixture(deploy);
    await drop.connect(alice).claim(0, e(100), proof(alice));
    expect(await token.balanceOf(alice.address)).to.equal(e(100));
    await expect(drop.connect(alice).claim(0, e(100), proof(alice))).to.be.revertedWithCustomError(
      drop,
      "AlreadyClaimed"
    );
  });

  it("stakes claim-and-stake with the bonus, owned by the claimer", async function () {
    const { bob, token, pod, drop, proof } = await loadFixture(deploy);
    await drop.connect(bob).claimAndStake(0, e(200), proof(bob));
    expect(await pod.balanceOf(bob.address)).to.equal(e(250));
    expect(await token.balanceOf(bob.address)).to.equal(0n);
    await pod.connect(bob).withdraw(e(250));
    expect(await token.balanceOf(bob.address)).to.equal(e(250));
  });

  it("rejects wrong amounts, wrong wallets, and late claims", async function () {
    const { alice, carol, drop, proof, deadline } = await loadFixture(deploy);
    await expect(drop.connect(alice).claim(0, e(101), proof(alice))).to.be.revertedWithCustomError(
      drop,
      "InvalidProof"
    );
    await expect(drop.connect(carol).claim(0, e(100), proof(alice))).to.be.revertedWithCustomError(
      drop,
      "InvalidProof"
    );
    await time.increaseTo(deadline + 1);
    await expect(drop.connect(alice).claim(0, e(100), proof(alice))).to.be.revertedWithCustomError(
      drop,
      "RoundEnded"
    );
  });

  it("returns unclaimed tokens to the pool after the deadline", async function () {
    const { alice, drop, proof, deadline } = await loadFixture(deploy);
    await drop.connect(alice).claim(0, e(100), proof(alice));
    await expect(drop.closeRound(0)).to.be.revertedWithCustomError(drop, "RoundStillOpen");
    await time.increaseTo(deadline + 1);
    await drop.closeRound(0); // anyone can call
    expect(await drop.totalReserved()).to.equal(0n);
    expect(await drop.available()).to.equal(e(900));
  });

  it("cannot start a round bigger than the free pool", async function () {
    const { drop, list, deadline } = await loadFixture(deploy);
    await expect(drop.startRound(list.root, e(626), deadline, 0)).to.be.revertedWithCustomError(
      drop,
      "InsufficientPool"
    );
    await drop.startRound(list.root, e(500), deadline, 2500); // 625 exactly
  });

  it("caps payouts at the round reserve even if the list oversums", async function () {
    const { alice, bob, drop } = await loadFixture(deploy);
    const list = buildTree([
      { address: alice.address, amount: e(100) },
      { address: bob.address, amount: e(100) },
    ]);
    await drop.startRound(list.root, e(150), (await time.latest()) + DAY, 0); // owner understates
    await drop.connect(alice).claim(1, e(100), list.claims[alice.address].proof);
    await expect(
      drop.connect(bob).claim(1, e(100), list.claims[bob.address].proof)
    ).to.be.revertedWithCustomError(drop, "RoundExhausted");
  });

  it("only lets the owner start rounds and burn, and only unreserved tokens", async function () {
    const { alice, token, drop, list, deadline } = await loadFixture(deploy);
    await expect(
      drop.connect(alice).startRound(list.root, 1n, deadline, 0)
    ).to.be.revertedWithCustomError(drop, "OwnableUnauthorizedAccount");
    await expect(drop.burnUnallocated(e(626))).to.be.revertedWithCustomError(drop, "InsufficientPool");
    const supply = await token.totalSupply();
    await drop.burnUnallocated(e(625));
    expect(await token.totalSupply()).to.equal(supply - e(625));
    expect(await drop.available()).to.equal(0n);
  });
});
