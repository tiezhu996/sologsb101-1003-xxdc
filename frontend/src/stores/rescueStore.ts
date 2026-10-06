/**
 * 困人救援状态（Pinia）
 * 维护困人事件时间线与到场 / 救出时长派生值，并做响应时限判定。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  ROW_REVISION,
  listCheckItems,
  listElevators,
  listPlans,
  listRectifies,
  listRescues,
  putRescue,
  removeRescue,
  type CheckItemRow,
  type ElevatorRow,
  type PlanRow,
  type RectifyRow,
  type RescueRow,
} from '../utils/db';
import {
  type RescueDraft,
  type RescueRectifyBrief,
  type RescueTimelineNode,
  type RescueView,
} from '../types/rescue';
import { arriveMinutes, nowDateTime, rescueMinutes } from '../utils/duration';
import {
  ARRIVE_LIMIT_MINUTES,
  findRelatedCheckItem,
  isUrgentRescue,
  NORMAL_DUE_DAYS,
  resolveRescueRectify,
  suggestedDueDate,
  suggestedDueDays,
  URGENT_DUE_DAYS,
} from '../utils/rescueReview';
import { overdueDaysOf } from '../types/rectify';
import { uuid } from '../utils/export';
import { emitChange, onChange } from '../utils/events';

/** 复盘登记前的预演结果（救援页展示将沿用哪个保养项 / 是否复用待整改单） */
export interface RescueRectifyPreview {
  item: string;
  mode: 'reuseMaintenance' | 'createMaintenance' | 'createCause';
  planDate: string | null;
  urgent: boolean;
  dueDays: number;
  dueDate: string;
  reasonText: string;
}

export const useRescueStore = defineStore('rescue', () => {
  const rescues = ref<RescueRow[]>([]);
  const elevators = ref<ElevatorRow[]>([]);
  const rectifies = ref<RectifyRow[]>([]);
  const plans = ref<PlanRow[]>([]);
  const checkItems = ref<CheckItemRow[]>([]);
  /** 复盘选中的事件 */
  const activeRescueId = ref<string>('');
  const loading = ref(false);
  const error = ref('');
  const initialized = ref(false);
  let subscribed = false;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [rescueRows, elevatorRows, rectifyRows, planRows, itemRows] = await Promise.all([
        listRescues(),
        listElevators(),
        listRectifies(),
        listPlans(),
        listCheckItems(),
      ]);
      rescues.value = rescueRows;
      elevators.value = elevatorRows;
      rectifies.value = rectifyRows;
      plans.value = planRows;
      checkItems.value = itemRows;
      error.value = '';
      if (!activeRescueId.value || !rescueRows.some((item) => item.id === activeRescueId.value)) {
        activeRescueId.value = rescueRows[0]?.id ?? '';
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '困人事件读取失败';
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

  async function createRescue(draft: RescueDraft): Promise<RescueRow> {
    const row: RescueRow = {
      id: uuid(),
      elevatorId: draft.elevatorId,
      alarmAt: draft.alarmAt,
      arriveAt: draft.arriveAt,
      rescueAt: draft.rescueAt,
      cause: draft.cause.trim(),
      trappedCount: draft.trappedCount,
      responder: draft.responder.trim(),
      rectifyId: null,
      createdAt: nowDateTime(),
      revision: ROW_REVISION,
    };
    await putRescue(row);
    activeRescueId.value = row.id;
    emitChange();
    return row;
  }

  async function updateRescue(id: string, draft: RescueDraft): Promise<void> {
    const existing = rescues.value.find((item) => item.id === id);
    if (!existing) return;
    await putRescue({
      ...existing,
      elevatorId: draft.elevatorId,
      alarmAt: draft.alarmAt,
      arriveAt: draft.arriveAt,
      rescueAt: draft.rescueAt,
      cause: draft.cause.trim(),
      trappedCount: draft.trappedCount,
      responder: draft.responder.trim(),
      // 编辑事件不解除已登记的整改关联（处理以复盘登记为准）
      rectifyId: existing.rectifyId ?? null,
    });
    emitChange();
  }

  async function deleteRescue(id: string): Promise<void> {
    await removeRescue(id);
    if (activeRescueId.value === id) activeRescueId.value = '';
    emitChange();
  }

  function setActive(id: string): void {
    activeRescueId.value = id;
  }

  /** 困人事件视图：自动算到场与救援时长、时间线回放节点、整改处理情况 */
  const rescueViews = computed<RescueView[]>(() =>
    rescues.value.map((rescue) => {
      const elevator = elevators.value.find((item) => item.id === rescue.elevatorId);
      const arrive = arriveMinutes(rescue.alarmAt, rescue.arriveAt);
      const total = rescueMinutes(rescue.alarmAt, rescue.rescueAt);
      const linked = rescue.rectifyId
        ? rectifies.value.find((item) => item.id === rescue.rectifyId)
        : undefined;
      const linkedBrief: RescueRectifyBrief | null = linked
        ? {
            id: linked.id,
            item: linked.item,
            dueDate: linked.dueDate,
            state: linked.state,
            source: linked.source ?? 'manual',
            overdue: overdueDaysOf(linked.dueDate, linked.state) > 0,
            overdueDays: overdueDaysOf(linked.dueDate, linked.state),
          }
        : null;
      const timeline: RescueTimelineNode[] = [
        {
          label: '接警',
          at: rescue.alarmAt,
          minutesFromAlarm: 0,
          tone: 'alarm',
          detail: `监控中心接到报警，被困 ${rescue.trappedCount} 人`,
        },
        {
          label: '到场',
          at: rescue.arriveAt,
          minutesFromAlarm: arrive,
          tone: 'arrive',
          detail:
            arrive <= ARRIVE_LIMIT_MINUTES
              ? `按时到场（${arrive} 分钟，限 ${ARRIVE_LIMIT_MINUTES} 分钟）`
              : `到场超时（${arrive} 分钟，限 ${ARRIVE_LIMIT_MINUTES} 分钟）`,
        },
        {
          label: '救出',
          at: rescue.rescueAt,
          minutesFromAlarm: total,
          tone: 'rescue',
          detail: `原因：${rescue.cause}，救援人：${rescue.responder}`,
        },
      ];
      return {
        ...rescue,
        elevatorName: elevator ? `${elevator.regCode}（${elevator.owner}）` : '已删除电梯',
        owner: elevator?.owner ?? '-',
        arriveMinutes: arrive,
        rescueMinutes: total,
        arriveInTime: arrive > 0 && arrive <= ARRIVE_LIMIT_MINUTES,
        urgentRectify: isUrgentRescue(rescue),
        suggestedDueDays: suggestedDueDays(rescue),
        linkedRectify: linkedBrief,
        timeline,
      };
    }),
  );

  /**
   * 复盘登记前预演：沿最近一次已签署计划找对应异常 / 建议项，
   * 给出将沿用 / 复用 / 新建的整改项与限期口径（不落库）。
   */
  function previewRectify(rescueId: string): RescueRectifyPreview | null {
    const rescue = rescues.value.find((item) => item.id === rescueId);
    if (!rescue) return null;
    const resolution = resolveRescueRectify({
      rescue,
      plans: plans.value,
      checkItems: checkItems.value,
      rectifies: rectifies.value,
    });
    return {
      item: resolution.item,
      mode: resolution.mode,
      planDate: resolution.plan?.planDate ?? null,
      urgent: resolution.urgent,
      dueDays: suggestedDueDays(rescue),
      dueDate: suggestedDueDate(rescue),
      reasonText: resolution.reasonText,
    };
  }

  /** 该电梯报警前最近一次已签署计划是否含与原因对应的异常 / 建议项（页面轻量提示用） */
  function hasRelatedCheckItem(rescue: RescueRow): boolean {
    return findRelatedCheckItem(plans.value, checkItems.value, rescue.elevatorId, rescue) !== null;
  }

  const activeRescue = computed(
    () => rescueViews.value.find((item) => item.id === activeRescueId.value) ?? null,
  );

  /** 平均救援时长（分钟） */
  const averageRescueMinutes = computed(() => {
    if (rescueViews.value.length === 0) return 0;
    const total = rescueViews.value.reduce((sum, item) => sum + item.rescueMinutes, 0);
    return Math.round(total / rescueViews.value.length);
  });

  /** 平均到场时长（分钟） */
  const averageArriveMinutes = computed(() => {
    if (rescueViews.value.length === 0) return 0;
    const total = rescueViews.value.reduce((sum, item) => sum + item.arriveMinutes, 0);
    return Math.round(total / rescueViews.value.length);
  });

  /** 到场超时事件 */
  const lateArriveViews = computed(() => rescueViews.value.filter((item) => !item.arriveInTime));

  /** 按电梯复盘分组 */
  const byElevator = computed(() => {
    const buckets = new Map<string, RescueView[]>();
    for (const view of rescueViews.value) {
      const list = buckets.get(view.elevatorId);
      if (list) list.push(view);
      else buckets.set(view.elevatorId, [view]);
    }
    return [...buckets.entries()]
      .map(([elevatorId, items]) => ({
        elevatorId,
        elevatorName: items[0]?.elevatorName ?? '-',
        count: items.length,
        averageRescueMinutes: Math.round(
          items.reduce((sum, item) => sum + item.rescueMinutes, 0) / items.length,
        ),
        trappedTotal: items.reduce((sum, item) => sum + item.trappedCount, 0),
        items: items.sort((a, b) => b.alarmAt.localeCompare(a.alarmAt)),
      }))
      .sort((a, b) => b.count - a.count);
  });

  const trappedTotal = computed(() =>
    rescueViews.value.reduce((sum, item) => sum + item.trappedCount, 0),
  );

  const onTimeRate = computed(() => {
    if (rescueViews.value.length === 0) return 0;
    const ok = rescueViews.value.filter((item) => item.arriveInTime).length;
    return Number(((ok / rescueViews.value.length) * 100).toFixed(1));
  });

  return {
    rescues,
    elevators,
    rectifies,
    plans,
    checkItems,
    activeRescueId,
    loading,
    error,
    initialized,
    load,
    bootstrap,
    createRescue,
    updateRescue,
    deleteRescue,
    setActive,
    rescueViews,
    activeRescue,
    averageRescueMinutes,
    averageArriveMinutes,
    lateArriveViews,
    byElevator,
    trappedTotal,
    onTimeRate,
    previewRectify,
    hasRelatedCheckItem,
    ARRIVE_LIMIT_MINUTES,
    URGENT_DUE_DAYS,
    NORMAL_DUE_DAYS,
  };
});
