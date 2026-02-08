/**
 * SENTINEL LIVE Dashboard
 * Real-time E2E flow monitoring: Scout → Yellow → Validator → Risk Engine → Executor → Settlement
 */
"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { io, Socket } from "socket.io-client";
import { useTheme } from "next-themes";
import {
  Activity,
  Shield,
  Zap,
  Terminal,
  Radio,
  TrendingUp,
  Moon,
  Sun,
  AlertTriangle,
  CheckCircle,
  XCircle,
  RefreshCw,
  ChevronDown,
  ArrowRight,
  Clock,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// Types
interface LogEntry {
  id: string;
  timestamp: number;
  level: "INFO" | "WARN" | "SIGNAL" | "ERROR" | "SUCCESS";
  source: string;
  message: string;
}

interface Execution {
  id: string;
  timestamp: number;
  chain: string;
  action: string;
  poolId: string;
  txHash: string;
  status: "pending" | "success" | "failed";
  tier: string;
}

interface RiskScore {
  current: number;
  tier: "WATCH" | "ELEVATED" | "CRITICAL";
  contributingSignals: number;
}

interface HysteresisState {
  poolId: string;
  tier: string;
  score: number;
  timestamp: number;
}

interface GasDataPoint {
  timestamp: number;
  chain: string;
  gasPrice: number;
}

interface PriceDataPoint {
  timestamp: number;
  pair: string;
  price: number;
  source?: string;
}

interface SimulationResult {
  id: string;
  attackType: string;
  protectionResponse: {
    triggered: boolean;
    action: string | null;
    tier: string;
    score: number;
  };
  mockTxHash: string;
}

// E2E Flow Types
type FlowStage =
  | "scout_signal"
  | "yellow_session"
  | "validator_alert"
  | "risk_decision"
  | "executor_action"
  | "settlement";

interface FlowStageData {
  stage: FlowStage;
  timestamp: number;
  data?: Record<string, unknown>;
}

interface E2EFlow {
  id: string;
  startTime: number;
  chain: string;
  poolId: string;
  stages: FlowStageData[];
  currentStage: FlowStage;
  settlementTxHash?: string;
  status: "active" | "completed" | "failed";
  executionId?: string; // Link to execution entry (backend only)
}

// Constants
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3000";
const ATTACK_TYPES = [
  {
    id: "SANDWICH",
    name: "Sandwich Attack",
    icon: "🥪",
    desc: "MEV sandwich pattern simulation",
  },
  {
    id: "ORACLE_MANIPULATION",
    name: "Oracle Manipulation",
    icon: "🔮",
    desc: "Oracle price deviation attack",
  },
  {
    id: "FLASH_LOAN",
    name: "Flash Loan Attack",
    icon: "⚡",
    desc: "Flash loan + large swap pattern",
  },
  {
    id: "CROSS_CHAIN",
    name: "Cross-Chain Attack",
    icon: "🌐",
    desc: "Cross-chain arbitrage attack (mainnet-only)",
  },
  {
    id: "JIT_LIQUIDITY",
    name: "JIT Liquidity",
    icon: "💉",
    desc: "Just-in-time liquidity extraction",
  },
  {
    id: "FRONTRUN",
    name: "Frontrun Attack",
    icon: "🏃",
    desc: "Generalized frontrunning with gas spike",
  },
  {
    id: "TOXIC_ARBITRAGE",
    name: "Toxic Arbitrage",
    icon: "☠️",
    desc: "LP-extractive arbitrage pattern",
  },
];

const CHAINS = ["ethereum", "base", "arbitrum"];

// Pool addresses - keyed by chain, all pools are WETH/USDC on different chains
const POOL_ADDRESSES: Record<string, string> = {
  ethereum: "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8",
  base: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  arbitrum: "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443",
};

// Chain explorer URLs - TESTNETS
const CHAIN_EXPLORERS: Record<string, string> = {
  ethereum: "https://sepolia.etherscan.io/tx/",
  base: "https://sepolia.basescan.org/tx/",
  arbitrum: "https://sepolia.arbiscan.io/tx/",
};

function getExplorerUrl(chain: string, txHash: string): string {
  const baseUrl =
    CHAIN_EXPLORERS[chain.toLowerCase()] || CHAIN_EXPLORERS.ethereum;
  return `${baseUrl}${txHash}`;
}

const STAGE_NAMES: Record<FlowStage, string> = {
  scout_signal: "Scout Signal",
  yellow_session: "Yellow Session",
  validator_alert: "Validator Alert",
  risk_decision: "Risk Decision",
  executor_action: "Executor Action",
  settlement: "Settlement",
};

const STAGE_ORDER: FlowStage[] = [
  "scout_signal",
  "yellow_session",
  "validator_alert",
  "risk_decision",
  "executor_action",
  "settlement",
];

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-black/90 border border-white/10 p-2 rounded shadow-xl text-xs">
        <p className="text-gray-300 mb-1">
          {new Date(label).toLocaleTimeString()}
        </p>
        <p className="text-cyan-400 font-mono">{payload[0].value.toFixed(4)}</p>
      </div>
    );
  }
  return null;
};

export default function DashboardPage() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);

  // Data state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [riskScore, setRiskScore] = useState<RiskScore>({
    current: 0,
    tier: "WATCH",
    contributingSignals: 0,
  });
  const [hysteresisHistory, setHysteresisHistory] = useState<HysteresisState[]>(
    [],
  );
  const [gasHistory, setGasHistory] = useState<GasDataPoint[]>([]);
  const [priceHistory, setPriceHistory] = useState<PriceDataPoint[]>([]);
  const [e2eFlows, setE2EFlows] = useState<E2EFlow[]>([]);
  const [yellowChannel, setYellowChannel] = useState<any>(null);

  // Yellow session management state
  const [sessionStarting, setSessionStarting] = useState(false);
  const [sessionEnding, setSessionEnding] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Simulation state
  const [selectedAttack, setSelectedAttack] = useState(ATTACK_TYPES[0].id);
  const [selectedChain, setSelectedChain] = useState(CHAINS[0]);
  const [simulating, setSimulating] = useState(false);
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);

  // Graph filters
  const [graphChain, setGraphChain] = useState<string>("ethereum");

  useEffect(() => {
    setMounted(true);
  }, []);

  // Auto-clear session errors after 5 seconds
  useEffect(() => {
    if (sessionError) {
      const timer = setTimeout(() => {
        setSessionError(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [sessionError]);

  const fetchInitialData = useCallback(async () => {
    try {
      const [
        logsRes,
        execsRes,
        riskRes,
        gasRes,
        priceRes,
        flowsRes,
        yellowRes,
      ] = await Promise.all([
        fetch(`${API_BASE}/api/dashboard/scout-logs?limit=50`),
        fetch(`${API_BASE}/api/dashboard/executions?limit=20`),
        fetch(`${API_BASE}/api/dashboard/risk-scores`),
        fetch(`${API_BASE}/api/dashboard/gas-history`),
        fetch(`${API_BASE}/api/dashboard/price-history`),
        fetch(`${API_BASE}/api/dashboard/e2e-flows`),
        fetch(`${API_BASE}/api/dashboard/yellow-channels`),
      ]);

      if (logsRes.ok) {
        const data = await logsRes.json();
        setLogs(data.logs || []);
      }
      if (execsRes.ok) {
        const data = await execsRes.json();
        setExecutions(data.executions || []);
      }
      if (riskRes.ok) {
        const data = await riskRes.json();
        setRiskScore(
          data.current || { current: 0, tier: "WATCH", contributingSignals: 0 },
        );
        setHysteresisHistory(data.hysteresisHistory || []);
      }
      if (gasRes.ok) {
        const data = await gasRes.json();
        setGasHistory(data.history || []);
      }
      if (priceRes.ok) {
        const data = await priceRes.json();
        setPriceHistory(data.history || []);
      }
      if (flowsRes.ok) {
        const data = await flowsRes.json();
        setE2EFlows(data.flows || []);
      }
      if (yellowRes.ok) {
        const data = await yellowRes.json();
        setYellowChannel(data);
      }
    } catch (error) {
      console.error("Failed to fetch initial data:", error);
    }
  }, []);

  useEffect(() => {
    fetchInitialData();
    const newSocket = io(API_BASE);

    newSocket.on("connect", () => {
      setConnected(true);
      console.log("Connected to dashboard WebSocket");
    });
    newSocket.on("disconnect", () => setConnected(false));

    newSocket.on("log", (entry: LogEntry) =>
      setLogs((prev) => [...prev.slice(-99), entry]),
    );
    newSocket.on("execution", (exec: Execution) =>
      setExecutions((prev) => [...prev.slice(-19), exec]),
    );
    newSocket.on("executionUpdate", (exec: Execution) =>
      setExecutions((prev) => prev.map((e) => (e.id === exec.id ? exec : e))),
    );
    newSocket.on(
      "riskUpdate",
      (data: { score: number; tier: "WATCH" | "ELEVATED" | "CRITICAL" }) => {
        setRiskScore((prev) => ({
          ...prev,
          current: data.score,
          tier: data.tier,
        }));
      },
    );
    newSocket.on("gasUpdate", (point: GasDataPoint) =>
      setGasHistory((prev) => [...prev.slice(-99), point]),
    );
    newSocket.on("priceUpdate", (point: PriceDataPoint) =>
      setPriceHistory((prev) => [...prev.slice(-99), point]),
    );
    newSocket.on("yellowUpdate", (state: any) => {
      setYellowChannel(state);
    });
    newSocket.on("flowStarted", (flow: E2EFlow) =>
      setE2EFlows((prev) => [flow, ...prev.slice(0, 19)]),
    );
    newSocket.on("flowUpdated", (flow: E2EFlow) => {
      setE2EFlows((prev) => prev.map((f) => (f.id === flow.id ? flow : f)));
    });
    newSocket.on("flowCompleted", (flow: E2EFlow) => {
      setE2EFlows((prev) => prev.map((f) => (f.id === flow.id ? flow : f)));
    });
    newSocket.on("flowFailed", (data: { flow: E2EFlow; error: string }) => {
      setE2EFlows((prev) =>
        prev.map((f) => (f.id === data.flow.id ? data.flow : f)),
      );
    });

    setSocket(newSocket);
    return () => {
      newSocket.close();
    };
  }, [fetchInitialData]);

  const gasChartData = useMemo(() => {
    return gasHistory.filter((g) => g.chain === graphChain).slice(-30);
  }, [gasHistory, graphChain]);

  const priceChartData = useMemo(() => {
    return priceHistory.slice(-30);
  }, [priceHistory]);

  const runSimulation = async () => {
    setSimulating(true);
    setSimResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/simulate-attack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedAttack,
          targetPool: POOL_ADDRESSES[selectedChain],
          chain: selectedChain,
          intensity: "medium",
        }),
      });
      const result = await res.json();
      if (res.ok) {
        setSimResult(result);
      } else {
        console.error("Simulation rejected:", result);
        alert(`Simulation failed: ${result.error || "Unknown error"}`);
      }
    } catch (error) {
      console.error("Simulation failed:", error);
      alert(
        `Simulation failed: ${error instanceof Error ? error.message : "Network error"}`,
      );
    } finally {
      setSimulating(false);
    }
  };

  // Yellow Session Management Functions
  const startYellowSession = async (depositAmount: string = '5') => {
    setSessionStarting(true);
    setSessionError(null);
    try {
      const res = await fetch(`${API_BASE}/api/yellow/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depositAmount }),
      });
      const result = await res.json();
      
      if (res.ok && result.success) {
        // Refresh Yellow channel state
        await fetchInitialData();
        console.log('✅ Yellow session started:', result.sessionId);
      } else {
        const errorMsg = result.error || result.message || "Failed to start session";
        setSessionError(errorMsg);
        console.error("Session start failed:", result);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Network error";
      setSessionError(errorMsg);
      console.error("Session start error:", error);
    } finally {
      setSessionStarting(false);
    }
  };

  const endYellowSession = async () => {
    setSessionEnding(true);
    setSessionError(null);
    try {
      const res = await fetch(`${API_BASE}/api/yellow/session/end`, {
        method: "POST",
      });
      const result = await res.json();
      
      if (res.ok && result.success) {
        // Refresh Yellow channel state
        await fetchInitialData();
        console.log('✅ Yellow session ended:', result.summary);
      } else {
        const errorMsg = result.error || result.message || "Failed to end session";
        setSessionError(errorMsg);
        console.error("Session end failed:", result);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Network error";
      setSessionError(errorMsg);
      console.error("Session end error:", error);
    } finally {
      setSessionEnding(false);
    }
  };

  if (!mounted) return null;

  const getTierColor = (tier: string) => {
    switch (tier) {
      case "CRITICAL":
        return "text-red-500 bg-red-500/20";
      case "ELEVATED":
        return "text-yellow-500 bg-yellow-500/20";
      default:
        return "text-green-500 bg-green-500/20";
    }
  };

  const getStageIcon = (stage: FlowStage) => {
    switch (stage) {
      case "scout_signal":
        return "📡";
      case "yellow_session":
        return "🟡";
      case "validator_alert":
        return "🔍";
      case "risk_decision":
        return "🧠";
      case "executor_action":
        return "⚡";
      case "settlement":
        return "✅";
      default:
        return "⏺";
    }
  };

  const getStageStatus = (flow: E2EFlow, stage: FlowStage) => {
    // Check if this stage exists in the flow's recorded stages
    const stageExists = flow.stages.some((s) => s.stage === stage);
    const stageIndex = STAGE_ORDER.indexOf(stage);
    const currentIndex = STAGE_ORDER.indexOf(flow.currentStage);

    if (stageExists && stageIndex < currentIndex) return "completed";
    if (stageExists && stageIndex === currentIndex) {
      return flow.status === "completed" ? "completed" : "active";
    }
    if (!stageExists && stageIndex <= currentIndex) return "completed"; // Stage was implicitly passed
    return "pending";
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-4 lg:p-6 font-sans">
      {/* Header */}
      <header className="flex flex-col lg:flex-row lg:items-center justify-between mb-6 gap-4">
        <div className="flex items-center gap-3">
          {/* <Shield className="w-8 h-8 text-cyan-400" /> */}
          {/* <h1 className="text-2xl lg:text-3xl font-bold bg-gradient-to-r from-cyan-400 to-teal-400 bg-clip-text text-transparent">
            SENTINEL LIVE
          </h1> */}
          <div
            className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm ${connected ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}
          >
            <span
              className={`w-2 h-2 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-red-400"}`}
            />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchInitialData}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
            title="Refresh data"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
          >
            {theme === "dark" ? (
              <Sun className="w-5 h-5" />
            ) : (
              <Moon className="w-5 h-5" />
            )}
          </button>
        </div>
      </header>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        {/* Left Column */}
        <div className="lg:col-span-1 space-y-4 lg:space-y-6">
          {/* E2E Flow Tracker */}
          <div className="bg-gradient-to-br from-[#0a1a2a]/90 to-[#1a1a0a]/90 backdrop-blur-sm rounded-xl border border-yellow-500/20 p-5 shadow-lg shadow-yellow-500/5">
            <div className="flex items-center gap-2 mb-4">
              <Radio className="w-5 h-5 text-yellow-400" />
              <h2 className="font-semibold text-lg">E2E Flow Tracker</h2>
              <span className="ml-auto text-xs bg-yellow-900/30 text-yellow-400 px-2 py-1 rounded">
                {e2eFlows.length} Active
              </span>
            </div>

            <div className="space-y-3 max-h-96 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-700">
              {e2eFlows.slice(0, 3).map((flow) => (
                <div
                  key={flow.id}
                  className={`p-3 rounded-lg border ${
                    flow.status === "completed"
                      ? "bg-green-500/5 border-green-500/20"
                      : flow.status === "failed"
                        ? "bg-red-500/5 border-red-500/20"
                        : "bg-white/5 border-white/10"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-500 font-mono">
                      {flow.poolId.substring(0, 10)}...
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded uppercase ${
                        flow.status === "completed"
                          ? "bg-green-900/30 text-green-400"
                          : flow.status === "failed"
                            ? "bg-red-900/30 text-red-400"
                            : "bg-blue-900/30 text-blue-400"
                      }`}
                    >
                      {flow.status}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {STAGE_ORDER.map((stage) => {
                      const status = getStageStatus(flow, stage);
                      return (
                        <div key={stage} className="flex items-center gap-2">
                          <span
                            className={`text-sm ${status === "completed" ? "opacity-100" : status === "active" ? "opacity-100" : "opacity-30"}`}
                          >
                            {getStageIcon(stage)}
                          </span>
                          <span
                            className={`text-xs flex-1 ${status === "active" ? "text-yellow-400 font-semibold" : "text-gray-500"}`}
                          >
                            {STAGE_NAMES[stage]}
                          </span>
                          {status === "completed" && (
                            <CheckCircle className="w-3 h-3 text-green-400" />
                          )}
                          {status === "active" && (
                            <Clock className="w-3 h-3 text-yellow-400 animate-pulse" />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {flow.settlementTxHash && (
                    <div className="mt-2 pt-2 border-t border-white/5">
                      <a
                        href={getExplorerUrl(flow.chain, flow.settlementTxHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-mono text-cyan-400 hover:underline flex items-center gap-1"
                      >
                        <span className="text-gray-500">TX:</span>{" "}
                        {flow.settlementTxHash.substring(0, 12)}... ↗
                      </a>
                    </div>
                  )}
                </div>
              ))}

              {e2eFlows.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <Radio className="w-12 h-12 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No active flows</p>
                  <p className="text-xs">
                    Trigger an attack to start E2E tracking
                  </p>
                </div>
              )}
            </div>
          </div>
          {/* Yellow Network Session Info */}
          <div className="bg-gradient-to-br from-[#1a1a0a]/90 to-[#0a1a2a]/90 backdrop-blur-sm rounded-xl border border-yellow-500/30 p-5 shadow-lg shadow-yellow-500/10">
            <div className="flex items-center gap-2 mb-4">
              <Radio className="w-5 h-5 text-yellow-400" />
              <h2 className="font-semibold text-lg text-yellow-400">Yellow Network</h2>
              <span className={`ml-auto text-xs px-2 py-1 rounded ${yellowChannel?.connected ? "bg-green-900/30 text-green-400" : "bg-gray-900/30 text-gray-500"}`}>
                {yellowChannel?.connected ? "CONNECTED" : "OFFLINE"}
              </span>
            </div>
            <div className="space-y-3">
              {/* Session Status */}
              <div className="bg-gradient-to-br from-yellow-500/5 to-yellow-900/5 border border-yellow-500/20 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400">Session Status</span>
                  <span className={`text-xs px-2 py-0.5 rounded font-semibold ${yellowChannel?.sessionId ? "bg-green-900/30 text-green-400" : "bg-gray-900/30 text-gray-400"}`}>
                    {yellowChannel?.sessionId ? "ACTIVE" : "NO SESSION"}
                  </span>
                </div>
                {yellowChannel?.sessionId && (
                  <div className="font-mono text-xs bg-black/40 border border-yellow-500/20 rounded px-2 py-1 break-all">
                    {yellowChannel.sessionId.substring(0, 16)}...
                  </div>
                )}
              </div>

              {/* Session Stats (only show if session active) */}
              {yellowChannel?.sessionId && (
                <div className="bg-gradient-to-br from-yellow-500/10 to-yellow-900/10 border border-yellow-500/20 rounded-lg p-3 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-400">Micro-Fees Accrued</span>
                    <span className="text-sm font-semibold text-green-400">{yellowChannel?.microFeesAccrued || "0.000"} YUSD</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-400">State Version</span>
                    <span className="text-sm font-semibold text-cyan-400">#{yellowChannel?.stateVersion || 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-400">Total Actions</span>
                    <span className="text-sm font-semibold text-blue-400">{yellowChannel?.totalActions || 0}</span>
                  </div>
                </div>
              )}

              {/* Session Control Buttons */}
              <div className="pt-2 space-y-2">
                {!yellowChannel?.sessionId ? (
                  <button
                    onClick={() => startYellowSession('5')}
                    disabled={sessionStarting || !yellowChannel?.connected}
                    className="w-full px-4 py-3 bg-gradient-to-r from-yellow-600 to-yellow-400 hover:from-yellow-500 hover:to-yellow-300 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-yellow-900/20"
                  >
                    {sessionStarting ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Starting Session...
                      </>
                    ) : (
                      <>
                        <Radio className="w-4 h-4" />
                        Start Yellow Session
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    onClick={endYellowSession}
                    disabled={sessionEnding}
                    className="w-full px-4 py-3 bg-gradient-to-r from-red-600 to-red-400 hover:from-red-500 hover:to-red-300 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-red-900/20"
                  >
                    {sessionEnding ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Ending Session...
                      </>
                    ) : (
                      <>
                        <XCircle className="w-4 h-4" />
                        End Yellow Session
                      </>
                    )}
                  </button>
                )}
                
                {!yellowChannel?.connected && (
                  <p className="text-xs text-center text-gray-500 mt-2">
                    Agent not connected to Yellow Network
                  </p>
                )}
                
                {yellowChannel?.connected && !yellowChannel?.sessionId && (
                  <p className="text-xs text-center text-gray-400 mt-2">
                    Start a session to enable off-chain coordination
                  </p>
                )}
              </div>

              {/* Session Error Display */}
              {sessionError && (
                <div className="mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
                  {sessionError}
                </div>
              )}
            </div>
          </div>

          {/* Attack Simulator */}
          <div className="bg-gradient-to-br from-[#0a1a2a]/90 to-[#1a0a2a]/90 backdrop-blur-sm rounded-xl border border-cyan-500/20 p-5 shadow-lg shadow-purple-500/5">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="w-5 h-5 text-cyan-400" />
              <h2 className="font-semibold text-lg">Attack Simulator</h2>
            </div>

            <div className="grid grid-cols-2 gap-2 mb-4">
              {ATTACK_TYPES.map((attack) => (
                <button
                  key={attack.id}
                  onClick={() => setSelectedAttack(attack.id)}
                  className={`p-3 rounded-lg border transition-all text-left ${
                    selectedAttack === attack.id
                      ? "bg-cyan-500/20 border-cyan-500"
                      : "bg-white/5 border-white/10 hover:bg-white/10 hover:border-cyan-500/50"
                  }`}
                >
                  <div className="text-xl mb-1">{attack.icon}</div>
                  <div className="font-medium text-xs">{attack.name}</div>
                </button>
              ))}
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-gray-500">Trading Pair</label>
                <div className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-400">
                  WETH/USDC
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Pool: {POOL_ADDRESSES[selectedChain].slice(0, 6)}...
                  {POOL_ADDRESSES[selectedChain].slice(-4)}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-gray-500">Network</label>
                <select
                  value={selectedChain}
                  onChange={(e) => setSelectedChain(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-500"
                >
                  {CHAINS.map((chain) => (
                    <option key={chain} value={chain}>
                      {chain.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>

              <button
                onClick={runSimulation}
                disabled={simulating}
                className="w-full mt-2 px-4 py-3 bg-gradient-to-r from-cyan-600 to-cyan-300 hover:from-cyan-500 hover:to-cyan-200 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-purple-900/20"
              >
                {simulating ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
                {simulating ? "Simulating Attack..." : "Launch Attack"}
              </button>
            </div>

            {simResult && (
              <div className="mt-4 p-4 bg-black/40 rounded-lg border border-purple-500/30 animate-in fade-in slide-in-from-top-2">
                <div className="flex items-center gap-2 mb-3 pb-3 border-b border-white/5">
                  {simResult.protectionResponse.triggered ? (
                    <>
                      <CheckCircle className="w-5 h-5 text-green-400" />
                      <span className="text-green-400 font-semibold">
                        Protection Triggered
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-5 h-5 text-yellow-400" />
                      <span className="text-yellow-400 font-semibold">
                        No Threat Detected
                      </span>
                    </>
                  )}
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Action</span>
                    <span className="font-mono text-cyan-400">
                      {simResult.protectionResponse.action || "NONE"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-500">Risk Tier</span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${getTierColor(simResult.protectionResponse.tier)}`}
                    >
                      {simResult.protectionResponse.tier}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Score</span>
                    <span className="font-mono">
                      {simResult.protectionResponse.score.toFixed(1)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column (2 spans) */}
        <div className="lg:col-span-2 space-y-4 lg:space-y-6">
          {/* Scout Logs - Full Width */}
          <div className="lg:col-span-2">
            <div className="bg-[#0a1a2a]/80 backdrop-blur-sm rounded-xl border border-cyan-500/20 p-5 shadow-lg shadow-cyan-500/5">
              <div className="flex items-center gap-2 mb-4">
                <Terminal className="w-5 h-5 text-cyan-400" />
                <h2 className="font-semibold text-lg">
                  Scout Agent - Live Activity Monitor
                </h2>
                <span className="ml-auto text-xs bg-cyan-900/30 text-cyan-400 px-2 py-1 rounded">
                  🔴 Live Feed
                </span>
              </div>
              <div className="h-80 overflow-y-auto font-mono text-sm space-y-1.5 bg-black/40 rounded-lg p-4 border border-white/5 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
                {logs
                  .slice()
                  .reverse()
                  .slice(0, 100)
                  .map((log) => (
                    <div
                      key={log.id}
                      className="flex gap-3 hover:bg-white/5 p-2 rounded transition-colors duration-150 border-l-2 border-transparent hover:border-cyan-500/50"
                    >
                      <span className="text-gray-500 shrink-0 w-24 text-xs">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span
                        className={`shrink-0 w-20 text-center rounded px-2 py-0.5 text-xs font-semibold ${
                          log.level === "ERROR"
                            ? "bg-red-900/30 text-red-400 border border-red-500/20"
                            : log.level === "WARN"
                              ? "bg-yellow-900/30 text-yellow-400 border border-yellow-500/20"
                              : log.level === "SUCCESS"
                                ? "bg-green-900/30 text-green-400 border border-green-500/20"
                                : log.level === "SIGNAL"
                                  ? "bg-cyan-900/30 text-cyan-400 border border-cyan-500/20"
                                  : "bg-gray-900/30 text-gray-400 border border-gray-500/20"
                        }`}
                      >
                        {log.level}
                      </span>
                      <span className="text-gray-200 flex-1 leading-relaxed">
                        {log.message}
                      </span>
                    </div>
                  ))}
                {logs.length === 0 && (
                  <div className="flex h-full items-center justify-center text-gray-500">
                    <div className="text-center">
                      <RefreshCw className="w-8 h-8 mx-auto mb-2 opacity-50 animate-spin-slow" />
                      <p className="text-sm">
                        Waiting for Scout Agent signals...
                      </p>
                      <p className="text-xs mt-2 text-gray-600">
                        Monitoring mempool, gas prices, and DEX activity
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Risk Engine & Other Panels - Side by Side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
            {/* Risk Engine */}
            <div className="bg-[#0a1a2a]/80 backdrop-blur-sm rounded-xl border border-cyan-500/20 p-5 shadow-lg shadow-cyan-500/5">
              <div className="flex items-center gap-2 mb-4">
                <Activity className="w-5 h-5 text-cyan-400" />
                <h2 className="font-semibold text-lg">Risk Engine</h2>
              </div>
              <div className="flex items-center justify-between mb-6">
                <div className="relative w-32 h-32 mx-auto">
                  <svg className="w-full h-full -rotate-90">
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      fill="none"
                      stroke="#1a2a3a"
                      strokeWidth="8"
                    />
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="8"
                      strokeDasharray={`${(riskScore.current / 100) * 351} 351`}
                      className={`transition-all duration-1000 ${
                        riskScore.tier === "CRITICAL"
                          ? "text-red-500"
                          : riskScore.tier === "ELEVATED"
                            ? "text-yellow-500"
                            : "text-green-500"
                      }`}
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-3xl font-bold">
                      {Math.round(riskScore.current)}
                    </span>
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                      Score
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="text-right">
                    <div className="text-xs text-gray-500">Current Tier</div>
                    <div
                      className={`text-sm font-bold px-2 py-1 rounded inline-block mt-1 ${getTierColor(riskScore.tier)}`}
                    >
                      {riskScore.tier}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-500">Active Signals</div>
                    <div className="text-lg font-mono text-cyan-400">
                      {riskScore.contributingSignals}
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Hysteresis History (Last 20)</span>
                </div>
                <div className="h-16 flex items-end gap-1 bg-black/20 rounded p-2">
                  {hysteresisHistory.slice(-20).map((h, i) => (
                    <div
                      key={i}
                      className={`flex-1 rounded-t opacity-80 hover:opacity-100 transition-opacity ${
                        h.tier === "CRITICAL"
                          ? "bg-red-500"
                          : h.tier === "ELEVATED"
                            ? "bg-yellow-500"
                            : "bg-green-500"
                      }`}
                      style={{ height: `${(h.score / 100) * 100}%` }}
                      title={`${h.tier}: ${h.score.toFixed(1)}`}
                    />
                  ))}
                  {hysteresisHistory.length === 0 && (
                    <div className="w-full text-center text-xs text-gray-600 self-center">
                      No history data
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Executions */}
          <div className="bg-[#0a1a2a]/80 backdrop-blur-sm rounded-xl border border-cyan-500/20 p-5 shadow-lg shadow-cyan-500/5">
            <div className="flex items-center gap-2 mb-4">
              <Zap className="w-5 h-5 text-cyan-400" />
              <h2 className="font-semibold text-lg">Recent Executions</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-gray-500 uppercase bg-black/20">
                  <tr>
                    <th className="px-4 py-3 rounded-l-lg">Status</th>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">Chain</th>
                    <th className="px-4 py-3">Tier</th>
                    <th className="px-4 py-3 rounded-r-lg">TX Hash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {executions
                    .slice()
                    .reverse()
                    .slice(0, 5)
                    .map((exec) => (
                      <tr
                        key={exec.id}
                        className="hover:bg-white/5 transition-colors"
                      >
                        <td className="px-4 py-3">
                          {exec.status === "success" ? (
                            <div className="flex items-center gap-2 text-green-400">
                              <CheckCircle className="w-4 h-4" /> Success
                            </div>
                          ) : exec.status === "failed" ? (
                            <div className="flex items-center gap-2 text-red-400">
                              <XCircle className="w-4 h-4" /> Failed
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 text-yellow-400">
                              <RefreshCw className="w-4 h-4 animate-spin" />{" "}
                              Pending
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-300 font-medium">
                          {exec.action}
                        </td>
                        <td className="px-4 py-3 uppercase text-xs text-gray-500">
                          {exec.chain}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs px-2 py-1 rounded ${getTierColor(exec.tier)}`}
                          >
                            {exec.tier}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {exec.txHash === "0xPENDING" ? (
                            <span className="font-mono text-gray-500 text-xs">
                              Pending...
                            </span>
                          ) : (
                            <a
                              href={getExplorerUrl(exec.chain, exec.txHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-cyan-400 hover:text-cyan-300 hover:underline flex items-center gap-1"
                            >
                              {exec.txHash.slice(0, 8)}...
                              {exec.txHash.slice(-4)}
                              <small className="opacity-50">↗</small>
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  {executions.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-4 py-8 text-center text-gray-500"
                      >
                        No executions recorded within the last 24 hours.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Live Graphs */}
          <div className="bg-[#0a1a2a]/80 backdrop-blur-sm rounded-xl border border-cyan-500/20 p-5 shadow-lg shadow-cyan-500/5">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6 gap-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-cyan-400" />
                <h2 className="font-semibold text-lg">
                  Live Market & Gas Feed
                </h2>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500">Network:</span>
                <select
                  className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500"
                  value={graphChain}
                  onChange={(e) => setGraphChain(e.target.value)}
                >
                  <option value="ethereum">Ethereum</option>
                  <option value="base">Base</option>
                  <option value="arbitrum">Arbitrum</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Gas Chart */}
              <div className="h-72 bg-black/20 rounded-lg p-2 border border-white/5">
                <h3 className="text-xs text-gray-400 mb-2 pl-2">
                  Gas Price (Gwei)
                </h3>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={gasChartData}>
                    <defs>
                      <linearGradient id="colorGas" x1="0" y1="0" x2="0" y2="1">
                        <stop
                          offset="5%"
                          stopColor="#06b6d4"
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="95%"
                          stopColor="#06b6d4"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                    <XAxis
                      dataKey="timestamp"
                      tickFormatter={(ts) =>
                        new Date(ts).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      }
                      stroke="#666"
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis
                      stroke="#666"
                      tick={{ fontSize: 10 }}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="gasPrice"
                      stroke="#06b6d4"
                      fillOpacity={1}
                      fill="url(#colorGas)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Price Chart */}
              <div className="h-72 bg-black/20 rounded-lg p-2 border border-white/5">
                <h3 className="text-xs text-gray-400 mb-2 pl-2">
                  WETH Price (USD)
                </h3>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={priceChartData}>
                    <defs>
                      <linearGradient
                        id="colorPrice"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor="#14b8a6"
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="95%"
                          stopColor="#14b8a6"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                    <XAxis
                      dataKey="timestamp"
                      tickFormatter={(ts) =>
                        new Date(ts).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      }
                      stroke="#666"
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis
                      stroke="#666"
                      tick={{ fontSize: 10 }}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="price"
                      stroke="#14b8a6"
                      fillOpacity={1}
                      fill="url(#colorPrice)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
