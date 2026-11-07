import type { QuickDraftInput } from "../data/quickSplits.ts";
import { isCurrency, parseAmount, wholeBasisPoints, type Currency } from "../domain/money.ts";
import { calculateQuickSplit, type QuickSplitInput, type QuickSplitSnapshot } from "../domain/quickSplit.ts";
import type { DomainErrorCode, Failure } from "../domain/result.ts";
import type { PersonalSpending } from "../domain/split.ts";

export type EditorMember = {
  readonly id: string;
  readonly displayName: string;
  readonly included: boolean;
  readonly shareCommon: boolean;
  readonly personalAmount: string;
};

export type QuickSplitEditorState = {
  readonly currency: Currency;
  readonly mode: "equal" | "treat" | "individual";
  readonly members: readonly EditorMember[];
  readonly nextMemberNumber: number;
  readonly finalTotal: string;
  readonly chargeMode: "finalTotal" | "details";
  readonly subtotal: string;
  readonly discount: string;
  readonly serviceFeeMode: "none" | "manual" | "quick10";
  readonly serviceFee: string;
  readonly serviceFeeBasis: "beforeDiscount" | "afterDiscount";
  readonly hostId?: string;
  readonly coverKind: "fixed" | "percentage";
  readonly coverAmount: string;
  readonly coverPercentage: string;
  readonly includeHostInRemainder: boolean;
  readonly sharedAmount: string;
  readonly merchantPayerId?: string;
};

export type EditorField =
  | "currency" | "finalTotal" | "members" | "hostId" | "coverAmount" | "coverPercentage"
  | "personalAmount" | "sharedAmount" | "sharedMembers" | "subtotal" | "discount" | "serviceFee"
  | "merchantPayerId";

export type EditorError = { readonly code: DomainErrorCode; readonly field: EditorField; readonly memberId?: string };
export type QuickSplitPreview = { readonly input: QuickSplitInput; readonly snapshot: QuickSplitSnapshot };
type EditorResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: EditorError };

function createMember(number: number): EditorMember {
  return { id: `member-${number}`, displayName: "", included: true, shareCommon: true, personalAmount: "" };
}

export function createQuickSplitEditor(currency: Currency = "HKD"): QuickSplitEditorState {
  return {
    currency, mode: "equal", members: [createMember(1), createMember(2)], nextMemberNumber: 3,
    finalTotal: "", chargeMode: "finalTotal", subtotal: "", discount: "", serviceFeeMode: "none", serviceFee: "",
    serviceFeeBasis: "beforeDiscount", coverKind: "fixed", coverAmount: "", coverPercentage: "",
    includeHostInRemainder: false, sharedAmount: "",
  };
}

export function editorMemberName(member: EditorMember, index: number): string {
  const number = /^member-([1-9]\d*)$/.exec(member.id)?.[1];
  return member.displayName.trim() || `成員 ${number ?? index + 1}`;
}

export function addEditorMember(state: QuickSplitEditorState): QuickSplitEditorState {
  const existing = new Set(state.members.map(({ id }) => id));
  let number = state.nextMemberNumber;
  while (existing.has(`member-${number}`)) number += 1;
  return { ...state, members: [...state.members, createMember(number)], nextMemberNumber: number + 1 };
}

export function removeEditorMember(state: QuickSplitEditorState, id: string): QuickSplitEditorState {
  if (state.members.length <= 1) return state;
  return {
    ...state,
    members: state.members.filter((member) => member.id !== id),
    hostId: state.hostId === id ? undefined : state.hostId,
    merchantPayerId: state.merchantPayerId === id ? undefined : state.merchantPayerId,
  };
}

export function serializeQuickSplitDraft(state: QuickSplitEditorState): QuickDraftInput {
  const { currency, mode, members, merchantPayerId, hostId, ...parameters } = state;
  return {
    currency, mode,
    members: members.map(({ id, displayName }) => ({ id, displayName })),
    ...(merchantPayerId !== undefined ? { merchantPayerId } : {}),
    parameters: {
      ...parameters,
      ...(hostId !== undefined ? { hostId } : {}),
      memberOptions: members.map(({ id, included, shareCommon, personalAmount }) => ({ id, included, shareCommon, personalAmount })),
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function hydrateQuickSplitDraft(input: QuickDraftInput): QuickSplitEditorState {
  const defaults = createQuickSplitEditor();
  if (!input || typeof input !== "object") return defaults;
  const params = input.parameters;
  const options = new Map<string, Pick<EditorMember, "included" | "shareCommon" | "personalAmount">>();
  if (Array.isArray(params?.memberOptions)) {
    for (const option of params.memberOptions) {
      if (typeof option?.id !== "string") continue;
      options.set(option.id, {
        included: option.included !== false, shareCommon: option.shareCommon !== false,
        personalAmount: stringValue(option.personalAmount),
      });
    }
  }
  const seen = new Set<string>();
  const storedMembers: EditorMember[] = [];
  if (Array.isArray(input.members)) {
    for (const member of input.members) {
      if (typeof member?.id !== "string" || member.id.trim() === "" || seen.has(member.id)) continue;
      seen.add(member.id);
      storedMembers.push({
        id: member.id, displayName: stringValue(member.displayName),
        included: true, shareCommon: true, personalAmount: "",
        ...options.get(member.id),
      });
    }
  }
  const members = storedMembers.length > 0 ? storedMembers : defaults.members;
  const idIfPresent = (value: unknown) => members.find(({ id }) => id === value)?.id;
  const storedNextNumber = params?.nextMemberNumber;
  const nextMemberNumber = typeof storedNextNumber === "number" && Number.isSafeInteger(storedNextNumber)
    && storedNextNumber > 0 && storedNextNumber < Number.MAX_SAFE_INTEGER - members.length
    ? storedNextNumber : members.length + 1;

  return {
    currency: isCurrency(input.currency) ? input.currency : defaults.currency,
    mode: input.mode === "treat" || input.mode === "individual" ? input.mode : defaults.mode,
    members, nextMemberNumber,
    finalTotal: stringValue(params?.finalTotal ?? params?.total),
    chargeMode: params?.chargeMode === "details" ? "details" : "finalTotal",
    subtotal: stringValue(params?.subtotal),
    discount: stringValue(params?.discount),
    serviceFeeMode: params?.serviceFeeMode === "manual" || params?.serviceFeeMode === "quick10" ? params.serviceFeeMode : "none",
    serviceFee: stringValue(params?.serviceFee),
    serviceFeeBasis: params?.serviceFeeBasis === "afterDiscount" ? "afterDiscount" : "beforeDiscount",
    hostId: idIfPresent(params?.hostId),
    coverKind: params?.coverKind === "percentage" ? "percentage" : "fixed",
    coverAmount: stringValue(params?.coverAmount),
    coverPercentage: stringValue(params?.coverPercentage),
    includeHostInRemainder: params?.includeHostInRemainder === true,
    sharedAmount: stringValue(params?.sharedAmount),
    merchantPayerId: idIfPresent(input.merchantPayerId),
  };
}

function editorFailure(code: DomainErrorCode, field: EditorField, memberId?: string): EditorResult<never> {
  return { ok: false, error: { code, field, ...(memberId !== undefined ? { memberId } : {}) } };
}

function parseEditorAmount(raw: string, currency: Currency, field: EditorField, { zeroIfBlank = false, memberId }: {
  zeroIfBlank?: boolean; memberId?: string;
} = {}) {
  const text = raw.trim();
  const parsed = parseAmount(zeroIfBlank && text === "" ? "0" : text, currency);
  return parsed.ok ? parsed : editorFailure(parsed.error.code, field, memberId);
}

function parsePercentage(raw: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return editorFailure("INVALID_PERCENTAGE", "coverPercentage");
  const basisPoints = Number(match[1] + (match[2] ?? "").padEnd(2, "0"));
  if (basisPoints > wholeBasisPoints) return editorFailure("INVALID_PERCENTAGE", "coverPercentage");
  return { ok: true, value: basisPoints } as const;
}

function editorCharges(state: QuickSplitEditorState): EditorResult<QuickSplitInput["charges"]> {
  const { currency } = state;
  const total = parseEditorAmount(state.finalTotal, currency, "finalTotal");
  if (!total.ok) return total;
  if (state.chargeMode === "finalTotal") return { ok: true, value: { kind: "finalTotal", total: total.value } };

  const subtotal = parseEditorAmount(state.subtotal, currency, "subtotal");
  if (!subtotal.ok) return subtotal;
  const discount = parseEditorAmount(state.discount, currency, "discount", { zeroIfBlank: true });
  if (!discount.ok) return discount;
  let serviceFee: Extract<QuickSplitInput["charges"], { kind: "details" }>["serviceFee"];
  if (state.serviceFeeMode === "manual") {
    const manual = parseEditorAmount(state.serviceFee, currency, "serviceFee");
    if (!manual.ok) return manual;
    serviceFee = { kind: "manual", amountMinor: manual.value.amountMinor };
  } else if (state.serviceFeeMode === "quick10") {
    serviceFee = { kind: "quick10", basis: state.serviceFeeBasis };
  }

  return { ok: true, value: {
    kind: "details", subtotal: subtotal.value, discountMinor: discount.value.amountMinor, serviceFee, receiptTotal: total.value,
  } };
}

function editorMethod(state: QuickSplitEditorState): EditorResult<QuickSplitInput["method"]> {
  const memberIds = state.members.map(({ id }) => id);
  if (state.mode === "equal") {
    return { ok: true, value: { kind: "equal", memberIds: state.members.filter(({ included }) => included).map(({ id }) => id) } };
  }
  if (state.mode === "treat") {
    if (!state.hostId || !memberIds.includes(state.hostId)) return editorFailure("HOST_NOT_PARTICIPATING", "hostId");
    const coverValue = state.coverKind === "fixed"
      ? parseEditorAmount(state.coverAmount, state.currency, "coverAmount")
      : parsePercentage(state.coverPercentage);
    if (!coverValue.ok) return coverValue;
    const cover = typeof coverValue.value === "number"
      ? { kind: "percentage" as const, basisPoints: coverValue.value }
      : { kind: "fixed" as const, amountMinor: coverValue.value.amountMinor };
    return { ok: true, value: {
      kind: "treat", memberIds,
      options: { hostId: state.hostId, cover, includeHostInRemainder: state.includeHostInRemainder },
    } };
  }

  const personalSpending: PersonalSpending[] = [];
  for (const member of state.members) {
    const parsed = parseEditorAmount(member.personalAmount, state.currency, "personalAmount", { zeroIfBlank: true, memberId: member.id });
    if (!parsed.ok) return parsed;
    personalSpending.push({ memberId: member.id, personalMinor: parsed.value.amountMinor });
  }
  const shared = parseEditorAmount(state.sharedAmount, state.currency, "sharedAmount", { zeroIfBlank: true });
  if (!shared.ok) return shared;
  return { ok: true, value: {
    kind: "individual", personalSpending,
    shared: {
      amountMinor: shared.value.amountMinor,
      memberIds: state.members.filter(({ shareCommon }) => shareCommon).map(({ id }) => id),
    },
  } };
}

function locateError(state: QuickSplitEditorState, { code, field }: Failure["error"]) {
  switch (field) {
    case "currency":
    case "hostId":
    case "subtotal":
    case "discount":
    case "serviceFee":
    case "sharedAmount":
      return editorFailure(code, field);
    case "total":
      return editorFailure(code, state.mode === "individual" && code === "TOTAL_MISMATCH" ? "sharedAmount" : "finalTotal");
    case "receiptTotal":
      return editorFailure(code, "finalTotal");
    case "cover":
      return editorFailure(code, state.coverKind === "percentage" ? "coverPercentage" : "coverAmount");
    case "sharedMemberIds":
      return editorFailure(code, "sharedMembers");
    case "merchantPayment":
      return editorFailure(code, "merchantPayerId");
    case "charges":
      return editorFailure(code, "serviceFee");
    default:
      return editorFailure(code, "members");
  }
}

export function calculateQuickSplitEditor(state: QuickSplitEditorState): EditorResult<QuickSplitPreview> {
  if (!isCurrency(state.currency)) return editorFailure("UNSUPPORTED_CURRENCY", "currency");
  const charges = editorCharges(state);
  if (!charges.ok) return charges;
  const method = editorMethod(state);
  if (!method.ok) return method;
  const input: QuickSplitInput = {
    members: state.members.map((member, index) => ({ id: member.id, displayName: editorMemberName(member, index) })),
    charges: charges.value,
    method: method.value,
    ...(state.merchantPayerId !== undefined ? { merchantPayerId: state.merchantPayerId } : {}),
  };
  const calculated = calculateQuickSplit(input);
  if (!calculated.ok) return locateError(state, calculated.error);
  return { ok: true, value: { input, snapshot: calculated.value } };
}
