# The door agent

A small program that runs on the PC at a shop door, holds the fingerprint
scanner, and answers the clock page over `http://127.0.0.1:9500`.

It exists because of one hard fact: **a web page cannot read a fingerprint.**
The ZK9500 is a camera for fingers. Everything that makes it useful — turning
an image into a template, matching a template against a shop's worth of people
— lives in ZKTeco's closed library, which is a native Windows DLL. A browser
has no way to reach either. So something native has to sit between them, and
this is it.

The agent is deliberately the smallest thing that can work:

- It never decides anything about attendance. It matches a finger, gets an
  employee id, and hands that to the website, which decides whether to believe
  it. The website checks that the person still works there, still works at
  *that* door, and actually has a finger enrolled.
- It holds only its own shop's templates. `/api/clock/fingers?shop=N` refuses
  to hand over any other branch's people, so a stolen door PC costs you one
  shop's staff, not the company's.
- It keeps nothing on disk. Templates live in memory and are re-fetched on
  start. Pull the plug and the machine is carrying nothing.

## What runs where

```
   the finger                 this agent                 the website
  ┌──────────┐   USB    ┌───────────────────┐  HTTPS  ┌──────────────┐
  │  ZK9500  │ ───────► │ ZKFinger SDK      │ ──────► │ /api/clock/  │
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

1. **Driver and SDK.** Install ZKTeco's *ZKFinger SDK for Windows*, which
   carries the ZK9500 driver. Plug the scanner in afterwards and confirm it
   appears in Device Manager and that the SDK's own demo program captures a
   print. **If the demo cannot read a finger, nothing below will either** —
   fix that first, it is a driver problem and not ours.
2. **Node.js 20 or newer**, from nodejs.org, the LTS installer.
3. Copy this `agent` folder onto the PC, open a command prompt in it, and run
   `npm install`.
4. Copy `door.example.json` to `door.json` and fill in the four values.
5. `node door.js`. It prints the shop it is serving and how many templates it
   loaded. Leave the window open, or install it as a service (below).
6. Open the clock page in Chrome **on that same PC**. It finds the agent by
   itself and shows "Place your finger" above the keypad.

### As a service, so it starts with the PC

```
npm install -g node-windows
node service-install.js
```

The shop should not need somebody to remember to start a program.

## Configuration — `door.json`

| Key | What it is |
|---|---|
| `site` | `https://msbeauave-ops.vercel.app` |
| `username` | the `Timekeeper` sign-in |
| `password` | its code |
| `shop` | `1` for Bayan Bayanan, `2` for Dao |

The `shop` number is what stops the Dao machine holding Bayan Bayanan's
staff. Get it wrong and the door will simply not recognise anybody.

## The one file that needs the SDK

`sdk.js` is the only file that touches ZKTeco's library, and it is the only
file that cannot be written or tested without the hardware in hand. Everything
else — the HTTP surface, the template cache, the refresh loop, the fallback to
PINs — is finished and testable, and `SDK_STUB=1 node door.js` runs the whole
agent against a fake scanner so the clock page can be worked on without a
ZK9500 on the desk.

When the SDK arrives, `sdk.js` needs four functions filled in: `open`,
`close`, `capture`, and `identify`. The file says what each must return.
