import { scramble_construct, swap_part } from './wasm-pkg/elp_wasm.js';

export function wasmScrambleConstruct(reqJson: string): string {
  return scramble_construct(reqJson);
}

export function wasmSwapPart(reqJson: string): string {
  return swap_part(reqJson);
}
