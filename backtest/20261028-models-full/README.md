# 20261028-models-full — 阶段二全历史验证数据（换种子复验，种子 20261028）

与 [20261027-models-full](../20261027-models-full/README.md) 同法，仅换抽样种子（**20261028**）复验结论稳健性：B092/B223 依然稳定胜基线（配对胜率 62.5% / 57%），本口径重选 Top5 依然失效。详见 [20261027-models 实验文档](../20261027-models/README.md)。

- `samples.csv`、`report.json`：同 20261027-models-full 口径

复现：`node scripts/model-phase2.mjs 200 20261028 20261028-models-full`
