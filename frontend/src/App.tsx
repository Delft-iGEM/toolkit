import { useState } from 'react';
import { MantineProvider, Container, Title, Text, Stepper, Group, Switch } from '@mantine/core';
import SequenceInput from './components/SequenceInput';
import SequenceAnnotator from './components/SequenceAnnotator';
import ResultsView from './components/ResultsView';
import PartSwapper from './components/PartSwapper';
import type { Region, ScrambleResult, WorkSession } from './types';
import { readRepeatMotif, writeRepeatMotif } from './repeat';

const FAST_MODE_ENABLED = false

export default function App() {
  const [active, setActive] = useState(0);
  const [sequence, setSequence] = useState('');
  const [regions, setRegions] = useState<Region[]>([]);
  const [result, setResult] = useState<ScrambleResult | null>(null);
  const [loadedSession, setLoadedSession] = useState<WorkSession | null>(null);
  const [fastMode, setFastMode] = useState(false);
  const [repeatMotif, setRepeatMotif] = useState<string>(() => readRepeatMotif());

  const handleRepeatMotifChange = (motif: string) => {
    const m = motif.toUpperCase();
    setRepeatMotif(m);
    writeRepeatMotif(m);
  };

  const handleSequenceNext = (seq: string) => {
    setSequence(seq);
    // Clear downstream state when sequence changes
    setRegions([]);
    setResult(null);
    setActive(1);
  };

  const handleAnnotateNext = (r: Region[]) => {
    setRegions(r);
    setResult(null);
    setActive(2);
  };

  const handleAssembleNext = (seq: string, r: Region[]) => {
    setSequence(seq);
    setRegions(r);
    setResult(null);
    setActive(2);
  };

  const handleLoadSession = (session: WorkSession) => {
    setSequence(session.sequence);
    setRegions(session.regions);
    setResult(session.result);
    setLoadedSession(session);
    setActive(3);
  };

  return (
    <MantineProvider>
      <Container size="lg" py="xl">
        <Group justify="space-between" align="flex-start" mb={active !== 3 ? 0 : 'xl'}>
          {active !== 3 && (
            <div>
              <Title order={1} mb={4}>ELP Toolkit</Title>
              <Text c="dimmed" size="sm">
                Design repetitive protein constructs with codon scrambling for Golden Gate Assembly
              </Text>
            </div>
          )}
          {active === 3 && <div />}
          {
            FAST_MODE_ENABLED && <Switch
              label="Fast mode"
              checked={fastMode}
              onChange={e => setFastMode(e.currentTarget.checked)}
              size="sm"
              mt={4}
            />
          }
        </Group>
        {active !== 3 && <>
          <Text mb="xl" />
          <Stepper active={active} mb="xl">
            <Stepper.Step label="Sequence" description="Enter protein" />
            <Stepper.Step label="Annotate" description="Parts & linkers" />
            <Stepper.Step label="Scramble" description="Generate DNA" />
            <Stepper.Step label="Swap" description="Replace parts" />
          </Stepper>
        </>}

        {active === 0 && (
          <SequenceInput
            sequence={sequence}
            onNext={handleSequenceNext}
            onAssemble={handleAssembleNext}
            onLoadSession={handleLoadSession}
            repeatMotif={repeatMotif}
            onRepeatMotifChange={handleRepeatMotifChange}
          />
        )}
        {active === 1 && (
          <SequenceAnnotator
            sequence={sequence}
            regions={regions}
            onBack={() => setActive(0)}
            onNext={handleAnnotateNext}
            repeatMotif={repeatMotif}
          />
        )}
        {active === 2 && (
          <ResultsView
            sequence={sequence}
            regions={regions}
            result={result}
            onResultChange={setResult}
            onBack={() => setActive(1)}
            onNext={() => setActive(3)}
            fastMode={fastMode}
          />
        )}
        {active === 3 && (
          <PartSwapper
            sequence={sequence}
            regions={regions}
            result={result}
            onResultChange={setResult}
            onRestart={() => { setSequence(''); setRegions([]); setResult(null); setLoadedSession(null); setActive(0); }}
            initialSession={loadedSession}
            fastMode={fastMode}
          />
        )}
      </Container>
    </MantineProvider>
  );
}
