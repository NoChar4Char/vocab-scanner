// content.js — injected programmatically from popup.js
// Extracts page text or signals that the page is a PDF

(function () {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'extractText') return;

    const url = window.location.href;
    const isPDF =
      url.toLowerCase().endsWith('.pdf') ||
      document.contentType === 'application/pdf';

    if (isPDF) {
      sendResponse({
        type: 'pdf',
        url: url,
        source: document.title || url,
      });
      return true;
    }

    // Remove scripts, styles, nav, footer noise
    const clone = document.body.cloneNode(true);
    ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside'].forEach(tag => {
      clone.querySelectorAll(tag).forEach(el => el.remove());
    });

    const rawText = clone.innerText || clone.textContent || '';
    const cleanText = rawText
      .replace(/\s{3,}/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    sendResponse({
      type: 'web',
      text: cleanText,
      source: document.title || url,
      url: url,
    });
    return true;
  });
})();
