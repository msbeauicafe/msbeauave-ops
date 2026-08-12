// What day it is, in the only timezone this business trades in.
//
// The shop is in Marikina. Its trading day starts and ends by the clock on the
// wall, and the engine already books sales against a Manila date — see the
// `at time zone 'Asia/Manila'` in takings_by_branch and close of day.
//
// The servers, though, run on UTC, and `new Date().toISOString()` gives the UTC
// date. Manila is eight hours ahead, so between midnight and eight in the
// morning those two disagree: it is already Tuesday in the shop while the
// server still says Monday. Every report that defaulted its date window to the
// UTC "today" therefore asked for yesterday, and a supervisor opening the till
// at seven would have been told the shop had taken nothing — while the sales
// were being recorded correctly the whole time, one day further on than the
// window being asked for.
//
// That is a bug that only appears before breakfast, which is exactly the kind
// that survives a long time. So there is one answer to "what day is it", here.
const MANILA = 'Asia/Manila';

// en-CA formats as YYYY-MM-DD, which is what every date input and every
// Postgres date cast in this codebase expects.
export const today = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: MANILA });

export const daysAgo = (n) =>
  new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: MANILA });
