import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Cable,
  ChevronDown,
  ChevronUp,
  Download,
  FileJson,
  FolderOpen,
  ImagePlus,
  Library,
  MoreHorizontal,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Redo2,
  Send,
  Sparkles,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import { ComponentRenderer, getComponentBounds, getComponentConnectionPoints } from "./ComponentRenderer";
import {
  AGENT_MAX_MODEL_ROUNDS,
  AGENT_MAX_REPAIR_CYCLES,
  AGENT_MAX_STALLED_ROUNDS,
  AGENT_MAX_TOOL_CALLS,
  CANVAS_STORAGE_KEY,
  HISTORY_LIMIT,
  PROJECT_FILE_VERSION,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SNAP_DISTANCE,
  WIRE_ENDPOINT_HIT_DISTANCE,
} from "./appConfig";
import { buildToolResultMessages, componentToolSnapshot, createModelCanvasState } from "./agentContext";
import {
  hasExplicitClearIntent,
  isRunResponseCurrent,
  isToolExecutionAuthorized,
} from "./agentRunPolicy";
import {
  cancelConversationTurn,
  continueConversationTurn,
  createConversation,
  fetchComponentCatalog,
  fetchComponentDetails,
  fetchConversation,
  fetchConversations,
  fetchModelOptions,
  getCatalogItems,
  normalizeUsage,
  readJsonResponse,
  saveConversationCanvas,
  startConversationTurn,
  syncDebugMessages,
  updateConversation,
  uploadAsset,
} from "./apiClient";
import {
  ComponentLibraryTile,
  WireSegmentRenderer,
  componentDisplayName,
  normalizeCacheKey,
  normalizeSearchValue,
} from "./componentUtils";
import {
  canvasStatesEqual,
  formatSaveTime,
  loadStoredCanvasState,
  normalizeImportedProjectState,
  reconcileCanvasComponentDetails,
  selectionExists,
} from "./editorState";
import { downloadTextFile, formatExportTimestamp, prepareSvgForExport } from "./exportUtils";
import { clamp, distance, isAxisAlignedPoints, samePoint } from "./geometry";
import { readImageFile } from "./imageUtils";
import { checkComponentLibraryPortGrid } from "./componentIntegrity";
import { computeCanvasViewportBounds } from "./canvasViewport";
import {
  applyToolCall,
  COMPONENT_GRID_SIZE,
  CONNECTION_GRID_SIZE,
  componentSupportsOrientation,
  createComponentInstance,
  demoToolCalls,
  emptyCanvasState,
  GRID_SIZE,
  getAllowedComponentOrientations,
  getNextCanvasObjectId,
  isCanvasMutatingToolCall,
  MAJOR_GRID_SIZE,
  mergeComponentProperties,
  parseToolCalls,
  snapCoordinateToGrid,
  snapPointToGridStep,
  validateCanvas,
} from "./circuitTools";
import type {
  CanvasBounds,
  CircuitCanvasState,
  CircuitToolCall,
  ComponentDetail,
  ComponentInstance,
  Orientation,
  Point,
  ToolExecutionResult,
  TraceItem,
  ValidationIssue,
  WireSegment,
} from "./circuitTools";
import type {
  AgentLoopStatus,
  AgentMessage,
  AgentPanelTab,
  AgentResponse,
  AgentRoundSummary,
  AgentRunControl,
  AgentStopReason,
  AgentTimelineItem,
  AgentUsage,
  ComponentDragState,
  EditorMode,
  EditorSelection,
  SnapTarget,
  ToolExecutionBatch,
  ToolExecutionRecord,
  WireDraft,
  WireEndpoint,
  WireEndpointDragState,
  WireSegmentDragState,
  UploadedImage,
  ConversationEvent,
  ConversationSummary,
  ReasoningMode,
} from "./appTypes";
import type { ModelOption, ModelProviderId, TurnStreamEvent } from "./apiClient";
import { ConversationDock } from "./ui";
import type { ContextUsage, ConversationTimelineItem, ToolTimelineEvent } from "./ui";

export function App() {
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const canvasSvgRef = useRef<SVGSVGElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectFileInputRef = useRef<HTMLInputElement | null>(null);
  const timersRef = useRef<number[]>([]);
  const componentDetailCacheRef = useRef<Map<string, ComponentDetail>>(new Map());
  const componentDragRef = useRef<ComponentDragState | null>(null);
  const wireEndpointDragRef = useRef<WireEndpointDragState | null>(null);
  const wireSegmentDragRef = useRef<WireSegmentDragState | null>(null);
  const agentRunRef = useRef<AgentRunControl | null>(null);
  const manualToolRunRef = useRef<AbortController | null>(null);
  const agentRunSequenceRef = useRef(0);
  const conversationSaveTimerRef = useRef<number | null>(null);
  const conversationBootstrapRef = useRef(false);
  // Keep circuit coordinates stable across window resizes. The SVG scales to
  // the viewport; responsive layout must never invalidate saved geometry.
  const canvasBounds = useMemo<CanvasBounds>(() => ({ width: 1280, height: 720 }), []);
  const [canvasState, setCanvasState] = useState<CircuitCanvasState>(() => loadStoredCanvasState());
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [historyPast, setHistoryPast] = useState<CircuitCanvasState[]>([]);
  const [historyFuture, setHistoryFuture] = useState<CircuitCanvasState[]>([]);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [canvasFlashKey, setCanvasFlashKey] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(true);
  const [toolDockCollapsed, setToolDockCollapsed] = useState(true);
  const [toolDockTab, setToolDockTab] = useState<"library" | "inspector">("library");
  const [isNarrowWorkspace, setIsNarrowWorkspace] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [activeAgentTab, setActiveAgentTab] = useState<AgentPanelTab>("chat");
  const [debugMode, setDebugMode] = useState(false);
  const [input, setInput] = useState("");
  const [imageName, setImageName] = useState("");
  const [uploadedImage, setUploadedImage] = useState<UploadedImage | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentLoopStatus, setAgentLoopStatus] = useState<AgentLoopStatus>("idle");
  const [agentRoundSummaries, setAgentRoundSummaries] = useState<AgentRoundSummary[]>([]);
  const [isAgentCalling, setIsAgentCalling] = useState(false);
  const [agentTimeline, setAgentTimeline] = useState<AgentTimelineItem[]>([]);
  const [agentStopReason, setAgentStopReason] = useState<AgentStopReason | null>(null);
  const [lastAgentTurnStart, setLastAgentTurnStart] = useState<CircuitCanvasState | null>(null);
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>("auto");
  const [agentUsage, setAgentUsage] = useState<AgentUsage | undefined>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationRevision, setConversationRevision] = useState(0);
  const [editorMode, setEditorMode] = useState<EditorMode>("select");
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [wireDraft, setWireDraft] = useState<WireDraft | null>(null);
  const [snapTarget, setSnapTarget] = useState<SnapTarget | null>(null);
  const [componentLibrary, setComponentLibrary] = useState<ComponentDetail[]>([]);
  const [componentQuery, setComponentQuery] = useState("");
  const [componentLibraryLoading, setComponentLibraryLoading] = useState(false);
  const [componentLibraryError, setComponentLibraryError] = useState<string | null>(null);
  const [pendingComponentName, setPendingComponentName] = useState<string | null>(null);
  const [placementOrientation, setPlacementOrientation] = useState<"h" | "v">("h");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [selectedModelProvider, setSelectedModelProvider] = useState<ModelProviderId>("bailian");
  const [selectedModel, setSelectedModel] = useState("qwen3.7-plus");
  const [modelOptionsError, setModelOptionsError] = useState<string | null>(null);
  const [canvasViewportSize, setCanvasViewportSize] = useState({ width: 1280, height: 720 });

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => {
      setIsNarrowWorkspace(media.matches);
      if (media.matches) setToolDockCollapsed(true);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (componentLibrary.length === 0) return;
    setCanvasState((current) => reconcileCanvasComponentDetails(current, componentLibrary));
  }, [canvasState.components, componentLibrary]);

  useEffect(() => {
    const viewport = canvasViewportRef.current;
    if (!viewport) return;

    const updateViewportSize = () => {
      const { width, height } = viewport.getBoundingClientRect();
      setCanvasViewportSize((current) =>
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height }
      );
    };

    updateViewportSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewportSize);
      return () => window.removeEventListener("resize", updateViewportSize);
    }

    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (conversationSaveTimerRef.current !== null) {
        window.clearTimeout(conversationSaveTimerRef.current);
      }
      agentRunRef.current?.abortController.abort();
      manualToolRunRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    const savedAt = new Date();
    try {
      window.localStorage.setItem(
        CANVAS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          savedAt: savedAt.toISOString(),
          state: canvasState,
        })
      );
      setLastSavedAt(formatSaveTime(savedAt));
    } catch (error) {
      console.warn("Failed to save circuit canvas state", error);
    }
  }, [canvasState]);

  useEffect(() => {
    if (!activeConversationId || conversationBootstrapRef.current === false) return;
    // Agent continuations persist the authoritative canvas together with each
    // tool batch. Avoid racing that revision with the manual-edit debounce.
    if (agentRunRef.current) return;
    if (conversationSaveTimerRef.current !== null) {
      window.clearTimeout(conversationSaveTimerRef.current);
    }
    conversationSaveTimerRef.current = window.setTimeout(() => {
      void saveConversationCanvas(activeConversationId, {
        canvas_state: canvasState,
        canvas_bounds: canvasBounds,
        revision: conversationRevision,
      })
        .then((revision) => {
          setConversationRevision(revision);
          setConversations((items) =>
            items.map((item) =>
              item.id === activeConversationId
                ? { ...item, canvas_revision: revision, updated_at: new Date().toISOString() }
                : item
            )
          );
        })
        .catch((error) => console.warn("Failed to persist conversation canvas", error));
    }, 500);
    return () => {
      if (conversationSaveTimerRef.current !== null) {
        window.clearTimeout(conversationSaveTimerRef.current);
        conversationSaveTimerRef.current = null;
      }
    };
  }, [activeConversationId, canvasBounds, canvasState]);

  useEffect(() => {
    let cancelled = false;

    async function loadComponentLibrary() {
      setComponentLibraryLoading(true);
      setComponentLibraryError(null);
      try {
        const catalog = await fetchComponentCatalog();
        const items = getCatalogItems(catalog);
        const details = await fetchComponentDetails(items.map((item) => item.name));
        details.components.forEach((detail) => cacheComponentDetail(detail));
        const integrity = checkComponentLibraryPortGrid(details.components);
        if (!integrity.valid) {
          console.warn(
            "Component port integrity issues:",
            integrity.issues.map((issue) => issue.message).join("; ")
          );
        }
        if (!cancelled) {
          setComponentLibrary(details.components);
          if (details.components.length === 0) {
            setComponentLibraryError("No components were loaded.");
          }
        }
      } catch (error) {
        if (!cancelled) {
          setComponentLibraryError(error instanceof Error ? error.message : "Failed to load component library");
        }
      } finally {
        if (!cancelled) {
          setComponentLibraryLoading(false);
        }
      }
    }

    void loadComponentLibrary();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (modelOptions.length === 0 || conversationBootstrapRef.current) return;
    conversationBootstrapRef.current = true;
    const controller = new AbortController();

    async function bootstrapConversations() {
      try {
        let items = await fetchConversations(controller.signal);
        if (items.length === 0) {
          const importedLocalWorkspace =
            canvasState.components.length > 0 || canvasState.wires.length > 0 || canvasState.junctions.length > 0;
          const created = await createConversation({
            title: importedLocalWorkspace ? "迁移的工作区" : "Circuit workspace",
            provider: selectedModelProvider,
            model: selectedModel,
            reasoning_mode: reasoningMode,
            canvas_state: canvasState,
          });
          items = [created];
        }
        if (controller.signal.aborted) return;
        setConversations(items);
        const active = items[0];
        if (!active) return;
        setActiveConversationId(active.id);
        const record = await fetchConversation(active.id, controller.signal);
        if (controller.signal.aborted) return;
        setConversationRevision(record.canvas_revision ?? 0);
        setReasoningMode(record.reasoning_mode ?? "auto");
        if (record.canvas_state && isCircuitCanvasState(record.canvas_state)) {
          setCanvasState(record.canvas_state);
        }
        if (record.events) {
          setAgentTimeline(conversationEventsToTimeline(record.events));
          const contextWindow = modelOptions.find(
            (option) => option.provider === record.provider && option.model === record.model
          )?.context_window;
          setAgentUsage(usageFromConversationEvents(record.events, contextWindow));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("Conversation persistence is unavailable; using the local workspace", error);
        }
      }
    }

    void bootstrapConversations();
    return () => controller.abort();
  }, [modelOptions, selectedModel, selectedModelProvider]);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const models = await fetchModelOptions();
        if (cancelled) return;
        setModelOptions(models.options);
        const preferred =
          models.options.find((option) => option.provider === models.default_provider && option.model === models.default_model) ??
          models.options.find((option) => option.available) ??
          models.options[0];
        if (preferred) {
          setSelectedModelProvider(preferred.provider);
          setSelectedModel(preferred.model);
        }
        setModelOptionsError(null);
      } catch (error) {
        if (!cancelled) {
          setModelOptionsError(error instanceof Error ? error.message : "Failed to load model options");
        }
      }
    }

    void loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void syncDebugMessages({
      provider: selectedModelProvider,
      model: selectedModel,
      messages: agentMessages,
    }).catch((error) => {
      console.warn("Failed to sync debug messages", error);
    });
  }, [agentMessages, selectedModel, selectedModelProvider]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName.toLowerCase();
      if (tagName === "input" || tagName === "textarea") return;

      if (event.key === "Escape") {
        setSelection(null);
        setWireDraft(null);
        setSnapTarget(null);
        setActiveId(null);
        wireEndpointDragRef.current = null;
        componentDragRef.current = null;
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selection) {
        event.preventDefault();
        void deleteSelectedObject();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, canvasState, canvasBounds]);

  useEffect(() => {
    if (!selection || selectionExists(canvasState, selection)) return;
    setSelection(null);
    setActiveId(null);
  }, [canvasState, selection]);

  useEffect(() => {
    if (!selection) return;
    setToolDockCollapsed(false);
    setToolDockTab("inspector");
    setPanelCollapsed(true);
  }, [selection]);

  const visibleCanvasBounds = useMemo(
    () => computeCanvasViewportBounds(canvasBounds, canvasViewportSize.width, canvasViewportSize.height),
    [canvasBounds, canvasViewportSize]
  );
  const viewBox = `0 0 ${visibleCanvasBounds.width} ${visibleCanvasBounds.height}`;
  const canvasWidthLabel = Math.round(canvasBounds.width);
  const canvasHeightLabel = Math.round(canvasBounds.height);
  const workspaceStyle = {
    "--sidebar-width": `${panelCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth}px`,
  } as CSSProperties;

  const validation = useMemo(() => validateCanvas(canvasState, canvasBounds), [canvasState, canvasBounds]);
  const validationMarkers = useMemo(
    () =>
      validation.issues.filter(
        (issue): issue is ValidationIssue & { point: Point } =>
          Array.isArray(issue.point) &&
          issue.point.length === 2 &&
          issue.point.every((value) => typeof value === "number" && Number.isFinite(value))
      ),
    [validation.issues]
  );
  const isBusy = isRunning || isAgentCalling;
  useEffect(() => {
    function handleKeyboardShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable);
      if (isTextInput) return;

      const key = event.key.toLowerCase();
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey) return;

      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redoCanvasEdit();
        } else {
          undoCanvasEdit();
        }
      } else if (key === "y" && event.ctrlKey) {
        event.preventDefault();
        redoCanvasEdit();
      }
    }

    window.addEventListener("keydown", handleKeyboardShortcut);
    return () => window.removeEventListener("keydown", handleKeyboardShortcut);
  }, [canvasState, historyFuture, historyPast, isBusy]);

  const totalAgentToolCalls = useMemo(
    () => agentRoundSummaries.reduce((total, round) => total + round.toolCalls, 0),
    [agentRoundSummaries]
  );
  const conversationTimelineItems = useMemo<ConversationTimelineItem[]>(
    () => toConversationTimelineItems(agentTimeline, agentStopReason !== null && lastAgentTurnStart !== null),
    [agentStopReason, agentTimeline, lastAgentTurnStart]
  );
  const conversationDockUsage = useMemo<ContextUsage | undefined>(
    () => agentUsage
      ? {
          inputTokens: agentUsage.input_tokens,
          outputTokens: agentUsage.output_tokens,
          totalTokens: agentUsage.total_tokens,
          cachedTokens: agentUsage.cached_tokens,
          reasoningTokens: agentUsage.reasoning_tokens,
          imageTokens: agentUsage.image_tokens,
          sessionTotalTokens: agentUsage.session_total_tokens,
          contextWindow: agentUsage.context_window,
        }
      : undefined,
    [agentUsage]
  );
  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.provider === selectedModelProvider && option.model === selectedModel) ?? null,
    [modelOptions, selectedModel, selectedModelProvider]
  );
  const filteredComponentLibrary = useMemo(() => {
    const normalizedQuery = normalizeSearchValue(componentQuery);
    if (!normalizedQuery) return componentLibrary;
    return componentLibrary.filter((detail) =>
      normalizeSearchValue([detail.name, detail.category, detail.requested_name, ...detail.aliases].join(" ")).includes(normalizedQuery)
    );
  }, [componentLibrary, componentQuery]);
  const wireComponentDetail = useMemo(
    () => componentLibrary.find((detail) => normalizeCacheKey(detail.name) === "wire") ?? null,
    [componentLibrary]
  );
  const pendingComponentDetail = useMemo(
    () => pendingComponentName
      ? componentLibrary.find((detail) =>
          [detail.name, detail.requested_name, ...detail.aliases]
            .some((name) => normalizeCacheKey(name) === normalizeCacheKey(pendingComponentName))
        ) ?? null
      : null,
    [componentLibrary, pendingComponentName]
  );
  const placementOrientations = useMemo<Orientation[]>(
    () => pendingComponentDetail ? getAllowedComponentOrientations(pendingComponentDetail) : ["h", "v"],
    [pendingComponentDetail]
  );
  const selectedComponent = useMemo(
    () => (selection?.kind === "component" ? canvasState.components.find((component) => component.id === selection.id) ?? null : null),
    [canvasState.components, selection]
  );
  const selectedComponentOrientations = useMemo<Orientation[]>(
    () => selectedComponent ? getAllowedComponentOrientations(selectedComponent.detail) : [],
    [selectedComponent]
  );
  const selectedWire = useMemo(
    () => (selection?.kind === "wire" ? canvasState.wires.find((wire) => wire.id === selection.id) ?? null : null),
    [canvasState.wires, selection]
  );
  const selectedJunction = useMemo(
    () => (selection?.kind === "junction" ? canvasState.junctions.find((junction) => junction.id === selection.id) ?? null : null),
    [canvasState.junctions, selection]
  );
  useEffect(() => {
    if (!pendingComponentDetail || componentSupportsOrientation(pendingComponentDetail, placementOrientation)) return;
    const fallback = getAllowedComponentOrientations(pendingComponentDetail)[0];
    if (fallback) setPlacementOrientation(fallback);
  }, [pendingComponentDetail, placementOrientation]);
  const canUndo = historyPast.length > 0 && !isBusy;
  const canRedo = historyFuture.length > 0 && !isBusy;
  const visibleConnectionPoints = useMemo(
    () =>
      canvasState.components.flatMap((component) =>
        getComponentConnectionPoints(component).map((connection, index) => ({
          ...connection,
          componentId: component.id,
          key: `${component.id}-${connection.name}-${index}`,
        }))
      ),
    [canvasState.components]
  );
  const trashActionLabel = selection ? "Delete selected" : "Clear canvas";

  function clearTimers() {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }

  function pushCanvasHistory(before: CircuitCanvasState, after: CircuitCanvasState) {
    if (canvasStatesEqual(before, after)) return;
    setHistoryPast((current) => [...current.slice(-(HISTORY_LIMIT - 1)), before]);
    setHistoryFuture([]);
  }

  function createAgentCanvasSnapshot(state: CircuitCanvasState) {
    const snapshot = createModelCanvasState(state, canvasBounds);
    const sideInsets = isNarrowWorkspace
      ? { left: 20, right: 20 }
      : {
          left: !panelCollapsed ? 460 : !toolDockCollapsed ? 440 : 24,
          right: 24,
        };
    return {
      ...snapshot,
      canvas: {
        ...snapshot.canvas,
        visible_safe_area: {
          left: sideInsets.left,
          top: 90,
          right: Math.max(sideInsets.left, Math.floor(canvasBounds.width - sideInsets.right)),
          bottom: Math.max(90, Math.floor(canvasBounds.height - 24)),
        },
      },
    };
  }

  function restoreCanvasState(state: CircuitCanvasState) {
    clearTimers();
    setCanvasState(state);
    setSelection(null);
    setWireDraft(null);
    setSnapTarget(null);
    setActiveId(null);
    setExecutionError(null);
    setIsRunning(false);
  }

  function undoCanvasEdit() {
    if (isBusy || historyPast.length === 0) return;
    const previous = historyPast[historyPast.length - 1];
    setHistoryPast((current) => current.slice(0, -1));
    setHistoryFuture((current) => [canvasState, ...current].slice(0, HISTORY_LIMIT));
    restoreCanvasState(previous);
  }

  function redoCanvasEdit() {
    if (isBusy || historyFuture.length === 0) return;
    const next = historyFuture[0];
    setHistoryFuture((current) => current.slice(1));
    setHistoryPast((current) => [...current.slice(-(HISTORY_LIMIT - 1)), canvasState]);
    restoreCanvasState(next);
  }

  function exportCanvasSvg() {
    const svg = canvasSvgRef.current;
    if (!svg || isBusy) return;

    try {
      const exportedSvg = svg.cloneNode(true) as SVGSVGElement;
      prepareSvgForExport(exportedSvg, canvasBounds);
      const serialized = new XMLSerializer().serializeToString(exportedSvg);
      const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${serialized}\n`], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `circuit-${formatExportTimestamp(new Date())}.svg`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setExecutionError(null);
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : "Failed to export SVG");
    }
  }

  function exportCanvasProject() {
    if (isBusy) return;

    try {
      const exportedAt = new Date();
      const project = {
        version: PROJECT_FILE_VERSION,
        app: "circuit-ai-workbench",
        exported_at: exportedAt.toISOString(),
        canvas_bounds: canvasBounds,
        canvas_state: canvasState,
        validation,
      };
      downloadTextFile(
        `circuit-project-${formatExportTimestamp(exportedAt)}.json`,
        JSON.stringify(project, null, 2),
        "application/json;charset=utf-8"
      );
      setExecutionError(null);
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : "Failed to export project");
    }
  }

  async function onProjectFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText) as unknown;
      const nextState = normalizeImportedProjectState(parsed);
      if (!nextState) {
        throw new Error("Project JSON does not contain a valid editable circuit canvas state.");
      }
      pushCanvasHistory(canvasState, nextState);
      clearTimers();
      setCanvasState(nextState);
      setTrace([]);
      setSelection(null);
      setWireDraft(null);
      setSnapTarget(null);
      setActiveId(null);
      setExecutionError(null);
      setIsRunning(false);
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : "Failed to import project");
    } finally {
      event.target.value = "";
    }
  }

  function runDemo() {
    void executeToolCalls(demoToolCalls);
  }

  async function runAllComponentsTest() {
    if (isBusy) return;
    setExecutionError(null);

    try {
      const catalog = await fetchComponentCatalog();
      const items = getCatalogItems(catalog);
      if (items.length === 0) {
        setExecutionError("Component catalog is empty.");
        return;
      }

      const columns = 10;
      const originX = 60;
      const originY = 90;
      const gapX = 90;
      const gapY = 90;
      const calls: CircuitToolCall[] = [
        { name: "clear_canvas" },
        { name: "get_component_detail", names: items.map((item) => item.name) },
        ...items.map((item, index) => ({
          name: "place_component" as const,
          componentName: item.name,
          origin: [originX + (index % columns) * gapX, originY + Math.floor(index / columns) * gapY] as [number, number],
          orientation: "h" as const,
          properties: {},
        })),
      ];

      void executeToolCalls(calls);
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : "Failed to run all components test");
    }
  }

  async function executeToolCalls(
    calls: CircuitToolCall[],
    options: {
      startState?: CircuitCanvasState;
      replaceTrace?: boolean;
      run?: AgentRunControl;
      allowClear?: boolean;
    } = {}
  ): Promise<ToolExecutionBatch> {
    if (calls.length === 0 || isRunning) {
      return { state: options.startState ?? canvasState, records: [] };
    }

    clearTimers();
    let nextState = options.startState ?? canvasState;
    const records: ToolExecutionRecord[] = [];
    if (options.replaceTrace ?? true) {
      setTrace([]);
    }
    setSelection(null);
    setWireDraft(null);
    setSnapTarget(null);
    setActiveId(null);
    setExecutionError(null);
    setIsRunning(true);
    const manualController = options.run ? null : new AbortController();
    if (manualController) manualToolRunRef.current = manualController;
    const executionSignal = options.run?.abortController.signal ?? manualController?.signal;

    const stepDelay = calls.length > 20 ? 25 : 320;
    const endDelay = calls.length > 20 ? 160 : 650;

    for (const [index, call] of calls.entries()) {
      if (options.run?.stopped || executionSignal?.aborted) break;
      if (index > 0) {
        await wait(stepDelay, executionSignal);
      }
      if (options.run?.stopped || executionSignal?.aborted) break;

      const result = await executeCircuitToolCall(nextState, call, {
        allowClear: options.allowClear ?? options.run?.clearAllowed ?? true,
        run: options.run,
      });
      const previousState = nextState;
      nextState = result.state;
      records.push({ call, result });
      pushCanvasHistory(previousState, result.state);
      setCanvasState(result.state);
      setActiveId(result.activeId);
      setTrace((current) => [...current, result.trace]);
      if (result.trace.action === "clear_canvas" && result.trace.status === "ok") {
        setCanvasFlashKey((current) => current + 1);
      }
    }

    if (!options.run?.stopped && !executionSignal?.aborted) {
      await wait(endDelay, executionSignal);
    }
    if (manualController && manualToolRunRef.current === manualController) {
      manualToolRunRef.current = null;
    }
    setActiveId(null);
    setIsRunning(false);
    return { state: nextState, records };
  }

  async function executeCircuitToolCall(
    state: CircuitCanvasState,
    call: CircuitToolCall,
    options: { allowClear?: boolean; run?: AgentRunControl } = {}
  ): Promise<ToolExecutionResult> {
    try {
      if (!isToolExecutionAuthorized(call.name, options.allowClear !== false)) {
        return createPolicyErrorResult(
          state,
          call,
          "CLEAR_NOT_ALLOWED",
          "clear_canvas is available only when the user explicitly asks to clear or start over"
        );
      }
      if (isComponentToolCall(call)) {
        const preflight = applyToolCall(state, call, canvasBounds);
        if (preflight.trace.status === "error" && !preflight.trace.detail.endsWith("requires async execution")) {
          return enhanceToolError(preflight, call, canvasBounds);
        }
      }

      switch (call.name) {
        case "review_canvas_visual":
          return await executeVisualReviewTool(state, call, options.run);
        case "get_component_catalog":
          return await executeComponentCatalogTool(state, call);
        case "get_component_detail":
          return await executeComponentDetailTool(state, call);
        case "place_component":
          return await executePlaceComponentTool(state, call);
        case "move_component":
          return executeMoveComponentTool(state, call);
        case "update_component_properties":
          return executeUpdateComponentPropertiesTool(state, call);
        case "remove_component":
          return executeRemoveComponentTool(state, call);
        default:
          return enhanceToolError(applyToolCall(state, call, canvasBounds), call, canvasBounds);
      }
    } catch (error) {
      const targetId = "id" in call && typeof call.id === "string" ? call.id : null;
      return {
        state,
        activeId: targetId,
        trace: {
          id: targetId ?? "component-registry",
          action: call.name,
          detail: error instanceof Error ? error.message : "tool execution failed",
          status: "error",
        },
        toolResult: {
          status: "error",
          message: error instanceof Error ? error.message : "tool execution failed",
        },
      };
    }
  }

  async function executeVisualReviewTool(
    state: CircuitCanvasState,
    call: Extract<CircuitToolCall, { name: "review_canvas_visual" }>,
    run?: AgentRunControl
  ): Promise<ToolExecutionResult> {
    if (!run || !activeConversationId) {
      return createPolicyErrorResult(
        state,
        call,
        "VISUAL_REVIEW_REQUIRES_AGENT_RUN",
        "Visual review is available only inside an Agent turn."
      );
    }
    if (run.visualReviews >= 2) {
      return createPolicyErrorResult(
        state,
        call,
        "VISUAL_REVIEW_LIMIT",
        "Visual review is limited to two screenshots per Agent turn."
      );
    }
    run.visualReviews += 1;
    const snapshot = await captureCanvasReviewFile();
    const asset = await uploadAsset(snapshot, {
      provider: selectedModelProvider,
      model: selectedModel,
      purpose: "canvas_visual_review",
      conversationId: activeConversationId,
    }, run.abortController.signal);
    const ready = ["active", "processed", "ready"].includes(asset.status);
    if (!asset.asset_id || !ready) {
      return createPolicyErrorResult(
        state,
        call,
        "VISUAL_ASSET_UNAVAILABLE",
        `Canvas screenshot upload is ${asset.status || "unavailable"}; continue with structured inspect_canvas data.`
      );
    }
    return {
      state,
      activeId: null,
      trace: {
        id: "canvas",
        action: call.name,
        detail: `visual review ${run.visualReviews}/2 uploaded`,
        status: "ok",
      },
      toolResult: {
        status: "executed",
        asset_id: asset.asset_id,
        provider_ref: asset.provider_ref,
        canvas_hash: fingerprintCanvas(state),
        review_index: run.visualReviews,
      },
    };
  }

  async function captureCanvasReviewFile(): Promise<File> {
    const source = canvasSvgRef.current;
    if (!source) throw new Error("Canvas is not ready for visual review");
    const exported = source.cloneNode(true) as SVGSVGElement;
    prepareSvgForExport(exported, canvasBounds);
    const svgBlob = new Blob([new XMLSerializer().serializeToString(exported)], {
      type: "image/svg+xml;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(svgBlob);
    try {
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(canvasBounds.width);
      canvas.height = Math.round(canvasBounds.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Browser canvas renderer is unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Canvas screenshot encoding failed")), "image/png");
      });
      return new File([png], `canvas-review-${Date.now()}.png`, { type: "image/png" });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function executeComponentCatalogTool(
    state: CircuitCanvasState,
    call: Extract<CircuitToolCall, { name: "get_component_catalog" }>
  ): Promise<ToolExecutionResult> {
    const catalog = await fetchComponentCatalog();
    const count = Array.isArray(catalog.items) ? catalog.items.length : 0;
    return {
      state,
      activeId: null,
      trace: {
        id: "component-catalog",
        action: call.name,
        detail: `${count} catalog items`,
        status: "ok",
      },
      toolResult: {
        status: "executed",
        catalog,
      },
    };
  }

  async function executeComponentDetailTool(
    state: CircuitCanvasState,
    call: Extract<CircuitToolCall, { name: "get_component_detail" }>
  ): Promise<ToolExecutionResult> {
    const details = await fetchComponentDetails(call.names);
    details.components.forEach((detail) => cacheComponentDetail(detail));
    return {
      state,
      activeId: null,
      trace: {
        id: "component-detail",
        action: call.name,
        detail: `${details.components.length}/${call.names.length} components`,
        status: details.components.length > 0 ? "ok" : "error",
      },
      toolResult: {
        status: details.components.length > 0 ? "executed" : "error",
        components: details.components,
        errors: details.errors,
      },
    };
  }

  async function executePlaceComponentTool(
    state: CircuitCanvasState,
    call: Extract<CircuitToolCall, { name: "place_component" }>
  ): Promise<ToolExecutionResult> {
    const detail = await loadComponentDetail(call.componentName);
    const generatedId = getNextCanvasObjectId(state, "component");
    const { component, error } = createComponentInstance(call, detail, generatedId);
    if (!component || error) {
      return createComponentErrorResult(state, generatedId, call.name, error ?? "component creation failed");
    }

    const nextState = {
      components: [...state.components, component],
      wires: state.wires,
      junctions: state.junctions,
    };

    return {
      state: nextState,
      activeId: component.id,
      trace: {
        id: component.id,
        action: call.name,
        detail: `${component.id} ${componentDisplayName(component)} @ [${component.origin[0]},${component.origin[1]}]`,
        status: "ok",
      },
      toolResult: {
        status: "executed",
        component: componentToolSnapshot(component),
      },
    };
  }

  function executeMoveComponentTool(
    state: CircuitCanvasState,
    call: Extract<CircuitToolCall, { name: "move_component" }>
  ): ToolExecutionResult {
    const currentIndex = state.components.findIndex((component) => component.id === call.id);
    if (currentIndex < 0) return createComponentErrorResult(state, call.id, call.name, `Rejected ${call.id}: component does not exist`);

    const updatedComponent: ComponentInstance = {
      ...state.components[currentIndex],
      origin: call.origin,
      orientation: call.orientation ?? state.components[currentIndex].orientation,
    };
    const components = state.components.map((component, index) => (index === currentIndex ? updatedComponent : component));

    const nextState = { components, wires: state.wires, junctions: state.junctions };
    return {
      state: nextState,
      activeId: call.id,
      trace: {
        id: call.id,
        action: call.name,
        detail: `${call.id} @ [${updatedComponent.origin[0]},${updatedComponent.origin[1]}]`,
        status: "ok",
      },
      toolResult: {
        status: "executed",
        component: componentToolSnapshot(updatedComponent),
      },
    };
  }

  function executeUpdateComponentPropertiesTool(
    state: CircuitCanvasState,
    call: Extract<CircuitToolCall, { name: "update_component_properties" }>
  ): ToolExecutionResult {
    const current = state.components.find((component) => component.id === call.id);
    if (!current) return createComponentErrorResult(state, call.id, call.name, `Rejected ${call.id}: component does not exist`);

    const merged = mergeComponentProperties(current.detail, { ...current.properties, ...call.properties });
    if (merged.errors.length > 0) {
      return createComponentErrorResult(state, call.id, call.name, merged.errors.join("; "));
    }

    const updatedComponent = { ...current, properties: merged.properties };
    const nextState = {
      components: state.components.map((component) => (component.id === call.id ? updatedComponent : component)),
      wires: state.wires,
      junctions: state.junctions,
    };

    return {
      state: nextState,
      activeId: call.id,
      trace: {
        id: call.id,
        action: call.name,
        detail: `${call.id} ${Object.keys(call.properties).join(", ") || "properties"}`,
        status: "ok",
      },
      toolResult: {
        status: "executed",
        component: componentToolSnapshot(updatedComponent),
      },
    };
  }

  function executeRemoveComponentTool(
    state: CircuitCanvasState,
    call: Extract<CircuitToolCall, { name: "remove_component" }>
  ): ToolExecutionResult {
    const exists = state.components.some((component) => component.id === call.id);
    if (!exists) return createComponentErrorResult(state, call.id, call.name, `Rejected ${call.id}: component does not exist`);

    const nextState = {
      components: state.components.filter((component) => component.id !== call.id),
      wires: state.wires,
      junctions: state.junctions,
    };
    return {
      state: nextState,
      activeId: null,
      trace: { id: call.id, action: call.name, detail: call.id, status: "ok" },
      toolResult: { status: "executed", id: call.id },
    };
  }

  async function loadComponentDetail(name: string): Promise<ComponentDetail> {
    const cached = componentDetailCacheRef.current.get(normalizeCacheKey(name));
    if (cached) return cached;

    const response = await fetchComponentDetails([name]);
    const detail = response.components[0];
    if (!detail) {
      throw new Error(response.errors[0] ?? `Component not found: ${name}`);
    }
    cacheComponentDetail(detail);
    return detail;
  }

  function cacheComponentDetail(detail: ComponentDetail) {
    const cache = componentDetailCacheRef.current;
    cache.set(normalizeCacheKey(detail.name), detail);
    cache.set(normalizeCacheKey(detail.requested_name), detail);
    detail.aliases.forEach((alias) => cache.set(normalizeCacheKey(alias), detail));
  }

  function resetCanvas() {
    clearTimers();
    pushCanvasHistory(canvasState, emptyCanvasState);
    setCanvasState(emptyCanvasState);
    setTrace([]);
    setActiveId(null);
    setSelection(null);
    setWireDraft(null);
    setSnapTarget(null);
    setCanvasFlashKey((current) => current + 1);
    setExecutionError(null);
    setIsRunning(false);
  }

  async function executeManualToolCall(call: CircuitToolCall, nextSelection: EditorSelection | null | undefined, stateOverride?: CircuitCanvasState) {
    if (isBusy) return;
    const previousState = stateOverride ?? canvasState;
    const result = await executeCircuitToolCall(previousState, call);
    pushCanvasHistory(previousState, result.state);
    setCanvasState(result.state);
    setActiveId(result.activeId);
    setTrace((current) => [...current, result.trace]);

    if (result.trace.status === "ok") {
      setSelection(nextSelection === undefined ? getCreatedSelection(call, result.activeId) : nextSelection);
      setExecutionError(null);
    } else {
      setExecutionError(result.trace.detail);
    }
  }

  async function placeComponentFromLibrary(componentName: string, origin: [number, number]) {
    const detail = await loadComponentDetail(componentName);
    const allowedOrientations = getAllowedComponentOrientations(detail);
    const orientation = componentSupportsOrientation(detail, placementOrientation)
      ? placementOrientation
      : allowedOrientations[0];
    if (!orientation) {
      setExecutionError(`${detail.name} has conflicting orientation flags.`);
      return;
    }
    await executeManualToolCall(
      {
        name: "place_component",
        componentName: detail.name,
        origin,
        orientation,
        properties: {},
      },
      undefined
    );
    setPendingComponentName(null);
    selectEditorMode("select");
  }

  function handleComponentLibraryDragStart(event: React.DragEvent<HTMLButtonElement>, detail: ComponentDetail) {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-circuit-component", detail.name);
    event.dataTransfer.setData("text/plain", detail.name);
    setPendingComponentName(detail.name);
  }

  function handleComponentLibraryPointerDown(event: React.PointerEvent<HTMLButtonElement>, detail: ComponentDetail) {
    if (event.button !== 0 || isBusy) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    setPendingComponentName(detail.name);

    function onPointerMove(moveEvent: PointerEvent) {
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 5) {
        moved = true;
      }
    }

    function onPointerUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (moved && clientIsInsideCanvasViewport(upEvent.clientX, upEvent.clientY)) {
        const point = getCanvasPointFromClient(upEvent.clientX, upEvent.clientY);
        if (point) {
          void placeComponentFromLibrary(detail.name, point);
          return;
        }
      }
      armComponentPlacement(detail);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  function handleCanvasDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes("application/x-circuit-component")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }

  function handleCanvasDrop(event: React.DragEvent<HTMLDivElement>) {
    const componentName = event.dataTransfer.getData("application/x-circuit-component");
    if (!componentName) return;
    event.preventDefault();
    const point = getCanvasPointFromClient(event.clientX, event.clientY);
    if (!point) return;
    void placeComponentFromLibrary(componentName, point);
  }

  function armComponentPlacement(detail: ComponentDetail) {
    const allowedOrientations = getAllowedComponentOrientations(detail);
    if (!componentSupportsOrientation(detail, placementOrientation) && allowedOrientations[0]) {
      setPlacementOrientation(allowedOrientations[0]);
    }
    setPendingComponentName(detail.name);
    selectEditorMode("select");
    setSelection(null);
    setActiveId(null);
  }

  function updateSelectedComponentOrientation(orientation: "h" | "v") {
    if (!selectedComponent) return;
    if (!componentSupportsOrientation(selectedComponent.detail, orientation)) return;
    void executeManualToolCall(
      {
        name: "move_component",
        id: selectedComponent.id,
        origin: selectedComponent.origin,
        orientation,
      },
      { kind: "component", id: selectedComponent.id }
    );
  }

  function updateSelectedComponentOriginCoordinate(axis: "x" | "y", rawValue: string) {
    if (!selectedComponent) return;
    const coordinate = normalizeCoordinateInput(
      rawValue,
      axis === "x" ? canvasBounds.width : canvasBounds.height,
      COMPONENT_GRID_SIZE
    );
    if (coordinate === null) return;
    const origin: [number, number] = [...selectedComponent.origin];
    origin[axis === "x" ? 0 : 1] = coordinate;

    void executeManualToolCall(
      {
        name: "move_component",
        id: selectedComponent.id,
        origin,
        orientation: selectedComponent.orientation,
      },
      { kind: "component", id: selectedComponent.id }
    );
  }

  function updateSelectedComponentProperty(name: string, value: string | boolean) {
    if (!selectedComponent) return;
    void executeManualToolCall(
      {
        name: "update_component_properties",
        id: selectedComponent.id,
        properties: {
          [name]: String(value),
        },
      },
      { kind: "component", id: selectedComponent.id }
    );
  }

  function updateSelectedWireCoordinate(endpoint: WireEndpoint, axis: "x" | "y", rawValue: string) {
    if (!selectedWire) return;
    const coordinate = normalizeCoordinateInput(
      rawValue,
      axis === "x" ? canvasBounds.width : canvasBounds.height,
      CONNECTION_GRID_SIZE
    );
    if (coordinate === null) return;

    const start: [number, number] = [...selectedWire.start];
    const end: [number, number] = [...selectedWire.end];
    const isHorizontal = selectedWire.start[1] === selectedWire.end[1];
    const isVertical = selectedWire.start[0] === selectedWire.end[0];

    if (isHorizontal && axis === "y") {
      start[1] = coordinate;
      end[1] = coordinate;
    } else if (isVertical && axis === "x") {
      start[0] = coordinate;
      end[0] = coordinate;
    } else {
      const target = endpoint === "start" ? start : end;
      target[axis === "x" ? 0 : 1] = coordinate;
    }

    void executeManualToolCall(
      {
        name: "update_wire_segment",
        id: selectedWire.id,
        start,
        end,
      },
      { kind: "wire", id: selectedWire.id }
    );
  }

  function updateSelectedJunctionCoordinate(axis: "x" | "y", rawValue: string) {
    if (!selectedJunction || !selectedJunction.manual) return;
    const coordinate = normalizeCoordinateInput(
      rawValue,
      axis === "x" ? canvasBounds.width : canvasBounds.height,
      CONNECTION_GRID_SIZE
    );
    if (coordinate === null) return;
    const point: [number, number] = [...selectedJunction.point];
    point[axis === "x" ? 0 : 1] = coordinate;

    void executeManualToolCall(
      {
        name: "move_junction",
        id: selectedJunction.id,
        point,
      },
      { kind: "junction", id: selectedJunction.id }
    );
  }

  function normalizeCoordinateInput(rawValue: string, max: number, step: number): number | null {
    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed)) return null;
    return snapCoordinateToGrid(parsed, max, step);
  }

  async function deleteSelectedObject() {
    if (!selection) return;

    const call =
      selection.kind === "component"
        ? ({ name: "remove_component", id: selection.id } as const)
        : selection.kind === "wire"
          ? ({ name: "delete_wire_segment", id: selection.id } as const)
          : ({ name: "remove_junction", id: selection.id } as const);

    await executeManualToolCall(call, null);
  }

  function handleTrashAction() {
    if (selection) {
      void deleteSelectedObject();
      return;
    }
    resetCanvas();
  }

  function selectEditorMode(mode: EditorMode) {
    setEditorMode(mode);
    setWireDraft(null);
    setSnapTarget(null);
    if (mode === "wire") {
      setPendingComponentName(null);
      setSelection(null);
      setActiveId(null);
    }
  }

  function handleCanvasPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (isBusy || event.button !== 0) return;
    const point = getCanvasPointFromEvent(event);
    if (!point) return;

    if (pendingComponentName && editorMode === "select") {
      void placeComponentFromLibrary(pendingComponentName, point);
      return;
    }

    if (editorMode === "wire") {
      const snapped = getSnappedCanvasPointFromClient(event.clientX, event.clientY);
      event.currentTarget.setPointerCapture(event.pointerId);
      setSelection(null);
      setActiveId(null);
      setSnapTarget(snapped.target);
      setWireDraft({ start: snapped.point, end: snapped.point, startSnap: snapped.target, endSnap: null });
      return;
    }

    const endpointHit = findSelectedWireEndpointHit(point);
    if (endpointHit) {
      const wire = canvasState.wires.find((item) => item.id === endpointHit.id);
      if (wire) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelection({ kind: "wire", id: wire.id });
        setActiveId(wire.id);
        setExecutionError(null);
        wireEndpointDragRef.current = {
          id: wire.id,
          endpoint: endpointHit.endpoint,
          baseState: canvasState,
          fixedPoint: endpointHit.endpoint === "start" ? wire.end : wire.start,
          latestPoint: endpointHit.endpoint === "start" ? wire.start : wire.end,
          moved: false,
        };
        return;
      }
    }

    const hit = findCanvasHit(point);
    setSelection(hit);
    setActiveId(hit?.id ?? null);
    setExecutionError(null);

    if (hit?.kind === "component") {
      const component = canvasState.components.find((item) => item.id === hit.id);
      if (component) {
        event.currentTarget.setPointerCapture(event.pointerId);
        componentDragRef.current = {
          id: component.id,
          baseState: canvasState,
          startPoint: point,
          startOrigin: component.origin,
          latestOrigin: component.origin,
          moved: false,
        };
      }
    } else if (hit?.kind === "wire") {
      const wire = canvasState.wires.find((item) => item.id === hit.id);
      if (wire) {
        event.currentTarget.setPointerCapture(event.pointerId);
        wireSegmentDragRef.current = {
          id: wire.id,
          baseState: canvasState,
          startPoint: point,
          startWire: wire,
          latestStart: wire.start,
          latestEnd: wire.end,
          moved: false,
        };
      }
    }
  }

  function handleCanvasPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const wireEndpointDrag = wireEndpointDragRef.current;
    if (wireEndpointDrag) {
      const snapped = getSnappedWireEndFromClient(event.clientX, event.clientY, wireEndpointDrag.fixedPoint, {
        excludeWireId: wireEndpointDrag.id,
      });
      const baseWire = wireEndpointDrag.baseState.wires.find((wire) => wire.id === wireEndpointDrag.id);
      const basePoint = baseWire ? baseWire[wireEndpointDrag.endpoint] : snapped.point;
      wireEndpointDrag.latestPoint = snapped.point;
      wireEndpointDrag.moved = wireEndpointDrag.moved || !samePoint(snapped.point, basePoint);
      setSnapTarget(snapped.target);
      setCanvasState((state) => ({
        ...state,
        wires: state.wires.map((wire) =>
          wire.id === wireEndpointDrag.id
            ? {
                ...wire,
                [wireEndpointDrag.endpoint]: snapped.point,
              }
            : wire
        ),
      }));
      return;
    }

    const wireSegmentDrag = wireSegmentDragRef.current;
    if (wireSegmentDrag) {
      const point = getCanvasPointFromEvent(event, CONNECTION_GRID_SIZE);
      if (!point) return;
      const translated = translateWireSegment(wireSegmentDrag.startWire, wireSegmentDrag.startPoint, point);
      wireSegmentDrag.latestStart = translated.start;
      wireSegmentDrag.latestEnd = translated.end;
      wireSegmentDrag.moved =
        wireSegmentDrag.moved ||
        !samePoint(translated.start, wireSegmentDrag.startWire.start) ||
        !samePoint(translated.end, wireSegmentDrag.startWire.end);

      const preview = applyToolCall(
        wireSegmentDrag.baseState,
        {
          name: "update_wire_segment",
          id: wireSegmentDrag.id,
          start: translated.start,
          end: translated.end,
        },
        canvasBounds
      );
      if (preview.trace.status === "ok") {
        setCanvasState(preview.state);
      }
      return;
    }

    const componentDrag = componentDragRef.current;
    if (componentDrag) {
      const point = getCanvasPointFromEvent(event);
      if (!point) return;
      const nextOrigin = snapPointToGrid([
        componentDrag.startOrigin[0] + point[0] - componentDrag.startPoint[0],
        componentDrag.startOrigin[1] + point[1] - componentDrag.startPoint[1],
      ]);
      componentDrag.latestOrigin = nextOrigin;
      componentDrag.moved =
        componentDrag.moved || nextOrigin[0] !== componentDrag.startOrigin[0] || nextOrigin[1] !== componentDrag.startOrigin[1];
      setCanvasState((state) => ({
        ...state,
        components: state.components.map((component) =>
          component.id === componentDrag.id ? { ...component, origin: nextOrigin } : component
        ),
      }));
      return;
    }

    if (editorMode !== "wire" || !wireDraft) return;
    const snapped = getSnappedWireEndFromClient(event.clientX, event.clientY, wireDraft.start);
    setWireDraft({
      start: wireDraft.start,
      end: snapped.point,
      startSnap: wireDraft.startSnap,
      endSnap: snapped.target,
    });
    setSnapTarget(snapped.target);
  }

  function handleCanvasPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    const wireEndpointDrag = wireEndpointDragRef.current;
    if (wireEndpointDrag) {
      wireEndpointDragRef.current = null;
      setSnapTarget(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (wireEndpointDrag.moved) {
        void executeManualToolCall(
          {
            name: "update_wire_segment",
            id: wireEndpointDrag.id,
            [wireEndpointDrag.endpoint]: wireEndpointDrag.latestPoint,
          },
          { kind: "wire", id: wireEndpointDrag.id },
          wireEndpointDrag.baseState
        );
      }
      return;
    }

    const wireSegmentDrag = wireSegmentDragRef.current;
    if (wireSegmentDrag) {
      wireSegmentDragRef.current = null;
      setSnapTarget(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (wireSegmentDrag.moved) {
        void executeManualToolCall(
          {
            name: "update_wire_segment",
            id: wireSegmentDrag.id,
            start: wireSegmentDrag.latestStart,
            end: wireSegmentDrag.latestEnd,
          },
          { kind: "wire", id: wireSegmentDrag.id },
          wireSegmentDrag.baseState
        );
      }
      return;
    }

    const componentDrag = componentDragRef.current;
    if (componentDrag) {
      componentDragRef.current = null;
      setSnapTarget(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (componentDrag.moved) {
        void executeManualToolCall(
          {
            name: "move_component",
            id: componentDrag.id,
            origin: componentDrag.latestOrigin,
          },
          { kind: "component", id: componentDrag.id },
          componentDrag.baseState
        );
      }
      return;
    }

    if (editorMode !== "wire" || !wireDraft) return;
    const snapped = getSnappedWireEndFromClient(event.clientX, event.clientY, wireDraft.start);
    const end = snapped.point ?? wireDraft.end;
    const start = wireDraft.start;
    setWireDraft(null);
    setSnapTarget(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (start[0] === end[0] && start[1] === end[1]) return;

    void executeManualToolCall(
      {
        name: "draw_wire_segment",
        start,
        end,
      },
      undefined
    );
  }

  function handleCanvasPointerCancel(event: React.PointerEvent<SVGSVGElement>) {
    setWireDraft(null);
    setSnapTarget(null);
    const wireEndpointDrag = wireEndpointDragRef.current;
    if (wireEndpointDrag) {
      setCanvasState(wireEndpointDrag.baseState);
      wireEndpointDragRef.current = null;
    }
    const wireSegmentDrag = wireSegmentDragRef.current;
    if (wireSegmentDrag) {
      setCanvasState(wireSegmentDrag.baseState);
      wireSegmentDragRef.current = null;
    }
    const componentDrag = componentDragRef.current;
    if (componentDrag) {
      setCanvasState(componentDrag.baseState);
      componentDragRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function getCanvasPointFromEvent(
    event: React.PointerEvent<SVGSVGElement>,
    step = COMPONENT_GRID_SIZE
  ): [number, number] | null {
    return getCanvasPointFromClient(event.clientX, event.clientY, step);
  }

  function getCanvasPointFromClient(
    clientX: number,
    clientY: number,
    step = COMPONENT_GRID_SIZE
  ): [number, number] | null {
    const point = getRawCanvasPointFromClient(clientX, clientY);
    return point ? snapPointToGridStep(point, canvasBounds, step) : null;
  }

  function getRawCanvasPointFromClient(clientX: number, clientY: number): [number, number] | null {
    const svg = canvasSvgRef.current;
    if (!svg) return null;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return [transformed.x, transformed.y];
  }

  function getSnappedCanvasPointFromClient(
    clientX: number,
    clientY: number,
    options: { excludeWireId?: string } = {}
  ): { point: [number, number]; target: SnapTarget | null } {
    const raw = getRawCanvasPointFromClient(clientX, clientY);
    const gridPoint = raw ? snapPointToGridStep(raw, canvasBounds, CONNECTION_GRID_SIZE) : ([0, 0] as [number, number]);
    const target = findSnapTarget(gridPoint, options);
    return { point: target?.point ?? gridPoint, target };
  }

  function getSnappedWireEndFromClient(
    clientX: number,
    clientY: number,
    start: [number, number],
    options: { excludeWireId?: string } = {}
  ): { point: [number, number]; target: SnapTarget | null } {
    const raw = getRawCanvasPointFromClient(clientX, clientY);
    const gridPoint = raw ? snapPointToGridStep(raw, canvasBounds, CONNECTION_GRID_SIZE) : start;
    const constrained = constrainWireEnd(start, gridPoint);
    const target = findSnapTarget(constrained, options);

    if (target && isAxisAlignedPoints(start, target.point)) {
      return { point: target.point, target };
    }

    return { point: constrained, target: null };
  }

  function clientIsInsideCanvasViewport(clientX: number, clientY: number) {
    const viewport = canvasViewportRef.current;
    if (!viewport) return false;
    const rect = viewport.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function snapPointToGrid(point: [number, number]): [number, number] {
    return snapPointToGridStep(point, canvasBounds, COMPONENT_GRID_SIZE);
  }

  function constrainWireEnd(start: [number, number], point: [number, number]): [number, number] {
    const dx = Math.abs(point[0] - start[0]);
    const dy = Math.abs(point[1] - start[1]);
    return dx >= dy ? [point[0], start[1]] : [start[0], point[1]];
  }

  function translateWireSegment(
    wire: WireSegment,
    startPoint: [number, number],
    currentPoint: [number, number]
  ): { start: [number, number]; end: [number, number] } {
    const minX = Math.min(wire.start[0], wire.end[0]);
    const maxX = Math.max(wire.start[0], wire.end[0]);
    const minY = Math.min(wire.start[1], wire.end[1]);
    const maxY = Math.max(wire.start[1], wire.end[1]);
    const maxGridX = Math.floor(canvasBounds.width / CONNECTION_GRID_SIZE) * CONNECTION_GRID_SIZE;
    const maxGridY = Math.floor(canvasBounds.height / CONNECTION_GRID_SIZE) * CONNECTION_GRID_SIZE;
    const dx = clamp(currentPoint[0] - startPoint[0], -minX, maxGridX - maxX);
    const dy = clamp(currentPoint[1] - startPoint[1], -minY, maxGridY - maxY);

    return {
      start: [wire.start[0] + dx, wire.start[1] + dy],
      end: [wire.end[0] + dx, wire.end[1] + dy],
    };
  }

  function findSnapTarget(point: [number, number], options: { excludeWireId?: string } = {}): SnapTarget | null {
    const candidates: Array<SnapTarget & { distance: number; priority: number }> = [];

    visibleConnectionPoints.forEach((connection) => {
      const distanceToPoint = distance(point, connection.point);
      if (distanceToPoint <= SNAP_DISTANCE) {
        candidates.push({
          kind: "component-port",
          point: connection.point,
          sourceId: connection.componentId,
          label: `${connection.componentId}.${connection.name}`,
          distance: distanceToPoint,
          priority: 0,
        });
      }
    });

    canvasState.junctions.forEach((junction) => {
      const distanceToPoint = distance(point, junction.point);
      if (distanceToPoint <= SNAP_DISTANCE) {
        candidates.push({
          kind: "junction",
          point: junction.point,
          sourceId: junction.id,
          label: junction.id,
          distance: distanceToPoint,
          priority: 1,
        });
      }
    });

    canvasState.wires.forEach((wire) => {
      if (wire.id === options.excludeWireId) return;

      (["start", "end"] as const).forEach((endpoint) => {
        const endpointPoint = wire[endpoint];
        const distanceToPoint = distance(point, endpointPoint);
        if (distanceToPoint <= SNAP_DISTANCE) {
          candidates.push({
            kind: "wire-endpoint",
            point: endpointPoint,
            sourceId: wire.id,
            label: `${wire.id}.${endpoint}`,
            distance: distanceToPoint,
            priority: 2,
          });
        }
      });

      const projected = nearestGridPointOnWire(point, wire);
      if (projected && !samePoint(projected, wire.start) && !samePoint(projected, wire.end)) {
        const distanceToPoint = distance(point, projected);
        if (distanceToPoint <= SNAP_DISTANCE) {
          candidates.push({
            kind: "wire-segment",
            point: projected,
            sourceId: wire.id,
            label: wire.id,
            distance: distanceToPoint,
            priority: 3,
          });
        }
      }
    });

    candidates.sort((a, b) => a.priority - b.priority || a.distance - b.distance);
    const target = candidates[0];
    return target
      ? {
          kind: target.kind,
          point: target.point,
          sourceId: target.sourceId,
          label: target.label,
        }
      : null;
  }

  function nearestGridPointOnWire(point: [number, number], wire: CircuitCanvasState["wires"][number]): [number, number] | null {
    if (wire.start[1] === wire.end[1]) {
      const minX = Math.min(wire.start[0], wire.end[0]);
      const maxX = Math.max(wire.start[0], wire.end[0]);
      const x = clamp(Math.round(point[0] / CONNECTION_GRID_SIZE) * CONNECTION_GRID_SIZE, minX, maxX);
      return [x, wire.start[1]];
    }

    if (wire.start[0] === wire.end[0]) {
      const minY = Math.min(wire.start[1], wire.end[1]);
      const maxY = Math.max(wire.start[1], wire.end[1]);
      const y = clamp(Math.round(point[1] / CONNECTION_GRID_SIZE) * CONNECTION_GRID_SIZE, minY, maxY);
      return [wire.start[0], y];
    }

    return null;
  }

  function findSelectedWireEndpointHit(point: [number, number]): { id: string; endpoint: WireEndpoint } | null {
    if (!selectedWire) return null;
    if (distance(point, selectedWire.start) <= WIRE_ENDPOINT_HIT_DISTANCE) return { id: selectedWire.id, endpoint: "start" };
    if (distance(point, selectedWire.end) <= WIRE_ENDPOINT_HIT_DISTANCE) return { id: selectedWire.id, endpoint: "end" };
    return null;
  }

  function findCanvasHit(point: [number, number]): EditorSelection | null {
    for (const junction of [...canvasState.junctions].reverse()) {
      if (distance(point, junction.point) <= 8) {
        return { kind: "junction", id: junction.id };
      }
    }

    for (const component of [...canvasState.components].reverse()) {
      const bounds = getComponentBounds(component);
      if (point[0] >= bounds.x - 8 && point[0] <= bounds.x + bounds.width + 8 && point[1] >= bounds.y - 8 && point[1] <= bounds.y + bounds.height + 8) {
        return { kind: "component", id: component.id };
      }
    }

    for (const wire of [...canvasState.wires].reverse()) {
      if (pointIsNearWire(point, wire)) {
        return { kind: "wire", id: wire.id };
      }
    }

    return null;
  }

  function pointIsNearWire(point: [number, number], wire: CircuitCanvasState["wires"][number]) {
    const tolerance = 7;
    const minX = Math.min(wire.start[0], wire.end[0]) - tolerance;
    const maxX = Math.max(wire.start[0], wire.end[0]) + tolerance;
    const minY = Math.min(wire.start[1], wire.end[1]) - tolerance;
    const maxY = Math.max(wire.start[1], wire.end[1]) + tolerance;

    if (wire.start[1] === wire.end[1]) {
      return point[0] >= minX && point[0] <= maxX && Math.abs(point[1] - wire.start[1]) <= tolerance;
    }

    if (wire.start[0] === wire.end[0]) {
      return point[1] >= minY && point[1] <= maxY && Math.abs(point[0] - wire.start[0]) <= tolerance;
    }

    return false;
  }

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (panelCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setIsResizingSidebar(true);

    function onPointerMove(moveEvent: PointerEvent) {
      const nextWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(Math.round(nextWidth));
    }

    function onPointerUp() {
      setIsResizingSidebar(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  function handleModelChange(value: string) {
    const [provider, model] = value.split(":", 2);
    const option = modelOptions.find((item) => item.provider === provider && item.model === model);
    if (!option) return;
    const nextReasoningMode = option.reasoning_modes?.includes(reasoningMode) === false ? "auto" : reasoningMode;
    setSelectedModelProvider(option.provider);
    setSelectedModel(option.model);
    if (nextReasoningMode !== reasoningMode) setReasoningMode(nextReasoningMode);
    if (activeConversationId) {
      void updateConversation(activeConversationId, {
        provider: option.provider,
        model: option.model,
        reasoning_mode: nextReasoningMode,
      })
        .then((record) => {
          setConversations((items) => items.map((item) => (item.id === record.id ? record : item)));
        })
        .catch((error) => console.warn("Failed to update conversation model", error));
    }
  }

  function handleReasoningModeChange(mode: ReasoningMode) {
    setReasoningMode(mode);
    if (!activeConversationId) return;
    void updateConversation(activeConversationId, { reasoning_mode: mode })
      .then((record) => {
        setConversations((items) => items.map((item) => (item.id === record.id ? record : item)));
      })
      .catch((error) => console.warn("Failed to update reasoning mode", error));
  }

  async function createNewConversation() {
    if (isBusy) return;
    try {
      const created = await createConversation({
        title: `Circuit ${conversations.length + 1}`,
        provider: selectedModelProvider,
        model: selectedModel,
        reasoning_mode: reasoningMode,
        canvas_state: emptyCanvasState,
      });
      setConversations((items) => [created, ...items]);
      setActiveConversationId(created.id);
      setConversationRevision(created.canvas_revision ?? 0);
      setAgentMessages([]);
      setAgentTimeline([]);
      setAgentUsage(undefined);
      pushCanvasHistory(canvasState, emptyCanvasState);
      restoreCanvasState(emptyCanvasState);
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : "Failed to create conversation");
    }
  }

  async function switchConversation(id: string) {
    if (isBusy || id === activeConversationId) return;
    try {
      const record = await fetchConversation(id);
      setActiveConversationId(id);
      setConversationRevision(record.canvas_revision ?? 0);
      setReasoningMode(record.reasoning_mode ?? "auto");
      setSelectedModelProvider(record.provider === "doubao" ? "doubao" : "bailian");
      setSelectedModel(record.model);
      setAgentMessages([]);
      setAgentTimeline(conversationEventsToTimeline(record.events ?? []));
      setAgentUsage(usageFromConversationEvents(
        record.events ?? [],
        modelOptions.find((option) => option.provider === record.provider && option.model === record.model)?.context_window
      ));
      if (record.canvas_state && isCircuitCanvasState(record.canvas_state)) {
        restoreCanvasState(record.canvas_state);
      }
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : "Failed to switch conversation");
    }
  }

  async function handleSubmit() {
    if (isBusy) return;
    const trimmed = input.trim();
    if (!trimmed) {
      runDemo();
      return;
    }

    if (looksLikeJson(trimmed)) {
      const parsed = parseToolCalls(trimmed);
      if (parsed.error) {
        setExecutionError(parsed.error);
        return;
      }

      setInput("");
      void executeToolCalls(parsed.calls);
      return;
    }

    await askAgent(trimmed);
  }

  async function askAgent(message: string) {
    const run: AgentRunControl = {
      id: ++agentRunSequenceRef.current,
      abortController: new AbortController(),
      stopped: false,
      stopReason: null,
      startState: canvasState,
      toolCalls: 0,
      repairCycles: 0,
      visualReviews: 0,
      stalledRounds: 0,
      previousCanvasFingerprint: fingerprintCanvas(canvasState),
      previousIssueFingerprint: fingerprintIssues(validateCanvas(canvasState, canvasBounds).issues),
      repeatedIssueRounds: 0,
      clearAllowed: hasExplicitClearIntent(message),
    };
    agentRunRef.current?.abortController.abort();
    agentRunRef.current = run;
    setLastAgentTurnStart(canvasState);
    setExecutionError(null);
    setIsAgentCalling(true);
    setAgentLoopStatus("running");
    setAgentStopReason(null);
    setAgentRoundSummaries([]);
    setTrace([]);
    appendTimeline({
      id: `run-${run.id}-user`,
      kind: "user",
      text: message,
      createdAt: new Date().toISOString(),
    });

    let lastCanvasState = canvasState;
    let turnCanvasRevision = conversationRevision;
    let persistedCanvasFingerprint = fingerprintCanvas(canvasState);
    const streamedTimelineContent = new Set<string>();

    function handleTurnStreamEvent(event: TurnStreamEvent) {
      const payload = event.data.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const text = (payload as Record<string, unknown>).text;
      if (typeof text !== "string" || !text.trim()) return;
      if (event.event !== "reasoning.summary.delta" && event.event !== "assistant.text.delta") return;
      const kind = event.event === "reasoning.summary.delta" ? "reasoning" : "assistant";
      const normalized = text.trim();
      streamedTimelineContent.add(`${kind}:${normalized}`);
      appendTimeline({
        id: `run-${run.id}-stream-${String(event.data.id ?? streamedTimelineContent.size)}`,
        kind,
        text: normalized,
        createdAt: typeof event.data.created_at === "string" ? event.data.created_at : new Date().toISOString(),
      });
    }

    try {
      let loopMessages = agentMessages;
      let loopCanvasState = canvasState;
      let finalMessages = agentMessages;
      let pendingToolOutputs: Array<{ tool_call_id: string; content: string }> = [];
      let pendingVisualAssetIds: string[] = [];
      let previousTurnUsageTotal = 0;
      let reasoningDegradationShown = false;
      let completed = false;

      for (let round = 0; round < AGENT_MAX_MODEL_ROUNDS; round += 1) {
        if (!isActiveRun(run)) break;
        const isFirstRound = round === 0;
        let data: AgentResponse;
        if (activeConversationId) {
          if (isFirstRound) {
            run.turnId = createClientTurnId();
            data = await startConversationTurn(
              activeConversationId,
              {
                turn_id: run.turnId,
                message,
                require_tool: true,
                prefer_responses: true,
                model_provider: selectedModelProvider,
                model: selectedModel,
                reasoning_mode: reasoningMode,
                model_canvas_state: createAgentCanvasSnapshot(loopCanvasState),
                canvas_state: loopCanvasState,
                canvas_bounds: canvasBounds,
                asset_id: uploadedImage?.asset_id,
                image: uploadedImage?.asset_id ? undefined : uploadedImage,
              },
              run.abortController.signal,
              handleTurnStreamEvent
            );
            run.turnId = data.turn_id ?? run.turnId;
          } else {
            if (!run.turnId) throw new Error("Conversation turn id is missing");
            data = await continueConversationTurn(
              run.turnId,
              {
                tool_outputs: pendingToolOutputs,
                visual_asset_ids: pendingVisualAssetIds,
                canvas_state: loopCanvasState,
                require_tool: false,
              },
              run.abortController.signal,
              handleTurnStreamEvent
            );
            turnCanvasRevision = data.canvas_revision ?? turnCanvasRevision + 1;
            persistedCanvasFingerprint = fingerprintCanvas(loopCanvasState);
            setConversationRevision(turnCanvasRevision);
          }
        } else {
          const response = await fetch("/api/circuit-agent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: isFirstRound ? message : "",
              append_user_message: isFirstRound,
              require_tool: isFirstRound,
              messages: loopMessages,
              canvas_state: createAgentCanvasSnapshot(loopCanvasState),
              canvas_bounds: canvasBounds,
              image: isFirstRound ? imageForAgentRequest(uploadedImage) : null,
              model_provider: selectedModelProvider,
              model: selectedModel,
              reasoning_mode: reasoningMode,
              clear_allowed: run.clearAllowed,
            }),
            signal: run.abortController.signal,
          });
          data = await readJsonResponse<AgentResponse>(response, "Agent request");
        }
        if (!isActiveRun(run)) break;

        if (data.status === "stopped") {
          stopAgentRun(run, stopReasonFromProvider(data.stop_reason), "任务已在服务端停止，当前画布已保留。");
          break;
        }
        if (data.reasoning_degraded && !reasoningDegradationShown) {
          reasoningDegradationShown = true;
          appendTimeline({
            id: `run-${run.id}-reasoning-degraded`,
            kind: "status",
            text: "当前模型不支持所选思考参数，已自动降级为模型默认模式。",
            createdAt: new Date().toISOString(),
          });
        }

        const openAiToolCalls = data.tool_calls ?? [];
        const nextMessages = data.messages?.length
          ? data.messages
          : data.assistant_message
            ? [...loopMessages, data.assistant_message]
            : loopMessages;
        const normalizedUsage = normalizeUsage(data.usage);
        const usage = normalizedUsage
          ? {
              ...normalizedUsage,
              context_window: normalizedUsage.context_window ?? selectedModelOption?.context_window,
            }
          : undefined;
        if (usage) {
          const sessionContribution = activeConversationId
            ? Math.max(0, usage.total_tokens - previousTurnUsageTotal)
            : usage.total_tokens;
          previousTurnUsageTotal = usage.total_tokens;
          setAgentUsage((current) => ({
            ...usage,
            session_total_tokens:
              usage.session_total_tokens ?? (current?.session_total_tokens ?? 0) + sessionContribution,
          }));
        }
        if (
          data.reasoning_summary?.trim() &&
          !streamedTimelineContent.has(`reasoning:${data.reasoning_summary.trim()}`)
        ) {
          appendTimeline({
            id: `run-${run.id}-reasoning-${round}`,
            kind: "reasoning",
            text: data.reasoning_summary.trim(),
            createdAt: new Date().toISOString(),
          });
        }
        const assistantText = getLatestAssistantText(nextMessages);
        if (assistantText && !streamedTimelineContent.has(`assistant:${assistantText}`)) {
          appendTimeline({
            id: `run-${run.id}-assistant-${round}`,
            kind: "assistant",
            text: assistantText,
            createdAt: new Date().toISOString(),
          });
        }
        if (typeof data.clear_allowed === "boolean") {
          run.clearAllowed = run.clearAllowed && data.clear_allowed;
        }
        const roundSummary: AgentRoundSummary = {
          round: round + 1,
          toolCalls: openAiToolCalls.length,
          status: openAiToolCalls.length === 0 ? "final" : "tool_calls",
          model: data.model,
          enableThinking: data.enable_thinking,
          usage,
        };
        setAgentRoundSummaries((current) => [...current, roundSummary]);
        setAgentMessages(nextMessages);

        if (openAiToolCalls.length === 0) {
          finalMessages = nextMessages;
          setAgentLoopStatus("complete");
          appendTimeline({
            id: `run-${run.id}-complete`,
            kind: "status",
            text: "任务已完成",
            createdAt: new Date().toISOString(),
          });
          completed = true;
          break;
        }

        if (run.toolCalls + openAiToolCalls.length > AGENT_MAX_TOOL_CALLS) {
          stopAgentRun(run, "tool_limit", `工具调用达到 ${AGENT_MAX_TOOL_CALLS} 次上限，已保留当前画布。`);
          break;
        }

        const parsed = parseToolCalls(JSON.stringify(openAiToolCalls));
        if (parsed.error) {
          throw new Error(parsed.error);
        }

        const validationBeforeBatch = validateCanvas(loopCanvasState, canvasBounds);
        const hasMutatingCalls = parsed.calls.some(isCanvasMutatingToolCall);
        const isRepairAttempt = hasMutatingCalls && validationBeforeBatch.issues.length > 0;
        if (isRepairAttempt && run.repairCycles >= AGENT_MAX_REPAIR_CYCLES) {
          stopAgentRun(run, "repair_budget", `自检修复已达到 ${AGENT_MAX_REPAIR_CYCLES} 轮，已停止自动重试。`);
          break;
        }
        if (isRepairAttempt) run.repairCycles += 1;

        const batch = await executeToolCalls(parsed.calls, {
          startState: loopCanvasState,
          replaceTrace: false,
          run,
          allowClear: run.clearAllowed,
        });
        run.toolCalls += batch.records.length;
        loopCanvasState = batch.state;
        lastCanvasState = batch.state;

        batch.records.forEach(({ call, result }, index) => {
          appendTimeline({
            id: `run-${run.id}-tool-${round}-${index}`,
            kind: "tool",
            text: result.trace.detail,
            toolName: call.name,
            toolStatus: result.trace.status === "ok" ? "ok" : "error",
            targetId: result.activeId ?? undefined,
            createdAt: new Date().toISOString(),
          });
        });

        if (!isActiveRun(run)) break;

        const validationAfterBatch = validateCanvas(loopCanvasState, canvasBounds);
        const canvasFingerprint = fingerprintCanvas(loopCanvasState);
        const issueFingerprint = fingerprintIssues(validationAfterBatch.issues);
        const unchanged =
          canvasFingerprint === run.previousCanvasFingerprint &&
          issueFingerprint === run.previousIssueFingerprint;
        if (hasMutatingCalls) {
          run.stalledRounds = unchanged ? run.stalledRounds + 1 : 0;
          run.repeatedIssueRounds =
            validationAfterBatch.issues.length > 0 && issueFingerprint === run.previousIssueFingerprint
              ? run.repeatedIssueRounds + 1
              : 0;
        }
        run.previousCanvasFingerprint = canvasFingerprint;
        run.previousIssueFingerprint = issueFingerprint;

        if (run.stalledRounds >= AGENT_MAX_STALLED_ROUNDS) {
          stopAgentRun(run, "no_progress", "连续两轮画布与校验问题均无变化，已停止以避免无限循环。");
          break;
        }
        if (run.repeatedIssueRounds >= AGENT_MAX_REPAIR_CYCLES) {
          stopAgentRun(run, "repair_budget", "同一组校验问题连续三轮未减少，已停止自动修复。");
          break;
        }

        const toolResultMessages = buildToolResultMessages(
          openAiToolCalls,
          batch.records,
          loopCanvasState,
          canvasBounds
        );
        pendingToolOutputs = toolResultMessages.map((toolMessage, index) => ({
          tool_call_id: toolMessage.tool_call_id ?? openAiToolCalls[index]?.id ?? `call_${index + 1}`,
          content: typeof toolMessage.content === "string" ? toolMessage.content : JSON.stringify(toolMessage.content ?? {}),
        }));
        pendingVisualAssetIds = batch.records
          .map((record) => getVisualAssetId(record.result.toolResult))
          .filter((assetId): assetId is string => Boolean(assetId));
        loopMessages = [...nextMessages, ...toolResultMessages];
        finalMessages = loopMessages;
        setAgentMessages(loopMessages);

        if (round === AGENT_MAX_MODEL_ROUNDS - 1) {
          stopAgentRun(run, "round_limit", `模型步骤达到 ${AGENT_MAX_MODEL_ROUNDS} 轮上限，已保留当前画布。`);
        }
      }

      setAgentMessages(finalMessages);
      setInput("");
      if (!completed && !run.stopped && isActiveRun(run)) {
        stopAgentRun(run, "round_limit", `模型步骤达到 ${AGENT_MAX_MODEL_ROUNDS} 轮上限，已保留当前画布。`);
      }
    } catch (error) {
      if (run.stopped || isAbortError(error)) {
        setAgentLoopStatus("stopped");
      } else {
        const messageText = error instanceof Error ? error.message : "Agent request failed";
        run.stopReason = "model_error";
        setAgentStopReason("model_error");
        setAgentLoopStatus("error");
        setExecutionError(messageText);
        appendTimeline({
          id: `run-${run.id}-error`,
          kind: "error",
          text: messageText,
          createdAt: new Date().toISOString(),
        });
      }
    } finally {
      if (agentRunRef.current?.id === run.id) {
        if (
          activeConversationId &&
          fingerprintCanvas(lastCanvasState) !== persistedCanvasFingerprint
        ) {
          void saveConversationCanvas(activeConversationId, {
            canvas_state: lastCanvasState,
            canvas_bounds: canvasBounds,
          })
            .then(setConversationRevision)
            .catch((error) => console.warn("Failed to persist final agent canvas", error));
        }
        setIsAgentCalling(false);
        setIsRunning(false);
        agentRunRef.current = null;
      }
    }
  }

  function isActiveRun(run: AgentRunControl) {
    return isRunResponseCurrent({
      runId: run.id,
      activeRunId: agentRunRef.current?.id,
      stopped: run.stopped,
      aborted: run.abortController.signal.aborted,
    });
  }

  function stopAgentRun(run: AgentRunControl, reason: AgentStopReason, message: string) {
    if (run.stopped) return;
    run.stopped = true;
    run.stopReason = reason;
    if (run.turnId) {
      void cancelConversationTurn(run.turnId).catch((error) => {
        if (!isAbortError(error)) console.warn("Failed to cancel server turn", error);
      });
    }
    run.abortController.abort();
    setAgentStopReason(reason);
    setAgentLoopStatus("stopped");
    setExecutionError(message);
    setIsRunning(false);
    appendTimeline({
      id: `run-${run.id}-stopped-${reason}`,
      kind: "status",
      text: message,
      createdAt: new Date().toISOString(),
    });
  }

  function handleStopAgent() {
    const run = agentRunRef.current;
    if (run) {
      stopAgentRun(run, "user", "已手动停止，已完成的画布修改会被保留。");
      return;
    }
    if (manualToolRunRef.current) {
      manualToolRunRef.current.abort();
      manualToolRunRef.current = null;
      clearTimers();
      setIsRunning(false);
      setExecutionError("已手动停止，已完成的画布修改会被保留。");
    }
  }

  function undoLastAgentTurn() {
    if (!lastAgentTurnStart || isBusy) return;
    pushCanvasHistory(canvasState, lastAgentTurnStart);
    restoreCanvasState(lastAgentTurnStart);
    setLastAgentTurnStart(null);
    setAgentStopReason(null);
  }

  function appendTimeline(item: AgentTimelineItem) {
    setAgentTimeline((current) => {
      if (current.some((entry) => entry.id === item.id)) return current;
      return [...current, item];
    });
  }

  function selectTimelineToolEvent(event: ToolTimelineEvent) {
    if (!event.targetId) return;
    const targetId = event.targetId;
    const nextSelection = canvasState.components.some((item) => item.id === targetId)
      ? ({ kind: "component", id: targetId } as const)
      : canvasState.wires.some((item) => item.id === targetId)
        ? ({ kind: "wire", id: targetId } as const)
        : canvasState.junctions.some((item) => item.id === targetId)
          ? ({ kind: "junction", id: targetId } as const)
          : null;
    setSelection(nextSelection);
    setActiveId(targetId);
  }

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const image = await readImageFile(file);
      let uploaded = image;
      try {
        const asset = await uploadAsset(file, {
          provider: selectedModelProvider,
          model: selectedModel,
          purpose: "user_image",
          conversationId: activeConversationId,
        });
        uploaded = {
          ...image,
          asset_id: asset.asset_id,
          provider_ref: asset.provider_ref,
          expires_at: asset.expires_at,
        };
      } catch (uploadError) {
        console.warn("Provider asset upload unavailable; using one-shot image fallback", uploadError);
      }
      setUploadedImage(uploaded);
      setImageName(uploaded.name);
      setExecutionError(null);
    } catch (error) {
      setUploadedImage(null);
      setImageName("");
      setExecutionError(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      event.target.value = "";
    }
  }

  function handleConversationDockCollapse(collapsed: boolean) {
    setPanelCollapsed(collapsed);
    if (!collapsed) setToolDockCollapsed(true);
  }

  function toggleToolDock() {
    setToolDockCollapsed((current) => {
      const next = !current;
      if (!next) setPanelCollapsed(true);
      return next;
    });
  }

  return (
    <main
      className={[
        "workspace",
        "cw-workspace-shell",
        panelCollapsed ? "sidebarCollapsed" : "",
        !panelCollapsed || !toolDockCollapsed ? "workspaceDockExpanded" : "",
        !panelCollapsed ? "agentDockExpanded" : "",
        !toolDockCollapsed ? "toolDockExpanded" : "",
        isResizingSidebar ? "resizingSidebar" : "",
      ].join(" ")}
      style={workspaceStyle}
    >
      <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChange} hidden />
      <nav className="cw-workspace-dock-rail" aria-label="Workspace panels">
        <button
          type="button"
          className={!panelCollapsed ? "is-active" : ""}
          onClick={() => handleConversationDockCollapse(!panelCollapsed)}
          aria-label={panelCollapsed ? "Open agent conversation" : "Close agent conversation"}
          aria-expanded={!panelCollapsed}
          title="Agent conversation"
        >
          <Sparkles size={18} aria-hidden="true" />
          <span className="cw-sr-only">Agent conversation</span>
        </button>
        <button
          type="button"
          className={!toolDockCollapsed ? "is-active" : ""}
          onClick={toggleToolDock}
          aria-label={toolDockCollapsed ? "Open component tools" : "Close component tools"}
          aria-expanded={!toolDockCollapsed}
          title="Components and inspector"
        >
          {toolDockTab === "inspector" ? (
            <SlidersHorizontal size={18} aria-hidden="true" />
          ) : (
            <Library size={18} aria-hidden="true" />
          )}
          <span className="cw-sr-only">Components and inspector</span>
        </button>
      </nav>
      <ConversationDock
        conversations={conversations.map((conversation) => ({ id: conversation.id, title: conversation.title }))}
        activeConversationId={activeConversationId}
        onConversationChange={(id) => void switchConversation(id)}
        onCreateConversation={() => void createNewConversation()}
        items={conversationTimelineItems}
        value={input}
        onValueChange={setInput}
        onSubmit={() => void handleSubmit()}
        onStop={handleStopAgent}
        running={isAgentCalling || isRunning}
        reasoningMode={reasoningMode}
        reasoningModes={[
          {
            value: "fast",
            label: "快速",
            description: "减少推理延迟",
            disabled: selectedModelOption?.reasoning_modes?.includes("fast") === false,
          },
          {
            value: "auto",
            label: "自动",
            description: "由模型按任务复杂度决定",
            disabled: selectedModelOption?.reasoning_modes?.includes("auto") === false,
          },
          {
            value: "deep",
            label: "深入",
            description: "使用更高推理预算",
            disabled: selectedModelOption?.reasoning_modes?.includes("deep") === false,
          },
        ]}
        onReasoningModeChange={(mode) => handleReasoningModeChange(mode as ReasoningMode)}
        usage={conversationDockUsage}
        attachment={uploadedImage
          ? {
              id: uploadedImage.asset_id ?? uploadedImage.name,
              name: uploadedImage.name,
              previewUrl: uploadedImage.data_url,
              metadata: `${uploadedImage.width}×${uploadedImage.height}`,
            }
          : null}
        onAttach={() => fileInputRef.current?.click()}
        onRemoveAttachment={() => {
          setUploadedImage(null);
          setImageName("");
        }}
        collapsed={panelCollapsed}
        showCollapsedTrigger={false}
        onCollapsedChange={handleConversationDockCollapse}
        onToolEventSelect={selectTimelineToolEvent}
        onStatusAction={() => undoLastAgentTurn()}
        emptyState={<p>描述要生成的电路，或直接要求修改当前画布。</p>}
        headerSlot={
          <div className="cw-agent-settings">
            <label>
              <span>模型</span>
              <select
                value={`${selectedModelProvider}:${selectedModel}`}
                onChange={(event) => handleModelChange(event.target.value)}
                aria-label="Agent model"
                disabled={isBusy}
              >
                {modelOptions.map((option) => (
                  <option key={`${option.provider}:${option.model}`} value={`${option.provider}:${option.model}`}>
                    {option.label}{option.available ? "" : "（缺少 Key）"}
                  </option>
                ))}
              </select>
            </label>
            <span className={`cw-run-state is-${agentLoopStatus}`}>
              {agentLoopStatus === "running" ? `第 ${agentRoundSummaries.length + 1} 步` : agentLoopStatus}
            </span>
            {executionError && <div className="cw-inline-error">{executionError}</div>}
            {agentStopReason && lastAgentTurnStart && (
              <button type="button" className="cw-undo-turn" onClick={undoLastAgentTurn} disabled={isBusy}>
                撤销本轮
              </button>
            )}
          </div>
        }
      />
      <section className={panelCollapsed ? "agentPanel collapsed" : "agentPanel"}>
        <header className="agentHeader">
          <div className="agentTitle">
            <Sparkles size={17} />
            <span>Circuit Agent Studio</span>
          </div>
          <button
            type="button"
            className="iconButton subtle"
            onClick={() => setPanelCollapsed((value) => !value)}
            aria-label={panelCollapsed ? "Expand agent panel" : "Collapse agent panel"}
          >
            {panelCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
          </button>
        </header>

        {!panelCollapsed && (
          <>
            <div
              className="sidebarResizeHandle"
              onPointerDown={startSidebarResize}
              role="separator"
              aria-label="Resize agent panel"
              aria-orientation="vertical"
            />
            <nav className="agentTabs" aria-label="Agent panel views">
              <button
                type="button"
                className={activeAgentTab === "chat" ? "agentTab active" : "agentTab"}
                onClick={() => setActiveAgentTab("chat")}
              >
                Chat
              </button>
              <button
                type="button"
                className={activeAgentTab === "trace" ? "agentTab active" : "agentTab"}
                onClick={() => setActiveAgentTab("trace")}
              >
                Trace
              </button>
              <button
                type="button"
                className={debugMode ? "debugSwitch active" : "debugSwitch"}
                onClick={() => setDebugMode((value) => !value)}
              >
                Debug
              </button>
            </nav>

            <div className="agentBody">
              {activeAgentTab === "chat" && (
                <>
                  <div className="modelPickerPanel">
                    <div className="modelPickerHeader">
                      <span>Model</span>
                      <code>{selectedModelOption?.provider_name ?? selectedModelProvider}</code>
                    </div>
                    <select
                      value={`${selectedModelProvider}:${selectedModel}`}
                      onChange={(event) => handleModelChange(event.target.value)}
                      aria-label="Agent model"
                    >
                      {modelOptions.map((option) => (
                        <option key={`${option.provider}:${option.model}`} value={`${option.provider}:${option.model}`}>
                          {option.label}
                          {option.available ? "" : " (missing key)"}
                        </option>
                      ))}
                    </select>
                    {modelOptionsError && <div className="modelPickerNote error">{modelOptionsError}</div>}
                    {selectedModelOption && selectedModelOption.missing_env.length > 0 && (
                      <div className="modelPickerNote">Missing env: {selectedModelOption.missing_env.join(" or ")}</div>
                    )}
                  </div>

                  <div className="loopStatusPanel">
                    <div className="loopStatusHeader">
                      <span>Tool loop</span>
                      <code>{agentLoopStatus}</code>
                    </div>
                    <div className="loopStatusStats">
                      <span>{agentRoundSummaries.length}/{AGENT_MAX_MODEL_ROUNDS} rounds</span>
                      <span>{totalAgentToolCalls} tool calls</span>
                      <span>{isAgentCalling ? "calling" : isRunning ? "drawing" : "idle"}</span>
                    </div>
                    {agentRoundSummaries.length > 0 && (
                      <div className="loopRoundList">
                        {agentRoundSummaries.slice(-6).map((round) => (
                          <div key={round.round}>
                            <span>#{round.round}</span>
                            <code>{round.toolCalls} calls</code>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {uploadedImage && (
                    <div className="imageChip" title={imageName}>
                      <img src={uploadedImage.data_url} alt="" />
                      <span>{imageName}</span>
                      <code>
                        {uploadedImage.width}x{uploadedImage.height}
                      </code>
                    </div>
                  )}
                  {executionError && <div className="errorBanner">{executionError}</div>}
                  {validation.issues.length > 0 && (
                    <div className="issueList">
                      {validation.issues.slice(0, 4).map((issue, index) => (
                        <div key={`${issue.id}-${index}`}>{issue.message}</div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {activeAgentTab === "trace" && (
                <div className="traceList">
                  {trace.length === 0 ? (
                    <div className="emptyTrace">等待绘制动作</div>
                  ) : (
                    trace.map((item, index) => (
                      <div
                        key={`${item.action}-${item.id}-${index}`}
                        className={[
                          "traceItem",
                          activeId === item.id ? "active" : "",
                          item.status === "error" ? "error" : "",
                        ].join(" ")}
                      >
                        <span>{item.action}</span>
                        <code>{item.detail}</code>
                      </div>
                    ))
                  )}
                </div>
              )}

            </div>

            <footer className="agentComposer">
              <div className="composerShell">
                <button
                  type="button"
                  className="composerAttachButton"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Upload image"
                >
                  <ImagePlus size={18} />
                </button>
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  aria-label="Agent message"
                  placeholder=""
                  rows={1}
                />
                <button type="button" className="composerSendButton" onClick={handleSubmit} disabled={isBusy} aria-label="Send">
                  <Send size={18} />
                </button>
              </div>
            </footer>
          </>
        )}
      </section>

      <section className="canvasWorkspace" aria-label="Circuit canvas workspace">
        <header className="canvasToolbar">
          <div className="canvasToolbarTitle">
            <span>Circuit Canvas</span>
            <code>{canvasWidthLabel}x{canvasHeightLabel} grid</code>
            {lastSavedAt && <em>saved {lastSavedAt}</em>}
          </div>

          <div className="canvasToolbarStats" aria-label="Canvas status">
            <span>{canvasState.components.length} components</span>
            <span>{canvasState.wires.length} wires</span>
            <span>{canvasState.junctions.length} junctions</span>
            <span>{validation.status === "valid" ? "valid" : `${validation.issues.length} issues`}</span>
          </div>

          <div className="canvasToolbarActions" aria-label="Canvas controls">
            <input
              ref={projectFileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={onProjectFileChange}
              hidden
            />
            <button
              type="button"
              className="iconButton"
              onClick={undoCanvasEdit}
              disabled={!canUndo}
              aria-label="Undo"
              title="Undo"
            >
              <Undo2 size={18} />
            </button>
            <button
              type="button"
              className="iconButton"
              onClick={redoCanvasEdit}
              disabled={!canRedo}
              aria-label="Redo"
              title="Redo"
            >
              <Redo2 size={18} />
            </button>
            <span className="toolbarDivider" />
            <button
              type="button"
              className={editorMode === "select" ? "iconButton activeTool" : "iconButton"}
              onClick={() => selectEditorMode("select")}
              aria-label="Select tool"
              title="Select tool"
            >
              <MousePointer2 size={18} />
            </button>
            <button
              type="button"
              className={editorMode === "wire" ? "iconButton activeTool" : "iconButton"}
              onClick={() => selectEditorMode("wire")}
              aria-label="Wire tool"
              title="Wire tool"
            >
              <Cable size={18} />
            </button>
            <span className="toolbarDivider" />
            <details className="cw-toolbar-overflow">
              <summary aria-label="More canvas actions" title="More canvas actions">
                <MoreHorizontal size={19} aria-hidden="true" />
              </summary>
              <div className="cw-toolbar-overflow-menu">
                <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); runDemo(); }} disabled={isBusy}>
                  <Play size={16} aria-hidden="true" /><span>Run demo</span>
                </button>
                <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); projectFileInputRef.current?.click(); }} disabled={isBusy}>
                  <FolderOpen size={16} aria-hidden="true" /><span>Open JSON</span>
                </button>
                <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); exportCanvasProject(); }} disabled={isBusy}>
                  <FileJson size={16} aria-hidden="true" /><span>Export JSON</span>
                </button>
                <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); exportCanvasSvg(); }} disabled={isBusy}>
                  <Download size={16} aria-hidden="true" /><span>Export SVG</span>
                </button>
                {debugMode && (
                  <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); runAllComponentsTest(); }} disabled={isBusy}>
                    <Sparkles size={16} aria-hidden="true" /><span>Test components</span>
                  </button>
                )}
              </div>
            </details>
            <button type="button" className="iconButton danger" onClick={handleTrashAction} aria-label={trashActionLabel}>
              <Trash2 size={18} />
            </button>
          </div>
        </header>

        <div className="canvasStage">
          <aside
            className={toolDockCollapsed ? "componentPanel collapsed" : "componentPanel"}
            data-tab={toolDockTab}
            aria-label="Circuit tools"
          >
            <div className="componentPanelHeader">
              {!toolDockCollapsed && (
                <div className="componentPanelTabs" role="tablist" aria-label="Tool panel">
                  <button
                    type="button"
                    role="tab"
                    aria-label={`Component library, ${componentLibrary.length} items`}
                    aria-selected={toolDockTab === "library"}
                    className={toolDockTab === "library" ? "active" : ""}
                    onClick={() => setToolDockTab("library")}
                  >
                    <Library size={15} aria-hidden="true" />
                    <span>Library</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={toolDockTab === "inspector"}
                    className={toolDockTab === "inspector" ? "active" : ""}
                    onClick={() => setToolDockTab("inspector")}
                  >
                    <SlidersHorizontal size={15} aria-hidden="true" />
                    <span>Inspector</span>
                  </button>
                </div>
              )}
              <button
                type="button"
                className="componentPanelCollapse"
                onClick={toggleToolDock}
                aria-label={toolDockCollapsed ? "Open circuit tools" : "Collapse circuit tools"}
                aria-expanded={!toolDockCollapsed}
              >
                {toolDockCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={17} />}
              </button>
            </div>

            <div className="componentLibraryControls" role="tabpanel" aria-label="Component library">
            <input
              className="componentSearch"
              value={componentQuery}
              onChange={(event) => setComponentQuery(event.target.value)}
              aria-label="Search components"
              placeholder="Search components"
            />

            <div className="placementControls" aria-label="Placement orientation">
              {placementOrientations.map((orientation) => (
                <button
                  key={`placement-${orientation}`}
                  type="button"
                  className={placementOrientation === orientation ? "orientationButton active" : "orientationButton"}
                  onClick={() => setPlacementOrientation(orientation)}
                  aria-label={`Place ${orientation === "h" ? "horizontally" : "vertically"}`}
                >
                  {orientation.toUpperCase()}
                </button>
              ))}
              {pendingComponentName && <code>{pendingComponentName}</code>}
            </div>

            <div className="componentLibraryList">
              {componentLibraryLoading && <div className="panelEmpty">Loading components</div>}
              {componentLibraryError && <div className="panelError">{componentLibraryError}</div>}
              {!componentLibraryLoading && !componentLibraryError && filteredComponentLibrary.length === 0 && (
                <div className="panelEmpty">No components</div>
              )}
              {filteredComponentLibrary.map((detail) => (
                <ComponentLibraryTile
                  key={`${detail.path}-${detail.name}`}
                  detail={detail}
                  active={pendingComponentName === detail.name}
                  onPick={() => armComponentPlacement(detail)}
                  onPointerDown={(event) => handleComponentLibraryPointerDown(event, detail)}
                  onDragStart={(event) => handleComponentLibraryDragStart(event, detail)}
                />
              ))}
            </div>
            </div>

            <div className="selectionInspector" role="tabpanel" aria-label="Selected object inspector">
              {selectedComponent ? (
                <>
                  <div className="inspectorHeader">
                    <span>{selectedComponent.id}</span>
                    <code>{componentDisplayName(selectedComponent)}</code>
                  </div>
                  <div className="coordinateEditor">
                    <label className="coordinateField">
                      <span>origin x</span>
                      <input
                        key={`${selectedComponent.id}-origin-x-${selectedComponent.origin[0]}`}
                        defaultValue={selectedComponent.origin[0]}
                        inputMode="numeric"
                        onBlur={(event) => updateSelectedComponentOriginCoordinate("x", event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <label className="coordinateField">
                      <span>origin y</span>
                      <input
                        key={`${selectedComponent.id}-origin-y-${selectedComponent.origin[1]}`}
                        defaultValue={selectedComponent.origin[1]}
                        inputMode="numeric"
                        onBlur={(event) => updateSelectedComponentOriginCoordinate("y", event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                  </div>
                  <div className="inspectorSegment">
                    {selectedComponentOrientations.map((orientation) => (
                      <button
                        key={`${selectedComponent.id}-${orientation}`}
                        type="button"
                        className={selectedComponent.orientation === orientation ? "orientationButton active" : "orientationButton"}
                        onClick={() => updateSelectedComponentOrientation(orientation)}
                        aria-label={`Set ${selectedComponent.id} ${orientation === "h" ? "horizontal" : "vertical"}`}
                      >
                        {orientation.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <div className="propertyList">
                    {selectedComponent.detail.properties.length === 0 ? (
                      <div className="panelEmpty compact">No properties</div>
                    ) : (
                      selectedComponent.detail.properties.slice(0, 12).map((property) => {
                        const currentValue = selectedComponent.properties[property.name] ?? property.default ?? "";
                        return (
                          <label key={`${selectedComponent.id}-${property.name}`} className="propertyField">
                            <span title={property.name}>{property.name}</span>
                            {property.type === "enum" && property.options.length > 0 ? (
                              <select
                                value={currentValue}
                                onChange={(event) => updateSelectedComponentProperty(property.name, event.target.value)}
                              >
                                {property.options.map((option) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            ) : property.type === "bool" ? (
                              <select
                                value={currentValue.toLowerCase() === "true" ? "true" : "false"}
                                onChange={(event) => updateSelectedComponentProperty(property.name, event.target.value)}
                              >
                                <option value="true">true</option>
                                <option value="false">false</option>
                              </select>
                            ) : (
                              <input
                                key={`${selectedComponent.id}-${property.name}-${currentValue}`}
                                defaultValue={currentValue}
                                onBlur={(event) => updateSelectedComponentProperty(property.name, event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.currentTarget.blur();
                                  }
                                }}
                              />
                            )}
                          </label>
                        );
                      })
                    )}
                  </div>
                </>
              ) : selectedWire ? (
                <>
                  <div className="inspectorHeader">
                    <span>{selectedWire.id}</span>
                    <code>Wire</code>
                  </div>
                  <div className="coordinateEditor">
                    <label className="coordinateField">
                      <span>start x</span>
                      <input
                        key={`${selectedWire.id}-start-x-${selectedWire.start[0]}`}
                        defaultValue={selectedWire.start[0]}
                        inputMode="numeric"
                        onBlur={(event) => updateSelectedWireCoordinate("start", "x", event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <label className="coordinateField">
                      <span>start y</span>
                      <input
                        key={`${selectedWire.id}-start-y-${selectedWire.start[1]}`}
                        defaultValue={selectedWire.start[1]}
                        inputMode="numeric"
                        onBlur={(event) => updateSelectedWireCoordinate("start", "y", event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <label className="coordinateField">
                      <span>end x</span>
                      <input
                        key={`${selectedWire.id}-end-x-${selectedWire.end[0]}`}
                        defaultValue={selectedWire.end[0]}
                        inputMode="numeric"
                        onBlur={(event) => updateSelectedWireCoordinate("end", "x", event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <label className="coordinateField">
                      <span>end y</span>
                      <input
                        key={`${selectedWire.id}-end-y-${selectedWire.end[1]}`}
                        defaultValue={selectedWire.end[1]}
                        inputMode="numeric"
                        onBlur={(event) => updateSelectedWireCoordinate("end", "y", event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                  </div>
                </>
              ) : selectedJunction ? (
                <>
                  <div className="inspectorHeader">
                    <span>{selectedJunction.id}</span>
                    <code>{selectedJunction.manual ? "Junction" : "Inferred junction"}</code>
                  </div>
                  <div className="coordinateEditor">
                    <label className="coordinateField">
                      <span>x</span>
                      <input
                        key={`${selectedJunction.id}-x-${selectedJunction.point[0]}`}
                        defaultValue={selectedJunction.point[0]}
                        inputMode="numeric"
                        disabled={!selectedJunction.manual}
                        onBlur={(event) => updateSelectedJunctionCoordinate("x", event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <label className="coordinateField">
                      <span>y</span>
                      <input
                        key={`${selectedJunction.id}-y-${selectedJunction.point[1]}`}
                        defaultValue={selectedJunction.point[1]}
                        inputMode="numeric"
                        disabled={!selectedJunction.manual}
                        onBlur={(event) => updateSelectedJunctionCoordinate("y", event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    {!selectedJunction.manual && <div className="panelEmpty compact">Move connected wires to reposition this junction.</div>}
                  </div>
                </>
              ) : (
                <div className="panelEmpty compact">No selection</div>
              )}
            </div>
          </aside>

          <div className="canvasViewport" ref={canvasViewportRef} onDragOver={handleCanvasDragOver} onDrop={handleCanvasDrop}>
            <svg
              ref={canvasSvgRef}
              className={editorMode === "wire" ? "canvas wireTool" : "canvas selectTool"}
              viewBox={viewBox}
              preserveAspectRatio="xMinYMin meet"
              role="img"
              aria-label="Circuit grid canvas"
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerCancel}
            >
              <defs>
                <pattern id="minorGrid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
                  <path d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`} className="minorGridLine" />
                </pattern>
                <pattern id="majorGrid" width={MAJOR_GRID_SIZE} height={MAJOR_GRID_SIZE} patternUnits="userSpaceOnUse">
                  <path d={`M ${MAJOR_GRID_SIZE} 0 L 0 0 0 ${MAJOR_GRID_SIZE}`} className="majorGridLine" />
                </pattern>
                <filter id="activeGlow" x="-100%" y="-100%" width="300%" height="300%">
                  <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#2563eb" floodOpacity="0.45" />
                </filter>
              </defs>

              <rect
                x={-visibleCanvasBounds.width}
                y={-visibleCanvasBounds.height}
                width={visibleCanvasBounds.width * 3}
                height={visibleCanvasBounds.height * 3}
                className="outsideCanvas"
              />
              <rect x={0} y={0} width={visibleCanvasBounds.width} height={visibleCanvasBounds.height} className="paper" />
              <rect x={0} y={0} width={visibleCanvasBounds.width} height={visibleCanvasBounds.height} fill="url(#minorGrid)" />
              <rect x={0} y={0} width={visibleCanvasBounds.width} height={visibleCanvasBounds.height} fill="url(#majorGrid)" />
              {canvasFlashKey > 0 && (
                <rect
                  key={canvasFlashKey}
                  x={0}
                  y={0}
                  width={canvasBounds.width}
                  height={canvasBounds.height}
                  className="canvasClearFlash"
                />
              )}
              <rect x={0} y={0} width={canvasBounds.width} height={canvasBounds.height} className="canvasBounds" />

              <g className="wireLayer">
                {canvasState.wires.map((wire) => (
                  <WireSegmentRenderer
                    key={wire.id}
                    wire={wire}
                    wireDetail={wireComponentDetail}
                    active={activeId === wire.id || selection?.id === wire.id}
                  />
                ))}
                {wireDraft && !samePoint(wireDraft.start, wireDraft.end) && (
                  <WireSegmentRenderer
                    wire={{ id: "draft-wire", start: wireDraft.start, end: wireDraft.end }}
                    wireDetail={wireComponentDetail}
                    active={false}
                    draft
                  />
                )}
              </g>

              <g className="componentLayer">
                {canvasState.components.map((component) => (
                  <ComponentRenderer key={component.id} component={component} active={activeId === component.id || selection?.id === component.id} />
                ))}
              </g>

              <g className="junctionLayer">
                {canvasState.junctions.map((junction) => (
                  <circle
                    key={junction.id}
                    cx={junction.point[0]}
                    cy={junction.point[1]}
                    r={3}
                    className={activeId === junction.id || selection?.id === junction.id ? "junction activeJunction" : "junction"}
                  />
                ))}
              </g>

              {validationMarkers.length > 0 && (
                <g className="issueMarkerLayer" aria-hidden="true">
                  {validationMarkers.map((issue, index) => (
                    <g key={`${issue.id}-${index}`} className={`issueMarker ${issue.target}`}>
                      <circle cx={issue.point[0]} cy={issue.point[1]} r={5} />
                      <path
                        d={`M ${issue.point[0] - 2.5} ${issue.point[1] - 2.5} L ${issue.point[0] + 2.5} ${
                          issue.point[1] + 2.5
                        } M ${issue.point[0] + 2.5} ${issue.point[1] - 2.5} L ${issue.point[0] - 2.5} ${issue.point[1] + 2.5}`}
                      />
                    </g>
                  ))}
                </g>
              )}

              {(editorMode === "wire" || selectedComponent || selectedWire) && (
                <g className="connectionHintLayer">
                  {visibleConnectionPoints.map((connection) => (
                    <circle
                      key={connection.key}
                      cx={connection.point[0]}
                      cy={connection.point[1]}
                      r={3}
                      className="portHint"
                    />
                  ))}
                </g>
              )}

              {selectedWire && (
                <g className="wireHandleLayer">
                  <circle cx={selectedWire.start[0]} cy={selectedWire.start[1]} r={3} className="wireHandle" />
                  <circle cx={selectedWire.end[0]} cy={selectedWire.end[1]} r={3} className="wireHandle" />
                </g>
              )}

              {snapTarget && (
                <g className="snapTargetLayer">
                  <circle cx={snapTarget.point[0]} cy={snapTarget.point[1]} r={3} className={`snapTarget ${snapTarget.kind}`} />
                </g>
              )}
            </svg>
          </div>

          <div className={isBusy ? "edgeGlow active" : "edgeGlow"} aria-hidden="true">
            <span className="edgeGlowTop" />
            <span className="edgeGlowRight" />
            <span className="edgeGlowBottom" />
            <span className="edgeGlowLeft" />
          </div>

        </div>
      </section>
    </main>
  );
}

function looksLikeJson(value: string) {
  return value.startsWith("{") || value.startsWith("[");
}

function isComponentToolCall(call: CircuitToolCall): boolean {
  return (
    call.name === "get_component_catalog" ||
    call.name === "get_component_detail" ||
    call.name === "place_component" ||
    call.name === "move_component" ||
    call.name === "update_component_properties" ||
    call.name === "remove_component"
  );
}

function createComponentErrorResult(
  state: CircuitCanvasState,
  id: string,
  action: CircuitToolCall["name"],
  message: string
): ToolExecutionResult {
  return {
    state,
    activeId: id,
    trace: {
      id,
      action,
      detail: message,
      status: "error",
    },
    toolResult: {
      status: "error",
      message,
    },
  };
}

function getCreatedSelection(call: CircuitToolCall, id: string | null): EditorSelection | null {
  if (!id) return null;
  if (call.name === "place_component") return { kind: "component", id };
  if (call.name === "draw_wire_segment") return { kind: "wire", id };
  if (call.name === "add_junction") return { kind: "junction", id };
  return null;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fingerprintCanvas(state: CircuitCanvasState): string {
  return JSON.stringify({
    components: state.components.map(({ id, name, requestedName, origin, orientation, properties }) => ({
      id,
      name,
      requestedName,
      origin,
      orientation,
      properties,
    })),
    wires: state.wires,
    junctions: state.junctions,
  });
}

function fingerprintIssues(issues: ValidationIssue[]): string {
  return JSON.stringify(
    issues
      .map((issue) => `${issue.id}:${issue.target}:${issue.message}:${issue.point?.join(",") ?? ""}`)
      .sort()
  );
}

function getLatestAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
    }
  }
  return "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

function isCircuitCanvasState(value: unknown): value is CircuitCanvasState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.components) && Array.isArray(record.wires) && Array.isArray(record.junctions);
}

function conversationEventsToTimeline(events: ConversationEvent[]): AgentTimelineItem[] {
  const timeline: AgentTimelineItem[] = [];
  for (const event of events) {
    const payload = event.payload ?? event.data ?? {};
    const messageContent = extractEventContent(payload.content);
    const toolName = typeof payload.name === "string"
      ? payload.name
      : isToolCallPayload(payload) ? payload.function.name : undefined;
    if (
      event.type === "turn.started" ||
      event.type === "usage.updated" ||
      event.type === "step.completed" ||
      event.type === "visual.review" ||
      event.type === "assistant.text.delta" ||
      (event.type === "assistant.message" && !messageContent)
    ) {
      continue;
    }
    const text = event.type === "user.message" && messageContent
      ? extractUserRequest(messageContent)
      : event.type === "tool.call" && toolName
        ? `Calling ${toolName}`
        : event.type === "tool.result" && typeof payload.content === "string"
          ? summarizeToolResult(payload.content)
      : typeof payload.text === "string"
      ? payload.text
      : typeof payload.message === "string"
        ? payload.message
        : messageContent
          ? messageContent
          : typeof payload.error === "string"
            ? payload.error
            : typeof payload.reason === "string"
              ? payload.reason
        : event.type;
    const kind: AgentTimelineItem["kind"] = event.type === "user.message"
      ? "user"
      : event.type === "assistant.message"
        ? "assistant"
        : event.type === "reasoning.summary" || event.type === "reasoning.summary.delta"
          ? "reasoning"
          : event.type === "tool.call" || event.type === "tool.result"
            ? "tool"
            : event.type === "turn.error"
              ? "error"
              : "status";
    timeline.push({
      id: String(event.id),
      kind,
      text,
      createdAt: event.created_at,
      toolName,
      toolStatus: event.type === "tool.result"
        ? payload.status === "error" ? "error" : "ok"
        : event.type === "tool.call" ? "running" : undefined,
      targetId: typeof payload.target_id === "string" ? payload.target_id : undefined,
    });
  }
  return timeline;
}

function extractEventContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object" && !Array.isArray(part))
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function extractUserRequest(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const request = (parsed as Record<string, unknown>).user_request;
      if (typeof request === "string" && request.trim()) return request.trim();
    }
  } catch {
    // Plain user messages do not need decoding.
  }
  const markdownRequest = value.match(
    /(?:^|\n)# 用户请求\s*\n+([\s\S]*?)(?=\n+# 任务模式(?:\n|$))/
  );
  if (markdownRequest?.[1]?.trim()) return markdownRequest[1].trim();
  return value;
}

function summarizeToolResult(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "tool";
      const status = typeof record.status === "string" ? record.status : "completed";
      return `${name}: ${status}`;
    }
  } catch {
    // Keep short non-JSON provider output below.
  }
  return value.length > 180 ? `${value.slice(0, 177)}…` : value;
}

function usageFromConversationEvents(
  events: ConversationEvent[],
  fallbackContextWindow?: number
): AgentUsage | undefined {
  const turnTotals = new Map<string, number>();
  let latest: AgentUsage | undefined;
  for (const event of events) {
    if (event.type !== "usage.updated") continue;
    const usage = normalizeUsage(event.payload ?? event.data);
    if (!usage) continue;
    latest = usage;
    const key = event.turn_id ?? `event-${event.id}`;
    turnTotals.set(key, Math.max(turnTotals.get(key) ?? 0, usage.total_tokens));
  }
  if (!latest) return undefined;
  return {
    ...latest,
    context_window: latest.context_window ?? fallbackContextWindow,
    session_total_tokens: Array.from(turnTotals.values()).reduce((sum, total) => sum + total, 0),
  };
}

function isToolCallPayload(value: Record<string, unknown>): value is Record<string, unknown> & {
  function: { name: string };
} {
  if (!value.function || typeof value.function !== "object" || Array.isArray(value.function)) return false;
  return typeof (value.function as Record<string, unknown>).name === "string";
}

function toConversationTimelineItems(
  items: AgentTimelineItem[],
  canUndoStoppedTurn: boolean
): ConversationTimelineItem[] {
  const result: ConversationTimelineItem[] = [];

  for (const item of items) {
    const createdAt = formatTimelineTime(item.createdAt);
    if (item.kind === "user" || item.kind === "assistant") {
      result.push({
        id: item.id,
        kind: "message",
        role: item.kind,
        content: item.text,
        createdAt,
        status: "complete",
      });
      continue;
    }

    if (item.kind === "reasoning") {
      result.push({
        id: item.id,
        kind: "reasoning",
        title: "Reasoning summary",
        summary: item.text,
        createdAt,
        status: item.toolStatus === "running" ? "running" : item.toolStatus === "error" ? "error" : "success",
      });
      continue;
    }

    if (item.kind === "tool") {
      const event: ToolTimelineEvent = {
        id: item.id,
        name: item.toolName ?? "canvas tool",
        summary: item.text,
        status: item.toolStatus === "running" ? "running" : item.toolStatus === "error" ? "error" : "success",
        targetId: item.targetId,
      };
      const previous = result[result.length - 1];
      if (previous?.kind === "tool") {
        previous.events.push(event);
      } else {
        result.push({
          id: `tool-batch-${item.id}`,
          kind: "tool",
          title: "Canvas operations",
          createdAt,
          events: [event],
        });
      }
      continue;
    }

    const isStopped = /stopp|停止|上限|无变化|未减少|耗尽/i.test(item.text);
    result.push({
      id: item.id,
      kind: "status",
      label: item.kind === "error" ? "Agent error" : isStopped ? "Run stopped" : "Agent status",
      detail: item.text,
      createdAt,
      tone: item.kind === "error" ? "danger" : isStopped ? "warning" : "info",
      actionLabel: isStopped && canUndoStoppedTurn ? "Undo this run" : undefined,
    });
  }

  return result;
}

function formatTimelineTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function createPolicyErrorResult(
  state: CircuitCanvasState,
  call: CircuitToolCall,
  errorCode: string,
  message: string
): ToolExecutionResult {
  return {
    state,
    activeId: null,
    trace: { id: "canvas", action: call.name, detail: message, status: "error" },
    toolResult: { status: "error", error_code: errorCode, message },
  };
}

function enhanceToolError(
  result: ToolExecutionResult,
  call: CircuitToolCall,
  canvasBounds: CanvasBounds
): ToolExecutionResult {
  if (result.trace.status !== "error") return result;
  const points = getToolCallPoints(call);
  const connectionCall =
    call.name === "draw_wire_segment" ||
    call.name === "update_wire_segment" ||
    call.name === "add_junction" ||
    call.name === "move_junction";
  const expectedGrid = connectionCall ? CONNECTION_GRID_SIZE : COMPONENT_GRID_SIZE;
  const errorCode = result.trace.detail.includes("grid")
    ? "OFF_GRID"
    : result.trace.detail.includes("horizontal or vertical")
      ? "WIRE_NOT_AXIS_ALIGNED"
      : result.trace.detail.includes("inside the canvas")
        ? "OUT_OF_BOUNDS"
        : "TOOL_REJECTED";
  return {
    ...result,
    toolResult: {
      status: "error",
      error_code: errorCode,
      message: result.trace.detail,
      expected_grid: expectedGrid,
      received_points: points,
      nearest_valid_points: points.map((point) => snapPointToGridStep(point, canvasBounds, expectedGrid)),
    },
  };
}

function getToolCallPoints(call: CircuitToolCall): Point[] {
  switch (call.name) {
    case "place_component":
    case "move_component":
      return [call.origin];
    case "draw_wire_segment":
      return [call.start, call.end];
    case "update_wire_segment":
      return [call.start, call.end].filter((point): point is Point => Boolean(point));
    case "add_junction":
    case "move_junction":
      return [call.point];
    default:
      return [];
  }
}

function getVisualAssetId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const assetId = (value as Record<string, unknown>).asset_id;
  return typeof assetId === "string" && assetId ? assetId : null;
}

function imageForAgentRequest(image: UploadedImage | null): Omit<UploadedImage, "data_url"> | UploadedImage | null {
  if (!image) return null;
  if (!image.asset_id) return image;
  const { data_url: _previewOnly, ...asset } = image;
  return asset;
}

function createClientTurnId(): string {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `turn_${random}`;
}

function stopReasonFromProvider(reason: string | null | undefined): AgentStopReason {
  if (reason === "tool_limit") return "tool_limit";
  if (reason === "round_limit") return "round_limit";
  if (reason === "repair_budget") return "repair_budget";
  if (reason === "no_progress") return "no_progress";
  if (reason === "user" || reason === "user_stopped") return "user";
  return "model_error";
}
