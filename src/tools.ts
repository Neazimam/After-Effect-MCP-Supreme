// MCP tool registry. Every call is logged, attributed to the connected AI client, and gated by dashboard settings.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clip, type Hub } from './hub';

const INSTRUCTIONS = `Controls Adobe After Effects through a live bridge.
Workflow: ae_get_project -> ae_get_comp -> ae_inspect (discover property paths/matchNames) -> mutate.
Conventions: layer indexes are 1-based; times are seconds; colors are hex ("#ff3366") or [r,g,b] 0-1 (values >1 are read as 0-255);
property paths use "/" with display names or matchNames, e.g. "Transform/Position" or "Effects/Gaussian Blur/Blurriness".
Each tool call is a single undo step in After Effects. ae_execute_script runs arbitrary ExtendScript when no structured tool fits.`;

const compRef = z.union([z.string(), z.number().int()]).optional()
  .describe('Composition name or project item index. Defaults to the active composition.');
const layerRef = z.union([z.string(), z.number().int()]).describe('Layer name or 1-based index.');
const propPath = z.string().describe('Property path separated by "/", display names or matchNames. e.g. "Transform/Opacity", "ADBE Transform Group/ADBE Position", "Contents/Group 1/Contents/Fill 1/Color". Use ae_inspect to discover.');
const color = z.union([z.string(), z.array(z.number()).min(3).max(4)]).describe('Hex "#rrggbb" or [r,g,b] in 0-1 (values >1 treated as 0-255).');
const easing = z.enum(['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut']);

type Opts = { mutating?: boolean; raw?: boolean; timeoutMs?: number };

export function buildServer(hub: Hub): McpServer {
  const server = new McpServer({ name: 'ae-supreme-mcp', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  const def = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, opts: Opts, run: (a: any) => Promise<unknown>) => {
    (server as any).tool(name, description, shape, async (args: any, extra: any) => {
      const sid: string | undefined = extra?.sessionId;
      const client = sid ? hub.clients.get(sid) : undefined;
      hub.touch(sid);
      const entry = hub.log({ kind: 'tool', tool: name, client: client?.name ?? 'unknown', sessionId: sid, status: 'running', message: name, args: clip(args) });
      const t0 = Date.now();
      try {
        if (opts.raw && !hub.settings.allowRawScripts) throw new Error('Raw script execution is disabled in the dashboard settings.');
        if (opts.mutating && hub.settings.readOnly) throw new Error('Read-only mode is ON in the dashboard; this tool would modify the project.');
        const result = await run(args);
        hub.finishTool(entry.id, sid, Date.now() - t0, true, result);
        let text = JSON.stringify(result ?? null, null, 2);
        if (text.length > 100_000) text = text.slice(0, 100_000) + '\n... [truncated]';
        return { content: [{ type: 'text', text }] };
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        hub.finishTool(entry.id, sid, Date.now() - t0, false, msg);
        return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] };
      }
    });
  };

  const call = (fn: string, args: unknown, o: Opts = {}) =>
    hub.bridge.call({ op: 'call', fn, args, undoName: `MCP: ${fn}` }, o.timeoutMs);

  def('ae_status', 'Daemon + After Effects connection status, connected AI clients, and active safety settings.', {}, {}, async () => ({
    afterEffects: hub.bridge.status(), settings: hub.settings,
    clients: hub.clientList().map((c) => ({ name: c.name, version: c.version, connected: c.connected, calls: c.calls })),
  }));

  def('ae_execute_script',
    'Run arbitrary ExtendScript inside After Effects. `code` is the BODY of a function: use `return` to send data back (must be JSON-able). ' +
    'Helpers: AEX.helpers.findComp(ref), findLayer(comp, ref), getProp(layer, path), setVal(prop, v, time), col(hexOrArray). Runs as one undo step. ES3 syntax (var, no arrow functions).',
    { code: z.string().describe('ExtendScript function body.'), undoName: z.string().optional() },
    { mutating: true, raw: true, timeoutMs: 120_000 },
    (a) => hub.bridge.call({ op: 'exec', code: a.code, undoName: a.undoName || 'MCP: script' }, 120_000));

  def('ae_get_project', 'List project items (comps, footage, folders, solids) and the active comp.', {}, {}, () => call('project', {}));
  def('ae_get_comp', 'Composition settings plus a summary of every layer (type, in/out, parent, effects count).', { comp: compRef }, {}, (a) => call('comp', a));
  def('ae_inspect',
    'Walk a layer\'s property tree (or a sub-path) returning names, matchNames, values, keyframe counts and expressions. Use this to discover property paths.',
    { comp: compRef, layer: layerRef, path: z.string().optional().describe('Sub-path to inspect; omit for the whole layer.'), depth: z.number().int().min(0).max(6).optional().describe('Tree depth, default 2.') },
    {}, (a) => call('inspect', a));

  def('ae_create_comp', 'Create a composition and open it.',
    { name: z.string(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), duration: z.number().positive().optional(),
      frameRate: z.number().positive().optional(), pixelAspect: z.number().positive().optional(), backgroundColor: color.optional() },
    { mutating: true }, (a) => call('createComp', a));

  def('ae_add_layer', 'Add a layer: text, solid, shape, null, camera, light, adjustment, footage (file path) or comp (precomp via `source`).',
    { comp: compRef, type: z.enum(['text', 'solid', 'shape', 'null', 'camera', 'light', 'adjustment', 'footage', 'comp']),
      name: z.string().optional(), text: z.string().optional(), font: z.string().optional(), fontSize: z.number().optional(), color: color.optional(),
      width: z.number().optional(), height: z.number().optional(), position: z.array(z.number()).min(2).max(3).optional(),
      shape: z.enum(['rectangle', 'ellipse', 'star', 'polygon']).optional(), size: z.array(z.number()).length(2).optional(), points: z.number().int().optional(),
      fill: color.optional(), stroke: color.optional(), strokeWidth: z.number().optional(),
      startTime: z.number().optional(), duration: z.number().optional(), threeD: z.boolean().optional(),
      file: z.string().optional().describe('Absolute path for type "footage".'), source: z.union([z.string(), z.number().int()]).optional().describe('Comp to nest for type "comp".') },
    { mutating: true }, (a) => call('addLayer', a));

  def('ae_set_property', 'Set a property value (or a keyframe if `time` is given). Colors accept hex. Text: pass a string or {text,font,fontSize,fillColor,justification}.',
    { comp: compRef, layer: layerRef, path: propPath, value: z.any(), time: z.number().optional() },
    { mutating: true }, (a) => call('setProperty', a));

  def('ae_set_keyframes', 'Set multiple keyframes on a property with optional easing (linear, hold, easeIn, easeOut, easeInOut).',
    { comp: compRef, layer: layerRef, path: propPath, keys: z.array(z.object({ time: z.number(), value: z.any(), easing: easing.optional() })).min(1), clear: z.boolean().optional().describe('Remove existing keyframes first.') },
    { mutating: true }, (a) => call('setKeyframes', a));

  def('ae_set_expression', 'Set (or remove with empty string) an expression on a property. Returns expressionError if AE rejects it.',
    { comp: compRef, layer: layerRef, path: propPath, expression: z.string() },
    { mutating: true }, (a) => call('setExpression', a));

  def('ae_add_effect', 'Add an effect by display name or matchName (e.g. "ADBE Gaussian Blur 2") and optionally set parameters. Returns the effect\'s parameter list.',
    { comp: compRef, layer: layerRef, effect: z.string(), settings: z.record(z.string(), z.any()).optional().describe('{ "Blurriness": 25 }') },
    { mutating: true }, (a) => call('addEffect', a));

  def('ae_layer_op', 'Layer operations: delete, duplicate (value=new name), rename (value), parent (value=layer or null), moveTo (value=index), solo/lock/shy/enable (value=bool).',
    { comp: compRef, layer: layerRef, op: z.enum(['delete', 'duplicate', 'rename', 'parent', 'moveTo', 'solo', 'lock', 'shy', 'enable']), value: z.any().optional() },
    { mutating: true }, (a) => call('layerOp', a));

  def('ae_menu_command', 'Run any After Effects menu command by its exact English name (e.g. "Save", "Reduce Project") or numeric command id.',
    { name: z.string().optional(), id: z.number().int().optional() }, { mutating: true }, (a) => call('menuCommand', a));

  def('ae_import', 'Import files into the project; optionally add them as layers to a comp.',
    { paths: z.array(z.string()).min(1), comp: compRef }, { mutating: true }, (a) => call('importFiles', a));

  def('ae_render', 'Add a comp to the render queue with an output path. Set start=true to render now (blocks After Effects until done).',
    { comp: compRef, outputPath: z.string(), outputTemplate: z.string().optional(), renderSettings: z.string().optional(), start: z.boolean().optional() },
    { mutating: true, timeoutMs: 3_600_000 }, (a) => call('render', a, { timeoutMs: a.start ? 3_600_000 : 30_000 }));

  return server;
}
