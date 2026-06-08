import { apiClient } from './client'
import type { DemandGenerateRequest, DemandJobResponse } from './types'

export const generateDemand = (data: DemandGenerateRequest) =>
  apiClient
    .post<{ job_id: string; status: string }>('/demand/generate', data)
    .then(r => r.data)

export const getDemandStatus = (jobId: string) =>
  apiClient.get<DemandJobResponse>(`/demand/status/${jobId}`).then(r => r.data)

export const pollDemandUntilDone = (
  jobId: string,
  intervalMs = 3000,
  onUpdate?: (status: DemandJobResponse) => void
): Promise<DemandJobResponse> =>
  new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const status = await getDemandStatus(jobId)
        onUpdate?.(status)
        if (status.status === 'COMPLETED') return resolve(status)
        if (status.status === 'FAILED') return reject(new Error(status.message ?? 'Demand generation failed'))
        setTimeout(tick, intervalMs)
      } catch (err) {
        reject(err)
      }
    }
    tick()
  })
