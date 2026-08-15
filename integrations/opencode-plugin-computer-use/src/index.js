import { tool } from "@opencode-ai/plugin";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Button, Key, getActiveWindow, getWindows, keyboard, mouse } from "@nut-tree-fork/nut-js";
import screenshotDesktop from "screenshot-desktop";

const keyMap = {
  ctrl: Key.LeftControl, control: Key.LeftControl, alt: Key.LeftAlt, option: Key.LeftAlt,
  shift: Key.LeftShift, win: Key.LeftMeta, meta: Key.LeftMeta, cmd: Key.LeftMeta,
  enter: Key.Enter, return: Key.Enter, tab: Key.Tab, space: Key.Space, esc: Key.Escape,
  escape: Key.Escape, up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
  home: Key.Home, end: Key.End, pageup: Key.PageUp, pagedown: Key.PageDown,
  insert: Key.Insert, delete: Key.Delete, backspace: Key.Backspace,
  f1: Key.F1, f2: Key.F2, f3: Key.F3, f4: Key.F4, f5: Key.F5, f6: Key.F6,
  f7: Key.F7, f8: Key.F8, f9: Key.F9, f10: Key.F10, f11: Key.F11, f12: Key.F12,
};

function parseKeys(combo) {
  return combo.split("+").map((part) => keyMap[part.trim().toLowerCase()] ?? part.trim());
}

function result(title, value) {
  return { title, output: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

const computerTools = {
  computer_screenshot: tool({
    description: "Capture the physical desktop. This is OS-level automation; review the image before acting on sensitive UI.",
    args: { savePath: tool.schema.string().optional(), format: tool.schema.enum(["png", "jpg"]).optional() },
    async execute(args, context) {
      const format = args.format || "png";
      const bytes = await screenshotDesktop({ format });
      let saved;
      if (args.savePath) {
        saved = resolve(context.worktree, args.savePath);
        await writeFile(saved, bytes);
      }
      const mime = format === "jpg" ? "image/jpeg" : "image/png";
      return { title: "Computer screenshot", output: saved ? `Saved to ${saved}` : "Desktop screenshot captured", attachments: [{ type: "file", mime, url: `data:${mime};base64,${bytes.toString("base64")}`, filename: `computer-screenshot.${format}` }] };
    },
  }),
  computer_mouse_move: tool({
    description: "Move the physical mouse to screen coordinates.",
    args: { x: tool.schema.number().int().min(0), y: tool.schema.number().int().min(0) },
    async execute(args) { await mouse.move([{ x: args.x, y: args.y }]); return result("Computer mouse move", args); },
  }),
  computer_mouse_click: tool({
    description: "Click the physical mouse at screen coordinates.",
    args: { x: tool.schema.number().int().min(0).optional(), y: tool.schema.number().int().min(0).optional(), button: tool.schema.enum(["left", "right", "middle"]).optional(), count: tool.schema.number().int().min(1).max(2).optional() },
    async execute(args) {
      if (args.x !== undefined && args.y !== undefined) await mouse.move([{ x: args.x, y: args.y }]);
      const button = args.button === "right" ? Button.RIGHT : args.button === "middle" ? Button.MIDDLE : Button.LEFT;
      for (let index = 0; index < (args.count || 1); index += 1) await mouse.click(button);
      return result("Computer mouse click", { button: args.button || "left", count: args.count || 1, x: args.x, y: args.y });
    },
  }),
  computer_mouse_drag: tool({
    description: "Drag the physical mouse between two screen coordinates.",
    args: { fromX: tool.schema.number().int().min(0), fromY: tool.schema.number().int().min(0), toX: tool.schema.number().int().min(0), toY: tool.schema.number().int().min(0) },
    async execute(args) { await mouse.move([{ x: args.fromX, y: args.fromY }]); await mouse.drag([{ x: args.toX, y: args.toY }]); return result("Computer mouse drag", args); },
  }),
  computer_mouse_scroll: tool({
    description: "Scroll the physical mouse wheel.",
    args: { delta: tool.schema.number().int().min(-10000).max(10000), x: tool.schema.number().int().min(0).optional(), y: tool.schema.number().int().min(0).optional() },
    async execute(args) { if (args.x !== undefined && args.y !== undefined) await mouse.move([{ x: args.x, y: args.y }]); await mouse.scroll(args.delta); return result("Computer mouse scroll", args); },
  }),
  computer_keyboard_type: tool({
    description: "Type text into the focused desktop application. Do not use for passwords, OTPs, or other secrets.",
    args: { text: tool.schema.string() },
    async execute(args) { await keyboard.type(args.text); return result("Computer keyboard type", { characters: args.text.length }); },
  }),
  computer_keyboard_press: tool({
    description: "Press a key or key combination such as ctrl+c, alt+tab, or enter.",
    args: { combo: tool.schema.string() },
    async execute(args) { await keyboard.pressKey(...parseKeys(args.combo)); return result("Computer keyboard press", { combo: args.combo }); },
  }),
  computer_window_list: tool({
    description: "List visible desktop windows with titles and bounds.",
    args: {},
    async execute() {
      const windows = await getWindows();
      const data = [];
      for (const window of windows) {
        const region = await window.getRegion().catch(() => null);
        data.push({ title: await window.getTitle().catch(() => ""), region });
      }
      return result("Computer windows", data);
    },
  }),
  computer_window_focus: tool({
    description: "Focus a desktop window by case-insensitive title substring.",
    args: { title: tool.schema.string() },
    async execute(args) {
      const windows = await getWindows();
      const window = (await Promise.all(windows.map(async (candidate) => ({ candidate, title: await candidate.getTitle().catch(() => "") })))).find((item) => item.title.toLowerCase().includes(args.title.toLowerCase()))?.candidate;
      if (!window) throw new Error(`Window not found: ${args.title}`);
      await window.focus();
      return result("Computer window focused", { title: await window.getTitle() });
    },
  }),
  computer_window_bounds: tool({
    description: "Read or update a desktop window's position and size by title substring.",
    args: { title: tool.schema.string(), action: tool.schema.enum(["get", "set"]).optional(), x: tool.schema.number().int().min(0).optional(), y: tool.schema.number().int().min(0).optional(), width: tool.schema.number().int().min(1).optional(), height: tool.schema.number().int().min(1).optional() },
    async execute(args) {
      const windows = await getWindows();
      const window = (await Promise.all(windows.map(async (candidate) => ({ candidate, title: await candidate.getTitle().catch(() => "") })))).find((item) => item.title.toLowerCase().includes(args.title.toLowerCase()))?.candidate;
      if (!window) throw new Error(`Window not found: ${args.title}`);
      if ((args.action || "get") === "set") {
        if (args.x !== undefined && args.y !== undefined) await window.move({ x: args.x, y: args.y });
        if (args.width !== undefined && args.height !== undefined) await window.resize({ width: args.width, height: args.height });
      }
      return result("Computer window bounds", { title: await window.getTitle(), region: await window.getRegion() });
    },
  }),
  computer_active_window: tool({
    description: "Read the active desktop window title and bounds.",
    args: {},
    async execute() { const window = await getActiveWindow(); return result("Computer active window", { title: await window.getTitle(), region: await window.getRegion() }); },
  }),
  computer_wait: tool({
    description: "Wait for a bounded number of milliseconds while a GUI changes.",
    args: { milliseconds: tool.schema.number().int().min(0).max(120000) },
    async execute(args) { await new Promise((resolvePromise) => setTimeout(resolvePromise, args.milliseconds)); return result("Computer wait", args); },
  }),
};

export const ComputerUsePlugin = async () => ({ tool: computerTools });
