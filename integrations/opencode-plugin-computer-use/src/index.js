// Computer Use Plugin - Human-like automation via nut-js + screenshot-desktop
// Windows/macOS/Linux support

import { screen, mouse, keyboard, Key, clipboard } from '@nut-tree-fork/nut-js';
import screenshotDesktop from 'screenshot-desktop';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

// Configure nut-js
screen.config.autoDelayMs = 50;
mouse.config.autoDelayMs = 20;
keyboard.config.autoDelayMs = 20;

// --- Helpers ---

function parseKeyCombo(combo) {
  // "ctrl+c" -> [Key.LeftControl, 'c']
  // "alt+tab" -> [Key.LeftAlt, Key.Tab]
  // "ctrl+shift+esc" -> [Key.LeftControl, Key.LeftShift, Key.Escape]
  const parts = combo.toLowerCase().split('+').map(p => p.trim());
  const keys = [];
  for (const part of parts) {
    const keyMap = {
      'ctrl': Key.LeftControl, 'control': Key.LeftControl,
      'alt': Key.LeftAlt, 'option': Key.LeftAlt,
      'shift': Key.LeftShift,
      'win': Key.LeftMeta, 'cmd': Key.LeftMeta, 'meta': Key.LeftMeta,
      'enter': Key.Enter, 'return': Key.Enter,
      'esc': Key.Escape, 'escape': Key.Escape,
      'tab': Key.Tab,
      'space': Key.Space,
      'up': Key.Up, 'down': Key.Down, 'left': Key.Left, 'right': Key.Right,
      'home': Key.Home, 'end': Key.End,
      'pageup': Key.PageUp, 'pagedown': Key.PageDown,
      'insert': Key.Insert, 'delete': Key.Delete,
      'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4,
      'f5': Key.F5, 'f6': Key.F6, 'f7': Key.F7, 'f8': Key.F8,
      'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12,
    };
    if (keyMap[part]) keys.push(keyMap[part]);
    else if (part.length === 1) keys.push(part);
    else keys.push(part); // pass through, nut-js may handle
  }
  return keys;
}

async function takeScreenshot({ region, windowTitle, format = 'png', savePath }) {
  let img;
  if (region) {
    // region: { x, y, width, height }
    img = await screenshotDesktop({ format, ...region });
  } else if (windowTitle) {
    // screenshot-desktop doesn't support window capture directly on Windows
    // Fall back to full screen; user can crop
    img = await screenshotDesktop({ format });
  } else {
    img = await screenshotDesktop({ format });
  }
  
  if (savePath) {
    writeFileSync(resolve(savePath), img);
  }
  return { 
    screenshot: img.toString('base64'), 
    format, 
    size: img.length,
    saved: !!savePath,
    path: savePath ? resolve(savePath) : null
  };
}

// --- Commands ---

async function cmdScreenshot(ctx, { region, windowTitle, format = 'png', savePath }) {
  return await takeScreenshot({ region, windowTitle, format, savePath });
}

async function cmdMouseMove(ctx, { x, y, speed = 'fast' }) {
  await mouse.move([x, y]);
  const pos = await mouse.getPosition();
  return { moved: true, x: pos.x, y: pos.y };
}

async function cmdMouseClick(ctx, { x, y, button = 'left', count = 1 }) {
  if (x !== undefined && y !== undefined) {
    await mouse.move([x, y]);
  }
  const btn = button === 'right' ? 1 : button === 'middle' ? 2 : 0;
  for (let i = 0; i < count; i++) {
    await mouse.click(btn);
    if (count > 1 && i < count - 1) await new Promise(r => setTimeout(r, 100));
  }
  const pos = await mouse.getPosition();
  return { clicked: true, button, count, x: pos.x, y: pos.y };
}

async function cmdMouseDrag(ctx, { fromX, fromY, toX, toY, speed = 'fast' }) {
  await mouse.move([fromX, fromY]);
  await mouse.drag([toX, toY]);
  const pos = await mouse.getPosition();
  return { dragged: true, from: { x: fromX, y: fromY }, to: { x: pos.x, y: pos.y } };
}

async function cmdMouseScroll(ctx, { x, y, deltaX = 0, deltaY = -100 }) {
  if (x !== undefined && y !== undefined) {
    await mouse.move([x, y]);
  }
  await mouse.scroll(deltaX, deltaY);
  return { scrolled: true, deltaX, deltaY };
}

async function cmdKeyboardType(ctx, { text, delay = 20 }) {
  await keyboard.type(text, delay);
  return { typed: text.length };
}

async function cmdKeyboardPress(ctx, { combo }) {
  const keys = parseKeyCombo(combo);
  await keyboard.pressKey(...keys);
  return { pressed: combo, keys: keys.map(k => typeof k === 'string' ? k : k.toString()) };
}

async function cmdKeyboardHold(ctx, { combo }) {
  const keys = parseKeyCombo(combo);
  for (const key of keys) {
    await keyboard.pressKey(key);
  }
  return { held: combo };
}

async function cmdKeyboardRelease(ctx, { combo }) {
  const keys = parseKeyCombo(combo);
  for (const key of keys.reverse()) {
    await keyboard.releaseKey(key);
  }
  return { released: combo };
}

async function cmdWindowList(ctx) {
  // nut-js doesn't have window listing; use platform-specific
  // This is a placeholder - would need platform-specific implementation
  return { 
    windows: [], 
    note: 'Window listing requires platform-specific implementation (Windows: user32.dll, macOS: CGWindowList, Linux: wmctrl/xdotool)' 
  };
}

async function cmdWindowFocus(ctx, { title, app }) {
  return { focused: false, note: 'Window focus requires platform-specific implementation' };
}

async function cmdWindowBounds(ctx, { action = 'get', title, x, y, width, height }) {
  return { bounds: null, note: 'Window bounds requires platform-specific implementation' };
}

async function cmdWait(ctx, { ms = 1000 }) {
  await new Promise(r => setTimeout(r, ms));
  return { waited: ms };
}

// --- Tools (same as commands) ---
const tools = {
  cu_screenshot: cmdScreenshot,
  cu_mouse_move: cmdMouseMove,
  cu_mouse_click: cmdMouseClick,
  cu_mouse_drag: cmdMouseDrag,
  cu_mouse_scroll: cmdMouseScroll,
  cu_keyboard_type: cmdKeyboardType,
  cu_keyboard_press: cmdKeyboardPress,
  cu_keyboard_hold: cmdKeyboardHold,
  cu_keyboard_release: cmdKeyboardRelease,
  cu_window_list: cmdWindowList,
  cu_window_focus: cmdWindowFocus,
  cu_window_bounds: cmdWindowBounds,
  cu_wait: cmdWait
};

const commands = {
  'cu:screenshot': cmdScreenshot,
  'cu:mouse_move': cmdMouseMove,
  'cu:mouse_click': cmdMouseClick,
  'cu:mouse_drag': cmdMouseDrag,
  'cu:mouse_scroll': cmdMouseScroll,
  'cu:keyboard_type': cmdKeyboardType,
  'cu:keyboard_press': cmdKeyboardPress,
  'cu:keyboard_hold': cmdKeyboardHold,
  'cu:keyboard_release': cmdKeyboardRelease,
  'cu:window_list': cmdWindowList,
  'cu:window_focus': cmdWindowFocus,
  'cu:window_bounds': cmdWindowBounds,
  'cu:wait': cmdWait
};

export default { commands, tools };