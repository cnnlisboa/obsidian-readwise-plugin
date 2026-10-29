import { jest } from '@jest/globals';
import { parse } from 'yaml';

export const App = jest.fn();
export const Plugin = jest.fn();
export const TFile = jest.fn();
export const TFolder = jest.fn();
export class PluginManifest {}
export type CachedMetadata = Record<string, unknown>;

export function parseYaml(yaml: string): unknown {
  return parse(yaml);
}

// add other exports as needed
