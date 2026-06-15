// Shared definition of the repeat unit (e.g. the ELP VPGXG pentapeptide).
// The motif is a residue string where `X` marks a variable position — it becomes
// a regex wildcard. Everything else is matched literally. The unit length is
// simply the motif length, so motifs of any length work.

const STORAGE_KEY = 'elp-repeat-motif';
export const DEFAULT_MOTIF = 'VPGXG';

// Marker for a variable/wildcard residue within the motif.
const WILDCARD = 'X';

// Amino acid letters allowed in a motif (standard 20) plus the X wildcard.
export const VALID_MOTIF_CHARS = 'ACDEFGHIKLMNPQRSTVWYX';

export function readRepeatMotif(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v.trim() ? v.toUpperCase() : DEFAULT_MOTIF;
  } catch {
    return DEFAULT_MOTIF;
  }
}

export function writeRepeatMotif(motif: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, motif.toUpperCase());
  } catch {
    /* ignore persistence failures */
  }
}

function escapeRegexChar(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Regex source for a single repeat unit, with X turned into a `.` wildcard.
// e.g. "VPGXG" → "VPG.G".
export function motifUnitSource(motif: string): string {
  return motif
    .split('')
    .map(c => (c.toUpperCase() === WILDCARD ? '.' : escapeRegexChar(c)))
    .join('');
}

// Regex matching exactly one repeat unit (case-insensitive).
export function motifUnitRegex(motif: string): RegExp {
  return new RegExp('^' + motifUnitSource(motif) + '$', 'i');
}

// 0-based indices of the variable (wildcard) positions within a unit.
export function motifVarPositions(motif: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < motif.length; i++) {
    if (motif[i].toUpperCase() === WILDCARD) out.push(i);
  }
  return out;
}

// Returns an error message if the motif is invalid, otherwise null.
export function validateMotif(motif: string): string | null {
  const m = motif.trim().toUpperCase();
  if (m.length < 2) return 'Motif must be at least 2 residues.';
  const bad = [...new Set(m.split('').filter(c => !VALID_MOTIF_CHARS.includes(c)))];
  if (bad.length) return `Invalid characters: ${bad.join(', ')}`;
  return null;
}
