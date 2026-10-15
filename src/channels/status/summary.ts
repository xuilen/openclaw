/** Normalize already-projected lifecycle facts without loading account or plugin runtime state. */
export function buildBaseChannelStatusSummary<TExtra extends object>(
  snapshot: {
    configured?: boolean | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    // Shipped passive-summary callers may include probe facts without projecting them.
    probe?: unknown;
    lastProbeAt?: number | null;
  },
  extra?: TExtra,
) {
  return {
    configured: snapshot.configured ?? false,
    // SAFETY: Preserve the shipped generic return contract; an absent extra contributes no fields.
    ...(extra ?? ({} as TExtra)),
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

/** Add probe facts after extras so the snapshot remains their authoritative source. */
export function buildProbeChannelStatusSummary<TExtra extends object>(
  snapshot: Parameters<typeof buildBaseChannelStatusSummary>[0],
  extra?: TExtra,
) {
  return {
    ...buildBaseChannelStatusSummary(snapshot, extra),
    probe: snapshot.probe,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  };
}
