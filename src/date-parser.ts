// ── Date Parsing ──────────────────────────────────────────────────────────

const RELATIVE_RE = /^\+(\d+)([mhdw])$/i;

export function parseDate(s: string): Date {
  s = s.trim();

  // 1. Relative shortcuts: +Nh, +Nm, +Nd, +Nw
  const m = RELATIVE_RE.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const now = new Date();
    if (unit === 'm') {
      now.setMinutes(now.getMinutes() + n);
    } else if (unit === 'h') {
      now.setHours(now.getHours() + n);
    } else if (unit === 'd') {
      now.setDate(now.getDate() + n);
    } else if (unit === 'w') {
      now.setDate(now.getDate() + n * 7);
    }
    return now;
  }

  // 2. Named shortcuts
  const sl = s.toLowerCase();
  if (sl === 'today') {
    const now = new Date();
    now.setHours(23, 59, 0, 0);
    return now;
  }
  if (sl === 'tomorrow') {
    const now = new Date();
    now.setDate(now.getDate() + 1);
    now.setHours(9, 0, 0, 0);
    return now;
  }

  // 3. ISO 8601 formats
  const formats = [
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2})$/,
  ];

  for (const fmt of formats) {
    const match = fmt.exec(s);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const day = parseInt(match[3], 10);
      const hour = match[4] ? parseInt(match[4], 10) : 0;
      const minute = match[5] ? parseInt(match[5], 10) : 0;
      const second = match[6] ? parseInt(match[6], 10) : 0;
      const dt = new Date(year, month, day, hour, minute, second);
      if (!isNaN(dt.getTime())) {
        return dt;
      }
    }
  }

  throw new Error(`Cannot parse date: '${s}'`);
}

export function dtToIso(dt: Date): string {
  const y = dt.getFullYear();
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  const h = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  const se = String(dt.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
}

export function fmtDt(s: string | null): string {
  if (!s) return '';
  try {
    const dt = new Date(s);
    if (isNaN(dt.getTime())) return s;
    const now = new Date();
    const diffMs = now.getTime() - dt.getTime();
    if (diffMs < 0) {
      // Future
      const absDiff = -diffMs;
      const seconds = absDiff / 1000;
      if (seconds < 60) return 'in <1m';
      if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
      if (seconds < 86400) return `in ${Math.round(seconds / 3600)}h`;
      return `in ${Math.floor(absDiff / (1000 * 86400))}d`;
    } else {
      // Past
      const seconds = diffMs / 1000;
      if (seconds < 60) return '<1m ago';
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
      if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
      return `${Math.floor(diffMs / (1000 * 86400))}d ago`;
    }
  } catch {
    return s;
  }
}

export function truncate(s: string | null, maxLen: number): string {
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '\u2026';
}

export function parseRecur(ruleStr: string): { interval: number; unit: string } {
  const m = /^(\d+)([dwm])$/.exec(ruleStr.toLowerCase());
  if (!m) {
    throw new Error(
      `Invalid recurrence pattern: '${ruleStr}'. Use format like 1d, 2w, 1m`,
    );
  }
  return { interval: parseInt(m[1], 10), unit: m[2] };
}

export function nextRecurrence(
  triggerAt: string | null,
  rule: { interval: number; unit: string },
): Date {
  const base = triggerAt ? new Date(triggerAt) : new Date();
  const interval = rule.interval || 1;
  const unit = rule.unit || 'd';
  if (unit === 'd') {
    base.setDate(base.getDate() + interval);
  } else if (unit === 'w') {
    base.setDate(base.getDate() + interval * 7);
  } else if (unit === 'm') {
    base.setDate(base.getDate() + interval * 30);
  } else {
    base.setDate(base.getDate() + interval);
  }
  return base;
}
