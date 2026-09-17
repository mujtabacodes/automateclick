if (window.__automateclickLoaded) {
  // Content script can be injected twice if the popup has to reload it.
} else {
window.__automateclickLoaded = true;

const DEFAULT_TARGET_CLICKS = 2;
const MIN_TARGET_CLICKS = 1;
const MAX_TARGET_CLICKS = 10;
const DEFAULT_DELAY_MS = 1000;

let isRecording = false;
let isAutomating = false;
let recordedClicks = [];
let recordingIndicator = null;
let targetClicks = DEFAULT_TARGET_CLICKS;

restoreState();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ success: false, error: error.message }));

  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "START_RECORDING":
      await startRecording();
      return { success: true };
    case "START_AUTOMATION":
      await startAutomation();
      return { success: true };
    case "STOP_AUTOMATION":
      await stopAll();
      return { success: true };
    default:
      return { success: false, error: "Unknown message." };
  }
}

async function restoreState() {
  const state = await chrome.storage.local.get({
    recordedClicks: [],
    recordingState: "idle",
    automationState: "idle",
    targetClicks: DEFAULT_TARGET_CLICKS
  });

  recordedClicks = state.recordedClicks || [];
  targetClicks = clampTargetClicks(state.targetClicks);

  if (state.recordingState === "recording" || state.automationState === "running") {
    await chrome.storage.local.set({
      recordingState: recordedClicks.length >= targetClicks ? "complete" : "idle",
      automationState: "idle"
    });
  }
}

function clampTargetClicks(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_TARGET_CLICKS;
  return Math.min(MAX_TARGET_CLICKS, Math.max(MIN_TARGET_CLICKS, Math.round(num)));
}

function getDelay(click) {
  const delay = Number(click?.delayMs);
  return Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_DELAY_MS;
}

async function startRecording() {
  if (isRecording) return;

  await stopAll();

  const state = await chrome.storage.local.get({ targetClicks: DEFAULT_TARGET_CLICKS });
  targetClicks = clampTargetClicks(state.targetClicks);

  isRecording = true;
  recordedClicks = [];

  await chrome.storage.local.set({
    recordedClicks,
    recordingState: "recording",
    automationState: "idle"
  });

  createRecordingIndicator();
  document.addEventListener("click", handleRecordingClick, true);
}

async function handleRecordingClick(event) {
  if (!isRecording) return;

  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("#automateclick-recording-indicator")) return;

  const clickable = getClickable(target);
  const click = describeClick(clickable, event);

  recordedClicks.push(click);
  updateRecordingIndicator();

  await chrome.storage.local.set({ recordedClicks });

  if (recordedClicks.length >= targetClicks) {
    await stopRecording();
  }
}

async function stopRecording() {
  isRecording = false;
  document.removeEventListener("click", handleRecordingClick, true);
  removeRecordingIndicator();

  await chrome.storage.local.set({
    recordedClicks,
    recordingState: recordedClicks.length >= targetClicks ? "complete" : "idle"
  });
}

async function startAutomation() {
  if (isAutomating) return;

  const result = await chrome.storage.local.get({
    recordedClicks: [],
    targetClicks: DEFAULT_TARGET_CLICKS
  });
  const clicks = result.recordedClicks;
  const requiredClicks = clampTargetClicks(result.targetClicks);

  if (!clicks || clicks.length < requiredClicks) {
    throw new Error(
      `Record ${requiredClicks} click${requiredClicks === 1 ? "" : "s"} before starting automation.`
    );
  }

  isAutomating = true;
  await chrome.storage.local.set({ automationState: "running" });

  runAutomation();
}

async function runAutomation() {
  try {
    while (isAutomating) {
      const result = await chrome.storage.local.get({ recordedClicks: [] });
      const clicks = result.recordedClicks || [];

      if (!clicks.length) break;

      for (let i = 0; i < clicks.length && isAutomating; i++) {
        const clicked = performClick(clicks[i]);
        if (!clicked) {
          isAutomating = false;
          break;
        }

        await sleep(getDelay(clicks[i]));
      }
    }
  } finally {
    isAutomating = false;
    await chrome.storage.local.set({ automationState: "idle" });
  }
}

async function stopAll() {
  isAutomating = false;

  if (isRecording) {
    await stopRecording();
  } else {
    await chrome.storage.local.set({
      recordingState: "idle",
      automationState: "idle"
    });
  }
}

function performClick(click) {
  const element = findElement(click);

  if (!element) {
    console.log("automateclick: no element found for", click);
    return false;
  }

  const clickable = getClickable(element);
  clickable.scrollIntoView({ block: "center", inline: "nearest" });
  clickable.click();
  return true;
}

function findElement(click) {
  const selectors = [];

  if (click.replaySelector) selectors.push(click.replaySelector);
  if (click.selector) selectors.push(click.selector);

  for (const selector of selectors) {
    const match = firstVisible(querySafe(selector));
    if (match) return match;
  }

  if (click.ariaLabel) {
    const ariaMatch = firstVisible(
      querySafe(`[aria-label="${cssAttrEscape(click.ariaLabel)}"]`)
    );
    if (ariaMatch) return ariaMatch;
  }

  if (click.text) {
    const textMatch = findByText(click.text);
    if (textMatch) return textMatch;
  }

  return document.elementFromPoint(click.x, click.y);
}

function describeClick(element, event) {
  const text = getElementText(element);
  const ariaLabel = element.getAttribute("aria-label");
  const selector = buildSelector(element);

  return {
    x: event.clientX,
    y: event.clientY,
    selector,
    replaySelector: buildReplaySelector(element),
    tagName: element.tagName.toLowerCase(),
    ariaLabel,
    text,
    label: ariaLabel || text || selector,
    delayMs: DEFAULT_DELAY_MS
  };
}

function buildSelector(element) {
  if (element.id) {
    return `#${cssIdEscape(element.id)}`;
  }

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    return `${element.tagName.toLowerCase()}[aria-label="${cssAttrEscape(ariaLabel)}"]`;
  }

  return getCssPath(element);
}

function buildReplaySelector(element) {
  const ariaLabel = element.getAttribute("aria-label");
  if (!ariaLabel) return "";

  const prefix = ariaLabel.split(/\s+/).slice(0, 3).join(" ");
  if (!prefix) return "";

  return `${element.tagName.toLowerCase()}[aria-label*="${cssAttrEscape(prefix)}" i]`;
}

function getCssPath(element) {
  const parts = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
    if (current.id) {
      parts.unshift(`#${cssIdEscape(current.id)}`);
      break;
    }

    let selector = current.tagName.toLowerCase();
    const parent = current.parentElement;

    if (parent) {
      const siblings = [...parent.children].filter(
        (child) => child.tagName === current.tagName
      );

      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }

    parts.unshift(selector);
    current = current.parentElement;
  }

  return parts.join(" > ");
}

function getClickable(element) {
  return (
    element.closest("button, a, [role='button'], [role='menuitem'], [role='option']") ||
    element
  );
}

function getElementText(element) {
  return (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function findByText(text) {
  const clickables = document.querySelectorAll(
    "button, a, [role='button'], [role='menuitem'], [role='option'], li"
  );

  const matches = [...clickables].filter((element) => {
    const value = getElementText(element);
    return value === text || value.startsWith(text);
  });

  return firstVisible(matches) || matches[0] || null;
}

function querySafe(selector) {
  try {
    return [...document.querySelectorAll(selector)];
  } catch (error) {
    return [];
  }
}

function firstVisible(elements) {
  return elements.find(isVisible) || elements[0] || null;
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight
  );
}

function cssIdEscape(value) {
  if (window.CSS?.escape) {
    return CSS.escape(value);
  }

  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function cssAttrEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function createRecordingIndicator() {
  removeRecordingIndicator();

  recordingIndicator = document.createElement("div");
  recordingIndicator.id = "automateclick-recording-indicator";

  Object.assign(recordingIndicator.style, {
    position: "fixed",
    top: "20px",
    right: "20px",
    zIndex: "2147483647",
    padding: "10px 14px",
    background: "#22c55e",
    color: "#ffffff",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: "600",
    fontFamily: "Arial, sans-serif",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
    pointerEvents: "none"
  });

  recordingIndicator.textContent = `Recording click 1 of ${targetClicks}`;
  document.documentElement.appendChild(recordingIndicator);
}

function updateRecordingIndicator() {
  if (!recordingIndicator) return;
  recordingIndicator.textContent = `Recording click ${Math.min(recordedClicks.length + 1, targetClicks)} of ${targetClicks}`;
}

function removeRecordingIndicator() {
  if (recordingIndicator) {
    recordingIndicator.remove();
    recordingIndicator = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

}
