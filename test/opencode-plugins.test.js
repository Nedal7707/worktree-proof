import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PLUGINS = [
  {
    id: 'opencode-plugin-chrome-use',
    exportName: 'ChromeUsePlugin',
    expectedTools: [
      'chrome_connect', 'chrome_navigate', 'chrome_click', 'chrome_fill', 'chrome_type',
      'chrome_scroll', 'chrome_screenshot', 'chrome_extract', 'chrome_wait', 'chrome_tabs',
      'chrome_evaluate', 'chrome_console', 'chrome_network',
    ],
  },
  {
    id: 'opencode-plugin-computer-use',
    exportName: 'ComputerUsePlugin',
    expectedTools: [
      'computer_screenshot', 'computer_mouse_move', 'computer_mouse_click', 'computer_mouse_drag',
      'computer_mouse_scroll', 'computer_keyboard_type', 'computer_keyboard_press',
      'computer_window_list', 'computer_window_focus', 'computer_window_bounds',
      'computer_active_window', 'computer_wait',
    ],
  },
  {
    id: 'opencode-plugin-goal-plan',
    exportName: 'GoalPlanPlugin',
    expectedTools: [
      'goal_set', 'goal_show', 'goal_clear', 'plan_create', 'plan_show', 'plan_update',
      'task_next', 'task_start', 'task_done', 'review_gate', 'review_summary',
    ],
  },
  {
    id: 'opencode-plugin-worktree-proof',
    exportName: 'WorktreeProofPlugin',
    expectedTools: [
      'wp_doctor', 'wp_capabilities', 'wp_status', 'wp_plan', 'wp_reserve', 'wp_run',
      'wp_close', 'wp_release', 'wp_validate', 'wp_cleanup', 'wp_leases', 'wp_tools',
      'wp_recipes', 'wp_resources', 'wp_bridge_inbox', 'wp_manifest',
    ],
  },
];

for (const plugin of PLUGINS) {
  test(`${plugin.id} loads and exposes the expected tool set`, async () => {
    const module = await import(pathToFileURL(path.join(projectRoot, 'integrations', plugin.id, 'src', 'index.js')).href);
    assert.equal(typeof module[plugin.exportName], 'function', `${plugin.exportName} must be a plugin function`);

    const clientStub = { app: { log: async () => {} } };
    const hooks = await module[plugin.exportName]({ client: clientStub });
    assert.ok(hooks && typeof hooks === 'object', 'plugin must return hooks');
    assert.ok(hooks.tool, 'plugin must expose tools');
    const toolNames = Object.keys(hooks.tool);
    for (const name of plugin.expectedTools) {
      assert.ok(toolNames.includes(name), `${plugin.id} should expose ${name}`);
      const definition = hooks.tool[name];
      assert.equal(typeof definition.description, 'string', `${name} must have a description`);
      assert.ok(definition.description.length > 10, `${name} description must be substantive`);
      assert.ok(definition.args && typeof definition.args === 'object', `${name} must declare args`);
      assert.equal(typeof definition.execute, 'function', `${name} must implement execute`);
    }
  });
}
