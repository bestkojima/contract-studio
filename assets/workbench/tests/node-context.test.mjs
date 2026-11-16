import test from 'node:test';
import assert from 'node:assert/strict';
import { describeNodeContext } from '../src/node-context.mjs';

const node = (id, title, parentId = null, extra = {}) => ({
  id, title, parentId, kind: 'logic', description: `${title}职责`, input: `${title}输入`, output: `${title}输出`, ...extra
});
const fixture = () => ({
  nodes: [
    node('input', '接收输入'), node('process', '处理流程', null, { kind: 'group' }),
    node('result', '展示结果'), node('error', '展示错误'),
    node('validate', '校验输入', 'process', { outputSchema: { type: 'array', items: { type: 'object' } } }),
    node('transform', '转换数据', 'process', { kind: 'group' }),
    node('nested', '深层辅助实现', 'transform'), node('unrelated', '无关功能')
  ],
  edges: [
    { id: 'input-process', source: 'input', target: 'process', sourceHandle: 'values', targetHandle: 'in', label: '输入已就绪' },
    { id: 'process-result', source: 'process', target: 'result', sourceHandle: 'ok', targetHandle: 'value', label: '处理成功' },
    { id: 'process-error', source: 'process', target: 'error', sourceHandle: 'fail', targetHandle: 'message', label: '校验或处理失败' },
    { id: 'validated-transform', source: 'validate', target: 'transform', label: '校验通过' },
    { id: 'unrelated-result', source: 'unrelated', target: 'result', label: '无关连线' }
  ]
});

test('节点文档包含直接前后驱、分支端口标签及直接子节点接口，范围不扩成全图', () => {
  const text = describeNodeContext(fixture(), 'process');
  assert.match(text, /直接输入依赖/);
  assert.match(text, /input · 接收输入 \[values\] → process · 处理流程 \[in\]/);
  assert.match(text, /输入：接收输入输入\n输出：接收输入输出/);
  assert.match(text, /process · 处理流程 \[ok\] → result · 展示结果 \[value\]/);
  assert.match(text, /process · 处理流程 \[fail\] → error · 展示错误 \[message\]/);
  assert.match(text, /条件 \/ 标签：校验或处理失败/);
  assert.match(text, /直接子节点契约/);
  assert.match(text, /validate · 校验输入\n职责：校验输入职责\n输入：校验输入输入/);
  assert.match(text, /"type": "array"/);
  assert.match(text, /transform · 转换数据/);
  assert.match(text, /子节点之间的关系/);
  assert.match(text, /validate · 校验输入 \[ok\] → transform · 转换数据 \[in\]/);
  assert.doesNotMatch(text, /深层辅助实现|无关功能|无关连线/);
});

test('从当前图生成新快照，节点契约和边条件变化不会沿用旧内容', () => {
  const graph = fixture();
  const before = describeNodeContext(graph, 'process');
  graph.nodes.find(item => item.id === 'input').output = '已归一化数据列表';
  graph.nodes.find(item => item.id === 'validate').description = '检查输入结构与必填字段';
  graph.edges.find(edge => edge.id === 'process-error').label = '缺少必填字段';
  graph.edges = graph.edges.filter(edge => edge.id !== 'process-result');
  const after = describeNodeContext(graph, 'process');
  assert.match(after, /输出：已归一化数据列表/);
  assert.match(after, /职责：检查输入结构与必填字段/);
  assert.match(after, /条件 \/ 标签：缺少必填字段/);
  assert.doesNotMatch(after, /输出：接收输入输出|职责：校验输入职责|处理成功|result · 展示结果/);
  assert.match(before, /输出：接收输入输出/);
  assert.doesNotMatch(before, /已归一化数据列表/);
});

test('叶节点仅包含其直接依赖，空功能组准确呈现未定义关系', () => {
  const graph = fixture();
  const leaf = describeNodeContext(graph, 'validate');
  assert.match(leaf, /无直接输入连线/);
  assert.match(leaf, /transform · 转换数据/);
  assert.doesNotMatch(leaf, /直接子节点契约|深层辅助实现|接收输入/);
  assert.match(describeNodeContext({ nodes: [node('empty', '待设计功能', null, { kind: 'group' })], edges: [] }, 'empty'), /尚无直接子节点/);
});

test('节点任务上下文带有自身、直接依赖与子节点的重要性，缺省普通且实时更新', () => {
  const graph = fixture();
  graph.nodes.find(node => node.id === 'process').importance = 'core';
  graph.nodes.find(node => node.id === 'input').importance = 'key';
  graph.nodes.find(node => node.id === 'validate').importance = 'key';
  const text = describeNodeContext(graph, 'process');
  assert.match(text, /节点重要性\n核心逻辑 \(core\)/);
  assert.match(text, /输出：接收输入输出\n重要性：关键逻辑 \(key\)/);
  assert.match(text, /输出：展示结果输出\n重要性：普通组成逻辑 \(normal\)/);
  assert.match(text, /validate · 校验输入\n[\s\S]*?重要性：关键逻辑 \(key\)/);
  graph.nodes.find(node => node.id === 'process').importance = 'normal';
  assert.match(describeNodeContext(graph, 'process'), /节点重要性\n普通组成逻辑 \(normal\)/);
});
