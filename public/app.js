document.querySelector("#mcp-url").textContent = `${window.location.origin}/mcp`;
const refreshIntervalSeconds = 15;
const refreshStatus = document.querySelector("#refresh-status");
const metadataStatus = document.querySelector("#metadata-status");
const backfillStatus = document.querySelector("#backfill-status");
const syncNamesButton = document.querySelector("#sync-names");
const initialBackfillButton = document.querySelector("#initial-backfill");
const discoverConversationsButton = document.querySelector("#discover-conversations");
const discoveryStatus = document.querySelector("#discovery-status");
const settingsForm = document.querySelector("#settings-form");
const settingsStatus = document.querySelector("#settings-status");
const settingsState = document.querySelector("#settings-state");
const testSettingsButton = document.querySelector("#test-settings");
const saveSettingsButton = settingsForm.querySelector("button[type=submit]");
const rotateMcpTokenButton = document.querySelector("#rotate-mcp-token");
const mcpTokenResult = document.querySelector("#mcp-token-result");
const mcpToken = document.querySelector("#mcp-token");
let nextRefreshAt = Date.now(); let refreshInFlight = false;

function renderRefreshStatus(message) { refreshStatus.textContent = message; }
function resetCountdown() { nextRefreshAt = Date.now() + refreshIntervalSeconds * 1000; }
function updateCountdown() { if (!refreshInFlight) renderRefreshStatus(`Auto-refresh in ${Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000))}s`); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function formatReference(name, id) { return name && name !== id ? `<strong class="reference-name">${escapeHtml(name)}</strong><code>${escapeHtml(id)}</code>` : `<code>${escapeHtml(id)}</code>`; }
function time(value) { return value ? new Date(value).toLocaleString() : "Never"; }
function progressPercent(acknowledged, total) { return total ? Math.round((acknowledged / total) * 100) : 0; }
function datetimeInput(date) { const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function formValues() { return Object.fromEntries(new FormData(settingsForm)); }
function showMcpToken(token) { mcpToken.textContent = token; mcpTokenResult.hidden = false; }
function renderSettings(settings) {
  settingsState.textContent = settings.configured ? "Observer configured" : "Setup required";
  settingsState.classList.toggle("incomplete", !settings.configured);
  const numbers = ["threadSettleSeconds", "messageRetentionDays", "rawEventRetentionDays", "backfillRequestIntervalSeconds", "downtimeSuggestionSeconds"];
  numbers.forEach((name) => { const field = settingsForm.elements.namedItem(name); if (field && document.activeElement !== field) field.value = settings[name]; });
  if (!settings.configured) settingsStatus.textContent = "Enter an App Token and either a user or bot token, test them, then save. An MCP token will be generated on first save.";
  else settingsStatus.textContent = `Saved securely in this observer database. App token: ${settings.slackAppTokenConfigured ? "configured" : "missing"}; user token: ${settings.slackUserTokenConfigured ? "configured" : "not configured"}; bot token: ${settings.slackBotTokenConfigured ? "configured" : "not configured"}. Leave secret fields blank to keep them.`;
  [syncNamesButton, initialBackfillButton, document.querySelector("#target-form button"), document.querySelector("#manual-backfill-form button")].forEach((button) => { button.disabled = !settings.configured; });
  rotateMcpTokenButton.disabled = !settings.mcpAuthTokenConfigured;
}

async function loadDashboard() {
  if (refreshInFlight) return;
  refreshInFlight = true; renderRefreshStatus("Refreshing observer data…");
  const [statusResponse, channelsResponse, backfillResponse] = await Promise.all([fetch("/dashboard/status"), fetch("/dashboard/channels"), fetch("/dashboard/backfill")]);
  if (!statusResponse.ok || !channelsResponse.ok || !backfillResponse.ok) throw new Error("Dashboard endpoints are unavailable.");
  const [status, { channels }, { jobs, suggestions }] = await Promise.all([statusResponse.json(), channelsResponse.json(), backfillResponse.json()]);
  const socket = status.socketMode;
  renderSettings(status.settings);
  discoverConversationsButton.disabled = !status.settings.configured || !status.userTokenConfigured;
  if (!status.userTokenConfigured) discoveryStatus.textContent = "Configure a Slack user token in Settings to enable this action.";
  document.querySelector("#stats").innerHTML = [["Slack socket", socket.state], ["Stored raw events", status.events], ["Messages", status.messages], ["Targets", status.channels], ["Earliest context", status.earliestMessageAt ? time(status.earliestMessageAt) : "None"]].map(([label, value]) => `<article class="stat"><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  document.querySelector("#consumer-progress").innerHTML = status.consumers.length ? status.consumers.map((consumer) => { const progress = progressPercent(consumer.acknowledgedMessages, consumer.totalMessages); return `<tr><td><code>${escapeHtml(consumer.consumerId)}</code></td><td>${consumer.acknowledgedMessages} / ${consumer.totalMessages}</td><td>${consumer.pendingMessages}</td><td><div class="progress" aria-label="${progress}% consumed"><span style="width:${progress}%"></span></div><small>${progress}%</small></td><td>${time(consumer.lastAcknowledgedAt)}</td></tr>`; }).join("") : "<tr><td colspan=\"5\" class=\"muted\">No agent acknowledgement yet.</td></tr>";
  document.querySelector("#channels").innerHTML = channels.length ? channels.map((channel) => `<tr><td>${formatReference(channel.workspaceName, channel.workspaceId)}</td><td>${formatReference(channel.channelName, channel.channelId)}</td><td>${channel.messageCount}</td><td>${time(channel.lastObservedAt)}</td></tr>`).join("") : "<tr><td colspan=\"4\" class=\"muted\">No target channels yet.</td></tr>";
  document.querySelector("#backfill-jobs").innerHTML = jobs.length ? jobs.map((job) => `<tr><td>#${job.id} · ${escapeHtml(job.kind)}</td><td>${time(job.requestedStartAt)}<br>to ${time(job.requestedEndAt)}</td><td>${job.completedTasks}/${job.totalTasks} tasks<br><small>${job.channels} channels · ${job.replyTasks} reply checks</small></td><td>${escapeHtml(job.state)}</td><td>${job.lastError ? `<span class=\"error\">${escapeHtml(job.lastError)}</span>` : ""}${["queued", "running"].includes(job.state) ? `<button class=\"secondary tiny\" data-cancel-job=\"${job.id}\">Cancel</button>` : ""}</td></tr>`).join("") : "<tr><td colspan=\"5\" class=\"muted\">No backfill jobs yet.</td></tr>";
  document.querySelector("#backfill-suggestions").innerHTML = suggestions.length ? `<div class="suggestions"><strong>Possible Socket Mode gaps</strong>${suggestions.map((item) => `<p>${time(item.startAt)} to ${time(item.endAt)} <button class="secondary tiny" data-accept-suggestion="${item.id}">Queue fetch</button><button class="secondary tiny" data-dismiss-suggestion="${item.id}">Dismiss</button></p>`).join("")}</div>` : "";
  backfillStatus.textContent = status.nextBackfillRequestAt && new Date(status.nextBackfillRequestAt) > new Date() ? `Next Slack history/thread request: ${time(status.nextBackfillRequestAt)}.` : "Queue is ready for its next Slack request.";
  refreshInFlight = false; resetCountdown(); updateCountdown();
}
async function refreshDashboard() { try { await loadDashboard(); } catch (cause) { refreshInFlight = false; resetCountdown(); renderRefreshStatus(`Refresh failed; retrying in ${refreshIntervalSeconds}s`); console.error(cause); } }
async function post(url, body) { const response = await fetch(url, { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) throw new Error(await response.text()); return response.status === 204 ? undefined : response.json(); }

document.querySelector("#refresh").addEventListener("click", refreshDashboard);
testSettingsButton.addEventListener("click", async () => { testSettingsButton.disabled = true; settingsStatus.textContent = "Testing Slack credentials without saving or starting the observer…"; try { await post("/dashboard/settings/test", formValues()); settingsStatus.textContent = "Slack credentials are valid. Save to start observing."; } catch (cause) { settingsStatus.textContent = "Connection test failed. Check the tokens and Slack app scopes."; console.error(cause); } finally { testSettingsButton.disabled = false; } });
settingsForm.addEventListener("submit", async (event) => { event.preventDefault(); saveSettingsButton.disabled = true; settingsStatus.textContent = "Saving settings and starting observer services…"; try { const result = await post("/dashboard/settings", formValues()); if (result.mcpAuthToken) showMcpToken(result.mcpAuthToken); settingsForm.querySelectorAll("input[type=password]").forEach((field) => { field.value = ""; }); settingsStatus.textContent = "Settings saved. Observer services now use the new configuration."; await refreshDashboard(); } catch (cause) { settingsStatus.textContent = "Settings could not be saved. Check the required values."; console.error(cause); } finally { saveSettingsButton.disabled = false; } });
rotateMcpTokenButton.addEventListener("click", async () => { if (!window.confirm("Rotate the MCP token? Connected agents must be updated immediately.")) return; rotateMcpTokenButton.disabled = true; try { const result = await post("/dashboard/settings/mcp-token"); showMcpToken(result.mcpAuthToken); settingsStatus.textContent = "MCP token rotated. Update connected agents now."; await refreshDashboard(); } catch (cause) { settingsStatus.textContent = "MCP token could not be rotated."; console.error(cause); } finally { rotateMcpTokenButton.disabled = false; } });
syncNamesButton.addEventListener("click", async () => { syncNamesButton.disabled = true; metadataStatus.textContent = "Queueing name lookup…"; try { const { queued } = await post("/dashboard/metadata/sync"); metadataStatus.textContent = queued ? `Name lookup queued for ${queued} channel${queued === 1 ? "" : "s"}.` : "No observed channels to synchronize."; await refreshDashboard(); } catch (cause) { metadataStatus.textContent = "Name synchronization could not be queued."; console.error(cause); } finally { syncNamesButton.disabled = false; } });
discoverConversationsButton.addEventListener("click", async () => { discoverConversationsButton.disabled = true; discoveryStatus.textContent = "Reading the user-visible conversation list…"; try { const { conversations } = await post("/dashboard/conversations/discover"); discoveryStatus.textContent = `${conversations} user-visible conversation${conversations === 1 ? "" : "s"} registered. Use the index action to fetch history.`; await refreshDashboard(); } catch (cause) { discoveryStatus.textContent = "User-visible conversations could not be synchronized."; console.error(cause); } finally { discoverConversationsButton.disabled = false; } });
document.querySelector("#target-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button"); button.disabled = true; try { await post("/dashboard/targets", { workspaceId: document.querySelector("#target-workspace").value, channelId: document.querySelector("#target-channel").value }); form.reset(); await refreshDashboard(); } catch (cause) { metadataStatus.textContent = "Channel could not be added."; console.error(cause); } finally { button.disabled = false; } });
initialBackfillButton.addEventListener("click", async () => { initialBackfillButton.disabled = true; backfillStatus.textContent = "Creating complete 30-day index job…"; try { await post("/dashboard/backfill/initial"); await refreshDashboard(); } catch (cause) { backfillStatus.textContent = "Initial index could not be queued."; console.error(cause); } finally { initialBackfillButton.disabled = false; } });
document.querySelector("#manual-backfill-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button"); button.disabled = true; try { await post("/dashboard/backfill/manual", { startAt: new Date(document.querySelector("#backfill-start").value).toISOString(), endAt: new Date(document.querySelector("#backfill-end").value).toISOString() }); await refreshDashboard(); } catch (cause) { backfillStatus.textContent = "Backfill window could not be queued."; console.error(cause); } finally { button.disabled = false; } });
document.addEventListener("click", async (event) => { const target = event.target; if (!(target instanceof HTMLButtonElement)) return; try { if (target.dataset.cancelJob) await post(`/dashboard/backfill/${target.dataset.cancelJob}/cancel`); if (target.dataset.acceptSuggestion) await post(`/dashboard/backfill/suggestions/${target.dataset.acceptSuggestion}/accept`); if (target.dataset.dismissSuggestion) await post(`/dashboard/backfill/suggestions/${target.dataset.dismissSuggestion}/dismiss`); if (target.dataset.cancelJob || target.dataset.acceptSuggestion || target.dataset.dismissSuggestion) await refreshDashboard(); } catch (cause) { backfillStatus.textContent = "Backfill action could not be completed."; console.error(cause); } });
document.querySelector("#backfill-start").value = datetimeInput(new Date(Date.now() - 24 * 60 * 60 * 1000));
document.querySelector("#backfill-end").value = datetimeInput(new Date());
setInterval(() => { updateCountdown(); if (!refreshInFlight && Date.now() >= nextRefreshAt) void refreshDashboard(); }, 1000);
void refreshDashboard();
