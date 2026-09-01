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

/** Tile one attachment via the Python driver. Returns {ok:true, layout} or {ok:false, error}. */
async function tileAttachment(ctx, ref, signal, agent) {
  const shell = ctx.get('shell');
  const attachments = ctx.get('attachments');
  if (shell === undefined) return { ok: false, error: 'shell service unavailable' };
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
    const policy = resolveSandboxPolicy(ctx, agent);
    if (policy !== undefined) request.sandboxPolicy = policy;
    const spec = shell.resolve(request);
    result = await shell.run(spec);
  } catch (error) {
    console.error('dsh-v4flash-tiler: tile driver run failed', error);
    return { ok: false, error: 'shell.run: ' + (error && error.message ? error.message : String(error)) };
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

/** Replace oversized images in one message list. Returns the original array when nothing changed. */
async function maybeTileMessages(ctx, messages, signal, agent) {
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

/** Build the pre-step listener (root-ctx registration, like dsh-compaction). */
function preStepListener(ctx) {
  return async (payload, next) => {
    // Let other pre-step listeners decide first, then transform the final messages.
    const decision = await next();
    if (decision === null || typeof decision !== 'object') return decision;
    if (decision.kind !== 'enter') return decision;
    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    const replaced = await maybeTileMessages(ctx, messages, payload && payload.signal, payload && payload.agent);
    if (replaced === messages) return decision;
    console.error('dsh-v4flash-tiler: pre-step replaced images with tiles');
    return { kind: 'enter', messages: replaced, startsRequestSeries: decision.startsRequestSeries };
  };
}

export function apply(ctx) {
  console.error('dsh-v4flash-tiler: host half active (auto-tiler ready)');
  // Auto-tiling: one root-ctx listener, exactly like @deepseek-ai/dsh-compaction.
  // Scope-filtered dispatch delivers every agent's pre-step to root listeners.
  ctx.effect(() => ctx.on('agent/pre-step', preStepListener(ctx)), 'dsh-v4flash-tiler: auto tiler');
}
