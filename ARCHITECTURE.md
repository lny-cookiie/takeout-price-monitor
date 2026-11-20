# 系统架构

## 分层与依赖规则

```mermaid
flowchart TB
  subgraph 入口层
    HTTP[HTTP API src/http]
    UI[比价页面 public/bd.html + src/ui]
    CLI[验收与运维脚本 scripts]
  end
  subgraph 应用层
    SCHED[调度与重试 src/application]
    MATCH[目标匹配与合同 src/application + src/domain]
  end
  subgraph 领域层
    CONTRACT[业务契约与报价校验 src/domain]
    LAYOUT[布局签名与策略选择 src/domain/layout.ts]
  end
  subgraph 适配层
    JD[京东适配器]
    MT[美团适配器]
    TB[淘宝闪购适配器]
    VIS[视觉结算与小程序兜底]
  end
  subgraph 基础设施
    STORE[(SQLite 状态库)]
    EVID[证据库与截图]
    MODEL[本地视觉模型]
    ADB[ADB 设备通道]
  end
  HTTP --> SCHED
  UI --> HTTP
  CLI --> SCHED
  SCHED --> CONTRACT
  SCHED --> JD & MT & TB
  JD --> ADB
  MT --> ADB
  TB --> ADB
  JD --> MODEL
  MT --> MODEL
  TB --> MODEL
  VIS --> MODEL
  JD --> EVID
  MT --> EVID
  TB --> EVID
  SCHED --> STORE
  CONTRACT --> LAYOUT
```

依赖方向只有一条：入口层调用应用层，应用层依赖领域契约，适配器和基础设施实现领域接口。领域层不引用设备、模型或数据库；适配器之间不互相调用；页面定位和金额读取不写进调度器。

## 关键模块

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `src/domain/` | 任务与报价契约、目标匹配、布局签名 | 页面操作、数据库写入 |
| `src/application/` | 调度、重试、暂停、映射和结果校验 | 具体平台页面细节 |
| `src/adapters/` | 京东、美团、淘宝的页面操作与读取，视觉兜底 | 跨平台调度和业务口径 |
| `src/infra/` | SQLite 状态、证据文件、模型调用、ADB 传输 | 页面策略选择 |
| `src/http/` | 对内对外的 HTTP 接口 | 采集逻辑 |
| `scripts/` | 基线冻结、验收批次、证据复核、知识库与布局注册表命令 | 生产运行时逻辑 |

## 一次比较组的数据流

```mermaid
sequenceDiagram
  participant U as 用户/脚本
  participant API as HTTP API
  participant S as 调度器
  participant A as 平台适配器
  participant P as 手机 App
  participant E as 证据库
  participant DB as 状态库
  U->>API: 提交城市/品牌/门店/商品
  API->>DB: 匹配已登记目标并建任务
  API->>S: 排队三个平台
  S->>A: 串行执行（同一台手机）
  A->>P: 搜索、进店、加购、结算
  P-->>A: 页面截图与节点
  A->>E: 保存门店/商品/结算证据
  A-->>S: 报价、费用、失败码、清理状态
  S->>DB: 写结果与知识记录
  S-->>U: 比较组结果与证据链接
```

## 自愈闭环

```mermaid
flowchart LR
  FAIL[真机失败] --> REC[自动记录 attempts.jsonl]
  REC --> SIG[按平台+错误码聚合]
  SIG --> REG[匹配 42 失败模式注册表]
  REG --> NEW{已登记?}
  NEW -- 否 --> DIG[摘要提示未登记签名]
  NEW -- 是 --> FIX[套用已知修复]
  FIX --> VER[真机验证并标注运行编号]
  VER --> REG
  DIG --> HUMAN[人工归纳成新条目]
  HUMAN --> REG
```

## 文件系统约定

- 代码只放 `src/`、`scripts/`、`tests/`，页面资源放 `public/`。
- 本地运行数据、证据、验收产物放 `.runtime/` 和 `artifacts/`，不入库。
- 当前有效的产品判断放 `产品目标/`，过程数据放 `进度与实验记录/`，方案与知识库放 `前期调研/`。
- 历史调研、旧演示和一次性截图已清理；需要追溯时用 Git 历史，不把历史材料堆回工作区。
