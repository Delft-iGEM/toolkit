import { useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  CopyButton,
  Group,
  Loader,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { IconCheck, IconCopy, IconDownload } from '@tabler/icons-react';
import { scrambleConstruct } from '../api';
import type { Region, ScrambleResult } from '../types';

interface Props {
  sequence: string;
  regions: Region[];
  result: ScrambleResult | null;
  onResultChange: (r: ScrambleResult) => void;
  onBack: () => void;
  onNext: () => void;
  fastMode?: boolean;
}

export default function ResultsView({
  sequence,
  regions,
  result,
  onResultChange,
  onBack,
  onNext,
  fastMode = false,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleScramble = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await scrambleConstruct(sequence, regions, fastMode);
      onResultChange(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (!result) return;
    const lines = [
      '>full_construct',
      result.dna,
      '',
      ...result.regions.flatMap(r => [`>${r.name}_${r.type}`, r.dna, '']),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'construct.fasta';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack mt="md">
      {!result && !loading && (
        <Button size="md" onClick={handleScramble}>
          Run codon scrambler
        </Button>
      )}

      {loading && (
        <Group>
          <Loader size="sm" />
          <Text size="sm" c="dimmed">Running MILP solver — this may take a moment…</Text>
        </Group>
      )}

      {error && (
        <Alert color="red" title="Error">
          {error}
        </Alert>
      )}

      {result && (
        <>
          <Group>
            <Badge color="green">Solver: {result.status}</Badge>
            <Badge color="gray" variant="light">Objective: {result.objective.toFixed(4)}</Badge>
            <Badge color="blue" variant="light">{result.dna.length} bp</Badge>
          </Group>

          {/* Full DNA */}
          <Box>
            <Group justify="space-between" mb={6}>
              <Text fw={500} size="sm">Full DNA sequence</Text>
              <Group gap="xs">
                <CopyButton value={result.dna}>
                  {({ copied, copy }) => (
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                      onClick={copy}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  )}
                </CopyButton>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconDownload size={13} />}
                  onClick={handleDownload}
                >
                  FASTA
                </Button>
              </Group>
            </Group>
            <Code
              block
              style={{
                wordBreak: 'break-all',
                maxHeight: 120,
                overflowY: 'auto',
                fontSize: 12,
              }}
            >
              {result.dna}
            </Code>
          </Box>

          {/* Per-region table */}
          <Table striped withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>AA</Table.Th>
                <Table.Th>DNA</Table.Th>
                <Table.Th>Length</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {result.regions.map(r => (
                <Table.Tr key={r.name}>
                  <Table.Td>
                    <Badge color={r.type === 'part' ? 'blue' : 'orange'}>{r.name}</Badge>
                  </Table.Td>
                  <Table.Td>{r.type}</Table.Td>
                  <Table.Td>
                    <Code style={{ fontSize: 11 }}>{r.aa}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Code
                      style={{
                        fontSize: 11,
                        wordBreak: 'break-all',
                        maxWidth: 280,
                        display: 'block',
                      }}
                    >
                      {r.dna}
                    </Code>
                  </Table.Td>
                  <Table.Td>{r.dna.length} bp</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          <Button variant="subtle" size="xs" onClick={handleScramble} loading={loading}>
            Re-scramble
          </Button>
        </>
      )}

      <Group justify="space-between" mt="xl">
        <Button variant="outline" onClick={onBack}>← Back</Button>
        <Button onClick={onNext} disabled={!result}>
          Next: Swap parts →
        </Button>
      </Group>
    </Stack>
  );
}
