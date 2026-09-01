// ─────────────────────────────────────────────────────────────
// 두 좌표 사이의 대권 거리(great-circle distance)
//
// Impossible Travel(M-4) 은 "직전 접속지 → 현재 접속지" 이동이 물리적으로 가능한
// 속도인지를 본다. 지구는 구에 가까우므로 평면 거리로 계산하면 고위도·장거리에서
// 오차가 커진다. 하버사인 공식으로 구면 거리를 구한다.
// ─────────────────────────────────────────────────────────────

// 지구 평균 반지름(km). WGS84 평균 반경.
const EARTH_RADIUS_KM = 6371.0088

export interface GeoPoint {
  lat: number
  lon: number
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

/** 두 좌표 사이 거리(km). 좌표가 유효하지 않으면 null. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number | null {
  if (!isValidPoint(a) || !isValidPoint(b)) return null

  const dLat = toRadians(b.lat - a.lat)
  const dLon = toRadians(b.lon - a.lon)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2

  // 부동소수 오차로 h 가 1 을 아주 살짝 넘으면 asin 이 NaN 이 된다.
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)))
  return EARTH_RADIUS_KM * c
}

export function isValidPoint(p: GeoPoint | null | undefined): p is GeoPoint {
  if (!p) return false
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false
  if (p.lat < -90 || p.lat > 90) return false
  if (p.lon < -180 || p.lon > 180) return false
  // 정확히 (0,0)은 GeoIP 조회 실패의 기본값일 가능성이 높다. 실제 위치로 채택하면
  // 서울과 약 9,900km 로 잡혀 오탐이 대량 발생하므로 무효 처리한다.
  if (p.lat === 0 && p.lon === 0) return false
  return true
}

/** 거리(km)와 경과 시간(ms)으로 이동 속도(km/h). 경과가 0 이하면 null. */
export function travelSpeedKmh(distanceKm: number, elapsedMs: number): number | null {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return null
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null
  return distanceKm / (elapsedMs / 3_600_000)
}
