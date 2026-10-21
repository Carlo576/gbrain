/**
 * createPatternDetector (conversation-parser/parse.ts) against parseConversation: the streamed whole-page grammar
 * detection conversation facts uses on a segmented page (PR 4 lane 4b round 5, F3).
 *
 * 1. Protects: fed any body in arbitrary pieces (cut mid-line, CRLF or LF), the detector picks exactly the pattern
 *    parseConversation(body) matches, or null when it matches none: head pass, full-body re-score, score_full_body
 *    re-score, acceptance floor, structure gate, block-format collapse and the speaker-object region scan included.
 * 2. Fails when: the detector diverges from the whole-page parser on any seeded body (a preamble that tips the head
 *    pass, a block header deep in the body, an invalid speaker-object region, a label list with no repeated speaker),
 *    or holds more than a bounded amount of text between pieces: a 40 MiB line with no newline, or a 40 MiB block
 *    message body, fed in 1 MiB pieces (N6, round 6); a message line over the cap is still scored by its head.
 */
import { describe, expect, test } from 'bun:test';
import { heapSize } from 'bun:jsc';
import { BUILTIN_PATTERNS } from '../../src/core/conversation-parser/builtins.ts';
import { createPatternDetector, parseConversation } from '../../src/core/conversation-parser/parse.ts';

const POSITIVE = BUILTIN_PATTERNS.flatMap(p => p.test_positive ?? []);
const NEGATIVE = BUILTIN_PATTERNS.flatMap(p => p.test_negative ?? []);
const OTHER = [
  '', '', '   ', '# Meeting', '## Summary', '## Transcript', '## Action Items', '## 2025-01-02', '### 2025-03-04', '```', '~~~', '    indented code',
  "{'source': 'microphone', 'attribution': 'me'}: hello", "{'source': 'speaker', 'name': 'alice-example', 'attribution': 'them'}: hi",
  "Alice's update was \"ready\" (after review).", 'An unfinished list [', 'Quoted note: "unfinished', '- **Theo** (Mon 11:18)', '- **Juan** (11:20 AM)',
  '  Body line of a block message.', '**Note:** remember the budget', '**Alice Example:** okay', '**Bob Example:** sure thing', 'User: one line of a preamble',
  'The roadmap review moved to next quarter and the budget stays flat.', 'Plain prose about the launch and the hiring plan.', '---', '> quoted line',
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/** A seeded body: random lines, or a preamble then one pattern's positives repeated, with random noise. */
function body(seed: number): string {
  const next = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
  const lines: string[] = [];
  if (next() < 0.5) {
    for (let i = Math.floor(next() * 120); i > 0; i--) lines.push(pick(next() < 0.4 ? POSITIVE : next() < 0.5 ? NEGATIVE : OTHER));
  } else {
    const entry = pick(BUILTIN_PATTERNS);
    for (let i = Math.floor(next() * 40); i > 0; i--) lines.push(pick(next() < 0.3 ? POSITIVE : OTHER));
    for (let i = 1 + Math.floor(next() * 80); i > 0; i--) {
      lines.push(next() < 0.85 ? pick(entry.test_positive ?? POSITIVE) : pick(OTHER));
      if (next() < 0.3) lines.push('');
    }
    for (let i = Math.floor(next() * 10); i > 0; i--) lines.push(pick(OTHER));
  }
  return lines.join(next() < 0.2 ? '\r\n' : '\n');
}

/** The detector's pick over \`text\` fed in seeded pieces. */
function detect(text: string, seed: number): string | null {
  const next = rng(seed * 31 + 7);
  const detector = createPatternDetector();
  for (let at = 0; at < text.length;) {
    const size = 1 + Math.floor(next() * (next() < 0.5 ? 8 : 400));
    detector.push(text.slice(at, at + size));
    at += size;
  }
  return detector.finish();
}

describe('createPatternDetector', () => {
  test('picks what parseConversation picks on 3000 seeded bodies fed in arbitrary pieces', () => {
    const mismatches: Array<{ seed: number; parsed: string | null; detected: string | null }> = [];
    const picked = new Set<string | null>();
    for (let seed = 1; seed <= 3000; seed++) {
      const text = body(seed);
      const parsed = parseConversation(text).matched_pattern_id ?? null;
      const detected = detect(text, seed);
      picked.add(parsed);
      if (parsed !== detected) mismatches.push({ seed, parsed, detected });
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(picked.size).toBeGreaterThan(12);
  });

  test('a preamble that tips the head pass loses to the transcript the whole body holds', () => {
    const preamble = Array.from({ length: 4000 }, (_, i) => (i % 4 === 3 ? 'User: a line of the preamble' : `Notes line ${i} about the roadmap review.`)).join('\n');
    const transcript = Array.from({ length: 30000 }, (_, i) => `**${['Alice Example', 'Bob Example'][i % 2]}** (9:${String(i % 60).padStart(2, '0')} AM): budget and launch.`).join('\n\n');
    const text = `${preamble}\n\n${transcript}`;
    expect(parseConversation(text.slice(0, 64 * 1024)).matched_pattern_id).toBe('plain-role-no-time');
    expect({ parsed: parseConversation(text).matched_pattern_id, detected: detect(text, 1) }).toEqual({ parsed: 'bold-paren-time-12h', detected: 'bold-paren-time-12h' });
  });

  /** Heap growth (bytes) over a baseline after each of 40 fresh 1 MiB pieces `piece(i)` the detector is fed: the most it retained. */
  const peakRetained = (head: string, piece: (i: number) => string, tail: string) => {
    const detector = createPatternDetector();
    detector.push(head);
    Bun.gc(true);
    const base = heapSize();
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      detector.push(piece(i));
      Bun.gc(true);
      peak = Math.max(peak, heapSize() - base);
    }
    detector.push(tail);
    return { peak, pattern: detector.finish() };
  };
  const MIB = 1024 ** 2;
  const transcript = Array.from({ length: 60 }, (_, t) => `**${t % 2 ? 'Alice' : 'Bob'}** (${1 + (t % 11)}:0${t % 10} PM): turn ${t} about the roadmap review.`).join('\n');

  test('N6: a 40 MiB line with no newline, fed in 1 MiB pieces, is never held whole; only its head is scored', () => {
    const { peak, pattern } = peakRetained(`${transcript}\n`, i => String.fromCharCode(97 + (i % 26)).repeat(MIB - 8) + String(i).padStart(8, '0'), `\n${transcript}\n`);
    expect({ held: peak < 4 * MIB, pattern }).toEqual({ held: true, pattern: 'bold-paren-time-12h' });
  });

  test('N6: a block message whose 40 MiB body arrives in 1 MiB pieces of short lines holds a bounded body', () => {
    const line = (i: number, j: number) => `  body line ${j} of piece ${i} `.padEnd(1023, 'x');
    const { peak, pattern } = peakRetained('- **Theo** (Mon 11:18)\n', i => Array.from({ length: 1024 }, (_, j) => `${line(i, j)}\n`).join(''), '- **Juan** (11:20 AM)\n  done\n');
    expect({ held: peak < 4 * MIB, pattern }).toEqual({ held: true, pattern: 'bold-paren-time' });
  });
});
