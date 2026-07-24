document.getElementById("status").addEventListener("click", async () => {
  const output = document.getElementById("output");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(flow|labs)\.google\//.test(tab.url || "")) {
    output.textContent = "Open a Flow tab first.";
    return;
  }
  output.textContent = "The content script writes detailed status to the page console.";
});
