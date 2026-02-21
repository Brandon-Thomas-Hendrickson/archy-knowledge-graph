import {
    Decoration,
    DecorationSet,
    EditorView,
    MatchDecorator,
    ViewPlugin,
    ViewUpdate,
    WidgetType,
} from '@codemirror/view';
import { App } from 'obsidian';
import { INLINE_TAG_REGEX, openNote, resolveTagMatch } from './parser';

// ── Widget rendered in place of the raw tag text ──────────────────────────────

class InlineTagWidget extends WidgetType {
    constructor(
        readonly linkType: string,
        readonly noteName: string,
        readonly app: App,
    ) {
        super();
    }

    eq(other: InlineTagWidget): boolean {
        return other.linkType === this.linkType && other.noteName === this.noteName;
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = `archy-inline-tag archy-inline-${this.linkType}`;
        span.textContent = this.noteName;
        span.title = `${this.linkType} → ${this.noteName}`;
        // mousedown fires before editor captures focus; preventDefault keeps
        // the editor from moving focus away while still triggering our handler.
        span.addEventListener('mousedown', (e) => {
            e.preventDefault();
            openNote(this.noteName, this.app);
        });
        return span;
    }

    // Let mousedown through so our handler fires
    ignoreEvent(event: Event): boolean {
        return event.type !== 'mousedown';
    }
}

// ── MatchDecorator that skips ranges where the cursor sits ───────────────────

function makeDecorator(app: App): MatchDecorator {
    return new MatchDecorator({
        // Re-create a fresh RegExp from the same source/flags so MatchDecorator
        // manages its own lastIndex independently of the shared export.
        regexp: new RegExp(INLINE_TAG_REGEX.source, INLINE_TAG_REGEX.flags),
        decoration: (match, view, pos) => {
            const from = pos;
            const to   = pos + match[0].length;
            // If any selection range overlaps with this match, show raw text
            for (const sel of view.state.selection.ranges) {
                if (sel.from <= to && sel.to >= from) return null;
            }
            const resolved = resolveTagMatch(match);
            if (!resolved) return null;
            return Decoration.replace({
                widget: new InlineTagWidget(resolved.type, resolved.target, app),
            });
        },
    });
}

// ── ViewPlugin factory ────────────────────────────────────────────────────────

export function buildInlineTagExtension(app: App) {
    const decorator = makeDecorator(app);

    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;

            constructor(view: EditorView) {
                this.decorations = decorator.createDeco(view);
            }

            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged || update.selectionSet) {
                    this.decorations = decorator.updateDeco(update, this.decorations);
                }
            }
        },
        { decorations: (instance) => instance.decorations },
    );
}
