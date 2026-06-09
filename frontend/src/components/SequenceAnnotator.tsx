import { useCallback, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconInfoCircle, IconTrash } from '@tabler/icons-react';
import type { Region } from '../types';

function elpRepeatName(aa: string): string | null {
  if (aa.length === 0 || aa.length % 5 !== 0) return null;
  if (!/^(VPG.G)+$/.test(aa)) return null;
  const xs: string[] = [];
  for (let i = 0; i < aa.length; i += 5) xs.push(aa[i + 3]);
  return xs.join('');
}

function adjacentPartsIn(list: Region[]): boolean {
  for (let i = 0; i < list.length - 1; i++) {
    if (list[i].type === 'part' && list[i + 1].type === 'part') return true;
  }
  return false;
}

const COLOR_PART = '#228be6';
const COLOR_LINKER = '#fd7e14';
const COLOR_PREVIEW = '#ae3ec9';
const COLOR_NONE = '#dee2e6';
type SeqSeg =
  | { kind: 'char'; ch: string; idx: number }
  | { kind: 'repeat'; chars: { ch: string; idx: number }[] };

interface Props {
  sequence: string;
  regions: Region[];
  onBack: () => void;
  onNext: (regions: Region[]) => void;
}

export default function SequenceAnnotator({ sequence, regions: initRegions, onBack, onNext }: Props) {
  const [regions, setRegions] = useState<Region[]>(initRegions);
  const [selAnchor, setSelAnchor] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [pending, setPending] = useState<{ start: number; end: number } | null>(null);
  const [regionName, setRegionName] = useState('');
  const [regionType, setRegionType] = useState<'part' | 'linker'>((regions.length > 0 && regions[0].type === "part") ? "linker" : "part");
  const [overlap, setOverlap] = useState(false);

  const regionAt = useCallback(
    (idx: number) => regions.find(r => idx >= r.start && idx <= r.end),
    [regions]
  );

  const charBg = useCallback(
    (idx: number): string => {
      const r = regionAt(idx);
      if (r) return r.type === 'part' ? COLOR_PART : COLOR_LINKER;
      if (selAnchor !== null) {
        const lo = Math.min(selAnchor, hoverIdx ?? selAnchor);
        const hi = Math.max(selAnchor, hoverIdx ?? selAnchor);
        if (idx >= lo && idx <= hi) return COLOR_PREVIEW;
      }
      return COLOR_NONE;
    },
    [regions, selAnchor, hoverIdx, regionAt]
  );

  const handleCharClick = (idx: number) => {
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
        regionType === 'part'
          ? (elpRepeatName(sliceAa) ?? `P${regions.filter(r => r.type === 'part').length + 1}`)
          : `L${regions.filter(r => r.type === 'linker').length + 1}`;
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

  // Map each sequence position to its VPGXG repeat group index, or -1.
  const repeatGroupOf = useMemo<number[]>(() => {
    const groups = new Array(sequence.length).fill(-1);
    let gid = 0;
    for (let i = 0; i <= sequence.length - 5; i++) {
      if (groups[i] === -1 && /^VPG.G$/i.test(sequence.slice(i, i + 5))) {
        for (let j = 0; j < 5; j++) groups[i + j] = gid;
        gid++;
        i += 4;
      }
    }
    return groups;
  }, [sequence]);

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
      <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
        {isSelecting
          ? `Selecting from position ${selAnchor! + 1} — click another character to finish, or click the same to cancel.`
          : 'Click a character to start selecting a region, then click another to end it.'}
      </Alert>

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
                border: '1.5px solid rgba(0,0,0,0.18)',
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
        {[
          { color: COLOR_PART, label: 'Part (scrambled)' },
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
                  <Badge color={r.type === 'part' ? 'blue' : 'orange'}>{r.name}</Badge>
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
