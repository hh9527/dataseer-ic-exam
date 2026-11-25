# IC 数据场景

`generate.mjs` 通过 Node.js 内置 `node:sqlite` 创建数据库，显式消费领域模型导出的结构与类型契约。

## 输入与运行

```sh
node data/ic/generate.mjs \
  --contract /path/to/generation-contract.json \
  --catalog /path/to/source_catalog.json \
  --output /path/to/output --anchor-utc 2026-11-25T02:44:00Z \
  --resources 150 --tenants 30 --days 93 --interval-minutes 60 --exam-profile
```

`--contract` 使用 `icloud-generation-contract/v1`，包含准备模型与源目录摘要；`--catalog` 给出物理表和字段。摘要不匹配时拒绝生成。模型仓库负责导出和更新这两个 JSON，生成器不访问其源码、Telora 编译器或 WASM。

七张 IC 资源表在模型契约和源目录中使用无前缀的物理表名，分别为 `EntCollaborationElement`、`EntNetworkElement`、`EntPonElement`、`EnterpriseFrame`、`EnterpriseNetworkLTP`、`EnterpriseOpticalModule` 和 `EnterpriseSlot`。SQLite 数据库、生成清单和逐题覆盖 SQL 均使用这些表名。

API 可使用 `generate({contract, catalog, output, seed, resources, tenants, days, intervalMinutes, anchor, examProfile})`。`loadModel(contract, catalog)` 读取并验证输入。测试也可通过 `IC_GENERATION_CONTRACT` 与 `IC_SOURCE_CATALOG` 显式提供输入，路径均由调用方指定。

## 规模与确定性

普通场景默认种子 20260926，每表 12 个基准资源、32 天小时样本；锚点默认当前 UTC 分钟。完整考卷使用 150 个资源、30 个租户、93 天小时采样和 `--exam-profile`，题库默认取本仓 `questions/`，也可用 `--exam-questions DIR` 指定。

种子、锚点、契约、源目录与生成规则相同，可复现同一数据库。生成器使用物理表名构造资源 ID，并将表名作为设备分类抽样的输入。输出目录必须不存在；在相邻临时目录生成和校验，再原子重命名发布，失败则清理临时目录。生成版本为 16，记录在 manifest。

- `--resources N` 设置基准资源总体，至少 6；全卷场景至少 120，推荐 150
- `--tenants N` 独立设置租户数，3 至 resources；按约 20%／30%／50% 租户承载约 60%／30%／10% 资源，前 30 个租户使用企业、学校、医院等名称
- `--days N` 和 `--interval-minutes N` 设置窗口及采样；完整场景至少 93 天，固定日期题需覆盖题面窗口
- `--alarms-per-resource-per-day N` 设置告警基础数量系数，默认 2；工作日、周末和周期性高发日有差异，不表示每类每实例每天固定产生 N 条
- `--storage-gap-hours N` 为存储台账下标 2、11 构造近期缺样，默认 0；FC 序列保持完整，告警发生日仍需有 CPU 样本

超过一千万 KPI 行或一百万告警的生成请求会被拒绝。数据用于查询与展现测评，不用于生产容量规划。

## 数据规则

覆盖网络、服务器、存储、FC、PON、终端、协作设备、组件和物理连接。当前契约包含 48 张表、827 列。17 张 KPI 表使用按设备和指标独立的波形、种子噪声、昼夜、周末及短时事件，保持个体差异。

- DateTimeUtc 使用固定三位毫秒的 `YYYY-MM-DDTHH:MM:SS.SSSZ`，EpochMillis 使用整数；告警缺失确认/清除时间使用零
- AP、射频、SSID 与 PON 端口按角色生成序列；子资源继承实际父设备的租户与站点；ONU 采样以 ONU 身份唯一
- 服务器、存储和磁盘采用高／中／低档位；系统功率与峰值功率、已用端口与总端口保持约束
- 容量以 MB 生成，总量等于已用加未用，比率等于已用除总量；比率与百分数保留各自量纲
- ONU 光功率包含 OLT、路径与 ONU 的层次差异，避免父设备聚合后的排名失去区分度
- 在线率由设备身份和绝对 UTC 日期的停机事件计算，按区间并集与实际采样窗口重叠确定；改变采样粒度仍使用同一批事件
- 通信状态和告警场景使用同一资源画像；告警对象、名称、租户、站点、分类和厂商从资产派生
- 告警覆盖全部 UTC 日期、六类资源、四种严重度及确认/清除组合；无源分光器不生成 CPU、内存或掉电类告警
- 所有数据均为测评场景，不增加模型未声明的字段或业务事实

## 全卷场景

`ic-exam/v1` 包含具名园区和设备、版本匹配及反例、零使用容量、单板版本、物理链路、终端接入、告警交集，以及固定日期和去年同月的采样。每题检查筛选条件、关系与窗口，记录到 `manifest.examCoverage`；场景缺失阻止发布。

“内存占用率超过 30MB”等题保留单位瑕疵，允许澄清或明确合理口径；数据检查只证明解释所需的场景存在。“当日不可达比率”是能力边界确认，不能将在线率的补数冒充为已发布指标。

## 验证与产物

生成时检查 SQLite 完整性、行数、载体作用域、时间编码、枚举、唯一粒度、关系、角色、功率与容量约束、告警时间及逐日覆盖。多态引用逐行选择资源族，不要求一条记录匹配所有替代关系；协作设备没有声明 CPU 源，单独记录。

输出 `icloud.sqlite`、`model.json`、`manifest.json`。清单包含输入摘要、数据库摘要、选项、窗口、采样、缺样、行数、关系覆盖及逐题检查结果；数据库摘要分块计算，支持超过 2 GiB 的文件。

```sh
node data/ic/coverage.mjs /path/to/icloud.sqlite questions 2026-11-25T02:44:00Z
```

实际模型能否正确校验和 lower 查询，由模型仓库及消费方的集成验收负责；数据见证检查不替代模型契约测试和 Agent 测评。
