# The door agent

A small program that runs on the PC at a shop door, holds the fingerprint
scanner, and answers the clock page over `http://127.0.0.1:9500`.

It exists because of one hard fact: **a web page cannot read a fingerprint.**
The ZK9500 is a camera for fingers. Everything that makes it useful — turning
an image into a template, matching a template against a shop's worth of people
— lives in ZKTeco's `libzkfp.dll`, which a browser has no way to reach. So
something native has to sit between them, and this is it.

The agent is deliberately the smallest thing that can work:

- It never decides anything about attendance. It matches a finger, gets an
  employee id, and hands that to the website, which decides whether to believe
  it — checking that the person still works there, still works at *that* door,
  and actually has a finger enrolled.
- It holds only its own shop's templates. `/api/clock/fingers?shop=N` refuses
  to hand over any other branch's people, so a stolen door PC costs you one
  shop's staff, not the company's.
- It keeps nothing on disk. Templates live in memory and are re-fetched every
  ten minutes. Pull the plug and the machine is carrying nothing.

## What runs where

```
   the finger                 this agent                 the website
  ┌──────────┐   USB    ┌───────────────────┐  HTTPS  ┌──────────────┐
  │  ZK9500  │ ───────► │ libzkfp.dll       │ ──────► │ /api/clock/  │
  └──────────┘          │ 1:N match, local  │ ◄────── │   fingers    │
                        └───────────────────┘         │   by-finger  │
                                 ▲                    └──────────────┘
                                 │ http://127.0.0.1:9500
                        ┌───────────────────┐
                        │ the clock page in │
                        │ Chrome, same PC   │
                        └───────────────────┘
```

## Installing, on the PC at the door

1. **ZKFinger SDK for Windows**, which carries the ZK9500 driver. Plug the
   scanner in afterwards and confirm the SDK's own demo captures a print. If
   the demo cannot read a finger, nothing below will either.
2. **Node.js 20 or newer.** It must match the DLL's architecture — the SDK
   ships both a 32-bit and a 64-bit `libzkfp.dll` and they are not
   interchangeable. 64-bit Node with 64-bit SDK is the ordinary case; the
   agent checks and says so plainly if they disagree.
3. Copy this `agent` folder onto the PC, open a command prompt in it, and run
   `npm install`. That fetches **koffi**, which is how Node calls into the DLL.
   If npm turns out to be missing, the Node installer was run with its npm
   component turned off — Settings → Apps → Node.js → Modify, and tick *npm
   package manager*. (`TEST-WITHOUT-SCANNER.bat` needs none of this and will
   run meanwhile.)
4. Copy `door.example.json` to `door.json` and fill it in.
5. **`npm run selftest`.** This is the important step. It opens the scanner,
   reads a print, walks the three-scan enrolment, loads the result into the
   matcher and matches a fresh finger against it — the same calls the agent
   makes, one at a time, stopping at the first failure with what to do about
   it. Do not move on until every line says `ok`.
6. `npm start`. It prints the shop it is serving and how many templates it
   loaded.
7. Open the clock page in Chrome **on that same PC**. It finds the agent by
   itself and shows "Place your finger" above the keypad.

### As a service, so it starts with the PC

```
npm install -g node-windows
node service-install.js
```

A shop should not need somebody to remember to start a program.

## Configuration — `door.json`

| Key | What it is |
|---|---|
| `site` | `https://msbeauave-ops.vercel.app` |
| `username` | the `Timekeeper` sign-in |
| `password` | its code |
| `shop` | `1` for Bayan Bayanan, `2` for Dao |
| `zkfpPath` | leave empty unless the DLL is somewhere unusual |

The `shop` number is what stops the Dao machine holding Bayan Bayanan's
staff. Get it wrong and the door simply will not recognise anybody.

`door.json` holds the door's password and is git-ignored. Keep it that way.

## Enrolling

From the back office: Team → open a person → **Fingerprints** → Scan a finger.
The scanner takes the finger **three times** and merges the three into one
registration template, which is how ZKTeco's own algorithm expects to be
enrolled — one scan is a photograph of one moment, and the matcher wants the
parts of a finger that are the same every time. Lift between each press.

Enrol two fingers each. A cut thumb on a Monday should not cost somebody
their hours.

## If something goes wrong

Every SDK error code is translated before it reaches a screen, so the answer
usually says what to do. The ones worth knowing:

| What you see | What it means |
|---|---|
| no scanner is plugged in | USB, or the driver did not install |
| the scanner is in use by another program | the SDK demo is still open |
| that print could not be read | dry or dirty finger; wipe the glass |
| the finger did not match the earlier scans | a different finger mid-enrolment |
| libzkfp.dll and Node do not match | 32-bit against 64-bit; see step 2 |

`TEST-WITHOUT-SCANNER.bat` (or `SDK_STUB=1 npm start`) runs the whole agent
against a pretend scanner: it signs in, pulls the shop's templates down, and
answers the clock page, but never reads a finger. That is exactly what tells a
website problem apart from a hardware one — if the clock page finds the agent
and shows a count, everything except the scanner is working.
