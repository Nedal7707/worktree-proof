// WorktreeProof Chrome Use - Popup Script

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const tabsBtn = document.getElementById('tabsBtn');

function setConnected(connected) {
  if (connected) {
    statusEl.textContent = 'Connected to Chrome via CDP';
    statusEl.className = 'status connected';
    connectBtn.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
  } else {
    statusEl.textContent = 'Not connected to CDP';
    statusEl.className = 'status disconnected';
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
  }
}

async function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response);
    });
  });
}

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';
  const result = await sendMessage({ action: 'connect' });
  if (result.success) {
    setConnected(true);
  } else {
    statusEl.textContent = 'Connection failed: ' + (result.error || 'unknown');
    statusEl.className = 'status disconnected';
  }
  connectBtn.disabled = false;
  connectBtn.textContent = 'Connect to Chrome (CDP 9222)';
});

disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  await sendMessage({ action: 'disconnect' });
  setConnected(false);
  disconnectBtn.disabled = false;
});

tabsBtn.addEventListener('click', async () => {
  tabsBtn.disabled = true;
  tabsBtn.textContent = 'Loading...';
  const result = await sendMessage({ action: 'getTabs' });
  if (result.success && result.tabs.length > 0) {
    const tabList = result.tabs.map(t => `${t.title || 'Untitled'} — ${t.url}`).join('\n');
    alert(`Open tabs (${result.tabs.length}):\n\n${tabList}`);
  } else {
    alert('No tabs found or connection failed');
  }
  tabsBtn.disabled = false;
  tabsBtn.textContent = 'List Tabs';
});

// Check connection status on popup open
(async () => {
  try {
    const result = await sendMessage({ action: 'connect' });
    if (result.success) {
      setConnected(true);
      // Disconnect immediately since we just checked
      await sendMessage({ action: 'disconnect' });
      setConnected(false);
    }
  } catch {
    // Ignore
  }
})();