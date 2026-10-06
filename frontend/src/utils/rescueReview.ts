/**
 * 困人复盘整改判定：
 * - 沿同一电梯最近一次已签署保养计划查找与救援原因对应的异常 / 建议项
 * - 命中则优先沿用该保养项，并复用同项未复核整改单；未命中才按救援原因登记
 * - 限期：到场超时或救出超过 1 小时为 3 日，其余 7 日；复用已有待整改单不换限期
 */
import type { CheckItem } from '../types/checkItem';
import type { Plan } from '../types/plan';
import type { Rectify } from '../types/rectify';
import type { Rescue } from '../types/rescue';
import {
  ARRIVE_LIMIT_MINUTES,
  RESCUE_DURATION_LIMIT_MINUTES,
  RESCUE_NORMAL_DUE_DAYS,
  RESCUE_URGENT_DUE_DAYS,
  keywordsForCause,
} from '../types/rescue';
import { arriveMinutes, rescueMinutes } from './duration';
import { addDays } from './cycle';

/** 复盘可能命中的处置方式 */
export type ReviewOutcome =
  | { kind: 'rescueReuse'; item: string; rectifyId: string }
  | { kind: 'fromMaintenance'; item: string; planId: string; checkItemId: string; sourceNote: string }
  | { kind: 'fromRescueCause'; item: string };

/**
 * 最近一次已签署计划：优先签署时间不晚于报警时间的最近一期；
 * 若全部签署都在报警之后（事后补录场景），退化为全局最近签署的一期。
 */
export function latestSignedPlan(plans: Plan[], elevatorId: string, alarmAt: string): Plan | null {
  const signed = plans
    .filter((plan) => plan.elevatorId === elevatorId && plan.state === 'signed')
    .sort((a, b) => (b.signedAt ?? b.planDate).localeCompare(a.signedAt ?? a.planDate));
  if (signed.length === 0) return null;
  const beforeAlarm = signed.filter((plan) => (plan.signedAt ?? `${plan.planDate} 23:59`) <= alarmAt);
  return beforeAlarm[0] ?? signed[0];
}

/** 在指定计划的异常 / 建议项中，按救援原因关键词匹配对应保养项 */
export function matchCheckItem(
  items: CheckItem[],
  planId: string,
  cause: string,
): { item: CheckItem; keyword: string } | null {
  const keywords = keywordsForCause(cause);
  const scoped = items
    .filter((entry) => entry.planId === planId && (entry.result === 'abnormal' || entry.result === 'advice'))
    .sort((a, b) => a.seq - b.seq);
  for (const keyword of keywords) {
    const hit = scoped.find((entry) => entry.itemName.includes(keyword));
    if (hit) return { item: hit, keyword };
  }
  return null;
}

/** 是否加急：到场超时或救出超过 1 小时 */
export function isUrgentRescue(rescue: Pick<Rescue, 'alarmAt' | 'arriveAt' | 'rescueAt'>): boolean {
  const arrive = arriveMinutes(rescue.alarmAt, rescue.arriveAt);
  const total = rescueMinutes(rescue.alarmAt, rescue.rescueAt);
  return arrive > ARRIVE_LIMIT_MINUTES || total > RESCUE_DURATION_LIMIT_MINUTES;
}

/** 整改限期天数 */
export function reviewDueDays(rescue: Pick<Rescue, 'alarmAt' | 'arriveAt' | 'rescueAt'>): number {
  return isUrgentRescue(rescue) ? RESCUE_URGENT_DUE_DAYS : RESCUE_NORMAL_DUE_DAYS;
}

/** 以救出日期为基准推算整改限期 yyyy-MM-dd */
export function reviewDueDate(rescue: Pick<Rescue, 'alarmAt' | 'arriveAt' | 'rescueAt'>): string {
  const base = rescue.rescueAt?.slice(0, 10) || rescue.alarmAt.slice(0, 10);
  return addDays(base, reviewDueDays(rescue));
}

/** 加急原因文案（用于页面提示） */
export function urgentReasonText(rescue: Pick<Rescue, 'alarmAt' | 'arriveAt' | 'rescueAt'>): string {
  const reasons: string[] = [];
  if (arriveMinutes(rescue.alarmAt, rescue.arriveAt) > ARRIVE_LIMIT_MINUTES) reasons.push('到场超时');
  if (rescueMinutes(rescue.alarmAt, rescue.rescueAt) > RESCUE_DURATION_LIMIT_MINUTES) reasons.push('救出超过 1 小时');
  return reasons.join('、');
}

/**
 * 复盘判定：沿最近一次已签署计划找对应异常 / 建议项；
 * 找到则优先沿用保养项并复用同项未复核整改单，找不到时按救援原因登记。
 */
export function resolveReviewOutcome(params: {
  rescue: Rescue;
  plans: Plan[];
  checkItems: CheckItem[];
  rectifies: Rectify[];
}): { outcome: ReviewOutcome; plan: Plan | null; matched: ReturnType<typeof matchCheckItem> } {
  const { rescue, plans, checkItems, rectifies } = params;
  const plan = latestSignedPlan(plans, rescue.elevatorId, rescue.alarmAt);
  const matched = plan ? matchCheckItem(checkItems, plan.id, rescue.cause) : null;

  const itemName = matched?.item.itemName ?? rescue.cause;
  const pending = rectifies.find(
    (row) =>
      row.elevatorId === rescue.elevatorId &&
      row.state === 'pending' &&
      row.item === itemName,
  );
  if (pending) {
    return {
      outcome: { kind: 'rescueReuse', item: itemName, rectifyId: pending.id },
      plan,
      matched,
    };
  }
  if (matched && plan) {
    return {
      outcome: {
        kind: 'fromMaintenance',
        item: matched.item.itemName,
        planId: plan.id,
        checkItemId: matched.item.id,
        sourceNote: `${plan.planDate} 已签署保养${matched.item.result === 'advice' ? '建议' : '异常'}项 · ${matched.item.itemName}`,
      },
      plan,
      matched,
    };
  }
  return { outcome: { kind: 'fromRescueCause', item: rescue.cause }, plan, matched };
}
