import type { Revisioned } from './persistence';

/** 整改状态：待整改 / 已复核 */
export type RectifyState = 'pending' | 'reviewed';

export const RECTIFY_STATE_LABEL: Record<RectifyState, string> = {
  pending: '待整改',
  reviewed: '已复核',
};

/** 整改单来源：年检登记 / 保养异常项转单 / 困人复盘登记 */
export type RectifySource = 'annual' | 'maintenance' | 'rescue';

export const RECTIFY_SOURCE_LABEL: Record<RectifySource, string> = {
  annual: '年检',
  maintenance: '保养',
  rescue: '救援',
};

/** 复盘处理方式：保养项新建 / 复用未复核单 / 按救援原因新建 / 保养页转单 / 手工登记 */
export type RectifyHandleKind =
  | 'fromMaintenance'
  | 'rescueReuse'
  | 'fromRescueCause'
  | 'maintenancePromote'
  | 'manual';

export const RECTIFY_HANDLE_LABEL: Record<RectifyHandleKind, string> = {
  fromMaintenance: '沿用保养项登记',
  rescueReuse: '复用未复核整改单',
  fromRescueCause: '按救援原因登记',
  maintenancePromote: '异常项转整改',
  manual: '手工登记',
};

/** 年检整改单 */
export interface Rectify extends Revisioned {
  id: string;
  /** 所属电梯 */
  elevatorId: string;
  /** 不合格项 */
  item: string;
  /** 限期 yyyy-MM-dd */
  dueDate: string;
  /** 状态 */
  state: RectifyState;
  /** 复核人 */
  reviewer: string;
  /** 复核时间 */
  reviewedAt: string | null;
  /** 来源 */
  source: RectifySource;
  /** 来源说明（如：2026-09-15 半月保养 · 层门锁紧装置） */
  sourceNote: string;
  /** 复盘处理方式 */
  handleKind: RectifyHandleKind;
  /** 关联困人事件（来源 / 复用涉及救援时登记） */
  rescueId: string | null;
  /** 被哪些困人事件复用（复用未复核单时追加，避免同故障重复开单） */
  rescueIds: string[];
  createdAt: string;
}

/** 整改单草稿 */
export interface RectifyDraft {
  elevatorId: string;
  item: string;
  dueDate: string;
  reviewer: string;
  source?: RectifySource;
  sourceNote?: string;
  handleKind?: RectifyHandleKind;
  rescueId?: string | null;
}

/** 整改单视图：带电梯上下文与超期天数 */
export interface RectifyView extends Rectify {
  elevatorName: string;
  owner: string;
  /** 是否超期（未复核且限期早于今天） */
  overdue: boolean;
  /** 超期天数（未超期为 0） */
  overdueDays: number;
  /** 关联困人事件报警时间（用于来源展示） */
  rescueAlarmAt: string | null;
}

/** 年检不合格项字典 */
export const RECTIFY_ITEM_LIBRARY: string[] = [
  '限速器动作速度超差',
  '层门门锁啮合深度不足',
  '制动器制动力矩不足',
  '缓冲器复位异常',
  '钢丝绳断丝超标',
  '轿厢应急照明失效',
  '超载保护装置失灵',
  '机房通风不符合要求',
];

/** 超期天数计算 */
export function overdueDaysOf(dueDate: string, state: RectifyState, now: Date = new Date()): number {
  if (state === 'reviewed') return 0;
  const due = new Date(`${dueDate}T23:59:59`);
  if (Number.isNaN(due.getTime())) return 0;
  const diff = now.getTime() - due.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (24 * 3600 * 1000));
}
