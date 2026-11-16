export type Importance = 'core' | 'key' | 'normal';
export const importanceLabels: Readonly<Record<Importance, string>>;
export function nodeImportance(value?:unknown): Importance;
export function importanceLabel(value?:unknown): string;
