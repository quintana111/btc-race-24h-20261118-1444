/**
 * Strategy: RFMOB-24 TUNED
 * Competition: btc-race-24h-20261118-1444
 * Regime-filtered momentum + oversold bounce, long only, $1,000 paper.
 * Tuned parameters:
 * - momBps 60
 * - tpBps 160
 * - stopBps 80
 * - trailBps 80
 * - revBps -60
 * - maxHold 480
 * - cool 10
 * - filterBps -80
 * - bounceEntryBps -80
 * - bounceTpBps 120
 * - bounceStopBps 60
 * - bounceSize 0.7
 * - bounceHold 60
 * - bounceCool 20
 * - hard stop 12% from peak equity
 *
 * Local dev grade (real harness, frozen 24h dev window, BTC $65,083 -> $63,261):
 * net PnL +18.955711 USDC, 4 trades, win rate 1.000, max drawdown 0.008773,
 * fees 1.373367 USDC, net PnL at 2x fees +17.570970 USDC. Guardrails met.
 * Neighbourhood on the real harness: momentum TP 1.40% -> +17.258523 USDC,
 * TP 1.80% -> +22.053378 USDC; TP 1.60% kept as the middle of the plateau.
 */

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

type Mode = 'momentum' | 'bounce';

interface PendingEntry {
  mode: Mode;
  entryClose: bigint;
  entrySeq: number;
}

interface ActiveEntry extends PendingEntry {
  peakClose: bigint;
  trailActive: boolean;
}

const closes: (bigint | null)[] = [];
let peakEquity = 0n;
let pendingEntry: PendingEntry | null = null;
let activeEntry: ActiveEntry | null = null;
let cooldownUntilSeq = 0;
let stoppedForever = false;

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const seq = batch.seq;
  const close = state.close(SYMBOL);
  closes[seq] = close;

  if (state.equity > peakEquity) {
    peakEquity = state.equity;
  }

  if (stoppedForever) {
    return [];
  }

  if (state.equity * 100n <= peakEquity * 88n) {
    stoppedForever = true;
    pendingEntry = null;
    activeEntry = null;
    if (close !== null && !state.warmingUp) {
      const position = state.positions.get(SYMBOL);
      if (position && position.qty > 0n) {
        return [{
          side: 'sell',
          symbol: SYMBOL,
          qty: position.qty,
          max_slippage_bps: 500,
        }];
      }
    }
    return [];
  }

  if (state.warmingUp) {
    return [];
  }

  if (close === null) {
    return [];
  }

  const position = state.positions.get(SYMBOL);
  const holding = position !== undefined && position.qty > 0n;

  if (holding) {
    if (pendingEntry && !activeEntry) {
      activeEntry = {
        mode: pendingEntry.mode,
        entryClose: pendingEntry.entryClose,
        entrySeq: pendingEntry.entrySeq,
        peakClose: pendingEntry.entryClose,
        trailActive: false,
      };
      pendingEntry = null;
    }
  } else {
    if (activeEntry) {
      activeEntry = null;
    }
    if (pendingEntry && seq > pendingEntry.entrySeq) {
      pendingEntry = null;
    }
  }

  if (holding && activeEntry) {
    const qty = position!.qty;
    const entry = activeEntry;
    let shouldSell = false;

    if (entry.mode === 'momentum') {
      if (close * 10000n >= entry.entryClose * 10080n) {
        entry.trailActive = true;
      }
      if (close > entry.peakClose) {
        entry.peakClose = close;
      }

      if (close * 10000n >= entry.entryClose * 10160n) {
        shouldSell = true;
      }
      if (close * 10000n <= entry.entryClose * 9920n) {
        shouldSell = true;
      }
      if (entry.trailActive && close * 10000n <= entry.peakClose * 9920n) {
        shouldSell = true;
      }
      const c10 = closes[seq - 10];
      if (c10 != null && close * 10000n <= c10 * 9940n) {
        shouldSell = true;
      }
      if (seq - entry.entrySeq >= 480) {
        shouldSell = true;
      }
    } else {
      if (close * 10000n >= entry.entryClose * 10120n) {
        shouldSell = true;
      }
      if (close * 10000n <= entry.entryClose * 9940n) {
        shouldSell = true;
      }
      if (seq - entry.entrySeq >= 60) {
        shouldSell = true;
      }
    }

    if (shouldSell) {
      // Keep activeEntry: if this sell is rejected (e.g. max_slippage on a
      // gap), the position is still held next bar and the exit is
      // re-evaluated; when the fill lands the position disappears and the
      // not-holding branch clears the entry.
      cooldownUntilSeq = seq + (entry.mode === 'momentum' ? 10 : 20);
      pendingEntry = null;
      return [{
        side: 'sell',
        symbol: SYMBOL,
        qty,
        max_slippage_bps: 500,
      }];
    }

    return [];
  }

  if (holding) {
    return [];
  }

  if (seq < cooldownUntilSeq) {
    return [];
  }

  if (pendingEntry) {
    return [];
  }

  if (seq < 60) {
    return [];
  }

  const c5 = closes[seq - 5];
  const c10 = closes[seq - 10];
  const c60 = closes[seq - 60];
  if (c5 == null || c10 == null || c60 == null) {
    return [];
  }

  let sum60 = 0n;
  for (let i = seq - 59; i <= seq; i++) {
    const c = closes[i];
    if (c == null) {
      return [];
    }
    sum60 += c;
  }

  const downtrend = (close * 10000n <= c60 * 9920n) && (close * 60n < sum60);
  const cash = state.cash;
  const minNotional = state.hello.fees.min_notional_quote_units;

  if (!downtrend) {
    if (close * 10000n >= c10 * 10060n) {
      if (cash > 0n && cash >= minNotional) {
        pendingEntry = { mode: 'momentum', entryClose: close, entrySeq: seq };
        return [{
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: cash,
          max_slippage_bps: 500,
        }];
      }
    }
  } else {
    const prevClose = closes[seq - 1];
    if (prevClose != null && close * 10000n <= c5 * 9920n && close > prevClose) {
      const notional = cash * 70n / 100n;
      if (cash > 0n && notional >= minNotional && notional > 0n) {
        pendingEntry = { mode: 'bounce', entryClose: close, entrySeq: seq };
        return [{
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: 500,
        }];
      }
    }
  }

  return [];
}

await runBars({ onBatch });
