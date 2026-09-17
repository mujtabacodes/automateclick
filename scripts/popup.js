const recordBtn = document.getElementById("record-btn");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const statusEl = document.getElementById("status");
const statusDescription = document.getElementById("status-description");
const statusDot = document.getElementById("status-dot");
const actionCount = document.getElementById("action-count");
const actionsList = document.getElementById("actions-list");
const targetStepper = document.getElementById("target-stepper");
const targetDecreaseBtn = document.getElementById("target-decrease");
const targetIncreaseBtn = document.getElementById("target-increase");
const clearBtn = document.getElementById("clear-btn");

const DEFAULT_TARGET_CLICKS = 2;
const MIN_TARGET_CLICKS = 1;
const MAX_TARGET_CLICKS = 10;
const DEFAULT_DELAY_MS = 1000;

init();

async function init() {
  recordBtn.addEventListener("click", onRecord);
  startBtn.addEventListener("click", onStart);
  stopBtn.addEventListener("click", onStop);
  targetDecreaseBtn.addEventListener("click", () => onAdjustTarget(-1));
  targetIncreaseBtn.addEventListener("click", () => onAdjustTarget(1));
  clearBtn.addEventListener("click", onClear);
  actionsList.addEventListener("change", onDelayChange);
  actionsList.addEventListener("input", onDelayInput);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    refreshUi();
  });

  await refreshUi();
}

async function onAdjustTarget(delta) {
  const state = await chrome.storage.local.get({ targetClicks: DEFAULT_TARGET_CLICKS });
  const next = clampTargetClicks((state.targetClicks ?? DEFAULT_TARGET_CLICKS) + delta);
  await chrome.storage.local.set({ targetClicks: next });
  await refreshUi();
}

async function onClear() {
  setBusy(true);

  try {
    await chrome.storage.local.set({
      recordedClicks: [],
      recordingState: "idle"
    });
    await refreshUi();
  } catch (error) {
    await refreshUi();
    setStatus("Error", error.message, "error");
  }
}

function onDelayInput(event) {
  const input = event.target;
  if (!input.classList.contains("action-delay")) return;
  resizeDelayInput(input);
}

function resizeDelayInput(input) {
  input.style.width = `${Math.max(String(input.value).length, 2) + 1}ch`;
}

async function onDelayChange(event) {
  const input = event.target;
  if (!input.classList.contains("action-delay")) return;

  const index = Number(input.dataset.index);
  const state = await chrome.storage.local.get({ recordedClicks: [] });
  const clicks = state.recordedClicks || [];
  if (!clicks[index]) return;

  const value = Math.max(0, Math.round(Number(input.value)) || 0);
  input.value = value;
  resizeDelayInput(input);
  clicks[index] = { ...clicks[index], delayMs: value };

  await chrome.storage.local.set({ recordedClicks: clicks });
}

function clampTargetClicks(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_TARGET_CLICKS;
  return Math.min(MAX_TARGET_CLICKS, Math.max(MIN_TARGET_CLICKS, Math.round(num)));
}

async function onRecord() {
  setBusy(true);

  try {
    const response = await sendToActiveTab({ type: "START_RECORDING" });

    if (!response?.success) {
      throw new Error(response?.error || "Could not start recording.");
    }

    await refreshUi();
  } catch (error) {
    await refreshUi();
    setStatus("Error", error.message, "error");
  }
}

async function onStart() {
  setBusy(true);

  try {
    const response = await sendToActiveTab({ type: "START_AUTOMATION" });

    if (!response?.success) {
      throw new Error(response?.error || "Could not start automation.");
    }

    await refreshUi();
  } catch (error) {
    await refreshUi();
    setStatus("Error", error.message, "error");
  }
}

async function onStop() {
  setBusy(true);

  try {
    await sendToActiveTab({ type: "STOP_AUTOMATION" });
    await chrome.storage.local.set({
      recordingState: "idle",
      automationState: "idle"
    });
    await refreshUi();
  } catch (error) {
    await refreshUi();
    setStatus("Error", error.message, "error");
  }
}

async function refreshUi() {
  const state = await chrome.storage.local.get({
    recordedClicks: [],
    recordingState: "idle",
    automationState: "idle",
    targetClicks: DEFAULT_TARGET_CLICKS
  });

  const clicks = state.recordedClicks || [];
  const recording = state.recordingState === "recording";
  const automating = state.automationState === "running";
  const targetClicks = clampTargetClicks(state.targetClicks);

  renderActions(clicks, targetClicks, { recording, automating });

  if (automating) {
    setStatus("Running", "Repeating the recorded clicks on this page.", "running");
  } else if (recording) {
    setStatus(
      "Recording",
      `Click ${targetClicks} element${targetClicks === 1 ? "" : "s"} on the page. Reopen this popup when done.`,
      "recording"
    );
  } else if (clicks.length >= targetClicks) {
    setStatus("Ready", "Start automation to replay the recorded clicks.", "ready");
  } else {
    setStatus("Ready", "Record your clicks to get started.", "idle");
  }

  recordBtn.disabled = recording || automating;
  recordBtn.textContent = recording ? "Recording..." : "Record Clicks";
  startBtn.disabled = recording || automating || clicks.length < targetClicks;
  stopBtn.disabled = !recording && !automating;

  targetStepper.hidden = clicks.length > 0;
  targetDecreaseBtn.disabled = recording || automating || targetClicks <= MIN_TARGET_CLICKS;
  targetIncreaseBtn.disabled = recording || automating || targetClicks >= MAX_TARGET_CLICKS;

  clearBtn.hidden = clicks.length === 0;
  clearBtn.disabled = recording || automating;
}

function renderActions(clicks, targetClicks, { recording, automating } = {}) {
  actionCount.textContent = `${clicks.length}/${targetClicks}`;

  if (!clicks.length) {
    actionsList.innerHTML = `<p class="empty-state">No actions recorded yet.</p>`;
    return;
  }

  const disableDelay = recording || automating;

  actionsList.innerHTML = clicks
    .map((click, index) => {
      const label = click.label || click.text || click.selector || `Click at ${click.x}, ${click.y}`;
      const delay = Number.isFinite(click.delayMs) ? click.delayMs : DEFAULT_DELAY_MS;
      return `
        <div class="action-item">
          <span class="action-index">${index + 1}</span>
          <span class="action-label">${escapeHtml(label)}</span>
          <span class="action-delay-wrap">
            <input
              type="number"
              class="action-delay"
              data-index="${index}"
              min="0"
              step="100"
              value="${delay}"
              style="width: ${String(delay).length + 1}ch"
              title="Delay after this action (ms)"
              aria-label="Delay after action ${index + 1} in milliseconds"
              ${disableDelay ? "disabled" : ""}
            />
            <span class="action-delay-unit">ms</span>
          </span>
        </div>
      `;
    })
    .join("");
}

function setStatus(title, description, mode) {
  statusEl.textContent = title;
  statusDescription.textContent = description;
  statusDot.className = `status-dot ${mode}`;
}

function setBusy(isBusy) {
  if (!isBusy) return;
  recordBtn.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = true;
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  if (!isInjectableUrl(tab.url)) {
    throw new Error("Open a normal webpage first. This page cannot be automated.");
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scripts/content.js"]
    });

    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

function isInjectableUrl(url) {
  if (!url) return false;
  return /^(https?|file):/.test(url);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
