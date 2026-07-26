// How the table renders a timestamp, and where that choice comes from.
//
// Formatting used to read two module-level `let`s in index.ts, which made it
// both untestable and order-dependent (render before the preference load and
// every row silently used the default). Passing the preferences in makes the
// dependency explicit and the formatting pure.

import { storageGet } from '$platform';

type DateFormat = 'dmy' | 'mdy';
type TimeFormat = '12h' | '24h';
type ModelPreference = 'current' | 'original';

interface DateTimePrefs {
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

/** Anything not exactly the alternative is the default — storage is untrusted. */
const loadDateTimePrefs = async (): Promise<DateTimePrefs> => {
  const result = await storageGet<{ dateFormat?: string; timeFormat?: string }>(
    'local',
    ['dateFormat', 'timeFormat'],
  );
  return {
    dateFormat: result.dateFormat === 'dmy' ? 'dmy' : 'mdy',
    timeFormat: result.timeFormat === '24h' ? '24h' : '12h',
  };
};

const loadModelPreference = async (): Promise<ModelPreference> => {
  const result = await storageGet<{ modelDisplay?: string }>('local', [
    'modelDisplay',
  ]);
  return result.modelDisplay === 'current' ? 'current' : 'original';
};

const formatDate = (dt: Date, dateFormat: DateFormat): string => {
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  const y = dt.getFullYear();
  return dateFormat === 'dmy' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
};

const formatTime = (dt: Date, timeFormat: TimeFormat): string => {
  if (timeFormat === '24h') {
    return dt.toLocaleTimeString([], {
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
    });
  }
  return dt.toLocaleTimeString([], {
    hour: '2-digit',
    hour12: true,
    minute: '2-digit',
  });
};

export { formatDate, formatTime, loadDateTimePrefs, loadModelPreference };
export type { DateFormat, DateTimePrefs, ModelPreference, TimeFormat };
