import { uuid } from "expo";
import { useLayoutEffect, useRef, useState } from "react";
import { getLocalDatabase } from "../data/database.ts";
import { createQuickSplitRepository } from "../data/quickSplits.ts";
import type { QuickSplitInput } from "../domain/quickSplit.ts";
import type { DomainErrorCode } from "../domain/result.ts";
import { createQuickHistorySave } from "../services/quickHistorySave.ts";
import { usePro } from "./ProContext.ts";

type SaveState = { readonly status: "idle" | "saving" }
  | { readonly status: "saved"; readonly historyId: string }
  | { readonly status: "error"; readonly code: DomainErrorCode };

export function useQuickHistorySave(input: QuickSplitInput) {
  const { hasProAccess } = usePro();
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const saveAttempt = useRef<ReturnType<typeof createQuickHistorySave> | undefined>(undefined);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function save() {
    if (!mounted.current || state.status === "saving" || state.status === "saved") return;
    setState({ status: "saving" });

    try {
      saveAttempt.current ??= createQuickHistorySave(`quick-history:${uuid.v4()}`, input, async (id, snapshotInput) => {
        const repository = createQuickSplitRepository(await getLocalDatabase(), hasProAccess);
        return repository.saveQuickHistory(id, snapshotInput);
      });
      const result = await saveAttempt.current();
      if (!mounted.current) return;
      setState(result.ok ? { status: "saved", historyId: result.value.id } : { status: "error", code: result.error.code });
    } catch {
      if (mounted.current) setState({ status: "error", code: "QUICK_STORAGE_ERROR" });
    }
  }

  return { state, save };
}
