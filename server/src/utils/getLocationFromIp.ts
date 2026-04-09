interface Location {
  country?: string
  region?: string
  city?: string
}

export const getLocationFromIp = async (ip: string): Promise<Location> => {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country,regionName,city`)
    const geo = (await res.json()) as { country?: string; regionName?: string; city?: string }
    return {
      country: geo.country,
      region: geo.regionName,
      city: geo.city,
    }
  } catch {
    return {}
  }
}
