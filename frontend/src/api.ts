import type { Region, ScrambleResult } from './types';

const BASE = import.meta.env.VITE_API_BASE ?? '';

async function post<T>(path: string, body: unknown, fast = false): Promise<T> {
  const url = `${BASE}${path}${fast ? '?fast=True' : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? 'Request failed');
  }
  return res.json();
}

export function scrambleConstruct(
  sequence: string,
  regions: Region[],
  fast = false,
  config?: Record<string, unknown>
): Promise<ScrambleResult> {
  return post('/api/scramble', { sequence, regions, config }, fast);
}

export function swapPart(
  newAa: string,
  partName: string,
  regions: Region[],
  regionDnas: Record<string, string>,
  fast = false,
): Promise<{ dna: string; swapped_dna: string }> {
  return post('/api/swap-part', {
    new_aa: newAa,
    part_name: partName,
    regions,
    region_dnas: regionDnas,
  }, fast);
}
