// Minimal dummy background service worker for Chrome Extension compatibility
chrome.runtime.onInstalled.addListener(() => {
  console.log('Regnis Portal Admin extension loaded.');
});
