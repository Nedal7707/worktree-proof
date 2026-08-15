import WebSocket from 'ws';

let cdp = null;
let messageId = 0;
const pending = new Map();
let currentSessionId = null;
let currentTabId = null;

// CDP connection
async function connectCDP(host = '127.0.0.1', port = 9222) {
  if (cdp) throw new Error('Already connected. Disconnect first.');
  
  const versionUrl = `http://${host}:${port}/json/version`;
  const versionRes = await fetch(versionUrl);
  const version = await versionRes.json();
  const wsUrl = version.webSocketDebuggerUrl;
  
  cdp = new WebSocket(wsUrl);
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP connection timeout')), 10000);
    
    cdp.on('open', () => {
      clearTimeout(timeout);
      // Enable domains
      sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      sendCDP('Page.enable');
      sendCDP('Runtime.enable');
      sendCDP('Network.enable');
      sendCDP('Console.enable');
      sendCDP('Log.enable');
      sendCDP('Target.enable');
      
      // Get initial tabs
      getTabs().then(tabs => {
        if (tabs.length > 0) {
          currentTabId = tabs[0].id;
          currentSessionId = tabs[0].sessionId;
        }
      });
      
      resolve({ connected: true, browser: version.Browser, tabs: tabs.length });
    });
    
    cdp.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
      // Handle events
      handleCDPEvent(msg);
    });
    
    cdp.on('error', (err) => reject(err));
    cdp.on('close', () => {
      cdp = null;
      currentSessionId = null;
      currentTabId = null;
    });
  });
}

function sendCDP(method, params = {}) {
  if (!cdp || cdp.readyState !== WebSocket.OPEN) throw new Error('CDP not connected');
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    cdp.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
  });
}

function handleCDPEvent(msg) {
  if (!msg.method) return;
  // Could emit events for console, network, etc.
}

async function getTabs() {
  const res = await fetch(`http://127.0.0.1:9222/json/list`);
  const targets = await res.json();
  return targets
    .filter(t => t.type === 'page')
    .map(t => ({ id: t.id, title: t.title, url: t.url, sessionId: t.sessionId }));
}

function ensureSession() {
  if (!currentSessionId) throw new Error('No active tab. Use chrome:tabs to select one.');
  return currentSessionId;
}

// --- Commands/Tools Implementation ---

async function cmdConnect(ctx, { host = '127.0.0.1', port = 9222 } = {}) {
  return await connectCDP(host, port);
}

async function cmdDisconnect(ctx) {
  if (cdp) {
    cdp.close();
    cdp = null;
  }
  return { disconnected: true };
}

async function cmdNavigate(ctx, { url, waitUntil = 'load' }) {
  const sessionId = ensureSession();
  await sendCDP('Page.navigate', { url }, sessionId);
  if (waitUntil !== 'none') {
    await sendCDP('Page.waitForLoadState', { state: waitUntil }, sessionId);
  }
  const info = await sendCDP('Page.getNavigationHistory', {}, sessionId);
  return { navigated: true, url };
}

async function cmdClick(ctx, { selector, button = 'left', count = 1 }) {
  const sessionId = ensureSession();
  // Get element position
  const result = await sendCDP('Runtime.evaluate', {
    expression: `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'Element not found' };
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()
    `,
    returnByValue: true
  }, sessionId);
  
  if (result.result?.value?.error) throw new Error(result.result.value.error);
  
  const { x, y } = result.result.value;
  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, clickCount: count
  }, sessionId);
  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, clickCount: count
  }, sessionId);
  return { clicked: true, selector, x, y };
}

async function cmdFill(ctx, { selector, text, clearFirst = true }) {
  const sessionId = ensureSession();
  await sendCDP('Runtime.evaluate', {
    expression: `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'Element not found' };
        if (${clearFirst}) el.value = '';
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      })()
    `,
    returnByValue: true
  }, sessionId);
  return { filled: true, selector };
}

async function cmdType(ctx, { text }) {
  const sessionId = ensureSession();
  for (const char of text) {
    await sendCDP('Input.dispatchKeyEvent', {
      type: 'char', text: char
    }, sessionId);
  }
  return { typed: text.length };
}

async function cmdScroll(ctx, { direction = 'down', amount = 500, selector }) {
  const sessionId = ensureSession();
  if (selector) {
    await sendCDP('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ behavior: 'smooth' })`
    }, sessionId);
  } else {
    const delta = direction === 'down' ? amount : -amount;
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: delta
    }, sessionId);
  }
  return { scrolled: true };
}

async function cmdScreenshot(ctx, { format = 'png', quality = 80, fullPage = false, savePath }) {
  const sessionId = ensureSession();
  const result = await sendCDP('Page.captureScreenshot', {
    format, quality, captureBeyondViewport: fullPage
  }, sessionId);
  
  const base64 = result.data;
  if (savePath) {
    const fs = await import('fs');
    fs.writeFileSync(savePath, Buffer.from(base64, 'base64'));
  }
  return { screenshot: base64, format, saved: !!savePath };
}

async function cmdExtract(ctx, { selector, attribute = 'text' }) {
  const sessionId = ensureSession();
  const expr = attribute === 'text' 
    ? `document.querySelector(${JSON.stringify(selector)})?.innerText || ''`
    : attribute === 'html'
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || ''`
    : `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(attribute)}) || ''`;
  
  const result = await sendCDP('Runtime.evaluate', {
    expression: expr,
    returnByValue: true
  }, sessionId);
  return { value: result.result?.value ?? '' };
}

async function cmdWait(ctx, { for: waitFor = 'load', selector, text, timeout = 30000 }) {
  const sessionId = ensureSession();
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    if (waitFor === 'load') {
      const state = await sendCDP('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true
      }, sessionId);
      if (state.result?.value === 'complete') return { ready: true };
    }
    else if (waitFor === 'element' && selector) {
      const found = await sendCDP('Runtime.evaluate', {
        expression: `!!document.querySelector(${JSON.stringify(selector)})`,
        returnByValue: true
      }, sessionId);
      if (found.result?.value) return { found: true, selector };
    }
    else if (waitFor === 'text' && text) {
      const found = await sendCDP('Runtime.evaluate', {
        expression: `document.body.innerText.includes(${JSON.stringify(text)})`,
        returnByValue: true
      }, sessionId);
      if (found.result?.value) return { found: true, text };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Wait timeout: ${waitFor}`);
}

async function cmdConsole(ctx, { filter = [] }) {
  // Console logs would need event collection; return placeholder
  return { logs: [], note: 'Console event collection requires hook setup' };
}

async function cmdNetwork(ctx, { filter = [] }) {
  return { requests: [], note: 'Network event collection requires hook setup' };
}

async function cmdTabs(ctx, { action = 'list', tabId, url }) {
  const tabs = await getTabs();
  if (action === 'list') return { tabs };
  if (action === 'activate' && tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) throw new Error('Tab not found');
    currentTabId = tab.id;
    currentSessionId = tab.sessionId;
    await sendCDP('Target.activateTarget', { targetId: tabId });
    return { activated: true, tab };
  }
  if (action === 'new' && url) {
    const result = await sendCDP('Target.createTarget', { url });
    return { created: true, targetId: result.targetId };
  }
  if (action === 'close' && tabId) {
    await sendCDP('Target.closeTarget', { targetId: tabId });
    return { closed: true };
  }
  return { error: 'Invalid action' };
}

async function cmdEvaluate(ctx, { expression, returnByValue = true }) {
  const sessionId = ensureSession();
  const result = await sendCDP('Runtime.evaluate', {
    expression, returnByValue
  }, sessionId);
  return { result: result.result?.value };
}

// --- Tool wrappers (same as commands but for agent) ---
const tools = {
  chrome_navigate: cmdNavigate,
  chrome_click: cmdClick,
  chrome_fill: cmdFill,
  chrome_type: cmdType,
  chrome_scroll: cmdScroll,
  chrome_screenshot: cmdScreenshot,
  chrome_extract: cmdExtract,
  chrome_wait: cmdWait,
  chrome_console: cmdConsole,
  chrome_network: cmdNetwork,
  chrome_tabs: cmdTabs,
  chrome_evaluate: cmdEvaluate
};

const commands = {
  'chrome:connect': cmdConnect,
  'chrome:disconnect': cmdDisconnect,
  'chrome:navigate': cmdNavigate,
  'chrome:click': cmdClick,
  'chrome:fill': cmdFill,
  'chrome:type': cmdType,
  'chrome:scroll': cmdScroll,
  'chrome:screenshot': cmdScreenshot,
  'chrome:extract': cmdExtract,
  'chrome:wait': cmdWait,
  'chrome:console': cmdConsole,
  'chrome:network': cmdNetwork,
  'chrome:tabs': cmdTabs,
  'chrome:evaluate': cmdEvaluate
};

export default { commands, tools };