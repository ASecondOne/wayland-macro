# Wayland GNOME Macro Recorder

This repo is a GNOME Shell extension for GNOME on Wayland that records a simple macro and replays it through GNOME Shell's own virtual input devices.

It installs as a separate GNOME Shell extension from the original autoclicker, so both can be installed and enabled at the same time.

Current behavior:

- `F4` starts recording and `F4` again stops recording
- `F5` plays the last recorded macro and `F5` again stops playback
- while recording, the extension captures keyboard presses, mouse movement, and mouse button events
- while recording, the extension grabs the seat inside GNOME Shell and immediately forwards the same events back into GNOME so the target app still receives them
- playback uses GNOME Shell virtual keyboard and pointer devices instead of X11-only tricks

## Install on this machine

Run:

```bash
./scripts/install-local.sh
```

That script will:

- compile the GSettings schema
- build a GNOME extension bundle in `build/`
- install the bundle with `gnome-extensions install --force`
- try to enable it immediately
- fall back to marking it enabled for the next GNOME login if the running shell does not rescan newly installed extensions

## Notes

- Red dot means recording. Blue dot means playback.
- Recorded macros are stored in memory only. Reloading GNOME Shell or disabling the extension clears the current recording.
- Pointer movement is replayed as relative motion, so playback starts from the mouse position you have when you press `F5`.
- If GNOME Shell does not discover the new extension live, log out and back in once.
