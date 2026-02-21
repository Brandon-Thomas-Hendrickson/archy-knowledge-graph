// ─── Link Types ───────────────────────────────────────────────────────────────
export type LinkType = 'leadsto' | 'dependson' | 'informedby';

// All three relationship arrays for a single note
export interface NoteLinks {
    noteName: string;   // file basename without .md
    leadsto: string[];
    dependson: string[];
    informedby: string[];
}
