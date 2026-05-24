import { useEffect, useEffectEvent } from "react"

import { turn, type Turn } from "@/lib/api"

export function useGenerationEvents(turnId: string | null, active: boolean, onUpdate: (turn: Turn) => void) {
  const handleUpdate = useEffectEvent(onUpdate)

  useEffect(() => {
    if (!turnId || !active) {
      return
    }

    const source = new EventSource(`/api/generations/${turnId}/events`)
    const update = (event: MessageEvent<string>) => handleUpdate(turn(JSON.parse(event.data)))

    source.addEventListener("status", update)
    source.addEventListener("completed", update)
    source.addEventListener("failed", update)
    source.addEventListener("canceled", update)
    source.addEventListener("completed", () => source.close())
    source.addEventListener("failed", () => source.close())
    source.addEventListener("canceled", () => source.close())
    return () => source.close()
  }, [active, turnId])
}
