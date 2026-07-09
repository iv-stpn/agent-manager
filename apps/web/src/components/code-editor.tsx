import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

// A CodeMirror 6 editor whose language mode is chosen from the filename and
// loaded lazily (each language is its own async chunk in @codemirror/language-data,
// so the bundle only pays for the modes actually opened). The editor is
// uncontrolled — CodeMirror owns the document — and reports edits through
// `onChange`; the parent tracks the dirty/save state.

interface CodeEditorProps {
	// Identifies the open file. A change swaps both the document and the language.
	path: string;
	value: string;
	readOnly: boolean;
	onChange: (value: string) => void;
	// Fired on Cmd/Ctrl-S so the parent can save without stealing browser focus.
	onSave: () => void;
}

// Base (language-independent) extensions. `basicSetup` from the meta package
// bundles a lot we don't want to re-configure piecemeal, so we assemble the
// pieces we need explicitly — line numbers, history, selection drawing, the
// default + history keymaps, and tab-to-indent.
function baseExtensions(): ReturnType<typeof lineNumbers>[] {
	return [
		lineNumbers(),
		highlightActiveLineGutter(),
		highlightSpecialChars(),
		history(),
		drawSelection(),
		highlightActiveLine(),
		keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
	];
}

export function CodeEditor({ path, value, readOnly, onChange, onSave }: CodeEditorProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const languageComp = useRef(new Compartment());
	const readOnlyComp = useRef(new Compartment());
	// Keep the latest callbacks reachable from the (once-created) update listener
	// without rebuilding the editor on every render.
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	onChangeRef.current = onChange;
	onSaveRef.current = onSave;

	// Create the EditorView once, on mount.
	// biome-ignore lint/correctness/useExhaustiveDependencies: editor is created once; doc/language/readOnly are pushed via effects below.
	useEffect(() => {
		if (!hostRef.current) return;
		const saveKeymap = keymap.of([
			{
				key: "Mod-s",
				preventDefault: true,
				run: () => {
					onSaveRef.current();
					return true;
				},
			},
		]);
		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					saveKeymap,
					...baseExtensions(),
					languageComp.current.of([]),
					readOnlyComp.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) onChangeRef.current(update.state.doc.toString());
					}),
				],
			}),
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, []);

	// Swap the document whenever the file content changes (a file switch changes
	// `value` too, since the parent reloads content per path). Guard on the current
	// doc so re-renders from our own onChange don't reset the cursor by
	// re-dispatching identical text.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (view.state.doc.toString() === value) return;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
	}, [value]);

	// Load and apply the language mode for the current filename.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		let cancelled = false;
		const desc = LanguageDescription.matchFilename(languages, path);
		if (!desc) {
			view.dispatch({ effects: languageComp.current.reconfigure([]) });
			return;
		}
		desc
			.load()
			.then((support) => {
				if (!cancelled && viewRef.current) {
					viewRef.current.dispatch({ effects: languageComp.current.reconfigure(support) });
				}
			})
			.catch(() => {
				// A missing/broken language chunk must not blank the editor — fall
				// back to plain text (no highlighting).
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	// Reflect read-only transitions (e.g. project stopped mid-edit).
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({
			effects: readOnlyComp.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
		});
	}, [readOnly]);

	return <div ref={hostRef} className="h-full overflow-auto text-sm" />;
}
