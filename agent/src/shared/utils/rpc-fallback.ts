/**
 * RPC Fallback Provider
 * 
 * Automatically switches between Alchemy and Ankr RPCs when rate limits are hit.
 * Implements retry logic for 429 (rate limit) errors.
 */

import { ethers } from 'ethers';

export interface RpcConfig {
  primary: string;
  fallback?: string;
  publicRpc?: string;
}

/**
 * Create a provider with automatic fallback on rate limit errors
 */
export function createFallbackProvider(config: RpcConfig): ethers.JsonRpcProvider {
  const { primary, fallback, publicRpc } = config;

  // Use primary provider with custom fetch that handles fallback
  const provider = new ethers.JsonRpcProvider(primary, undefined, {
    staticNetwork: true,
  });

  // Store fallback URLs for manual retry
  (provider as any)._fallbackUrl = fallback;
  (provider as any)._publicUrl = publicRpc;

  // Override send method to handle 429 errors
  const originalSend = provider.send.bind(provider);
  
  provider.send = async (method: string, params: any[]): Promise<any> => {
    try {
      return await originalSend(method, params);
    } catch (error: any) {
      // Check if it's a rate limit error (429)
      const is429 = 
        error?.info?.error?.code === 429 ||
        error?.code === 'CALL_EXCEPTION' ||
        error?.message?.includes('exceeded') ||
        error?.message?.includes('rate limit');

      if (is429 && fallback) {
        console.warn(`⚠️  Primary RPC rate limited, switching to fallback...`);
        
        // Try fallback provider
        try {
          const fallbackProvider = new ethers.JsonRpcProvider(fallback);
          return await fallbackProvider.send(method, params);
        } catch (fallbackError: any) {
          console.error('Fallback RPC also failed:', fallbackError.message);
          
          // Last resort: try public RPC if available
          if (publicRpc) {
            console.warn('⚠️  Trying public RPC as last resort...');
            const publicProvider = new ethers.JsonRpcProvider(publicRpc);
            return await publicProvider.send(method, params);
          }
        }
      }
      
      throw error;
    }
  };

  return provider;
}

/**
 * Create a provider with ethers FallbackProvider for automatic retry
 */
export function createMultiProvider(configs: RpcConfig[]): ethers.FallbackProvider {
  const providers = configs
    .filter(c => c.primary)
    .map((config, index) => {
      const provider = new ethers.JsonRpcProvider(config.primary);
      return {
        provider,
        priority: index + 1,
        stallTimeout: 2000, // 2 seconds timeout before trying next
        weight: 1,
      };
    });

  // Add fallback providers
  configs.forEach(config => {
    if (config.fallback) {
      providers.push({
        provider: new ethers.JsonRpcProvider(config.fallback),
        priority: providers.length + 1,
        stallTimeout: 2000,
        weight: 1,
      });
    }
  });

  return new ethers.FallbackProvider(providers);
}

/**
 * Retry wrapper for rate-limited calls
 */
export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 1000
): Promise<T> {
  let lastError: any;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      const is429 = 
        error?.info?.error?.code === 429 ||
        error?.code === 'CALL_EXCEPTION' ||
        error?.message?.includes('exceeded') ||
        error?.message?.includes('rate limit');

      if (is429 && i < maxRetries - 1) {
        const delay = delayMs * Math.pow(2, i); // Exponential backoff
        console.warn(`⚠️  RPC rate limited, retrying in ${delay}ms... (${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      break;
    }
  }
  
  throw lastError;
}
