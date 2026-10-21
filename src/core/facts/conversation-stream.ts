/**
 * PR 4 (Wave B incremental derivation, transcripts): the conversation windows of a segmented page, streamed across its
 * occurrences (wave-b spec 8.2 "Conversation facts").
 *
 * Messages are parsed one occurrence at a time, under the page's winning pattern (the segmenter's, in the first
 * occurrence's entry state) when it has one. The last message of an occurrence may continue into the next one, so it is
 * held back and parsed again with the next occurrence's text, from its anchor line and with the day-header date in force
 * there; the windows (createWindowStream, the same gap groups and bounds as the whole-page pass) then run over message
 * boundaries, never over segment cuts, so a window can span a cut. Each window is owned by the occurrence its first
 * message starts in. Reads one occurrence's text at a time and holds the carried message and the open window, never the
 * whole body.
 *
 * A run of occurrences is streamed on its own when the occurrence after it opens a gap group: its windows then equal
 * the whole stream's, because every window before that occurrence closed at the gap. startsConversationRun tells, from
 * an occurrence's text and the one before it, whether its first message opens a gap group, so the newest run of a page
 * is read without the rest.
 */
import type { Page } from '../types.ts';
import { BUILTIN_PATTERNS } from '../conversation-parser/builtins.ts';
import { DAY_HEADER_RE, isAnchorLine, parseConversation } from '../conversation-parser/parse.ts';
import type { ConversationOccurrence } from '../page-body/segment-conversation.ts';
import type { ConversationSegment } from './conversation-types.ts';
import { DEFAULT_SEGMENT_GAP_MINUTES, MAX_PAGE_SEGMENT_GAP_MINUTES, createWindowStream } from './conversation-windows.ts';

export interface ConversationStreamSink {
  /** A closed window, owned by occurrence `owner` (an index into the occurrences). */
  window(owner: number, seg: ConversationSegment): void;
  /** Occurrence `index` was read; `startsGroup`: its first message opens a gap group. */
  occurrence(index: number, startsGroup: boolean): void;
}

export interface ConversationStreamOpts { page: Page; gapMinutes: number | null; sinceIso?: string }

/** The last message of an occurrence, held back to be parsed with the next occurrence's text. */
interface Carry { text: string; date: string | undefined; owner: number; region: string }

/** The page's winning pattern (the segmenter's) and the parser options that pin it. */
function pinnedPattern(occurrences: readonly ConversationOccurrence[]) {
  const pattern = occurrences[0]?.conversation?.pattern ?? null;
  const forced = pattern && BUILTIN_PATTERNS.some(p => p.id === pattern) ? BUILTIN_PATTERNS.filter(p => p.id !== pattern).map(p => p.id) : undefined;
  return { pattern, forced };
}

const gapMinutesFor = (opts: ConversationStreamOpts, patternId: string | null) =>
  opts.gapMinutes ?? (patternId === 'email-thread-heading' ? MAX_PAGE_SEGMENT_GAP_MINUTES : undefined);

function parseChunk(text: string, page: Page, fallbackDate: string | undefined, forced: string[] | undefined) {
  return parseConversation(text, { page, ...(fallbackDate ? { fallbackDate } : {}), ...(forced ? { disabledBuiltinIds: forced } : {}) });
}

/** The offset of the first (`last`) line of `text` that opens a message under `patternId`, or -1. */
function anchorOffset(patternId: string, text: string, last: boolean): number {
  if (last) {
    let end = text.length;
    while (end > 0) {
      const start = text.lastIndexOf('\n', end - 1) + 1;
      if (isAnchorLine(patternId, text.slice(start, end).replace(/\r$/, ''))) return start;
      end = start - 1;
    }
    return -1;
  }
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    if (isAnchorLine(patternId, text.slice(start, end < 0 ? text.length : end).replace(/\r$/, ''))) return start;
    if (end < 0) break;
    start = end + 1;
  }
  return -1;
}

/** The day-header date in force at `offset` of `text`, else `fallback`. */
function dateAt(text: string, offset: number, fallback: string | undefined): string | undefined {
  let end = offset;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 2) + 1;
    const match = DAY_HEADER_RE.exec(text.slice(start, end).trim());
    if (match) return match[1];
    end = start;
  }
  return fallback;
}

/**
 * Whether occurrence `index`'s first message opens a gap group: it comes more than the gap after the last message of
 * the occurrence before it (`previous`, read with the date in force at its last anchor).
 */
export function startsConversationRun(occurrences: readonly ConversationOccurrence[], index: number, text: string, previous: string,
  opts: ConversationStreamOpts): boolean {
  if (index === 0) return true;
  const occurrence = occurrences[index]!;
  const { pattern, forced } = pinnedPattern(occurrences);
  const parsed = parseChunk(text, opts.page, occurrence.conversation?.fallbackDate ?? undefined, forced);
  const patternId = pattern ?? parsed.matched_pattern_id ?? null;
  const first = parsed.messages[0] ? Date.parse(parsed.messages[0].timestamp) : NaN;
  const at = patternId ? anchorOffset(patternId, previous, true) : -1;
  if (at < 0 || !Number.isFinite(first)) return false;
  const date = occurrence.conversation?.lastDate ?? dateAt(previous, at, occurrences[index - 1]!.conversation?.fallbackDate ?? undefined);
  const last = parseChunk(previous.slice(at), opts.page, date, forced).messages[0];
  const gapMs = (gapMinutesFor(opts, patternId) ?? DEFAULT_SEGMENT_GAP_MINUTES) * 60_000;
  return !!last && first - Date.parse(last.timestamp) > gapMs;
}

/**
 * Stream the windows of occurrences `from`..`to` (exclusive) of a segmented conversation page (module doc) into `sink`.
 * `to` is the page's end or an occurrence whose first message opens a gap group; the text before that occurrence's
 * first anchor line still belongs to the last message before it.
 */
export async function streamConversationWindows(occurrences: readonly ConversationOccurrence[], from: number, to: number, opts: ConversationStreamOpts,
  readText: (index: number) => Promise<string>, sink: ConversationStreamSink): Promise<void> {
  const { pattern, forced } = pinnedPattern(occurrences);
  const pageTitle = opts.page.title || opts.page.slug;
  let stream: ReturnType<typeof createWindowStream<number>> | null = null;
  let carry: Carry | null = null;
  let lastPattern: string | null = null;
  for (let i = from; i < to; i++) {
    const occurrence = occurrences[i]!;
    let text = await readText(i);
    const leadPattern = pattern ?? lastPattern;
    if (i === to - 1 && to < occurrences.length && leadPattern) {
      const next = await readText(to);
      const lead = anchorOffset(leadPattern, next, false);
      if (lead > 0) text += (occurrences[to]!.row.region === occurrence.row.region ? '' : '\n\n') + next.slice(0, lead);
    }
    const carried: string = carry ? carry.text + (carry.region === occurrence.row.region ? '' : '\n\n') : '';
    const chunk: string = carried + text;
    const fallbackDate: string | undefined = carry ? carry.date : occurrence.conversation?.fallbackDate ?? undefined;
    const parsed = parseChunk(chunk, opts.page, fallbackDate, forced);
    const patternId: string | null = pattern ?? parsed.matched_pattern_id ?? lastPattern;
    lastPattern = patternId;
    stream ??= createWindowStream<number>({ pageTitle, sinceIso: opts.sinceIso, gapMinutes: gapMinutesFor(opts, patternId) });
    let messages = parsed.messages;
    const firstOwner: number = carry ? carry.owner : i;
    let next: Carry | null = null;
    if (i < to - 1 && messages.length && patternId) {
      const at = anchorOffset(patternId, chunk, true);
      if (at >= 0) {
        next = { text: chunk.slice(at), date: dateAt(chunk, at, fallbackDate), owner: at < carried.length ? firstOwner : i, region: occurrence.row.region };
        messages = messages.slice(0, -1);
      }
    }
    let startsGroup: boolean | null = null;
    messages.forEach((message, k) => {
      const owner = k === 0 ? firstOwner : i;
      const pushed = stream!.push(message, owner);
      if (pushed.accepted && owner === i && startsGroup === null) startsGroup = pushed.startsGroup;
      for (const w of pushed.windows) sink.window(w.tag, w.seg);
    });
    sink.occurrence(i, startsGroup === true);
    carry = next;
  }
  for (const w of stream?.end() ?? []) sink.window(w.tag, w.seg);
}
