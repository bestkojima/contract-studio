import type { FeatureClient } from '../../src/feature-client';

export function ProjectPanel() {
  return <section className="project-guide" aria-label="项目开发指引">
    <div><strong>从功能节点开始</strong><p>在画布中添加节点、填写属性，再从侧栏导出节点文档与 Agent 开发任务。</p></div>
    <span>未接入运行能力的节点显示「待实现」</span>
  </section>;
}

const client: FeatureClient = { Panel: ProjectPanel };
export default client;
