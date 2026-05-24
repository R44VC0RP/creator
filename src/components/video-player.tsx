import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00"
  const rounded = Math.floor(seconds)
  const minutes = Math.floor(rounded / 60)
  return `${minutes}:${String(rounded % 60).padStart(2, "0")}`
}

export function VideoPlayer({ src, poster, label, className }: { src: string; poster?: string; label: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const hideControlsRef = useRef<number | undefined>(undefined)
  const [playing, setPlaying] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  function stopHideTimer() {
    if (hideControlsRef.current !== undefined) {
      window.clearTimeout(hideControlsRef.current)
      hideControlsRef.current = undefined
    }
  }

  function showControls(hideAfterDelay = playing) {
    stopHideTimer()
    setControlsVisible(true)
    if (hideAfterDelay) {
      hideControlsRef.current = window.setTimeout(() => setControlsVisible(false), 1900)
    }
  }

  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange)
      stopHideTimer()
    }
  }, [])

  async function togglePlayback() {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      await video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }

  function seek(value: string) {
    const video = videoRef.current
    if (!video) return
    const nextTime = Number(value)
    video.currentTime = nextTime
    setCurrentTime(nextTime)
    showControls()
  }

  function updateVolume(value: string) {
    const video = videoRef.current
    if (!video) return
    const nextVolume = Number(value)
    video.volume = nextVolume
    video.muted = nextVolume === 0
    setVolume(nextVolume)
    setMuted(nextVolume === 0)
    showControls()
  }

  function toggleMute() {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setMuted(video.muted)
    showControls()
  }

  async function toggleFullscreen() {
    const container = containerRef.current
    if (!container) return
    if (document.fullscreenElement === container) {
      await document.exitFullscreen().catch(() => undefined)
    } else {
      await container.requestFullscreen().catch(() => undefined)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    if (event.key === " " || event.key.toLowerCase() === "k") {
      event.preventDefault()
      void togglePlayback()
    } else if (event.key.toLowerCase() === "m") {
      event.preventDefault()
      toggleMute()
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault()
      void toggleFullscreen()
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault()
      const video = videoRef.current
      if (!video) return
      video.currentTime = Math.max(0, Math.min(duration, video.currentTime + (event.key === "ArrowRight" ? 5 : -5)))
      showControls()
    }
  }

  const played = duration ? (currentTime / duration) * 100 : 0
  const volumeFill = muted ? 0 : volume * 100

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label={label}
      className={cn("group/video relative size-full overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-white/45", className)}
      onMouseMove={() => showControls()}
      onMouseLeave={() => playing && setControlsVisible(false)}
      onFocus={() => showControls(false)}
      onKeyDown={handleKeyDown}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        preload="metadata"
        playsInline
        className="size-full object-cover"
        onClick={() => void togglePlayback()}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume)
          setMuted(event.currentTarget.muted)
        }}
        onPlay={() => {
          setPlaying(true)
          showControls(true)
        }}
        onPause={() => {
          setPlaying(false)
          showControls(false)
        }}
        onEnded={() => {
          setPlaying(false)
          showControls(false)
        }}
      />
      <button
        type="button"
        aria-label="Play video"
        className={cn("absolute inset-0 flex items-center justify-center transition-opacity duration-200", playing ? "pointer-events-none opacity-0" : "opacity-100")}
        onClick={() => void togglePlayback()}
      >
        <span className="flex size-14 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white shadow-xl backdrop-blur-sm transition-transform hover:scale-105">
          <Play className="ml-0.5 size-6 fill-white" />
        </span>
      </button>
      <div className={cn("pointer-events-none absolute inset-x-0 bottom-0 flex flex-col justify-end bg-linear-to-t from-black/75 via-black/25 to-transparent px-3 pt-14 pb-3 text-white transition-opacity duration-200", controlsVisible || !playing ? "opacity-100" : "opacity-0")}>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={currentTime}
          aria-label="Seek video"
          className="video-scrubber pointer-events-auto mb-2 w-full"
          style={{ "--video-progress": `${played}%` } as CSSProperties}
          onChange={(event) => seek(event.target.value)}
        />
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={playing ? "Pause video" : "Play video"} className="pointer-events-auto text-white hover:bg-white/15 hover:text-white" onClick={() => void togglePlayback()}>
            {playing ? <Pause className="fill-white" /> : <Play className="fill-white" />}
          </Button>
          <span className="ml-1 text-[11px] font-medium text-white/85 tabular-nums">{formatTime(currentTime)} / {formatTime(duration)}</span>
          <div className="ml-auto flex items-center gap-0.5">
            <Button type="button" variant="ghost" size="icon-sm" aria-label={muted ? "Unmute" : "Mute"} className="pointer-events-auto text-white hover:bg-white/15 hover:text-white" onClick={toggleMute}>
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={muted ? 0 : volume}
              aria-label="Video volume"
              className="video-scrubber pointer-events-auto hidden w-16 sm:block"
              style={{ "--video-progress": `${volumeFill}%` } as CSSProperties}
              onChange={(event) => updateVolume(event.target.value)}
            />
            <Button type="button" variant="ghost" size="icon-sm" aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} className="pointer-events-auto ml-1 text-white hover:bg-white/15 hover:text-white" onClick={() => void toggleFullscreen()}>
              {fullscreen ? <Minimize /> : <Maximize />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
