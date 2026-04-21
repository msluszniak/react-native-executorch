import React, { useState, useRef, useCallback } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  initExecutorch,
  useLLM,
  LLAMA3_2_1B_SPINQUANT,
  RnExecutorchError,
  RnExecutorchErrorCode,
} from 'react-native-executorch';
import { BareResourceFetcher } from 'react-native-executorch-bare-resource-fetcher';
import { setConfig } from '@kesha-antonov/react-native-background-downloader';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

setConfig({
  isLogsEnabled: true,
  logCallback: log => console.log('[BackgroundDownloader]', log),
});

initExecutorch({ resourceFetcher: BareResourceFetcher });

const HF_BASE =
  'https://huggingface.co/software-mansion/react-native-executorch-llama-3.2/resolve/v0.6.0';
const TOKENIZER = `${HF_BASE}/tokenizer.json`;
const TOKENIZER_CFG = `${HF_BASE}/tokenizer_config.json`;
const BIG_MODEL = LLAMA3_2_1B_SPINQUANT.modelSource;

type LogEntry = { ts: string; text: string; kind: 'info' | 'ok' | 'err' };
type Mode = 'tests' | 'chat';

function Harness({ switchToChat }: { switchToChat: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [bgWatchActive, setBgWatchActive] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const push = useCallback((text: string, kind: LogEntry['kind'] = 'info') => {
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { ts, text, kind }]);
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setProgress(0);
    try {
      await fn();
    } catch (e: any) {
      push(`${label} unexpected: ${e?.message ?? String(e)}`, 'err');
    } finally {
      setBusy(null);
    }
  };

  const short = (p: string) => p.split('/').slice(-2).join('/');

  const T1 = () =>
    run('T1 fetch single', async () => {
      push('T1: fetching tokenizer.json…');
      const { paths, wasDownloaded } = await BareResourceFetcher.fetch(
        setProgress,
        TOKENIZER,
      );
      push(
        `T1 OK  path=${short(paths[0])} wasDownloaded=${wasDownloaded[0]}`,
        'ok',
      );
    });

  const T2 = () =>
    run('T2 fetch multi', async () => {
      push('T2: fetching tokenizer + tokenizer_config…');
      const { paths, wasDownloaded } = await BareResourceFetcher.fetch(
        setProgress,
        TOKENIZER,
        TOKENIZER_CFG,
      );
      push(
        `T2 OK  count=${paths.length} wasDownloaded=[${wasDownloaded.join(',')}]`,
        'ok',
      );
      paths.forEach(p => push(`    ${short(p)}`));
    });

  const T3 = () =>
    run('T3 cancel', async () => {
      push('T3: starting LARGE model fetch; will cancel in 2s…');
      const fetchPromise = BareResourceFetcher.fetch(setProgress, BIG_MODEL);
      setTimeout(async () => {
        try {
          await BareResourceFetcher.cancelFetching(BIG_MODEL);
          push('T3: cancelFetching() returned');
        } catch (e: any) {
          push(`T3 cancelFetching threw: ${e?.message}`, 'err');
        }
      }, 2000);
      try {
        const res = await fetchPromise;
        push(
          `T3 FAIL  expected throw but fetch resolved with ${res.paths.length} paths`,
          'err',
        );
      } catch (e: any) {
        const isExec = e instanceof RnExecutorchError;
        const code = isExec ? e.code : undefined;
        const match = code === RnExecutorchErrorCode.DownloadInterrupted;
        push(
          `T3 ${match ? 'OK' : 'FAIL'}  threw code=${code ?? '?'} msg="${e?.message}"`,
          match ? 'ok' : 'err',
        );
      }
    });

  const T4 = () =>
    run('T4 model load', async () => {
      push('T4: switching to Chat screen; useLLM will consume cached files.');
      switchToChat();
    });

  const T5list = () =>
    run('T5 list', async () => {
      const files = await BareResourceFetcher.listDownloadedFiles();
      const models = await BareResourceFetcher.listDownloadedModels();
      push(`T5 list  files=${files.length} models=${models.length}`, 'ok');
      files.forEach(f => push(`    ${short(f)}`));
    });

  const T5delete = () =>
    run('T5 delete', async () => {
      push('T5: deleting tokenizer + tokenizer_config…');
      await BareResourceFetcher.deleteResources(TOKENIZER, TOKENIZER_CFG);
      const files = await BareResourceFetcher.listDownloadedFiles();
      const remaining = files.filter(
        f =>
          f.endsWith('tokenizer.json') || f.endsWith('tokenizer_config.json'),
      );
      push(
        `T5 ${remaining.length === 0 ? 'OK' : 'FAIL'}  tokenizer entries remaining=${remaining.length}`,
        remaining.length === 0 ? 'ok' : 'err',
      );
    });

  const T6 = () =>
    run('T6 background', async () => {
      push('T6: wiping cached PTE to force a real download…');
      await BareResourceFetcher.deleteResources(BIG_MODEL);
      push(
        'T6: starting big model fetch. Send app to background (Cmd+Shift+H) to test resumable downloads; foreground to see final status.',
      );
      setBgWatchActive(true);
      const sub = AppState.addEventListener('change', s =>
        push(`T6 AppState=${s}`),
      );
      try {
        const { paths, wasDownloaded } = await BareResourceFetcher.fetch(
          setProgress,
          BIG_MODEL,
        );
        push(
          `T6 OK  downloaded=${wasDownloaded[0]} path=${short(paths[0])}`,
          'ok',
        );
      } catch (e: any) {
        push(`T6 ended: ${e?.message}`, 'err');
      } finally {
        sub.remove();
        setBgWatchActive(false);
      }
    });

  const progressRef = useRef(0);
  const trackProgress = (p: number) => {
    progressRef.current = p;
    setProgress(p);
  };

  const T7 = () =>
    run('T7 pause/resume', async () => {
      push('T7: wiping cached PTE to get an active download…');
      await BareResourceFetcher.deleteResources(BIG_MODEL);
      progressRef.current = 0;

      push('T7: starting fetch (not awaiting)…');
      const fetchPromise = BareResourceFetcher.fetch(trackProgress, BIG_MODEL);

      const sleep = (ms: number) =>
        new Promise<void>(r => setTimeout(() => r(), ms));
      await sleep(3000);
      const pAtPause = progressRef.current;
      push(`T7: progress before pause = ${(pAtPause * 100).toFixed(2)}%`);

      try {
        await BareResourceFetcher.pauseFetching(BIG_MODEL);
        push('T7: pauseFetching() returned', 'ok');
      } catch (e: any) {
        push(`T7 FAIL pause threw: code=${e?.code} ${e?.message}`, 'err');
        await BareResourceFetcher.cancelFetching(BIG_MODEL).catch(() => {});
        await fetchPromise.catch(() => {});
        return;
      }

      await sleep(3000);
      const pAfterPause = progressRef.current;
      push(
        `T7: progress after 3s paused = ${(pAfterPause * 100).toFixed(2)}% (delta ${((pAfterPause - pAtPause) * 100).toFixed(3)}%)`,
        Math.abs(pAfterPause - pAtPause) < 0.005 ? 'ok' : 'err',
      );

      try {
        await BareResourceFetcher.resumeFetching(BIG_MODEL);
        push('T7: resumeFetching() returned', 'ok');
      } catch (e: any) {
        push(`T7 FAIL resume threw: code=${e?.code} ${e?.message}`, 'err');
        await BareResourceFetcher.cancelFetching(BIG_MODEL).catch(() => {});
        await fetchPromise.catch(() => {});
        return;
      }

      await sleep(4000);
      const pAfterResume = progressRef.current;
      push(
        `T7: progress after 4s resumed = ${(pAfterResume * 100).toFixed(2)}% (delta ${((pAfterResume - pAfterPause) * 100).toFixed(3)}%)`,
        pAfterResume - pAfterPause > 0.001 ? 'ok' : 'err',
      );

      push('T7: cancelling to skip full 1GB download…');
      try {
        await BareResourceFetcher.cancelFetching(BIG_MODEL);
      } catch (e: any) {
        push(`T7: cancel threw: ${e?.message}`, 'err');
      }
      try {
        await fetchPromise;
      } catch (e: any) {
        const ok = e?.code === RnExecutorchErrorCode.DownloadInterrupted;
        push(
          `T7 done  fetch rejected with code=${e?.code} ${ok ? '(expected)' : '(unexpected)'}`,
          ok ? 'ok' : 'err',
        );
      }
    });

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Resource Fetcher PR #1023 harness</Text>
      <View style={styles.progressRow}>
        <Text style={styles.progressText}>
          progress {(progress * 100).toFixed(1)}%
        </Text>
        {busy ? (
          <>
            <ActivityIndicator />
            <Text style={styles.busy}>{busy}</Text>
          </>
        ) : null}
        {bgWatchActive ? <Text style={styles.bg}>bg watch</Text> : null}
      </View>
      <View style={styles.buttonGrid}>
        <Btn label="T1 fetch single" onPress={T1} disabled={!!busy} />
        <Btn label="T2 fetch multi" onPress={T2} disabled={!!busy} />
        <Btn label="T3 cancel" onPress={T3} disabled={!!busy} />
        <Btn label="T4 model loads" onPress={T4} disabled={!!busy} />
        <Btn label="T5 list" onPress={T5list} disabled={!!busy} />
        <Btn label="T5 delete" onPress={T5delete} disabled={!!busy} />
        <Btn label="T6 background" onPress={T6} disabled={!!busy} />
        <Btn label="T7 pause/resume" onPress={T7} disabled={!!busy} />
        <Btn label="clear log" onPress={() => setLogs([])} disabled={false} />
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.logBox}
        contentContainerStyle={styles.logContent}
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: false })
        }
      >
        {logs.map((l, i) => (
          <Text
            key={i}
            style={[
              styles.logLine,
              l.kind === 'ok' && styles.ok,
              l.kind === 'err' && styles.err,
            ]}
          >
            {l.ts} {l.text}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Btn({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.btn, disabled && styles.btnDisabled]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function Chat({ switchToTests }: { switchToTests: () => void }) {
  const llm = useLLM({ model: LLAMA3_2_1B_SPINQUANT });
  const [out, setOut] = useState<string>('');
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.progressRow}>
        <Text style={styles.title}>T4 useLLM(LLAMA3_2_1B_SPINQUANT)</Text>
        <TouchableOpacity onPress={switchToTests} style={styles.smallBtn}>
          <Text style={styles.btnText}>back</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.status}>
        isReady={String(llm.isReady)} progress=
        {(llm.downloadProgress * 100).toFixed(1)}%
        {llm.error ? `  error=${String(llm.error)}` : ''}
      </Text>
      {llm.isReady ? (
        <>
          <TouchableOpacity
            style={styles.btn}
            onPress={async () => {
              setOut('');
              try {
                await llm.sendMessage('Say hi in 3 words.');
                setOut(llm.response || '(no response yet)');
              } catch (e: any) {
                setOut(`err: ${e?.message}`);
              }
            }}
          >
            <Text style={styles.btnText}>run prompt</Text>
          </TouchableOpacity>
          <ScrollView style={styles.logBox}>
            <Text style={styles.logLine}>live: {llm.response}</Text>
            <Text style={styles.logLine}>last: {out}</Text>
          </ScrollView>
        </>
      ) : (
        <ActivityIndicator style={{ marginTop: 20 }} />
      )}
    </SafeAreaView>
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>('tests');
  return (
    <SafeAreaProvider>
      {mode === 'tests' ? (
        <Harness switchToChat={() => setMode('chat')} />
      ) : (
        <Chat switchToTests={() => setMode('tests')} />
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, backgroundColor: '#fff' },
  title: { fontSize: 16, fontWeight: '700', marginBottom: 8 },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  progressText: { fontVariant: ['tabular-nums'] },
  busy: { color: '#555' },
  bg: {
    color: '#fff',
    backgroundColor: '#0a0',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontSize: 12,
  },
  buttonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  btn: {
    backgroundColor: '#001A72',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
  },
  smallBtn: {
    backgroundColor: '#666',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  btnDisabled: { backgroundColor: '#99a' },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  logBox: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 6,
    padding: 8,
  },
  logContent: { paddingBottom: 12 },
  logLine: {
    color: '#ddd',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    lineHeight: 15,
  },
  ok: { color: '#6f6' },
  err: { color: '#f77' },
  status: { fontSize: 13, color: '#333', marginBottom: 8 },
});
