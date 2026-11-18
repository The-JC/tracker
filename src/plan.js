// The 30-week half-marathon plan, extracted from the original hand-built index.html.
// Pure data + lookups: no DOM, no Firebase. Safe to import from node tests.
//
// Run ids keep the legacy format `1-<week>-<index>-<a|b>` (index is 0-based) because
// they are the keys of the Firebase `checks` and `goals` maps.
// `km` is the default goal (null = no distance, e.g. an optional shakeout).

export const TOTAL_WEEKS = 30;

// Run types, in the order they are explained to the user.
// `mult` multiplies km into points. `why`/`how` are the descriptive cards.
export const RUN_TYPES = [
  { key: 'easy', name: 'Easy', mult: 1, why: 'Aerobic base + recovery', how: 'Relaxed, conversational running that builds your aerobic base and supports recovery.' },
  { key: 'long', name: 'Long run', mult: 1.3, why: 'Endurance + race-day toughness', how: 'Your longest run of the week, building endurance and race-day resilience.' },
  { key: 'tempo', name: 'Tempo', mult: 1.6, why: 'Raises your threshold', how: 'A sustained, comfortably hard effort that raises your threshold.' },
  { key: 'speed', name: 'Speed', mult: 1.8, why: 'Top-end speed + efficiency', how: 'Short, fast repeats with easy recovery to improve speed and efficiency.' },
  { key: 'shakeout', name: 'Shakeout', mult: 1, why: 'Keeps legs loose, adds nothing', how: 'A short, easy jog to keep your legs loose without adding fatigue.' },
  { key: 'race', name: 'Race day', mult: 3, why: "The one it's all for", how: 'Run with your practiced pace, fuelling, and hydration. Enjoy race day.' }
];

export const RUN_TYPE_BY_KEY = Object.fromEntries(RUN_TYPES.map(t => [t.key, t]));
// 'Long run' -> 'long' (also accepts the old upper-case 'RACE DAY').
export const RUN_TYPE_KEY_BY_NAME = Object.fromEntries(
  RUN_TYPES.flatMap(t => [[t.name, t.key], [t.name.toUpperCase(), t.key]])
);

// Sports. points = amount / per * rate, where amount is km (requires 'km') or minutes.
// Runs have no flat rate: points = km * run-type multiplier.
export const SPORTS = [
  { key: 'run', label: 'Run', emoji: '🏃', requires: 'km', rate: null, per: 1, unit: 'km' },
  { key: 'hike', label: 'Hike', emoji: '🥾', requires: 'km', rate: 0.5, per: 1, unit: 'km' },
  { key: 'cycle', label: 'Cycle', emoji: '🚴', requires: 'durationMin', rate: 0.4, per: 30, unit: 'min' },
  { key: 'swim', label: 'Swim', emoji: '🏊', requires: 'durationMin', rate: 0.6, per: 30, unit: 'min' },
  { key: 'strength', label: 'Strength', emoji: '🏋️', requires: 'durationMin', rate: 0.5, per: 30, unit: 'min' },
  { key: 'workout', label: 'Workout', emoji: '🔥', requires: 'durationMin', rate: 0.6, per: 30, unit: 'min' }
];
export const SPORT_BY_KEY = Object.fromEntries(SPORTS.map(s => [s.key, s]));

// Legacy `activities` names -> sport keys.
export const LEGACY_SPORT_MAP = { hiking: 'hike', cycling: 'cycle', swimming: 'swim', strength: 'strength', workout: 'workout' };

// n: week number, kind: '' | 'cutback' | 'peak' | 'race-week', tag: label shown on the tile ('' if none).
export const PLAN = [
  { n: 1, kind: '', tag: '', runs: {
    a: [
      { id: '1-1-0-a', type: 'Easy', runType: 'easy', detail: '', km: 5, mult: 1 },
      { id: '1-1-1-a', type: 'Tempo', runType: 'tempo', detail: '4×2 min pickups', km: 5, mult: 1.6 },
      { id: '1-1-2-a', type: 'Long run', runType: 'long', detail: '', km: 6.5, mult: 1.3 }
    ],
    b: [
      { id: '1-1-0-b', type: 'Easy', runType: 'easy', detail: '', km: 5, mult: 1 },
      { id: '1-1-1-b', type: 'Tempo', runType: 'tempo', detail: '4×2 min pickups', km: 5, mult: 1.6 },
      { id: '1-1-2-b', type: 'Long run', runType: 'long', detail: '', km: 6.5, mult: 1.3 }
    ]
  } },
  { n: 2, kind: '', tag: '', runs: {
    a: [
      { id: '1-2-0-a', type: 'Easy', runType: 'easy', detail: '', km: 5, mult: 1 },
      { id: '1-2-1-a', type: 'Tempo', runType: 'tempo', detail: '4×2 min pickups', km: 5, mult: 1.6 },
      { id: '1-2-2-a', type: 'Long run', runType: 'long', detail: '', km: 6.5, mult: 1.3 }
    ],
    b: [
      { id: '1-2-0-b', type: 'Easy', runType: 'easy', detail: '', km: 5, mult: 1 },
      { id: '1-2-1-b', type: 'Tempo', runType: 'tempo', detail: '4×2 min pickups', km: 5, mult: 1.6 },
      { id: '1-2-2-b', type: 'Long run', runType: 'long', detail: '', km: 6.5, mult: 1.3 }
    ]
  } },
  { n: 3, kind: '', tag: '', runs: {
    a: [
      { id: '1-3-0-a', type: 'Easy', runType: 'easy', detail: '', km: 5.5, mult: 1 },
      { id: '1-3-1-a', type: 'Tempo', runType: 'tempo', detail: '5×2 min pickups', km: 5.5, mult: 1.6 },
      { id: '1-3-2-a', type: 'Long run', runType: 'long', detail: '', km: 8, mult: 1.3 }
    ],
    b: [
      { id: '1-3-0-b', type: 'Easy', runType: 'easy', detail: '', km: 5.5, mult: 1 },
      { id: '1-3-1-b', type: 'Tempo', runType: 'tempo', detail: '5×2 min pickups', km: 5.5, mult: 1.6 },
      { id: '1-3-2-b', type: 'Long run', runType: 'long', detail: '', km: 8, mult: 1.3 }
    ]
  } },
  { n: 4, kind: '', tag: '', runs: {
    a: [
      { id: '1-4-0-a', type: 'Easy', runType: 'easy', detail: '', km: 5.5, mult: 1 },
      { id: '1-4-1-a', type: 'Tempo', runType: 'tempo', detail: '5×2 min pickups', km: 5.5, mult: 1.6 },
      { id: '1-4-2-a', type: 'Long run', runType: 'long', detail: '', km: 8, mult: 1.3 }
    ],
    b: [
      { id: '1-4-0-b', type: 'Easy', runType: 'easy', detail: '', km: 5.5, mult: 1 },
      { id: '1-4-1-b', type: 'Tempo', runType: 'tempo', detail: '5×2 min pickups', km: 5.5, mult: 1.6 },
      { id: '1-4-2-b', type: 'Long run', runType: 'long', detail: '', km: 8, mult: 1.3 }
    ]
  } },
  { n: 5, kind: '', tag: '', runs: {
    a: [
      { id: '1-5-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-5-1-a', type: 'Tempo', runType: 'tempo', detail: '15 min @ tempo pace', km: 6.5, mult: 1.6 },
      { id: '1-5-2-a', type: 'Long run', runType: 'long', detail: '', km: 9, mult: 1.3 }
    ],
    b: [
      { id: '1-5-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-5-1-b', type: 'Tempo', runType: 'tempo', detail: '15 min @ tempo pace', km: 6.5, mult: 1.6 },
      { id: '1-5-2-b', type: 'Long run', runType: 'long', detail: '', km: 9, mult: 1.3 }
    ]
  } },
  { n: 6, kind: '', tag: '', runs: {
    a: [
      { id: '1-6-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-6-1-a', type: 'Tempo', runType: 'tempo', detail: '15 min @ tempo pace', km: 6.5, mult: 1.6 },
      { id: '1-6-2-a', type: 'Long run', runType: 'long', detail: '', km: 9, mult: 1.3 }
    ],
    b: [
      { id: '1-6-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-6-1-b', type: 'Tempo', runType: 'tempo', detail: '15 min @ tempo pace', km: 6.5, mult: 1.6 },
      { id: '1-6-2-b', type: 'Long run', runType: 'long', detail: '', km: 9, mult: 1.3 }
    ]
  } },
  { n: 7, kind: '', tag: '', runs: {
    a: [
      { id: '1-7-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-7-1-a', type: 'Tempo', runType: 'tempo', detail: '20 min tempo', km: 6.5, mult: 1.6 },
      { id: '1-7-2-a', type: 'Long run', runType: 'long', detail: '', km: 9.5, mult: 1.3 }
    ],
    b: [
      { id: '1-7-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-7-1-b', type: 'Tempo', runType: 'tempo', detail: '20 min tempo', km: 6.5, mult: 1.6 },
      { id: '1-7-2-b', type: 'Long run', runType: 'long', detail: '', km: 9.5, mult: 1.3 }
    ]
  } },
  { n: 8, kind: '', tag: '', runs: {
    a: [
      { id: '1-8-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-8-1-a', type: 'Tempo', runType: 'tempo', detail: '20 min tempo', km: 6.5, mult: 1.6 },
      { id: '1-8-2-a', type: 'Long run', runType: 'long', detail: '', km: 9.5, mult: 1.3 }
    ],
    b: [
      { id: '1-8-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-8-1-b', type: 'Tempo', runType: 'tempo', detail: '20 min tempo', km: 6.5, mult: 1.6 },
      { id: '1-8-2-b', type: 'Long run', runType: 'long', detail: '', km: 9.5, mult: 1.3 }
    ]
  } },
  { n: 9, kind: '', tag: '', runs: {
    a: [
      { id: '1-9-0-a', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-9-1-a', type: 'Tempo', runType: 'tempo', detail: '20 min tempo', km: 7, mult: 1.6 },
      { id: '1-9-2-a', type: 'Long run', runType: 'long', detail: '', km: 10.5, mult: 1.3 }
    ],
    b: [
      { id: '1-9-0-b', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-9-1-b', type: 'Tempo', runType: 'tempo', detail: '20 min tempo', km: 7, mult: 1.6 },
      { id: '1-9-2-b', type: 'Long run', runType: 'long', detail: '', km: 10.5, mult: 1.3 }
    ]
  } },
  { n: 10, kind: '', tag: '', runs: {
    a: [
      { id: '1-10-0-a', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-10-1-a', type: 'Tempo', runType: 'tempo', detail: '20 min tempo', km: 7, mult: 1.6 },
      { id: '1-10-2-a', type: 'Long run', runType: 'long', detail: '', km: 10.5, mult: 1.3 }
    ],
    b: [
      { id: '1-10-0-b', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-10-1-b', type: 'Tempo', runType: 'tempo', detail: '20 min tempo', km: 7, mult: 1.6 },
      { id: '1-10-2-b', type: 'Long run', runType: 'long', detail: '', km: 10.5, mult: 1.3 }
    ]
  } },
  { n: 11, kind: '', tag: '', runs: {
    a: [
      { id: '1-11-0-a', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-11-1-a', type: 'Tempo', runType: 'tempo', detail: '25 min tempo', km: 7, mult: 1.6 },
      { id: '1-11-2-a', type: 'Long run', runType: 'long', detail: '', km: 11.5, mult: 1.3 }
    ],
    b: [
      { id: '1-11-0-b', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-11-1-b', type: 'Tempo', runType: 'tempo', detail: '25 min tempo', km: 7, mult: 1.6 },
      { id: '1-11-2-b', type: 'Long run', runType: 'long', detail: '', km: 11.5, mult: 1.3 }
    ]
  } },
  { n: 12, kind: '', tag: '', runs: {
    a: [
      { id: '1-12-0-a', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-12-1-a', type: 'Tempo', runType: 'tempo', detail: '25 min tempo', km: 7, mult: 1.6 },
      { id: '1-12-2-a', type: 'Long run', runType: 'long', detail: '', km: 11.5, mult: 1.3 }
    ],
    b: [
      { id: '1-12-0-b', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-12-1-b', type: 'Tempo', runType: 'tempo', detail: '25 min tempo', km: 7, mult: 1.6 },
      { id: '1-12-2-b', type: 'Long run', runType: 'long', detail: '', km: 11.5, mult: 1.3 }
    ]
  } },
  { n: 13, kind: '', tag: '', runs: {
    a: [
      { id: '1-13-0-a', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-13-1-a', type: 'Tempo', runType: 'tempo', detail: '25 min tempo', km: 8, mult: 1.6 },
      { id: '1-13-2-a', type: 'Long run', runType: 'long', detail: '', km: 12, mult: 1.3 }
    ],
    b: [
      { id: '1-13-0-b', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-13-1-b', type: 'Tempo', runType: 'tempo', detail: '25 min tempo', km: 8, mult: 1.6 },
      { id: '1-13-2-b', type: 'Long run', runType: 'long', detail: '', km: 12, mult: 1.3 }
    ]
  } },
  { n: 14, kind: '', tag: '', runs: {
    a: [
      { id: '1-14-0-a', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-14-1-a', type: 'Tempo', runType: 'tempo', detail: '25 min tempo', km: 8, mult: 1.6 },
      { id: '1-14-2-a', type: 'Long run', runType: 'long', detail: '', km: 12, mult: 1.3 }
    ],
    b: [
      { id: '1-14-0-b', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-14-1-b', type: 'Tempo', runType: 'tempo', detail: '25 min tempo', km: 8, mult: 1.6 },
      { id: '1-14-2-b', type: 'Long run', runType: 'long', detail: '', km: 12, mult: 1.3 }
    ]
  } },
  { n: 15, kind: '', tag: '', runs: {
    a: [
      { id: '1-15-0-a', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-15-1-a', type: 'Tempo', runType: 'tempo', detail: '30 min tempo', km: 8, mult: 1.6 },
      { id: '1-15-2-a', type: 'Long run', runType: 'long', detail: '', km: 13, mult: 1.3 }
    ],
    b: [
      { id: '1-15-0-b', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-15-1-b', type: 'Tempo', runType: 'tempo', detail: '30 min tempo', km: 8, mult: 1.6 },
      { id: '1-15-2-b', type: 'Long run', runType: 'long', detail: '', km: 13, mult: 1.3 }
    ]
  } },
  { n: 16, kind: 'cutback', tag: 'Cutback', runs: {
    a: [
      { id: '1-16-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-16-1-a', type: 'Tempo', runType: 'tempo', detail: 'Easy w/ strides', km: 6.5, mult: 1.6 },
      { id: '1-16-2-a', type: 'Long run', runType: 'long', detail: '', km: 9.5, mult: 1.3 }
    ],
    b: [
      { id: '1-16-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-16-1-b', type: 'Tempo', runType: 'tempo', detail: 'Easy w/ strides', km: 6.5, mult: 1.6 },
      { id: '1-16-2-b', type: 'Long run', runType: 'long', detail: '', km: 9.5, mult: 1.3 }
    ]
  } },
  { n: 17, kind: '', tag: '', runs: {
    a: [
      { id: '1-17-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-17-1-a', type: 'Tempo', runType: 'tempo', detail: '30 min tempo', km: 6.5, mult: 1.6 },
      { id: '1-17-2-a', type: 'Long run', runType: 'long', detail: '', km: 14, mult: 1.3 }
    ],
    b: [
      { id: '1-17-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-17-1-b', type: 'Tempo', runType: 'tempo', detail: '30 min tempo', km: 6.5, mult: 1.6 },
      { id: '1-17-2-b', type: 'Long run', runType: 'long', detail: '', km: 14, mult: 1.3 }
    ]
  } },
  { n: 18, kind: '', tag: '', runs: {
    a: [
      { id: '1-18-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-18-1-a', type: 'Speed', runType: 'speed', detail: '6×3 min @ 5k pace', km: 8, mult: 1.8 },
      { id: '1-18-2-a', type: 'Long run', runType: 'long', detail: '', km: 14.5, mult: 1.3 }
    ],
    b: [
      { id: '1-18-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-18-1-b', type: 'Speed', runType: 'speed', detail: '6×3 min @ 5k pace', km: 8, mult: 1.8 },
      { id: '1-18-2-b', type: 'Long run', runType: 'long', detail: '', km: 14.5, mult: 1.3 }
    ]
  } },
  { n: 19, kind: '', tag: '', runs: {
    a: [
      { id: '1-19-0-a', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-19-1-a', type: 'Tempo', runType: 'tempo', detail: '30 min tempo', km: 8, mult: 1.6 },
      { id: '1-19-2-a', type: 'Long run', runType: 'long', detail: '', km: 15, mult: 1.3 }
    ],
    b: [
      { id: '1-19-0-b', type: 'Easy', runType: 'easy', detail: '', km: 7, mult: 1 },
      { id: '1-19-1-b', type: 'Tempo', runType: 'tempo', detail: '30 min tempo', km: 8, mult: 1.6 },
      { id: '1-19-2-b', type: 'Long run', runType: 'long', detail: '', km: 15, mult: 1.3 }
    ]
  } },
  { n: 20, kind: 'cutback', tag: 'Cutback', runs: {
    a: [
      { id: '1-20-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-20-1-a', type: 'Tempo', runType: 'tempo', detail: 'Easy (cutback)', km: 6.5, mult: 1.6 },
      { id: '1-20-2-a', type: 'Long run', runType: 'long', detail: '', km: 11.5, mult: 1.3 }
    ],
    b: [
      { id: '1-20-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-20-1-b', type: 'Tempo', runType: 'tempo', detail: 'Easy (cutback)', km: 6.5, mult: 1.6 },
      { id: '1-20-2-b', type: 'Long run', runType: 'long', detail: '', km: 11.5, mult: 1.3 }
    ]
  } },
  { n: 21, kind: '', tag: '', runs: {
    a: [
      { id: '1-21-0-a', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-21-1-a', type: 'Speed', runType: 'speed', detail: '8×3 min @ 5k pace', km: 8, mult: 1.8 },
      { id: '1-21-2-a', type: 'Long run', runType: 'long', detail: '', km: 16, mult: 1.3 }
    ],
    b: [
      { id: '1-21-0-b', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-21-1-b', type: 'Speed', runType: 'speed', detail: '8×3 min @ 5k pace', km: 8, mult: 1.8 },
      { id: '1-21-2-b', type: 'Long run', runType: 'long', detail: '', km: 16, mult: 1.3 }
    ]
  } },
  { n: 22, kind: '', tag: '', runs: {
    a: [
      { id: '1-22-0-a', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-22-1-a', type: 'Tempo', runType: 'tempo', detail: '35 min tempo', km: 9, mult: 1.6 },
      { id: '1-22-2-a', type: 'Long run', runType: 'long', detail: '', km: 17, mult: 1.3 }
    ],
    b: [
      { id: '1-22-0-b', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-22-1-b', type: 'Tempo', runType: 'tempo', detail: '35 min tempo', km: 9, mult: 1.6 },
      { id: '1-22-2-b', type: 'Long run', runType: 'long', detail: '', km: 17, mult: 1.3 }
    ]
  } },
  { n: 23, kind: 'cutback', tag: 'Cutback', runs: {
    a: [
      { id: '1-23-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-23-1-a', type: 'Tempo', runType: 'tempo', detail: 'Easy (cutback)', km: 6.5, mult: 1.6 },
      { id: '1-23-2-a', type: 'Long run', runType: 'long', detail: '', km: 13, mult: 1.3 }
    ],
    b: [
      { id: '1-23-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-23-1-b', type: 'Tempo', runType: 'tempo', detail: 'Easy (cutback)', km: 6.5, mult: 1.6 },
      { id: '1-23-2-b', type: 'Long run', runType: 'long', detail: '', km: 13, mult: 1.3 }
    ]
  } },
  { n: 24, kind: '', tag: '', runs: {
    a: [
      { id: '1-24-0-a', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-24-1-a', type: 'Tempo', runType: 'tempo', detail: '5 km @ race pace', km: 9.5, mult: 1.6 },
      { id: '1-24-2-a', type: 'Long run', runType: 'long', detail: '', km: 17.5, mult: 1.3 }
    ],
    b: [
      { id: '1-24-0-b', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-24-1-b', type: 'Tempo', runType: 'tempo', detail: '5 km @ race pace', km: 9.5, mult: 1.6 },
      { id: '1-24-2-b', type: 'Long run', runType: 'long', detail: '', km: 17.5, mult: 1.3 }
    ]
  } },
  { n: 25, kind: '', tag: '', runs: {
    a: [
      { id: '1-25-0-a', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-25-1-a', type: 'Tempo', runType: 'tempo', detail: '35–40 min tempo', km: 9, mult: 1.6 },
      { id: '1-25-2-a', type: 'Long run', runType: 'long', detail: '', km: 18.5, mult: 1.3 }
    ],
    b: [
      { id: '1-25-0-b', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-25-1-b', type: 'Tempo', runType: 'tempo', detail: '35–40 min tempo', km: 9, mult: 1.6 },
      { id: '1-25-2-b', type: 'Long run', runType: 'long', detail: '', km: 18.5, mult: 1.3 }
    ]
  } },
  { n: 26, kind: 'cutback', tag: 'Cutback', runs: {
    a: [
      { id: '1-26-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-26-1-a', type: 'Tempo', runType: 'tempo', detail: 'Easy (cutback)', km: 6.5, mult: 1.6 },
      { id: '1-26-2-a', type: 'Long run', runType: 'long', detail: '', km: 13, mult: 1.3 }
    ],
    b: [
      { id: '1-26-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-26-1-b', type: 'Tempo', runType: 'tempo', detail: 'Easy (cutback)', km: 6.5, mult: 1.6 },
      { id: '1-26-2-b', type: 'Long run', runType: 'long', detail: '', km: 13, mult: 1.3 }
    ]
  } },
  { n: 27, kind: 'peak', tag: 'Peak', runs: {
    a: [
      { id: '1-27-0-a', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-27-1-a', type: 'Tempo', runType: 'tempo', detail: '6.5 km @ race pace', km: 8, mult: 1.6 },
      { id: '1-27-2-a', type: 'Long run', runType: 'long', detail: 'Peak long run', km: 19, mult: 1.3 }
    ],
    b: [
      { id: '1-27-0-b', type: 'Easy', runType: 'easy', detail: '', km: 8, mult: 1 },
      { id: '1-27-1-b', type: 'Tempo', runType: 'tempo', detail: '6.5 km @ race pace', km: 8, mult: 1.6 },
      { id: '1-27-2-b', type: 'Long run', runType: 'long', detail: 'Peak long run', km: 19, mult: 1.3 }
    ]
  } },
  { n: 28, kind: '', tag: 'Taper', runs: {
    a: [
      { id: '1-28-0-a', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-28-1-a', type: 'Tempo', runType: 'tempo', detail: 'Easy w/ strides', km: 6.5, mult: 1.6 },
      { id: '1-28-2-a', type: 'Long run', runType: 'long', detail: '', km: 13, mult: 1.3 }
    ],
    b: [
      { id: '1-28-0-b', type: 'Easy', runType: 'easy', detail: '', km: 6.5, mult: 1 },
      { id: '1-28-1-b', type: 'Tempo', runType: 'tempo', detail: 'Easy w/ strides', km: 6.5, mult: 1.6 },
      { id: '1-28-2-b', type: 'Long run', runType: 'long', detail: '', km: 13, mult: 1.3 }
    ]
  } },
  { n: 29, kind: '', tag: 'Taper', runs: {
    a: [
      { id: '1-29-0-a', type: 'Easy', runType: 'easy', detail: '', km: 5, mult: 1 },
      { id: '1-29-1-a', type: 'Tempo', runType: 'tempo', detail: '4×1 min strides', km: 5, mult: 1.6 },
      { id: '1-29-2-a', type: 'Long run', runType: 'long', detail: '', km: 8, mult: 1.3 }
    ],
    b: [
      { id: '1-29-0-b', type: 'Easy', runType: 'easy', detail: '', km: 5, mult: 1 },
      { id: '1-29-1-b', type: 'Tempo', runType: 'tempo', detail: '4×1 min strides', km: 5, mult: 1.6 },
      { id: '1-29-2-b', type: 'Long run', runType: 'long', detail: '', km: 8, mult: 1.3 }
    ]
  } },
  { n: 30, kind: 'race-week', tag: 'Race week', runs: {
    a: [
      { id: '1-30-0-a', type: 'Easy', runType: 'easy', detail: '', km: 4, mult: 1 },
      { id: '1-30-1-a', type: 'Shakeout', runType: 'shakeout', detail: 'Rest or 20 min jog', km: null, mult: 1 },
      { id: '1-30-2-a', type: 'Race day', runType: 'race', detail: '21.1 km', km: 21.1, mult: 3 }
    ],
    b: [
      { id: '1-30-0-b', type: 'Easy', runType: 'easy', detail: '', km: 4, mult: 1 },
      { id: '1-30-1-b', type: 'Shakeout', runType: 'shakeout', detail: 'Rest or 20 min jog', km: null, mult: 1 },
      { id: '1-30-2-b', type: 'Race day', runType: 'race', detail: '21.1 km', km: 21.1, mult: 3 }
    ]
  } }
];

// runId -> { run, week, person }
export const PLAN_RUN_BY_ID = {};
for (const w of PLAN) {
  for (const person of ['a', 'b']) {
    for (const run of w.runs[person]) PLAN_RUN_BY_ID[run.id] = { run, week: w.n, person };
  }
}
