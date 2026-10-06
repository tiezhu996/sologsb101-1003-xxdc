/**
 * 年检整改状态（Pinia）
 * 维护整改单跟踪、复核关闭与超期预警派生值。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  ROW_REVISION,
  listElevators,
  listRectifies,
  putRectify,
  listCheckItems,
  listPlans,
  listRescues,
  putRescue,
  removeRectify,
  type CheckItemRow,
  type ElevatorRow,
  type PlanRow,
  type RectifyRow,
  type RescueRow,
} from '../utils/db';
import {
  overdueDaysOf,
  RECTIFY_SOURCE_LABEL,
  type RectifyDraft,
  type RectifyView,
} from '../types/rectify';
import type { Rescue } from '../types/rescue';
import { resolveRescueRectify } from '../utils/rescueReview';
import { nowDateTime } from '../utils/duration';
import { uuid } from '../utils/export';
import { emitChange, onChange } from '../utils/events';

export interface RegisterRescueResult {
  /** 复用已有待整改单 / 新建 */
  reused: boolean;
  /** 是否沿用保养异常 / 建议项 */
  fromMaintenance: boolean;
  rectifyId: string;
  item: string;
  /** 实际生效限期（复用时为原单限期） */
  dueDate: string;
  reasonText: string;
}

export const useRectifyStore = defineStore('rectify', () => {
  const rectifies = ref<RectifyRow[]>([]);
  const elevators = ref<ElevatorRow[]>([]);
  const plans = ref<PlanRow[]>([]);
  const rescues = ref<RescueRow[]>([]);
  const loading = ref(false);
  const error = ref('');
  const initialized = ref(false);
  let subscribed = false;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [rectifyRows, elevatorRows, planRows, rescueRows] = await Promise.all([
        listRectifies(),
        listElevators(),
        listPlans(),
        listRescues(),
      ]);
      rectifies.value = rectifyRows;
      elevators.value = elevatorRows;
      plans.value = planRows;
      rescues.value = rescueRows;
      error.value = '';
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '整改单读取失败';
    } finally {
      loading.value = false;
    }
  }

  async function bootstrap(): Promise<void> {
    if (!initialized.value) initialized.value = true;
    if (!subscribed) {
      subscribed = true;
      onChange(() => {
        void load();
      });
    }
    await load();
  }

  async function createRectify(draft: RectifyDraft): Promise<RectifyRow> {
    const row: RectifyRow = {
      id: uuid(),
      elevatorId: draft.elevatorId,
      item: draft.item.trim(),
      dueDate: draft.dueDate,
      state: 'pending',
      source: draft.source ?? 'manual',
      rescueId: draft.rescueId ?? null,
      planId: draft.planId ?? null,
      reviewer: draft.reviewer.trim(),
      reviewedAt: null,
      createdAt: nowDateTime(),
      revision: ROW_REVISION,
    };
    await putRectify(row);
    emitChange();
    return row;
  }

  async function updateRectify(id: string, draft: RectifyDraft): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({
      ...existing,
      elevatorId: draft.elevatorId,
      item: draft.item.trim(),
      dueDate: draft.dueDate,
      // 来源与关联为系统登记口径，手动编辑不覆盖
      source: draft.source ?? existing.source,
      rescueId: draft.rescueId ?? existing.rescueId,
      planId: draft.planId ?? existing.planId,
      reviewer: draft.reviewer.trim(),
    });
    emitChange();
  }

  /** 复核通过：关闭整改单并回写复核人与时间 */
  async function review(id: string, reviewer: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({
      ...existing,
      state: 'reviewed',
      reviewer: reviewer.trim() || existing.reviewer,
      reviewedAt: nowDateTime(),
    });
    emitChange();
  }

  /** 撤销复核：退回待整改 */
  async function revokeReview(id: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({ ...existing, state: 'pending', reviewedAt: null });
    emitChange();
  }

  async function deleteRectify(id: string): Promise<void> {
    await removeRectify(id);
    emitChange();
  }

  /**
   * 由保养异常项一键转整改单（调用方传入电梯与计划上下文，避免反向依赖）。
   * 同电梯同项目已存在待整改单时跳过，返回实际新建数量。
   */
  async function promoteAbnormalItems(
    elevatorId: string,
    planId: string,
    dueDate: string,
    reviewer: string,
  ): Promise<number> {
    const items: CheckItemRow[] = await listCheckItems();
    const targets = items.filter(
      (item) => item.planId === planId && (item.result === 'abnormal' || item.result === 'advice'),
    );
    let created = 0;
    for (const item of targets) {
      const exists = rectifies.value.some(
        (row) => row.elevatorId === elevatorId && row.item === item.itemName && row.state === 'pending',
      );
      if (exists) continue;
      await createRectify({
        elevatorId,
        item: item.itemName,
        dueDate,
        reviewer,
        source: 'maintenance',
        planId,
      });
      created += 1;
    }
    return created;
  }

  /**
   * 困人复盘登记整改（救援页调用）：
   * 沿同一电梯最近一次已签署计划查找对应异常 / 建议项——
   * 命中则优先沿用该保养项并复用未复核的同项整改单（保留原限期，不新建）；
   * 未命中才按救援原因登记，加紧 3 日 / 常规 7 日。
   * 回写 rescue.rectifyId 与整改单的 rescueId / planId 关联。
   */
  async function registerFromRescue(rescue: Rescue): Promise<RegisterRescueResult> {
    const [freshPlans, freshItems, freshRectifies] = await Promise.all([
      listPlans(),
      listCheckItems(),
      listRectifies(),
    ]);

    // 已挂接整改单（含已复核）：直接返回，绝不重复开单
    const linked = rescue.rectifyId
      ? freshRectifies.find((item) => item.id === rescue.rectifyId)
      : undefined;
    if (linked) {
      return {
        reused: true,
        fromMaintenance: linked.planId !== null,
        rectifyId: linked.id,
        item: linked.item,
        dueDate: linked.dueDate,
        reasonText: `该救援已关联整改单「${linked.item}」（限期 ${linked.dueDate}），不重复登记`,
      };
    }

    const resolution = resolveRescueRectify({
      rescue,
      plans: freshPlans,
      checkItems: freshItems,
      rectifies: freshRectifies,
    });

    let rectifyId: string;
    let reused = false;
    let dueDate = resolution.dueDate;

    if (resolution.mode === 'reuseMaintenance' && resolution.existingRectify) {
      // 复用待整改单：仅回填关联，限期 / 来源均不改动，避免同一故障两张单
      const existing = resolution.existingRectify;
      await putRectify({
        ...existing,
        rescueId: rescue.id,
        planId: existing.planId ?? resolution.plan?.id ?? null,
      });
      rectifyId = existing.id;
      reused = true;
      dueDate = existing.dueDate;
    } else {
      const created = await createRectify({
        elevatorId: rescue.elevatorId,
        item: resolution.item,
        dueDate: resolution.dueDate,
        reviewer: '王敏',
        source: 'rescue',
        rescueId: rescue.id,
        planId: resolution.plan?.id ?? null,
      });
      rectifyId = created.id;
    }

    // 回写困人事件的整改单关联
    const rescueRow = rescues.value.find((item) => item.id === rescue.id);
    if (rescueRow) {
      await putRescue({ ...rescueRow, rectifyId });
    }
    emitChange();

    return {
      reused,
      fromMaintenance: resolution.mode !== 'createCause',
      rectifyId,
      item: resolution.item,
      dueDate,
      reasonText: resolution.reasonText,
    };
  }

  /** 整改单视图：附电梯上下文、来源上下文与超期天数 */
  const rectifyViews = computed<RectifyView[]>(() =>
    rectifies.value.map((row) => {
      const elevator = elevators.value.find((item) => item.id === row.elevatorId);
      const days = overdueDaysOf(row.dueDate, row.state);
      const linkedRescue = row.rescueId
        ? rescues.value.find((item) => item.id === row.rescueId)
        : undefined;
      const linkedPlan = row.planId ? plans.value.find((item) => item.id === row.planId) : undefined;
      return {
        ...row,
        elevatorName: elevator ? `${elevator.regCode}（${elevator.owner}）` : '已删除电梯',
        owner: elevator?.owner ?? '-',
        sourceLabel: RECTIFY_SOURCE_LABEL[row.source ?? 'manual'],
        rescueAlarmAt: linkedRescue?.alarmAt ?? null,
        planDate: linkedPlan?.planDate ?? null,
        overdue: days > 0,
        overdueDays: days,
      };
    }),
  );

  const pendingViews = computed(() => rectifyViews.value.filter((item) => item.state === 'pending'));
  const overdueViews = computed(() =>
    rectifyViews.value
      .filter((item) => item.overdue)
      .sort((a, b) => b.overdueDays - a.overdueDays),
  );
  const reviewedViews = computed(() => rectifyViews.value.filter((item) => item.state === 'reviewed'));

  const reviewRate = computed(() => {
    if (rectifyViews.value.length === 0) return 0;
    return Number(((reviewedViews.value.length / rectifyViews.value.length) * 100).toFixed(1));
  });

  /** 按使用单位统计待整改量 */
  const byOwner = computed(() => {
    const buckets = new Map<string, { owner: string; pending: number; overdue: number; total: number }>();
    for (const row of rectifyViews.value) {
      const bucket = buckets.get(row.owner) ?? { owner: row.owner, pending: 0, overdue: 0, total: 0 };
      bucket.total += 1;
      if (row.state === 'pending') bucket.pending += 1;
      if (row.overdue) bucket.overdue += 1;
      buckets.set(row.owner, bucket);
    }
    return [...buckets.values()].sort((a, b) => b.pending - a.pending);
  });

  return {
    rectifies,
    elevators,
    plans,
    rescues,
    loading,
    error,
    initialized,
    load,
    bootstrap,
    createRectify,
    updateRectify,
    review,
    revokeReview,
    deleteRectify,
    promoteAbnormalItems,
    registerFromRescue,
    rectifyViews,
    pendingViews,
    overdueViews,
    reviewedViews,
    reviewRate,
    byOwner,
  };
});
