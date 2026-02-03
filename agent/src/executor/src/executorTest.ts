import { expect } from "chai";
import { EventEmitter } from "events";
import { ethers } from "ethers";
import sinon from "sinon";
import { ExecutorAgent, ExecutorConfig, createExecutorAgent } from "./Execution";
import type { RiskDecision, DefenseAction, ThreatTier } from "./RiskEngine";

// ---------------------------------------------------------------------------
// TEST HELPERS
// ---------------------------------------------------------------------------

function createMockConfig(overrides?: Partial<ExecutorConfig>): ExecutorConfig {
  return {
    rpcUrls: {
      ethereum: "https://eth.example.com",
      base: "https://base.example.com",
      arbitrum: "https://arb.example.com",
    },
    hookAddresses: {
      ethereum: "0x1234567890123456789012345678901234567890",
      base: "0x2345678901234567890123456789012345678901",
      arbitrum: "0x3456789012345678901234567890123456789012",
    },
    agentPrivateKey: "0x" + "a".repeat(64), // Valid 32-byte hex
    teeEnabled: false,
    maxGasPrice: {
      ethereum: 100,
      base: 10,
      arbitrum: 5,
    },
    ...overrides,
  };
}

function createMockDecision(overrides?: Partial<RiskDecision>): RiskDecision {
  return {
    id: "test-decision-001",
    timestamp: Date.now(),
    chain: "ethereum",
    pair: "ETH/USDC",
    targetPool: "0xPoolAddress123",
    tier: "ELEVATED" as ThreatTier,
    compositeScore: 65,
    action: "MEV_PROTECTION" as DefenseAction,
    rationale: "High MEV activity detected in mempool",
    ttlMs: 60000, // 1 minute
    signals: [],
    ...overrides,
  };
}

function createMockContract() {
  return {
    activateProtection: sinon.stub().resolves({ hash: "0xTxHash1", wait: sinon.stub().resolves({}) }),
    deactivateProtection: sinon.stub().resolves({ hash: "0xTxHash2", wait: sinon.stub().resolves({}) }),
    activateCircuitBreaker: sinon.stub().resolves({ hash: "0xTxHash3", wait: sinon.stub().resolves({}) }),
    deactivateCircuitBreaker: sinon.stub().resolves({ hash: "0xTxHash4", wait: sinon.stub().resolves({}) }),
    configureOracle: sinon.stub().resolves({ hash: "0xTxHash5", wait: sinon.stub().resolves({}) }),
    isProtectionActive: sinon.stub().resolves(false),
    isCircuitBreakerActive: sinon.stub().resolves(false),
    getActiveFee: sinon.stub().resolves(500),
    configs: sinon.stub().resolves([false, false, false]),
  };
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("ExecutorAgent", () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe("constructor", () => {
    it("should create an ExecutorAgent with valid config", () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);
      expect(agent).to.be.instanceOf(ExecutorAgent);
      expect(agent).to.be.instanceOf(EventEmitter);
    });

    it("should throw error for invalid private key", () => {
      const config = createMockConfig({ agentPrivateKey: "invalid" });
      expect(() => new ExecutorAgent(config)).to.throw("Invalid agent private key");
    });

    it("should throw error for missing RPC URL", () => {
      const config = createMockConfig();
      config.rpcUrls.ethereum = "";
      expect(() => new ExecutorAgent(config)).to.throw("Missing RPC URL for ethereum");
    });

    it("should throw error for invalid hook address", () => {
      const config = createMockConfig();
      config.hookAddresses.base = "not-an-address";
      expect(() => new ExecutorAgent(config)).to.throw("Invalid hook address for base");
    });
  });

  describe("createExecutorAgent factory", () => {
    it("should create an ExecutorAgent instance", () => {
      const config = createMockConfig();
      const agent = createExecutorAgent(config);
      expect(agent).to.be.instanceOf(ExecutorAgent);
    });
  });

  describe("initialize", () => {
    it("should initialize providers, wallets, and contracts for all chains", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      // Stub ethers constructors
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };
      const mockContract = createMockContract();

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      // Verify providers created for all 3 chains
      expect((ethers.JsonRpcProvider as sinon.SinonStub).callCount).to.equal(3);
      expect((ethers.Wallet as sinon.SinonStub).callCount).to.equal(3);
      expect((ethers.Contract as sinon.SinonStub).callCount).to.equal(3);
    });
  });

  describe("start/stop", () => {
    it("should start monitoring and emit started event", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const startedSpy = sinon.spy();
      agent.on("executor:started", startedSpy);

      await agent.start();

      expect(startedSpy.calledOnce).to.be.true;
    });

    it("should warn if already running", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const warnStub = sandbox.stub(console, "warn");

      await agent.start();
      await agent.start();

      expect(warnStub.calledWith("⚠️  Executor: Already running")).to.be.true;
    });

    it("should stop and emit stopped event", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const stoppedSpy = sinon.spy();
      agent.on("executor:stopped", stoppedSpy);

      await agent.start();
      await agent.stop();

      expect(stoppedSpy.calledOnce).to.be.true;
    });

    it("should not emit stopped event if not running", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const stoppedSpy = sinon.spy();
      agent.on("executor:stopped", stoppedSpy);

      await agent.stop();

      expect(stoppedSpy.called).to.be.false;
    });
  });

  describe("executeDecision", () => {
    let agent: ExecutorAgent;
    let mockContract: ReturnType<typeof createMockContract>;

    beforeEach(async () => {
      const config = createMockConfig();
      agent = new ExecutorAgent(config);

      mockContract = createMockContract();

      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();
    });

    it("should execute MEV_PROTECTION action", async () => {
      const decision = createMockDecision({ action: "MEV_PROTECTION" as DefenseAction });
      const successSpy = sinon.spy();
      agent.on("execution:success", successSpy);

      await agent.executeDecision(decision);

      expect(mockContract.activateProtection.calledOnce).to.be.true;
      expect(successSpy.calledOnce).to.be.true;
      expect(successSpy.firstCall.args[0].txHash).to.equal("0xTxHash1");
    });

    it("should execute ORACLE_VALIDATION action", async () => {
      const decision = createMockDecision({ action: "ORACLE_VALIDATION" as DefenseAction });
      const successSpy = sinon.spy();
      agent.on("execution:success", successSpy);

      await agent.executeDecision(decision);

      expect(mockContract.configureOracle.calledOnce).to.be.true;
      expect(successSpy.calledOnce).to.be.true;
    });

    it("should execute CIRCUIT_BREAKER action", async () => {
      const decision = createMockDecision({ action: "CIRCUIT_BREAKER" as DefenseAction });
      const successSpy = sinon.spy();
      agent.on("execution:success", successSpy);

      await agent.executeDecision(decision);

      expect(mockContract.activateCircuitBreaker.calledOnce).to.be.true;
      expect(successSpy.calledOnce).to.be.true;
    });

    it("should deactivate existing protections before activating new ones", async () => {
      mockContract.isProtectionActive.resolves(true);
      mockContract.isCircuitBreakerActive.resolves(true);

      const decision = createMockDecision();
      await agent.executeDecision(decision);

      expect(mockContract.deactivateProtection.calledOnce).to.be.true;
      expect(mockContract.deactivateCircuitBreaker.calledOnce).to.be.true;
      expect(mockContract.activateProtection.calledOnce).to.be.true;
    });

    it("should emit execution:failed on error", async () => {
      mockContract.activateProtection.rejects(new Error("Transaction failed"));

      const decision = createMockDecision();
      const failedSpy = sinon.spy();
      agent.on("execution:failed", failedSpy);

      await expect(agent.executeDecision(decision)).to.be.rejectedWith("Transaction failed");
      expect(failedSpy.calledOnce).to.be.true;
    });

    it("should store protection state after successful execution", async () => {
      const decision = createMockDecision({
        chain: "ethereum",
        pair: "ETH/USDC",
        timestamp: 1000000,
        ttlMs: 60000,
      });

      await agent.executeDecision(decision);

      const state = agent.getProtectionState("ethereum", "ETH/USDC");
      expect(state).to.not.be.null;
      expect(state!.action).to.equal("MEV_PROTECTION");
      expect(state!.chain).to.equal("ethereum");
      expect(state!.expiresAt).to.equal(1060000);
    });

    it("should calculate dynamic fee based on composite score", async () => {
      const decision = createMockDecision({ compositeScore: 100 });
      await agent.executeDecision(decision);

      // At score=100: fee = 5 + (100/100)*(30-5) = 30 bps
      const callArgs = mockContract.activateProtection.firstCall.args;
      expect(callArgs[1]).to.equal(30);
    });

    it("should calculate minimum fee for low score", async () => {
      const decision = createMockDecision({ compositeScore: 0 });
      await agent.executeDecision(decision);

      // At score=0: fee = 5 + (0/100)*(30-5) = 5 bps
      const callArgs = mockContract.activateProtection.firstCall.args;
      expect(callArgs[1]).to.equal(5);
    });

    it("should truncate long rationale for circuit breaker", async () => {
      const longRationale = "x".repeat(500);
      const decision = createMockDecision({
        action: "CIRCUIT_BREAKER" as DefenseAction,
        rationale: longRationale,
      });

      await agent.executeDecision(decision);

      const callArgs = mockContract.activateCircuitBreaker.firstCall.args;
      expect(callArgs[1].length).to.be.at.most(256);
    });
  });

  describe("yellow:decision event handler", () => {
    it("should execute decision received via Yellow state channel", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const successSpy = sinon.spy();
      agent.on("execution:success", successSpy);

      const decision = createMockDecision();
      agent.emit("yellow:decision", decision);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockContract.activateProtection.calledOnce).to.be.true;
    });

    it("should emit execution:failure on Yellow decision error", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      mockContract.activateProtection.rejects(new Error("Tx failed"));

      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const failureSpy = sinon.spy();
      agent.on("execution:failure", failureSpy);

      const decision = createMockDecision();
      agent.emit("yellow:decision", decision);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(failureSpy.calledOnce).to.be.true;
      expect(failureSpy.firstCall.args[0].error).to.include("Tx failed");
    });
  });

  describe("getProtectionState", () => {
    it("should return null for unknown pool", () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const state = agent.getProtectionState("ethereum", "UNKNOWN/PAIR");
      expect(state).to.be.null;
    });
  });

  describe("getActiveProtections", () => {
    it("should return empty array when no protections active", () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const protections = agent.getActiveProtections();
      expect(protections).to.deep.equal([]);
    });

    it("should return active protections", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const decision = createMockDecision();
      await agent.executeDecision(decision);

      const protections = agent.getActiveProtections();
      expect(protections.length).to.equal(1);
      expect(protections[0].poolKey).to.equal("ethereum:ETH/USDC");
    });
  });

  describe("gas price limits", () => {
    it("should apply max gas price when configured", async () => {
      const config = createMockConfig({
        maxGasPrice: { ethereum: 50, base: 10, arbitrum: 5 },
      });
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const decision = createMockDecision({ chain: "ethereum" });
      await agent.executeDecision(decision);

      const callArgs = mockContract.activateProtection.firstCall.args;
      const txOptions = callArgs[3];
      expect(txOptions.maxFeePerGas).to.equal(ethers.parseUnits("50", "gwei"));
    });

    it("should not set gas price when not configured", async () => {
      const config = createMockConfig({ maxGasPrice: undefined });
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const decision = createMockDecision();
      await agent.executeDecision(decision);

      const callArgs = mockContract.activateProtection.firstCall.args;
      const txOptions = callArgs[3];
      expect(txOptions.maxFeePerGas).to.be.undefined;
    });
  });

  describe("TEE proof generation", () => {
    it("should return empty proof when TEE disabled", async () => {
      const config = createMockConfig({ teeEnabled: false });
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const decision = createMockDecision();
      await agent.executeDecision(decision);

      const callArgs = mockContract.activateProtection.firstCall.args;
      const proof = callArgs[2];
      expect(proof.length).to.equal(0);
    });

    it("should return placeholder proof when TEE enabled", async () => {
      const config = createMockConfig({ teeEnabled: true });
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const decision = createMockDecision();
      await agent.executeDecision(decision);

      const callArgs = mockContract.activateProtection.firstCall.args;
      const proof = callArgs[2];
      expect(proof.length).to.equal(64);
    });
  });

  describe("Chainlink feed lookup", () => {
    it("should return correct feed for known pairs", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const decision = createMockDecision({
        action: "ORACLE_VALIDATION" as DefenseAction,
        chain: "ethereum",
        pair: "ETH/USDC",
      });
      await agent.executeDecision(decision);

      const callArgs = mockContract.configureOracle.firstCall.args;
      expect(callArgs[1]).to.equal("0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419");
    });

    it("should return zero address for unknown pairs", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const decision = createMockDecision({
        action: "ORACLE_VALIDATION" as DefenseAction,
        chain: "ethereum",
        pair: "UNKNOWN/PAIR",
      });
      await agent.executeDecision(decision);

      const callArgs = mockContract.configureOracle.firstCall.args;
      expect(callArgs[1]).to.equal(ethers.ZeroAddress);
    });
  });

  describe("multi-chain execution", () => {
    it("should execute on Base chain", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 8453n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const decision = createMockDecision({ chain: "base" });
      await agent.executeDecision(decision);

      expect(mockContract.activateProtection.calledOnce).to.be.true;
    });

    it("should execute on Arbitrum chain", async () => {
      const config = createMockConfig();
      const agent = new ExecutorAgent(config);

      const mockContract = createMockContract();
      const mockProvider = { getNetwork: sinon.stub().resolves({ chainId: 42161n }) };
      const mockWallet = { address: "0xAgentAddress" };

      sandbox.stub(ethers, "JsonRpcProvider").returns(mockProvider as any);
      sandbox.stub(ethers, "Wallet").returns(mockWallet as any);
      sandbox.stub(ethers, "Contract").returns(mockContract as any);

      await agent.initialize();

      const decision = createMockDecision({ chain: "arbitrum" });
      await agent.executeDecision(decision);

      expect(mockContract.activateProtection.calledOnce).to.be.true;
    });
  });
});

// For chai-as-promised support
import chaiAsPromised from "chai-as-promised";
import chai from "chai";
chai.use(chaiAsPromised);