import { useCallback, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconInfoCircle, IconTrash } from '@tabler/icons-react';
import type { Region } from '../types';
import { motifUnitRegex, motifUnitSource, motifVarPositions } from '../repeat';

// Build a short name from the variable (X) residues of a pure repeat run, e.g.
// "VPGMGVPGIG" with motif "VPGXG" → "MI". Returns null if `aa` isn't a whole
// number of repeat units or the motif has no variable position to name.
function elpRepeatName(aa: string, motif: string): string | null {
  const unitLen = motif.length;
  if (aa.length === 0 || aa.length % unitLen !== 0) return null;
  if (!new RegExp('^(' + motifUnitSource(motif) + ')+$', 'i').test(aa)) return null;
  const varPos = motifVarPositions(motif);
  if (varPos.length === 0) return null;
  const xs: string[] = [];
  for (let i = 0; i < aa.length; i += unitLen) {
    for (const p of varPos) xs.push(aa[i + p]);
  }
  return xs.join('');
}

function adjacentPartsIn(list: Region[]): boolean {
  for (let i = 0; i < list.length - 1; i++) {
    if (list[i].type === 'part' && list[i + 1].type === 'part') return true;
  }
  return false;
}

// Map each sequence position to its repeat-unit index, or -1 if the position
// isn't part of a repeat. Units are `motif.length` residues wide and share one
// id. The motif (e.g. "VPGXG") defines the unit length and matching pattern.
function computeRepeatGroups(sequence: string, motif: string): number[] {
  const unitLen = motif.length;
  const groups = new Array(sequence.length).fill(-1);
  if (unitLen < 1) return groups;
  const re = motifUnitRegex(motif);
  let gid = 0;
  for (let i = 0; i <= sequence.length - unitLen; i++) {
    if (groups[i] === -1 && re.test(sequence.slice(i, i + unitLen))) {
      for (let j = 0; j < unitLen; j++) groups[i + j] = gid;
      gid++;
      i += unitLen - 1;
    }
  }
  return groups;
}

// A cut at position `p` (the boundary between residues p-1 and p) is "clean"
// when it does not slice through the middle of a VPGXG repeat unit. Inside a
// unit all positions share one group id, so a same-id pair means a mid-unit cut.
function isCleanCut(groups: number[], p: number): boolean {
  if (p <= 0 || p >= groups.length) return false; // interior cuts only
  return !(groups[p - 1] === groups[p] && groups[p] >= 0);
}

// Snap a linker (starting at `p`, spanning `linkerLen` residues) to the nearest
// position where BOTH of its boundaries are clean cuts, so the whole linker sits
// between repeat units rather than slicing through one. Prefers the lower
// position on a tie; falls back to the original start if nothing qualifies.
function snapLinkerStart(groups: number[], p: number, linkerLen: number): number {
  const ok = (s: number) =>
    isCleanCut(groups, s) && isCleanCut(groups, s + linkerLen);
  if (ok(p)) return p;
  const n = groups.length;
  for (let d = 1; d < n; d++) {
    if (ok(p - d)) return p - d;
    if (ok(p + d)) return p + d;
  }
  return p;
}

// Evenly distribute `numParts` parts across the sequence, separated by
// fixed-length linkers. The leftover (after reserving linker space) is split as
// evenly as possible across the parts, with the remainder going to the earliest
// parts. When `repeatGroups` is provided ("prefer VPGXG ends"), each linker's
// boundaries are snapped to VPGXG repeat-unit edges so linkers sit between whole
// repeats instead of cutting through them. Parts are flagged `excludeFromLibrary`
// so auto-annotated constructs don't pollute the saved part library. Returns
// null if there isn't enough room for every part to be at least 1 aa.
function buildAutoRegions(
  seqLen: number,
  numParts: number,
  linkerLen: number,
  repeatGroups?: number[]
): Region[] | null {
  if (numParts < 1 || linkerLen < 0) return null;
  const numLinkers = numParts - 1;
  const partsTotal = seqLen - numLinkers * linkerLen;
  if (partsTotal < numParts) return null;

  const base = Math.floor(partsTotal / numParts);
  const extra = partsTotal % numParts;

  // Nominal linker start positions from the even split.
  const linkerStarts: number[] = [];
  let pos = 0;
  for (let i = 0; i < numParts; i++) {
    pos += base + (i < extra ? 1 : 0);
    if (i < numLinkers) {
      linkerStarts.push(pos);
      pos += linkerLen;
    }
  }

  // Snap linker boundaries onto repeat-unit edges when requested.
  if (repeatGroups) {
    for (let i = 0; i < numLinkers; i++) {
      linkerStarts[i] = snapLinkerStart(repeatGroups, linkerStarts[i], linkerLen);
    }
  }

  // Build regions from the (possibly snapped) linker spans, filling parts in
  // between. Bail out if snapping collapsed a part or overran the sequence.
  const regions: Region[] = [];
  let cursor = 0;
  for (let i = 0; i < numParts; i++) {
    const partEnd = i < numLinkers ? linkerStarts[i] : seqLen; // exclusive
    if (partEnd - cursor < 1) return null;
    regions.push({
      name: `P${i + 1}`,
      type: 'part',
      start: cursor,
      end: partEnd - 1,
      excludeFromLibrary: true,
    });
    if (i < numLinkers) {
      const ls = linkerStarts[i];
      const le = ls + linkerLen; // exclusive
      if (le > seqLen) return null;
      regions.push({
        name: `L${i + 1}`,
        type: 'linker',
        start: ls,
        end: le - 1,
        excludeFromLibrary: true,
      });
      cursor = le;
    }
  }
  return regions;
}

const COLOR_PART = '#228be6';
const COLOR_LINKER = '#fd7e14';
const COLOR_PREVIEW = '#ae3ec9';
const COLOR_NONE = '#dee2e6';

// Distinct colors assigned to parts by their sequence: identical part sequences
// share a color. First entry matches the old default part blue. The linker
// orange (#fd7e14) and selection purple (#ae3ec9) are intentionally excluded.
const PART_PALETTE = [
  '#228be6', // blue
  '#e64980', // pink
  '#12b886', // teal
  '#7950f2', // violet
  '#15aabf', // cyan
  '#82c91e', // lime
  '#4c6ef5', // indigo
  '#f59f00', // amber
  '#9c36b5', // grape
  '#0ca678', // green
];
type SeqSeg =
  | { kind: 'char'; ch: string; idx: number }
  | { kind: 'repeat'; chars: { ch: string; idx: number }[] };

interface Props {
  sequence: string;
  regions: Region[];
  onBack: () => void;
  onNext: (regions: Region[]) => void;
  repeatMotif: string;
}

export default function SequenceAnnotator({ sequence, regions: initRegions, onBack, onNext, repeatMotif }: Props) {
  const [regions, setRegions] = useState<Region[]>(initRegions);
  const [selAnchor, setSelAnchor] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [pending, setPending] = useState<{ start: number; end: number } | null>(null);
  const [regionName, setRegionName] = useState('');
  const [regionType, setRegionType] = useState<'part' | 'linker'>((regions.length > 0 && regions[0].type === "part") ? "linker" : "part");
  const [overlap, setOverlap] = useState(false);

  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  const [autoNumParts, setAutoNumParts] = useState<number>(2);
  const [autoLinkerLen, setAutoLinkerLen] = useState<number>(5);
  const [preferVpgxg, setPreferVpgxg] = useState<boolean>(false);

  // Map each sequence position to its repeat-unit index (or -1). Shared by the
  // auto-annotate snapping and the repeat-grouping in the sequence display.
  const repeatGroupOf = useMemo<number[]>(
    () => computeRepeatGroups(sequence, repeatMotif),
    [sequence, repeatMotif]
  );

  const hasRepeats = useMemo(() => repeatGroupOf.some(g => g >= 0), [repeatGroupOf]);

  const autoRegions = useMemo(
    () =>
      buildAutoRegions(
        sequence.length,
        autoNumParts,
        autoLinkerLen,
        preferVpgxg ? repeatGroupOf : undefined
      ),
    [sequence.length, autoNumParts, autoLinkerLen, preferVpgxg, repeatGroupOf]
  );

  const applyAuto = () => {
    if (autoRegions) setRegions(autoRegions);
  };

  const regionAt = useCallback(
    (idx: number) => regions.find(r => idx >= r.start && idx <= r.end),
    [regions]
  );

  // Map each distinct part sequence to a color (assigned by first appearance).
  const partColors = useMemo(() => {
    const map = new Map<string, string>();
    let next = 0;
    for (const r of regions) {
      if (r.type !== 'part') continue;
      const aa = sequence.slice(r.start, r.end + 1);
      if (!map.has(aa)) {
        map.set(aa, PART_PALETTE[next % PART_PALETTE.length]);
        next++;
      }
    }
    return map;
  }, [regions, sequence]);

  const partColorOf = useCallback(
    (r: Region) => partColors.get(sequence.slice(r.start, r.end + 1)) ?? COLOR_PART,
    [partColors, sequence]
  );

  // Distinct part sequences with their color and the region names sharing it.
  const uniqueParts = useMemo(() => {
    const seen = new Map<string, { color: string; names: string[] }>();
    for (const r of regions) {
      if (r.type !== 'part') continue;
      const aa = sequence.slice(r.start, r.end + 1);
      if (!seen.has(aa)) seen.set(aa, { color: partColorOf(r), names: [] });
      seen.get(aa)!.names.push(r.name);
    }
    return [...seen.values()];
  }, [regions, sequence, partColorOf]);

  const charBg = useCallback(
    (idx: number): string => {
      const r = regionAt(idx);
      if (r) return r.type === 'part' ? partColorOf(r) : COLOR_LINKER;
      if (selAnchor !== null) {
        const lo = Math.min(selAnchor, hoverIdx ?? selAnchor);
        const hi = Math.max(selAnchor, hoverIdx ?? selAnchor);
        if (idx >= lo && idx <= hi) return COLOR_PREVIEW;
      }
      return COLOR_NONE;
    },
    [selAnchor, hoverIdx, regionAt, partColorOf]
  );

  const handleCharClick = (idx: number) => {
    if (mode === 'auto') return;
    if (selAnchor === null) {
      setSelAnchor(idx);
    } else {
      const lo = Math.min(selAnchor, idx);
      const hi = Math.max(selAnchor, idx);
      const hasOverlap = regions.some(r => !(hi < r.start || lo > r.end));
      setOverlap(hasOverlap);
      setPending({ start: lo, end: hi });
      const sliceAa = sequence.slice(lo, hi + 1).toUpperCase();
      const suggestedName =
        elpRepeatName(sliceAa, repeatMotif) || (regionType === 'part'
          ? (`P${regions.filter(r => r.type === 'part').length + 1}`)
          : `L${regions.filter(r => r.type === 'linker').length + 1}`);
      setRegionName(suggestedName);
      setModalOpen(true);
      setSelAnchor(null);
      setHoverIdx(null);
    }
  };

  const handleAdd = () => {
    if (!pending || !regionName || overlap) return;
    setRegions(prev =>
      [...prev, { name: regionName, type: regionType, start: pending.start, end: pending.end }]
        .sort((a, b) => a.start - b.start)
    );
    setModalOpen(false);
    setPending(null);
  };

  const handleRemove = (name: string) => setRegions(prev => prev.filter(r => r.name !== name));

  // True when the candidate type + position would place two parts next to each other.
  const wouldCreateAdjacentParts = useMemo(() => {
    if (!pending || regionType !== 'part') return false;
    const candidate: Region = { name: '_', type: 'part', start: pending.start, end: pending.end };
    const sorted = [...regions, candidate].sort((a, b) => a.start - b.start);
    return adjacentPartsIn(sorted);
  }, [pending, regionType, regions]);

  // Violation across currently saved regions (can appear after a delete).
  const existingAdjacentParts = useMemo(() => adjacentPartsIn(regions), [regions]);

  const isSelecting = selAnchor !== null;
  const hasOverlapErr = overlap && modalOpen;

  const charBox = (ch: string, idx: number) => {
    const bg = charBg(idx);
    return (
      <Box
        key={idx}
        component="span"
        onClick={() => handleCharClick(idx)}
        onMouseEnter={() => isSelecting && setHoverIdx(idx)}
        onMouseLeave={() => isSelecting && setHoverIdx(null)}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 20, borderRadius: 2,
          backgroundColor: bg,
          color: bg === COLOR_NONE ? '#495057' : 'white',
          userSelect: 'none', transition: 'background-color 80ms',
        }}
      >
        {ch}
      </Box>
    );
  };

  const segments: SeqSeg[] = [];
  {
    let ci = 0;
    while (ci < sequence.length) {
      const gid = repeatGroupOf[ci];
      if (gid >= 0) {
        const group: { ch: string; idx: number }[] = [];
        while (ci < sequence.length && repeatGroupOf[ci] === gid) {
          group.push({ ch: sequence[ci], idx: ci });
          ci++;
        }
        segments.push({ kind: 'repeat', chars: group });
      } else {
        segments.push({ kind: 'char', ch: sequence[ci], idx: ci });
        ci++;
      }
    }
  }

  return (
    <Stack mt="md">
      <SegmentedControl
        data={[
          { label: 'Manual', value: 'manual' },
          { label: 'Auto-annotate', value: 'auto' },
        ]}
        value={mode}
        onChange={v => setMode(v as 'manual' | 'auto')}
      />

      {mode === 'auto' && (
        <Paper withBorder p="md" radius="md">
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Evenly splits the sequence into parts separated by fixed-length
              linkers. Parts created this way are not added to the part library.
            </Text>
            <Group align="flex-end" gap="md">
              <NumberInput
                label="Number of parts"
                value={autoNumParts}
                onChange={v => setAutoNumParts(Math.max(1, Number(v) || 1))}
                min={1}
                step={1}
                w={150}
              />
              <NumberInput
                label="Linker length (aa)"
                value={autoLinkerLen}
                onChange={v => setAutoLinkerLen(Math.max(0, Number(v) || 0))}
                min={0}
                step={1}
                w={150}
              />
              <Button onClick={applyAuto} disabled={!autoRegions}>
                Apply
              </Button>
            </Group>
            <Checkbox
              label={`Prefer ${repeatMotif} ends`}
              description={`Snap linker boundaries to ${repeatMotif} repeat-unit edges so linkers sit between whole repeats instead of cutting through one.`}
              checked={preferVpgxg}
              onChange={e => setPreferVpgxg(e.currentTarget.checked)}
              disabled={!hasRepeats}
            />
            {preferVpgxg && !hasRepeats && (
              <Text size="sm" c="dimmed">
                No {repeatMotif} repeats detected in this sequence.
              </Text>
            )}
            {!autoRegions && (
              <Text size="sm" c="red">
                Sequence is too short for {autoNumParts} part
                {autoNumParts === 1 ? '' : 's'} with {autoLinkerLen}-aa linkers.
              </Text>
            )}
          </Stack>
        </Paper>
      )}

      {mode === 'manual' && (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
          {isSelecting
            ? `Selecting from position ${selAnchor! + 1} — click another character to finish, or click the same to cancel.`
            : 'Click a character to start selecting a region, then click another to end it.'}
        </Alert>
      )}

      {/* Sequence display */}
      <Box
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 1,
          fontFamily: 'monospace', fontSize: 13,
          cursor: isSelecting ? 'crosshair' : 'default',
        }}
      >
        {segments.map(seg =>
          seg.kind === 'repeat' ? (
            <Box
              key={`r${seg.chars[0].idx}`}
              style={{
                display: 'inline-flex', gap: 1,
                border: '1.5px solid rgb(0, 0, 0)',
                borderRadius: 4, padding: '0 1px',
              }}
            >
              {seg.chars.map(({ ch, idx }) => charBox(ch, idx))}
            </Box>
          ) : (
            charBox(seg.ch, seg.idx)
          )
        )}
      </Box>

      {/* Legend */}
      <Group gap="md">
        {uniqueParts.map(p => (
          <Group key={p.names.join(',')} gap={6}>
            <Box style={{ width: 14, height: 14, backgroundColor: p.color, borderRadius: 2 }} />
            <Text size="xs">Part {p.names.join(', ')}</Text>
          </Group>
        ))}
        {[
          { color: COLOR_LINKER, label: 'Linker (anchored)' },
          { color: COLOR_PREVIEW, label: 'Selection' },
          { color: COLOR_NONE, label: 'Unannotated' },
        ].map(({ color, label }) => (
          <Group key={label} gap={6}>
            <Box style={{ width: 14, height: 14, backgroundColor: color, borderRadius: 2 }} />
            <Text size="xs">{label}</Text>
          </Group>
        ))}
      </Group>

      {/* Adjacent-parts violation */}
      {existingAdjacentParts && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
          Two parts are adjacent with no linker between them. Add a linker between every consecutive pair of parts.
        </Alert>
      )}

      {/* Regions table */}
      {regions.length > 0 && (
        <Table striped withTableBorder withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Range</Table.Th>
              <Table.Th>Length</Table.Th>
              <Table.Th>Sequence</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {regions.map(r => (
              <Table.Tr key={r.name}>
                <Table.Td>
                  {r.type === 'part' ? (
                    <Badge style={{ backgroundColor: partColorOf(r), color: 'white' }}>{r.name}</Badge>
                  ) : (
                    <Badge color="orange">{r.name}</Badge>
                  )}
                </Table.Td>
                <Table.Td>{r.type}</Table.Td>
                <Table.Td>{r.start + 1}–{r.end + 1}</Table.Td>
                <Table.Td>{r.end - r.start + 1} aa</Table.Td>
                <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {sequence.slice(r.start, r.end + 1)}
                </Table.Td>
                <Table.Td>
                  <ActionIcon color="red" variant="subtle" onClick={() => handleRemove(r.name)}>
                    <IconTrash size={15} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {/* Add region modal */}
      <Modal
        opened={modalOpen}
        onClose={() => { setModalOpen(false); setPending(null); }}
        title="Define region"
        size="sm"
      >
        {pending && (
          <Stack>
            <Text size="sm" c="dimmed">
              Positions {pending.start + 1}–{pending.end + 1} · {pending.end - pending.start + 1} aa
            </Text>
            <Text size="sm" style={{ fontFamily: 'monospace', letterSpacing: 1 }}>
              {sequence.slice(pending.start, pending.end + 1)}
            </Text>
            {hasOverlapErr && (
              <Text size="sm" c="red">This range overlaps an existing region.</Text>
            )}
            {wouldCreateAdjacentParts && (
              <Text size="sm" c="red">
                Two parts would be adjacent — add a linker between consecutive parts.
              </Text>
            )}
            <SegmentedControl
              data={[
                { label: 'Part', value: 'part' },
                { label: 'Linker', value: 'linker' },
              ]}
              value={regionType}
              onChange={v => setRegionType(v as 'part' | 'linker')}
              fullWidth
            />
            <TextInput
              label="Name"
              value={regionName}
              onChange={e => setRegionName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              autoFocus
            />
            <Button onClick={handleAdd} disabled={!regionName || hasOverlapErr || wouldCreateAdjacentParts}>
              Add region
            </Button>
          </Stack>
        )}
      </Modal>

      <Group justify="space-between" mt="xl">
        <Button variant="outline" onClick={onBack}>← Back</Button>
        <Button onClick={() => onNext(regions)} disabled={regions.length === 0 || existingAdjacentParts}>
          Next: Scramble →
        </Button>
      </Group>
    </Stack>
  );
}
