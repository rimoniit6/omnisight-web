/**
 * Analytics Comparison Tool — query building & validation (pure, testable).
 *
 * The Comparison Tool previously dereferenced `start1!.toISOString()` during
 * render, which crashed the component the moment "Time Periods" was selected
 * before any date was picked. All query construction and range validation now
 * lives HERE so the component stays crash-free and the rules are unit-testable
 * without a DOM.
 *
 * Date serialization contract: user-selected calendar dates are serialized as
 * the LOCAL calendar day (never `toISOString().split('T')[0]`, which can shift
 * the day backward for positive-offset zones like Asia/Dhaka).
 */

export interface CompareDates {
  start1?: Date;
  end1?: Date;
  start2?: Date;
  end2?: Date;
}

export type CompareQueryResult =
  | { ok: true; params: string }
  | { ok: false; reason: 'incomplete' | 'invalid-range' };

/**
 * Local calendar day (YYYY-MM-DD) of `date`, from the machine's local clock.
 * Correct for serializing a user-picked calendar date regardless of the
 * browser timezone — never use `toISOString().split('T')[0]` for this.
 */
export function toLocalDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Build the `periods` comparison query string. Returns ok:false with a reason
 * while any date is missing (query must stay disabled) or when a start date is
 * after its end date (validation — no meaningless API request). Only a fully
 * valid selection produces query params.
 */
export function buildPeriodCompareQuery(dates: CompareDates): CompareQueryResult {
  const { start1, end1, start2, end2 } = dates;
  if (!start1 || !end1 || !start2 || !end2) {
    return { ok: false, reason: 'incomplete' };
  }
  if (start1.getTime() > end1.getTime() || start2.getTime() > end2.getTime()) {
    return { ok: false, reason: 'invalid-range' };
  }
  const p = new URLSearchParams();
  p.set('mode', 'periods');
  p.set('startDate1', toLocalDayKey(start1));
  p.set('endDate1', toLocalDayKey(end1));
  p.set('startDate2', toLocalDayKey(start2));
  p.set('endDate2', toLocalDayKey(end2));
  return { ok: true, params: p.toString() };
}

/** True once both selected dates are present and in range (start <= end). */
export function isValidPeriodPair(start: Date | undefined, end: Date | undefined): boolean {
  return Boolean(start && end && start.getTime() <= end.getTime());
}

/**
 * Build the `departments` comparison query string (including the shared
 * analytics date range so the department query is bounded, never unbounded).
 * Returns ok:false until two different departments are selected.
 */
export function buildDepartmentCompareQuery(
  dept1: string,
  dept2: string,
  range?: { from: Date; to: Date }
): { ok: boolean; params: string } {
  if (!dept1 || !dept2 || dept1 === dept2) return { ok: false, params: '' };
  const p = new URLSearchParams();
  p.set('mode', 'departments');
  p.set('id1', dept1);
  p.set('id2', dept2);
  if (range) {
    p.set('startDate', toLocalDayKey(range.from));
    p.set('endDate', toLocalDayKey(range.to));
  }
  return { ok: true, params: p.toString() };
}
