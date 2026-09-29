const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["url", "token", "enabled", "jevKey"]).then((c) => {
  $("jevKey").value = c.jevKey ?? "";
  $("url").value = c.url ?? "";
  $("token").value = c.token ?? "";
  $("enabled").checked = !!c.enabled;
});
const showStatus = () => chrome.storage.session.get("status").then((s) => ($("status").textContent = s.status ?? "-"));
showStatus();
chrome.storage.onChanged.addListener((_, area) => area === "session" && showStatus());

$("save").onclick = () =>
  chrome.storage.local.set({ url: $("url").value.trim(), token: $("token").value.trim(), enabled: $("enabled").checked, jevKey: $("jevKey").value.trim() });
