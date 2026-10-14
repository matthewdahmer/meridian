# Protractor Data Changelog

Add new entries at the top, directly after this header block. Never delete old entries.
Each `## ` line starts a new entry. Fill in all fields when a new dataset is generated.
"Promoted to flight" is the date the chandra_models version went from pre-release to full release on
github.com/sot/chandra_models. GitHub's API does not expose that transition; use the <updated> timestamp for the
release in https://github.com/sot/chandra_models/releases.atom (it is the last edit to the release, normally the promotion).

---

## 3.76.0 (f513ee0)

**Promoted to flight:** 2026-08-17
**Models version:** 3.76.0
**Hash:** f513ee0

| Parameter | Available Values |
|---|---|
| Date | Jan 1 2026, Jul 1 2026, Oct 1 2026, Jan 1 2027, Apr 1 2027, Jul 1 2027, Oct 1 2027, Jan 1 2028, Jun 30 2028, Jan 1 2029, Jul 1 2029, Jan 1 2030, Jul 1 2030, Jan 1 2031, Jul 1 2031, Jan 1 2032, Jun 30 2032 |
| Chips | 1, 2, 3, 4, 5, 6 |
| HRC-S CEA (°C) | 9.0, 9.5 |
| HRC-I CEA (°C) | 9.0, 9.5 |
| Prop. Line #3 (°F) | 50 |
| Prop. Line #4 (°F) | 50 |
| ACIS DPA (°C) | 38.5 |
| ACIS DEA (°C) | 38.5 |
| ACIS FP (°C) | -111, -109, -108, -105; -86 (3 chips only) |
| OBA Fwd Bulkhead (°F) | 112, 115, 118. Jan 2026: 112 only; Jul/Oct 2026 and Apr/Oct 2027: 112, 115 |
| ACA CCD (°C) | -10.0 to -0.5 (0.5° steps), 0.0, 1.0, 2.0 (no -2.1). Jan 2026: -1.5 only. Jul/Oct 2026, Apr/Oct 2027: 1 chip -1.5, -1.0; 2-6 chips -10.0 to -0.5. Jan/Jul 2027, Jan 2028: 1 chip -1.5, -1.0, 0.0, 1.0, 2.0; 2-6 chips -10.0 to 2.0. Jun 2028 onward: -1.5, -1.0, 0.0, 1.0, 2.0 |
| IPS Tank (°F) | 130, 135, 140, 145. Jan/Jul/Oct 2026 and Apr/Oct 2027: 130 only |
| MUPS Thruster 1B (°F) | 227.5, 230, 235, 240, 245, 250. Jan 2026: 230. Jul/Oct 2026, Apr/Oct 2027: 227.5, 230. Jan 2027, Jan 2028: 227.5-250. Jul 2027: 227.5-240. Jan 2029-2032: 230-250. Jun/Jul 2028-2032: 230, 235, 240 |
| MUPS Thruster 2A (°F) | Same as Thruster 1B |
| ACIS PSMC (°C) | 52.5 |
| Fine Sun Sensor Elec. (°F) | 125 |
| Reaction Wheel #5 (°F) | 125 |

---

## 3.74.0 (7328a78)

**Promoted to flight:** 2026-05-07
**Models version:** 3.74.0
**Hash:** 7328a78

| Parameter | Available Values |
|---|---|
| Date | Jul 1 2026, Oct 1 2026, Jan 1 2027, Apr 1 2027 |
| Chips | 1, 2, 3, 4, 5, 6 |
| HRC-S CEA (°C) | 9.0, 9.5 |
| HRC-I CEA (°C) | 9.0, 9.5 |
| Prop. Line #3 (°F) | 50 |
| Prop. Line #4 (°F) | 50 |
| ACIS DPA (°C) | 38.5 |
| ACIS DEA (°C) | 38.5 |
| ACIS FP (°C) | -111, -109, -108, -105; -86 (3 chips only) |
| OBA Fwd Bulkhead (°F) | 112 |
| ACA CCD (°C) | -10.0 to 0.5 (0.5° steps), plus -2.1 |
| IPS Tank (°F) | 130 |
| MUPS Thruster 1B (°F) | 227.5 |
| MUPS Thruster 2A (°F) | 227.5 |
| ACIS PSMC (°C) | 52.5 |
| Fine Sun Sensor Elec. (°F) | 125 |
| Reaction Wheel #5 (°F) | 125 |

---

## 3.73.1 (b073e82)

**Promoted to flight:** 2026-02-13
**Models version:** 3.73.1
**Hash:** b073e82

| Parameter | Available Values |
|---|---|
| Date | Jan 1 2026, Apr 1 2026, Jul 1 2026, Oct 1 2026, Jan 1 2027 |
| Chips | 1, 2, 3, 4, 5, 6 |
| HRC-S CEA (°C) | 9.5 |
| HRC-I CEA (°C) | 9.5 |
| Prop. Line #3 (°F) | 50 |
| Prop. Line #4 (°F) | 50 |
| ACIS DPA (°C) | 38.5 |
| ACIS DEA (°C) | 38.5 |
| ACIS FP (°C) | -111, -109, -108, -105; -86 (3 chips only) |
| OBA Fwd Bulkhead (°F) | 112 |
| ACA CCD (°C) | -10.0 to 0.5 (0.5° steps), plus -2.1 |
| IPS Tank (°F) | 130 |
| MUPS Thruster 1B (°F) | 227.5, 230 |
| MUPS Thruster 2A (°F) | 227.5, 230 |
| ACIS PSMC (°C) | 52.5 |
| Fine Sun Sensor Elec. (°F) | 121, 124 |
