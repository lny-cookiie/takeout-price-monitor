# 本地脚本索引

这里的脚本用于开发验证、真机试点和文档图表生成，不是应用运行时的一部分。应用入口是 `src/main.ts`（`npm run dev` / `npm start`）。

所有真机脚本都需要 USB 连接测试手机、`.runtime/android-sources.json` 与采集服务进程，执行前先读 `前期调研/20_指定单品采集使用说明.md`。脚本只读取 `.runtime/` 下的数据库、证据和配置；凭证、手机号与精确地址不写入脚本或日志。

## 京东采集与真机试点

| 脚本 | 用途 |
|---|---|
| `pilot-preflight.ts` | 采集前置检查：设备、账号、来源配置与数据库状态 |
| `pilot-page-inspect.ts` | 读取当前页面控件与结构，用于校准和排查 |
| `probe-jd-navigation.ts` | 京东入口、搜索与门店导航探测 |
| `probe-checkout-model.ts` | 结算页字段与模型读数探测 |
| `live-single-pilot.ts` | 单次指定单品真机试采（一店一品一份） |
| `live-pilot-cohort.ts` | 连续真机批次：首页出发 / 门店内继续各十次 |
| `report-pilot-cohort.ts` | 由批次 JSON 生成质量、性能与逐任务报告 |
| `freeze-jd-baseline.ts` | 冻结京东单店验收基线（质量门槛、性能门槛、文件哈希） |
| `pilot-evidence-index.ts` | 证据索引：核对证据文件摘要、去重与人工复核清单 |
| `restore-pilot-cart.ts` | 单独恢复购物车，用于失败任务的人工复核 |
| `watch-pilot-foreground.ts` | 监视前台应用变化，排查误触与页面切换 |
| `watch-sku-diagnostic.ts` | 监视 SKU 诊断读数 |

## 验证与演示

| 脚本 | 用途 |
|---|---|
| `verify.ts` | 端到端验证（`npm run test:e2e`），使用独立临时数据库 |
| `verify-collection.ts` | 指定单品采集工作台浏览器验证 |
| `verify-ue.ts` | UE 工作台浏览器验证（`npm run test:ue:browser`） |
| `serve-ue.ts` | UE 静态预览服务（`npm run dev:ue`），不连采集后台 |
| `showcase.ts` | 历史模拟演示（`npm run demo`） |
| `model-smoke.ts` | 视觉模型连接与结构化读数冒烟 |

## 图表

`diagrams/` 下五个 Python 脚本生成 `前期调研/图表/` 的 8 张成品 PNG，需要 matplotlib 与 Graphviz（`ue_*.dot`）。生成命令在项目根目录执行，例如：

```powershell
python scripts/diagrams/draw_ue_flowcharts.py
```

审稿裁剪图、SVG/PDF/DOT 导出与 imagegen 参考图归档在 `前期调研/图表/_archive/`，不再维护。
