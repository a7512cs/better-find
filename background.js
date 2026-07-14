// Relay find-bar messages to every frame in the sender's tab, stamping the
// sender's frameId so the top frame can order frames deterministically.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.fbp !== 1 || !sender.tab) return;
  chrome.tabs
    .sendMessage(sender.tab.id, { ...msg, _frameId: sender.frameId })
    .catch(() => {}); // tab may have no other listeners yet
});
