const login = document.querySelector("#login");
const dashboard = document.querySelector("#dashboard");
const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");
document.querySelector("#mcp-url").textContent = `${window.location.origin}/mcp`;

async function loadDashboard() {
  const [statusResponse, channelsResponse] = await Promise.all([fetch("/dashboard/status"), fetch("/dashboard/channels")]);
  if (!statusResponse.ok || !channelsResponse.ok) throw new Error("Dashboard session expired. Enter the token again.");
  const status = await statusResponse.json();
  const { channels } = await channelsResponse.json();
  document.querySelector("#stats").innerHTML = [
    ["Stored events", status.events], ["Messages", status.messages], ["Channels", status.channels], ["Last received", status.lastReceivedAt ? new Date(status.lastReceivedAt).toLocaleString() : "Never"],
  ].map(([label, value]) => `<article class="stat"><span>${label}</span><strong>${value}</strong></article>`).join("");
  document.querySelector("#channels").innerHTML = channels.length ? channels.map((channel) => `<tr><td>${escapeHtml(channel.workspaceId)}</td><td>${escapeHtml(channel.channelId)}</td><td>${channel.messageCount}</td><td>${new Date(channel.lastObservedAt).toLocaleString()}</td></tr>`).join("") : "<tr><td colspan=\"4\" class=\"muted\">No messages observed yet.</td></tr>";
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
form.addEventListener("submit", async (event) => {
  event.preventDefault(); error.hidden = true;
  const response = await fetch("/dashboard/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: document.querySelector("#token").value }) });
  if (!response.ok) { error.textContent = "Token is invalid."; error.hidden = false; return; }
  login.hidden = true; dashboard.hidden = false; await loadDashboard();
});
document.querySelector("#refresh").addEventListener("click", () => loadDashboard().catch((cause) => { error.textContent = cause.message; error.hidden = false; }));
