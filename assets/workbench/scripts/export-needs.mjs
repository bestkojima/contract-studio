import { exportNeeds } from '../server/traceability.mjs';
import { featureRegistry } from '../server/feature-registry.mjs';
for(const feature of featureRegistry.features)await exportNeeds(undefined,feature.id);
console.log('Sphinx-Needs 视图已从需求和已保存的功能图同步。');
