import { App, TFile } from 'obsidian';
import { NoteLinks, LinkType } from './types';

// Matches both full keywords and shorthands, with quoted or unquoted targets:
//   leadsto@note           dependson@note          informedby@note
//   leadsto@"note name"    dependson@"note name"   informedby@"note name"
//   >@note  <@note  !@note    (shorthands, quoted also supported)
//
// Groups: [1] full keyword | [2] shorthand char
//         [3] quoted target (spaces allowed) | [4] unquoted target ([\w\-]+)
export const INLINE_TAG_REGEX = /(?:\b(leadsto|dependson|informedby)|([><!]))@(?:"([^"]+)"|([\w\-]+))/g;

const SHORTHAND_MAP: Record<string, string> = {
    '>': 'leadsto',
    '<': 'dependson',
    '!': 'informedby',
};

/** Resolve link type and target note from a regex match. Returns null if the match is invalid. */
export function resolveTagMatch(m: RegExpExecArray): { type: string; target: string } | null {
    const type   = m[1] || SHORTHAND_MAP[m[2]];
    const target = m[3] || m[4];   // m[3] = quoted target, m[4] = unquoted target
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
 * Pass `reduceTransitive = true` to remove edges that are implied by a
 * longer path (transitive reduction of the leadsto graph).
 */
export async function buildFullGraph(app: App, infer = true, reduceTransitive = false): Promise<Map<string, NoteLinks>> {
    const graph = new Map<string, NoteLinks>();
    const mdFiles = app.vault.getMarkdownFiles();
    await Promise.all(
        mdFiles.map(async (file) => {
            const links = await parseNoteLinks(file, app);
            graph.set(file.basename, links);
        })
    );
    if (infer) inferBidirectionalLinks(graph);
    if (reduceTransitive) applyTransitiveReduction(graph);
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
 * Apply transitive reduction to the leadsto graph (in-memory only).
 *
 * If A→B, A→C, and B→C all exist, then A→C is redundant — it is already
 * "inherited" through B. This function removes such redundant edges so that
 * only the minimal set of connections needed to imply all reachability is kept.
 *
 * The corresponding dependson back-edges are also cleaned up.
 *
 * A snapshot of the original leadsto arrays is used for path-finding so that
 * earlier removals do not affect reachability checks for later notes.
 */
export function applyTransitiveReduction(graph: Map<string, NoteLinks>): void {
    // Snapshot ALL leadsto arrays first to ensure path-finding uses the
    // original graph, not a partially-reduced one.
    const snapshot = new Map<string, string[]>();
    for (const [name, links] of graph) {
        snapshot.set(name, [...links.leadsto]);
    }

    for (const [noteA, linksA] of graph) {
        const originalLeadsto = snapshot.get(noteA) ?? [];
        const toRemove = new Set<string>();

        for (const noteC of originalLeadsto) {
            // Check if noteC is reachable from noteA via any other direct
            // neighbour noteB (i.e. A→B→…→C with B ≠ C exists).
            for (const noteB of originalLeadsto) {
                if (noteB === noteC) continue;
                if (isReachableLeadsto(snapshot, noteB, noteC, new Set([noteA]))) {
                    toRemove.add(noteC);
                    break;
                }
            }
        }

        if (toRemove.size > 0) {
            linksA.leadsto = linksA.leadsto.filter(n => !toRemove.has(n));
            // Remove the back-edges from the target notes' dependson arrays.
            for (const noteC of toRemove) {
                const linksC = graph.get(noteC);
                if (linksC) {
                    linksC.dependson = linksC.dependson.filter(n => n !== noteA);
                }
            }
        }
    }
}

/**
 * Check whether `to` is reachable from `from` by following leadsto edges
 * in the snapshot. `visited` prevents infinite loops on cycles.
 */
function isReachableLeadsto(
    snapshot: Map<string, string[]>,
    from: string,
    to: string,
    visited: Set<string>
): boolean {
    if (visited.has(from)) return false;
    const children = snapshot.get(from) ?? [];
    if (children.includes(to)) return true;
    const nextVisited = new Set([...visited, from]);
    return children.some(n => isReachableLeadsto(snapshot, n, to, nextVisited));
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
