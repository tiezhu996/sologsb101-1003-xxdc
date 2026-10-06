<script setup lang="ts">
/**
 * /rescues 困人救援时间线
 * 录入报警 / 到场 / 救出时间，自动算响应时长并按电梯复盘；
 * 复盘后按规则登记整改：沿用最近已签署保养的对应项并复用待整改单，否则按救援原因登记；
 * 消费 Rescue、Elevator、Rectify 与 <FilterBar>、<StatBadge>。
 */
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDatePicker,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NForm,
  NFormItem,
  NGrid,
  NGi,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpace,
  NTag,
  NText,
  NTimeline,
  NTimelineItem,
  useMessage,
  type DataTableColumns,
  type FormInst,
} from 'naive-ui';
import { useRescueStore } from '../stores/rescueStore';
import { useElevatorStore } from '../stores/elevatorStore';
import { useRectifyStore } from '../stores/rectifyStore';
import { ROUTES } from '../router';
import { RESCUE_CAUSES, type RescueDraft, type RescueView } from '../types/rescue';
import { RECTIFY_SOURCE_LABEL } from '../types/rectify';
import { ARRIVE_LIMIT_MINUTES, RESCUE_LIMIT_MINUTES } from '../utils/rescueReview';
import { formatMinutes } from '../utils/duration';
import StatBadge from '../components/common/StatBadge.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import FilterBar from '../components/common/FilterBar.vue';

const message = useMessage();
const router = useRouter();
const rescueStore = useRescueStore();
const elevatorStore = useElevatorStore();
const rectifyStore = useRectifyStore();

const keyword = ref('');
const elevatorFilters = ref<string[]>([]);
const activeFilter = ref<'all' | 'late'>('all');
const registering = ref(false);

const formRef = ref<FormInst | null>(null);
const modalOpen = ref(false);
const editingId = ref('');

interface RescueFormModel {
  elevatorId: string;
  alarmTs: number;
  arriveTs: number;
  rescueTs: number;
  cause: string;
  trappedCount: number;
  responder: string;
}

const formModel = ref<RescueFormModel>({
  elevatorId: '',
  alarmTs: Date.now(),
  arriveTs: Date.now() + 20 * 60000,
  rescueTs: Date.now() + 45 * 60000,
  cause: RESCUE_CAUSES[0],
  trappedCount: 1,
  responder: '刘建国',
});

onMounted(async () => {
  await rescueStore.bootstrap();
  await elevatorStore.bootstrap();
  await rectifyStore.bootstrap();
});

function onFilterChange(values: Record<string, string[]>): void {
  elevatorFilters.value = values.elevator ?? [];
}

const filtered = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return rescueStore.rescueViews.filter((row) => {
    if (elevatorFilters.value.length > 0 && !elevatorFilters.value.includes(row.elevatorId)) return false;
    if (activeFilter.value === 'late' && row.arriveInTime) return false;
    if (lower && !`${row.elevatorName} ${row.cause} ${row.responder}`.toLowerCase().includes(lower)) return false;
    return true;
  });
});

const overview = computed(() => ({
  total: rescueStore.rescueViews.length,
  trapped: rescueStore.trappedTotal,
  avgRescue: rescueStore.averageRescueMinutes,
  avgArrive: rescueStore.averageArriveMinutes,
  onTimeRate: rescueStore.onTimeRate,
  late: rescueStore.lateArriveViews.length,
}));

/** 到场时长中位数（更能反映典型表现） */
const medianRescue = computed(() => {
  const values = rescueStore.rescueViews.map((item) => item.rescueMinutes).sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? Math.round((values[middle - 1] + values[middle]) / 2) : values[middle];
});

/** 当前复盘事件的整改登记预演（不落库，给管理员确认来源与限期） */
const activePreview = computed(() =>
  rescueStore.activeRescue ? rescueStore.previewRectify(rescueStore.activeRescue.id) : null,
);

/** 复盘登记 / 复用整改单 */
async function registerRectify(): Promise<void> {
  const active = rescueStore.activeRescue;
  if (!active || registering.value) return;
  registering.value = true;
  try {
    const result = await rectifyStore.registerFromRescue(active);
    if (result.reused) {
      message.success(`已复用待整改单「${result.item}」，保留原限期 ${result.dueDate}，未重复开单`);
    } else if (result.fromMaintenance) {
      message.success(`已沿用保养项「${result.item}」登记整改，限期至 ${result.dueDate}`);
    } else {
      message.success(`已按救援原因「${result.item}」登记整改，限期至 ${result.dueDate}`);
    }
  } finally {
    registering.value = false;
  }
}

function gotoRectifies(): void {
  void router.push(ROUTES.rectifies);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toDateTime(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function openCreate(): void {
  const targets = rescueStore.elevators;
  const elevatorId = rescueStore.elevators[0]?.id ?? '';
  editingId.value = '';
  formModel.value = {
    elevatorId,
    alarmTs: Date.now() - 300000,
    arriveTs: Date.now() + 15 * 60000,
    rescueTs: Date.now() + 40 * 60000,
    cause: RESCUE_CAUSES[0],
    trappedCount: 1,
    responder: '刘建国',
  };
  void targets;
  modalOpen.value = true;
}

function openEdit(row: RescueView): void {
  editingId.value = row.id;
  formModel.value = {
    elevatorId: row.elevatorId,
    alarmTs: new Date(row.alarmAt.replace(' ', 'T')).getTime(),
    arriveTs: new Date(row.arriveAt.replace(' ', 'T')).getTime(),
    rescueTs: new Date(row.rescueAt.replace(' ', 'T')).getTime(),
    cause: row.cause,
    trappedCount: row.trappedCount,
    responder: row.responder,
  };
  modalOpen.value = true;
}

/** 表单内的实时时长预览 */
const previewArrive = computed(() =>
  Math.max(0, Math.round((formModel.value.arriveTs - formModel.value.alarmTs) / 60000)),
);
const previewRescue = computed(() =>
  Math.max(0, Math.round((formModel.value.rescueTs - formModel.value.alarmTs) / 60000)),
);

async function submit(): Promise<void> {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  if (formModel.value.arriveTs < formModel.value.alarmTs) {
    message.error('到场时间不能早于报警时间');
    return;
  }
  if (formModel.value.rescueTs < formModel.value.arriveTs) {
    message.error('救出时间不能早于到场时间');
    return;
  }
  const draft: RescueDraft = {
    elevatorId: formModel.value.elevatorId,
    alarmAt: toDateTime(formModel.value.alarmTs),
    arriveAt: toDateTime(formModel.value.arriveTs),
    rescueAt: toDateTime(formModel.value.rescueTs),
    cause: formModel.value.cause,
    trappedCount: formModel.value.trappedCount,
    responder: formModel.value.responder,
  };
  if (editingId.value) {
    await rescueStore.updateRescue(editingId.value, draft);
    message.success('困人事件已更新');
  } else {
    await rescueStore.createRescue(draft);
    message.success(
      previewArrive.value <= ARRIVE_LIMIT_MINUTES
        ? '困人事件已录入，到场及时'
        : `困人事件已录入，到场超时 ${previewArrive.value - ARRIVE_LIMIT_MINUTES} 分钟，建议复盘`,
    );
  }
  modalOpen.value = false;
}

const columns = computed<DataTableColumns<RescueView>>(() => [
  { title: '报警时间', key: 'alarmAt', width: 150 },
  { title: '电梯', key: 'elevatorName', minWidth: 200, ellipsis: { tooltip: true } },
  {
    title: '到场时长',
    key: 'arriveMinutes',
    width: 150,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.arriveInTime ? 'success' : 'error', round: true },
        { default: () => `${formatMinutes(row.arriveMinutes)}${row.arriveInTime ? '' : ' 超时'}` },
      ),
  },
  {
    title: '救援时长',
    key: 'rescueMinutes',
    width: 130,
    render: (row) => formatMinutes(row.rescueMinutes),
  },
  { title: '被困人数', key: 'trappedCount', width: 100 },
  { title: '原因', key: 'cause', minWidth: 140 },
  { title: '救援人', key: 'responder', width: 100 },
  {
    title: '整改处理',
    key: 'linkedRectify',
    width: 180,
    render: (row) => {
      const linked = row.linkedRectify;
      if (!linked) {
        return h(NTag, { size: 'small', round: true, bordered: false }, { default: () => '复盘后登记' });
      }
      return h(
        NSpace,
        { size: 4, vertical: true },
        {
          default: () => [
            h(
              NTag,
              {
                size: 'small',
                round: true,
                type: linked.state === 'reviewed' ? 'success' : linked.overdue ? 'error' : 'warning',
              },
              {
                default: () =>
                  `${RECTIFY_SOURCE_LABEL[linked.source]} · ${linked.state === 'reviewed' ? '已复核' : '待整改'}`,
              },
            ),
            h(NText, { depth: 3, style: 'font-size:12px' }, { default: () => `限期 ${linked.dueDate}` }),
          ],
        },
      );
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 170,
    fixed: 'right',
    render: (row) =>
      h(NSpace, { size: 2 }, {
        default: () => [
          h(NButton, { size: 'tiny', text: true, type: 'primary', onClick: () => rescueStore.setActive(row.id) }, { default: () => '复盘' }),
          h(NButton, { size: 'tiny', text: true, onClick: () => openEdit(row) }, { default: () => '编辑' }),
          h(
            NButton,
            {
              size: 'tiny',
              text: true,
              type: 'error',
              onClick: async () => {
                await rescueStore.deleteRescue(row.id);
                message.success('困人事件已删除');
              },
            },
            { default: () => '删除' },
          ),
        ],
      }),
  },
]);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">困人救援时间线</h2>
        <div class="page-sub">
          录入报警 / 到场 / 救出时间，自动计算响应时长并按 {{ ARRIVE_LIMIT_MINUTES }} 分钟到场要求判定；右侧按电梯复盘。
        </div>
      </div>
      <n-space>
        <n-button @click="openCreate">录入困人事件</n-button>
      </n-space>
    </div>

    <div class="stat-grid">
      <stat-badge title="困人事件" :value="overview.total" suffix="起" color="#2080f0" />
      <stat-badge
        title="平均救援时长"
        :value="overview.avgRescue"
        suffix="分钟"
        color="#18a058"
        :hint="`中位数 ${formatMinutes(medianRescue)}`"
      />
      <stat-badge
        title="平均到场时长"
        :value="overview.avgArrive"
        suffix="分钟"
        :color="overview.avgArrive <= ARRIVE_LIMIT_MINUTES ? '#18a058' : '#d03050'"
        :percent="overview.onTimeRate"
        hint="进度条为按时到场比例"
      />
      <stat-badge
        title="累计被困"
        :value="overview.trapped"
        suffix="人"
        :color="overview.trapped > 0 ? '#f0a020' : '#18a058'"
        :hint="`到场超时 ${overview.late} 起`"
      />
    </div>

    <filter-bar
      keyword-placeholder="按电梯 / 原因 / 救援人搜索"
      :selects="[
        {
          key: 'elevator',
          label: '电梯',
          options: elevatorStore.elevators.map((item) => ({ label: `${item.regCode}（${item.owner}）`, value: item.id })),
          width: 230,
        },
      ]"
      :result-count="filtered.length"
      count-unit="起事件"
      @update:keyword="(value: string) => (keyword = value)"
      @change="onFilterChange"
    >
      <n-button size="small" :type="activeFilter === 'late' ? 'error' : 'default'" @click="activeFilter = activeFilter === 'late' ? 'all' : 'late'">
        仅看到场超时（{{ overview.late }}）
      </n-button>
    </filter-bar>

    <n-grid :cols="3" :x-gap="14" class="section-gap">
      <n-gi :span="2">
        <n-card size="small" title="事件清单">
          <empty-panel
            v-if="filtered.length === 0"
            title="没有匹配的困人事件"
            description="可录入一起困人事件，或调整筛选条件。"
            create-label="录入困人事件"
            @create="openCreate"
          />
          <n-data-table
            v-else
            :columns="columns"
            :data="filtered"
            :bordered="false"
            size="small"
            :scroll-x="1310"
            :pagination="{ pageSize: 8 }"
            :row-class-name="(row: RescueView) => (!row.arriveInTime ? 'row-marked' : '')"
          />
        </n-card>
      </n-gi>

      <n-gi>
        <n-card size="small" title="按电梯复盘" style="margin-bottom: 14px">
          <n-space v-if="rescueStore.byElevator.length === 0" vertical>
            <n-text depth="3">暂无困人事件</n-text>
          </n-space>
          <n-space v-else vertical :size="10">
            <div v-for="group in rescueStore.byElevator" :key="group.elevatorId">
              <n-space justify="space-between" align="center">
                <n-text strong style="font-size: 13px">{{ group.elevatorName }}</n-text>
                <n-tag size="small" round>{{ group.count }} 起</n-tag>
              </n-space>
              <n-text depth="3" style="font-size: 12px">
                平均救援 {{ formatMinutes(group.averageRescueMinutes) }} · 累计被困 {{ group.trappedTotal }} 人
              </n-text>
            </div>
          </n-space>
        </n-card>

        <n-card size="small" :title="rescueStore.activeRescue ? `时间线回放 · ${rescueStore.activeRescue.elevatorName}` : '时间线回放'">
          <template v-if="rescueStore.activeRescue">
            <n-descriptions :column="1" size="small" label-placement="left" bordered>
              <n-descriptions-item label="原因">{{ rescueStore.activeRescue.cause }}</n-descriptions-item>
              <n-descriptions-item label="被困人数">{{ rescueStore.activeRescue.trappedCount }} 人</n-descriptions-item>
              <n-descriptions-item label="救援人">{{ rescueStore.activeRescue.responder }}</n-descriptions-item>
            </n-descriptions>
            <n-timeline style="margin-top: 12px">
              <n-timeline-item
                v-for="node in rescueStore.activeRescue.timeline"
                :key="node.label"
                :type="node.tone === 'alarm' ? 'error' : node.tone === 'arrive' ? 'warning' : 'success'"
                :title="`${node.label} · ${node.at}`"
                :content="`${node.minutesFromAlarm === 0 ? '报警起点' : `距报警 ${formatMinutes(node.minutesFromAlarm)}`} · ${node.detail}`"
              />
            </n-timeline>

            <!-- 复盘整改：沿用最近已签署保养对应项并复用待整改单，否则按救援原因登记 -->
            <n-divider style="margin: 12px 0" />
            <n-space vertical :size="8">
              <n-text strong style="font-size: 13px">整改处理</n-text>
              <template v-if="rescueStore.activeRescue.linkedRectify">
                <n-space align="center" :size="8">
                  <n-tag
                    size="small"
                    round
                    :type="
                      rescueStore.activeRescue.linkedRectify.state === 'reviewed'
                        ? 'success'
                        : rescueStore.activeRescue.linkedRectify.overdue
                          ? 'error'
                          : 'warning'
                    "
                  >
                    {{ RECTIFY_SOURCE_LABEL[rescueStore.activeRescue.linkedRectify.source] }} ·
                    {{ rescueStore.activeRescue.linkedRectify.state === 'reviewed' ? '已复核' : '待整改' }}
                  </n-tag>
                  <n-tag
                    v-if="rescueStore.activeRescue.linkedRectify.overdue && rescueStore.activeRescue.linkedRectify.state === 'pending'"
                    size="small"
                    type="error"
                    round
                  >
                    超期 {{ rescueStore.activeRescue.linkedRectify.overdueDays }} 天
                  </n-tag>
                </n-space>
                <n-text depth="3" style="font-size: 12px">
                  整改项：{{ rescueStore.activeRescue.linkedRectify.item }} · 限期
                  {{ rescueStore.activeRescue.linkedRectify.dueDate }}
                </n-text>
                <n-button size="small" quaternary type="primary" @click="gotoRectifies">前往整改页跟踪</n-button>
              </template>
              <template v-else-if="activePreview">
                <n-alert
                  :type="activePreview.urgent ? 'error' : 'info'"
                  size="small"
                  :show-icon="false"
                  style="padding: 8px 10px"
                >
                  <n-text style="font-size: 12px">{{ activePreview.reasonText }}</n-text>
                </n-alert>
                <n-text depth="3" style="font-size: 12px">
                  到场限 {{ ARRIVE_LIMIT_MINUTES }} 分钟、救出限 {{ RESCUE_LIMIT_MINUTES }} 分钟；
                  本起到场 {{ formatMinutes(rescueStore.activeRescue.arriveMinutes) }}、救出
                  {{ formatMinutes(rescueStore.activeRescue.rescueMinutes) }}，建议限期
                  {{ activePreview.dueDate }}
                </n-text>
                <n-button size="small" type="primary" :loading="registering" @click="registerRectify">
                  {{ activePreview.mode === 'reuseMaintenance' ? '复用待整改单' : '登记整改单' }}
                </n-button>
              </template>
            </n-space>
          </template>
          <n-text v-else depth="3">点击左侧事件行的「复盘」查看完整时间线</n-text>
        </n-card>
      </n-gi>
    </n-grid>

    <!-- 录入 / 编辑 -->
    <n-modal
      v-model:show="modalOpen"
      preset="card"
      :title="editingId ? '编辑困人事件' : '录入困人事件'"
      style="max-width: 560px"
    >
      <n-form ref="formRef" :model="formModel" label-placement="top">
        <n-form-item
          label="电梯"
          path="elevatorId"
          :rule="{ required: true, message: '请选择电梯', trigger: 'change' }"
        >
          <n-select
            v-model:value="formModel.elevatorId"
            filterable
            :options="elevatorStore.elevators.map((item) => ({ label: `${item.regCode}（${item.owner}）`, value: item.id }))"
          />
        </n-form-item>
        <n-grid :cols="3" :x-gap="10">
          <n-gi>
            <n-form-item label="报警时间" path="alarmTs">
              <n-date-picker v-model:value="formModel.alarmTs" type="datetime" style="width: 100%" />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="到场时间" path="arriveTs">
              <n-date-picker v-model:value="formModel.arriveTs" type="datetime" style="width: 100%" />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="救出时间" path="rescueTs">
              <n-date-picker v-model:value="formModel.rescueTs" type="datetime" style="width: 100%" />
            </n-form-item>
          </n-gi>
        </n-grid>
        <n-grid :cols="2" :x-gap="12">
          <n-gi>
            <n-form-item label="原因" path="cause">
              <n-select
                v-model:value="formModel.cause"
                filterable
                tag
                :options="RESCUE_CAUSES.map((item) => ({ label: item, value: item }))"
              />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="被困人数" path="trappedCount">
              <n-input-number v-model:value="formModel.trappedCount" :min="1" :max="30" style="width: 100%" />
            </n-form-item>
          </n-gi>
        </n-grid>
        <n-form-item label="救援人" path="responder" :rule="{ required: true, message: '请输入救援人', trigger: 'blur' }">
          <n-input v-model:value="formModel.responder" />
        </n-form-item>
        <n-space>
          <n-tag :type="previewArrive <= ARRIVE_LIMIT_MINUTES ? 'success' : 'error'" round>
            到场 {{ formatMinutes(previewArrive) }}
          </n-tag>
          <n-tag type="info" round>救出 {{ formatMinutes(previewRescue) }}</n-tag>
          <n-tag round>限时 {{ ARRIVE_LIMIT_MINUTES }} 分钟</n-tag>
        </n-space>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="modalOpen = false">取消</n-button>
          <n-button type="primary" @click="submit">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>
