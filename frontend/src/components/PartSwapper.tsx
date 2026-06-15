import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Code,
  CopyButton,
  Divider,
  Group,
  Modal,
  Radio,
  Slider,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconCopy, IconDna, IconDna2, IconDownload, IconPlus } from '@tabler/icons-react';
import { scrambleConstruct, swapPart } from '../api';
import type { Region, RegionResult, ScrambleResult, WorkSession } from '../types';

// ── GGA helpers ──────────────────────────────────────────────────────────────

function dnaRc(seq: string): string {
  const comp: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };
  return seq.toUpperCase().split('').reverse().map(b => comp[b] ?? 'N').join('');
}

function calcGcPct(dna: string): number {
  const u = dna.toUpperCase();
  if (!u.length) return 0;
  return Math.round(100 * [...u].filter(b => b === 'G' || b === 'C').length / u.length);
}

const BSAI_RE = /GGTCTC|GAGACC/i;

interface EnzymeDef {
  key: string;
  name: string;
  site: string;
  fwd: string;      // left flank sequence: recognition site + spacers (before the OH)
  rev: string;      // right flank sequence: spacers + RC(recognition site) (after the OH)
  ohLen: number;
  re: RegExp;       // matches recognition site on either strand
  typeIIS: boolean;
}

const ENZYME_DEFS: EnzymeDef[] = [
  { key: 'BsaI',  name: 'BsaI',  site: 'GGTCTC', fwd: 'GGTCTCA',  rev: 'TGAGACC',  ohLen: 4, re: /GGTCTC|GAGACC/i, typeIIS: true  },
  { key: 'BseRI', name: 'BseRI', site: 'GAAGAC', fwd: 'GAAGACAA', rev: 'TTGTCTTC', ohLen: 4, re: /GAAGAC|GTCTTC/i,  typeIIS: true  },
  { key: 'NdeI',  name: 'NdeI',  site: 'CATATG', fwd: 'CATATG',   rev: 'CATATG',   ohLen: 2, re: /CATATG/i,          typeIIS: false },
  { key: 'BamHI', name: 'BamHI', site: 'GGATCC', fwd: 'GGATCC',   rev: 'GGATCC',   ohLen: 4, re: /GGATCC/i,          typeIIS: false },
  { key: 'XbaI',  name: 'XbaI',  site: 'TCTAGA', fwd: 'TCTAGA',   rev: 'TCTAGA',   ohLen: 4, re: /TCTAGA/i,          typeIIS: false },
];

function randomDna(len: number, gcFrac: number): string {
  return Array.from({ length: len }, () => {
    const r = Math.random();
    if (r < gcFrac * 0.5) return 'G';
    if (r < gcFrac) return 'C';
    if (r < gcFrac + (1 - gcFrac) * 0.5) return 'A';
    return 'T';
  }).join('');
}

function randomDnaClean(len: number, gcFrac: number, avoid = BSAI_RE): string {
  for (let i = 0; i < 200; i++) {
    const seq = randomDna(len, gcFrac).toUpperCase();
    if (!avoid.test(seq) && !avoid.test(dnaRc(seq))) return seq;
  }
  return randomDna(len, gcFrac).toUpperCase();
}

/** Returns true if `seq` (and its RC) is not yet in `used`. Also adds both to `used`. */
function tryAssign(seq: string, used: Set<string>): boolean {
  const s = seq.toUpperCase();
  const r = dnaRc(s);
  if (used.has(s) || used.has(r)) return false;
  used.add(s);
  used.add(r);
  return true;
}

/** Generate a random OH of the given length not already in `used`. */
function freshOH(gcFrac: number, used: Set<string>, ohLen: number, avoid: RegExp): string {
  for (let i = 0; i < 2000; i++) {
    const seq = randomDnaClean(ohLen, gcFrac, avoid);
    if (tryAssign(seq, used)) return seq;
  }
  return randomDnaClean(ohLen, gcFrac, avoid);
}

interface LinkerSplit {
  seq: string;
  leftRest: string;
  rightRest: string;
  warn?: string;
}

function splitLinker(ld: string, used: Set<string>, ohLen: number, avoid: RegExp): LinkerSplit {
  if (ld.length < ohLen) {
    const seq = (ld + 'AAAA').slice(0, ohLen);
    tryAssign(seq, used);
    return { seq, leftRest: '', rightRest: '', warn: `Linker DNA (${ld.length} bp) is < ${ohLen} bp — overhang padded` };
  }

  const maxK = ld.length - ohLen;
  const mid = maxK / 2;
  const positions = Array.from({ length: maxK + 1 }, (_, i) => i)
    .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));

  for (const k of positions) {
    const seq = ld.slice(k, k + ohLen);
    if (avoid.test(seq) || avoid.test(dnaRc(seq))) continue;
    if (tryAssign(seq, used)) {
      return { seq, leftRest: ld.slice(0, k), rightRest: ld.slice(k + ohLen) };
    }
  }

  const k = Math.round(maxK / 2);
  const seq = ld.slice(k, k + ohLen);
  used.add(seq.toUpperCase());
  used.add(dnaRc(seq.toUpperCase()));
  return {
    seq, leftRest: ld.slice(0, k), rightRest: ld.slice(k + ohLen),
    warn: 'No unique overhang found in this linker — consider lengthening it',
  };
}

interface GGAInsert {
  name: string;
  label: string;
  ohLeft: string;
  ohRight: string;
  body: string;       // sequence between the two OHs (no recognition sites)
  utrLeft: string;    // random handle upstream of GGTCTCA
  utrRight: string;   // random handle downstream of TGAGACC
  insertDna: string;  // full PCR product: utrLeft+GGTCTCA+ohLeft+body+ohRight+TGAGACC+utrRight
  partGcPct: number;
  warning?: string;
}

interface GGAResult {
  overhangs: { name: string; seq: string; conflict: boolean }[];
  inserts: GGAInsert[];
  linkerSplits: Record<string, { leftRest: string; rightRest: string }>;
}

function buildFasta(r: GGAResult): string {
  const lines: string[] = [];
  for (const ins of r.inserts) {
    lines.push(`>Insert_${ins.label} length=${ins.insertDna.length} part_GC=${ins.partGcPct}pct left_OH=${ins.ohLeft} right_OH=${ins.ohRight}`);
    lines.push(ins.insertDna);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────

type SwapSource = 'custom' | 'library';
type Alternative = { label: string; aa: string; dna: string };
type LibraryPart = { label: string; aa: string };

interface Props {
  sequence: string;
  regions: Region[];
  result: ScrambleResult | null;
  onResultChange: (r: ScrambleResult) => void;
  onRestart: () => void;
  initialSession?: WorkSession | null;
  fastMode?: boolean;
}

const VALID_AA = new Set('ACDEFGHIKLMNPQRSTVWY*');
const PART_COLORS = ['#0ca678', '#7048e8', '#e64980', '#f59f00', '#1098ad', '#d9480f'];

function usePartLibrary() {
  const [library, setLibrary] = useState<LibraryPart[]>(() => {
    try { return JSON.parse(localStorage.getItem('elp-part-library') ?? '[]'); }
    catch { return []; }
  });
  const addToLibrary = (label: string, aa: string) => {
    setLibrary(prev => {
      if (prev.some(p => p.label === label && p.aa === aa)) return prev;
      const updated = [...prev, { label, aa }];
      localStorage.setItem('elp-part-library', JSON.stringify(updated));
      return updated;
    });
  };
  return { library, addToLibrary };
}

export default function PartSwapper({ sequence, regions, result, onResultChange, onRestart, initialSession, fastMode = false }: Props) {
  const { library, addToLibrary } = usePartLibrary();

  const [baseResult] = useState(result);
  const [rescrambling, setRescrambling] = useState(false);

  const [alternatives, setAlternatives] = useState<Record<string, Alternative[]>>(() => {
    if (initialSession?.alternatives) return initialSession.alternatives;
    const init: Record<string, Alternative[]> = {};
    for (const r of result?.regions ?? []) {
      if (r.type === 'part') init[r.name] = [{ label: r.name, aa: r.aa, dna: r.dna }];
    }
    return init;
  });

  const [activeIndex, setActiveIndex] = useState<Record<string, number>>(() => {
    if (initialSession?.activeIndex) return initialSession.activeIndex;
    const init: Record<string, number> = {};
    for (const r of result?.regions ?? []) {
      if (r.type === 'part') init[r.name] = 0;
    }
    return init;
  });

  const [modalPart, setModalPart] = useState<string | null>(null);
  const [source, setSource] = useState<SwapSource>('library');
  const [customLabel, setCustomLabel] = useState('');
  const [customAa, setCustomAa] = useState('');
  const [aaError, setAaError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [utrLength, setUtrLength] = useState(50);
  const [gcTarget, setGcTarget] = useState(50);
  const [ggaResult, setGgaResult] = useState<GGAResult | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [savedOHs, setSavedOHs] = useState<Record<string, string> | null>(
    () => initialSession?.savedOHs ?? null
  );
  const [savedLinkerSplits, setSavedLinkerSplits] = useState<
    Record<string, { leftRest: string; rightRest: string }> | null
  >(() => initialSession?.savedLinkerSplits ?? null);
  const [enzymeKey, setEnzymeKey] = useState<string>(
    () => initialSession?.enzymeKey ?? 'BsaI'
  );

  useEffect(() => {
    if (!baseResult) return;
    // Parts annotated via auto-annotate are flagged to stay out of the library.
    const excluded = new Set(
      regions.filter(r => r.excludeFromLibrary).map(r => r.name)
    );
    for (const r of baseResult.regions) {
      if (r.type === 'part' && !excluded.has(r.name)) addToLibrary(r.name, r.aa);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!result || !baseResult) {
    return <Alert color="yellow" mt="md">Please complete the scrambling step first.</Alert>;
  }

  const sortedRegions = [...result.regions].sort((a, b) => a.start - b.start);
  const baseRegionMap = new Map(baseResult.regions.map(r => [r.name, r]));

  const activate = (partName: string, idx: number) => {
    const newActive = { ...activeIndex, [partName]: idx };
    setActiveIndex(newActive);
    const newRegions: RegionResult[] = baseResult.regions.map(r => {
      if (r.type === 'linker') return r;
      const i = newActive[r.name] ?? 0;
      const alts = alternatives[r.name] ?? [];
      const alt = alts[i] ?? alts[0];
      return alt ? { ...r, aa: alt.aa, dna: alt.dna } : r;
    });
    const fullDna = [...newRegions].sort((a, b) => a.start - b.start).map(r => r.dna).join('');
    onResultChange({ ...baseResult, dna: fullDna, regions: newRegions });
  };

  const isAltActive = (name: string, i: number) => (activeIndex[name] ?? 0) === i;

  const openModal = (partName: string) => {
    setModalPart(partName); setSource('library');
    setCustomLabel(''); setCustomAa('');
    setAaError(null); setError(null);
  };
  const closeModal = () => {
    setModalPart(null); setCustomLabel(''); setCustomAa('');
    setAaError(null); setError(null);
  };

  const doAdd = async (partName: string, label: string, newAa: string, saveToLibrary = false) => {
    setLoading(true); setError(null);
    try {
      const regionDnas = Object.fromEntries(result.regions.map(r => [r.name, r.dna]));
      const res = await swapPart(newAa, partName, regions, regionDnas, fastMode);
      setAlternatives(prev => ({
        ...prev,
        [partName]: [...(prev[partName] ?? []), { label, aa: newAa, dna: res.swapped_dna }],
      }));
      if (saveToLibrary) addToLibrary(label, newAa);
      closeModal();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const canAddCustom = customLabel.trim().length > 0 && customAa.length >= 4 && !aaError;

  const rescramble = async () => {
    setRescrambling(true);
    try {
      const sorted = [...result.regions].sort((a, b) => a.start - b.start);
      const currentSequence = sorted.map(r => r.aa).join('');
      let pos = 0;
      const currentRegions = sorted.map(r => {
        const reg = { name: r.name, type: r.type, start: pos, end: pos + r.aa.length - 1 };
        pos += r.aa.length;
        return reg;
      });
      const newResult = await scrambleConstruct(currentSequence, currentRegions, fastMode);
      const linkerDna = new Map(result.regions.filter(r => r.type === 'linker').map(r => [r.name, r.dna]));
      const fixedRegions = newResult.regions.map(r =>
        r.type === 'linker' ? { ...r, dna: linkerDna.get(r.name) ?? r.dna } : r
      );
      const fullDna = [...fixedRegions].sort((a, b) => a.start - b.start).map(r => r.dna).join('');
      setAlternatives(prev => {
        const next = { ...prev };
        for (const r of fixedRegions) {
          if (r.type === 'part' && next[r.name]) {
            const i = activeIndex[r.name] ?? 0;
            const alts = [...next[r.name]];
            alts[i] = { ...alts[i], dna: r.dna };
            next[r.name] = alts;
          }
        }
        return next;
      });
      onResultChange({ ...newResult, dna: fullDna, regions: fixedRegions });
    } finally {
      setRescrambling(false);
    }
  };

  const exportSession = () => {
    const session: WorkSession = {
      version: 1, sequence, regions, result: result!, alternatives, activeIndex,
      ...(savedOHs ? { savedOHs } : {}),
      ...(savedLinkerSplits ? { savedLinkerSplits } : {}),
      enzymeKey,
    };
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'elp-session.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const exportGenbank = () => {
    const dna = result.dna.toLowerCase();
    const len = dna.length;
    const sorted = [...result.regions].sort((a, b) => a.start - b.start);
    const colorMap = new Map<string, string>();
    let ci = 0;
    for (const r of sorted) {
      if (r.type === 'part') { colorMap.set(r.name, PART_COLORS[ci % PART_COLORS.length]); ci++; }
    }
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}-${months[now.getMonth()]}-${now.getFullYear()}`;
    const lines: string[] = [];
    lines.push(`LOCUS       construct        ${String(len).padStart(9)} bp    DNA     linear   SYN ${dateStr}`);
    lines.push('DEFINITION  ELP construct.');
    lines.push('ACCESSION   .');
    lines.push('VERSION     .');
    lines.push('FEATURES             Location/Qualifiers');
    let dnaPos = 0;
    for (const r of sorted) {
      const start = dnaPos + 1;
      const end = dnaPos + r.dna.length;
      dnaPos += r.dna.length;
      const isPart = r.type === 'part';
      const color = isPart ? (colorMap.get(r.name) ?? PART_COLORS[0]) : '#fd7e14';
      const alts = alternatives[r.name] ?? [];
      const label = isPart ? (alts[activeIndex[r.name] ?? 0]?.label ?? r.name) : r.name;
      lines.push(`     misc_feature    ${start}..${end}`);
      lines.push(`                     /label="${label}"`);
      lines.push(`                     /color="${color}"`);
      lines.push(`                     /ApEinfo_fwdcolor="${color}"`);
      lines.push(`                     /ApEinfo_revcolor="${color}"`);
    }
    lines.push('ORIGIN      ');
    for (let i = 0; i < len; i += 60) {
      const pos = String(i + 1).padStart(9);
      const chunk = dna.slice(i, i + 60);
      const blocks: string[] = [];
      for (let j = 0; j < chunk.length; j += 10) blocks.push(chunk.slice(j, j + 10));
      lines.push(`${pos} ${blocks.join(' ')}`);
    }
    lines.push('//');
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'construct.gb'; a.click();
    URL.revokeObjectURL(url);
  };

  const runGGA = (): GGAResult => {
    const gcFrac = gcTarget / 100;
    const enzyme = ENZYME_DEFS.find(e => e.key === enzymeKey) ?? ENZYME_DEFS[0];
    const { re: avoid, ohLen } = enzyme;
    const parts = sortedRegions.filter(r => r.type === 'part');
    const linkers = sortedRegions.filter(r => r.type === 'linker');

    const used = new Set<string>();

    // When overhangs are locked, use them directly — no re-derivation needed.
    let oh0: string;
    if (savedOHs?.["5' start"]) {
      oh0 = savedOHs["5' start"];
      used.add(oh0.toUpperCase()); used.add(dnaRc(oh0));
    } else {
      oh0 = freshOH(gcFrac, used, ohLen, avoid);
    }

    // Keys are index-based ("linker_0", "linker_1", …) so duplicate linker names don't collide.
    const linkerSplits: LinkerSplit[] = linkers.map((l, li) => {
      const ohKey = `linker_${li}`;
      if (savedOHs?.[ohKey] && savedLinkerSplits?.[ohKey]) {
        // Overhangs are locked: use stored OH + stored split — no DNA search needed.
        const seq = savedOHs[ohKey];
        const { leftRest, rightRest } = savedLinkerSplits[ohKey];
        used.add(seq.toUpperCase()); used.add(dnaRc(seq));
        return { seq, leftRest, rightRest };
      }
      return splitLinker(l.dna.toUpperCase(), used, ohLen, avoid);
    });

    let ohLast: string;
    if (savedOHs?.["3' end"]) {
      ohLast = savedOHs["3' end"];
      used.add(ohLast.toUpperCase()); used.add(dnaRc(ohLast));
    } else {
      ohLast = freshOH(gcFrac, used, ohLen, avoid);
    }

    const allOhSeqs = [oh0, ...linkerSplits.map(s => s.seq), ohLast];
    const allOhNames = ["5' start", ...linkers.map(l => l.name), "3' end"];

    const seenCheck = new Map<string, number>();
    const conflictIdx = new Set<number>();
    for (let i = 0; i < allOhSeqs.length; i++) {
      for (const key of [allOhSeqs[i].toUpperCase(), dnaRc(allOhSeqs[i])]) {
        if (seenCheck.has(key)) { conflictIdx.add(i); conflictIdx.add(seenCheck.get(key)!); }
        else seenCheck.set(key, i);
      }
    }
    const overhangs = allOhSeqs.map((seq, i) => ({ name: allOhNames[i], seq, conflict: conflictIdx.has(i) }));

    const inserts: GGAInsert[] = parts.map((part, i) => {
      const isLast = i === parts.length - 1;
      const ohLeft = allOhSeqs[i];
      const ohRight = allOhSeqs[i + 1];
      const activeAlt = alternatives[part.name]?.[activeIndex[part.name] ?? 0];
      const partDna = (activeAlt?.dna ?? part.dna).toUpperCase();

      const prevRight = i > 0 ? linkerSplits[i - 1].rightRest : '';
      const nextLeft = !isLast ? linkerSplits[i].leftRest : '';
      const body = prevRight + partDna + nextLeft;

      const utrLeft = utrLength > 0 ? randomDnaClean(utrLength, gcFrac) : '';
      const utrRight = utrLength > 0 ? randomDnaClean(utrLength, gcFrac) : '';

      const warnings = [
        i > 0 ? linkerSplits[i - 1].warn : undefined,
        !isLast ? linkerSplits[i].warn : undefined,
      ].filter(Boolean);

      return {
        name: part.name,
        label: activeAlt?.label ?? part.name,
        ohLeft, ohRight, body, utrLeft, utrRight,
        insertDna: `${utrLeft}${enzyme.fwd}${ohLeft}${body}${ohRight}${enzyme.rev}${utrRight}`,
        partGcPct: calcGcPct(partDna),
        warning: warnings.length ? warnings.join('; ') : undefined,
      };
    });

    // Carry exact splits keyed by index so duplicate linker names don't cause collisions.
    const linkerSplitsRecord: Record<string, { leftRest: string; rightRest: string }> = {};
    for (let i = 0; i < linkers.length; i++) {
      linkerSplitsRecord[`linker_${i}`] = {
        leftRest: linkerSplits[i].leftRest,
        rightRest: linkerSplits[i].rightRest,
      };
    }

    return { overhangs, inserts, linkerSplits: linkerSplitsRecord };
  };

  const computeGGA = () => {
    if (savedOHs && savedLinkerSplits) {
      // Overhangs + splits are locked — inserts rebuild with current part DNAs, OHs stay fixed.
      setGgaResult(runGGA());
      return;
    }
    // First assembly: retry up to 10 times to find a conflict-free set.
    let best: GGAResult | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = runGGA();
      if (!r.overhangs.some(o => o.conflict)) {
        // Lock OH sequences (index-based for linkers) and exact splits from this run.
        const linkers = sortedRegions.filter(reg => reg.type === 'linker');
        const ohs: Record<string, string> = {};
        ohs["5' start"] = r.overhangs[0].seq;
        for (let i = 0; i < linkers.length; i++) ohs[`linker_${i}`] = r.overhangs[i + 1].seq;
        ohs["3' end"] = r.overhangs[r.overhangs.length - 1].seq;
        setSavedOHs(ohs);
        setSavedLinkerSplits(r.linkerSplits);
        setGgaResult(r);
        return;
      }
      best = r;
    }
    // Still conflicted after 10 tries — show result as-is without locking.
    setGgaResult(best);
  };

  const partColorMap = new Map<string, string>();
  const partLabelMap = new Map<string, string>();
  let partIdx = 0;
  for (const r of sortedRegions) {
    if (r.type === 'part') {
      partColorMap.set(r.name, PART_COLORS[partIdx % PART_COLORS.length]);
      partLabelMap.set(r.name, `P${partIdx + 1}`);
      partIdx++;
    }
  }

  const downloadFasta = () => {
    if (!ggaResult) return;
    const content = buildFasta(ggaResult);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'gga-assembly.fasta'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack mt="md">
      {/* Top bar */}
      <Group justify="space-between" align="flex-start">
        <Text size="sm" c="dimmed" style={{ flex: 1 }}>
          Click a version card to activate it in the construct. Use + to scramble a new alternative from the library or a custom sequence.
        </Text>
        <Group gap="xs" style={{ flexShrink: 0 }}>
          <Button size="xs" variant="subtle" color="gray" onClick={onRestart}>Restart</Button>
          <Button size="xs" variant="light" leftSection={<IconDownload size={14} />} onClick={exportSession}>
            Export session
          </Button>
        </Group>
      </Group>

      {/* Gene-map track */}
      <Box style={{ display: 'flex', width: '100%', gap: 3, alignItems: 'flex-start' }}>
        {sortedRegions.map(r => {
          const isPart = r.type === 'part';
          const baseAaLen = (baseRegionMap.get(r.name) ?? r).aa.length;
          const flexVal = Math.max(baseAaLen, isPart ? 8 : 5);
          const alts: Alternative[] = isPart ? (alternatives[r.name] ?? []) : [];
          const color = isPart ? (partColorMap.get(r.name) ?? PART_COLORS[0]) : '#fd7e14';

          return (
            <Box key={r.start}
              style={{ flex: flexVal, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
              <Box style={{
                height: 44, borderRadius: 4,
                backgroundColor: isPart ? 'white' : color,
                border: isPart ? `2.5px solid ${color}` : 'none',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                color: isPart ? color : 'white', overflow: 'hidden',
              }}>
                <Text size="xs" fw={800} lh={1.3}
                  style={{ maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.04em' }}>
                  {isPart ? (partLabelMap.get(r.name) ?? r.name) : r.name}
                </Text>
                <Text size="xs" lh={1.3} style={{ opacity: 0.65 }}>{r.aa.length} aa</Text>
              </Box>

              {alts.map((alt, ai) => {
                const active = isAltActive(r.name, ai);
                return (
                  <Tooltip key={ai} label={alt.aa} openDelay={500} position="bottom">
                    <Box onClick={() => activate(r.name, ai)} style={{
                      borderRadius: 4,
                      border: `2px solid ${active ? color : `${color}70`}`,
                      backgroundColor: active ? color : `${color}18`,
                      padding: '4px 6px', cursor: 'pointer', textAlign: 'center', overflow: 'hidden',
                      transition: 'background-color 120ms, border-color 120ms',
                    }}>
                      <Text size="xs" fw={600}
                        style={{ color: active ? 'white' : color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {alt.label}
                      </Text>
                      <Text size="xs"
                        style={{ fontFamily: 'monospace', color: active ? 'rgba(255,255,255,0.85)' : color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {alt.aa}
                      </Text>
                    </Box>
                  </Tooltip>
                );
              })}

              {isPart && (
                <Box style={{ display: 'flex', justifyContent: 'center' }}>
                  <ActionIcon size="sm" variant="light" color="blue"
                    onClick={() => openModal(r.name)} aria-label={`Add alternative for ${r.name}`}>
                    <IconPlus size={13} />
                  </ActionIcon>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Construct DNA */}
      <Box mt="xs">
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <Text size="sm" fw={500}>Construct ({result.dna.length} bp)</Text>
          <Group gap="xs">
            <Button size="xs" variant="subtle" color="green" leftSection={<IconDna2 size={12} />} onClick={exportGenbank}>
              Export .gb
            </Button>
            <CopyButton value={result.dna}>
              {({ copied, copy }) => (
                <Button size="xs" variant="subtle"
                  leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />} onClick={copy}>
                  {copied ? 'Copied' : 'Copy DNA'}
                </Button>
              )}
            </CopyButton>
            <Button size="xs" variant="subtle" color="gray" leftSection={<IconDna2 size={12} />}
              loading={rescrambling} onClick={rescramble}>
              Rescramble
            </Button>
          </Group>
        </Box>
        <Box style={{
          fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all',
          maxHeight: 120, overflowY: 'auto',
          backgroundColor: '#f8f9fa', padding: '8px 12px',
          borderRadius: 4, border: '1px solid #dee2e6', lineHeight: 1.6,
        }}>
          {sortedRegions.map(r => {
            const isPart = r.type === 'part';
            const c = isPart ? (partColorMap.get(r.name) ?? PART_COLORS[0]) : '#fd7e14';
            return (
              <span key={r.start} style={isPart
                ? { color: c }
                : { color: 'white', backgroundColor: c, borderRadius: 2, padding: '0 1px' }
              }>{r.dna}</span>
            );
          })}
        </Box>
      </Box>

      {/* Regions table */}
      <Table striped withTableBorder withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th><Table.Th>Type</Table.Th>
            <Table.Th>AA</Table.Th><Table.Th>Length</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sortedRegions.map(r => {
            const isPart = r.type === 'part';
            const color = isPart ? (partColorMap.get(r.name) ?? PART_COLORS[0]) : '#fd7e14';
            const alts = alternatives[r.name] ?? [];
            const activeLabel = isPart ? (alts[activeIndex[r.name] ?? 0]?.label ?? r.name) : r.name;
            return (
              <Table.Tr key={r.start}>
                <Table.Td><Badge color={color}>{activeLabel}</Badge></Table.Td>
                <Table.Td>{r.type}</Table.Td>
                <Table.Td><Code style={{ fontSize: 11 }}>{r.aa}</Code></Table.Td>
                <Table.Td>{r.dna.length} bp</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      {/* GGA Assembly */}
      <Divider mt="xl" mb="md" label="GGA Assembly" labelPosition="center" />

      <Box>
        <Group gap="xs">
          <Button leftSection={<IconDna size={14} />} color="violet" onClick={computeGGA} style={{ flex: 1 }}>
            {savedOHs ? 'Regenerate Assembly' : 'Create GGA Assembly'}
          </Button>
          <Button variant="light" color="gray" onClick={() => setOptionsOpen(true)}>
            Assembly Options
          </Button>
        </Group>

        <Modal opened={optionsOpen} onClose={() => setOptionsOpen(false)} title="Assembly Options" size="sm">
          <Stack gap="md">
            <Box>
              <Text size="sm" fw={500} mb={6}>Restriction enzyme</Text>
              <Stack gap={4}>
                {ENZYME_DEFS.map(e => (
                  <Box
                    key={e.key}
                    onClick={() => { setEnzymeKey(e.key); setSavedOHs(null); setSavedLinkerSplits(null); setGgaResult(null); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                      border: `1.5px solid ${enzymeKey === e.key ? '#228be6' : '#dee2e6'}`,
                      background: enzymeKey === e.key ? '#e7f5ff' : 'transparent',
                    }}
                  >
                    <Box style={{ flex: 1 }}>
                      <Text size="sm" fw={600}>{e.name}</Text>
                      <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>{e.site}</Text>
                    </Box>
                    {!e.typeIIS && (
                      <Text size="xs" c="orange">fixed OH</Text>
                    )}
                  </Box>
                ))}
              </Stack>
              {!ENZYME_DEFS.find(e => e.key === enzymeKey)?.typeIIS && (
                <Text size="xs" c="orange" mt={4}>
                  This enzyme has a fixed cut site — overhang sequences cannot be freely designed.
                </Text>
              )}
            </Box>
            <Box style={{ borderTop: '1px solid #dee2e6' }} pt="xs">
              <Group justify="space-between" mb={6}>
                <Text size="sm" fw={500}>Non-coding frame length</Text>
                <Text size="sm" c="dimmed">{utrLength} bp</Text>
              </Group>
              <Slider min={0} max={200} step={10} value={utrLength} onChange={setUtrLength} />
            </Box>
            <Box>
              <Group justify="space-between" mb={6}>
                <Text size="sm" fw={500}>Target GC content</Text>
                <Text size="sm" c="dimmed">{gcTarget}%</Text>
              </Group>
              <Slider min={20} max={80} step={5} value={gcTarget} onChange={setGcTarget} />
            </Box>
            {savedOHs && (
              <Box pt="xs" style={{ borderTop: '1px solid #dee2e6' }}>
                <Text size="sm" fw={500} mb={4}>Overhangs</Text>
                <Text size="xs" c="dimmed" mb={8}>
                  Overhangs are currently locked. Reset to generate a new set from scratch on the next assembly.
                </Text>
                <Button size="xs" color="red" variant="light" fullWidth
                  onClick={() => { setSavedOHs(null); setSavedLinkerSplits(null); setGgaResult(null); setOptionsOpen(false); }}>
                  Reset overhangs
                </Button>
              </Box>
            )}
          </Stack>
        </Modal>

        {ggaResult && (
          <Stack gap="sm" mt="md">
            {ggaResult.overhangs.some(o => o.conflict) && (
              <Alert color="red" variant="light">
                Overhang conflict detected after 10 attempts — overhangs overlap. Consider lengthening the affected linkers.
              </Alert>
            )}
            {ggaResult.inserts.some(ins => ins.warning) && (
              <Alert color="yellow" variant="light">
                {ggaResult.inserts.filter(ins => ins.warning).map(ins => ins.warning).join(' · ')}
              </Alert>
            )}

            {/* Overhangs */}
            <Box>
              <Group gap={6} mb={4}>
                <Text size="xs" fw={500}>Assembly overhangs</Text>
                {savedOHs && <Badge size="xs" color="violet" variant="light">locked</Badge>}
              </Group>
              <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {ggaResult.overhangs.map((oh, i) => (
                  <Box key={i} style={{
                    border: `1.5px solid ${oh.conflict ? '#fa5252' : '#dee2e6'}`,
                    borderRadius: 4, padding: '3px 8px',
                    backgroundColor: oh.conflict ? '#fff0f0' : '#f8f9fa',
                  }}>
                    <Text size="xs" c="dimmed" lh={1.2}>{oh.name}</Text>
                    <Text size="xs" ff="monospace" fw={700} c={oh.conflict ? 'red' : undefined} lh={1.4}>
                      {oh.seq}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>

            {/* Inserts summary table */}
            <Box>
              <Text size="xs" fw={500} mb={4}>Inserts</Text>
              <Table striped withTableBorder withColumnBorders>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Part</Table.Th>
                    <Table.Th>Part GC%</Table.Th>
                    <Table.Th>Left OH</Table.Th>
                    <Table.Th>Right OH</Table.Th>
                    <Table.Th>Total length</Table.Th>
                    <Table.Th>Copy</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {ggaResult.inserts.map((ins, i) => {
                    const color = partColorMap.get(ins.name) ?? PART_COLORS[0];
                    const gcDiff = Math.abs(ins.partGcPct - gcTarget);
                    const gcColor = gcDiff <= 10 ? 'green' : gcDiff <= 20 ? 'orange' : 'red';
                    return (
                      <Table.Tr key={i}>
                        <Table.Td><Badge color={color}>{ins.label}</Badge></Table.Td>
                        <Table.Td><Badge color={gcColor} variant="light">{ins.partGcPct}%</Badge></Table.Td>
                        <Table.Td><Code style={{ fontSize: 11 }}>{ins.ohLeft}</Code></Table.Td>
                        <Table.Td><Code style={{ fontSize: 11 }}>{ins.ohRight}</Code></Table.Td>
                        <Table.Td><Text size="xs">{ins.insertDna.length} bp</Text></Table.Td>
                        <Table.Td>
                          <CopyButton value={ins.insertDna}>
                            {({ copied, copy }) => (
                              <ActionIcon size="xs" variant="subtle" onClick={copy} color={copied ? 'teal' : 'gray'}>
                                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                              </ActionIcon>
                            )}
                          </CopyButton>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Box>

            {/* Per-insert sequence visualization */}
            <Box>
              <Text size="xs" fw={500} mb={6}>Sequence map</Text>
              <Stack gap={6}>
                {ggaResult.inserts.map((ins, i) => {
                  const color = partColorMap.get(ins.name) ?? PART_COLORS[0];
                  const H = 24;
                  // Truncate body for display — show start + end if too long
                  const bodyDisplay = ins.body.length > 36
                    ? ins.body.slice(0, 18) + '···' + ins.body.slice(-18)
                    : ins.body;
                  const seg = (text: string, bg: string, fg: string, extra?: React.CSSProperties) => (
                    <span style={{
                      fontFamily: 'monospace', fontSize: 10, lineHeight: `${H}px`,
                      padding: '0 4px', background: bg, color: fg,
                      display: 'inline-block', height: H, whiteSpace: 'nowrap',
                      ...extra,
                    }}>{text}</span>
                  );
                  return (
                    <Box key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Badge size="xs" color={color} style={{ flexShrink: 0, width: 36 }}>{ins.label}</Badge>
                      <Box style={{ flex: 1, overflowX: "scroll", overflowY: "hidden" }}>
                        <Box style={{ display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
                          {/* UTR left */}
                          {ins.utrLeft && seg(ins.utrLeft, '#e9ecef', '#868e96')}
                          {/* Recognition site */}
                          {seg((ENZYME_DEFS.find(e => e.key === enzymeKey) ?? ENZYME_DEFS[0]).fwd, '#ffe066', '#664d03', { fontWeight: 700 })}
                          {/* Left OH */}
                          {seg(ins.ohLeft.substring(0, 2), '#fff3e0', '#e67700', {
                            fontWeight: 700,
                            borderBottom: '1.5px solid #f59f004A',
                          })}
                          {seg(ins.ohLeft.substring(2, 0), '#fff3e0', '#e67700', {
                            fontWeight: 700,
                            borderTop: '1.5px solid #f59f004A',
                            borderLeft: '1.5px solid #f59f004A'
                          })}
                          {/* Part body */}
                          {seg(bodyDisplay, color + '28', color)}
                          {/* Right OH */}
                          {seg(ins.ohRight.substring(0, 2), '#fff3e0', '#e67700', {
                            fontWeight: 700,
                            borderBottom: '1.5px solid #f59f004A',
                          })}
                          {seg(ins.ohRight.substring(2, 0), '#fff3e0', '#e67700', {
                            fontWeight: 700,
                            borderTop: '1.5px solid #f59f004A',
                            borderLeft: '1.5px solid #f59f004A'
                          })}
                          {/* Recognition site */}
                          {seg((ENZYME_DEFS.find(e => e.key === enzymeKey) ?? ENZYME_DEFS[0]).rev, '#ffe066', '#664d03', { fontWeight: 700 })}
                          {/* UTR right */}
                          {ins.utrRight && seg(ins.utrRight, '#e9ecef', '#868e96')}
                        </Box>
                      </Box>
                    </Box>
                  );
                })}
              </Stack>
            </Box>

            {/* FASTA export */}
            <Group justify="flex-end">
              <CopyButton value={buildFasta(ggaResult)}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="light" color="blue"
                    leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    onClick={copy}>
                    {copied ? 'Copied!' : 'Copy FASTA'}
                  </Button>
                )}
              </CopyButton>
              <Button size="xs" variant="light" color="blue"
                leftSection={<IconDownload size={12} />}
                onClick={downloadFasta}>
                Download FASTA
              </Button>
            </Group>
          </Stack>
        )}
      </Box>

      {/* Add-version modal */}
      <Modal opened={modalPart !== null} onClose={closeModal}
        title={`Add version for ${modalPart}`} size="md">
        <Stack>
          <Radio.Group value={source} onChange={v => setSource(v as SwapSource)}>
            <Stack gap="sm">
              <Radio value="library" label="Part library" />
              <Radio value="custom" label="Enter a custom part" />
            </Stack>
          </Radio.Group>

          {source === 'library' && (
            <Stack gap="xs" mt="xs">
              {library.length > 0 ? library.map((p, i) => (
                <Button key={i} variant="light" color="blue" justify="flex-start"
                  onClick={() => doAdd(modalPart!, p.label, p.aa)} loading={loading}>
                  <Box style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
                    <Badge color="blue" variant="filled" size="sm">{p.label}</Badge>
                    <Code style={{ fontSize: 11, background: 'transparent', color: 'inherit', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.aa.slice(0, 28)}{p.aa.length > 28 ? '…' : ''}
                    </Code>
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{p.aa.length} aa</Text>
                  </Box>
                </Button>
              )) : (
                <Text size="sm" c="dimmed">No parts in library yet. Add a custom part first.</Text>
              )}
            </Stack>
          )}

          {source === 'custom' && (
            <Stack gap="xs" mt="xs">
              <TextInput label="Label" placeholder="e.g. ELP-V5"
                value={customLabel} onChange={e => setCustomLabel(e.target.value)} autoFocus />
              <Textarea label="Amino acid sequence" placeholder="e.g. VPGVGVPGIG…"
                value={customAa}
                onChange={e => {
                  const clean = e.target.value.toUpperCase().replace(/\s/g, '');
                  setCustomAa(clean);
                  const invalid = [...new Set(clean.split('').filter(c => !VALID_AA.has(c)))];
                  setAaError(invalid.length ? `Unknown characters: ${invalid.join(', ')}` : null);
                }}
                error={aaError}
                styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
                minRows={3} />
              <Button onClick={() => doAdd(modalPart!, customLabel.trim(), customAa, true)}
                disabled={!canAddCustom} loading={loading}>
                Add to construct &amp; library
              </Button>
            </Stack>
          )}

          {error && <Alert color="red" title="Error" mt="xs">{error}</Alert>}
        </Stack>
      </Modal>
    </Stack>
  );
}
