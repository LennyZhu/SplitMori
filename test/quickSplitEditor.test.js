import assert from "node:assert/strict";
import test from "node:test";
import {
  addEditorMember, calculateQuickSplitEditor, createQuickSplitEditor, hydrateQuickSplitDraft,
  removeEditorMember, serializeQuickSplitDraft,
} from "../src/services/quickSplitEditor.ts";

function preview(state) {
  const result = calculateQuickSplitEditor(state);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

test("equal editor uses the receipt total and allows a missing payer", () => {
  const state = { ...createQuickSplitEditor(), finalTotal: "100.01", subtotal: "100", serviceFeeMode: "quick10" };
  const { input, snapshot } = preview(state);
  assert.deepEqual(input.members.map(({ displayName }) => displayName), ["成員 1", "成員 2"]);
  assert.deepEqual(snapshot.split.allocations.map(({ amountMinor }) => amountMinor), [5001, 5000]);
  assert.deepEqual(snapshot.suggestions, []);
  const payer = preview({ ...state, merchantPayerId: state.members[0].id });
  assert.equal(payer.snapshot.suggestions[0].amountMinor, 5000);
});

test("single-host commitments use the final total and ignore equal-only toggles", () => {
  const state = addEditorMember(createQuickSplitEditor());
  const members = state.members.map((member, index) => ({ ...member, included: index === 0 }));
  const treat = {
    ...state, members, mode: "treat", hostId: members[0].id, finalTotal: "100",
    coverAmount: "60", chargeMode: "details", subtotal: "100", discount: "10",
    serviceFeeMode: "manual", serviceFee: "10",
  };
  const shares = (value) => preview(value).snapshot.split.allocations.map(({ amountMinor }) => amountMinor);
  assert.deepEqual(shares(treat), [6000, 2000, 2000]);
  assert.deepEqual(shares({ ...treat, coverKind: "percentage", coverPercentage: "60.01" }), [6001, 2000, 1999]);
  assert.deepEqual(calculateQuickSplitEditor({ ...treat, coverAmount: "101" }), {
    ok: false, error: { code: "COVER_EXCEEDS_TOTAL", field: "coverAmount" },
  });
});

test("individual editor uses each personal amount and reports the invalid member field", () => {
  const state = createQuickSplitEditor();
  const members = state.members.map((member, index) => ({ ...member, personalAmount: index ? "40" : "30", shareCommon: index === 1 }));
  const individual = { ...state, mode: "individual", finalTotal: "100", sharedAmount: "30", members };
  assert.deepEqual(preview(individual).snapshot.split.allocations.map(({ amountMinor }) => amountMinor), [3000, 7000]);
  assert.deepEqual(calculateQuickSplitEditor({ ...individual, finalTotal: "99" }), {
    ok: false, error: { code: "TOTAL_MISMATCH", field: "sharedAmount" },
  });
  assert.deepEqual(calculateQuickSplitEditor({ ...individual, members: [{ ...members[0], personalAmount: "30.001" }, members[1]] }), {
    ok: false, error: { code: "INVALID_AMOUNT_PRECISION", field: "personalAmount", memberId: members[0].id },
  });
});

test("draft retains incomplete inputs and detail modes require the matching actual receipt", () => {
  const state = addEditorMember(createQuickSplitEditor());
  const [first, , third] = state.members;
  const draft = {
    ...state, members: [{ ...first, personalAmount: "3." }, state.members[1], third],
    mode: "individual", chargeMode: "details", finalTotal: "9.", subtotal: "100", discount: "10",
    serviceFeeMode: "quick10", serviceFeeBasis: "afterDiscount", merchantPayerId: third.id, hostId: third.id,
  };
  const reopened = hydrateQuickSplitDraft(serializeQuickSplitDraft(draft));
  assert.deepEqual(reopened, draft);
  const removed = removeEditorMember(reopened, third.id);
  assert.equal(removed.merchantPayerId, undefined);
  assert.equal(removed.hostId, undefined);
  assert.notEqual(addEditorMember(removed).members.at(-1).id, third.id);

  const equal = { ...reopened, mode: "equal", finalTotal: "99" };
  assert.equal(preview(equal).snapshot.split.total.amountMinor, 9900);
  assert.deepEqual(calculateQuickSplitEditor({ ...equal, serviceFeeBasis: "beforeDiscount" }), {
    ok: false, error: { code: "TOTAL_MISMATCH", field: "finalTotal" },
  });
  assert.equal(preview({ ...equal, finalTotal: "100", serviceFeeBasis: "beforeDiscount" }).snapshot.split.total.amountMinor, 10000);
});
