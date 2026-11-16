# Fixtures

## prayer-times.json

Independent oracle for `App\Services\PrayerTimes`. It was generated with the MIT-licensed npm package
[`adhan`](https://www.npmjs.com/package/adhan) **4.4.6** (license checked with `npm view adhan license`) on 2026-11-16.
The package is not a dependency of this repository; it was installed in a scratch directory outside the repo and only the
resulting JSON is committed.

How: for each case a small Node script (process time zone pinned with `TZ=UTC`) built `adhan.CalculationMethod.<Method>()`,
set `madhab` (Shafi = standard, Hanafi), set `highLatitudeRule = TwilightAngle` (Fajr/Isha never further than angle/60 of the
night from sunrise/sunset, the rule PrayerTimes implements), left rounding at the default (nearest minute) and called
`new adhan.PrayerTimes(new Coordinates(lat, lng), new Date(Date.UTC(y, m - 1, d)), params)`. For Umm al-Qura days of Ramadan the
package's documented `adjustments.isha = 30` was applied. The six times of each case are stored as UTC instants.

Coverage (784 cases): Makkah, Riyadh, Cairo, Istanbul, Karachi, Jakarta, New York, Amsterdam, Rotterdam, Oslo, Sydney,
Johannesburg, Doha, Kuwait City; five seasonal dates each (mid January, equinox, midsummer, September equinox, midwinter); the eight
methods (umm_al_qura, muslim_world_league, egyptian, karachi, north_america, kuwait, qatar, turkey); standard and Hanafi Asr; the DST
changes of 2027 (Europe 03-28 and 10-31, US 03-14 and 11-07, Sydney 04-04 and 10-03) and their neighbours; extra high-latitude days in
May to July and December; and Ramadan 1448 dates in Makkah and Riyadh.

Tolerance in `tests/Unit/PrayerTimesTest.php` is +-2 minutes per prayer. Both sides round to the minute and use different
low-precision solar series, so differences of one minute are normal.
