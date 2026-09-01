const refreshIntervalSeconds = 15;
const pageTitles = new Set(["overview", "operations", "agents"]);
const readScopes = ["channels:read", "channels:history", "groups:read", "groups:history", "im:read", "im:history", "mpim:read", "mpim:history", "team:read", "users:read"];
const eventNames = ["message.channels", "message.groups", "message.im", "message.mpim"];

const $ = (selector) => document.querySelector(selector);
const dashboard = $("#dashboard");
const onboarding = $("#onboarding");
const onboardingChoice = $("#onboarding-choice");
const onboardingConfig = $("#onboarding-config");
const onboardingSuccess = $("#onboarding-success");
const onboardingForm = $("#onboarding-form");
const onboardingStatus = $("#onboarding-status");
const settingsLayer = $("#settings-layer");
const settingsDrawer = $("#settings-drawer");
const settingsForm = $("#settings-form");
const settingsStatus = $("#settings-status");
const settingsToggle = $("#settings-toggle");
const confirmDialog = $("#confirm-dialog");
const confirmCopy = $("#confirm-copy");
const navButtons = [...document.querySelectorAll("[data-view]")];
const viewPanels = [...document.querySelectorAll("[data-view-panel]")];
let nextRefreshAt = Date.now();
let refreshInFlight = false;
let lastSettingsOpener = null;
let onboardingTokenType = null;

$("#mcp-url").textContent = `${window.location.origin}/mcp`;

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function formatReference(name, id) { return name && name !== id ? `<strong class="reference-name">${escapeHtml(name)}</strong><code>${escapeHtml(id)}</code>` : `<code>${escapeHtml(id)}</code>`; }
function conversationTypeLabel(type) { return ({ public_channel: "Public", private_channel: "Private", im: "DM", mpim: "Group DM", unknown: "Unknown" })[type] ?? "Unknown"; }
function conversationTitle(channel) {
  const name = channel.channelName ?? channel.channelId;
  if (channel.conversationType === "im") return `DM · ${name}`;
  if (channel.conversationType === "mpim") return `Group DM · ${name}`;
  if (channel.conversationType === "public_channel" || channel.conversationType === "private_channel") return name === channel.channelId ? name : `# ${name}`;
  return name;
}
function conversationIcon(type) { return ({ public_channel: "#", private_channel: "⌁", im: "@", mpim: "◎", unknown: "?" })[type] ?? "?"; }
function formatConversation(channel) {
  const type = channel.conversationType ?? "unknown";
  const title = conversationTitle(channel);
  const channelId = escapeHtml(channel.channelId);
  return `<div class="conversation-reference"><span class="conversation-icon type-${escapeHtml(type)}" aria-hidden="true">${conversationIcon(type)}</span><strong class="reference-name" title="${escapeHtml(title)}">${escapeHtml(title)}</strong><button class="channel-id-button" data-copy-channel-id="${channelId}" type="button" aria-label="Copy ${escapeHtml(conversationTypeLabel(type))} ID ${channelId}" title="Copy ID ${channelId}">⧉<span class="visually-hidden">Copy ID</span></button></div>`;
}
function coverageSwitch(channel) {
  const enabled = Boolean(channel.enabled);
  const state = enabled ? "on" : "off";
  const label = enabled ? "History recovery on" : "History recovery off";
  return `<button class="coverage-switch is-${state}" data-set-coverage="${enabled ? "false" : "true"}" data-workspace-id="${escapeHtml(channel.workspaceId)}" data-channel-id="${escapeHtml(channel.channelId)}" type="button" role="switch" aria-checked="${enabled}" aria-label="${label}" title="${label}"><span aria-hidden="true"></span><span class="visually-hidden">${label}</span></button>`;
}
function time(value) { return value ? new Date(value).toLocaleString() : "Never"; }
function shortTime(value) { return value ? new Date(value).toLocaleString() : "None yet"; }
function progressPercent(acknowledged, total) { return total ? Math.round((acknowledged / total) * 100) : 0; }
function datetimeInput(date) { const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function resetCountdown() { nextRefreshAt = Date.now() + refreshIntervalSeconds * 1000; }
function updateRefreshStatus() { if (!refreshInFlight) $("#refresh-status").textContent = `Updates in ${Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000))}s`; }
function formValues(form) { return Object.fromEntries(new FormData(form)); }
function setPending(button, pending, label) {
  if (!button) return;
  button.dataset.idleLabel ??= button.textContent;
  button.disabled = pending;
  button.classList.toggle("is-pending", pending);
  button.setAttribute("aria-busy", String(pending));
  button.textContent = pending ? label : button.dataset.idleLabel;
}

function tokenSummary(type) { return type === "user" ? "A User Token can explicitly discover public channels, private channels, DMs, and group DMs visible to the authorising user." : "A Bot Token is limited to conversations where the installed bot has access. It cannot run user-visible conversation discovery."; }
function scopeGuide(type) {
  const tokenLabel = type === "user" ? "User Token" : "Bot Token";
  const access = type === "user" ? "Choose this when discovery should use the authorising user’s own Slack visibility." : "Add the installed bot to each channel it should observe.";
  return `<h3>${tokenLabel} setup</h3><p>${access} Add <code>connections:write</code> to the App-Level Token, then add these OAuth scopes to the selected ${type} token.</p><ul>${readScopes.map((scope) => `<li><code>${scope}</code></li>`).join("")}</ul><p><code>users:read</code> lets Observer label DM and group-DM participants in this local dashboard; it does not read email addresses.</p><p>Enable Socket Mode and subscribe to only the matching message events you intend to observe.</p><ul class="event-list">${eventNames.map((event) => `<li><code>${event}</code></li>`).join("")}</ul><p>Reinstall or re-authorise the app after changing scopes. Scope only the conversation types you actually need.</p>`;
}
function setSetupProgress(step) { document.querySelectorAll("[data-setup-step]").forEach((item) => item.classList.toggle("is-active", Number(item.dataset.setupStep) === step)); }
function configureOnboardingToken(type) {
  onboardingTokenType = type;
  $("#onboarding-token-summary").textContent = tokenSummary(type);
  $("#onboarding-scope-guide").innerHTML = scopeGuide(type);
  onboardingForm.elements.namedItem("slackReadTokenType").value = type;
  const usingUser = type === "user";
  $("#onboarding-user-token-field").hidden = !usingUser;
  $("#onboarding-bot-token-field").hidden = usingUser;
  onboardingForm.elements.namedItem("slackUserToken").disabled = !usingUser;
  onboardingForm.elements.namedItem("slackUserToken").required = usingUser;
  onboardingForm.elements.namedItem("slackBotToken").disabled = usingUser;
  onboardingForm.elements.namedItem("slackBotToken").required = !usingUser;
  onboardingChoice.hidden = true;
  onboardingConfig.hidden = false;
  onboardingSuccess.hidden = true;
  setSetupProgress(2);
  onboardingForm.elements.namedItem(usingUser ? "slackUserToken" : "slackBotToken").focus();
}
function showOnboarding() { dashboard.hidden = true; onboarding.hidden = false; settingsLayer.hidden = true; document.body.classList.remove("drawer-open"); }
function showDashboard() { onboarding.hidden = true; dashboard.hidden = false; }

function selectedSettingsTokenType() { return settingsForm.elements.namedItem("slackReadTokenType").value; }
function setSettingsTokenType(type) {
  const usingUser = type === "user";
  [...settingsForm.querySelectorAll("input[name=slackReadTokenType]")].forEach((input) => { input.checked = input.value === type; });
  $("#settings-scope-guide").innerHTML = scopeGuide(type);
  $("#settings-user-token-field").hidden = !usingUser;
  $("#settings-bot-token-field").hidden = usingUser;
  settingsForm.elements.namedItem("slackUserToken").disabled = !usingUser;
  settingsForm.elements.namedItem("slackBotToken").disabled = usingUser;
}
function openSettings(opener = settingsToggle) { lastSettingsOpener = opener; settingsLayer.hidden = false; document.body.classList.add("drawer-open"); settingsToggle.setAttribute("aria-expanded", "true"); window.setTimeout(() => settingsDrawer.focus(), 0); }
function closeSettings() { settingsLayer.hidden = true; document.body.classList.remove("drawer-open"); settingsToggle.setAttribute("aria-expanded", "false"); lastSettingsOpener?.focus(); }
function socketLabel(socket) { return socket.state === "connected" ? "Connected" : socket.state === "not_configured" ? "Setup required" : socket.state === "reconnecting" ? "Reconnecting" : socket.state === "stopped" ? "Stopped" : "Connecting"; }
function socketTone(socket) { return socket.state === "connected" ? "good" : socket.state === "not_configured" || socket.state === "stopped" ? "neutral" : socket.lastError ? "bad" : "warning"; }
function setView(view, updateHash = true) { if (!pageTitles.has(view)) return; navButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.view === view)); viewPanels.forEach((panel) => { const active = panel.dataset.viewPanel === view; panel.hidden = !active; panel.classList.toggle("is-active", active); }); if (updateHash && window.location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`); }
function compactRow(label, value) { return `<div class="compact-row"><strong>${escapeHtml(label)}</strong><span>${value}</span></div>`; }
function jobLabel(kind) { return kind === "downtime" ? "Automatic recovery" : kind === "initial" ? "Recent thread index" : "Manual backfill"; }

function renderSettings(settings) {
  const numberFields = ["threadSettleSeconds", "messageRetentionDays", "rawEventRetentionDays", "backfillRequestIntervalSeconds", "downtimeSuggestionSeconds"];
  numberFields.forEach((name) => { const field = settingsForm.elements.namedItem(name); if (document.activeElement !== field) field.value = settings[name]; });
  setSettingsTokenType(settings.slackUserTokenConfigured ? "user" : "bot");
  settingsStatus.textContent = "Saved tokens stay hidden. Leave the selected token empty to keep it unchanged.";
  $("#rotate-mcp-token").disabled = !settings.mcpAuthTokenConfigured;
}

function renderOverview(status, socket, channels, jobs) {
  const tone = socketTone(socket);
  $("#header-socket-state").textContent = socketLabel(socket);
  $("#header-socket-dot").className = `state-dot ${tone}`;
  $("#overview-summary").textContent = `${status.channels} target${status.channels === 1 ? "" : "s"} · ${status.messages} messages available locally · last received ${shortTime(status.lastReceivedAt)}`;
  const activeJobs = jobs.filter((job) => ["queued", "running"].includes(job.state));
  const pendingMessages = status.consumers.reduce((sum, consumer) => sum + consumer.pendingMessages, 0);
  $("#overview-health").innerHTML = [
    ["Socket Mode", socketLabel(socket), socket.lastError ?? (socket.lastEventAt ? `Last event ${shortTime(socket.lastEventAt)}` : "Awaiting the first event"), tone],
    ["Local data", `${status.messages} messages`, `${status.events} raw events · since ${shortTime(status.earliestMessageAt)}`, ""],
    ["Backfill queue", activeJobs.length ? `${activeJobs.length} active` : "Idle", status.nextBackfillRequestAt ? `Next request ${shortTime(status.nextBackfillRequestAt)}` : "No scheduled Slack request", ""],
    ["Agent delivery", `${status.consumers.length} agent${status.consumers.length === 1 ? "" : "s"}`, `${pendingMessages} pending acknowledgement${pendingMessages === 1 ? "" : "s"}`, ""],
  ].map(([label, value, detail, toneClass]) => `<article class="health-card"><span>${label}</span><strong class="socket-value ${toneClass}">${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`).join("");
  const coveredChannels = channels.filter((channel) => channel.enabled);
  $("#overview-channels").innerHTML = coveredChannels.length ? coveredChannels.slice(0, 3).map((channel) => compactRow(conversationTitle(channel), `${conversationTypeLabel(channel.conversationType)} · ${channel.messageCount} messages · ${shortTime(channel.lastObservedAt)}`)).join("") : "<p>No conversations are in coverage yet.</p>";
  $("#overview-backfill").innerHTML = jobs.length ? jobs.slice(0, 3).map((job) => compactRow(`#${job.id} ${jobLabel(job.kind)}`, `${job.completedTasks}/${job.totalTasks} tasks · ${job.state}`)).join("") : "<p>No recovery jobs yet.</p>";
  $("#overview-agents").innerHTML = status.consumers.length ? status.consumers.slice(0, 3).map((consumer) => compactRow(consumer.consumerId, `${consumer.pendingMessages} pending · ${progressPercent(consumer.acknowledgedMessages, consumer.totalMessages)}% delivered`)).join("") : "<p>No agent acknowledgements yet.</p>";
}

function renderDashboardData(status, channels, jobs) {
  const socket = status.socketMode;
  renderSettings(status.settings);
  renderOverview(status, socket, channels, jobs);
  $("#discover-conversations").disabled = !status.userTokenConfigured;
  $("#discovery-status").textContent = status.userTokenConfigured ? "" : "Choose a User Token in Settings to enable discovery.";
  $("#channels").innerHTML = channels.length ? channels.map((channel) => `<tr><td>${formatReference(channel.workspaceName, channel.workspaceId)}</td><td>${formatConversation(channel)}</td><td>${channel.messageCount}</td><td>${time(channel.lastObservedAt)}</td><td>${coverageSwitch(channel)}</td></tr>`).join("") : "<tr><td colspan=\"5\" class=\"form-status\">Find accessible conversations or include one by ID to begin.</td></tr>";
  $("#consumer-progress").innerHTML = status.consumers.length ? status.consumers.map((consumer) => { const progress = progressPercent(consumer.acknowledgedMessages, consumer.totalMessages); return `<tr><td><code>${escapeHtml(consumer.consumerId)}</code></td><td>${consumer.acknowledgedMessages} / ${consumer.totalMessages}</td><td>${consumer.pendingMessages}</td><td><div class=\"progress\" aria-label=\"${progress}% consumed\"><span style=\"width:${progress}%\"></span></div><small>${progress}%</small></td><td>${time(consumer.lastAcknowledgedAt)}</td></tr>`; }).join("") : "<tr><td colspan=\"5\" class=\"form-status\">No agent acknowledgement yet.</td></tr>";
  $("#backfill-jobs").innerHTML = jobs.length ? jobs.map((job) => `<tr><td>#${job.id} · ${jobLabel(job.kind)}</td><td>${time(job.requestedStartAt)}<br>to ${time(job.requestedEndAt)}</td><td>${job.completedTasks}/${job.totalTasks} tasks<br><small>${job.channels} conversations · ${job.replyTasks} reply checks</small></td><td>${escapeHtml(job.state)}</td><td>${job.lastError ? `<span class=\"error\">${escapeHtml(job.lastError)}</span>` : ""}${["queued", "running"].includes(job.state) ? `<button class=\"secondary tiny\" data-cancel-job=\"${job.id}\" type=\"button\">Cancel</button>` : ""}</td></tr>`).join("") : "<tr><td colspan=\"5\" class=\"form-status\">No recovery jobs yet.</td></tr>";
  $("#backfill-status").textContent = status.nextBackfillRequestAt && new Date(status.nextBackfillRequestAt) > new Date() ? `Next Slack request: ${time(status.nextBackfillRequestAt)}.` : "Queue is ready for its next Slack request.";
}

async function loadDashboard() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  setPending($("#refresh"), true, "Refreshing");
  $("#refresh-status").textContent = "Refreshing…";
  try {
    const [statusResponse, channelsResponse, backfillResponse] = await Promise.all([fetch("/dashboard/status"), fetch("/dashboard/channels"), fetch("/dashboard/backfill")]);
    if (!statusResponse.ok || !channelsResponse.ok || !backfillResponse.ok) throw new Error("Dashboard endpoints are unavailable.");
    const [status, { channels }, { jobs }] = await Promise.all([statusResponse.json(), channelsResponse.json(), backfillResponse.json()]);
    if (!status.settings.configured) { showOnboarding(); return status; }
    showDashboard();
    renderDashboardData(status, channels, jobs);
    resetCountdown();
    updateRefreshStatus();
    return status;
  } catch (error) {
    resetCountdown();
    $("#refresh-status").textContent = "Refresh failed";
    console.error(error);
    throw error;
  } finally {
    refreshInFlight = false;
    setPending($("#refresh"), false);
  }
}
async function refreshDashboard() { try { await loadDashboard(); } catch { /* Status is already visible in the top bar. */ } }
async function post(url, body) { const response = await fetch(url, { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) throw new Error(await response.text()); return response.status === 204 ? undefined : response.json(); }
function confirmAction(message, confirmLabel = "Continue") { confirmCopy.textContent = message; $("#confirm-action").textContent = confirmLabel; confirmDialog.showModal(); return new Promise((resolve) => confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true })); }

document.querySelectorAll("[data-onboarding-token]").forEach((button) => button.addEventListener("click", () => configureOnboardingToken(button.dataset.onboardingToken)));
$("#change-token-type").addEventListener("click", () => { onboardingConfig.hidden = true; onboardingChoice.hidden = false; setSetupProgress(1); });
$("#onboarding-test").addEventListener("click", async () => { const button = $("#onboarding-test"); setPending(button, true, "Testing connection"); onboardingStatus.textContent = "Checking Slack without saving settings or starting Observer…"; try { await post("/dashboard/settings/test", formValues(onboardingForm)); onboardingStatus.textContent = "Connection verified. Save to start Observer."; } catch (error) { onboardingStatus.textContent = "Connection test failed. Check the tokens and scopes above."; console.error(error); } finally { setPending(button, false); } });
onboardingForm.addEventListener("submit", async (event) => { event.preventDefault(); const button = $("#onboarding-save"); setPending(button, true, "Starting Observer"); onboardingStatus.textContent = "Saving local settings and starting Observer…"; try { const result = await post("/dashboard/settings", formValues(onboardingForm)); onboardingForm.querySelectorAll("input[type=password]").forEach((input) => { input.value = ""; }); $("#onboarding-mcp-token").textContent = result.mcpAuthToken ?? "Token was already generated. Open Settings to rotate it if needed."; onboardingConfig.hidden = true; onboardingSuccess.hidden = false; setSetupProgress(3); } catch (error) { onboardingStatus.textContent = "Settings could not be saved. Check the required tokens."; console.error(error); } finally { setPending(button, false); } });
$("#enter-dashboard").addEventListener("click", async () => { showDashboard(); await refreshDashboard(); });

navButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll(".jump-button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.jump)));
$("#refresh").addEventListener("click", refreshDashboard);
settingsToggle.addEventListener("click", () => openSettings(settingsToggle));
$("#settings-close").addEventListener("click", closeSettings);
$("[data-close-settings]").addEventListener("click", closeSettings);
settingsForm.querySelectorAll("input[name=slackReadTokenType]").forEach((input) => input.addEventListener("change", () => setSettingsTokenType(input.value)));
$("#test-settings").addEventListener("click", async () => { const button = $("#test-settings"); setPending(button, true, "Testing connection"); settingsStatus.textContent = "Checking Slack without saving settings or restarting Observer…"; try { await post("/dashboard/settings/test", formValues(settingsForm)); settingsStatus.textContent = "Connection verified. Save changes when ready."; } catch (error) { settingsStatus.textContent = "Connection test failed. Check the selected token and scopes."; console.error(error); } finally { setPending(button, false); } });
settingsForm.addEventListener("submit", async (event) => { event.preventDefault(); const button = $("#save-settings"); setPending(button, true, "Saving changes"); settingsStatus.textContent = "Applying local settings and restarting affected services…"; try { const result = await post("/dashboard/settings", formValues(settingsForm)); if (result.mcpAuthToken) { $("#mcp-token").textContent = result.mcpAuthToken; $("#mcp-token-result").hidden = false; } settingsForm.querySelectorAll("input[type=password]").forEach((input) => { input.value = ""; }); settingsStatus.textContent = "Settings saved."; await refreshDashboard(); } catch (error) { settingsStatus.textContent = "Settings could not be saved. Check the required tokens."; console.error(error); } finally { setPending(button, false); } });
$("#rotate-mcp-token").addEventListener("click", async () => { if (!await confirmAction("This immediately invalidates MCP credentials used by connected agents. You will need to update every agent.", "Rotate token")) return; const button = $("#rotate-mcp-token"); setPending(button, true, "Rotating token"); try { const result = await post("/dashboard/settings/mcp-token"); $("#mcp-token").textContent = result.mcpAuthToken; $("#mcp-token-result").hidden = false; settingsStatus.textContent = "MCP token rotated. Update connected agents now."; } catch (error) { settingsStatus.textContent = "MCP token could not be rotated."; console.error(error); } finally { setPending(button, false); } });
$("#copy-mcp-url").addEventListener("click", async () => { const button = $("#copy-mcp-url"); setPending(button, true, "Copying"); try { await navigator.clipboard.writeText(`${window.location.origin}/mcp`); $("#endpoint-status").textContent = "MCP endpoint copied."; } catch { $("#endpoint-status").textContent = "Copy unavailable; select the endpoint above."; } finally { setPending(button, false); } });
$("#sync-names").addEventListener("click", async () => { const button = $("#sync-names"); setPending(button, true, "Refreshing names"); $("#coverage-status").textContent = "Refreshing conversation and DM participant names…"; try { const { queued } = await post("/dashboard/metadata/sync"); $("#coverage-status").textContent = queued ? `Name lookup queued for ${queued} included conversation${queued === 1 ? "" : "s"}.` : "No included conversations need a name lookup."; await refreshDashboard(); } catch (error) { $("#coverage-status").textContent = "Name refresh could not be queued."; console.error(error); } finally { setPending(button, false); } });
$("#discover-conversations").addEventListener("click", async () => { const button = $("#discover-conversations"); setPending(button, true, "Finding conversations"); $("#discovery-status").textContent = "Reading conversation and DM participant names…"; try { const { conversations } = await post("/dashboard/conversations/discover"); $("#discovery-status").textContent = `Found ${conversations} accessible conversation${conversations === 1 ? "" : "s"}. Choose Include in recovery coverage for the ones you want.`; await refreshDashboard(); } catch (error) { $("#discovery-status").textContent = "Accessible conversations could not be found."; console.error(error); } finally { setPending(button, false); } });
$("#target-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button"); setPending(button, true, "Including conversation"); try { await post("/dashboard/targets", { workspaceId: $("#target-workspace").value, channelId: $("#target-channel").value }); form.reset(); $("#coverage-status").textContent = "Conversation included in recovery coverage."; await refreshDashboard(); } catch (error) { $("#coverage-status").textContent = "Conversation could not be included."; console.error(error); } finally { setPending(button, false); } });
$("#initial-backfill").addEventListener("click", async () => { const button = $("#initial-backfill"); setPending(button, true, "Creating index"); $("#backfill-status").textContent = "Creating history and thread index job…"; try { await post("/dashboard/backfill/initial"); await refreshDashboard(); } catch (error) { $("#backfill-status").textContent = "Index job could not be queued."; console.error(error); } finally { setPending(button, false); } });
$("#manual-backfill-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button"); setPending(button, true, "Queueing fetch"); $("#backfill-status").textContent = "Queueing selected time range…"; try { await post("/dashboard/backfill/manual", { startAt: new Date($("#backfill-start").value).toISOString(), endAt: new Date($("#backfill-end").value).toISOString() }); await refreshDashboard(); } catch (error) { $("#backfill-status").textContent = "Time range could not be queued."; console.error(error); } finally { setPending(button, false); } });
document.addEventListener("click", async (event) => { const button = event.target instanceof Element ? event.target.closest("button") : null; if (!(button instanceof HTMLButtonElement)) return; if (button.dataset.copyChannelId) { try { await navigator.clipboard.writeText(button.dataset.copyChannelId); $("#coverage-status").textContent = "Conversation ID copied."; } catch (error) { $("#coverage-status").textContent = "Could not copy the conversation ID."; console.error(error); } return; } let action; let status = $("#backfill-status"); if (button.dataset.cancelJob) action = async () => { if (await confirmAction("Cancel this recovery job? Completed work stays stored locally.", "Cancel job")) await post(`/dashboard/backfill/${button.dataset.cancelJob}/cancel`); }; if (button.dataset.setCoverage) { status = $("#coverage-status"); action = () => post("/dashboard/targets/coverage", { workspaceId: button.dataset.workspaceId, channelId: button.dataset.channelId, enabled: button.dataset.setCoverage === "true" }); } if (!action) return; setPending(button, true, button.dataset.cancelJob ? "Cancelling" : "Updating recovery"); try { await action(); if (button.dataset.setCoverage) status.textContent = button.dataset.setCoverage === "true" ? "History recovery enabled for this conversation." : "History recovery turned off for this conversation."; await refreshDashboard(); } catch (error) { status.textContent = "History recovery or backfill action could not be completed."; console.error(error); } finally { setPending(button, false); } });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !settingsLayer.hidden) closeSettings(); });
window.addEventListener("hashchange", () => setView(window.location.hash.slice(1), false));
$("#backfill-start").value = datetimeInput(new Date(Date.now() - 24 * 60 * 60 * 1000));
$("#backfill-end").value = datetimeInput(new Date());
setView(window.location.hash.slice(1) || "overview", false);
setInterval(() => { updateRefreshStatus(); if (!refreshInFlight && !dashboard.hidden && Date.now() >= nextRefreshAt) void refreshDashboard(); }, 1000);
void loadDashboard();
