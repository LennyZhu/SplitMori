import type { QuickDraftInput } from "../data/quickSplits.ts";
import type { ChargeDistribution } from "../domain/charges.ts";
import { isCurrency, parseAmount, wholeBasisPoints, type Currency } from "../domain/money.ts";
import { calculateQuickSplit, type QuickSplitInput, type QuickSplitSnapshot } from "../domain/quickSplit.ts";
import type { DomainErrorCode, Failure } from "../domain/result.ts";
import type { CustomSplitOptions, ItemSpending, PersonalSpending, TreatOptions } from "../domain/split.ts";

export type EditorHost = {
  readonly hostId?: string;
  readonly coverKind: "fixed" | "percentage";
  readonly coverAmount: string;
  readonly coverPercentage: string;
  readonly includeHostInRemainder: boolean;
};
export type EditorItem = {
  readonly id: string;
  readonly name: string;
  readonly quantity: string;
  readonly amount: string;
  readonly memberIds: readonly string[];
};

export type EditorMember = {
  readonly id: string;
  readonly displayName: string;
  readonly included: boolean;
  readonly shareCommon: boolean;
  readonly personalAmount: string;
};

export type QuickSplitEditorState = {
  readonly currency: Currency;
  readonly mode: QuickSplitInput["method"]["kind"];
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
  readonly extraHosts?: readonly EditorHost[];
  readonly itemized?: boolean;
  readonly items?: readonly EditorItem[];
  readonly customKind?: CustomSplitOptions["kind"];
  readonly customValues?: Readonly<Record<string, string>>;
  readonly feeDistribution?: ChargeDistribution;
  readonly discountDistribution?: ChargeDistribution;
};

export type EditorField =
  | "currency" | "finalTotal" | "members" | "hostId" | "coverAmount" | "coverPercentage"
  | "personalAmount" | "sharedAmount" | "sharedMembers" | "subtotal" | "discount" | "serviceFee"
  | "merchantPayerId" | "hosts" | "items" | "custom" | "chargeDistribution";

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
    extraHosts: state.extraHosts?.filter((host) => host.hostId !== id),
    items: state.items?.map((item) => ({ ...item, memberIds: item.memberIds.filter((memberId) => memberId !== id) })),
    feeDistribution: withoutMember(state.feeDistribution, id),
    discountDistribution: withoutMember(state.discountDistribution, id),
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

function withoutMember(rule: ChargeDistribution | undefined, id: string): ChargeDistribution | undefined {
  return rule?.kind === "selected" ? { ...rule, memberIds: rule.memberIds.filter((memberId) => memberId !== id) } : rule;
}

function hydrateDistribution(raw: unknown, memberIds: ReadonlySet<string>): ChargeDistribution | undefined {
  if (!raw || typeof raw !== "object" || !("kind" in raw)) return;
  if (raw.kind === "equal") return { kind: "equal" };
  if (raw.kind === "selected" && "memberIds" in raw && Array.isArray(raw.memberIds)) {
    return { kind: "selected", memberIds: [...new Set(raw.memberIds.filter((id) => memberIds.has(id)))] };
  }
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
  const feeDistribution = hydrateDistribution(params?.feeDistribution, seen);
  const discountDistribution = hydrateDistribution(params?.discountDistribution, seen);

  return {
    currency: isCurrency(input.currency) ? input.currency : defaults.currency,
    mode: input.mode === "treat" || input.mode === "individual" || input.mode === "custom" ? input.mode : defaults.mode,
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
    ...(Array.isArray(params?.extraHosts) && { extraHosts: params.extraHosts.filter((host) => host && typeof host === "object").map((host) => ({
      hostId: idIfPresent(host.hostId), coverKind: host.coverKind === "percentage" ? "percentage" : "fixed",
      coverAmount: stringValue(host.coverAmount), coverPercentage: stringValue(host.coverPercentage),
      includeHostInRemainder: host.includeHostInRemainder === true,
    })) }),
    ...(typeof params?.itemized === "boolean" && { itemized: params.itemized }),
    ...(Array.isArray(params?.items) && { items: params.items.filter((item) => item && typeof item === "object").map((item, index) => ({
      id: `stored-item-${index}`, name: stringValue(item.name), amount: stringValue(item.amount), quantity: stringValue(item.quantity),
      memberIds: Array.isArray(item.memberIds) ? [...new Set<string>((item.memberIds as unknown[]).filter(
        (id: unknown): id is string => typeof id === "string" && seen.has(id),
      ))] : [],
    })) }),
    ...((params?.customKind === "percentage" || params?.customKind === "shares" || params?.customKind === "fixed") && { customKind: params.customKind }),
    ...(params?.customValues && typeof params.customValues === "object" && { customValues: Object.fromEntries(
      Object.entries(params.customValues).flatMap(([id, value]) => seen.has(id) && typeof value === "string" ? [[id, value]] : []),
    ) }),
    ...(feeDistribution && { feeDistribution }),
    ...(discountDistribution && { discountDistribution }),
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

function parsePercentage(raw: string, field: EditorField = "coverPercentage", memberId?: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return editorFailure("INVALID_PERCENTAGE", field, memberId);
  const basisPoints = Number(match[1] + (match[2] ?? "").padEnd(2, "0"));
  if (basisPoints > wholeBasisPoints) return editorFailure("INVALID_PERCENTAGE", field, memberId);
  return { ok: true, value: basisPoints } as const;
}

function positiveInteger(raw: string) {
  const value = Number(raw.trim());
  return /^\d+$/.test(raw.trim()) && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseHost(host: EditorHost, currency: Currency, memberIds: readonly string[], multiple: boolean): EditorResult<TreatOptions> {
  if (!host.hostId || !memberIds.includes(host.hostId)) return editorFailure("HOST_NOT_PARTICIPATING", multiple ? "hosts" : "hostId");
  const coverValue = host.coverKind === "fixed"
    ? parseEditorAmount(host.coverAmount, currency, multiple ? "hosts" : "coverAmount")
    : parsePercentage(host.coverPercentage, multiple ? "hosts" : "coverPercentage");
  if (!coverValue.ok) return coverValue;
  const cover = typeof coverValue.value === "number"
    ? { kind: "percentage" as const, basisPoints: coverValue.value }
    : { kind: "fixed" as const, amountMinor: coverValue.value.amountMinor };
  return { ok: true, value: { hostId: host.hostId, cover, includeHostInRemainder: host.includeHostInRemainder } };
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
    ...((state.mode === "equal" || state.mode === "individual") && (state.feeDistribution || state.discountDistribution)
      ? { distribution: { serviceFee: state.feeDistribution, discount: state.discountDistribution } } : {}),
  } };
}

function editorMethod(state: QuickSplitEditorState): EditorResult<QuickSplitInput["method"]> {
  const memberIds = state.members.map(({ id }) => id);
  if (state.mode === "equal") {
    return { ok: true, value: { kind: "equal", memberIds: state.members.filter(({ included }) => included).map(({ id }) => id) } };
  }
  if (state.mode === "treat") {
    const extra = state.extraHosts ?? [];
    const host = parseHost(state, state.currency, memberIds, extra.length > 0);
    if (!host.ok) return host;
    const hosts = [host.value];
    for (const draft of extra) {
      const parsed = parseHost(draft, state.currency, memberIds, true);
      if (!parsed.ok) return parsed;
      hosts.push(parsed.value);
    }
    return { ok: true, value: { kind: "treat", memberIds, options: extra.length ? { hosts } : host.value } };
  }
  if (state.mode === "custom") {
    const participants = state.members.filter(({ included }) => included);
    const kind = state.customKind ?? "fixed";
    const fixed: { memberId: string; amountMinor: number }[] = [];
    const percentages: { memberId: string; basisPoints: number }[] = [];
    const weighted: { memberId: string; shares: number }[] = [];
    for (const { id } of participants) {
      const raw = state.customValues?.[id] ?? "";
      if (kind === "fixed") {
        const amount = parseEditorAmount(raw, state.currency, "custom", { memberId: id });
        if (!amount.ok) return amount;
        fixed.push({ memberId: id, amountMinor: amount.value.amountMinor });
      } else if (kind === "percentage") {
        const percent = parsePercentage(raw, "custom", id);
        if (!percent.ok) return percent;
        percentages.push({ memberId: id, basisPoints: percent.value });
      } else {
        const shares = positiveInteger(raw);
        if (shares === undefined) return editorFailure("INVALID_SHARE_COUNT", "custom", id);
        weighted.push({ memberId: id, shares });
      }
    }
    const options: CustomSplitOptions = kind === "fixed" ? { kind, members: fixed }
      : kind === "percentage" ? { kind, members: percentages } : { kind, members: weighted };
    return { ok: true, value: { kind: "custom", options } };
  }
  if (state.itemized) {
    const items: ItemSpending[] = [];
    for (const item of state.items ?? []) {
      const amount = parseEditorAmount(item.amount, state.currency, "items");
      if (!amount.ok) return amount;
      const quantity = positiveInteger(item.quantity);
      if (!item.name.trim() || quantity === undefined) return editorFailure("INVALID_QUICK_INPUT", "items");
      items.push({ name: item.name.trim(), quantity, amountMinor: amount.value.amountMinor, memberIds: item.memberIds });
    }
    return { ok: true, value: { kind: "individual", memberIds, items } };
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
    case "items":
    case "hosts":
    case "chargeDistribution":
      return editorFailure(code, field);
    case "basisPoints":
    case "shares":
    case "allocations":
      return editorFailure(code, state.mode === "custom" ? "custom" : "members");
    case "total":
      return editorFailure(code, state.mode === "individual" && code === "TOTAL_MISMATCH" ? "sharedAmount" : "finalTotal");
    case "receiptTotal":
      return editorFailure(code, "finalTotal");
    case "cover":
      return editorFailure(code, state.extraHosts?.length ? "hosts" : state.coverKind === "percentage" ? "coverPercentage" : "coverAmount");
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

export function lockedAdvancedField(state: QuickSplitEditorState, hasProAccess: boolean): EditorField | undefined {
  if (hasProAccess) return;
  if (state.mode === "custom") return "custom";
  if (state.mode === "treat" && state.extraHosts?.length) return "hosts";
  if (state.mode === "individual" && state.itemized) return "items";
  if (state.chargeMode === "details" && (state.mode === "equal" || state.mode === "individual")
    && (state.feeDistribution || state.discountDistribution)) return "chargeDistribution";
}

export function calculateQuickSplitEditor(state: QuickSplitEditorState, hasProAccess = true): EditorResult<QuickSplitPreview> {
  const locked = lockedAdvancedField(state, hasProAccess);
  if (locked) return editorFailure("PRO_REQUIRED", locked);
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
