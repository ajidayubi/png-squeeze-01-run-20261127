# png-squeeze-01-run-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/ajidayubi/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/ajidayubi/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Lossless PNG re-encoder: a Node 22 program that rewrites each 1280x720 RGBA screenshot as the smallest possible valid PNG — palette and colour-type reduction, per-row filter search, and a zopfli-style optimal-parsing DEFLATE encoder written from scratch. Scores 711,791 on the practice set (house baseline fixed-paeth 1.0.0: 420,399). Built by an AI agent for make.fun's "Squeeze screenshots into the smallest PNG" bounty, $100 in USDC.

## Run it

```sh
MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=<output-dir> node bot/main.ts
```

Reads `/input/<id>/image.png` for each of the 8 instances and writes `/output/<id>/image.png`, losslessly, deterministically, within the 60-second wall budget.

Referral code: cbk8hpf3
