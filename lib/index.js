/* dsh-v4flash-tiler — host half (auto-tiling only).
 *
 * On every DSH boot, one root listener on the `agent/pre-step` waterfall
 * replaces oversized images in every user-authored message with a sequence of
 * labelled overlapping tile attachments before the request reaches the model:
 *
 *   - each tile is produced by the `v4flash_tiler` Python driver in
 *     `job: "tile"` mode (base64 in/out, no temp files) and committed through
 *     the `attachments` service, so the model adapter serves it like any
 *     other image block;
 *   - the message gains layout metadata: source dimensions, grid (rows x
 *     cols), overlap, and a per-tile 「第 r 行，第 c 列」 label, so the model
 *     can mentally stitch the tiles back into the source image and knows to
 *     ignore overlap duplicates;
 *   - when several images are sent in one message, each image's tiles are a
 *     labelled group (「第 X 张原图」) with an explicit instruction never to
 *     merge tiles across different source images.
 *
 * Small images pass untouched; any failure keeps the original image (with a
 * visible note in the message, never breaking the chat).
 */
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const name = 'dsh-v4flash-tiler';
export const inject = [];

const DRIVER_COMMAND = 'python -m v4flash_tiler.driver';
const DRIVER_WORKDIR = 'D:\\dsh_files';
const DRIVER_TIMEOUT_MS = 240000;
const TILE_STDOUT_MAX = 32 * 1024 * 1024;

const TILE_DEFAULTS = {
  tile_size: 1024,
  overlap: 0.15,
  max_tiles: 9,
  jpeg_quality: 90,
};

// Tile whenever the image is bigger than one tile: the vision model downsizes
// anything larger to ~800x800 and loses small text (screenshots, diagrams).
// A single 1024px tile is the largest useful unit, so that is the threshold.
const OVERSIZE_SIDE = 1024;
const OVERSIZE_PIXELS = 1_000_000;
const OVERSIZE_BYTES = 10 * 1024 * 1024;

// attachmentId -> { refs, count, rows, cols, width, height, overlap, tiles:[{row,col}] }.
// The session log keeps the ORIGINAL image blocks, so every step re-visits the
// same attachments; the cache makes that cheap and keeps blocks idempotent.
const tileCache = new Map();
const TILE_CACHE_MAX = 200;
function cacheGet(id) {
  const hit = tileCache.get(id);
  if (hit !== undefined) {
    // refresh LRU order
    tileCache.delete(id);
    tileCache.set(id, hit);
  }
  return hit;
}
function cacheSet(id, value) {
  if (tileCache.size >= TILE_CACHE_MAX) {
    const first = tileCache.keys().next().value;
    if (first !== undefined) tileCache.delete(first);
  }
  tileCache.set(id, value);
}

function base64FromBytes(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function bytesFromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function isOversizedRef(ref) {
  if (ref === null || typeof ref !== 'object') return false;
  const width = typeof ref.width === 'number' ? ref.width : 0;
  const height = typeof ref.height === 'number' ? ref.height : 0;
  const bytes = typeof ref.bytes === 'number' ? ref.bytes : 0;
  return (
    Math.max(width, height) > OVERSIZE_SIDE ||
    width * height > OVERSIZE_PIXELS ||
    bytes > OVERSIZE_BYTES
  );
}

/** Resolve the execution sandbox policy the way first-party tools do. */
function resolveSandboxPolicy(ctx, agent) {
  const svc = ctx.get('sandboxPolicy');
  if (svc === undefined || typeof svc.resolve !== 'function') return undefined;
  try {
    const session = agent !== null && typeof agent === 'object' ? agent.session : undefined;
    return session === undefined ? svc.resolve({}) : svc.resolve({ session });
  } catch (error) {
    console.error('dsh-v4flash-tiler: sandboxPolicy resolve failed', error);
    return undefined;
  }
}

/**
 * Run one shell request against whichever `ctx.shell` generation is mounted.
 *
 * The shell seam changed shape. Current DSH exposes a two-step contract —
 * `resolve(request)` -> spec, `execute(spec)` -> handle, then
 * `await handle.result()` for the foreground projection:
 *
 *   const result = await (await ctx.shell.execute(ctx.shell.resolve(req))).result()
 *
 * This plugin was written against an older one-shot `shell.run(spec)` form, so
 * every call threw "shell.run: shell.run is not a function" and the auto-tiler
 * silently fell back to the untiled original image. Support both shapes here so
 * the plugin keeps working either way.
 *
 * Resolves to a ShellRunResult ({exitCode, stdout, stderr, timedOut, ...}).
 * Rejects only for infrastructure failures, like the seam itself.
 */
async function shellRun(ctx, request, agent) {
  const shell = ctx.get('shell');
  if (shell === undefined) throw new Error('shell service unavailable');
  if (typeof shell.resolve !== 'function') throw new Error('shell.resolve unavailable');

  const req = Object.assign({}, request);
  const policy = resolveSandboxPolicy(ctx, agent);
  if (policy !== undefined) req.sandboxPolicy = policy;
  const spec = shell.resolve(req);

  if (typeof shell.execute === 'function') {
    const execution = await shell.execute(spec);
    if (execution !== null && typeof execution === 'object' && typeof execution.result === 'function') {
      return await execution.result();
    }
    // A host may hand back the settled result straight from execute().
    return execution;
  }
  if (typeof shell.run === 'function') return await shell.run(spec);
  throw new Error('no usable shell execution method (expected shell.execute(spec).result() or shell.run(spec))');
}

/** Tile one attachment via the Python driver. Returns {ok:true, layout} or {ok:false, error}. */
async function tileAttachment(ctx, ref, signal, agent) {
  const shell = ctx.get('shell');
  const attachments = ctx.get('attachments');
  if (shell === undefined) return { ok: false, error: 'shell service unavailable' };
  if (typeof shell.resolve !== 'function') return { ok: false, error: 'shell.resolve unavailable' };
  if (attachments === undefined) return { ok: false, error: 'attachments service unavailable' };

  let stored;
  try {
    stored = await attachments.readImage(ref, signal);
  } catch (error) {
    console.error('dsh-v4flash-tiler: readImage failed', error);
    return { ok: false, error: 'readImage: ' + (error && error.message ? error.message : String(error)) };
  }

  const payload = {
    job: 'tile',
    image_b64: base64FromBytes(stored.data),
    tile_size: TILE_DEFAULTS.tile_size,
    overlap: TILE_DEFAULTS.overlap,
    max_tiles: TILE_DEFAULTS.max_tiles,
    jpeg_quality: TILE_DEFAULTS.jpeg_quality,
  };

  let result;
  try {
    const request = {
      command: DRIVER_COMMAND,
      workdir: DRIVER_WORKDIR,
      timeoutMs: DRIVER_TIMEOUT_MS,
      stdoutMaxBytes: TILE_STDOUT_MAX,
      stdin: JSON.stringify(payload),
      env: { PYTHONIOENCODING: 'utf-8' },
    };
    result = await shellRun(ctx, request, agent);
  } catch (error) {
    console.error('dsh-v4flash-tiler: tile driver run failed', error);
    return { ok: false, error: 'shell exec: ' + (error && error.message ? error.message : String(error)) };
  }

  if (result.exitCode !== 0) {
    const errText =
      ((result.stderr && result.stderr.text) || '') +
      ((result.stdout && result.stdout.text) || '');
    console.error('dsh-v4flash-tiler: tile driver exited', result.exitCode, errText);
    return { ok: false, error: 'driver exit ' + String(result.exitCode) + ': ' + errText.slice(0, 300) };
  }
  let out = null;
  try {
    out = JSON.parse(result.stdout.text);
  } catch (error) {
    console.error('dsh-v4flash-tiler: tile driver returned invalid JSON', error);
    return { ok: false, error: 'driver invalid JSON: ' + result.stdout.text.slice(0, 200) };
  }
  if (out === null || typeof out !== 'object' || typeof out.error === 'string') {
    console.error('dsh-v4flash-tiler: tile driver error', out && out.error);
    return { ok: false, error: 'driver error: ' + (out && out.error) };
  }
  if (out.triggered !== true || !Array.isArray(out.tiles) || out.tiles.length === 0) {
    return { ok: false, error: 'driver produced no tiles' };
  }

  try {
    const saved = await attachments.saveImages(
      out.tiles.map((tile, index) => ({
        data: bytesFromBase64(tile.data_b64),
        mediaType: 'image/jpeg',
        name: (ref.name || 'image') + '-tile-' + String(index + 1) + '.jpg',
      })),
    );
    return {
      ok: true,
      refs: saved,
      count: out.tiles.length,
      rows: typeof out.grid_rows === 'number' ? out.grid_rows : 1,
      cols: typeof out.grid_cols === 'number' ? out.grid_cols : 1,
      width: typeof out.image_width === 'number' ? out.image_width : ref.width,
      height: typeof out.image_height === 'number' ? out.image_height : ref.height,
      overlap: typeof out.overlap === 'number' ? out.overlap : TILE_DEFAULTS.overlap,
      tiles: out.tiles.map((tile) => ({
        row: typeof tile.row === 'number' ? tile.row : 0,
        col: typeof tile.col === 'number' ? tile.col : 0,
      })),
    };
  } catch (error) {
    console.error('dsh-v4flash-tiler: saveImages failed', error);
    return { ok: false, error: 'saveImages: ' + (error && error.message ? error.message : String(error)) };
  }
}

/**
 * Tiler switch — this plugin's OWN setting, independent of dsh-vision-helper.
 *
 * Until 2026-10-08 this plugin read the vision helper's config
 * (~/.dsh/vision-helper/config.json) so that one `mode` controlled both. That
 * coupling was wrong: turning tiling ON for a vision-capable model forced the
 * vision helper's routing ON too (and vice versa), even though the two features
 * are unrelated.
 *
 * The switch now lives in ~/.dsh/v4flash-tiler/config.json:
 *   auto   (default) tile only for models WITHOUT native vision
 *   off              never tile (chat images pass through untouched)
 *   always           tile every oversized image, even for vision-capable models
 *
 * On first read, if our own config is missing but the old shared one exists, the
 * legacy `mode` is migrated once so the previous intent survives; after that the
 * vision helper's file is never consulted again.
 */
function tilerHomeDir() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}
function tilerConfigFile() {
  return path.join(tilerHomeDir(), 'v4flash-tiler', 'config.json');
}
function legacySharedConfigFile() {
  return path.join(tilerHomeDir(), 'vision-helper', 'config.json');
}

const TILE_MODES = ['auto', 'off', 'always'];
function parseModeFromJson(raw) {
  try {
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(text);
    const mode = parsed && typeof parsed === 'object' ? parsed.mode : undefined;
    if (TILE_MODES.includes(mode)) return mode;
  } catch { /* malformed config: caller keeps its default */ }
  return undefined;
}

let tilerConfigCache = { at: 0, value: { mode: 'auto' } };

/** Persist the tiler switch and refresh the cache. Returns the written mode. */
function writeTilerConfig(mode) {
  const next = TILE_MODES.includes(mode) ? mode : 'auto';
  const file = tilerConfigFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ mode: next }, null, 2) + '\n', 'utf8');
  tilerConfigCache = { at: Date.now(), value: { mode: next } };
  return next;
}

function readTilerConfig() {
  if (Date.now() - tilerConfigCache.at < 10000) return tilerConfigCache.value;

  let value = { mode: 'auto' };
  let loaded = false;
  const own = tilerConfigFile();
  if (existsSync(own)) {
    try {
      const mode = parseModeFromJson(readFileSync(own, 'utf8'));
      if (mode !== undefined) { value = { mode }; loaded = true; }
    } catch { /* fall through to migration */ }
  }
  if (!loaded) {
    // One-time migration from the old shared switch, so an existing
    // `always`/`off` choice is not silently reset to `auto`.
    let migrated = 'auto';
    try {
      const legacy = legacySharedConfigFile();
      if (existsSync(legacy)) {
        const mode = parseModeFromJson(readFileSync(legacy, 'utf8'));
        if (mode !== undefined) migrated = mode;
      }
    } catch { /* keep the safe default */ }
    value = { mode: migrated };
    try {
      writeTilerConfig(migrated);
      console.error('dsh-v4flash-tiler: created own config ' + tilerConfigFile() + ' (migrated mode="' + migrated + '")');
    } catch (error) {
      console.error('dsh-v4flash-tiler: could not create own config (' + String(error && error.message || error) + ')');
    }
  }
  tilerConfigCache = { at: Date.now(), value };
  return value;
}

const sessionModalityCache = new Map();
let nativeVisionSkipLogged = false;

/** true/false when the session model's modality is known, null when unknown. */
async function sessionModelAcceptsImages(ctx, agent) {
  const llm = ctx.get('llm');
  if (!llm || typeof llm.resolveModelInfo !== 'function') return null;
  let provider;
  let model;
  try {
    const session = agent && agent.session;
    const header = session && typeof session.requestHeader === 'function' ? session.requestHeader() : null;
    if (header && header.config) {
      provider = header.config.provider;
      model = header.config.model;
    }
  } catch { /* best effort */ }
  if (!provider || !model) return null;
  const key = provider + '/' + model;
  const hit = sessionModalityCache.get(key);
  if (hit && Date.now() - hit.at < 600000) return hit.value;
  let value = null;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    value = info && Array.isArray(info.inputModalities) ? info.inputModalities.includes('image') : null;
  } catch {
    value = null;
  }
  sessionModalityCache.set(key, { value, at: Date.now() });
  return value;
}

/** Replace oversized images in one message list. Returns the original array when nothing changed. */
async function maybeTileMessages(ctx, messages, signal, agent) {
  const own = readTilerConfig();
  if (own.mode === 'off') return messages;
  if (own.mode !== 'always') {
    const native = await sessionModelAcceptsImages(ctx, agent);
    if (native === true) {
      if (!nativeVisionSkipLogged) {
        nativeVisionSkipLogged = true;
        console.error('dsh-v4flash-tiler: session model has native image input - auto-tiling skipped (set tiler_route(mode="always") to force it)');
      }
      return messages;
    }
  }
  const attachments = ctx.get('attachments');
  if (attachments === undefined) return messages;
  const limits = attachments.imageLimits;

  let changed = false;
  const next = [];

  for (const message of messages) {
    if (message === null || typeof message !== 'object') {
      next.push(message);
      continue;
    }
    if (message.role !== 'user') {
      next.push(message);
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    const imageBlockCount = blocks.filter((b) => b !== null && typeof b === 'object' && b.type === 'image').length;
    const warnMix = imageBlockCount > 1;
    if (!blocks.some((b) => b !== null && typeof b === 'object' && b.type === 'image')) {
      next.push(message);
      continue;
    }

    const outBlocks = [];
    let messageChanged = false;
    let tilesInThisMessage = 0;
    let imageIndex = 0;

    for (const block of blocks) {
      if (block === null || typeof block !== 'object' || block.type !== 'image') {
        outBlocks.push(block);
        continue;
      }
      imageIndex += 1;
      const ref = block.attachment;
      const attachmentId = ref && typeof ref === 'object' ? ref.attachmentId : undefined;
      if (typeof attachmentId !== 'string' || !isOversizedRef(ref)) {
        outBlocks.push(block);
        continue;
      }

      let tiled = cacheGet(attachmentId);
      if (tiled === undefined) {
        tiled = await tileAttachment(ctx, ref, signal, agent);
        if (tiled.ok !== true) {
          // tiling failed: keep the original block AND surface the reason
          outBlocks.push({
            type: 'text',
            text: '（[v4flash-tiler] 第 ' + String(imageIndex) + ' 张原图自动切块失败，已使用原图。原因：' + String(tiled.error).slice(0, 300) + '）',
          });
          outBlocks.push(block);
          changed = true;
          messageChanged = true;
          continue;
        }
        cacheSet(attachmentId, tiled);
      }

      const cap = typeof limits === 'object' && typeof limits.maxImagesPerMessage === 'number'
        ? limits.maxImagesPerMessage
        : 24;
      if (tilesInThisMessage + tiled.count > cap) {
        outBlocks.push(block);
        continue;
      }
      tilesInThisMessage += tiled.count;
      console.error('dsh-v4flash-tiler: tiled attachment ' + String(attachmentId) + ' into ' + String(tiled.count) + ' tiles');

      // Group header: source metadata + stitching instructions.
      outBlocks.push({
        type: 'text',
        text:
          '【第 ' + String(imageIndex) + ' 张原图】尺寸 ' + String(tiled.width) + '×' + String(tiled.height) +
          '，已按从左到右、从上到下的顺序切成 ' + String(tiled.rows) + ' 行 × ' + String(tiled.cols) + ' 列共 ' +
          String(tiled.count) + ' 块（重叠 ' + String(Math.round(tiled.overlap * 100)) + '%，相邻两块有重叠区域，边缘重复内容请忽略一次）。' +
          '请按以下「第 r 行第 c 列」的顺序逐块阅读，并在脑中按行列拼回整图。' +
          (warnMix
            ? '（本消息中共有 ' + String(imageBlockCount) + ' 张原图，每张原图的块自成一组，绝不能跨原图混拼。）'
            : ''),
      });
      for (let i = 0; i < tiled.refs.length; i++) {
        const info = tiled.tiles[i] || { row: 0, col: i };
        outBlocks.push({
          type: 'text',
          text:
            '第 ' + String(imageIndex) + ' 张原图 · 第 ' + String(i + 1) + '/' + String(tiled.count) +
            ' 块（第 ' + String(info.row + 1) + ' 行，第 ' + String(info.col + 1) + ' 列）:',
        });
        outBlocks.push({ type: 'image', attachment: tiled.refs[i] });
      }
      changed = true;
      messageChanged = true;
    }

    if (!messageChanged) {
      next.push(message);
      continue;
    }
    next.push(Object.assign({}, message, { content: outBlocks }));
  }

  return changed ? next : messages;
}

/**
 * DeepSeek's chat-completions adapter only allows image content in user
 * messages. DSH may keep assistant-visible image attachments in the
 * conversation transcript; when those are sent back to the model in a later
 * turn, the adapter fails with:
 *
 *   "The DeepSeek chat-completions adapter cannot represent image content in a
 *    assistant message."
 *
 * This function replaces image blocks in non-user messages with a short text
 * placeholder so the conversation can continue without losing the fact that an
 * image was attached. The visible chat transcript is unaffected because this
 * only transforms the model-input messages for the current pre-step.
 */
function imagePlaceholder(block) {
  const ref = block && block.attachment;
  const name = ref && typeof ref.name === 'string' ? ref.name : '图片附件';
  const size =
    ref && typeof ref.width === 'number' && typeof ref.height === 'number'
      ? ` (${ref.width}×${ref.height})`
      : '';
  return {
    type: 'text',
    text: `[${name}${size}：助手消息中的图片附件已替换为文本占位]`,
  };
}

function sanitizeNonUserContentBlocks(blocks) {
  let changed = false;
  const sanitized = blocks.map((block) => {
    if (block !== null && typeof block === 'object' && block.type === 'image') {
      changed = true;
      return imagePlaceholder(block);
    }

    // `contentHasImage` in the DeepSeek adapter also recurses into tool-result
    // blocks, so images nested there must be sanitized too.
    if (
      block !== null &&
      typeof block === 'object' &&
      block.type === 'tool-result' &&
      Array.isArray(block.content)
    ) {
      const nested = sanitizeNonUserContentBlocks(block.content);
      if (nested.changed) {
        changed = true;
        return Object.assign({}, block, { content: nested.blocks });
      }
    }

    return block;
  });

  return { blocks: sanitized, changed };
}

function sanitizeNonUserImages(messages) {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (message === null || typeof message !== 'object') return message;
    if (message.role === 'user') return message;

    const blocks = Array.isArray(message.content) ? message.content : null;
    if (blocks === null) return message;

    const result = sanitizeNonUserContentBlocks(blocks);
    if (!result.changed) return message;

    changed = true;
    return Object.assign({}, message, { content: result.blocks });
  });

  return changed ? next : messages;
}

/**
 * Optional convenience: after a tool finishes and its result contains a newly
 * generated image (file path or DSH image attachment), open that image with the
 * host's default application so the user can see it immediately.
 *
 * This is deliberately conservative:
 *   - only image file extensions are opened;
 *   - only existing host files are opened;
 *   - read-only tools such as `read_image` are skipped;
 *   - each path is opened once per plugin lifetime.
 */
const OPEN_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
const OPEN_IMAGE_SKIP_TOOLS = new Set([
  'read',
  'read_image',
  'view',
  'ls',
  'list',
  'stat',
  'cat',
  'type',
  'head',
  'tail',
]);
const OPEN_IMAGE_MAX_PATHS = 20;
const openedImagePaths = new Set();
const OPENED_IMAGE_CACHE_MAX = 200;

function isImagePath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return OPEN_IMAGE_EXTS.has(ext);
}

function pushUniquePath(list, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  const cleaned = value.trim().replace(/[),;]+$/, '');
  if (cleaned.length === 0 || cleaned.startsWith('data:')) return;
  if (!list.includes(cleaned)) list.push(cleaned);
}

function collectStringPaths(value, out, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    pushUniquePath(out, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringPaths(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (/path|file|image|output|out|result|src|url/i.test(key)) {
        collectStringPaths(value[key], out, depth + 1);
      }
    }
  }
}

function addTextImagePaths(text, out) {
  if (typeof text !== 'string') return;
  const re = /([^\s"'<>|]+?\.(?:png|jpe?g|webp|gif|bmp|svg))/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[1]) pushUniquePath(out, match[1]);
  }
}

function addBlockImageHostPath(block, ctx, out) {
  if (block === null || typeof block !== 'object') return;
  if (block.type === 'image' && block.attachment) {
    const attachments = ctx.get('attachments');
    if (attachments && typeof attachments.imageHostPath === 'function') {
      try {
        const hostPath = attachments.imageHostPath(block.attachment);
        if (typeof hostPath === 'string' && hostPath) pushUniquePath(out, hostPath);
      } catch (error) {
        console.error('dsh-v4flash-tiler: imageHostPath failed', error);
      }
    }
  }
}

function extractImagePaths(exec, result, ctx) {
  const paths = [];
  const attachmentPaths = [];

  collectStringPaths(exec && exec.arguments, paths);
  collectStringPaths(result && result.value, paths);
  collectStringPaths(result && result.meta, paths);

  const content = result && Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      if (block.type === 'text' && typeof block.text === 'string') {
        addTextImagePaths(block.text, paths);
      }
      addBlockImageHostPath(block, ctx, attachmentPaths);
    }
  }

  return {
    paths: paths.filter(isImagePath),
    attachmentPaths,
  };
}

function resolveCandidatePath(candidate, agent) {
  let value = candidate.trim();
  if (value.startsWith('file://')) {
    try {
      value = new URL(value).pathname;
    } catch {
      // keep original if URL parsing fails
    }
  }

  if (path.isAbsolute(value)) return path.normalize(value);

  const session = agent && typeof agent === 'object' ? agent.session : undefined;
  const cwd =
    session && typeof session.cwd === 'string' && session.cwd
      ? session.cwd
      : session && session.meta && typeof session.meta.cwd === 'string' && session.meta.cwd
        ? session.meta.cwd
        : undefined;

  if (cwd) return path.resolve(cwd, value);
  return path.resolve(process.cwd(), value);
}

function buildOpenCommand(filePath) {
  const normalized = path.resolve(filePath);

  if (process.platform === 'win32') {
    const safe = normalized.replace(/'/g, "''");
    return `powershell -NoProfile -Command "Invoke-Item -LiteralPath '${safe}'"`;
  }

  if (process.platform === 'darwin') {
    return `open "${normalized.replace(/"/g, '\\"')}"`;
  }

  return `xdg-open "${normalized.replace(/"/g, '\\"')}"`;
}

async function openImageOnHost(filePath, ctx, agent) {
  const shell = ctx.get('shell');
  if (!shell || typeof shell.resolve !== 'function') {
    return false;
  }

  const request = {
    command: buildOpenCommand(filePath),
    timeoutMs: 30000,
    stdoutMaxBytes: 4096,
  };

  try {
    const result = await shellRun(ctx, request, agent);
    if (result.exitCode === 0) {
      console.error('dsh-v4flash-tiler: opened generated image:', filePath);
      return true;
    }
    const errText = ((result.stderr && result.stderr.text) || '').slice(0, 300);
    console.error('dsh-v4flash-tiler: open command failed', result.exitCode, errText);
  } catch (error) {
    console.error('dsh-v4flash-tiler: open command threw', error);
  }
  return false;
}

function openGeneratedImagesListener(ctx) {
  return async (exec, result) => {
    if (!result || result.isError) return;

    const toolName = typeof exec.name === 'string' ? exec.name.toLowerCase() : '';
    if (OPEN_IMAGE_SKIP_TOOLS.has(toolName)) return;

    const extracted = extractImagePaths(exec, result, ctx);
    const candidates = [...extracted.paths, ...extracted.attachmentPaths];
    let opened = 0;

    for (const candidate of candidates.slice(0, OPEN_IMAGE_MAX_PATHS)) {
      const resolved = resolveCandidatePath(candidate, exec.agent);
      if (openedImagePaths.has(resolved)) continue;
      if (!existsSync(resolved)) continue;
      // Attachment host paths are known to be images even when the storage
      // filename has no conventional image extension.
      if (!isImagePath(resolved) && !extracted.attachmentPaths.includes(candidate)) continue;

      const ok = await openImageOnHost(resolved, ctx, exec.agent);
      if (ok) {
        openedImagePaths.add(resolved);
        if (openedImagePaths.size > OPENED_IMAGE_CACHE_MAX) {
          const first = openedImagePaths.values().next().value;
          if (first !== undefined) openedImagePaths.delete(first);
        }
        opened += 1;
      }
    }

    if (opened > 0) {
      console.error(`dsh-v4flash-tiler: auto-opened ${opened} generated image(s) after tool ${toolName || '(unknown)'}`);
    }
  };
}

/** Build the pre-step listener (root-ctx registration, like dsh-compaction). */
function preStepListener(ctx) {
  return async (payload, next) => {
    // Let other pre-step listeners decide first, then transform the final messages.
    const decision = await next();
    if (decision === null || typeof decision !== 'object') return decision;
    if (decision.kind !== 'enter') return decision;
    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    const tiled = await maybeTileMessages(ctx, messages, payload && payload.signal, payload && payload.agent);
    const sanitized = sanitizeNonUserImages(tiled);
    if (sanitized === messages) return decision;
    if (tiled !== messages) {
      console.error('dsh-v4flash-tiler: pre-step replaced images with tiles');
    }
    return {
      kind: 'enter',
      messages: sanitized,
      startsRequestSeries: decision.startsRequestSeries,
    };
  };
}

/**
 * Register the `chat_send_image` tool using the DeepSeek-safe path.
 *
 * A generated image must NOT be appended as an `assistant` message: the
 * DeepSeek chat-completions adapter rejects image content in assistant
 * messages, which permanently corrupts the session history. The supported route
 * is to defer a plugin-originated `user` message (next-step context), which DSH
 * will surface as a visible image attachment and the model can see in the next
 * request.
 */
function registerChatSendImageTool(ctx) {
  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    console.error('dsh-v4flash-tiler: tools service unavailable at plugin apply; chat_send_image NOT registered');
    return;
  }

  const tool = {
    name: 'chat_send_image',
    description:
      'Post one local image file (PNG/JPG/WebP/GIF) into the current conversation '
      + 'as a visible image attachment. After an image is generated, call this to show it '
      + 'to the user right in the chat. Returns the attachment reference metadata on success. With text-only session models the image is saved as an attachment and auto-opened in the system viewer for the user.',
    parameters: {
      image_path: {
        type: 'string',
        required: true,
        description: 'Absolute path of the image file to post, e.g. D:\\GPT-Image\\result\\cat.png',
      },
      caption: {
        type: 'string',
        description: 'Optional short caption shown with the image.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          bytes: { type: 'number', required: true },
          postedAs: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const fs = ctx.get('fs');
      const attachments = ctx.get('attachments');
      if (fs === undefined || attachments === undefined) {
        throw new Error('chat_send_image requires fs and attachments services');
      }
      if (exec.agent === undefined) {
        throw new Error('chat_send_image requires an Agent-backed session');
      }

      const imagePath = String((args && args.image_path) || '').trim();
      if (imagePath === '') throw new Error('image_path is required');

      const target = await fs.resolve(imagePath);
      const maxBytes = 32 * 1024 * 1024;
      const data = await fs.readBytes(target, exec.signal, maxBytes);
      if (data.length === 0) throw new Error('image file is empty: ' + imagePath);

      const lower = imagePath.toLowerCase();
      let mediaType = 'image/png';
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mediaType = 'image/jpeg';
      else if (lower.endsWith('.webp')) mediaType = 'image/webp';
      else if (lower.endsWith('.gif')) mediaType = 'image/gif';

      const name = imagePath.split(/[\\/]/).pop() || 'image.png';
      const ref = await attachments.saveImage({ data, mediaType, name });

      const caption = typeof args.caption === 'string' && args.caption !== '' ? args.caption : 'Generated image';
      // pi-ai throws UNSUPPORTED_CONTENT when a request contains any image for
      // a model that does not declare image input - which would kill the whole
      // turn after the image is posted. So for text-only session models, post a
      // text notice + saved attachment instead of an image block.
      let modelAcceptsImages = true;
      try {
        const header = exec.agent.session && typeof exec.agent.session.requestHeader === 'function'
          ? exec.agent.session.requestHeader()
          : null;
        const providerId = header && header.config ? header.config.provider : void 0;
        const modelId = header && header.config ? header.config.model : void 0;
        const llm = ctx.get('llm');
        if (llm && typeof llm.resolveModelInfo === 'function' && providerId && modelId) {
          const info = await llm.resolveModelInfo(providerId, modelId);
          modelAcceptsImages = !(info && Array.isArray(info.inputModalities)) || info.inputModalities.includes('image');
        }
      } catch (err) {
        console.error('chat_send_image: modality lookup failed; assuming image-capable (' + String(err && err.message || err) + ')');
      }
      let content;
      let postedAs;
      if (modelAcceptsImages) {
        content = [{ type: 'image', attachment: ref }];
        if (caption !== '') content.push({ type: 'text', text: caption });
        postedAs = 'next-step context';
      } else {
        const shortId = String(ref.attachmentId).slice(0, 'sha256:'.length + 8);
        content = [{ type: 'text', text: '[图片已发送: ' + name + ' (' + (ref.width || '?') + 'x' + (ref.height || '?') + '), 附件ID=' + shortId + '\u2026。当前模型为纯文本，图片已保存为附件（未内嵌到消息），可用 image_understand 分析图片内容。]' + (caption !== '' ? '\n' + caption : '') }];
        postedAs = 'text notice (text-only model)';
      }
      if (!modelAcceptsImages) {
        // Text-only model: the image cannot appear inline in the chat context,
        // so open it with the host viewer - the whole point of the generation
        // workflow (no more digging through Explorer manually).
        try {
          const shellSvc = ctx.get('shell');
          if (shellSvc && typeof shellSvc.resolve === 'function') {
            await shellRun(ctx, {
              command: buildOpenCommand(imagePath),
              timeoutMs: 30000,
              stdoutMaxBytes: 4096,
            }, exec.agent);
          }
        } catch (err) {
          console.error('chat_send_image: auto-open failed (' + String(err && err.message || err) + ')');
        }
      }

      const message = {
        id: 'simg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
        role: 'user',
        content,
        source: {
          kind: 'plugin',
          plugin: 'v4flash-tiler',
          form: 'notice',
          summary: caption,
        },
      };

      // Legal model-visible route: user/next-step context, NOT assistant message.
      exec.deferContext(message);

      return {
        ok: true,
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        width: ref.width,
        height: ref.height,
        bytes: ref.bytes,
        postedAs,
      };
    },
  };

  // chat_send_image may already be registered by dsh-v4flash-publisher (both
  // bundles load in the same profile). Duplicate tools.register() throws and
  // would fail this whole plugin's apply(), killing the auto-tiler too — so
  // defer gracefully to whichever tool registered first.
  ctx.effect(() => {
    try {
      tools.register(tool);
    } catch (err) {
      console.error('dsh-v4flash-tiler: chat_send_image registration deferred (' + String(err && err.message || err) + ') — keeping the already-registered tool');
    }
  }, 'dsh-v4flash-tiler: chat_send_image');
}

/**
 * Register `tiler_route`: show or change THIS plugin's own switch.
 *
 * Deliberately separate from dsh-vision-helper's `vision_route`, so enabling
 * auto-tiling for a vision-capable model no longer forces the auxiliary vision
 * route on (and vice versa).
 */
function registerTilerRouteTool(ctx) {
  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    console.error('dsh-v4flash-tiler: tools service unavailable at plugin apply; tiler_route NOT registered');
    return;
  }

  const tool = {
    name: 'tiler_route',
    description:
      'Show or set the auto-tiling switch for THIS plugin (independent of the vision helper). '
      + 'auto (default): tile chat images only for session models that cannot see images themselves. '
      + 'off: never tile. always: tile every oversized image, even for vision-capable models - useful '
      + 'when small text must stay readable because the provider would downscale the original.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          oneOf: [{ type: 'string', enum: ['auto', 'off', 'always'] }, { type: 'null' }],
          description:
            'New switch value. auto: tile only for text-only models. off: never tile. always: always tile. '
            + 'Omit to just read the current value.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          configFile: { type: 'string', required: true },
          sessionModel: { type: 'string', required: true },
          nativeVision: { type: 'string', required: true },
          tilingActive: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Auto-tiling switch (this plugin only): ' + value.mode
          + '\nConfig: ' + value.configFile
          + '\nSession model: ' + value.sessionModel + ' (native image input: ' + value.nativeVision + ')'
          + '\nEffect now: ' + value.tilingActive
          + '\n(This is separate from the vision helper\'s vision_route switch.)',
      }],
    },
    async execute(args, exec) {
      if (args && typeof args.mode === 'string' && TILE_MODES.includes(args.mode)) {
        writeTilerConfig(args.mode);
        console.error('dsh-v4flash-tiler: switch set to "' + args.mode + '" via tiler_route');
      } else if (args && args.mode !== undefined && args.mode !== null) {
        throw new Error('mode must be one of: auto | off | always');
      }

      const mode = readTilerConfig().mode;
      const native = await sessionModelAcceptsImages(ctx, exec && exec.agent);
      let tilingActive;
      if (mode === 'off') tilingActive = 'no - tiling disabled';
      else if (mode === 'always') tilingActive = 'yes - every oversized image is tiled';
      else if (native === true) tilingActive = 'no - model has native vision (auto skips)';
      else if (native === false) tilingActive = 'yes - model is text-only';
      else tilingActive = 'unknown - model modality unresolved';

      return {
        mode,
        configFile: tilerConfigFile(),
        sessionModel: (exec && exec.agent && exec.agent.session && typeof exec.agent.session.requestHeader === 'function'
          ? (() => { try { const h = exec.agent.session.requestHeader(); return h && h.config ? String(h.config.provider) + '/' + String(h.config.model) : '(unknown)'; } catch { return '(unknown)'; } })()
          : '(unknown)'),
        nativeVision: native === true ? 'yes' : native === false ? 'no' : 'unknown',
        tilingActive,
      };
    },
  };

  ctx.effect(() => {
    try {
      tools.register(tool);
      console.error('dsh-v4flash-tiler: tiler_route registered');
    } catch (err) {
      console.error('dsh-v4flash-tiler: tiler_route registration failed (' + String(err && err.message || err) + ')');
    }
  }, 'dsh-v4flash-tiler: tiler_route');
}

export function apply(ctx) {
  console.error('dsh-v4flash-tiler: host half active (auto-tiler ready)');
  // Auto-tiling: one root-ctx listener, exactly like @deepseek-ai/dsh-compaction.
  // Scope-filtered dispatch delivers every agent's pre-step to root listeners.
  ctx.effect(() => ctx.on('agent/pre-step', preStepListener(ctx)), 'dsh-v4flash-tiler: auto tiler');

  // Own switch, independent of dsh-vision-helper's vision_route.
  registerTilerRouteTool(ctx);

  // DISABLED 2026-09-21 (user request): only auto-tiling is wanted from this
  // plugin. The `chat_send_image` tool was removed so the tiler no longer
  // registers any tool; dsh-v4flash-publisher was uninstalled at the same
  // time. The non-user image sanitizer inside preStepListener() is INDEPENDENT
  // of this tool and stays active — it is the safety net that keeps an image
  // block from ever reaching the DeepSeek adapter inside a non-user message.
  // Re-enable by calling registerChatSendImageTool(ctx) here again.
  // registerChatSendImageTool(ctx);

  // DISABLED 2026-09-03: this listener Invoke-Item'd EVERY image path that
  // appeared in ANY tool result (pwsh output, analysis prose, ... — pwsh is
  // not in OPEN_IMAGE_SKIP_TOOLS and result text is regex-scanned), so the
  // user accumulated a pile of Photos windows (restored by Windows after
  // reboot). Re-enable only with a strict allowlist of image-GENERATION tools
  // and image-block-only sources.
}
