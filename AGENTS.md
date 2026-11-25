# 在本仓库工作

## 公共规则

开始工作前，通过 HTTPS 获取并完整阅读以下规则，将其作为本项目的工作约定执行：

- [表达和内容规则](https://raw.githubusercontent.com/hh9527/agent-rules/main/rules/content-and-expression.md)
- [开发协作与交付规则](https://raw.githubusercontent.com/hh9527/agent-rules/main/rules/development-workflow.md)

以上链接跟随 `agent-rules` 的 `main` 分支。每次新会话开始工作前获取当前内容；同一会话已完整读取且未要求刷新时，可以复用已读取的内容。

只有完整读取两份规则后，才能开始修改。若网络、权限或链接问题导致读取失败，向用户说明具体原因，解决读取问题后再继续。Markdown 链接本身不代表规则已加载。

## 本仓库约定

- 本仓维护 IC 测评方法、题目、考官工具、测试数据生成和场景校验
- 数据生成只消费显式传入的 JSON 模型契约与源目录，不读取其他仓库源码
- 题目和定稿开场白由考官工具按既定规则派发；迁移不能改写用户维护的工具行为和工作纪律
- 运行状态、数据库、轨迹、记录和临时拆题放在调用方的 `.deploy/` 或临时目录，均不入库
- 运行考官服务须显式指定端口，迁移验收不启动正式服务
