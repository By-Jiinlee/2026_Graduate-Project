interface Location {
  country?: string
  region?: string
  city?: string
  // Impossible Travel(M-4) 이 두 접속 지점 간 이동 속도를 계산하려면 좌표가 필요하다.
  // 기존 호출부는 country/region/city 만 쓰므로 선택 필드로 추가한다(하위 호환).
  lat?: number
  lon?: number
}

export const getLocationFromIp = async (ip: string): Promise<Location> => {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon`)
    const geo = (await res.json()) as {
      status?: string
      country?: string
      regionName?: string
      city?: string
      lat?: number
      lon?: number
    }

    // 사설·예약 IP 는 status:'fail' 로 응답한다. 이때 좌표 필드가 없거나 0 으로 오는데,
    // 0,0(기니만 앞바다)을 실제 위치로 오인하면 서울과의 거리가 ~9,900km 로 잡혀
    // Impossible Travel 오탐이 대량 발생한다. 실패 응답은 좌표를 버린다.
    if (geo.status === 'fail') return {}

    const lat = typeof geo.lat === 'number' && Number.isFinite(geo.lat) ? geo.lat : undefined
    const lon = typeof geo.lon === 'number' && Number.isFinite(geo.lon) ? geo.lon : undefined

    return {
      country: geo.country,
      region: geo.regionName,
      city: geo.city,
      // 정확히 (0,0)은 조회 실패의 기본값일 가능성이 높아 좌표로 채택하지 않는다.
      ...(lat !== undefined && lon !== undefined && !(lat === 0 && lon === 0) ? { lat, lon } : {}),
    }
  } catch {
    return {}
  }
}
