import type { Revisioned } from './persistence';
import type { RectifyHandleKind, RectifyState } from './rectify';

/** 困人事件原因字典 */
export const RESCUE_CAUSES = [
  '门锁回路故障',
  '停电困人',
  '变频器故障',
  '平层感应器失效',
  '钢丝绳打滑',
  '超载保护动作',
] as const;

/** 困人事件 */
export interface Rescue extends Revisioned {
  id: string;
  /** 所属电梯 */
  elevatorId: string;
  /** 报警时间 yyyy-MM-dd HH:mm */
  alarmAt: string;
  /** 到场时间 */
  arriveAt: string;
  /** 救出时间 */
  rescueAt: string;
  /** 原因 */
  cause: string;
  /** 被困人数 */
  trappedCount: number;
  /** 救援人 */
  responder: string;
  /** 复盘关联整改单（已登记 / 复用后回写） */
  rectifyId: string | null;
  /** 复盘处理方式 */
  rectifyHandleKind: RectifyHandleKind | null;
  createdAt: string;
}

/** 困人事件草稿 */
export interface RescueDraft {
  elevatorId: string;
  alarmAt: string;
  arriveAt: string;
  rescueAt: string;
  cause: string;
  trappedCount: number;
  responder: string;
}

/** 困人事件视图：自动算到场与救援时长 */
export interface RescueView extends Rescue {
  elevatorName: string;
  owner: string;
  /** 报警 → 到场（分钟） */
  arriveMinutes: number;
  /** 报警 → 救出（分钟） */
  rescueMinutes: number;
  /** 是否满足 30 分钟到场要求 */
  arriveInTime: boolean;
  /** 时间线节点（用于回放展示） */
  timeline: RescueTimelineNode[];
  /** 复盘关联整改单 */
  linkedRectify: RescueLinkedRectify | null;
}

/** 复盘关联整改单摘要 */
export interface RescueLinkedRectify {
  id: string;
  item: string;
  dueDate: string;
  state: RectifyState;
  sourceNote: string;
  handleKind: RectifyHandleKind;
}

/** 时间线节点 */
export interface RescueTimelineNode {
  label: string;
  at: string;
  minutesFromAlarm: number;
  tone: 'alarm' | 'arrive' | 'rescue';
  detail: string;
}

/** 到场时限（分钟）：按特种设备应急要求 30 分钟内到场 */
export const ARRIVE_LIMIT_MINUTES = 30;

/** 救出时长红线（分钟）：超过 1 小时按加急限期处置 */
export const RESCUE_DURATION_LIMIT_MINUTES = 60;

/** 加急整改限期（天）：到场超时或救出超过 1 小时 */
export const RESCUE_URGENT_DUE_DAYS = 3;

/** 常规整改限期（天） */
export const RESCUE_NORMAL_DUE_DAYS = 7;

/**
 * 救援原因 → 最近一次保养异常 / 建议项的匹配关键词。
 * 复盘时按关键词在同电梯最近一次已签署计划的异常 / 建议项中查找对应保养项。
 */
export const RESCUE_CAUSE_KEYWORDS: Array<{ cause: string; keywords: string[] }> = [
  { cause: '门锁回路故障', keywords: ['层门', '门锁', '锁紧'] },
  { cause: '停电困人', keywords: ['应急照明', '警铃', '电源'] },
  { cause: '变频器故障', keywords: ['变频', '制动器', '制动'] },
  { cause: '平层感应器失效', keywords: ['平层'] },
  { cause: '钢丝绳打滑', keywords: ['钢丝绳'] },
  { cause: '超载保护动作', keywords: ['超载'] },
];

/** 按救援原因给出保养项匹配关键词（支持自定义原因的包含匹配） */
export function keywordsForCause(cause: string): string[] {
  const hit = RESCUE_CAUSE_KEYWORDS.find((entry) => entry.cause === cause);
  if (hit) return hit.keywords;
  return [cause.replace(/故障|失效|困人|动作|打滑/g, '')].filter(Boolean);
}
