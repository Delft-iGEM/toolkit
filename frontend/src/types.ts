export interface Region {
  name: string;
  type: 'part' | 'linker';
  start: number; // 0-indexed inclusive
  end: number;   // 0-indexed inclusive
  // Set by auto-annotate: these parts are NOT saved to the part library.
  excludeFromLibrary?: boolean;
}

export interface RegionResult extends Region {
  aa: string;
  dna: string;
}

export interface ScrambleResult {
  dna: string;
  regions: RegionResult[];
  objective: number;
  status: string;
}

export interface WorkSession {
  version: 1;
  sequence: string;
  regions: Region[];
  result: ScrambleResult;
  alternatives: Record<string, { label: string; aa: string; dna: string }[]>;
  activeIndex: Record<string, number>;
  savedOHs?: Record<string, string>;
  savedLinkerSplits?: Record<string, { leftRest: string; rightRest: string }>;
  enzymeKey?: string;
}
