import type { QuickHistoryRecord } from "../data/quickSplits.ts";
import type { QuickSplitInput } from "../domain/quickSplit.ts";
import { failure, type Result } from "../domain/result.ts";

export function createQuickHistorySave(
  id: string,
  input: QuickSplitInput,
  persist: (id: string, input: QuickSplitInput) => Promise<Result<QuickHistoryRecord>>,
) {
  let attempt: Promise<Result<QuickHistoryRecord>> | undefined;

  return function save() {
    // Share an in-flight write and keep its success for this result visit. A failed retry uses the same ID.
    attempt ??= Promise.resolve().then(() => persist(id, input)).then(
      (result) => {
        if (!result.ok) attempt = undefined;
        return result;
      },
      () => {
        attempt = undefined;
        return failure("QUICK_STORAGE_ERROR", "storage");
      },
    );
    return attempt;
  };
}
