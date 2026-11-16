import type { FeatureCatalog, FeatureDefinition } from './feature-client';
import type { Capability } from './CapabilityPanel';
export function resolveFeature(catalog:FeatureCatalog,requested:string|null,previous:string|null):FeatureDefinition|undefined;
export function visibleFeatures(catalog:FeatureCatalog,current:string):FeatureDefinition[];
export function capabilityDestination(catalog:FeatureCatalog,capability:Capability):FeatureDefinition|undefined;
