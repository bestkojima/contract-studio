# 按规范编写，自动形成关联

Agent 写需求、规格与源码标记；Sphinx-Needs 解析条目和关系，CodeLinks 提取源码函数身份、签名和范围，框架按 `traceability/node-mapping.json` 投影节点与属性。框架不会从未标注的任意代码猜测需求关系。

## 1. 编写需求和节点规格

新原生条目写入 `traceability/` 下的手写 RST，并加入 `traceability/index.rst` 的 `toctree`。下面只说明格式，按真实任务替换 ID 与内容：

```rst
.. req:: 名称不能为空
   :id: REQ_NAME

   提交名称时拒绝空白内容。

   * :need_part:`(EMPTY) 空白名称返回明确的输入错误。`

.. spec:: 校验名称
   :id: SPEC_NAME
   :feature_id: project
   :fulfills: REQ_NAME
   :importance: key
   :node_properties: {"input":"名称文本","output":"有效名称或输入错误"}

   检查去除首尾空白后的名称。
```

`feature_id` 选择已登记视图。节点 ID 默认取 spec ID；兼容已有节点时使用 `node_id`。标题、正文与 `node_properties` 投影为节点属性。`fulfills` 关联需求，`parent_spec/contains` 表达层级，`flows_to` 表达数据流，端口和条件用 `node_edges` JSON。

原生节点的需求关联修改 `spec.fulfills` 后重建；需求保存接口拒绝修改这类需求的 `nodeIds`。既有 JSON 条目继续改其 JSON 源；其导出 RST 和 `node-properties.rst` 是生成文件。每条语义只保留一个权威源。

## 2. 在具体函数上标记精确规格

```js
// @need-ids: SPEC_NAME
export function validateName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('名称不能为空');
  return value.trim();
}
```

多个函数可以标记同一 spec。也支持函数前的 `@need impl:` 声明，以 `:implements: SPEC_NAME` 关联并用 `@endneed` 结束。只标记 `REQ_NAME` 只能得到需求级引用，不能区分同一需求下的直接实现节点。函数身份由文件与符号确定；行号由解析结果更新。

## 3. 测试声明验收关系

```js
// @need test: 拒绝空白名称
// :id: TEST_NAME_EMPTY
// :verifies: REQ_NAME.EMPTY
// @endneed
test('[TEST_NAME_EMPTY] 拒绝空白名称', () => {
  assert.throws(() => validateName('  '), /名称不能为空/);
});
```

在测试文件导入 `node:test`、`node:assert/strict` 及被测函数。`verifies` 指向 `REQ_ID.PART_ID`；稳定 `[TEST_ID]` 与允许的测试文件共同匹配实际执行记录。工作台运行还需要可信能力的 `testFiles`，见[接入运行](workbench.md#connect-a-user-capability)。不需要额外的 `implementation`、`code` 或 `testCases` 对照表。

## 构建与读取

执行 `node scripts/build-index.mjs`，再查询节点上下文。`context.properties` 给出行为属性；`implementation` 是精确 spec 直接关联的函数，`relatedImplementation` 是同一能力中的其他函数。`backend.testCases` 给出验收关系和逐用例状态；`evidence.executionState` 是实际执行状态，`caseCoverage` 统计索引条目的结果完整性，不代表代码执行覆盖率。

工具配置在 `traceability/ubproject.toml`；模板扫描 `src/features/server/tests`。新增源码项目时同步 `index.rst` 的 `src-trace`。仅对当前配置支持的语言和路径声称解析成功；源码预览与编辑器导航限制在工作台根目录内。普通验收 ID 原样成为 part ID；含点或以 `PART_` 开头的旧 ID 使用可逆编码，读取接口返回的 `needId`。

## ubCode 是可选扩展

模板实际运行 Sphinx-Needs + CodeLinks；ubCode 当前状态为 `not-connected`。接入时先确认工具、项目配置和适用许可，再接入其索引或 CLI/MCP 输出，保留实际来源。仅存在 `ubproject.toml` 不等于已经运行 ubCode。

官方格式：[Sphinx-Needs 条目](https://sphinx-needs.readthedocs.io/en/latest/directives/need.html)、[验收子条目](https://sphinx-needs.readthedocs.io/en/latest/roles.html#need-part-np)、[CodeLinks 源码分析](https://codelinks.useblocks.com/en/sphinx-codelinks-v2.1.0/components/analyse.html)、[ubCode 与 Sphinx](https://ubcode.useblocks.com/paths/sphinx.html)。使用模板锁定的依赖版本，不直接套用新版文档新增语法。
