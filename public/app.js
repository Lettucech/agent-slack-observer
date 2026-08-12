document.querySelector("#mcp-url").textContent = `${window.location.origin}/mcp`;
const refreshIntervalSeconds = 15;
const refreshStatus = document.querySelector("#refresh-status");
const metadataStatus = document.querySelector("#metadata-status");
const syncNamesButton = document.querySelector("#sync-names");
let nextRefreshAt = Date.now();
let refreshInFlight = false;

function renderRefreshStatus(message) { refreshStatus.textContent = message; }

function resetCountdown() { nextRefreshAt = Date.now() + refreshIntervalSeconds * 1000; }

function updateCountdown() {
  if (refreshInFlight) return;
  const remaining = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  renderRefreshStatus(`Auto-refresh in ${remaining}s`);
}

async function loadDashboard() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  renderRefreshStatus("Refreshing observer data…");
  const [statusResponse, channelsResponse] = await Promise.all([fetch("/dashboard/status"), fetch("/dashboard/channels")]);
  if (!statusResponse.ok || !channelsResponse.ok) throw new Error("Dashboard endpoints are unavailable.");
  const status = await statusResponse.json();
  const { channels } = await channelsResponse.json();
  const socket = status.socketMode;
  document.querySelector("#stats").innerHTML = [
    ["Slack socket", socket.state], ["Stored events", status.events], ["Messages", status.messages], ["Last received", status.lastReceivedAt ? new Date(status.lastReceivedAt).toLocaleString() : "Never"],
  ].map(([label, value]) => `<article class="stat"><span>${label}</span><strong>${value}</strong></article>`).join("");
  document.querySelector("#channels").innerHTML = channels.length ? channels.map((channel) => `<tr><td>${formatReference(channel.workspaceName, channel.workspaceId)}</td><td>${formatReference(channel.channelName, channel.channelId)}</td><td>${channel.messageCount}</td><td>${new Date(channel.lastObservedAt).toLocaleString()}</td></tr>`).join("") : "<tr><td colspan=\"4\" class=\"muted\">No messages observed yet.</td></tr>";
  refreshInFlight = false;
  resetCountdown();
  updateCountdown();
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function formatReference(name, id) { return name && name !== id ? `<strong class="reference-name">${escapeHtml(name)}</strong><code>${escapeHtml(id)}</code>` : `<code>${escapeHtml(id)}</code>`; }
async function refreshDashboard() {
  try { await loadDashboard(); }
  catch (cause) {
    refreshInFlight = false;
    resetCountdown();
    renderRefreshStatus(`Refresh failed; retrying in ${refreshIntervalSeconds}s`);
    console.error(cause);
  }
}

document.querySelector("#refresh").addEventListener("click", refreshDashboard);
syncNamesButton.addEventListener("click", async () => {
  syncNamesButton.disabled = true;
  metadataStatus.textContent = "Queueing name lookup…";
  try {
    const response = await fetch("/dashboard/metadata/sync", { method: "POST" });
    if (!response.ok) throw new Error("Name synchronization endpoint is unavailable.");
    const { queued } = await response.json();
    metadataStatus.textContent = queued ? `Name lookup queued for ${queued} channel${queued === 1 ? "" : "s"}.` : "No observed channels to synchronize.";
    setTimeout(() => void refreshDashboard(), 1500);
  } catch (cause) {
    metadataStatus.textContent = "Name synchronization could not be queued.";
    console.error(cause);
  } finally { syncNamesButton.disabled = false; }
});
setInterval(() => {
  updateCountdown();
  if (!refreshInFlight && Date.now() >= nextRefreshAt) void refreshDashboard();
}, 1000);
void refreshDashboard();
