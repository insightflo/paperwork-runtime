import type { MissionListItem } from "../api/missions";

/**
 * [목적] 미션 목록 정렬 순서 계약(page: ui/src/pages/Missions.tsx).
 * 서버 정렬 파라미터(MissionListFilters.sortBy/sortOrder)와 동일한 필드·방향을
 * 클라이언트에서도 결정적으로 재현한다. 레이더 필터 중일 때 fleetMissions(서버 미정렬
 * 기본 순서)를 받아도 URL sortBy/sortOrder 그대로 정렬된다.
 */
export type MissionSortField = "createdAt" | "updatedAt" | "title" | "status";
export type MissionSortOrder = "asc" | "desc";

const SORT_FIELDS: readonly MissionSortField[] = ["updatedAt", "createdAt", "title", "status"];
const DEFAULT_FIELD: MissionSortField = "updatedAt";
const DEFAULT_ORDER: MissionSortOrder = "desc";

function normalizeField(value: unknown): MissionSortField {
  return SORT_FIELDS.includes(value as MissionSortField) ? (value as MissionSortField) : DEFAULT_FIELD;
}

function normalizeOrder(value: unknown): MissionSortOrder {
  return value === "asc" || value === "desc" ? value : DEFAULT_ORDER;
}

/** [주의] URL 검색파라미터는 캐스트 없이 신뢰할 수 없다. 알 수 없는 값은 기본 정렬로 떨어뜨린다. */
export function normalizeMissionSort(sortBy: unknown, sortOrder: unknown): {
  sortBy: MissionSortField;
  sortOrder: MissionSortOrder;
} {
  return { sortBy: normalizeField(sortBy), sortOrder: normalizeOrder(sortOrder) };
}

/** [주의] API 직렬화에 따라 Date | ISO 문자열 모두 올 수 있다. 무효 날짜는 epoch로 떨어뜨려 비교를 결정적으로 유지. */
function toTime(value: Date | string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** [주의] localeCompare는 로캘별 결과가 달라진다. 코드 유닛 순서 비교로 환경 무관 결정성을 보장. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 기준 필드 1차 비교(asc 기준). desc는 호출부에서 방향 계수로 뒤집는다. */
function compareByField(a: MissionListItem, b: MissionListItem, sortBy: MissionSortField): number {
  switch (sortBy) {
    case "createdAt":
      return toTime(a.createdAt) - toTime(b.createdAt);
    case "updatedAt":
      return toTime(a.updatedAt) - toTime(b.updatedAt);
    case "title":
      return compareStrings(a.title, b.title);
    case "status":
      return compareStrings(a.status, b.status);
  }
}

/**
 * [입출력] (미션 배열, 정렬 필드, 방향) → 정렬된 새 배열. 입력 배열은 변형하지 않는다(순수).
 * [수정 주의] 1차 키가 같으면 updatedAt 최신순(desc), 그래도 같으면 id 오름차순으로 결정적 타이브레이크.
 * 이 타이브레이크는 1차 방향(asc/desc)과 무관하게 항상 같으므로 어떤 정렬에서도 순서가 뒤집히지 않는다.
 */
export function sortMissions(
  missions: readonly MissionListItem[],
  sortBy: unknown,
  sortOrder: unknown,
): MissionListItem[] {
  const { sortBy: field, sortOrder: order } = normalizeMissionSort(sortBy, sortOrder);
  const direction = order === "desc" ? -1 : 1;
  return [...missions].sort((a, b) => {
    const primary = compareByField(a, b, field) * direction;
    if (primary !== 0) return primary;
    const byUpdatedDesc = toTime(b.updatedAt) - toTime(a.updatedAt);
    if (byUpdatedDesc !== 0) return byUpdatedDesc;
    return compareStrings(a.id, b.id);
  });
}
