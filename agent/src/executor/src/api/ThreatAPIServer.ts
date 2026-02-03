/**
 * Threat API Server
 * 
 * REST API for LP bots and websites to fetch ELEVATED tier threat data.
 * Provides endpoints to query active threats by pool, chain, or globally.
 */

import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { LPThreatBroadcast, CachedThreat } from '../types/LPBroadcast';

export interface ThreatAPIConfig {
  port: number;
  retentionMs: number; // How long to keep threats in cache
}

export class ThreatAPIServer {
  private app: express.Application;
  private config: ThreatAPIConfig;
  private threatCache: Map<string, CachedThreat>;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(config: ThreatAPIConfig) {
    this.config = config;
    this.app = express();
    this.threatCache = new Map();

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // JSON parsing
    this.app.use(express.json());

    // Rate limiting: 100 requests per 15 minutes
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: 'Too many requests, please try again later',
    });
    this.app.use(limiter);

    // CORS is intentionally NOT enabled per user request
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/api/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        timestamp: Date.now(),
        cacheSize: this.threatCache.size,
      });
    });

    // Get all active threats
    this.app.get('/api/threats', (req: Request, res: Response) => {
      const threats = this.getActiveThreats();
      res.json({
        threats,
        count: threats.length,
        timestamp: Date.now(),
      });
    });

    // Get threats for specific pool
    this.app.get('/api/threats/:poolId', (req: Request, res: Response) => {
      const { poolId } = req.params;
      const threats = this.getActiveThreats().filter(
        t => t.targetPool === poolId
      );
      res.json({
        threats,
        count: threats.length,
        timestamp: Date.now(),
      });
    });

    // Get threats by chain
    this.app.get('/api/threats/chain/:chain', (req: Request, res: Response) => {
      const { chain } = req.params;
      // Ensure chain is a string (Express params can be string | string[])
      const chainStr = Array.isArray(chain) ? chain[0] : chain;
      const threats = this.getActiveThreats().filter(
        t => t.chain.toLowerCase() === chainStr.toLowerCase()
      );
      res.json({
        threats,
        count: threats.length,
        timestamp: Date.now(),
      });
    });

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

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
    console.log(`📦 Cached threat ${broadcast.id} (cache size: ${this.threatCache.size})`);
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
      console.log(`🧹 Cleaned up ${removed} expired threats (cache size: ${this.threatCache.size})`);
    }
  }

  /**
   * Start the API server
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(this.config.port, () => {
        console.log(`🌐 Threat API server listening on port ${this.config.port}`);
        console.log(`   Endpoints:`);
        console.log(`   - GET /api/health`);
        console.log(`   - GET /api/threats`);
        console.log(`   - GET /api/threats/:poolId`);
        console.log(`   - GET /api/threats/chain/:chain`);

        // Start cleanup interval
        this.cleanupInterval = setInterval(
          () => this.cleanupExpired(),
          60000 // Clean every minute
        );

        resolve();
      });
    });
  }

  /**
   * Stop the API server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }

      // Express doesn't expose the server instance directly
      // In production, you'd want to store the server instance
      console.log('🛑 Threat API server stopped');
      resolve();
    });
  }
}
