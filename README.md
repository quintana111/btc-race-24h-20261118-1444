[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/quintana111/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/quintana111/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

# btc-race-24h-20261118-1444 — RFMOB-24 TUNED

Bot for the make.fun competition `btc-race-24h-20261118-1444`: trades Coinbase
Wrapped BTC (cbBTC) on 1-minute Orca Whirlpool bars, $1,000 paper, long only,
orders fill at the next bar's open. Protocol `agent-fun/bars-replay/v1`
(Node 22, erasable TypeScript, `main.ts` at the repo root, SDK vendored
byte-identical at `vendor/makefun-bars.ts`).

## Strategy: regime-filtered momentum + oversold bounce

All signals are evaluated on bar closes with exact bigint cross-multiplication
(no floats). `retN` is the N-bar return, `SMA60` the mean of the last 60 closes.

- **Downtrend** = `ret60 <= -0.80%` AND `close < SMA60`.
- **Momentum** (only when NOT in a downtrend): entry when `ret10 >= +0.60%`,
  full cash. Exits: TP `+1.60%`, initial stop `-0.80%`, trailing stop
  `-0.80%` from the peak once price is `+0.80%` above entry, reversal
  `ret10 <= -0.60%`, max hold 480 bars (8h). Cooldown 10 bars after any exit.
- **Bounce** (only in a downtrend): entry when `ret5 <= -0.80%` AND
  `close > previous close` (stabilization), 70% of cash. Exits: TP `+1.20%`,
  stop `-0.60%`, max hold 60 bars. Cooldown 20 bars after exit.
- **Hard risk stop**: if equity falls to `88%` of peak equity, liquidate and
  stop trading for the rest of the window.

Parameters: momBps 60, tpBps 160, stopBps 80, trailBps 80, revBps -60,
maxHold 480, cool 10, filterBps -80, bounceEntryBps -80, bounceTpBps 120,
bounceStopBps 60, bounceSize 0.7, bounceHold 60, bounceCool 20.

## Local grade (real harness, frozen 24h dev window)

Dev window is a falling day (BTC $65,083 -> $63,261, -2.80%); buy-and-hold
loses about $30.50.

- **Net PnL: +18.955711 USDC** (return +1.90%)
- Trades: 4, win rate 1.000, max drawdown 0.008773, exposure 0.2606
- Fees: 1.373367 USDC; net PnL at 2x fees: +17.570970 USDC
- 0 rejected orders; guardrails met; L1 regrade reproduced byte for byte

Neighbourhood on the real harness (momentum TP only): TP 1.40% ->
+17.258523 USDC; TP 1.80% -> +22.053378 USDC. TP 1.60% is kept as the
middle of the profitable plateau, not the dev-maximum edge.

## Reproduce

From the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```
