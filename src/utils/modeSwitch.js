// "What changes" preview of switching plan mode (My plan screen). Pure: wraps rolling.previewModeSwitch and turns its two
// scenarios (calendar / rolling) into plain sentences. The mode names are the stored ones: 'calendar' = fixed weeks, 'rolling' = flexible.
import { previewModeSwitch } from '../rolling.js';

const weekText = n => (n ? `Week ${n}` : 'none');
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

// preview = previewModeSwitch(...) result, from/to = 'calendar' | 'rolling'. -> [sentence]
export function previewLines(preview, from, to) {
  if (!preview || !preview[from] || !preview[to] || from === to) return [];
  const now = preview[from], then = preview[to];
  const lines = [];
  lines.push(now.currentWeek === then.currentWeek
    ? `Current week: stays ${weekText(then.currentWeek)}.`
    : `Current week: ${weekText(now.currentWeek)} now, ${weekText(then.currentWeek)} after the switch.`);
  lines.push(now.fulfilledWeeks === then.fulfilledWeeks
    ? `Fulfilled weeks: stays at ${now.fulfilledWeeks}.`
    : `Fulfilled weeks: ${now.fulfilledWeeks} now, ${then.fulfilledWeeks} after the switch.`);
  const missed = preview.calendar.behind;
  if (to === 'rolling' && missed > 0) lines.push(`${plural(missed, 'week')} that count as missed today stop being missed.`);
  if (to === 'calendar' && missed > 0) lines.push(`${plural(missed, 'past week')} would count as missed.`);
  if (to === 'rolling') {
    const s = preview.rolling.nextSession;
    lines.push(s ? `Next session: ${s.type}, Week ${s.week}${s.repeat ? ' (repeat)' : ''}.` : 'Next session: nothing open, the plan is complete.');
  }
  return lines;
}

// -> { lines: [] } (empty: the UI shows its generic explanation) ; never throws.
export function modeSwitchPreview({ person, to, log, goals, planState, todayISO }) {
  try {
    const from = to === 'rolling' ? 'calendar' : 'rolling';
    const preview = previewModeSwitch({ goals, log, state: planState, todayISO, person });
    return { lines: previewLines(preview, from, to) };
  } catch (e) {
    console.warn('Mode switch preview failed:', e);
    return { lines: [] };
  }
}
