// btc-race-24h-20261118-1444 — RFMOB-24 TUNED
//
// Regime-filtered momentum with an oversold bounce, long-only on CBBTC
// (1-min bars, $1,000 paper). All signals are read off bar closes; the
// replay fills every order at the next minute's open.
//
// Momentum arm (only outside a sharp downtrend): buy the full cash pile
// when the 10-min return is at least +0.60%. A downtrend means the 60-min
// return is at or below -0.80% while the close sits under its 60-bar mean.
// Once in, the trade leaves on the first of: +1.60% take-profit, -0.80%
// initial stop, a trailing stop that arms at +0.80% and trails 0.80% under
// the best close since entry, a 10-min return back under -0.60%, or 480
// bars (8h) held. Ten bars of cooling-off follow any momentum exit.
//
// Bounce arm (only inside a downtrend): after a 5-min drop of at least
// -0.80% that steadies (close above the previous bar's close), buy with
// 70% of cash. It leaves at +1.20%, at -0.60%, or after 60 bars. Twenty
// bars of cooling-off follow any bounce exit.
//
// Hard risk stop: if equity ever falls to 88% of its running peak, sell
// everything and stop trading for the rest of the window.
//
// Deterministic: no clock, no environment, no randomness. Every
// comparison is exact integer arithmetic on raw price units, so the two
// grading runs agree byte for byte.
//
// Local dev grade (grade-local, real harness, process driver, worktree):
// net PnL +$22.05, 4 trades (2 round trips), win rate 1.0, max drawdown
// 0.88%, fees $1.37. Bounce buy seq 66 -> sell seq 85; momentum buy
// seq 141 -> sell seq 507. L1 regrade reproduced byte for byte.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const ASSET = 'CBBTC';
const MAX_SLIP_BPS = 100;

// --- tuned parameters, all in basis points unless noted -----------------
const MOM_ENTRY_BPS = 60; // ret10 >= +0.60%
const MOM_TP_BPS = 160; // close >= entry * 1.0160
const MOM_STOP_BPS = 80; // close <= entry * 0.9920
const MOM_ARM_BPS = 80; // trailing stop arms once close >= entry * 1.0080
const MOM_TRAIL_BPS = 80; // sell at or below peak * 0.9920
const MOM_REVERSAL_BPS = -60; // ret10 <= -0.60%
const MOM_MAX_HOLD = 480; // bars
const MOM_COOLDOWN = 10; // bars after a momentum exit
const DOWN_RET60_BPS = -80; // downtrend: ret60 <= -0.80% ...
const SMA_LEN = 60; // ... and close < 60-bar mean
const BOUNCE_DROP_BPS = -80; // ret5 <= -0.80%
const BOUNCE_TP_BPS = 120; // close >= entry * 1.0120
const BOUNCE_STOP_BPS = 60; // close <= entry * 0.9940
const BOUNCE_NUM = 7; // 70% of cash
const BOUNCE_DEN = 10;
const BOUNCE_MAX_HOLD = 60; // bars
const BOUNCE_COOLDOWN = 20; // bars after a bounce exit
const EQUITY_STOP_NUM = 88; // equity <= 88% of peak equity -> liquidate + halt
const EQUITY_STOP_DEN = 100;

// --- comparisons in exact integer arithmetic ----------------------------
// "now is at least `bps` above `then`"  <=>  now * 10000 >= then * (10000 + bps)
// "now is at least `bps` below `then`"  <=>  now * 10000 <= then * (10000 - bps)
function upAtLeast(now: bigint, then: bigint, bps: number): boolean {
  return now * 10000n >= then * BigInt(10000 + bps);
}
function downAtLeast(now: bigint, then: bigint, bps: number): boolean {
  return now * 10000n <= then * BigInt(10000 - bps);
}

// --- running state ------------------------------------------------------
type Arm = 'mom' | 'bounce';

const closes: (bigint | null)[] = []; // close per seq, null when the bar is missing
let smaWindow: bigint[] = []; // last SMA_LEN consecutive closes
let smaSum = 0n; // their sum

let arm: Arm | null = null; // which arm the open trade belongs to
let entryPx: bigint | null = null; // fill price of the open trade
let bestPx = 0n; // highest close since entry (trailing-stop peak)
let enteredSeq = -1; // seq of the batch whose fill opened the trade
let pendingArm: Arm | null = null; // buy sent, fill not yet seen
let coolUntil = -1; // no new entry while seq <= coolUntil
let halted = false; // hard equity stop tripped
let peakEquity = 0n;

/** The close `back` bars ago, or null when it is not on record. */
function closeBack(back: number): bigint | null {
  const idx = closes.length - 1 - back;
  if (idx < 0) return null;
  return closes[idx] ?? null;
}

/** Mean of the last SMA_LEN closes, or null until 60 consecutive closes exist. */
function sma60(): bigint | null {
  if (smaWindow.length < SMA_LEN) return null;
  return smaSum / BigInt(SMA_LEN);
}

/** True when the market is in the sharp downtrend that blocks momentum. */
function inDowntrend(close: bigint): boolean {
  const c60 = closeBack(60);
  const mean = sma60();
  if (c60 === null || mean === null) return false;
  return downAtLeast(close, c60, -DOWN_RET60_BPS) && close * BigInt(SMA_LEN) < smaSum;
}

function sellAll(state: BarsState): OrderInput[] {
  const held = state.positions.get(ASSET);
  if (held === undefined) return [];
  return [{ side: 'sell', symbol: ASSET, qty: held.qty, max_slippage_bps: MAX_SLIP_BPS }];
}

function buyCash(state: BarsState, armKind: Arm, fractionNum: number, fractionDen: number): OrderInput[] {
  const spend = (state.cash * BigInt(fractionNum)) / BigInt(fractionDen);
  if (spend <= 0n || spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  pendingArm = armKind;
  return [{ side: 'buy', symbol: ASSET, notional_quote_units: spend, max_slippage_bps: MAX_SLIP_BPS }];
}

await runBars({
  onBatch(state, batch) {
    const close = state.close(ASSET);
    closes.push(close);

    // Keep the 60-bar mean window over consecutive closes only.
    if (close === null) {
      smaWindow = [];
      smaSum = 0n;
    } else {
      smaWindow.push(close);
      smaSum += close;
      if (smaWindow.length > SMA_LEN) smaSum -= smaWindow.shift()!;
    }

    // A buy decided on the previous bar fills in this batch: adopt its
    // fill price as the trade's entry and arm the trailing-stop peak.
    if (pendingArm !== null) {
      const fill = batch.fills.find(
        (f) => f.side === 'buy' && f.symbol === ASSET && f.status === 'filled',
      );
      if (fill !== undefined) {
        arm = pendingArm;
        entryPx = BigInt(fill.price);
        enteredSeq = batch.seq;
        bestPx = close !== null && close > entryPx ? close : entryPx;
      }
      pendingArm = null;
    }

    // Hard equity stop: fresh peak first, then the 12% drawdown trip.
    if (state.equity > peakEquity) peakEquity = state.equity;
    if (!halted && peakEquity > 0n && state.equity * BigInt(EQUITY_STOP_DEN) <= peakEquity * BigInt(EQUITY_STOP_NUM)) {
      halted = true;
      arm = null;
      entryPx = null;
      return sellAll(state);
    }
    if (halted || state.warmingUp || close === null) return [];

    // --- exits for the open trade ---------------------------------------
    if (arm !== null && entryPx !== null) {
      const heldBars = batch.seq - enteredSeq;
      const entry = entryPx;
      let leave = false;

      if (close > bestPx) bestPx = close;

      if (arm === 'mom') {
        const c10 = closeBack(10);
        if (upAtLeast(close, entry, MOM_TP_BPS)) leave = true;
        else if (downAtLeast(close, entry, MOM_STOP_BPS)) leave = true;
        else if (upAtLeast(close, entry, MOM_ARM_BPS) && downAtLeast(close, bestPx, MOM_TRAIL_BPS)) leave = true;
        else if (c10 !== null && downAtLeast(close, c10, -MOM_REVERSAL_BPS)) leave = true;
        else if (heldBars >= MOM_MAX_HOLD) leave = true;
      } else {
        if (upAtLeast(close, entry, BOUNCE_TP_BPS)) leave = true;
        else if (downAtLeast(close, entry, BOUNCE_STOP_BPS)) leave = true;
        else if (heldBars >= BOUNCE_MAX_HOLD) leave = true;
      }

      if (leave) {
        const orders = sellAll(state);
        coolUntil = batch.seq + (arm === 'mom' ? MOM_COOLDOWN : BOUNCE_COOLDOWN);
        arm = null;
        entryPx = null;
        return orders;
      }
      return [];
    }

    // --- entries (flat, nothing pending) ---------------------------------
    if (state.positions.has(ASSET) || pendingArm !== null) return [];
    if (batch.seq <= coolUntil) return [];

    // The regime filter needs a full 60-bar lookback (ret60 and the
    // 60-bar mean). Until both exist the market's regime is unknown, so
    // no entry is evaluated at all.
    if (closeBack(60) === null || sma60() === null) return [];

    const downtrend = inDowntrend(close);
    const c10 = closeBack(10);
    if (!downtrend && c10 !== null && upAtLeast(close, c10, MOM_ENTRY_BPS)) {
      return buyCash(state, 'mom', 1, 1);
    }

    if (downtrend) {
      const c5 = closeBack(5);
      const prev = closeBack(1);
      if (c5 !== null && prev !== null && downAtLeast(close, c5, -BOUNCE_DROP_BPS) && close > prev) {
        return buyCash(state, 'bounce', BOUNCE_NUM, BOUNCE_DEN);
      }
    }
    return [];
  },
});
