import { App, TFile } from 'obsidian';
import { NoteLinks, LinkType } from './types';

// Matches both full keywords and shorthands:
//   leadsto@note  dependson@note  informedby@note
//   >@note        <@note          !@note
// Groups: [1] full keyword | [2] shorthand char | [3] target note name
export const INLINE_TAG_REGEX = /(?:\b(leadsto|dependson|informedby)|([><!]))@([\w\-]+)/g;

const SHORTHAND_MAP: Record<string, string> = {
    '>': 'leadsto',
    '<': 'dependson',
    '!': 'informedby',
};

/** Resolve link type and target note from a regex match. Returns null if the match is invalid. */
export function resolveTagMatch(m: RegExpExecArray): { type: string; target: string } | null {
    const type   = m[1] || SHORTHAND_MAP[m[2]];
    const target = m[3];
    if (!type || !target) return null;
    return { type, target };
}

/**
 * Parse links from BOTH frontmatter arrays AND inline body tags.
 * Both sources are merged and deduplicated.
 */
export async function parseNoteLinks(file: TFile, app: App): Promise<NoteLinks> {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter ?? {};

    function toArray(val: unknown): string[] {
        if (!val) return [];
        if (Array.isArray(val)) return val.map(String).filter(Boolean);
        return [String(val)].filter(Boolean);
    }

    const leadsto: Set<string> = new Set(toArray(fm['leadsto']));
    const dependson: Set<string> = new Set(toArray(fm['dependson']));
    const informedby: Set<string> = new Set(toArray(fm['informedby']));

    try {
        const raw = await app.vault.cachedRead(file);
        const body = raw.startsWith('---')
            ? raw.replace(/^---[\s\S]*?---\n?/, '')
            : raw;

        let m: RegExpExecArray | null;
        INLINE_TAG_REGEX.lastIndex = 0;
        while ((m = INLINE_TAG_REGEX.exec(body)) !== null) {
            const resolved = resolveTagMatch(m);
            if (!resolved) continue;
            const { type, target } = resolved;
            if (type === 'leadsto')   leadsto.add(target);
            if (type === 'dependson') dependson.add(target);
            if (type === 'informedby') informedby.add(target);
        }
    } catch {
        // File unreadable — skip inline scan
    }

    return {
        noteName: file.basename,
        leadsto: [...leadsto],
        dependson: [...dependson],
        informedby: [...informedby],
    };
}

/**
 * Build a lookup map from every note name → its NoteLinks.
 * Pass `infer = false` to skip bidirectional inference (used by global graph
 * views that want to show only explicitly-declared relationships).
 */
export async function buildFullGraph(app: App, infer = true): Promise<Map<string, NoteLinks>> {
    const graph = new Map<string, NoteLinks>();
    const mdFiles = app.vault.getMarkdownFiles();
    await Promise.all(
        mdFiles.map(async (file) => {
            const links = await parseNoteLinks(file, app);
            graph.set(file.basename, links);
        })
    );
    if (infer) inferBidirectionalLinks(graph);
    return graph;
}

/**
 * Infer bidirectional links in the graph (in-memory only, never modifies files).
 *
 * Rule A: if A.leadsto contains B  → B.dependson should contain A
 * Rule B: if A.dependson contains B → B.leadsto should contain A
 *
 * This makes the hierarchy fully traversable in both directions.
 */
export function inferBidirectionalLinks(graph: Map<string, NoteLinks>): void {
    // Snapshot the original entries to avoid mutating while iterating
    const entries = [...graph.entries()];

    for (const [noteName, links] of entries) {
        // Rule A: A → leadsto → B  means  B ← dependson ← A
        for (const child of [...links.leadsto]) {
            const childLinks = graph.get(child);
            if (childLinks && !childLinks.dependson.includes(noteName)) {
                childLinks.dependson.push(noteName);
            }
        }
        // Rule B: A → dependson → B  means  B ← leadsto ← A
        for (const parent of [...links.dependson]) {
            const parentLinks = graph.get(parent);
            if (parentLinks && !parentLinks.leadsto.includes(noteName)) {
                parentLinks.leadsto.push(noteName);
            }
        }
    }
}

/**
 * Return all vault note basenames for autocomplete.
 */
export function allNoteNames(app: App): string[] {
    return app.vault.getMarkdownFiles().map(f => f.basename).sort();
}

/**
 * Open a note by basename in an unpinned leaf.
 */
export async function openNote(name: string, app: App): Promise<void> {
    const target = app.vault.getMarkdownFiles().find(f => f.basename === name);
    if (target) {
        await app.workspace.getUnpinnedLeaf().openFile(target);
    }
}
