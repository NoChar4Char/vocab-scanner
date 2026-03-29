// background.js — Service Worker
// Handles PDF fetching from the popup (bypasses CORS for same-origin pdfs)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchPDF') {
    fetch(message.url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(buffer => {
        // Transfer as plain array so it can cross the message boundary
        sendResponse({ success: true, data: Array.from(new Uint8Array(buffer)) });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message channel open for async response
  }
});
