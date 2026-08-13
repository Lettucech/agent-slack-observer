document.querySelector("#mcp-url").textContent = `${window.location.origin}/mcp`;
const refreshIntervalSeconds = 15;
const refreshStatus = document.querySelector("#refresh-status");
const metadataStatus = document.querySelector("#metadata-status");
const backfillStatus = document.querySelector("#backfill-status");
const syncNamesButton = document.querySelector("#sync-names");
const initialBackfillButton = document.querySelector("#initial-backfill");
let nextRefreshAt = Date.now(); let refreshInFlight = false;

function renderRefreshStatus(message) { refreshStatus.textContent = message; }
function resetCountdown() { nextRefreshAt = Date.now() + refreshIntervalSeconds * 1000; }
function updateCountdown() { if (!refreshInFlight) renderRefreshStatus(`Auto-refresh in ${Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000))}s`); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function formatReference(name, id) { return name && name !== id ? `<strong class="reference-name">${escapeHtml(name)}</strong><code>${escapeHtml(id)}</code>` : `<code>${escapeHtml(id)}</code>`; }
function time(value) { return value ? new Date(value).toLocaleString() : "Never"; }
function datetimeInput(date) { const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }

async function loadDashboard() {
  if (refreshInFlight) return;
  refreshInFlight = true; renderRefreshStatus("Refreshing observer data…");
  const [statusResponse, channelsResponse, backfillResponse] = await Promise.all([fetch("/dashboard/status"), fetch("/dashboard/channels"), fetch("/dashboard/backfill")]);
  if (!statusResponse.ok || !channelsResponse.ok || !backfillResponse.ok) throw new Error("Dashboard endpoints are unavailable.");
  const [status, { channels }, { jobs, suggestions }] = await Promise.all([statusResponse.json(), channelsResponse.json(), backfillResponse.json()]);
  const socket = status.socketMode;
  document.querySelector("#stats").innerHTML = [["Slack socket", socket.state], ["Stored raw events", status.events], ["Messages", status.messages], ["Targets", status.channels], ["Earliest context", status.earliestMessageAt ? time(status.earliestMessageAt) : "None"]].map(([label, value]) => `<article class="stat"><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  document.querySelector("#channels").innerHTML = channels.length ? channels.map((channel) => `<tr><td>${formatReference(channel.workspaceName, channel.workspaceId)}</td><td>${formatReference(channel.channelName, channel.channelId)}</td><td>${channel.messageCount}</td><td>${time(channel.lastObservedAt)}</td></tr>`).join("") : "<tr><td colspan=\"4\" class=\"muted\">No target channels yet.</td></tr>";
  document.querySelector("#backfill-jobs").innerHTML = jobs.length ? jobs.map((job) => `<tr><td>#${job.id} · ${escapeHtml(job.kind)}</td><td>${time(job.requestedStartAt)}<br>to ${time(job.requestedEndAt)}</td><td>${job.completedTasks}/${job.totalTasks} tasks<br><small>${job.channels} channels · ${job.replyTasks} reply checks</small></td><td>${escapeHtml(job.state)}</td><td>${job.lastError ? `<span class=\"error\">${escapeHtml(job.lastError)}</span>` : ""}${["queued", "running"].includes(job.state) ? `<button class=\"secondary tiny\" data-cancel-job=\"${job.id}\">Cancel</button>` : ""}</td></tr>`).join("") : "<tr><td colspan=\"5\" class=\"muted\">No backfill jobs yet.</td></tr>";
  document.querySelector("#backfill-suggestions").innerHTML = suggestions.length ? `<div class="suggestions"><strong>Possible Socket Mode gaps</strong>${suggestions.map((item) => `<p>${time(item.startAt)} to ${time(item.endAt)} <button class="secondary tiny" data-accept-suggestion="${item.id}">Queue fetch</button><button class="secondary tiny" data-dismiss-suggestion="${item.id}">Dismiss</button></p>`).join("")}</div>` : "";
  backfillStatus.textContent = status.nextBackfillRequestAt && new Date(status.nextBackfillRequestAt) > new Date() ? `Next Slack history/thread request: ${time(status.nextBackfillRequestAt)}.` : "Queue is ready for its next Slack request.";
  refreshInFlight = false; resetCountdown(); updateCountdown();
}
async function refreshDashboard() { try { await loadDashboard(); } catch (cause) { refreshInFlight = false; resetCountdown(); renderRefreshStatus(`Refresh failed; retrying in ${refreshIntervalSeconds}s`); console.error(cause); } }
async function post(url, body) { const response = await fetch(url, { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) throw new Error(await response.text()); return response.status === 204 ? undefined : response.json(); }

document.querySelector("#refresh").addEventListener("click", refreshDashboard);
syncNamesButton.addEventListener("click", async () => { syncNamesButton.disabled = true; metadataStatus.textContent = "Queueing name lookup…"; try { const { queued } = await post("/dashboard/metadata/sync"); metadataStatus.textContent = queued ? `Name lookup queued for ${queued} channel${queued === 1 ? "" : "s"}.` : "No observed channels to synchronize."; await refreshDashboard(); } catch (cause) { metadataStatus.textContent = "Name synchronization could not be queued."; console.error(cause); } finally { syncNamesButton.disabled = false; } });
document.querySelector("#target-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button"); button.disabled = true; try { await post("/dashboard/targets", { workspaceId: document.querySelector("#target-workspace").value, channelId: document.querySelector("#target-channel").value }); form.reset(); await refreshDashboard(); } catch (cause) { metadataStatus.textContent = "Channel could not be added."; console.error(cause); } finally { button.disabled = false; } });
initialBackfillButton.addEventListener("click", async () => { initialBackfillButton.disabled = true; backfillStatus.textContent = "Creating complete 30-day index job…"; try { await post("/dashboard/backfill/initial"); await refreshDashboard(); } catch (cause) { backfillStatus.textContent = "Initial index could not be queued."; console.error(cause); } finally { initialBackfillButton.disabled = false; } });
document.querySelector("#manual-backfill-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button"); button.disabled = true; try { await post("/dashboard/backfill/manual", { startAt: new Date(document.querySelector("#backfill-start").value).toISOString(), endAt: new Date(document.querySelector("#backfill-end").value).toISOString() }); await refreshDashboard(); } catch (cause) { backfillStatus.textContent = "Backfill window could not be queued."; console.error(cause); } finally { button.disabled = false; } });
document.addEventListener("click", async (event) => { const target = event.target; if (!(target instanceof HTMLButtonElement)) return; try { if (target.dataset.cancelJob) await post(`/dashboard/backfill/${target.dataset.cancelJob}/cancel`); if (target.dataset.acceptSuggestion) await post(`/dashboard/backfill/suggestions/${target.dataset.acceptSuggestion}/accept`); if (target.dataset.dismissSuggestion) await post(`/dashboard/backfill/suggestions/${target.dataset.dismissSuggestion}/dismiss`); if (target.dataset.cancelJob || target.dataset.acceptSuggestion || target.dataset.dismissSuggestion) await refreshDashboard(); } catch (cause) { backfillStatus.textContent = "Backfill action could not be completed."; console.error(cause); } });
document.querySelector("#backfill-start").value = datetimeInput(new Date(Date.now() - 24 * 60 * 60 * 1000));
document.querySelector("#backfill-end").value = datetimeInput(new Date());
setInterval(() => { updateCountdown(); if (!refreshInFlight && Date.now() >= nextRefreshAt) void refreshDashboard(); }, 1000);
void refreshDashboard();
