import { JsonRpcProvider, Transaction } from 'ethers';
import { RBB_NONCE_SOURCE } from './signed-response.mjs';

export class RetryProvider extends JsonRpcProvider {
  constructor(url = process.env.RBB_RPC_URL || RBB_NONCE_SOURCE.rpcUrl, { attempts = 12, fetcher = globalThis.fetch } = {}) {
    super(url, undefined, { batchMaxCount: 1, cacheTimeout: -1, staticNetwork: true });
    this.rpcUrl = url;
    this.attempts = attempts;
    this.rpcFetch = fetcher;
  }

  async _send(payload) {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.rpcFetch(this.rpcUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          redirect: 'error', signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        return Array.isArray(result) ? result : [result];
      } catch (error) {
        if (attempt >= this.attempts) throw new Error('RPC da RBB indisponível após ' + attempt + ' tentativas (' + error.message + ').');
        await new Promise(resolve => setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt)));
      }
    }
  }

  async broadcastTransaction(signed) {
    const hash = Transaction.from(signed).hash;
    try { return await super.broadcastTransaction(signed); }
    catch (error) {
      const known = await this.getTransaction(hash).catch(() => null);
      if (known) return known;
      throw error;
    }
  }
}
