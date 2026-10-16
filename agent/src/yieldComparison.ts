import type { RebalanceDecision } from './userStrategies';

export interface ProtocolYieldData {
  protocolId: string;
  name: string;
  type: 'blend' | 'dex_lp' | 'other';
  currentApy: number; // e.g. 0.085 for 8.5%
  historicalApy7d: number;
  historicalApy30d: number;
  tvlUsdc: number;
  volatility: number; // annualized volatility e.g. 0.02
  riskScore: number;  // 1-100 from risk scoring engine
}

export interface YieldOpportunity {
  protocolId: string;
  name: string;
  netApy: number;
  riskAdjustedScore: number;
  recommendedAllocationPercent: number;
}

export class YieldComparisonEngine {
  private readonly minImprovementThreshold: number;
  private readonly riskFreeRate: number;

  constructor(minImprovementThreshold = 0.005, riskFreeRate = 0.04) {
    this.minImprovementThreshold = minImprovementThreshold;
    this.riskFreeRate = riskFreeRate;
  }

  public calculateSharpeRatio(apy: number, volatility: number): number {
    if (volatility <= 0) return apy / 0.01;
    return (apy - this.riskFreeRate) / volatility;
  }

  public rankOpportunities(protocols: ProtocolYieldData[]): YieldOpportunity[] {
    const scored = protocols.map((p) => {
      const sharpe = this.calculateSharpeRatio(p.currentApy, p.volatility);
      // Risk-adjusted metric combines sharpe with inverse risk penalty
      const riskPenalty = (100 - p.riskScore) / 100;
      const riskAdjustedScore = sharpe * riskPenalty;

      return {
        protocolId: p.protocolId,
        name: p.name,
        netApy: p.currentApy,
        riskAdjustedScore: Math.round(riskAdjustedScore * 100) / 100,
        weight: Math.max(riskAdjustedScore, 0),
      };
    });

    const allocations = allocateByWeight(scored.map((row) => row.weight));
    return scored
      .map((row, index) => ({
        protocolId: row.protocolId,
        name: row.name,
        netApy: row.netApy,
        riskAdjustedScore: row.riskAdjustedScore,
        recommendedAllocationPercent: allocations[index] ?? 0,
      }))
      .sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);
  }

  /**
   * Rebalance when the improvement clears the threshold.
   *
   * When live protocol quotes are supplied, the target APY is taken from that
   * set (the highest net APY) instead of the caller-supplied number. An empty
   * quote list never rebalances.
   */
  public shouldRebalance(
    currentApy: number,
    targetApy: number,
    protocols?: ProtocolYieldData[],
  ): boolean {
    if (protocols) {
      if (protocols.length === 0) return false;
      const best = this.rankOpportunities(protocols)[0];
      if (!best) return false;
      return best.netApy - currentApy >= this.minImprovementThreshold;
    }
    return targetApy - currentApy >= this.minImprovementThreshold;
  }
}

/** Live venue the comparison engine can query for a current APY. */
export interface LiveApyAdapter {
  readonly protocolId: string;
  readonly name: string;
  /** Decimal APY, e.g. 0.085 for 8.5%, matching protocol adapter `getApy`. */
  getApy(ctx: LiveApyContext): Promise<number>;
}

export interface LiveApyContext {
  protocolId: string;
  contractId: string;
  asset: string;
  vaultAddress: string;
}

export interface LiveApyProfile {
  type: ProtocolYieldData['type'];
  historicalApy7d?: number;
  historicalApy30d?: number;
  tvlUsdc?: number;
  volatility?: number;
  riskScore?: number;
}

/**
 * Read current APYs from protocol adapters and shape them for allocation.
 * One adapter failure fails the ingest so callers do not rank a partial book.
 */
export async function ingestLiveApys(
  adapters: LiveApyAdapter[],
  contexts: LiveApyContext[],
  profiles: Record<string, LiveApyProfile> = {},
): Promise<ProtocolYieldData[]> {
  const quotes: ProtocolYieldData[] = [];

  for (const adapter of adapters) {
    const ctx = contexts.find((candidate) => candidate.protocolId === adapter.protocolId);
    if (!ctx) continue;

    const currentApy = await adapter.getApy(ctx);
    if (!Number.isFinite(currentApy) || currentApy < 0) {
      throw new Error(`invalid live APY for ${adapter.protocolId}`);
    }

    const profile = profiles[adapter.protocolId] ?? { type: 'other' };
    quotes.push({
      protocolId: adapter.protocolId,
      name: adapter.name,
      type: profile.type,
      currentApy,
      historicalApy7d: profile.historicalApy7d ?? currentApy,
      historicalApy30d: profile.historicalApy30d ?? currentApy,
      tvlUsdc: profile.tvlUsdc ?? 0,
      volatility: profile.volatility ?? 0,
      riskScore: profile.riskScore ?? 50,
    });
  }

  return quotes;
}

/** Percent weights from non-negative scores. They sum to 100 when any weight is positive. */
function allocateByWeight(weights: number[]): number[] {
  if (weights.length === 0) return [];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = total > 0
    ? weights.map((weight) => (weight / total) * 100)
    : weights.map(() => 100 / weights.length);
  const rounded = raw.map((value) => Math.round(value * 100) / 100);
  const drift = Math.round((100 - rounded.reduce((sum, value) => sum + value, 0)) * 100) / 100;
  if (drift !== 0) {
    let largest = 0;
    for (let i = 1; i < rounded.length; i++) {
      if (rounded[i] > rounded[largest]) largest = i;
    }
    rounded[largest] = Math.round((rounded[largest] + drift) * 100) / 100;
  }
  return rounded;
}

/** Minimum APY improvement, in percentage points, before a rebalance is proposed. */
export const MIN_REBALANCE_IMPROVEMENT_PCT = 0.5;

/** Offline fallback used only when the caller did not ingest adapter quotes. */
export async function fetchBlendApy(): Promise<number> {
  return 6.5;
}

/** Offline fallback used only when the caller did not ingest adapter quotes. */
export async function fetchDexApy(): Promise<number> {
  return 8.2;
}

/**
 * Decide whether to move funds for a given strategy (#467).
 *
 * APYs are in percent (e.g. 6.5), matching `rebalances.apy_after`.
 * Conservative strategies stay on Blend lending; balanced/growth may use the
 * DEX when it pays more. A rebalance is proposed only when the target
 * protocol differs and improves APY by more than 0.5 percentage points.
 * Fetch failures never trigger a rebalance.
 *
 * Restored after the class refactor dropped it while `index.ts` and
 * `eventListener.ts` still called it.
 */
export async function evaluateYield(
  strategy: string,
  currentProtocol: string,
  currentApy: number,
  liveProtocols?: ProtocolYieldData[],
): Promise<RebalanceDecision> {
  try {
    let blendApy: number;
    let dexApy: number;
    if (liveProtocols) {
      if (liveProtocols.length === 0) return { shouldRebalance: false };
      const blend = liveProtocols.find((protocol) => protocol.type === 'blend');
      const dex = liveProtocols.find((protocol) => protocol.type === 'dex_lp');
      // Adapter quotes are decimal fractions; this function compares percent points.
      blendApy = (blend?.currentApy ?? 0) * 100;
      dexApy = (dex?.currentApy ?? 0) * 100;
    } else {
      [blendApy, dexApy] = await Promise.all([fetchBlendApy(), fetchDexApy()]);
    }

    let targetProtocol = 'blend';
    let targetApy = blendApy;
    if (strategy !== 'conservative' && dexApy > blendApy) {
      targetProtocol = 'dex';
      targetApy = dexApy;
    }

    const improves = targetProtocol !== currentProtocol
      && targetApy - currentApy > MIN_REBALANCE_IMPROVEMENT_PCT;
    if (!improves) return { shouldRebalance: false };

    if (liveProtocols) {
      const engine = new YieldComparisonEngine();
      const eligible = targetProtocol === 'dex'
        ? liveProtocols.filter((protocol) => protocol.type === 'dex_lp')
        : liveProtocols.filter((protocol) => protocol.type === 'blend');
      if (!engine.shouldRebalance(currentApy / 100, targetApy / 100, eligible)) {
        return { shouldRebalance: false };
      }
    }

    return { shouldRebalance: true, targetProtocol };
  } catch {
    return { shouldRebalance: false };
  }
}
