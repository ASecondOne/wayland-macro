# Wayland GNOME Macro Recorder

This repo is a GNOME Shell extension for GNOME on Wayland that records a simple macro and replays it through GNOME Shell's own virtual input devices.

It installs as a separate GNOME Shell extension from the original autoclicker, so both can be installed and enabled at the same time.

Current behavior:

- `F4` starts recording and `F4` again stops recording
- `F5` plays the last recorded macro and `F5` again stops playback
- while recording, a small local helper reads keyboard presses, mouse movement, and mouse button events from `/dev/input/event*`
- while recording, the target app keeps receiving your real input directly; the extension no longer grabs the seat inside GNOME Shell
- playback uses GNOME Shell virtual keyboard and pointer devices instead of X11-only tricks

## Install on this machine

Run:

```bash
./scripts/install-local.sh
```

That script will:

- compile the GSettings schema
- compile the local Rust input helper
- build a GNOME extension bundle in `build/`
- install the bundle with `gnome-extensions install --force`
- copy the helper into the installed extension directory
- try to enable it immediately
- fall back to marking it enabled for the next GNOME login if the running shell does not rescan newly installed extensions

## Notes

- Red dot means recording. Blue dot means playback.
- Recorded macros are stored in memory only. Reloading GNOME Shell or disabling the extension clears the current recording.
- Pointer movement is recorded from raw evdev deltas, with screen coordinates kept when the cursor actually moves and relative playback used when a game captures or locks the pointer.
- If GNOME Shell does not discover the new extension live, log out and back in once.
