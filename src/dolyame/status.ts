import type { DolyameStatus } from "./types.js";

/**
 * Status lifecycle assembled from the documentation pages "Работа с заявкой", "Webhooks" and
 * "Тестовая заявка":
 *
 *   new              -> approved         buyer passed the data check
 *   new              -> rejected         refusal after the check
 *   new, approved    -> canceled         not paid within 24 hours
 *   approved         -> wait_for_commit  first 25 % held; the bank is ready to accept `commit`
 *   wait_for_commit  -> committed        `commit` (or the shop's auto-confirmation), due within 72 h of create
 *   wait_for_commit  -> canceled         `cancel` call, or no commit within 72 h
 *   committed        -> completed        first payment debited
 *
 * `waiting_for_commit` appears in the OpenAPI status enum, but only `wait_for_commit` is used in the
 * webhook documentation; they are treated as the same state (an assumption, not stated by the docs).
 * Refunds do not change the status: they are tracked in `refund_info`.
 */
export type DolyameLifecycleStatus = Exclude<DolyameStatus, "waiting_for_commit">;

export const DOLYAME_TRANSITIONS: Readonly<Record<DolyameLifecycleStatus, readonly DolyameLifecycleStatus[]>> = {
  new: ["approved", "rejected", "canceled"],
  approved: ["wait_for_commit", "canceled"],
  wait_for_commit: ["committed", "canceled"],
  committed: ["completed"],
  completed: [],
  rejected: [],
  canceled: [],
};

export const DOLYAME_TERMINAL_STATUSES: readonly DolyameLifecycleStatus[] = ["completed", "rejected", "canceled"];

export function canonicalDolyameStatus(status: DolyameStatus): DolyameLifecycleStatus {
  return status === "waiting_for_commit" ? "wait_for_commit" : status;
}

export function isTerminalDolyameStatus(status: DolyameStatus): boolean {
  return DOLYAME_TERMINAL_STATUSES.includes(canonicalDolyameStatus(status));
}

/** A single documented step, e.g. `approved -> wait_for_commit`. */
export function canTransitionDolyame(from: DolyameStatus, to: DolyameStatus): boolean {
  return DOLYAME_TRANSITIONS[canonicalDolyameStatus(from)].includes(canonicalDolyameStatus(to));
}

/** Can `to` be reached from `from` through documented steps (webhooks can be lost or reordered)? */
export function isDolyameStatusReachable(from: DolyameStatus, to: DolyameStatus): boolean {
  const target = canonicalDolyameStatus(to);
  const seen = new Set<DolyameLifecycleStatus>();
  const queue: DolyameLifecycleStatus[] = [canonicalDolyameStatus(from)];
  while (queue.length > 0) {
    const current = queue.shift() as DolyameLifecycleStatus;
    for (const next of DOLYAME_TRANSITIONS[current]) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Should an incoming status (webhook or `info`) replace the one you stored?
 * False for duplicates and for late/out-of-order notifications that would move an order backwards.
 */
export function shouldApplyDolyameStatus(current: DolyameStatus, incoming: DolyameStatus): boolean {
  return canonicalDolyameStatus(current) !== canonicalDolyameStatus(incoming) && isDolyameStatusReachable(current, incoming);
}

/** `commit` is accepted in `wait_for_commit` (docs: the bank "is ready to accept commit"). */
export function canCommitDolyame(status: DolyameStatus): boolean {
  return canonicalDolyameStatus(status) === "wait_for_commit";
}

/** Docs: "Отменить заказ можно только в статусе wait_for_commit". */
export function canCancelDolyame(status: DolyameStatus): boolean {
  return canonicalDolyameStatus(status) === "wait_for_commit";
}
