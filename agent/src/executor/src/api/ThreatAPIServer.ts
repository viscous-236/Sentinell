/**
 * Threat API Server (Extended for Dashboard)
 *
 * REST API + WebSocket for live dashboard consumption.
 * Serves threat data, scout logs, risk scores, and attack simulation.
 *
 * Binding: 0.0.0.0:3000
 * CORS enabled for frontend on port 8000
 */

import express, { Request, Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createServer, Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import type { LPThreatBroadcast, CachedThreat } from "../types/LPBroadcast";
import {
  dashboardState,
  DashboardLogEntry,
  GasDataPoint,
  PriceDataPoint,
} from "./DashboardState";
import { attackSimulator, AttackSimulationRequest } from "./AttackSimulator";
import type { YellowMessageBus } from "../../../shared/yellow/YellowMessageBus";

export interface ThreatAPIConfig {
  port: number;
  retentionMs: number; // How long to keep threats in cache
}

// Signature cache for Yellow API
interface SignatureCache {
  poolId: string;
  action: string;
  fee: number;
  expiryBlock: number;
  timestamp: number;
  signature: string;
  signer: string;
}

export class ThreatAPIServer {
  private app: express.Application;
  private httpServer: HttpServer;
  private io: SocketIOServer;
  private config: ThreatAPIConfig;
  private threatCache: Map<string, CachedThreat>;
  private signatureCache: Map<string, SignatureCache>;
  private cleanupInterval?: ReturnType<typeof setInterval>;
  private yellowMessageBus?: YellowMessageBus; // Injected after construction

  constructor(config: ThreatAPIConfig) {
    this.config = config;
    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: false
      },
    });
    this.threatCache = new Map();
    this.signatureCache = new Map();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupDashboardEvents();
  }

  private setupMiddleware(): void {
    // CORS for frontend
    this.app.use(
      cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
      }),
    );

    // JSON parsing
    this.app.use(express.json());

    // Rate limiting: 100 requests per 15 minutes
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: "Too many requests, please try again later",
    });
    this.app.use(limiter);
  }

  private setupRoutes(): void {
    // =========================================================================
    // Health & Status
    // =========================================================================

    this.app.get("/api/health", (req: Request, res: Response) => {
      res.json({
        status: "ok",
        timestamp: Date.now(),
        cacheSize: this.threatCache.size,
      });
    });

    this.app.get("/api/dashboard/status", (req: Request, res: Response) => {
      const snapshot = dashboardState.getSnapshot();
      res.json({
        status: snapshot.status,
        uptime: snapshot.uptime,
        yellowChannel: snapshot.yellowChannel,
        riskScore: snapshot.riskScore,
        timestamp: Date.now(),
      });
    });

    // =========================================================================
    // Threat Endpoints (Original)
    // =========================================================================

    this.app.get("/api/threats", (req: Request, res: Response) => {
      const threats = this.getActiveThreats();
      res.json({
        threats,
        count: threats.length,
        timestamp: Date.now(),
      });
    });

    this.app.get("/api/threats/:poolId", (req: Request, res: Response) => {
      const { poolId } = req.params;
      const threats = this.getActiveThreats().filter(
        (t) => t.targetPool === poolId,
      );
      res.json({
        threats,
        count: threats.length,
        timestamp: Date.now(),
      });
    });

    this.app.get("/api/threats/chain/:chain", (req: Request, res: Response) => {
      const { chain } = req.params;
      const chainStr = Array.isArray(chain) ? chain[0] : chain;
      const threats = this.getActiveThreats().filter(
        (t) => t.chain.toLowerCase() === chainStr.toLowerCase(),
      );
      res.json({
        threats,
        count: threats.length,
        timestamp: Date.now(),
      });
    });

    // =========================================================================
    // Dashboard Endpoints
    // =========================================================================

    // Scout Logs
    this.app.get("/api/dashboard/scout-logs", (req: Request, res: Response) => {
      const limitParam = req.query.limit;
      const limit =
        parseInt(typeof limitParam === "string" ? limitParam : "100") || 100;
      const logs = dashboardState.getLogs(limit);
      res.json({
        logs,
        count: logs.length,
        timestamp: Date.now(),
      });
    });

    // Executions
    this.app.get("/api/dashboard/executions", (req: Request, res: Response) => {
      const limitParam = req.query.limit;
      const limit =
        parseInt(typeof limitParam === "string" ? limitParam : "50") || 50;
      const executions = dashboardState.getExecutions(limit);
      res.json({
        executions,
        count: executions.length,
        timestamp: Date.now(),
      });
    });

    // Risk Scores + Hysteresis
    this.app.get(
      "/api/dashboard/risk-scores",
      (req: Request, res: Response) => {
        res.json({
          current: dashboardState.getRiskScore(),
          hysteresisHistory: dashboardState.getHysteresisHistory(),
          timestamp: Date.now(),
        });
      },
    );

    // Yellow Channel State
    this.app.get(
      "/api/dashboard/yellow-channels",
      (req: Request, res: Response) => {
        res.json({
          ...dashboardState.getYellowChannelState(),
          timestamp: Date.now(),
        });
      },
    );

    // Gas History (for graphs)
    this.app.get(
      "/api/dashboard/gas-history",
      (req: Request, res: Response) => {
        const chain = req.query.chain as string | undefined;
        const history = dashboardState.getGasHistory(chain);
        res.json({
          history,
          count: history.length,
          timestamp: Date.now(),
        });
      },
    );

    // Price History (for graphs)
    this.app.get(
      "/api/dashboard/price-history",
      (req: Request, res: Response) => {
        const pair = req.query.pair as string | undefined;
        const history = dashboardState.getPriceHistory(pair);
        res.json({
          history,
          count: history.length,
          timestamp: Date.now(),
        });
      },
    );

    // E2E Flows
    this.app.get("/api/dashboard/e2e-flows", (req: Request, res: Response) => {
      const flows = dashboardState.getE2EFlows();
      res.json({
        flows,
        count: flows.length,
        timestamp: Date.now(),
      });
    });

    // Full Snapshot
    this.app.get("/api/dashboard/snapshot", (req: Request, res: Response) => {
      res.json(dashboardState.getSnapshot());
    });

    // =========================================================================
    // Attack Simulation
    // =========================================================================

    this.app.post(
      "/api/dashboard/simulate-attack",
      async (req: Request, res: Response) => {
        try {
          const { type, targetPool, chain, intensity } =
            req.body as AttackSimulationRequest;

          if (!type || !targetPool || !chain) {
            res.status(400).json({
              error: "Missing required fields: type, targetPool, chain",
            });
            return;
          }

          const validTypes = [
            "SANDWICH",
            "ORACLE_MANIPULATION",
            "FLASH_LOAN",
            "CROSS_CHAIN",
            "JIT_LIQUIDITY",
            "FRONTRUN",
            "TOXIC_ARBITRAGE",
          ];
          if (!validTypes.includes(type)) {
            res.status(400).json({
              error: `Invalid attack type. Valid types: ${validTypes.join(", ")}`,
            });
            return;
          }

          const result = await attackSimulator.simulate({
            type,
            targetPool,
            chain,
            intensity,
          });

          res.json(result);
        } catch (error) {
          console.error("Attack simulation error:", error);
          res.status(500).json({
            error: "Simulation failed",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      },
    );

    // =========================================================================
    // Yellow Signatures API
    // =========================================================================

    this.app.get("/api/signatures/:poolId", (req: Request, res: Response) => {
      const poolIdParam = req.params.poolId;
      const poolId = Array.isArray(poolIdParam) ? poolIdParam[0] : poolIdParam;
      const signature = this.signatureCache.get(poolId);

      if (!signature) {
        res.json({
          hasSignature: false,
          poolId,
          message: "No active protection signature for this pool",
          timestamp: Date.now(),
        });
        return;
      }

      // Check expiry
      const currentBlock = Math.floor(Date.now() / 12000); // Approximate block
      if (signature.expiryBlock < currentBlock) {
        this.signatureCache.delete(poolId);
        res.json({
          hasSignature: false,
          poolId,
          message: "Protection signature has expired",
          timestamp: Date.now(),
        });
        return;
      }

      res.json({
        hasSignature: true,
        poolId,
        action: signature.action,
        fee: signature.fee,
        expiryBlock: signature.expiryBlock,
        timestamp: signature.timestamp,
        signature: signature.signature,
        signer: signature.signer,
        retrievedAt: Date.now(),
      });
    });

    // List all active signatures
    this.app.get("/api/signatures", (req: Request, res: Response) => {
      const currentBlock = Math.floor(Date.now() / 12000);
      const signatures: SignatureCache[] = [];

      for (const [poolId, sig] of this.signatureCache.entries()) {
        if (sig.expiryBlock >= currentBlock) {
          signatures.push(sig);
        }
      }

      res.json({
        signatures,
        count: signatures.length,
        timestamp: Date.now(),
      });
    });

    // =========================================================================
    // Yellow Session Management API
    // =========================================================================

    // Start a new Yellow session (on-demand)
    this.app.post("/api/yellow/session/start", async (req: Request, res: Response) => {
      try {
        if (!this.yellowMessageBus) {
          res.status(503).json({
            error: "Yellow MessageBus not initialized",
            message: "Agent is not connected to Yellow Network"
          });
          return;
        }

        if (this.yellowMessageBus.isActive()) {
          res.status(400).json({
            error: "Session already active",
            sessionId: this.yellowMessageBus.getSessionId(),
            message: "End the current session before starting a new one"
          });
          return;
        }

        const { depositAmount } = req.body;
        const deposit = depositAmount || '5'; // Default 5 ytest.usd

        console.log(`🟡 API: Starting Yellow session with ${deposit} ytest.usd deposit...`);
        const sessionId = await this.yellowMessageBus.startSession(deposit);

        // Update dashboard state
        dashboardState.updateYellowChannel({
          connected: true,
          sessionId,
          sessionStartTime: Date.now(),
          sessionBalance: deposit,
          microFeesAccrued: '0.000',
          stateVersion: 1,
          totalActions: 0,
        });

        res.json({
          success: true,
          sessionId,
          deposit,
          message: "Yellow session started successfully",
          timestamp: Date.now()
        });
      } catch (error) {
        console.error("Failed to start Yellow session:", error);
        res.status(500).json({
          error: "Session start failed",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    // End the current Yellow session
    this.app.post("/api/yellow/session/end", async (req: Request, res: Response) => {
      try {
        if (!this.yellowMessageBus) {
          res.status(503).json({
            error: "Yellow MessageBus not initialized"
          });
          return;
        }

        if (!this.yellowMessageBus.isActive()) {
          res.status(400).json({
            error: "No active session",
            message: "There is no Yellow session to end"
          });
          return;
        }

        const sessionId = this.yellowMessageBus.getSessionId();
        const summary = this.yellowMessageBus.getSummary();

        console.log(`🟡 API: Ending Yellow session ${sessionId?.slice(0, 12)}...`);
        const receipt = await this.yellowMessageBus.endSession();

        // Update dashboard state
        dashboardState.updateYellowChannel({
          connected: true,
          sessionId: null,
          sessionStartTime: null,
          sessionBalance: '0.000',
        });

        res.json({
          success: true,
          sessionId,
          summary: {
            messages: summary.totalMessages,
            microFeesEarned: receipt.sentinelReward || summary.microFeesAccrued,
            duration: receipt.duration || 0
          },
          message: "Yellow session ended and settled",
          timestamp: Date.now()
        });
      } catch (error) {
        console.error("Failed to end Yellow session:", error);
        res.status(500).json({
          error: "Session end failed",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    // Get current Yellow session status
    this.app.get("/api/yellow/session/status", (req: Request, res: Response) => {
      if (!this.yellowMessageBus) {
        res.json({
          connected: false,
          hasActiveSession: false,
          message: "Yellow MessageBus not initialized"
        });
        return;
      }

      const isActive = this.yellowMessageBus.isActive();
      const sessionId = this.yellowMessageBus.getSessionId();

      if (isActive && sessionId) {
        const summary = this.yellowMessageBus.getSummary();
        const stats = this.yellowMessageBus.getSessionStats();
        
        res.json({
          connected: this.yellowMessageBus.isConnected(),
          hasActiveSession: true,
          sessionId,
          summary: {
            signalCount: summary.signalCount,
            alertCount: summary.alertCount,
            decisionCount: summary.decisionCount,
            executionCount: summary.executionCount,
            totalMessages: summary.totalMessages,
            microFeesAccrued: summary.microFeesAccrued,
            stateVersion: summary.version
          },
          stats,
          timestamp: Date.now()
        });
      } else {
        res.json({
          connected: this.yellowMessageBus.isConnected(),
          hasActiveSession: false,
          sessionId: null,
          message: "No active Yellow session. Use POST /api/yellow/session/start to create one.",
          timestamp: Date.now()
        });
      }
    });

    // =========================================================================
    // 404 Handler
    // =========================================================================

    this.app.use((req: Request, res: Response) => {
      res.status(404).json({ error: "Not found" });
    });
  }

  private setupWebSocket(): void {
    this.io.on("connection", (socket: Socket) => {
      console.log(`🔌 Dashboard client connected: ${socket.id}`);

      // Send initial snapshot
      socket.emit("snapshot", dashboardState.getSnapshot());

      socket.on("disconnect", () => {
        console.log(`🔌 Dashboard client disconnected: ${socket.id}`);
      });
    });
  }

  private setupDashboardEvents(): void {
    // Forward dashboard events to WebSocket clients
    dashboardState.on("log", (entry: DashboardLogEntry) => {
      this.io.emit("log", entry);
    });

    dashboardState.on("riskUpdate", (data: { score: number; tier: string }) => {
      this.io.emit("riskUpdate", data);
    });

    dashboardState.on("execution", (entry: any) => {
      this.io.emit("execution", entry);
    });

    dashboardState.on("executionUpdate", (entry: any) => {
      this.io.emit("executionUpdate", entry);
    });

    dashboardState.on("gasUpdate", (point: GasDataPoint) => {
      this.io.emit("gasUpdate", point);
    });

    dashboardState.on("priceUpdate", (point: PriceDataPoint) => {
      this.io.emit("priceUpdate", point);
    });

    dashboardState.on("yellowUpdate", (state: any) => {
      this.io.emit("yellowUpdate", state);
    });

    // Forward E2E flow events to WebSocket clients
    dashboardState.on("flowStarted", (flow: any) => {
      this.io.emit("flowStarted", flow);
    });

    dashboardState.on("flowUpdated", (flow: any) => {
      this.io.emit("flowUpdated", flow);
    });

    dashboardState.on("flowCompleted", (flow: any) => {
      this.io.emit("flowCompleted", flow);
    });

    dashboardState.on("flowFailed", (data: any) => {
      this.io.emit("flowFailed", data);
    });
  }

  // =========================================================================
  // Public Methods
  // =========================================================================

  /**
   * Add a threat to the cache (called by ExecutorAgent)
   */
  addThreat(broadcast: LPThreatBroadcast, txHash: string): void {
    const cached: CachedThreat = {
      ...broadcast,
      onChainTxHash: txHash,
      broadcastedAt: Date.now(),
    };

    this.threatCache.set(broadcast.id, cached);
    console.log(
      `📦 Cached threat ${broadcast.id} (cache size: ${this.threatCache.size})`,
    );
  }

  /**
   * Add a Yellow signature to the cache
   */
  addSignature(
    poolId: string,
    action: string,
    fee: number,
    expiryBlock: number,
    signature: string,
    signer: string,
  ): void {
    this.signatureCache.set(poolId, {
      poolId,
      action,
      fee,
      expiryBlock,
      timestamp: Date.now(),
      signature,
      signer,
    });

    dashboardState.setLastSignature(poolId, signature);
    console.log(`🔐 Cached signature for pool ${poolId.slice(0, 10)}...`);
  }

  /**
   * Get all active (non-expired) threats
   */
  private getActiveThreats(): LPThreatBroadcast[] {
    const now = Date.now();
    const active: LPThreatBroadcast[] = [];

    for (const [id, threat] of this.threatCache.entries()) {
      if (threat.expiresAt > now) {
        active.push(threat);
      }
    }

    return active;
  }

  /**
   * Clean up expired threats from cache
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let removed = 0;

    for (const [id, threat] of this.threatCache.entries()) {
      if (threat.expiresAt <= now) {
        this.threatCache.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(
        `🧹 Cleaned up ${removed} expired threats (cache size: ${this.threatCache.size})`,
      );
    }
  }

  /**
   * Start the API server on 0.0.0.0:3000
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      // Bind to 0.0.0.0 for all network interfaces
      this.httpServer.listen(this.config.port, "0.0.0.0", () => {
        console.log(
          `🌐 Dashboard API server listening on 0.0.0.0:${this.config.port}`,
        );
        console.log(`   REST Endpoints:`);
        console.log(`   - GET  /api/health`);
        console.log(`   - GET  /api/dashboard/status`);
        console.log(`   - GET  /api/dashboard/scout-logs`);
        console.log(`   - GET  /api/dashboard/executions`);
        console.log(`   - GET  /api/dashboard/risk-scores`);
        console.log(`   - GET  /api/dashboard/yellow-channels`);
        console.log(`   - GET  /api/dashboard/gas-history`);
        console.log(`   - GET  /api/dashboard/price-history`);
        console.log(`   - GET  /api/dashboard/snapshot`);
        console.log(`   - POST /api/dashboard/simulate-attack`);
        console.log(`   - GET  /api/signatures/:poolId`);
        console.log(`   - GET  /api/signatures`);
        console.log(`   - GET  /api/threats`);
        console.log(`   - POST /api/yellow/session/start  (🆕 On-demand session)`);
        console.log(`   - POST /api/yellow/session/end    (🆕 On-demand session)`);
        console.log(`   - GET  /api/yellow/session/status (🆕 On-demand session)`);
        console.log(`   WebSocket: ws://0.0.0.0:${this.config.port}`);

        // Start dashboard state
        dashboardState.start();

        // Start cleanup interval
        this.cleanupInterval = setInterval(
          () => this.cleanupExpired(),
          60000, // Clean every minute
        );

        resolve();
      });
    });
  }

  /**
   * Inject Yellow MessageBus for session management
   */
  setYellowMessageBus(yellowMessageBus: YellowMessageBus): void {
    this.yellowMessageBus = yellowMessageBus;
    console.log("🟡 ThreatAPIServer: Yellow MessageBus injected for session management");
  }

  /**
   * Stop the API server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }

      dashboardState.stop();

      this.io.close(() => {
        this.httpServer.close(() => {
          console.log("🛑 Dashboard API server stopped");
          resolve();
        });
      });
    });
  }
}
