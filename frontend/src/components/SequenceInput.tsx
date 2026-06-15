import { useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Modal,
  Radio,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconSettings, IconTrash, IconUpload } from '@tabler/icons-react';
import type { Region, WorkSession } from '../types';
import { DEFAULT_MOTIF, validateMotif } from '../repeat';

const VALID_AA = new Set('ACDEFGHIKLMNPQRSTVWY*');

type Piece = { id: number; name: string; type: 'part' | 'linker'; aa: string };
type LibraryPart = { label: string; aa: string };

function readLibrary(): LibraryPart[] {
  try { return JSON.parse(localStorage.getItem('elp-part-library') ?? '[]'); }
  catch { return []; }
}

function writeLibrary(lib: LibraryPart[]) {
  localStorage.setItem('elp-part-library', JSON.stringify(lib));
}

interface Props {
  sequence: string;
  onNext: (sequence: string) => void;
  onAssemble?: (sequence: string, regions: Region[]) => void;
  onLoadSession?: (session: WorkSession) => void;
  repeatMotif: string;
  onRepeatMotifChange: (motif: string) => void;
}

let _pid = 0;
const nextId = () => ++_pid;

export default function SequenceInput({ sequence, onNext, onAssemble, onLoadSession, repeatMotif, onRepeatMotifChange }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  // ── Repeat-motif settings ─────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [motifDraft, setMotifDraft] = useState(repeatMotif);
  const motifError = validateMotif(motifDraft);

  const openSettings = () => {
    setMotifDraft(repeatMotif);
    setSettingsOpen(true);
  };
  const saveSettings = () => {
    if (motifError) return;
    onRepeatMotifChange(motifDraft.trim().toUpperCase());
    setSettingsOpen(false);
  };

  // ── Sequence mode ────────────────────────────────────────────────────────
  const [value, setValue] = useState(sequence);
  const [seqError, setSeqError] = useState<string | null>(null);

  const handleChange = (raw: string) => {
    const clean = raw.toUpperCase().replace(/\s/g, '');
    setValue(clean);
    const invalid = [...new Set(clean.split('').filter(c => !VALID_AA.has(c)))];
    setSeqError(invalid.length ? `Unknown characters: ${invalid.join(', ')}` : null);
  };

  const isValid = value.length >= 4 && !seqError;

  const [sessionError, setSessionError] = useState<string | null>(null);

  const handleFileLoad = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const session = JSON.parse(ev.target?.result as string) as WorkSession;
        if (session.version !== 1 || !session.result || !session.regions) {
          setSessionError('Invalid session file.');
          return;
        }
        setSessionError(null);
        onLoadSession?.(session);
      } catch {
        setSessionError('Could not parse session file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // ── Parts mode ───────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'sequence' | 'parts'>('sequence');
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [pieceType, setPieceType] = useState<'part' | 'linker'>('part');
  const [pieceSource, setPieceSource] = useState<'library' | 'custom'>('library');
  const [pieceName, setPieceName] = useState('');
  const [pieceAa, setPieceAa] = useState('');
  const [pieceAaError, setPieceAaError] = useState<string | null>(null);

  const library = readLibrary();

  const partCount   = pieces.filter(p => p.type === 'part').length;
  const linkerCount = pieces.filter(p => p.type === 'linker').length;

  const openModal = (type: 'part' | 'linker') => {
    setPieceType(type);
    setPieceSource('library');
    setPieceName('');
    setPieceAa('');
    setPieceAaError(null);
    setModalOpen(true);
  };

  const addFromLibrary = (item: LibraryPart) => {
    const autoName = pieceType === 'part'
      ? `P${partCount + 1}`
      : `L${linkerCount + 1}`;
    setPieces(prev => [...prev, { id: nextId(), name: item.label || autoName, type: pieceType, aa: item.aa }]);
    setModalOpen(false);
  };

  const addCustom = () => {
    if (pieceAaError || pieceAa.length < 1) return;
    const autoName = pieceType === 'part'
      ? `P${partCount + 1}`
      : `L${linkerCount + 1}`;
    const label = pieceName.trim() || autoName;
    // Save to library
    const lib = readLibrary();
    if (!lib.some(p => p.aa === pieceAa)) {
      writeLibrary([...lib, { label, aa: pieceAa }]);
    }
    setPieces(prev => [...prev, { id: nextId(), name: label, type: pieceType, aa: pieceAa }]);
    setModalOpen(false);
  };

  const removePiece = (id: number) => setPieces(prev => prev.filter(p => p.id !== id));

  const assembledSeq = pieces.map(p => p.aa).join('');
  const assembledRegions: Region[] = [];
  let pos = 0;
  for (const p of pieces) {
    assembledRegions.push({ name: p.name, type: p.type, start: pos, end: pos + p.aa.length - 1 });
    pos += p.aa.length;
  }

  const hasAdjacentParts = pieces.some((p, i) => p.type === 'part' && i > 0 && pieces[i - 1].type === 'part');
  const canAssemble = pieces.length > 0 && assembledSeq.length >= 4 && !hasAdjacentParts;

  const settingsModal = (
    <Modal
      opened={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      title="Repeat settings"
      size="sm"
    >
      <Stack>
        <TextInput
          label="Repeat motif"
          description="Use X for the variable residue (wildcard). The unit length follows the motif length. Default: VPGXG."
          value={motifDraft}
          onChange={e => setMotifDraft(e.target.value.toUpperCase().replace(/\s/g, ''))}
          onKeyDown={e => e.key === 'Enter' && saveSettings()}
          error={motifError}
          placeholder={DEFAULT_MOTIF}
          styles={{ input: { fontFamily: 'monospace', letterSpacing: 1 } }}
          autoFocus
        />
        <Group justify="space-between">
          <Button variant="subtle" color="gray" onClick={() => setMotifDraft(DEFAULT_MOTIF)}>
            Reset to default
          </Button>
          <Button onClick={saveSettings} disabled={!!motifError}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );

  const settingsBar = (
    <Group justify="flex-end" mb={-8}>
      <ActionIcon
        variant="subtle"
        color="gray"
        onClick={openSettings}
        aria-label="Repeat settings"
        title={`Repeat motif: ${repeatMotif}`}
      >
        <IconSettings size={18} />
      </ActionIcon>
    </Group>
  );

  if (mode === 'parts') {
    return (
      <Stack mt="md">
        {settingsBar}
        {settingsModal}
        {/* Pieces list */}
        {pieces.length === 0 ? (
          <Text size="sm" c="dimmed">No pieces yet — add a part or linker below.</Text>
        ) : (
          <Stack gap="xs">
            {pieces.map(p => (
              <Box key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Badge color={p.type === 'part' ? 'blue' : 'orange'} style={{ flexShrink: 0 }}>
                  {p.type === 'part' ? 'Part' : 'Linker'}
                </Badge>
                <Text size="sm" fw={600} style={{ flexShrink: 0 }}>{p.name}</Text>
                <Code style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.aa}
                </Code>
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{p.aa.length} aa</Text>
                <ActionIcon size="sm" color="red" variant="subtle" onClick={() => removePiece(p.id)}>
                  <IconTrash size={13} />
                </ActionIcon>
              </Box>
            ))}
          </Stack>
        )}

        {hasAdjacentParts && (
          <Alert color="red" variant="light">
            Two parts are adjacent — add a linker between consecutive parts.
          </Alert>
        )}

        {/* Add buttons */}
        <Group gap="xs">
          <Button size="xs" variant="light" color="blue" leftSection={<IconPlus size={13} />}
            onClick={() => openModal('part')}>
            Add Part
          </Button>
          <Button size="xs" variant="light" color="orange" leftSection={<IconPlus size={13} />}
            onClick={() => openModal('linker')}>
            Add Linker
          </Button>
        </Group>

        {assembledSeq.length > 0 && (
          <Box>
            <Text size="xs" c="dimmed" mb={4}>Assembled sequence ({assembledSeq.length} aa)</Text>
            <Code block style={{ fontSize: 11, wordBreak: 'break-all' }}>{assembledSeq}</Code>
          </Box>
        )}

        <Group justify="space-between" mt="md">
          <Button variant="subtle" size="xs" onClick={() => setMode('sequence')}>
            ← Enter sequence manually
          </Button>
          <Button
            onClick={() => onAssemble?.(assembledSeq, assembledRegions)}
            disabled={!canAssemble}>
            Next: Scramble →
          </Button>
        </Group>

        {/* Add piece modal */}
        <Modal opened={modalOpen} onClose={() => setModalOpen(false)}
          title={`Add ${pieceType === 'part' ? 'Part' : 'Linker'}`} size="md">
          <Stack>
            <Radio.Group value={pieceSource} onChange={v => setPieceSource(v as 'library' | 'custom')}>
              <Stack gap="sm">
                <Radio value="library" label="From part library" />
                <Radio value="custom" label="Enter custom sequence" />
              </Stack>
            </Radio.Group>

            {pieceSource === 'library' && (
              <Stack gap="xs" mt="xs">
                {library.length > 0 ? library.map((item, i) => (
                  <Button key={i} variant="light" color="blue" justify="flex-start"
                    onClick={() => addFromLibrary(item)}>
                    <Box style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
                      <Badge color="blue" variant="filled" size="sm">{item.label}</Badge>
                      <Code style={{ fontSize: 11, background: 'transparent', color: 'inherit', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.aa.slice(0, 32)}{item.aa.length > 32 ? '…' : ''}
                      </Code>
                      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{item.aa.length} aa</Text>
                    </Box>
                  </Button>
                )) : (
                  <Text size="sm" c="dimmed">Library is empty. Use "Enter custom sequence" or add parts from the Swap step.</Text>
                )}
              </Stack>
            )}

            {pieceSource === 'custom' && (
              <Stack gap="xs" mt="xs">
                <TextInput
                  label="Name"
                  placeholder={pieceType === 'part' ? `P${partCount + 1}` : `L${linkerCount + 1}`}
                  value={pieceName}
                  onChange={e => setPieceName(e.target.value)}
                  autoFocus
                />
                <Textarea
                  label="Amino acid sequence"
                  placeholder="VPGVGVPGIG…"
                  value={pieceAa}
                  onChange={e => {
                    const clean = e.target.value.toUpperCase().replace(/\s/g, '');
                    setPieceAa(clean);
                    const invalid = [...new Set(clean.split('').filter(c => !VALID_AA.has(c)))];
                    if (invalid.length) {
                      setPieceAaError(`Unknown: ${invalid.join(', ')}`);
                    } else {
                      const dup = readLibrary().find(p => p.aa === clean);
                      setPieceAaError(dup ? `Already in library as "${dup.label}"` : null);
                    }
                  }}
                  error={pieceAaError}
                  styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
                  minRows={3}
                />
                <Button onClick={addCustom} disabled={pieceAa.length < 1 || !!pieceAaError}>
                  Add to construct &amp; library
                </Button>
              </Stack>
            )}
          </Stack>
        </Modal>
      </Stack>
    );
  }

  // ── Sequence mode (default) ───────────────────────────────────────────────
  return (
    <Stack mt="md">
      {settingsBar}
      {settingsModal}
      <Textarea
        label="Amino acid sequence"
        description="Single-letter codes — standard 20 AAs plus stop codon (*)"
        placeholder="VPGVGVPGVGVPGVG..."
        value={value}
        onChange={e => handleChange(e.target.value)}
        styles={{ input: { fontFamily: 'monospace', fontSize: 14 } }}
        minRows={6}
        error={seqError}
        autoFocus
      />

      {value.length > 0 && (
        <Group>
          <Badge variant="light" color={isValid ? 'green' : 'red'}>
            {value.length} residues
          </Badge>
          {value.length < 4 && (
            <Text size="xs" c="dimmed">Minimum length: 4 residues</Text>
          )}
        </Group>
      )}

      <Group justify="flex-end" mt="md">
        <Button onClick={() => onNext(value)} disabled={!isValid}>
          Next: Annotate →
        </Button>
      </Group>

      <Divider label="OR" labelPosition="center" my="xs" />

      <Button variant="light" color="indigo" onClick={() => setMode('parts')}>
        Assemble by Parts
      </Button>

      <Divider label="OR" labelPosition="center" my="xs" />

      <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFileLoad} />
      <Button variant="light" color="teal" leftSection={<IconUpload size={14} />}
        onClick={() => fileRef.current?.click()}>
        Load work session
      </Button>
      {sessionError && <Alert color="red" variant="light">{sessionError}</Alert>}
    </Stack>
  );
}
