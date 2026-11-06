import { useCallback, useEffect, useRef, useState } from "react";
import { getLocalDatabase } from "../data/database.ts";
import { createQuickSplitRepository, type QuickDraftInput } from "../data/quickSplits.ts";
import {
  createQuickSplitEditor, hydrateQuickSplitDraft, serializeQuickSplitDraft, type QuickSplitEditorState,
} from "../services/quickSplitEditor.ts";

type DraftError = "load" | "save" | "discard";
type DraftSnapshot = {
  readonly id: string;
  readonly input: QuickDraftInput;
  readonly capturedAt: number;
};
type DraftSession = {
  editor: QuickSplitEditorState;
  repository?: ReturnType<typeof createQuickSplitRepository>;
  pending?: DraftSnapshot;
  operation: number;
  mounted: boolean;
  discarding: boolean;
};

// Keep capture times increasing through rapid edits, clock changes and screen remounts.
let lastCapturedAt = 0;

export function useQuickSplitDraft() {
  const [editor, setEditor] = useState(createQuickSplitEditor);
  const [loading, setLoading] = useState(true);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<DraftError>();
  const session = useRef<DraftSession>({ editor, operation: 0, mounted: false, discarding: false }).current;

  const loadDraft = useCallback(async () => {
    const operation = ++session.operation;
    const current = () => session.mounted && session.operation === operation;
    setLoading(true);
    setError(undefined);
    try {
      const repository = createQuickSplitRepository(await getLocalDatabase());
      const result = await repository.getQuickDraft();
      if (!current()) return;
      if (!result.ok) {
        setError("load");
        return;
      }
      if (result.value) {
        const { input, updatedAt } = result.value;
        lastCapturedAt = Math.max(lastCapturedAt, updatedAt);
        session.editor = hydrateQuickSplitDraft(input);
        setEditor(session.editor);
      }
      session.repository = repository;
    } catch {
      if (current()) setError("load");
    } finally {
      if (current()) setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    session.mounted = true;
    void loadDraft();
    return () => {
      session.mounted = false;
      session.operation += 1;
    };
  }, [loadDraft, session]);

  async function save(snapshot: DraftSnapshot) {
    if (!session.mounted || !session.repository || session.discarding) return;
    const operation = ++session.operation;
    setError(undefined);
    // Enqueue before returning to React. Edits and a later clear are serialized by SQLite,
    // including when the editor unmounts before the write finishes.
    const result = await session.repository.saveQuickDraft(snapshot.id, snapshot.input, snapshot.capturedAt);
    if (!session.mounted || session.operation !== operation) return;
    if (result.ok) session.pending = undefined;
    else setError("save");
  }

  function updateEditor(update: (current: QuickSplitEditorState) => QuickSplitEditorState) {
    if (!session.mounted || !session.repository || session.discarding) return;
    const next = update(session.editor);
    if (next === session.editor) return;
    session.editor = next;
    setEditor(next);
    lastCapturedAt = Math.max(Date.now(), lastCapturedAt + 1);
    const snapshot = {
      id: `quick-editor:${lastCapturedAt}`,
      input: serializeQuickSplitDraft(next),
      capturedAt: lastCapturedAt,
    };
    session.pending = snapshot;
    void save(snapshot);
  }

  function discard() {
    const repository = session.repository;
    if (!session.mounted || !repository || session.discarding) return;
    session.discarding = true;
    const operation = ++session.operation;
    setDiscarding(true);
    setError(undefined);
    void repository.clearQuickDraft().then((result) => {
      if (!session.mounted || session.operation !== operation) return;
      session.discarding = false;
      setDiscarding(false);
      if (!result.ok) {
        setError("discard");
        return;
      }
      session.pending = undefined;
      session.editor = createQuickSplitEditor();
      setEditor(session.editor);
    });
  }

  function retry() {
    if (error === "load") void loadDraft();
    if (error === "save" && session.pending) void save(session.pending);
    if (error === "discard") discard();
  }

  return { editor, updateEditor, loading, error, retry, discard, discarding };
}
