import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";
import type { LlmCall } from "../../shared/api";

const HIGHLIGHT_DURATION_MS = 10_000;

// Only data consumed by table cells and their tooltips belongs in this snapshot.
function visibleSignature(call: LlmCall): string
{
  return JSON.stringify([call.status, call.display_name, call.created_at_ms, call.model_id, call.call_kind, call.cost_status, call.total_cost, call.input_cost, call.output_cost, call.cache_read_cost, call.cache_write_cost, call.cost_backfilled, call.reasoning_effort, call.performance.tokens_per_second, call.performance.speed_status, call.performance.reason, call.performance.first_output_ms, call.performance.generation_ms, call.fast, call.route, call.finish_reason, call.http_status, call.input_tokens, call.output_tokens, call.total_tokens, call.cache_read_tokens, call.cache_write_tokens, call.reasoning_tokens, call.message_count, call.tool_count, call.detailed, call.error_kind, call.error_message, call.call_id, call.run_id, call.conversation_id, call.provider_call_index]);
}

type HighlightRow =
{
  node: HTMLTableRowElement | null;
  ref: RefCallback<HTMLTableRowElement>;
  highlightedAt: number | null;
  animatedAt: number | null;
  animation: Animation | null;
};

function cancelAnimation(row: HighlightRow)
{
  row.animation?.cancel();
  row.animation = null;
  row.animatedAt = null;
}

function animateRow(row: HighlightRow, now: number, reducedMotion: boolean)
{
  if (row.highlightedAt === null)
  {
    return;
  }
  const elapsed = Math.max(0, now - row.highlightedAt);
  if (elapsed >= HIGHLIGHT_DURATION_MS)
  {
    cancelAnimation(row);
    row.highlightedAt = null;
    return;
  }
  if (!row.node || row.animatedAt === row.highlightedAt)
  {
    return;
  }

  cancelAnimation(row);
  // One inherited strength animates every cell, including sticky cells, together.
  row.animation = row.node.animate([{ "--call-update-strength": 1 }, { "--call-update-strength": reducedMotion ? 1 : 0 }], { duration: HIGHLIGHT_DURATION_MS, easing: "linear" });
  row.animation.currentTime = elapsed;
  row.animatedAt = row.highlightedAt;
}

export function useCallHighlights(calls: LlmCall[], queryKey: string, ready: boolean): (call: LlmCall) => RefCallback<HTMLTableRowElement>
{
  const rows = useRef(new Map<string, HighlightRow>());
  const snapshot = useRef<{ queryKey: string; signatures: Map<string, string> | null }>({ queryKey, signatures: null });

  const rowRef = useCallback((call: LlmCall): RefCallback<HTMLTableRowElement> =>
  {
    let row = rows.current.get(call.call_id);
    if (!row)
    {
      const entry: HighlightRow =
      {
        node: null,
        highlightedAt: null,
        animatedAt: null,
        animation: null,
        ref: (node) =>
        {
          cancelAnimation(entry);
          entry.node = node;
          if (node)
          {
            animateRow(entry, Date.now(), window.matchMedia("(prefers-reduced-motion: reduce)").matches);
          }
          return () =>
          {
            cancelAnimation(entry);
            entry.node = null;
          };
        },
      };
      rows.current.set(call.call_id, entry);
      row = entry;
    }
    return row.ref;
  }, []);

  // Run after every commit so reattached rows resume at their remaining time.
  useLayoutEffect(() =>
  {
    const now = Date.now();
    if (snapshot.current.queryKey !== queryKey)
    {
      snapshot.current = { queryKey, signatures: null };
      for (const row of rows.current.values())
      {
        cancelAnimation(row);
        row.highlightedAt = null;
      }
    }

    if (ready)
    {
      const previous = snapshot.current.signatures;
      const signatures = new Map(calls.map((call) => [call.call_id, visibleSignature(call)]));
      for (const [id, row] of rows.current)
      {
        if (!signatures.has(id))
        {
          cancelAnimation(row);
          rows.current.delete(id);
          continue;
        }
        if (previous && previous.get(id) !== signatures.get(id))
        {
          row.highlightedAt = now;
        }
      }
      snapshot.current.signatures = signatures;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const row of rows.current.values())
    {
      animateRow(row, now, reducedMotion);
    }
  });

  useLayoutEffect(() =>
  {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () =>
    {
      const now = Date.now();
      for (const row of rows.current.values())
      {
        cancelAnimation(row);
        animateRow(row, now, media.matches);
      }
    };
    media.addEventListener("change", updateMotion);
    const trackedRows = rows.current;
    return () =>
    {
      media.removeEventListener("change", updateMotion);
      for (const row of trackedRows.values())
      {
        cancelAnimation(row);
      }
    };
  }, []);

  return rowRef;
}
