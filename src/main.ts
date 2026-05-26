import "./styles.css";

type Mode =
  | "selecting"
  | "timer_running"
  | "timer_paused"
  | "stopwatch_running"
  | "stopwatch_paused";

type Session = {
  mode: Mode;
  selectedIndex: number;
  selectedMinutes: number;
  targetAt: number | null;
  pausedRemainingMs: number | null;
  stopwatchStartedAt: number | null;
  stopwatchElapsedMs: number;
};

type Snapshot = Session & {
  version: 1;
};

type WakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};

type PointerGesture = {
  id: number;
  pointerType: string;
  startX: number;
  startY: number;
  startIndex: number;
  startedAt: number;
  lastY: number;
  lastAt: number;
  speed: number;
  stepRemainder: number;
};

const STORAGE_KEY = "joyful-visual-timer/session";
const MIN_INDEX = 0;
const MAX_INDEX = 90;
const FEED_RADIUS = 3;
const RESET_WHEEL_THRESHOLD = 24;
const RESET_TOUCH_THRESHOLD = 34;
const STEP_WHEEL_THRESHOLD = 34;
const TOUCH_SLOW_HALF_SCREEN_STEPS = 4;
const TOUCH_FAST_HALF_SCREEN_STEPS = 29;
const TOUCH_MIN_SLOW_THRESHOLD = 72;
const TOUCH_MAX_SLOW_THRESHOLD = 120;
const TOUCH_MIN_FAST_THRESHOLD = 10;
const TOUCH_MAX_FAST_THRESHOLD = 18;
const TOUCH_SLOW_SPEED = 0.035;
const TOUCH_FAST_SPEED = 0.42;
const TOUCH_SLOW_STEP_MS = 96;
const TOUCH_FAST_STEP_MS = 16;
const TOUCH_SLOW_TRANSITION_MS = 360;
const TOUCH_FAST_TRANSITION_MS = 90;
const WHEEL_RESET_QUIET_MS = 140;
const WHEEL_RESET_MAX_SUPPRESS_MS = 900;
const FRAME_MS = 250;
const appRoot = document.querySelector<HTMLElement>("#app");

if (!appRoot) {
  throw new Error("App root missing");
}

const app = appRoot;

const defaultSession = (): Session => ({
  mode: "selecting",
  selectedIndex: 13,
  selectedMinutes: 13,
  targetAt: null,
  pausedRemainingMs: null,
  stopwatchStartedAt: null,
  stopwatchElapsedMs: 0
});

let session = loadSession();
let wakeLock: WakeLockSentinel | null = null;
let wakeLockState: "off" | "pending" | "on" | "blocked" = "off";
let wheelRemainder = 0;
let pointerGesture: PointerGesture | null = null;
let touchTargetIndex: number | null = null;
let touchStepDelay = TOUCH_SLOW_STEP_MS;
let touchStepTimeout = 0;
let suppressWheelSelection = false;
let suppressWheelSelectionStartedAt = 0;
let suppressWheelTimeout = 0;
let suppressTouchSelectionUntilPointerUp = false;
let lastSecondKey = "";
let lastRenderKey = "";
let tickPulseTimeout = 0;
let rafId = 0;

render();
startRenderLoop();
bindEvents();
registerServiceWorker();
syncWakeLock();

function loadSession(): Session {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultSession();
    }

    const snapshot = JSON.parse(raw) as Partial<Snapshot>;
    if (snapshot.version !== 1 || typeof snapshot.mode !== "string") {
      return defaultSession();
    }

    const parsedIndex = Number(snapshot.selectedIndex);
    const selectedIndex = Number.isFinite(parsedIndex)
      ? clamp(parsedIndex, MIN_INDEX, MAX_INDEX)
      : 13;
    const storedMode = snapshot.mode as unknown;
    const mode = normalizeMode(storedMode);
    const isLegacyOvertime = storedMode === "timer_overtime";
    const targetAt = typeof snapshot.targetAt === "number" ? snapshot.targetAt : null;
    const stopwatchElapsedMs =
      typeof snapshot.stopwatchElapsedMs === "number" ? snapshot.stopwatchElapsedMs : 0;

    return {
      mode,
      selectedIndex,
      selectedMinutes: selectedIndexToMinutes(selectedIndex),
      targetAt,
      pausedRemainingMs:
        typeof snapshot.pausedRemainingMs === "number" ? snapshot.pausedRemainingMs : null,
      stopwatchStartedAt:
        mode === "stopwatch_running" && isLegacyOvertime ? Date.now() :
        typeof snapshot.stopwatchStartedAt === "number" ? snapshot.stopwatchStartedAt : null,
      stopwatchElapsedMs:
        mode === "stopwatch_running" && isLegacyOvertime && targetAt !== null
          ? Math.max(0, Date.now() - targetAt)
          : stopwatchElapsedMs
    };
  } catch {
    return defaultSession();
  }
}

function normalizeMode(value: unknown): Mode {
  if (value === "timer_overtime") {
    return "stopwatch_running";
  }

  return ["selecting", "timer_running", "timer_paused", "stopwatch_running", "stopwatch_paused"]
    .includes(String(value))
    ? (value as Mode)
    : "selecting";
}

function persistSession() {
  const snapshot: Snapshot = {
    ...session,
    version: 1
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function bindEvents() {
  window.addEventListener(
    "wheel",
    (event) => {
      if (session.mode === "selecting") {
        event.preventDefault();
        if (suppressWheelSelection) {
          updateWheelSelectionSuppression();
          return;
        }

        wheelRemainder += event.deltaY;
        const steps = drainSteps(wheelRemainder, STEP_WHEEL_THRESHOLD);
        if (steps !== 0) {
          wheelRemainder -= steps * STEP_WHEEL_THRESHOLD;
          moveSelection(-steps);
        }
        return;
      }

      if (isPaused() && Math.abs(event.deltaY) > RESET_WHEEL_THRESHOLD) {
        event.preventDefault();
        startWheelSelectionSuppression();
        wheelRemainder = 0;
        resetToSelecting();
      }
    },
    { passive: false }
  );

  window.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) {
      return;
    }

    const now = event.timeStamp || performance.now();
    pointerGesture = {
      id: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      startIndex: session.selectedIndex,
      startedAt: now,
      lastY: event.clientY,
      lastAt: now,
      speed: 0,
      stepRemainder: 0
    };
    touchTargetIndex = null;
    window.clearTimeout(touchStepTimeout);
  });

  window.addEventListener(
    "pointermove",
    (event) => {
      if (!pointerGesture || event.pointerId !== pointerGesture.id) {
        return;
      }

      if (pointerGesture.pointerType !== "touch") {
        return;
      }

      if (session.mode === "selecting") {
        event.preventDefault();
        if (suppressTouchSelectionUntilPointerUp) {
          return;
        }

        processTouchSelectionMove(event);
        return;
      }

      if (isPaused() && Math.abs(event.clientY - pointerGesture.startY) > RESET_TOUCH_THRESHOLD) {
        event.preventDefault();
        suppressTouchSelectionUntilPointerUp = true;
        clearTouchSelectionState();
        resetToSelecting();
      }
    },
    { passive: false }
  );

  window.addEventListener("pointerup", (event) => {
    if (!pointerGesture || event.pointerId !== pointerGesture.id) {
      return;
    }

    const dx = event.clientX - pointerGesture.startX;
    const dy = event.clientY - pointerGesture.startY;
    const dt = performance.now() - pointerGesture.startedAt;
    const wasTouchSelection =
      pointerGesture.pointerType === "touch" &&
      session.mode === "selecting" &&
      !suppressTouchSelectionUntilPointerUp &&
      Math.hypot(dx, dy) > 14;
    pointerGesture = null;
    suppressTouchSelectionUntilPointerUp = false;

    if (!wasTouchSelection || touchTargetIndex === session.selectedIndex) {
      clearTouchSelectionCue();
    }

    if (Math.hypot(dx, dy) > 14 || dt > 700) {
      return;
    }

    activate();
  });

  window.addEventListener("pointercancel", () => {
    pointerGesture = null;
    suppressTouchSelectionUntilPointerUp = false;
    clearTouchSelectionState();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (session.mode === "selecting") {
        moveSelection(1);
      } else if (isPaused()) {
        resetToSelecting();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (session.mode === "selecting") {
        moveSelection(-1);
      } else if (isPaused()) {
        resetToSelecting();
      }
      return;
    }

    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      activate();
    }
  });

  window.addEventListener("visibilitychange", () => {
    render();
    syncWakeLock();
  });
  window.addEventListener("pageshow", () => {
    render();
    syncWakeLock();
  });
  window.addEventListener("pagehide", () => {
    persistSession();
  });
}

function drainSteps(value: number, threshold: number) {
  if (Math.abs(value) < threshold) {
    return 0;
  }

  return value > 0 ? Math.floor(value / threshold) : Math.ceil(value / threshold);
}

function getTouchSpeedRatio(speed: number) {
  const ratio = clamp((speed - TOUCH_SLOW_SPEED) / (TOUCH_FAST_SPEED - TOUCH_SLOW_SPEED), 0, 1);
  return ratio ** 1.35;
}

function getTouchStepThreshold(speed: number) {
  const halfScreen = Math.max(240, window.innerHeight * 0.5);
  const slowThreshold = clamp(
    halfScreen / TOUCH_SLOW_HALF_SCREEN_STEPS,
    TOUCH_MIN_SLOW_THRESHOLD,
    TOUCH_MAX_SLOW_THRESHOLD
  );
  const fastThreshold = clamp(
    halfScreen / TOUCH_FAST_HALF_SCREEN_STEPS,
    TOUCH_MIN_FAST_THRESHOLD,
    TOUCH_MAX_FAST_THRESHOLD
  );

  const eased = getTouchSpeedRatio(speed);
  return slowThreshold + (fastThreshold - slowThreshold) * eased;
}

function getTouchStepDelay(speed: number) {
  const ratio = clamp((speed - TOUCH_SLOW_SPEED) / (TOUCH_FAST_SPEED - TOUCH_SLOW_SPEED), 0, 1);
  const eased = ratio ** 0.8;
  return TOUCH_SLOW_STEP_MS + (TOUCH_FAST_STEP_MS - TOUCH_SLOW_STEP_MS) * eased;
}

function updateTouchSelectionCue(speed: number) {
  const ratio = getTouchSpeedRatio(speed);
  const transitionMs =
    TOUCH_SLOW_TRANSITION_MS + (TOUCH_FAST_TRANSITION_MS - TOUCH_SLOW_TRANSITION_MS) * ratio;

  app.dataset.scrubbing = "true";
  app.style.setProperty("--selection-transition-ms", `${Math.round(transitionMs)}ms`);
}

function clearTouchSelectionCue() {
  delete app.dataset.scrubbing;
  app.style.removeProperty("--selection-transition-ms");
}

function clearTouchSelectionState() {
  touchTargetIndex = null;
  window.clearTimeout(touchStepTimeout);
  clearTouchSelectionCue();
}

function processTouchSelectionMove(event: PointerEvent) {
  if (!pointerGesture) {
    return;
  }

  const samples = event.getCoalescedEvents?.() ?? [];
  const moves = samples.length > 0 ? samples : [event];
  const move = moves[moves.length - 1];
  const y = move.clientY;
  const at = move.timeStamp || performance.now();
  const moveElapsed = Math.max(1, at - pointerGesture.lastAt);
  const fingerDelta = y - pointerGesture.lastY;
  const moveSpeed = Math.abs(fingerDelta) / moveElapsed;
  const speed = Math.max(moveSpeed, pointerGesture.speed * 0.45);
  const threshold = getTouchStepThreshold(speed);
  pointerGesture.stepRemainder += fingerDelta / threshold;
  const steps = pointerGesture.stepRemainder > 0
    ? Math.floor(pointerGesture.stepRemainder)
    : Math.ceil(pointerGesture.stepRemainder);

  pointerGesture.lastY = y;
  pointerGesture.lastAt = at;
  pointerGesture.speed = speed;
  touchStepDelay = getTouchStepDelay(speed);
  updateTouchSelectionCue(speed);

  if (steps !== 0) {
    pointerGesture.stepRemainder -= steps;
    touchTargetIndex = clamp(
      (touchTargetIndex ?? session.selectedIndex) + steps,
      MIN_INDEX,
      MAX_INDEX
    );
    stepTowardTouchTarget();
  }
}

function stepTowardTouchTarget() {
  window.clearTimeout(touchStepTimeout);
  if (touchTargetIndex === null || touchTargetIndex === session.selectedIndex) {
    return;
  }

  moveSelection(touchTargetIndex > session.selectedIndex ? 1 : -1);

  if (touchTargetIndex !== session.selectedIndex) {
    touchStepTimeout = window.setTimeout(stepTowardTouchTarget, touchStepDelay);
  } else if (!pointerGesture) {
    window.setTimeout(clearTouchSelectionCue, 80);
  }
}

function moveSelection(direction: number) {
  const next = clamp(session.selectedIndex + direction, MIN_INDEX, MAX_INDEX);
  if (next === session.selectedIndex) {
    nudgeEdge(direction);
    return;
  }

  session = {
    ...session,
    mode: "selecting",
    selectedIndex: next,
    selectedMinutes: selectedIndexToMinutes(next),
    targetAt: null,
    pausedRemainingMs: null,
    stopwatchStartedAt: null,
    stopwatchElapsedMs: 0
  };
  app.dataset.bump = direction > 0 ? "up" : "down";
  pulseSelection();
  persistSession();
  render();
}

function nudgeEdge(direction: number) {
  app.dataset.bump = direction > 0 ? "edge-up" : "edge-down";
  window.setTimeout(() => {
    if (app.dataset.bump?.startsWith("edge")) {
      delete app.dataset.bump;
    }
  }, 220);
}

function pulseSelection() {
  app.classList.remove("selection-pulse");
  void app.offsetWidth;
  app.classList.add("selection-pulse");
  vibrate(6);
}

function activate() {
  const now = Date.now();

  if (session.mode === "selecting") {
    app.classList.add("launching");
    window.setTimeout(() => app.classList.remove("launching"), 620);

    if (session.selectedIndex === 0) {
      session = {
        ...session,
        mode: "stopwatch_running",
        selectedMinutes: 0,
        stopwatchStartedAt: now,
        stopwatchElapsedMs: 0,
        targetAt: null,
        pausedRemainingMs: null
      };
    } else {
      session = {
        ...session,
        mode: "timer_running",
        selectedMinutes: session.selectedIndex,
        targetAt: now + session.selectedIndex * 60_000,
        pausedRemainingMs: null,
        stopwatchStartedAt: null,
        stopwatchElapsedMs: 0
      };
    }

    vibrate(18);
    persistSession();
    render();
    syncWakeLock();
    return;
  }

  if (session.mode === "timer_running") {
    const remainingMs = getTimerRemainingMs(now);
    session = {
      ...session,
      mode: "timer_paused",
      pausedRemainingMs: remainingMs,
      targetAt: null
    };
    vibrate(10);
    persistSession();
    render();
    syncWakeLock();
    return;
  }

  if (session.mode === "timer_paused") {
    const pausedRemainingMs = session.pausedRemainingMs ?? session.selectedMinutes * 60_000;
    if (pausedRemainingMs <= 0) {
      session = {
        ...session,
        mode: "stopwatch_running",
        targetAt: null,
        pausedRemainingMs: null,
        stopwatchStartedAt: now,
        stopwatchElapsedMs: Math.abs(pausedRemainingMs)
      };
      vibrate(12);
      persistSession();
      render();
      syncWakeLock();
      return;
    }

    session = {
      ...session,
      mode: "timer_running",
      targetAt: now + pausedRemainingMs,
      pausedRemainingMs: null
    };
    vibrate(12);
    persistSession();
    render();
    syncWakeLock();
    return;
  }

  if (session.mode === "stopwatch_running") {
    session = {
      ...session,
      mode: "stopwatch_paused",
      stopwatchElapsedMs: getStopwatchElapsedMs(now),
      stopwatchStartedAt: null
    };
    vibrate(10);
    persistSession();
    render();
    syncWakeLock();
    return;
  }

  if (session.mode === "stopwatch_paused") {
    session = {
      ...session,
      mode: "stopwatch_running",
      stopwatchStartedAt: now,
      stopwatchElapsedMs: session.stopwatchElapsedMs
    };
    vibrate(12);
    persistSession();
    render();
    syncWakeLock();
  }
}

function resetToSelecting() {
  const selectedIndex = getResetSelectedIndex();
  session = {
    ...defaultSession(),
    selectedIndex,
    selectedMinutes: selectedIndexToMinutes(selectedIndex)
  };
  app.classList.add("resetting");
  window.setTimeout(() => app.classList.remove("resetting"), 320);
  vibrate([8, 22, 8]);
  persistSession();
  render();
  syncWakeLock();
}

function startWheelSelectionSuppression() {
  suppressWheelSelection = true;
  suppressWheelSelectionStartedAt = performance.now();
  updateWheelSelectionSuppression();
}

function updateWheelSelectionSuppression() {
  window.clearTimeout(suppressWheelTimeout);

  if (performance.now() - suppressWheelSelectionStartedAt >= WHEEL_RESET_MAX_SUPPRESS_MS) {
    suppressWheelSelection = false;
    return;
  }

  suppressWheelTimeout = window.setTimeout(() => {
    suppressWheelSelection = false;
  }, WHEEL_RESET_QUIET_MS);
}

function getResetSelectedIndex() {
  if (session.mode === "timer_paused") {
    const remainingMs = session.pausedRemainingMs ?? session.selectedMinutes * 60_000;
    if (remainingMs > 0) {
      return clamp(Math.ceil(Math.floor(remainingMs / 1000) / 60), 1, MAX_INDEX);
    }
  }

  return session.selectedIndex;
}

function render() {
  const now = Date.now();
  const display = getDisplay(now);
  const secondKey = `${display.mode}:${display.label}:${display.hero}`;
  const tickChanged = lastSecondKey && lastSecondKey !== secondKey;
  const shouldPulse =
    tickChanged && display.focused && !display.paused && isRunningMode(display.mode);

  if (shouldPulse) {
    triggerTickPulse();
  } else if (display.paused) {
    stopTickPulse();
  }
  lastSecondKey = secondKey;

  app.dataset.mode = display.mode;
  app.dataset.visual = display.visual;
  app.dataset.focused = String(display.focused);
  app.dataset.paused = String(display.paused);
  app.dataset.wake = wakeLockState;

  const renderKey = [
    display.mode,
    display.visual,
    display.focused,
    display.paused,
    display.hero,
    display.label,
    display.announcement
  ].join("|");

  if (renderKey !== lastRenderKey) {
    app.innerHTML = display.focused ? renderFocused(display) : renderFeed(display);
    lastRenderKey = renderKey;
  }
}

function triggerTickPulse() {
  app.classList.remove("tick-pulse");
  void app.offsetWidth;
  app.classList.add("tick-pulse");
  window.clearTimeout(tickPulseTimeout);
  tickPulseTimeout = window.setTimeout(() => {
    app.classList.remove("tick-pulse");
  }, 260);
}

function stopTickPulse() {
  window.clearTimeout(tickPulseTimeout);
  app.classList.remove("tick-pulse");
}

function renderFeed(display: Display) {
  const items = [];
  const from = clamp(session.selectedIndex - FEED_RADIUS, MIN_INDEX, MAX_INDEX);
  const to = clamp(session.selectedIndex + FEED_RADIUS, MIN_INDEX, MAX_INDEX);

  for (let index = to; index >= from; index -= 1) {
    const distance = index - session.selectedIndex;
    const abs = Math.abs(distance);
    const y = getFeedOffset(distance);
    const scale = abs === 0 ? 1 : Math.max(0.24, 0.5 - (abs - 1) * 0.08);
    const opacity = abs === 0 ? 1 : Math.max(0.14, 0.64 - abs * 0.1);
    const blur = abs > 2 ? 1.2 : abs === 0 ? 0 : 0.25;
    const rotate = distance * -1.8;
    const value = index === 0 ? "+" : String(index);
    const current = index === session.selectedIndex ? "true" : "false";
    const className = index === 0 ? "feed-value plus" : "feed-value";

    items.push(`
      <div
        class="${className}"
        aria-current="${current}"
        style="
          --distance:${distance};
          --abs:${abs};
          --feed-y:${y};
          --feed-scale:${scale};
          --feed-rotate:${rotate}deg;
          transform: translate3d(-50%, calc(-50% + var(--feed-y)), 0) scale(var(--feed-scale)) rotateX(var(--feed-rotate));
          opacity:${opacity};
          filter: blur(${blur}px);
          z-index:${100 - abs};
        "
      >${value}</div>
    `);
  }

  return `
    <section class="stage" aria-label="Timer value selector">
      <div class="feed" role="listbox" aria-label="Timer values">${items.join("")}</div>
      <p class="sr-only">${display.announcement}</p>
    </section>
  `;
}

function getFeedOffset(distance: number) {
  const abs = Math.abs(distance);
  if (abs === 0) {
    return "0px";
  }

  const offset = `clamp(${abs * 13}rem, ${abs * 34}dvh, ${abs * 22}rem)`;
  return distance > 0 ? `calc(0px - ${offset})` : offset;
}

function renderFocused(display: Display) {
  return `
    <section class="stage focus-stage" aria-label="${display.announcement}">
      <div class="focus-shell">
        <div class="focus-number" aria-hidden="true">${display.hero}</div>
        <div class="sub-time" aria-hidden="true">${display.label}</div>
        <div class="pause-mark" aria-hidden="true"><span></span><span></span></div>
      </div>
      <p class="sr-only">${display.announcement}</p>
    </section>
  `;
}

type Display = {
  mode: Mode;
  visual: "timer" | "stopwatch";
  focused: boolean;
  paused: boolean;
  hero: string;
  label: string;
  announcement: string;
};

function getDisplay(now: number): Display {
  if (session.mode === "selecting") {
    const value = session.selectedIndex === 0 ? "stopwatch" : `${session.selectedIndex} minutes`;
    return {
      mode: "selecting",
      visual: session.selectedIndex === 0 ? "stopwatch" : "timer",
      focused: false,
      paused: false,
      hero: session.selectedIndex === 0 ? "+" : String(session.selectedIndex),
      label: "",
      announcement: `Selected ${value}`
    };
  }

  if (session.mode === "stopwatch_running" || session.mode === "stopwatch_paused") {
    const elapsedMs =
      session.mode === "stopwatch_paused"
        ? session.stopwatchElapsedMs
        : getStopwatchElapsedMs(now);
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const hero = totalSeconds < 60 ? String(totalSeconds) : String(Math.floor(totalSeconds / 60));
    const label = formatDuration(totalSeconds);

    return {
      mode: session.mode,
      visual: "stopwatch",
      focused: true,
      paused: session.mode === "stopwatch_paused",
      hero,
      label,
      announcement: `${label} stopwatch ${session.mode === "stopwatch_paused" ? "paused" : "running"}`
    };
  }

  const remainingMs =
    session.mode === "timer_paused"
      ? session.pausedRemainingMs ?? session.selectedMinutes * 60_000
      : getTimerRemainingMs(now);

  if (session.mode === "timer_running" && remainingMs <= 0) {
    session = {
      ...session,
      mode: "stopwatch_running",
      targetAt: null,
      pausedRemainingMs: null,
      stopwatchStartedAt: now,
      stopwatchElapsedMs: Math.abs(remainingMs)
    };
    persistSession();
    return getDisplay(now);
  }

  const durationSeconds = session.selectedMinutes * 60;
  const remainingSeconds = Math.min(durationSeconds - 1, Math.floor(remainingMs / 1000));
  const hero =
    remainingMs < 60_000 ? String(Math.max(1, remainingSeconds)) : String(Math.ceil(remainingSeconds / 60));
  const label = formatDuration(remainingSeconds);

  return {
    mode: session.mode,
    visual: "timer",
    focused: true,
    paused: session.mode === "timer_paused",
    hero,
    label,
    announcement: `${label} remaining ${session.mode === "timer_paused" ? "paused" : "running"}`
  };
}

function getTimerRemainingMs(now: number) {
  if (typeof session.targetAt !== "number") {
    return session.pausedRemainingMs ?? session.selectedMinutes * 60_000;
  }

  return session.targetAt - now;
}

function getStopwatchElapsedMs(now: number) {
  return session.stopwatchElapsedMs + Math.max(0, now - (session.stopwatchStartedAt ?? now));
}

function selectedIndexToMinutes(index: number) {
  return index === 0 ? 0 : index;
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isPaused() {
  return session.mode === "timer_paused" || session.mode === "stopwatch_paused";
}

function isRunningMode(mode: Mode) {
  return mode === "timer_running" || mode === "stopwatch_running";
}

function vibrate(pattern: number | number[]) {
  if ("vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
}

function startRenderLoop() {
  let lastFrame = 0;
  const frame = (time: number) => {
    if (time - lastFrame >= FRAME_MS) {
      lastFrame = time;
      if (session.mode !== "selecting") {
        render();
      }
    }

    rafId = window.requestAnimationFrame(frame);
  };

  if (rafId) {
    window.cancelAnimationFrame(rafId);
  }
  rafId = window.requestAnimationFrame(frame);
}

async function syncWakeLock() {
  const shouldHold =
    document.visibilityState === "visible" &&
    (session.mode === "timer_running" || session.mode === "stopwatch_running");

  if (!shouldHold) {
    if (wakeLock && !wakeLock.released) {
      await wakeLock.release().catch(() => undefined);
    }
    wakeLock = null;
    wakeLockState = "off";
    render();
    return;
  }

  if (!("wakeLock" in navigator) || wakeLockState === "pending" || wakeLock) {
    return;
  }

  try {
    wakeLockState = "pending";
    render();
    const manager = navigator.wakeLock as { request: (type: "screen") => Promise<WakeLockSentinel> };
    wakeLock = await manager.request("screen");
    wakeLockState = "on";
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      wakeLockState = "off";
      render();
    });
  } catch {
    wakeLock = null;
    wakeLockState = "blocked";
  }

  render();
}

function registerServiceWorker() {
  if (import.meta.env.DEV) {
    disableDevelopmentCaching();
    return;
  }

  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        warmServiceWorkerCache(registration);
      })
      .catch(() => undefined);
  });
}

function disableDevelopmentCaching() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister()))
      )
      .catch(() => undefined);
  }

  if ("caches" in window) {
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("visual-timer-"))
            .map((key) => caches.delete(key))
        )
      )
      .catch(() => undefined);
  }
}

function warmServiceWorkerCache(registration: ServiceWorkerRegistration) {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) {
    return;
  }

  worker.postMessage({
    type: "WARM_CACHE",
    urls: getCacheWarmUrls()
  });
}

function getCacheWarmUrls() {
  const urls = new Set(["/", "/index.html", "/manifest.webmanifest", "/icon.svg"]);

  const addUrl = (value: string) => {
    try {
      const url = new URL(value, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === "/sw.js") {
        return;
      }
      urls.add(`${url.pathname}${url.search}`);
    } catch {
      return;
    }
  };

  document.querySelectorAll<HTMLLinkElement>("link[href]").forEach((link) => addUrl(link.href));
  document.querySelectorAll<HTMLScriptElement>("script[src]").forEach((script) => addUrl(script.src));
  performance.getEntriesByType("resource").forEach((entry) => addUrl(entry.name));

  return [...urls];
}
