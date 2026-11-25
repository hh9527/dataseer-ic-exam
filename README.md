# dataseer-ic-exam

可复现的 IC 数据分析测评：题目、考官方法、考官工具和配套数据场景。运行工具需要 Node.js 22.13 及以上，无第三方依赖；命令入口使用 just。

## 内容

| 路径 | 内容 |
| --- | --- |
| `questions/` | 142 道题，按 A1–C1 与 T1 卷分类 |
| `考官须知.md` | 工作方法、澄清口径、纪律与记录方法 |
| `开场白.md` | 定稿开场白 |
| `tools/` | 题目派发、澄清与会话服务工具 |
| `data/ic/` | IC 数据生成、场景画像和逐题数据覆盖检查 |
| `tests/` | 工具、数据生成与场景校验回归 |

题面可以保留歧义或单位瑕疵。允许请求澄清，或采用模型支持的合理解释并在结果中明确说明；不能静默替换单位或臆造字段。派发时只发送任务与指定追问，考核要点留给考官。

## 考官工具

```sh
just list
just ask 10924 --question A2-004 --dry-run
just ask 10924 --question T1-016 --step 2 --dry-run
just run-tester 10924 --deploy-root /path/to/product/.deploy
```

`run-tester` 使用指定部署的 token 和工作区建立考官服务。考官状态保存在 `<deploy-root>/<port>/tester`；数据目录由调用方控制，不写入考卷文件。所有端口须显式指定。集成在 dataseer-ic 时，伞仓的 `just run-tester`、`just ask`、`just submit` 等命令统一转调本仓 justfile，并通过 `--set deploy_root <绝对路径>` 指定部署根目录。`DEPLOY_ROOT` 设置独立使用时的默认部署目录，`TESTER_STATE_DIR` 可覆盖客户端状态目录。

独立调用 `tools/exam.mjs` 时，通过 `TESTER_STATE_DIR` 指向同一个考官状态目录；`just ask` 等入口也接受此变量。工具使用脚本所在仓库的题库，调用目录不会改变题库来源。

## 配套数据

领域模型负责发布 `generation-contract.json` 和 `source_catalog.json`；本仓只消费这两个 JSON 输入，不读取模型源码，不需要 Telora、WASM 或相邻仓库检出。输入目录哈希不匹配时拒绝生成。

```sh
just generate /path/to/output /path/to/generation-contract.json /path/to/source_catalog.json \
  --anchor-utc 2026-11-25T02:44:00Z
just check-data /path/to/output/icloud.sqlite 2026-11-25T02:44:00Z
```

完整场景使用 150 个基准资源、30 个租户、93 天小时采样；服务器同比额外提供去年同月样本。固定日期题需选择覆盖相应日期的生成窗口。生成器在发布前检查 142 道题的 152 个数据见证，并写入 manifest。瑕疵题检查解释口径的支撑数据；能力边界题不捏造指标。详见 [数据生成说明](data/ic/README.md)。

输出目录包含 `icloud.sqlite`、`model.json` 和 `manifest.json`。数据库、模型二进制、轨迹、测评记录、认证状态与临时拆题均作为运行产物，不进入版本控制。

## 验收

```sh
just test
just test-data /path/to/generation-contract.json /path/to/source_catalog.json
```

第一组检查题目派发、私有考核要点隔离及确定性画像；第二组使用调用方契约检查数据可复现性、48 表与 827 列、角色、关联、窗口、约束和失败发布。已有全卷数据库的反向验收需在数据库副本上运行：

```sh
node tests/icloud-exam.test.mjs /path/to/copy.sqlite questions 2026-11-25T02:44:00Z
```

这些检查证明数据场景存在，不替代实际 Agent 测评。

## 作为 submodule 使用

消费方将本仓挂载为 `exam` 并固定提交。首次检出执行 `git submodule update --init exam`；升级时同时审阅题目、生成规则和模型输入契约，验收后更新 gitlink。模型契约由消费方选定的模型版本提供，考卷仓库不反向依赖产品源码。
