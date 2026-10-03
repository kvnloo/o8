/**
 * Ripple clarification gate for hurttlocker/o8#3188.
 *
 * No Spatial Ink surface and no capture. This module only decides whether
 * one question is shown and whether an accepted choice is an allowlisted
 * semantic patch. It never sends, dispatches, or mints authority.
 */
export const RIPPLE_CLARIFICATION_SCHEMA = "o8.z0int.ripple-clarification/v0" as const;

const ALLOWED_PATCH_PREFIXES = [
  "intent.",
  "constraints.",
  "references.",
  "verification.",
] as const;

export type RippleChoice = {
  id: string;
  patchPath: string;
};

export type RippleQuestion = {
  question: string;
  choices: readonly RippleChoice[];
};

export type RipplePatch = {
  path: string;
  choiceId: string;
};

export type RippleState = {
  schema: typeof RIPPLE_CLARIFICATION_SCHEMA;
  questions: readonly RippleQuestion[];
  patch: RipplePatch | null;
  durableChange: boolean;
  autoSent: false;
};

export function patchPathAllowed(path: string): boolean {
  return ALLOWED_PATCH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function eligible(question: RippleQuestion): boolean {
  const count = question.choices.length;
  return question.question.trim() !== "" && count >= 2 && count <= 4;
}

/**
 * Invariant ripple_one_clarification_no_autosend (surface):
 * at most one question is returned. Zero or ineligible candidates disappear.
 * autoSent stays false and nothing durable is written.
 */
export function surfaceOneClarification(candidates: readonly RippleQuestion[]): RippleState {
  const first = candidates.find(eligible);
  return {
    schema: RIPPLE_CLARIFICATION_SCHEMA,
    questions: first ? [first] : [],
    patch: null,
    durableChange: false,
    autoSent: false,
  };
}

/**
 * Invariant ripple_one_clarification_no_autosend (resolve):
 * dismiss writes no patch. An accepted choice is kept only when its path is
 * allowlisted. autoSent is false on every path, including acceptance.
 */
export function resolveClarification(
  state: RippleState,
  action: "accept" | "dismiss",
  choiceId?: string,
): RippleState {
  const quiet: RippleState = {
    schema: RIPPLE_CLARIFICATION_SCHEMA,
    questions: [],
    patch: null,
    durableChange: false,
    autoSent: false,
  };
  if (action === "dismiss" || state.questions.length === 0) {
    return quiet;
  }
  const question = state.questions[0];
  const choice = question.choices.find((item) => item.id === choiceId);
  if (!choice || !patchPathAllowed(choice.patchPath)) {
    return quiet;
  }
  return {
    schema: RIPPLE_CLARIFICATION_SCHEMA,
    questions: [],
    patch: { path: choice.patchPath, choiceId: choice.id },
    durableChange: true,
    autoSent: false,
  };
}
