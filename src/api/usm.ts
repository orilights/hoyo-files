import type { FileRecord } from '@/types'
import { useQuery } from '@tanstack/vue-query'
import { API_BASE } from '@/constants/core'

export function useUsmDescriptions(gameId: ComputedRef<string>) {
  return useQuery({
    queryKey: computed(() => ['usm-descriptions', gameId.value]),
    queryFn: async ({ signal }) => {
      const res = await fetch(`${API_BASE}/usm/${gameId.value}_desc.json`, { signal })
      if (res.status === 404)
        return {} as Record<string, string>
      if (!res.ok)
        throw new Error(`Failed to fetch USM descriptions: ${res.status}`)
      const data: unknown = await res.json()
      if (!data || typeof data !== 'object' || Array.isArray(data))
        return {} as Record<string, string>
      return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function useUsmHistory(gameId: ComputedRef<string>) {
  return useQuery({
    queryKey: computed(() => ['usm-history', gameId.value]),
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/usm/${gameId.value}_history.json`)
      if (!res.ok)
        throw new Error(`Failed to fetch history: ${res.status}`)
      return res.json() as Promise<Record<string, FileRecord>>
    },
    staleTime: 5 * 60 * 1000,
  })
}
