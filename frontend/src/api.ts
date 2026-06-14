import type { Region, ScrambleResult } from './types';
import { wasmScrambleConstruct, wasmSwapPart } from './wasm-api';

export function scrambleConstruct(
  sequence: string,
  regions: Region[],
  fast = false,
  config?: Record<string, unknown>
): Promise<ScrambleResult> {
  const req = JSON.stringify({ sequence, regions, config, fast });
  return Promise.resolve(JSON.parse(wasmScrambleConstruct(req)) as ScrambleResult);
}

export function swapPart(
  newAa: string,
  partName: string,
  regions: Region[],
  regionDnas: Record<string, string>,
  fast = false,
): Promise<{ dna: string; swapped_dna: string }> {
  const req = JSON.stringify({
    new_aa: newAa,
    part_name: partName,
    regions,
    region_dnas: regionDnas,
    fast,
  });
  return Promise.resolve(JSON.parse(wasmSwapPart(req)) as { dna: string; swapped_dna: string });
}
