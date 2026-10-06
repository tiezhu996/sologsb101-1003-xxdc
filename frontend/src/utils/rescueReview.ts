/**
 * 困人复盘 → 整改登记规则（纯函数，无 IndexedDB 依赖）
 *
 * 复盘后决定整改单怎么开，避免同一故障留下两张待整改单：
 * 1. 沿同一电梯查找报警之前最近一期「已签署」保养计划，在其异常 / 建议项中
 *    按救援原因匹配对应项；命中则沿用该保养项名，并优先复用同电梯同项名的
 *    待整改单（不换限期、不再新建）。
 * 2. 找不到对应保养项时，才按救援原因登记新整改项。
 * 3. 到场超时（>30 分钟）或救出超过一小时，限期 3 日；其余 7 日；
 *    自救出当日起算。复用已有待整改单时保留其原限期。
 */
import type { CheckItemRow, PlanRow, RectifyRow } from './db';
import { ARRIVE_LIMIT_MINUTES, type Rescue } from '../types/rescue';
import { arriveMinutes, rescueMinutes } from './duration';
import { addDays } from './cycle';

export { ARRIVE_LIMIT_MINUTES };
/** 救出限期（分钟）：超过 1 小时属于处置迟缓 */
export const RESCUE_LIMIT_MINUTES = 60;
/** 加紧整改限期（自然日）：到场超时或救出超一小时 */
export const URGENT_DUE_DAYS = 3;
/** 常规整改限期（自然日） */
export const NORMAL_DUE_DAYS = 7;

/**
 * 救援原因 → 保养项名匹配关键词。
 * 命中任一关键词即认为该异常 / 建议项与本次困人原因对应。
 */
const CAUSE_ITEM_KEYWORDS: Array<{ cause: string; keywords: string[] }> = [
  { cause: '门锁回路故障', keywords: ['层门', '门锁', '锁紧'] },
  { cause: '停电困人', keywords: ['停电', '应急照明', '警铃'] },
  { cause: '变频器故障', keywords: ['变频'] },
  { cause: '平层感应器失效', keywords: ['平层'] },
  { cause: '钢丝绳打滑', keywords: ['钢丝绳'] },
  { cause: '超载保护动作', keywords: ['超载'] },
];

/** 保养项是否与救援原因对应（字典未覆盖的自定义原因无法匹配，走按原因登记） */
export function itemMatchesCause(itemName: string, cause: string): boolean {
  const rule = CAUSE_ITEM_KEYWORDS.find((entry) => entry.cause === cause);
  if (!rule) return false;
  return rule.keywords.some((keyword) => itemName.includes(keyword));
}

/** 是否触发加紧限期：到场超时或救出超过一小时（时间缺失时该段不判超时） */
export function isUrgentRescue(rescue: Pick<Rescue, 'alarmAt' | 'arriveAt' | 'rescueAt'>): boolean {
  const arrive = arriveMinutes(rescue.alarmAt, rescue.arriveAt);
  const total = rescueMinutes(rescue.alarmAt, rescue.rescueAt);
  return arrive > ARRIVE_LIMIT_MINUTES || total > RESCUE_LIMIT_MINUTES;
}

/** 建议整改限期天数：3 / 7 */
export function suggestedDueDays(rescue: Pick<Rescue, 'alarmAt' | 'arriveAt' | 'rescueAt'>): number {
  return isUrgentRescue(rescue) ? URGENT_DUE_DAYS : NORMAL_DUE_DAYS;
}

/** 建议整改限期日期 yyyy-MM-dd（自救出当日起算） */
export function suggestedDueDate(rescue: Pick<Rescue, 'rescueAt' | 'alarmAt' | 'arriveAt'>): string {
  const base = rescue.rescueAt?.slice(0, 10) || rescue.alarmAt.slice(0, 10);
  return addDays(base, suggestedDueDays(rescue));
}

/** 同一电梯报警之前（含当日）的已签署计划，按计划日期倒序（最近一期在前） */
export function latestSignedPlansBeforeRescue(
  plans: PlanRow[],
  elevatorId: string,
  rescue: Pick<Rescue, 'alarmAt'>,
): PlanRow[] {
  const alarmDate = rescue.alarmAt.slice(0, 10);
  return plans
    .filter((plan) => plan.elevatorId === elevatorId && plan.state === 'signed' && plan.planDate <= alarmDate)
    .sort((a, b) => b.planDate.localeCompare(a.planDate));
}

/**
 * 在最近一次已签署计划中查找与救援原因对应的异常 / 建议项。
 * 从最近一期向前逐期找，先找异常项、再找建议项；找不到返回 null。
 */
export function findRelatedCheckItem(
  plans: PlanRow[],
  items: CheckItemRow[],
  elevatorId: string,
  rescue: Pick<Rescue, 'alarmAt' | 'cause'>,
): { plan: PlanRow; item: CheckItemRow } | null {
  for (const plan of latestSignedPlansBeforeRescue(plans, elevatorId, rescue)) {
    const scoped = items
      .filter((item) => item.planId === plan.id && (item.result === 'abnormal' || item.result === 'advice'))
      .filter((item) => itemMatchesCause(item.itemName, rescue.cause))
      // 异常项优先于建议项
      .sort((a, b) => (a.result === b.result ? a.seq - b.seq : a.result === 'abnormal' ? -1 : 1));
    if (scoped.length > 0) return { plan, item: scoped[0] };
  }
  return null;
}

/** 同电梯同项名的待整改单（用于复用，避免同一故障两张待整改单） */
export function findPendingRectify(
  rectifies: RectifyRow[],
  elevatorId: string,
  item: string,
): RectifyRow | null {
  return (
    rectifies.find(
      (row) => row.elevatorId === elevatorId && row.item === item && row.state === 'pending',
    ) ?? null
  );
}

export type RescueRectifyResolutionMode = 'reuseMaintenance' | 'createMaintenance' | 'createCause';

export interface RescueRectifyResolution {
  /** 整改项名 */
  item: string;
  /** 处置方式：复用保养待整改单 / 按保养项新建 / 按救援原因新建 */
  mode: RescueRectifyResolutionMode;
  /** 沿用的保养计划（命中保养项时存在） */
  plan: PlanRow | null;
  /** 沿用的保养项（命中保养项时存在） */
  checkItem: CheckItemRow | null;
  /** 复用的已有待整改单（mode=reuseMaintenance 时存在） */
  existingRectify: RectifyRow | null;
  /** 是否触发加紧限期 */
  urgent: boolean;
  /** 新建时的建议限期（复用已有单时仍给出，仅作提示） */
  dueDate: string;
  /** 判定说明文案（救援页展示来源与处理依据） */
  reasonText: string;
}

/**
 * 复盘整改判定主入口：
 * 给出该困人事件应沿用 / 复用 / 新建的整改项与限期口径。
 */
export function resolveRescueRectify(input: {
  rescue: Rescue;
  plans: PlanRow[];
  checkItems: CheckItemRow[];
  rectifies: RectifyRow[];
}): RescueRectifyResolution {
  const { rescue, plans, checkItems, rectifies } = input;
  const urgent = isUrgentRescue(rescue);
  const dueDate = suggestedDueDate(rescue);
  const related = findRelatedCheckItem(plans, checkItems, rescue.elevatorId, rescue);

  if (related) {
    const existing = findPendingRectify(rectifies, rescue.elevatorId, related.item.itemName);
    if (existing) {
      return {
        item: related.item.itemName,
        mode: 'reuseMaintenance',
        plan: related.plan,
        checkItem: related.item,
        existingRectify: existing,
        urgent,
        dueDate,
        reasonText: `沿用 ${related.plan.planDate} 已签署保养的${
          related.item.result === 'advice' ? '建议项' : '异常项'
        }「${related.item.itemName}」，复用待整改单（保留原限期 ${existing.dueDate}）`,
      };
    }
    return {
      item: related.item.itemName,
      mode: 'createMaintenance',
      plan: related.plan,
      checkItem: related.item,
      existingRectify: null,
      urgent,
      dueDate,
      reasonText: `沿用 ${related.plan.planDate} 已签署保养的${
        related.item.result === 'advice' ? '建议项' : '异常项'
      }「${related.item.itemName}」登记整改，${urgent ? `到场 / 救出超时，限期 ${URGENT_DUE_DAYS} 日` : `限期 ${NORMAL_DUE_DAYS} 日`}`,
    };
  }

  return {
    item: rescue.cause,
    mode: 'createCause',
    plan: null,
    checkItem: null,
    existingRectify: null,
    urgent,
    dueDate,
    reasonText: `最近一次已签署保养无对应异常 / 建议项，按救援原因「${rescue.cause}」登记，${
      urgent ? `到场 / 救出超时，限期 ${URGENT_DUE_DAYS} 日` : `限期 ${NORMAL_DUE_DAYS} 日`
    }`,
  };
}
