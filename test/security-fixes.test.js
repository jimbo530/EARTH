const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EARTH — security fixes", function () {
  let earth;
  let owner, reactor, alice, bob;

  beforeEach(async function () {
    [owner, reactor, alice, bob] = await ethers.getSigners();
    const EARTH = await ethers.getContractFactory("EARTH");
    earth = await EARTH.deploy(ethers.parseEther("1000000")); // 1M EARTH
    await earth.waitForDeployment();
    // Wire owner as the "reactor" so we can call rebase/excludeFromRebase from tests
    await earth.setReactor(reactor.address);
  });

  describe("totalNonExcludedShares view", function () {
    it("returns initial supply minted to deployer", async function () {
      expect(await earth.totalNonExcludedShares()).to.equal(ethers.parseEther("1000000"));
    });

    it("decreases when an address is excluded from rebase", async function () {
      // Move some balance to alice first
      await earth.connect(owner).transfer(alice.address, ethers.parseEther("100"));
      const before = await earth.totalNonExcludedShares();

      // Exclude alice
      await earth.connect(reactor).excludeFromRebase(alice.address);

      const after = await earth.totalNonExcludedShares();
      expect(after).to.be.lt(before);
    });
  });

  describe("rebase — precision guard", function () {
    it("reverts when mintAmount is too small to move the index", async function () {
      // With 1M EARTH (=1e24 shares) and 1e18 scaling, mintAmount < 1e6 wei rounds to 0
      await expect(
        earth.connect(reactor).rebase(1n)
      ).to.be.revertedWith("mint too small");
    });

    it("succeeds for amounts that move the index", async function () {
      const indexBefore = await earth.rebaseIndex();
      await earth.connect(reactor).rebase(ethers.parseEther("1"));
      const indexAfter = await earth.rebaseIndex();
      expect(indexAfter).to.be.gt(indexBefore);
    });
  });

  describe("excludeFromRebase — idempotent", function () {
    it("does not revert on second call for already-excluded address", async function () {
      await earth.connect(owner).transfer(alice.address, ethers.parseEther("100"));
      await earth.connect(reactor).excludeFromRebase(alice.address);
      // Second call should be a no-op, not a revert
      await expect(
        earth.connect(reactor).excludeFromRebase(alice.address)
      ).to.not.be.reverted;
    });

    it("only the reactor can call excludeFromRebase", async function () {
      await expect(
        earth.connect(alice).excludeFromRebase(bob.address)
      ).to.be.revertedWith("not reactor");
    });
  });
});

describe("Reactor — admin transfer", function () {
  let reactor;
  let admin, candidate, attacker;
  // Dummy non-zero addresses for the constructor; we don't call methods that hit them.
  const DUMMY = "0x0000000000000000000000000000000000000001";

  beforeEach(async function () {
    [admin, candidate, attacker] = await ethers.getSigners();
    const EARTH = await ethers.getContractFactory("EARTH");
    const earth = await EARTH.deploy(ethers.parseEther("1"));
    await earth.waitForDeployment();
    const Reactor = await ethers.getContractFactory("Reactor");
    reactor = await Reactor.deploy(await earth.getAddress(), DUMMY, DUMMY, DUMMY);
    await reactor.waitForDeployment();
  });

  it("transferAdmin alone does not change admin", async function () {
    await reactor.connect(admin).transferAdmin(candidate.address);
    expect(await reactor.admin()).to.equal(admin.address);
    expect(await reactor.pendingAdmin()).to.equal(candidate.address);
  });

  it("acceptAdmin completes the transfer", async function () {
    await reactor.connect(admin).transferAdmin(candidate.address);
    await reactor.connect(candidate).acceptAdmin();
    expect(await reactor.admin()).to.equal(candidate.address);
    expect(await reactor.pendingAdmin()).to.equal(ethers.ZeroAddress);
  });

  it("only pendingAdmin can call acceptAdmin", async function () {
    await reactor.connect(admin).transferAdmin(candidate.address);
    await expect(
      reactor.connect(attacker).acceptAdmin()
    ).to.be.revertedWith("not pending admin");
  });

  it("renounceAdmin clears both admin and pendingAdmin", async function () {
    await reactor.connect(admin).transferAdmin(candidate.address);
    await reactor.connect(admin).renounceAdmin();
    expect(await reactor.admin()).to.equal(ethers.ZeroAddress);
    expect(await reactor.pendingAdmin()).to.equal(ethers.ZeroAddress);
  });

  it("only admin can transferAdmin", async function () {
    await expect(
      reactor.connect(attacker).transferAdmin(candidate.address)
    ).to.be.revertedWith("not admin");
  });

  it("undistributedMint starts at 0", async function () {
    expect(await reactor.undistributedMint()).to.equal(0n);
  });
});
