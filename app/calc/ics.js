// Minimal iCalendar export for experiment events (timepoints, batch days, buffer prep).
export function toICS(events, calName = 'LNP Lab') {
  const fmt = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LNP Lab//EN', `X-WR-CALNAME:${calName}`];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@lnp-lab`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(e.start)}`,
      `DTEND:${fmt(e.end ?? new Date(new Date(e.start).getTime() + 3600e3))}`, `SUMMARY:${e.title}`,
      `DESCRIPTION:${(e.description ?? '').replace(/\n/g, '\\n')}`);
    if (e.reminderMinutes) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:-PT${e.reminderMinutes}M`, `DESCRIPTION:${e.title}`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
