export const importanceLabels = Object.freeze({
  core: '核心逻辑',
  key: '关键逻辑',
  normal: '普通组成逻辑'
});

// Absence is the legacy default; explicit invalid values must never be coerced.
export function nodeImportance(value) {
  if (value === undefined) return 'normal';
  if (typeof value === 'string' && Object.hasOwn(importanceLabels, value)) return value;
  throw Error('节点 importance 无效：仅支持 core、key、normal');
}

export function importanceLabel(value) {
  return importanceLabels[nodeImportance(value)];
}
