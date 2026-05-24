import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
} from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import {
  ArrowLeftRight,
  ArrowUp,
  Download,
  GitFork,
  ImageIcon,
  ImagePlus,
  Images,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react"
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useGenerationEvents } from "@/hooks/use-generation-events"
import {
  addPerson,
  cancelGeneration,
  createGeneration,
  deleteGalleryItem,
  forkTurn,
  getConversation,
  getGalleryItem,
  listConversations,
  listGallery,
  listPeople,
  regenerateGeneration,
  type ConversationSummary,
  type GalleryItem,
  type GenerationDraft,
  type ImageModel,
  type Person,
  type Turn,
} from "@/lib/api"
import { cn } from "@/lib/utils"

type ImageSettings = {
  model: ImageModel
  aspectRatio: "1:1" | "3:2" | "2:3"
  quality: "low" | "medium" | "high"
  resolution: "1k" | "2k"
}

type ActiveMention = {
  query: string
  range: Range
}

type ComposerSubmission = Omit<GenerationDraft, "model" | "aspectRatio" | "quality" | "resolution" | "conversationId" | "parentTurnId">

type DraftAttachment = {
  file: File
  previewUrl: string
}

function loadSettings(): ImageSettings {
  const fallback: ImageSettings = { model: "openai/gpt-image-2", aspectRatio: "3:2", quality: "medium", resolution: "2k" }
  const saved = window.localStorage.getItem("creator-image-settings")
  if (!saved) return fallback
  try {
    return { ...fallback, ...JSON.parse(saved) }
  } catch {
    return fallback
  }
}

function initials(name: string) {
  return name.split(" ").map((word) => word[0]).join("")
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong."
}

function modelName(model: ImageModel) {
  return model === "xai/grok-imagine-image-quality" ? "Grok" : "GPT"
}

const COMPLETION_SOUND = "/generation-complete.mp3"

function prepareCompletionAlert() {
  if ("Notification" in window && Notification.permission === "default") {
    void Notification.requestPermission()
  }
  const audio = new Audio(COMPLETION_SOUND)
  audio.preload = "auto"
  audio.load()
}

function notifyGenerationComplete() {
  const audio = new Audio(COMPLETION_SOUND)
  audio.volume = 0.7
  void audio.play().catch(() => undefined)

  if ((document.visibilityState === "hidden" || !document.hasFocus()) && "Notification" in window && Notification.permission === "granted") {
    new Notification("Image ready", { body: "Your generation is complete." })
  }
}

function canUseShortcut(event: globalThis.KeyboardEvent) {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
  if (!(event.target instanceof HTMLElement)) return true
  if (event.target.isContentEditable || event.target.closest("input, textarea, select, [contenteditable='true']")) return false
  return !document.querySelector("[data-slot='dialog-content'][data-state='open'], [data-slot='alert-dialog-content'][data-state='open']")
}

export function App() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<ImageSettings>(loadSettings)
  const people = useQuery({ queryKey: ["people"], queryFn: listPeople })
  const conversations = useQuery({ queryKey: ["conversations"], queryFn: listConversations })

  function updateSettings(next: Partial<ImageSettings>) {
    const value = { ...settings, ...next }
    window.localStorage.setItem("creator-image-settings", JSON.stringify(value))
    setSettings(value)
  }

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!canUseShortcut(event) || event.key.toLowerCase() !== "n") return
      event.preventDefault()
      navigate("/", { state: { skipComposerMotion: true } })
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [navigate])

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={false}>
        <WorkspaceSidebar conversations={conversations.data ?? []} people={people.data ?? []} peopleLoading={people.isLoading} />
        <WorkspaceSidebarBackdrop />
        <SidebarInset className="h-svh overflow-hidden bg-background">
          <WorkspaceSidebarOpenButton />
          <LayoutGroup>
            <Routes>
              <Route path="/" element={<LandingPage people={people.data ?? []} settings={settings} onSettingsChange={updateSettings} />} />
              <Route path="/c/:conversationId" element={<ConversationPage people={people.data ?? []} settings={settings} onSettingsChange={updateSettings} />} />
              <Route path="/gallery" element={<GalleryPage />} />
              <Route path="/gallery/:assetId" element={<GalleryPage />} />
            </Routes>
          </LayoutGroup>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function WorkspaceSidebar({ conversations, people, peopleLoading }: { conversations: ConversationSummary[]; people: Person[]; peopleLoading: boolean }) {
  const navigate = useNavigate()
  const location = useLocation()
  const activeConversationId = location.pathname.startsWith("/c/") ? location.pathname.slice(3) : null

  return (
    <Sidebar overlay collapsible="offcanvas" variant="floating" className="z-40! duration-300 ease-out">
      <SidebarHeader className="px-3 pt-2.5 pb-2">
        <div className="flex items-center justify-between gap-2">
          <SidebarTrigger className="text-muted-foreground hover:text-foreground">
            <X className="transition-transform duration-200 ease-out hover:rotate-90" />
            <span className="sr-only">Close sidebar</span>
          </SidebarTrigger>
          <div className="font-heading text-xs font-medium tracking-tight">Creator</div>
        </div>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent className="pt-1">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={location.pathname.startsWith("/gallery")} className="text-xs" onClick={() => navigate("/gallery")}>
                  <Images />
                  <span>Gallery</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>Conversations</SidebarGroupLabel>
          <SidebarGroupAction aria-label="New prompt" aria-keyshortcuts="N" title="New prompt (N)" onClick={() => navigate("/", { state: { skipComposerMotion: true } })}>
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {conversations.map((conversation) => (
                <SidebarMenuItem key={conversation.id}>
                  <SidebarMenuButton isActive={activeConversationId === conversation.id} tooltip={conversation.title} className="text-xs" onClick={() => navigate(`/c/${conversation.id}`)}>
                    {conversation.previewSrc ? (
                      <img src={conversation.previewSrc} alt="" className="size-5 shrink-0 rounded-[4px] object-cover" />
                    ) : (
                      <ImageIcon />
                    )}
                    <span className={cn(conversation.titleStatus === "generating" && "animate-pulse text-muted-foreground")}>{conversation.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {!conversations.length && <p className="px-2 py-1 text-[11px] text-muted-foreground">No conversations yet</p>}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>People</SidebarGroupLabel>
          <AddPersonDialog />
          <SidebarGroupContent>
            <SidebarMenu>
              {people.map((person) => (
                <SidebarMenuItem key={person.id}>
                  <SidebarMenuButton tooltip={`@${person.handle}`} className="h-9 text-xs">
                    <Avatar size="sm">
                      <AvatarImage src={person.imageSrc} alt={person.name} />
                      <AvatarFallback>{initials(person.name)}</AvatarFallback>
                    </Avatar>
                    <span className="flex flex-col leading-tight">
                      <span>{person.name}</span>
                      <span className="text-[11px] text-muted-foreground">@{person.handle}</span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {peopleLoading && <Skeleton className="mx-2 mt-1 h-8" />}
              {!peopleLoading && !people.length && <p className="px-2 py-1 text-[11px] text-muted-foreground">Add a person to mention them</p>}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}

function AddPersonDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState("")
  const mutation = useMutation({
    mutationFn: addPerson,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["people"] })
      setOpen(false)
      reset()
    },
  })

  function reset() {
    setName("")
    setFile(null)
    setPreview("")
    mutation.reset()
  }

  function pickImage(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null
    setFile(next)
    if (!next) return setPreview("")
    const reader = new FileReader()
    reader.addEventListener("load", () => setPreview(String(reader.result)))
    reader.readAsDataURL(next)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file || !name.trim()) return
    const form = new FormData()
    form.set("name", name.trim())
    form.set("handle", name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
    form.set("image", file)
    await mutation.mutateAsync(form).catch(() => undefined)
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) reset() }}>
      <DialogTrigger asChild>
        <SidebarGroupAction aria-label="Add person"><Plus /></SidebarGroupAction>
      </DialogTrigger>
      <DialogContent className="gap-5 p-5 text-xs sm:max-w-sm">
        <DialogHeader className="gap-1.5 pr-7">
          <DialogTitle className="text-base">Add person</DialogTitle>
          <DialogDescription className="text-xs">Upload a portrait and give them a name.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div>
            <Input id="person-photo" className="sr-only" type="file" accept="image/*" onChange={pickImage} required />
            <Label htmlFor="person-photo" className={cn("group flex w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-muted/20 transition-colors hover:border-foreground/25 hover:bg-muted/30", !preview && "h-60")}>
              {preview ? (
                <img src={preview} alt="Portrait preview" className="h-auto w-full object-contain" />
              ) : (
                <>
                  <ImagePlus className="mb-2 size-6 text-muted-foreground transition-colors group-hover:text-foreground/70" />
                  <span className="text-xs text-muted-foreground">Upload portrait</span>
                </>
              )}
            </Label>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="person-name" className="text-xs">Name</Label>
            <Input id="person-name" className="h-9 text-sm" value={name} placeholder="Person name" onChange={(event) => setName(event.target.value)} required />
            {mutation.error && <p className="text-[11px] text-destructive">{message(mutation.error)}</p>}
          </div>
          <DialogFooter className="-mx-5 -mb-5 mt-1 p-4">
            <Button type="submit" className="w-full" disabled={!file || !name.trim() || mutation.isPending}>
              {mutation.isPending ? "Adding..." : "Add person"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function WorkspaceSidebarOpenButton() {
  const { isMobile, open, openMobile } = useSidebar()
  const isOpen = isMobile ? openMobile : open
  return (
    <SidebarTrigger aria-hidden={isOpen} tabIndex={isOpen ? -1 : 0} className={cn(
      "fixed top-4 left-4 z-30 rounded-lg border border-transparent bg-background/45 text-muted-foreground backdrop-blur-sm transition-all duration-200 hover:border-border/60 hover:bg-muted/55 hover:text-foreground",
      isOpen && "pointer-events-none -translate-x-1 opacity-0"
    )} />
  )
}

function WorkspaceSidebarBackdrop() {
  const { isMobile, open, setOpen } = useSidebar()
  if (isMobile) return null
  return <button type="button" aria-label="Close sidebar" tabIndex={open ? 0 : -1} onClick={() => setOpen(false)} className={cn(
    "fixed inset-0 z-20 hidden bg-black/28 backdrop-blur-[1px] transition-opacity duration-300 md:block",
    open ? "opacity-100" : "pointer-events-none opacity-0"
  )} />
}

function LandingPage({ people, settings, onSettingsChange }: { people: Person[]; settings: ImageSettings; onSettingsChange: (next: Partial<ImageSettings>) => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const mutation = useMutation({ mutationFn: createGeneration })
  const skipComposerMotion = Boolean((location.state as { skipComposerMotion?: boolean } | null)?.skipComposerMotion)

  async function submit(value: ComposerSubmission) {
    prepareCompletionAlert()
    const result = await mutation.mutateAsync({ ...value, ...settings })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      queryClient.invalidateQueries({ queryKey: ["conversation", result.conversation.id] }),
    ])
    navigate(`/c/${result.conversation.id}`, { state: { focusTurnId: result.turn.id, animateComposer: true } })
  }

  return (
    <div className="relative flex h-full items-center justify-center px-4">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_46%,oklch(0.22_0.025_235_/_0.3),transparent_42%)]" />
      <motion.div layoutId={skipComposerMotion ? undefined : "prompt-composer"} initial={skipComposerMotion ? { opacity: 0 } : undefined} animate={{ opacity: 1 }} transition={skipComposerMotion ? { duration: 0.16 } : { type: "spring", stiffness: 360, damping: 34, mass: 0.85 }}>
        <PromptComposer
          people={people}
          className="min-h-[18svh] w-[clamp(22rem,46vw,49.5rem)] max-w-[calc(100vw-2rem)]"
          placeholder="Describe an image... Use @ to add someone"
          settings={settings}
          onSettingsChange={onSettingsChange}
          onSubmit={submit}
          busy={mutation.isPending}
          canToggleModel
        />
      </motion.div>
    </div>
  )
}

function ConversationPage({ people, settings, onSettingsChange }: { people: Person[]; settings: ImageSettings; onSettingsChange: (next: Partial<ImageSettings>) => void }) {
  const { conversationId = "" } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const location = useLocation()
  const stateFocus = (location.state as { focusTurnId?: string } | null)?.focusTurnId
  const animateComposer = Boolean((location.state as { animateComposer?: boolean } | null)?.animateComposer)
  const [focusedId, setFocusedId] = useState<string | null>(stateFocus ?? null)
  const alertedTurns = useRef(new Set<string>())
  const wheelTotal = useRef(0)
  const wheelLocked = useRef(false)
  const wheelReleaseTimer = useRef<number | null>(null)
  const conversation = useQuery({ queryKey: ["conversation", conversationId], queryFn: () => getConversation(conversationId), enabled: Boolean(conversationId) })
  const create = useMutation({ mutationFn: createGeneration })
  const cancel = useMutation({ mutationFn: cancelGeneration })
  const regenerate = useMutation({ mutationFn: (turnId: string) => regenerateGeneration(turnId, conversationId) })
  const fork = useMutation({ mutationFn: forkTurn })
  const turns = conversation.data?.turns ?? []
  const activeTurn = turns.find((item) => !["succeeded", "failed", "canceled"].includes(item.status)) ?? null
  const latestSuccessful = [...turns].reverse().find((item) => item.status === "succeeded" && item.previewSrc) ?? null
  const latestTerminalTurn = [...turns].reverse().find((item) => ["succeeded", "failed", "canceled"].includes(item.status)) ?? null
  const focusedTurn = turns.find((item) => item.id === focusedId) ?? activeTurn ?? latestTerminalTurn ?? turns.at(-1) ?? null
  const visibleTurns = turns.filter((item) => item.previewSrc || !["succeeded", "failed", "canceled"].includes(item.status) || item.status === "failed" || item.status === "canceled")
  const conversationModel = latestSuccessful?.model ?? activeTurn?.model ?? "openai/gpt-image-2"

  useEffect(() => {
    if (!animateComposer) return
    const timeout = window.setTimeout(() => {
      navigate(location.pathname, { replace: true, state: { focusTurnId: stateFocus } })
    }, 420)
    return () => window.clearTimeout(timeout)
  }, [animateComposer, location.pathname, navigate, stateFocus])

  useEffect(() => () => {
    if (wheelReleaseTimer.current !== null) window.clearTimeout(wheelReleaseTimer.current)
  }, [])

  useGenerationEvents(activeTurn?.id ?? null, Boolean(activeTurn), (nextTurn) => {
    if (nextTurn.status === "succeeded") {
      setFocusedId(nextTurn.id)
      if (!alertedTurns.current.has(nextTurn.id)) {
        alertedTurns.current.add(nextTurn.id)
        notifyGenerationComplete()
      }
    }
    void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
    if (nextTurn.status === "succeeded") void queryClient.invalidateQueries({ queryKey: ["gallery"] })
  })

  async function submit(value: ComposerSubmission) {
    if (!latestSuccessful) return
    prepareCompletionAlert()
    const result = await create.mutateAsync({ ...value, ...settings, model: conversationModel, conversationId, parentTurnId: latestSuccessful.id })
    setFocusedId(result.turn.id)
    await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })
  }

  async function runRegenerate(turnId: string) {
    prepareCompletionAlert()
    const result = await regenerate.mutateAsync(turnId)
    setFocusedId(result.id)
    await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })
  }

  const regenerateFromKeyboard = useEffectEvent(() => {
    if (focusedTurn) void runRegenerate(focusedTurn.id)
  })
  const mayRegenerate = Boolean(focusedTurn && ["succeeded", "failed", "canceled"].includes(focusedTurn.status) && !activeTurn && !regenerate.isPending)

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!mayRegenerate || !canUseShortcut(event) || event.key.toLowerCase() !== "r") return
      event.preventDefault()
      regenerateFromKeyboard()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [mayRegenerate])

  async function runFork(turnId: string) {
    const result = await fork.mutateAsync(turnId)
    await queryClient.invalidateQueries({ queryKey: ["conversations"] })
    navigate(`/c/${result.conversation.id}`, { state: { focusTurnId: result.focusedTurn.id } })
  }

  function focusAdjacent(direction: -1 | 1) {
    if (!focusedTurn || activeTurn || visibleTurns.length < 2) return
    const index = visibleTurns.findIndex((turn) => turn.id === focusedTurn.id)
    const currentIndex = index === -1 ? visibleTurns.length - 1 : index
    const target = visibleTurns[currentIndex + direction]
    if (!target) return
    setFocusedId(target.id)
  }

  function handleTimelineWheel(event: WheelEvent<HTMLDivElement>) {
    if (activeTurn || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    event.preventDefault()
    if (wheelReleaseTimer.current !== null) window.clearTimeout(wheelReleaseTimer.current)
    wheelReleaseTimer.current = window.setTimeout(() => {
      wheelLocked.current = false
      wheelTotal.current = 0
    }, 180)
    if (wheelLocked.current) return
    wheelTotal.current += event.deltaY
    if (Math.abs(wheelTotal.current) < 72) return
    focusAdjacent(wheelTotal.current < 0 ? -1 : 1)
    wheelLocked.current = true
    wheelTotal.current = 0
  }

  if (conversation.isLoading) return <CenteredLoader />
  if (!conversation.data || conversation.error) return <PageError text={message(conversation.error)} />

  return (
    <div className="relative flex h-full flex-col items-center px-4 pt-7 pb-46 sm:pt-5">
      <div className="flex min-h-0 flex-1 items-start justify-center pt-3 sm:pt-0" onWheel={handleTimelineWheel}>
        {focusedTurn ? (
          <div className="relative">
            <RevisionRail turns={visibleTurns} activeId={focusedTurn.id} disabled={Boolean(activeTurn)} onSelect={setFocusedId} />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={focusedTurn.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
                <FocusedOutput
                  turn={focusedTurn}
                  busy={Boolean(activeTurn)}
                  onCancel={() => activeTurn?.id === focusedTurn.id && cancel.mutateAsync(activeTurn.id).then(() => queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }))}
                  onRegenerate={() => runRegenerate(focusedTurn.id)}
                  onFork={() => runFork(focusedTurn.id)}
                />
              </motion.div>
            </AnimatePresence>
          </div>
        ) : <p className="pt-3 text-xs text-muted-foreground">No output in this conversation.</p>}
      </div>
      <motion.div layoutId={animateComposer ? "prompt-composer" : undefined} className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center" transition={{ type: "spring", stiffness: 360, damping: 34, mass: 0.85 }}>
        <PromptComposer
          people={people}
          className="pointer-events-auto min-h-31 w-[min(49.5rem,calc(100vw-2rem))]"
          placeholder="Describe a change... Use @ to add someone"
          settings={{ ...settings, model: conversationModel }}
          onSettingsChange={onSettingsChange}
          onSubmit={submit}
          busy={Boolean(activeTurn) || create.isPending}
          disabled={!latestSuccessful}
        />
      </motion.div>
    </div>
  )
}

function RevisionRail({ turns, activeId, disabled, onSelect }: { turns: Turn[]; activeId: string; disabled: boolean; onSelect: (id: string) => void }) {
  if (turns.length < 2) return null

  return (
    <nav aria-label="Generation history" className="absolute top-2 right-full mr-3 hidden flex-col items-center gap-1.5 sm:flex">
      <span className="mb-1 text-[10px] text-muted-foreground tabular-nums">{turns.findIndex((turn) => turn.id === activeId) + 1}/{turns.length}</span>
      <div className="relative flex flex-col items-center gap-2 before:absolute before:top-4 before:bottom-4 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border">
        {turns.map((turn) => (
          <Tooltip key={turn.id}>
            <TooltipTrigger asChild>
              <button type="button" disabled={disabled} onClick={() => onSelect(turn.id)} className={cn("relative z-10 flex size-9 items-center justify-center overflow-hidden rounded-md border bg-background transition-all", turn.id === activeId ? "border-foreground/45 ring-2 ring-background" : "border-border opacity-60 hover:opacity-100")}>
                {turn.previewSrc ? <img src={turn.previewSrc} alt="" className="size-full object-cover" /> : <LoaderCircle className={cn("size-3 text-muted-foreground", !["failed", "canceled"].includes(turn.status) && "animate-spin")} />}
                {turn.isForkPoint && <span className="absolute bottom-0 left-0 h-0.5 w-full bg-primary" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{turn.isSnapshot ? "Inherited output" : turn.prompt.length > 46 ? `${turn.prompt.slice(0, 46).trimEnd()}...` : turn.prompt}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </nav>
  )
}

function FocusedOutput({ turn, busy, onCancel, onRegenerate, onFork }: {
  turn: Turn
  busy: boolean
  onCancel: () => void
  onRegenerate: () => void
  onFork: () => void
}) {
  const pending = !["succeeded", "failed", "canceled"].includes(turn.status)
  const frameClassName = cn(
    "w-[min(49.5rem,calc(100vw-2rem))]",
    turn.aspectRatio === "3:2" ? "aspect-[3/2]" : turn.aspectRatio === "2:3" ? "aspect-[2/3]" : "aspect-square"
  )
  return (
    <figure className="group relative flex max-h-full flex-col items-center gap-2">
      <div className={cn("relative flex items-center justify-center overflow-hidden rounded-xl border border-white/8 bg-card shadow-2xl shadow-black/35", frameClassName)}>
        <AnimatePresence mode="wait">
          {turn.status === "succeeded" && turn.previewSrc ? (
            <img key={turn.previewSrc} src={turn.previewSrc} alt={turn.prompt} className="size-full object-cover" />
          ) : pending ? (
            <motion.div key="pending" className="flex flex-col items-center gap-3 text-xs text-muted-foreground" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <LoaderCircle className="size-4 animate-spin" />
              <span>{turn.status === "persisting" ? "Saving image" : "Generating image"}</span>
              <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
            </motion.div>
          ) : (
            <motion.div key="terminal" className="flex flex-col items-center gap-2 text-xs text-muted-foreground" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <span>{turn.status === "failed" ? turn.errorMessage ?? "Generation failed" : "Generation canceled"}</span>
              <Button variant="outline" size="sm" disabled={busy} aria-keyshortcuts="R" title="Try again (R)" onClick={onRegenerate}>
                <RefreshCw />
                Try again
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
        {turn.status === "succeeded" && (
          <div className="absolute top-2 right-2 flex gap-0.5 rounded-lg border border-white/10 bg-black/35 p-0.5 opacity-0 backdrop-blur-md transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button size="icon-sm" variant="ghost" disabled={busy} aria-keyshortcuts="R" title="Regenerate (R)" className="text-white hover:bg-white/14 hover:text-white" onClick={onRegenerate}><RefreshCw /><span className="sr-only">Regenerate</span></Button>
            <Button size="icon-sm" variant="ghost" disabled={busy} className="text-white hover:bg-white/14 hover:text-white" onClick={onFork}><GitFork /><span className="sr-only">Fork</span></Button>
            {turn.downloadSrc && <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/14 hover:text-white" asChild><a href={turn.downloadSrc} download><Download /><span className="sr-only">Download</span></a></Button>}
          </div>
        )}
      </div>
      <PromptSummary turn={turn} />
    </figure>
  )
}

function PromptSummary({ turn }: { turn: Turn }) {
  const mentions = new Map(turn.inputs.filter((input) => input.person).map((input) => [`@${input.person!.handle}`, input]))
  return (
    <div className="flex max-w-xl flex-wrap items-center justify-center gap-1 text-[11px] text-muted-foreground">
      {turn.prompt.split(/(@[\w-]+)/g).map((fragment, index) => {
        const input = mentions.get(fragment)
        if (!input?.person) return <span key={`${fragment}-${index}`}>{fragment}</span>
        return (
          <Tooltip key={`${input.assetId}-${index}`}>
            <TooltipTrigger asChild><Badge variant="outline" className={cn("h-auto rounded-sm border-transparent px-1 py-0 text-[11px] leading-4 ring-1", input.person.colorToken)}>{fragment}</Badge></TooltipTrigger>
            <TooltipContent hideArrow className="block bg-popover p-1.5 text-popover-foreground ring-1 ring-border">
              {input.src && <img className="h-24 w-20 rounded-md object-cover" src={input.src} alt={input.person.name} />}
              <p className="mt-1 text-[11px] font-medium">{input.person.name}</p>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

function GalleryPage() {
  const { assetId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const gallery = useQuery({ queryKey: ["gallery"], queryFn: listGallery })
  const detail = useQuery({ queryKey: ["gallery", assetId], queryFn: () => getGalleryItem(assetId!), enabled: Boolean(assetId) })
  const selected = assetId ? gallery.data?.find((item) => item.assetId === assetId) ?? detail.data : null
  const selectedWidth = selected?.aspectRatio === "3:2"
    ? "min(70rem, calc(100vw - 3rem), calc((100svh - 8rem) * 1.5))"
    : selected?.aspectRatio === "2:3"
      ? "min(46rem, calc(100vw - 3rem), calc((100svh - 8rem) * 0.6667))"
      : "min(52rem, calc(100vw - 3rem), calc(100svh - 8rem))"
  const fork = useMutation({ mutationFn: forkTurn, onSuccess: (result) => {
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
    navigate(`/c/${result.conversation.id}`, { state: { focusTurnId: result.focusedTurn.id } })
  } })
  const remove = useMutation({ mutationFn: deleteGalleryItem, onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ["gallery"] })
    navigate("/gallery")
  } })

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!assetId || event.key !== "Escape") return
      if (document.querySelector("[data-slot='alert-dialog-content'][data-state='open']")) return
      event.preventDefault()
      navigate("/gallery")
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [assetId, navigate])

  if (gallery.isLoading) return <CenteredLoader />
  if (gallery.error) return <PageError text={message(gallery.error)} />

  return (
    <div className="relative h-full overflow-y-auto px-6 pt-14 pb-8 sm:px-10">
      <div className="mx-auto max-w-6xl">
        <h1 className="font-heading text-sm font-medium">Gallery</h1>
        <p className="mt-1 text-xs text-muted-foreground">Every successful output, preserved.</p>
        {!gallery.data?.length ? <p className="mt-16 text-center text-xs text-muted-foreground">Generated images will appear here.</p> : (
          <div className="mt-6 columns-2 gap-3 sm:columns-3 lg:columns-4">
            {gallery.data.map((item) => (
              <article key={item.assetId} className="group relative mb-3 break-inside-avoid">
                <Link to={`/gallery/${item.assetId}`} className="block overflow-hidden rounded-lg bg-card" style={{ aspectRatio: item.aspectRatio.replace(":", " / ") }}>
                  <img src={item.thumbnailSrc} alt={item.prompt} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.015]" />
                </Link>
                <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{item.prompt}</p>
              </article>
            ))}
          </div>
        )}
      </div>
      <AnimatePresence>
        {selected && (
          <motion.div className="fixed inset-0 z-30 flex items-center justify-center p-6 sm:p-12" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <motion.button type="button" aria-label="Close image" className="absolute inset-0 bg-background/88 backdrop-blur-sm" onClick={() => navigate("/gallery")} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <div className="relative z-10 flex max-h-full max-w-full flex-col items-center gap-3">
              <div className="flex w-full items-center justify-end">
                <OutputActions item={selected} onFork={() => fork.mutate(selected.turnId)} onDelete={() => remove.mutate(selected.assetId)} />
                <Button variant="ghost" size="icon-sm" aria-keyshortcuts="Escape" title="Close (Esc)" className="ml-1" onClick={() => navigate("/gallery")}><X /><span className="sr-only">Close</span></Button>
              </div>
              <motion.div className="overflow-hidden rounded-xl shadow-2xl shadow-black/30" style={{ aspectRatio: selected.aspectRatio.replace(":", " / "), width: selectedWidth }} initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.99 }} transition={{ duration: 0.18, ease: "easeOut" }}>
                <img src={selected.previewSrc} alt={selected.prompt} className="size-full object-cover" />
              </motion.div>
              <div className="flex max-w-xl items-center gap-2 text-xs text-muted-foreground">
                <span>{selected.prompt}</span>
                <Badge variant="outline" className="shrink-0 rounded-sm px-1 py-0 text-[10px]">{modelName(selected.model)}</Badge>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function OutputActions({ item, onFork, onDelete }: { item: GalleryItem; onFork: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="sm" onClick={onFork}><GitFork />Fork</Button>
      <Button variant="outline" size="sm" asChild><a href={item.downloadSrc} download><Download />Download</a></Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" disabled={!item.mayDelete}><Trash2 /><span className="sr-only">Delete</span></Button>
        </AlertDialogTrigger>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete this output?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">The stored image will be permanently deleted. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction size="sm" variant="destructive" onClick={onDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function PromptComposer({ people, className, placeholder, settings, onSettingsChange, onSubmit, busy, disabled = false, canToggleModel = false }: {
  people: Person[]
  className?: string
  placeholder: string
  settings: ImageSettings
  onSettingsChange: (next: Partial<ImageSettings>) => void
  onSubmit: (draft: ComposerSubmission) => Promise<void>
  busy: boolean
  disabled?: boolean
  canToggleModel?: boolean
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [hasPrompt, setHasPrompt] = useState(false)
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [hoveredPerson, setHoveredPerson] = useState<Person | null>(null)
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const attachmentsRef = useRef<DraftAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isGrok = settings.model === "xai/grok-imagine-image-quality"
  const allowsAttachment = !isGrok || canToggleModel
  const attachmentLimit = isGrok ? 1 : 2
  const resolvedPlaceholder = isGrok
    ? canToggleModel ? "Type a text prompt or add one reference image..." : "Describe a change..."
    : placeholder
  const deferredQuery = useDeferredValue(activeMention?.query ?? "")
  const suggestions = !isGrok && activeMention ? people.filter((person) => `${person.name} ${person.handle}`.toLowerCase().includes(deferredQuery.toLowerCase())).slice(0, 5) : []
  const showSuggestions = suggestions.length > 0 && activeMention !== null

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => () => {
    attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl))
  }, [])

  function promptValue() { return editorRef.current?.innerText.replaceAll("\u00a0", " ").trim() ?? "" }
  function mentionedPeople() {
    const elements = editorRef.current?.querySelectorAll<HTMLElement>("[data-person-id]") ?? []
    const ids = new Set(Array.from(elements, (element) => element.dataset.personId))
    return people.filter((person) => ids.has(person.id))
  }
  function locateMention(): ActiveMention | null {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return null
    const range = selection.getRangeAt(0)
    if (!(range.endContainer instanceof Text) || !editor.contains(range.endContainer)) return null
    const beforeCursor = range.endContainer.textContent?.slice(0, range.endOffset) ?? ""
    const match = beforeCursor.match(/(?:^|\s)(@[\w-]*)$/)
    if (!match) return null
    const mentionRange = range.cloneRange()
    mentionRange.setStart(range.endContainer, range.endOffset - match[1].length)
    return { query: match[1].slice(1), range: mentionRange }
  }
  function handleInput() { setHasPrompt(promptValue().length > 0); setActiveMention(locateMention()); setHighlightedIndex(0); setHoveredPerson(null) }
  function selectPerson(person: Person) {
    if (!activeMention || !editorRef.current) return
    const selected = mentionedPeople()
    if (!selected.some((item) => item.id === person.id) && selected.length >= 4) { setError("A prompt can reference up to four people."); return }
    const badge = document.createElement("span")
    badge.contentEditable = "false"
    badge.dataset.personId = person.id
    badge.className = cn("mention-token", person.colorToken)
    badge.textContent = `@${person.handle}`
    activeMention.range.deleteContents()
    activeMention.range.insertNode(badge)
    const spacer = document.createTextNode("\u00a0")
    badge.after(spacer)
    const selection = window.getSelection()
    const nextRange = document.createRange()
    nextRange.setStartAfter(spacer)
    nextRange.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(nextRange)
    editorRef.current.focus()
    setHasPrompt(true)
    setActiveMention(null)
    setError(null)
  }
  function toggleModel() {
    if (!canToggleModel || busy || disabled) return
    if (!isGrok && (mentionedPeople().length > 0 || attachments.length > 1)) {
      setError("Grok supports one reference image and no tagged People.")
      return
    }
    onSettingsChange({ model: isGrok ? "openai/gpt-image-2" : "xai/grok-imagine-image-quality" })
    setActiveMention(null)
    setError(null)
  }
  function addFiles(files: File[]) {
    if (!allowsAttachment) {
      setError("Grok follow-up prompts edit the previous output and cannot include another reference image.")
      return
    }
    const images = files.filter((file) => file.type.startsWith("image/"))
    setAttachments((current) => {
      const remaining = attachmentLimit - current.length
      if (images.length > remaining) setError(isGrok ? "Grok supports one reference image." : "A prompt can include up to two reference images.")
      const added = images.slice(0, remaining).map((file) => ({ file, previewUrl: URL.createObjectURL(file) }))
      return [...current, ...added]
    })
  }
  function removeAttachment(index: number) {
    setAttachments((current) => {
      const removed = current[index]
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return current.filter((_, itemIndex) => itemIndex !== index)
    })
  }
  function clearAttachments() {
    attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl))
    setAttachments([])
  }
  async function submit() {
    const prompt = promptValue()
    if (!prompt || !editorRef.current || busy || disabled) return
    setError(null)
    try {
      await onSubmit({ prompt, people: mentionedPeople(), attachments: attachments.map((attachment) => attachment.file) })
      editorRef.current.innerHTML = ""
      setHasPrompt(false)
      clearAttachments()
      setActiveMention(null)
    } catch (cause) {
      setError(message(cause))
    }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (showSuggestions && event.key === "ArrowDown") { event.preventDefault(); setHighlightedIndex((current) => (current + 1) % suggestions.length); return }
    if (showSuggestions && event.key === "ArrowUp") { event.preventDefault(); setHighlightedIndex((current) => (current - 1 + suggestions.length) % suggestions.length); return }
    if (showSuggestions && event.key === "Enter") { event.preventDefault(); selectPerson(suggestions[Math.min(highlightedIndex, suggestions.length - 1)]); return }
    if (event.key === "Escape" && activeMention) { setActiveMention(null); return }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit() }
  }
  function mouseOver(event: MouseEvent<HTMLDivElement>) {
    const token = (event.target as HTMLElement).closest<HTMLElement>("[data-person-id]")
    setHoveredPerson(token ? people.find((person) => person.id === token.dataset.personId) ?? null : null)
  }
  function drop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)) }

  return (
    <Popover open={showSuggestions || Boolean(hoveredPerson)}>
      <PopoverAnchor asChild>
        <div onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={drop} className={cn(
          "relative mt-6 flex flex-col rounded-xl border bg-card/92 p-2.5 shadow-xl shadow-black/15 backdrop-blur-md transition-colors",
          isGrok ? "border-[#2B2B2B] focus-within:border-[#3a3a3a]" : "border-[#435064]/70 focus-within:border-[#596b85]",
          dragging && "border-primary/55 ring-2 ring-primary/15",
          className
        )}>
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            disabled={!canToggleModel || busy || disabled}
            aria-label={canToggleModel ? `Switch image model. Currently ${modelName(settings.model)}` : modelName(settings.model)}
            title={canToggleModel ? "Switch model" : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleModel}
            className={cn(
              "absolute top-0 left-3 flex -translate-y-full items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1 text-[10px] font-medium tracking-wide transition-colors",
              isGrok ? "border-[#2B2B2B] bg-[#2B2B2B] text-foreground" : "border-[#435064]/70 bg-[#252a33] text-[#aebbcf]",
              canToggleModel ? "hover:brightness-110" : "cursor-default"
            )}
          >
            {modelName(settings.model)}
            {canToggleModel && <ArrowLeftRight className="size-3 text-muted-foreground" />}
          </motion.button>
          <div ref={editorRef} role="textbox" aria-label="Image prompt" aria-multiline="true" data-placeholder={resolvedPlaceholder} contentEditable={!disabled && !busy} suppressContentEditableWarning className="prompt-editor min-h-0 flex-1 overflow-y-auto px-0.5 pt-0.5 text-[13px] leading-6 text-foreground outline-none" onInput={handleInput} onKeyDown={keyDown} onMouseOver={mouseOver} onMouseLeave={() => setHoveredPerson(null)} onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"))
            if (images.length) {
              event.preventDefault()
              addFiles(images)
            }
          }} />
          <AnimatePresence>
            {attachments.length > 0 && <motion.div className="mt-2 flex gap-1.5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {attachments.map((attachment, index) => (
                <motion.div key={attachment.previewUrl} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} className="group/attachment relative size-12 overflow-hidden rounded-md border border-border bg-muted">
                  <img src={attachment.previewUrl} alt="Reference attachment" className="size-full object-cover" />
                  <button type="button" aria-label="Remove reference image" onClick={() => removeAttachment(index)} className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-sm bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/attachment:opacity-100 focus:opacity-100">
                    <X className="size-3" />
                  </button>
                </motion.div>
              ))}
            </motion.div>}
          </AnimatePresence>
          {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
          <div className="mt-2 flex items-end justify-between gap-1.5">
            <div className="flex items-center gap-1">
              <input ref={fileRef} className="hidden" type="file" accept="image/*" multiple onChange={(event) => addFiles(Array.from(event.target.files ?? []))} />
              <Button type="button" size="icon-sm" variant="ghost" disabled={disabled || busy || !allowsAttachment || attachments.length >= attachmentLimit} title={isGrok ? (canToggleModel ? "Add one Grok reference image" : "Grok edits the previous output") : undefined} onClick={() => fileRef.current?.click()}><ImagePlus /><span className="sr-only">Add reference image</span></Button>
              <Select value={settings.aspectRatio} disabled={busy} onValueChange={(value) => onSettingsChange({ aspectRatio: value as ImageSettings["aspectRatio"] })}>
                <SelectTrigger size="sm" className="h-6 border-transparent bg-muted/45 px-2 text-[10px] text-muted-foreground hover:text-foreground"><SelectValue /></SelectTrigger>
                <SelectContent position="popper" align="start" className="min-w-24"><SelectItem value="3:2" className="text-[11px]!">3:2</SelectItem><SelectItem value="1:1" className="text-[11px]!">1:1</SelectItem><SelectItem value="2:3" className="text-[11px]!">2:3</SelectItem></SelectContent>
              </Select>
              {isGrok ? (
                <Select value={settings.resolution} disabled={busy} onValueChange={(value) => onSettingsChange({ resolution: value as ImageSettings["resolution"] })}>
                  <SelectTrigger size="sm" className="h-6 border-transparent bg-muted/45 px-2 text-[10px] text-muted-foreground hover:text-foreground"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" align="start" className="min-w-24"><SelectItem value="1k" className="text-[11px]!">1K</SelectItem><SelectItem value="2k" className="text-[11px]!">2K</SelectItem></SelectContent>
                </Select>
              ) : (
                <Select value={settings.quality} disabled={busy} onValueChange={(value) => onSettingsChange({ quality: value as ImageSettings["quality"] })}>
                  <SelectTrigger size="sm" className="h-6 border-transparent bg-muted/45 px-2 text-[10px] text-muted-foreground hover:text-foreground"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" align="start" className="min-w-28"><SelectItem value="low" className="text-[11px]!">Low</SelectItem><SelectItem value="medium" className="text-[11px]!">Medium</SelectItem><SelectItem value="high" className="text-[11px]!">High</SelectItem></SelectContent>
                </Select>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="hidden text-[10px] text-muted-foreground sm:inline">Shift + Enter for newline</span>
              <Button size="icon-sm" disabled={disabled || busy || !hasPrompt} onClick={() => void submit()} className="rounded-lg">{busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}<span className="sr-only">Generate image</span></Button>
            </div>
          </div>
        </div>
      </PopoverAnchor>
      {showSuggestions ? <PopoverContent side="top" align="start" sideOffset={8} className="w-64 gap-0.5 p-1" onOpenAutoFocus={(event) => event.preventDefault()}>
        <p className="px-1.5 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">People</p>
        {suggestions.map((person, index) => <Button key={person.id} type="button" variant="ghost" className={cn("h-auto w-full justify-start gap-2 px-1.5 py-1.5 text-xs", index === highlightedIndex && "bg-accent")} onMouseDown={(event) => { event.preventDefault(); selectPerson(person) }} onMouseEnter={() => setHighlightedIndex(index)}><Avatar><AvatarImage src={person.imageSrc} alt={person.name} /><AvatarFallback>{initials(person.name)}</AvatarFallback></Avatar><span className="flex flex-col items-start leading-tight"><span>{person.name}</span><span className="text-[11px] font-normal text-muted-foreground">@{person.handle}</span></span></Button>)}
      </PopoverContent> : hoveredPerson ? <PopoverContent side="top" align="start" sideOffset={6} className="pointer-events-none w-34 gap-1.5 p-1.5"><img className="h-32 w-full rounded-md object-cover" src={hoveredPerson.imageSrc} alt={hoveredPerson.name} /><div><p className="text-[11px] font-medium">{hoveredPerson.name}</p><p className="text-[10px] text-muted-foreground">@{hoveredPerson.handle}</p></div></PopoverContent> : null}
    </Popover>
  )
}

function CenteredLoader() {
  return <div className="flex h-full items-center justify-center"><LoaderCircle className="size-4 animate-spin text-muted-foreground" /></div>
}

function PageError({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-xs text-destructive">{text}</div>
}

export default App
