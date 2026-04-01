import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import St from 'gi://St'

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'

const UUID = 'wayland-macro-recorder@anotherone'

const KEY_RECORD_SHORTCUT = 'record-shortcut'
const KEY_PLAYBACK_SHORTCUT = 'playback-shortcut'
const KEY_LOOP_PLAYBACK = 'loop-playback'

const EVDEV_KEY_F4 = 62
const EVDEV_KEY_F5 = 63
const EVDEV_KEY_F1 = 59
const EVDEV_KEY_F12 = 88

const KEY_RELEASED = 0
const KEY_PRESSED = 1
const BUTTON_RELEASED = 0
const BUTTON_PRESSED = 1
const POINTER_TARGET_TOLERANCE = 1
const POINTER_MAX_STEP = 96
const POINTER_MAX_CORRECTION_ATTEMPTS = 64
const POINTER_SETTLE_DELAY_MS = 8
const POINTER_SETTLE_POLL_COUNT = 6

const GRAB_STATE_POINTER = 1
const GRAB_STATE_KEYBOARD = 1 << 1
const GRAB_STATE_ALL = GRAB_STATE_POINTER | GRAB_STATE_KEYBOARD
const EVENT_FLAG_SYNTHETIC = 1 << 0
const EVENT_FLAG_REPEATED = 1 << 2
const MUTTER_REMOTE_DESKTOP_DESTINATION = 'org.gnome.Mutter.RemoteDesktop'
const MUTTER_REMOTE_DESKTOP_OBJECT_PATH = '/org/gnome/Mutter/RemoteDesktop'
const MUTTER_REMOTE_DESKTOP_IFACE = 'org.gnome.Mutter.RemoteDesktop'
const MUTTER_REMOTE_DESKTOP_SESSION_IFACE = 'org.gnome.Mutter.RemoteDesktop.Session'

const STATUS = {
    IDLE: 'idle',
    RECORDING: 'recording',
    PLAYING: 'playing',
    ERROR: 'error',
}

function describeError(error) {
    if (error instanceof Error)
        return error.message

    return String(error)
}

function formatShortcut(settings, key) {
    const shortcuts = settings.get_strv(key).filter(Boolean)
    return shortcuts.length > 0 ? shortcuts.join(', ') : _('Disabled')
}

function formatEventCount(count) {
    return `${count} ${count === 1 ? _('event') : _('events')}`
}

function isIgnoredFunctionKey(keycode) {
    return keycode >= EVDEV_KEY_F1 && keycode <= EVDEV_KEY_F12
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
}

function toEvdevButtonCode(button) {
    switch (button) {
    case 1:
        return 272
    case 2:
        return 274
    case 3:
        return 273
    case 4:
        return 275
    case 5:
        return 276
    default:
        return button
    }
}

function getEventCode(event) {
    if (typeof event.get_event_code === 'function') {
        const eventCode = event.get_event_code()
        if (eventCode > 0)
            return eventCode
    }

    return 0
}

function getKeyEventCode(event) {
    const eventCode = getEventCode(event)
    if (eventCode > 0)
        return eventCode

    return event.get_key_code()
}

function getButtonEventCode(event) {
    const eventCode = getEventCode(event)
    if (eventCode > 0)
        return eventCode

    return toEvdevButtonCode(event.get_button())
}

function getRelativeMotionDelta(event) {
    if (typeof event.get_relative_motion !== 'function')
        return null

    try {
        const relativeMotion = event.get_relative_motion()
        if (!Array.isArray(relativeMotion))
            return null

        const [hasRelativeMotion, dx, dy] = relativeMotion
        return hasRelativeMotion ? [dx, dy] : null
    } catch (_error) {
        return null
    }
}

function waitMs(delayMs) {
    return new Promise(resolve => {
        if (delayMs <= 0) {
            resolve()
            return
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            resolve()
            return GLib.SOURCE_REMOVE
        })
    })
}

function callDBus(connection, destination, objectPath, interfaceName, methodName,
    parameters = null, replyType = null) {
    return new Promise((resolve, reject) => {
        connection.call(
            destination,
            objectPath,
            interfaceName,
            methodName,
            parameters,
            replyType,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (source, result) => {
                try {
                    resolve(source.call_finish(result))
                } catch (error) {
                    reject(error)
                }
            })
    })
}

class MutterRemoteDesktopController {
    constructor(onClosed) {
        this._onClosed = onClosed
        this._connection = Gio.DBus.session
        this._sessionPath = null
        this._sessionClosedSignalId = 0
        this._startPromise = null
    }

    async ensureStarted() {
        if (this._sessionPath)
            return

        if (!this._startPromise) {
            this._startPromise = this._startInternal().finally(() => {
                this._startPromise = null
            })
        }

        return this._startPromise
    }

    async movePointer(dx, dy) {
        if (dx === 0 && dy === 0)
            return

        await this._callSession(
            'NotifyPointerMotionRelative',
            new GLib.Variant('(dd)', [dx, dy]))
    }

    async notifyPointerButton(buttonCode, state) {
        await this._callSession(
            'NotifyPointerButton',
            new GLib.Variant('(ib)', [buttonCode, state === BUTTON_PRESSED]))
    }

    async notifyKeyboardKeycode(keycode, state) {
        await this._callSession(
            'NotifyKeyboardKeycode',
            new GLib.Variant('(ub)', [keycode, state === KEY_PRESSED]))
    }

    async stop() {
        const sessionPath = this._sessionPath
        this._sessionPath = null
        this._unwatchSession()

        if (!sessionPath)
            return

        try {
            await callDBus(
                this._connection,
                MUTTER_REMOTE_DESKTOP_DESTINATION,
                sessionPath,
                MUTTER_REMOTE_DESKTOP_SESSION_IFACE,
                'Stop',
                null,
                new GLib.VariantType('()'))
        } catch (error) {
            logError(error, `${UUID}: failed to stop Mutter remote desktop session`)
        }
    }

    destroy() {
        this._onClosed = null
        void this.stop()
    }

    async _startInternal() {
        const result = await callDBus(
            this._connection,
            MUTTER_REMOTE_DESKTOP_DESTINATION,
            MUTTER_REMOTE_DESKTOP_OBJECT_PATH,
            MUTTER_REMOTE_DESKTOP_IFACE,
            'CreateSession',
            null,
            new GLib.VariantType('(o)'))

        const [sessionPath] = result.deepUnpack()
        if (!sessionPath)
            throw new Error(_('GNOME did not return a Mutter remote desktop session.'))

        this._sessionPath = sessionPath
        this._watchSession(sessionPath)

        try {
            await callDBus(
                this._connection,
                MUTTER_REMOTE_DESKTOP_DESTINATION,
                sessionPath,
                MUTTER_REMOTE_DESKTOP_SESSION_IFACE,
                'Start',
                null,
                new GLib.VariantType('()'))
        } catch (error) {
            this._sessionPath = null
            this._unwatchSession()
            throw error
        }
    }

    async _callSession(methodName, parameters) {
        await this.ensureStarted()

        if (!this._sessionPath)
            throw new Error(_('No Mutter remote desktop session is active.'))

        await callDBus(
            this._connection,
            MUTTER_REMOTE_DESKTOP_DESTINATION,
            this._sessionPath,
            MUTTER_REMOTE_DESKTOP_SESSION_IFACE,
            methodName,
            parameters,
            new GLib.VariantType('()'))
    }

    _watchSession(sessionPath) {
        this._unwatchSession()
        this._sessionClosedSignalId = this._connection.signal_subscribe(
            MUTTER_REMOTE_DESKTOP_DESTINATION,
            MUTTER_REMOTE_DESKTOP_SESSION_IFACE,
            'Closed',
            sessionPath,
            null,
            Gio.DBusSignalFlags.NONE,
            () => {
                this._sessionPath = null
                this._unwatchSession()

                if (this._onClosed)
                    this._onClosed()
            })
    }

    _unwatchSession() {
        if (!this._sessionClosedSignalId)
            return

        this._connection.signal_unsubscribe(this._sessionClosedSignalId)
        this._sessionClosedSignalId = 0
    }
}

class EvdevRecordingSource {
    constructor(helperPath, callbacks) {
        this._helperPath = helperPath
        this._callbacks = callbacks
        this._process = null
        this._stdout = null
        this._stderr = null
        this._cancellable = null
        this._stopping = false
    }

    start() {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        })

        this._stopping = false
        this._cancellable = new Gio.Cancellable()
        this._process = launcher.spawnv([this._helperPath])
        this._stdout = new Gio.DataInputStream({
            base_stream: this._process.get_stdout_pipe(),
            close_base_stream: true,
        })
        this._stderr = new Gio.DataInputStream({
            base_stream: this._process.get_stderr_pipe(),
            close_base_stream: true,
        })

        this._readStdout()
        this._readStderr()
        this._waitForExit()
    }

    stop() {
        this._stopping = true

        if (this._cancellable) {
            this._cancellable.cancel()
            this._cancellable = null
        }

        if (this._process) {
            this._process.force_exit()
            this._process = null
        }

        this._stdout = null
        this._stderr = null
    }

    destroy() {
        this.stop()
    }

    _readStdout() {
        this._readLine(this._stdout, line => {
            let payload

            try {
                payload = JSON.parse(line)
            } catch (error) {
                this._callbacks.onError?.(new Error(`Invalid recorder output: ${describeError(error)}`))
                return
            }

            this._callbacks.onRecordedEvent?.(payload)
        })
    }

    _readStderr() {
        this._readLine(this._stderr, line => {
            if (!this._stopping && line.length > 0)
                this._callbacks.onError?.(new Error(line))
        })
    }

    _readLine(stream, onLine) {
        if (!stream || !this._cancellable)
            return

        stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (source, result) => {
            let line

            try {
                ;[line] = source.read_line_finish_utf8(result)
            } catch (error) {
                if (!this._stopping && !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._callbacks.onError?.(error)
                return
            }

            if (line === null)
                return

            onLine(line)
            this._readLine(stream, onLine)
        })
    }

    _waitForExit() {
        if (!this._process)
            return

        this._process.wait_check_async(this._cancellable, (process, result) => {
            try {
                process.wait_check_finish(result)
            } catch (error) {
                if (!this._stopping && !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._callbacks.onError?.(error)
            } finally {
                if (this._process === process)
                    this._process = null
            }
        })
    }
}

class EvdevPointerPlaybackSink {
    constructor(helperPath, callbacks) {
        this._helperPath = helperPath
        this._callbacks = callbacks
        this._process = null
        this._stdin = null
        this._stderr = null
        this._cancellable = null
        this._stopping = false
    }

    start() {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        })

        this._stopping = false
        this._cancellable = new Gio.Cancellable()
        this._process = launcher.spawnv([this._helperPath, '--play-pointer'])
        this._stdin = new Gio.DataOutputStream({
            base_stream: this._process.get_stdin_pipe(),
            close_base_stream: true,
        })
        this._stderr = new Gio.DataInputStream({
            base_stream: this._process.get_stderr_pipe(),
            close_base_stream: true,
        })

        this._readStderr()
        this._waitForExit()
    }

    async movePointer(dx, dy) {
        const roundedDx = Math.round(dx)
        const roundedDy = Math.round(dy)

        if (roundedDx === 0 && roundedDy === 0)
            return

        this._writeLine(`motion ${roundedDx} ${roundedDy}`)
    }

    async notifyPointerButton(buttonCode, state) {
        this._writeLine(`button ${Math.round(buttonCode)} ${Math.round(state)}`)
    }

    stop() {
        this._stopping = true

        if (this._cancellable) {
            this._cancellable.cancel()
            this._cancellable = null
        }

        if (this._stdin) {
            try {
                this._stdin.close(null)
            } catch (_error) {
                if (this._process)
                    this._process.force_exit()
            }

            this._stdin = null
        }

        this._stderr = null
    }

    destroy() {
        this.stop()
    }

    _writeLine(line) {
        if (!this._stdin || !this._process)
            throw new Error(_('The local pointer playback helper is not running.'))

        this._stdin.put_string(`${line}\n`, null)
        this._stdin.flush(null)
    }

    _readStderr() {
        this._readLine(this._stderr, line => {
            if (!this._stopping && line.length > 0)
                this._callbacks.onError?.(new Error(line))
        })
    }

    _readLine(stream, onLine) {
        if (!stream || !this._cancellable)
            return

        stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (source, result) => {
            let line

            try {
                ;[line] = source.read_line_finish_utf8(result)
            } catch (error) {
                if (!this._stopping && !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._callbacks.onError?.(error)
                return
            }

            if (line === null)
                return

            onLine(line)
            this._readLine(stream, onLine)
        })
    }

    _waitForExit() {
        if (!this._process)
            return

        this._process.wait_check_async(this._cancellable, (process, result) => {
            try {
                process.wait_check_finish(result)

                if (!this._stopping)
                    this._callbacks.onError?.(new Error(_('The local pointer playback helper exited unexpectedly.')))
            } catch (error) {
                if (!this._stopping && !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._callbacks.onError?.(error)
            } finally {
                if (this._process === process)
                    this._process = null
            }
        })
    }
}

class RecordingGrab {
    constructor(inputController, callbacks) {
        this._inputController = inputController
        this._callbacks = callbacks
        this._grab = null
        this._regrabId = 0
        this._lastPointerX = null
        this._lastPointerY = null
        this._stopOnF4Release = false
        this._pressedKeycodes = new Set()
        this._pressedButtonCodes = new Set()

        this._actor = new St.Widget({
            reactive: true,
            can_focus: true,
            opacity: 0,
            visible: false,
        })

        this._actorEventId = this._actor.connect('event', (_actor, event) => {
            return this._handleEvent(event)
        })
        Main.uiGroup.add_child(this._actor)

        this._stageAllocationId = global.stage.connect('notify::allocation', () => {
            this._syncGeometry()
        })
        this._syncGeometry()
    }

    start() {
        this._syncGeometry()
        this._actor.show()
        this._grabSeat()
        this._pressedKeycodes.clear()
        this._pressedButtonCodes.clear()

        this._actor.grab_key_focus()

        const [pointerX, pointerY] = global.get_pointer()
        this._lastPointerX = pointerX
        this._lastPointerY = pointerY
    }

    stop() {
        this._stopOnF4Release = false
        this._removePendingRegrab()
        this._dismissGrab()
        this._pressedKeycodes.clear()
        this._pressedButtonCodes.clear()

        this._actor.hide()
        this._lastPointerX = null
        this._lastPointerY = null
    }

    destroy() {
        this.stop()

        if (this._stageAllocationId) {
            global.stage.disconnect(this._stageAllocationId)
            this._stageAllocationId = 0
        }

        if (this._actorEventId) {
            this._actor.disconnect(this._actorEventId)
            this._actorEventId = 0
        }

        this._actor.destroy()
    }

    _grabSeat() {
        this._dismissGrab()

        this._grab = global.stage.grab(this._actor)
        if (!this._grab)
            throw new Error(_('GNOME could not grab the seat for recording.'))

        if ((this._grab.get_seat_state() & GRAB_STATE_ALL) !== GRAB_STATE_ALL) {
            this._dismissGrab()
            throw new Error(_('GNOME could not grab keyboard and pointer input.'))
        }
    }

    _dismissGrab() {
        if (!this._grab)
            return

        this._grab.dismiss()
        this._grab = null
    }

    _removePendingRegrab() {
        if (!this._regrabId)
            return

        GLib.Source.remove(this._regrabId)
        this._regrabId = 0
    }

    _forwardWhileUngrabbed(callback) {
        this._removePendingRegrab()
        this._dismissGrab()

        try {
            const maybePromise = callback()
            if (maybePromise?.catch)
                maybePromise.catch(error => this._callbacks.onError?.(error))
        } catch (error) {
            this._callbacks.onError?.(error)
        }

        this._regrabId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._regrabId = 0

            if (!this._actor.visible)
                return GLib.SOURCE_REMOVE

            try {
                this._grabSeat()
                this._actor.grab_key_focus()
            } catch (error) {
                if (this._callbacks.onError)
                    this._callbacks.onError(error)
            }

            return GLib.SOURCE_REMOVE
        })
    }

    _syncGeometry() {
        this._actor.set_position(0, 0)
        this._actor.set_size(global.stage.width, global.stage.height)
    }

    _handleEvent(event) {
        try {
            if ((event.get_flags() & EVENT_FLAG_SYNTHETIC) !== 0)
                return Clutter.EVENT_STOP

            switch (event.type()) {
            case Clutter.EventType.KEY_PRESS:
            case Clutter.EventType.KEY_RELEASE:
                return this._handleKeyEvent(event)
            case Clutter.EventType.BUTTON_PRESS:
            case Clutter.EventType.BUTTON_RELEASE:
                return this._handleButtonEvent(event)
            case Clutter.EventType.MOTION:
                return this._handleMotionEvent(event)
            default:
                return Clutter.EVENT_STOP
            }
        } catch (error) {
            if (this._callbacks.onError)
                this._callbacks.onError(error)

            return Clutter.EVENT_STOP
        }
    }

    _handleKeyEvent(event) {
        const keycode = getKeyEventCode(event)
        const isPress = event.type() === Clutter.EventType.KEY_PRESS
        const isRepeated = (event.get_flags() & EVENT_FLAG_REPEATED) !== 0

        if (keycode === EVDEV_KEY_F4) {
            if (isPress && !isRepeated) {
                this._stopOnF4Release = true
            } else if (!isPress && this._stopOnF4Release) {
                this._stopOnF4Release = false
                if (this._callbacks.onStopRequested)
                    this._callbacks.onStopRequested()
            }

            return Clutter.EVENT_STOP
        }

        if (keycode === EVDEV_KEY_F5 || isRepeated)
            return Clutter.EVENT_STOP

        if (isPress) {
            if (this._pressedKeycodes.has(keycode))
                return Clutter.EVENT_STOP

            this._pressedKeycodes.add(keycode)
        } else if (!this._pressedKeycodes.delete(keycode)) {
            return Clutter.EVENT_STOP
        }

        const payload = {
            type: 'key',
            keycode,
            state: isPress ? KEY_PRESSED : KEY_RELEASED,
        }

        if (this._callbacks.onRecordedEvent)
            this._callbacks.onRecordedEvent(payload)

        this._forwardWhileUngrabbed(() => {
            this._inputController.notifyKeyboardKeycode(keycode, payload.state)
        })
        return Clutter.EVENT_STOP
    }

    _handleButtonEvent(event) {
        const buttonCode = getButtonEventCode(event)
        const isPress = event.type() === Clutter.EventType.BUTTON_PRESS

        if (isPress) {
            if (this._pressedButtonCodes.has(buttonCode))
                return Clutter.EVENT_STOP

            this._pressedButtonCodes.add(buttonCode)
        } else if (!this._pressedButtonCodes.delete(buttonCode)) {
            return Clutter.EVENT_STOP
        }

        const payload = {
            type: 'button',
            buttonCode,
            state: isPress ? BUTTON_PRESSED : BUTTON_RELEASED,
        }

        if (this._callbacks.onRecordedEvent)
            this._callbacks.onRecordedEvent(payload)

        this._forwardWhileUngrabbed(() => {
            this._inputController.notifyPointerButton(payload.buttonCode, payload.state)
        })
        return Clutter.EVENT_STOP
    }

    _handleMotionEvent(event) {
        const [pointerX, pointerY] = event.get_coords()
        const relativeMotion = getRelativeMotionDelta(event)
        const dx = relativeMotion
            ? relativeMotion[0]
            : (this._lastPointerX === null ? 0 : pointerX - this._lastPointerX)
        const dy = relativeMotion
            ? relativeMotion[1]
            : (this._lastPointerY === null ? 0 : pointerY - this._lastPointerY)

        if (dx === 0 && dy === 0) {
            this._lastPointerX = pointerX
            this._lastPointerY = pointerY
            return Clutter.EVENT_STOP
        }

        const payload = {
            type: 'motion',
            x: pointerX,
            y: pointerY,
            dx,
            dy,
        }

        if (this._callbacks.onRecordedEvent)
            this._callbacks.onRecordedEvent(payload)

        // Reinjecting motion while the real device is already moving the cursor
        // causes doubled movement and visible sway during recording.
        this._lastPointerX = pointerX
        this._lastPointerY = pointerY

        return Clutter.EVENT_STOP
    }
}

const MacroIndicator = GObject.registerClass(
class MacroIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Wayland Macro Recorder'))

        this._extension = extension
        this._helperPath = GLib.build_filenamev([extension.path, 'native', 'evdev-recorder-helper'])
        this._settings = extension.getSettings()
        this._inputController = new MutterRemoteDesktopController(() => {
            if (this._status === STATUS.RECORDING || this._status === STATUS.PLAYING)
                this._stopFromError(new Error(_('GNOME closed the virtual input session.')))
        })
        this._recordingSource = null
        this._pointerPlaybackSink = null

        this._status = STATUS.IDLE
        this._lastError = ''
        this._macroEvents = []
        this._lastRecordTimestampUsec = null
        this._recordedPressedKeys = new Set()
        this._recordedPressedButtons = new Set()
        this._lastObservedPointerX = null
        this._lastObservedPointerY = null
        this._playbackSerial = 0
        this._playbackPressedKeys = new Set()
        this._playbackPressedButtons = new Set()
        this._destroyed = false
        this._loopPlaybackEnabled = this._settings.get_boolean(KEY_LOOP_PLAYBACK)

        this.add_style_class_name('macro-panel-button')

        const buttonBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        })

        this._icon = new St.Icon({
            icon_name: 'input-keyboard-symbolic',
            style_class: 'system-status-icon',
        })
        buttonBox.add_child(this._icon)

        this._dot = new St.Widget({
            style_class: 'macro-active-dot',
        })
        buttonBox.add_child(this._dot)

        this.add_child(buttonBox)

        this._buildMenu()
        this._bindSettings()
        this._rebindShortcuts()
        this._syncUi()
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        })

        const statusBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'macro-menu-heading',
        })

        this._statusTitle = new St.Label({
            text: _('Wayland Macro Recorder'),
            style_class: 'macro-menu-title',
            x_expand: true,
        })
        statusBox.add_child(this._statusTitle)

        this._statusDescription = new St.Label({
            style_class: 'macro-menu-subtitle',
            x_expand: true,
        })
        statusBox.add_child(this._statusDescription)

        this._statusItem.add_child(statusBox)
        this.menu.addMenuItem(this._statusItem)
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

        this._loopPlaybackItem = new PopupMenu.PopupSwitchMenuItem(
            _('Loop playback'),
            this._loopPlaybackEnabled)
        this._loopPlaybackItem.connect('toggled', (_item, enabled) => {
            if (enabled !== this._settings.get_boolean(KEY_LOOP_PLAYBACK))
                this._settings.set_boolean(KEY_LOOP_PLAYBACK, enabled)
        })
        this.menu.addMenuItem(this._loopPlaybackItem)
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

        this._macroInfoLabel = this._addInfoRow()
        this._shortcutInfoLabel = this._addInfoRow()
        this._captureInfoLabel = this._addInfoRow()
    }

    _addInfoRow() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        })

        const label = new St.Label({
            style_class: 'macro-menu-subtitle',
            x_expand: true,
        })

        item.add_child(label)
        this.menu.addMenuItem(item)
        return label
    }

    _bindSettings() {
        this._settings.connectObject(
            `changed::${KEY_RECORD_SHORTCUT}`,
            () => {
                this._rebindShortcuts()
                this._syncUi()
            },
            `changed::${KEY_PLAYBACK_SHORTCUT}`,
            () => {
                this._rebindShortcuts()
                this._syncUi()
            },
            `changed::${KEY_LOOP_PLAYBACK}`,
            () => {
                this._syncLoopPlaybackState()
                this._syncUi()
            },
            this)
    }

    _syncLoopPlaybackState() {
        this._loopPlaybackEnabled = this._settings.get_boolean(KEY_LOOP_PLAYBACK)
        this._loopPlaybackItem?.setToggleState(this._loopPlaybackEnabled)
    }

    _rebindShortcuts() {
        Main.wm.removeKeybinding(KEY_RECORD_SHORTCUT)
        Main.wm.removeKeybinding(KEY_PLAYBACK_SHORTCUT)

        Main.wm.addKeybinding(
            KEY_RECORD_SHORTCUT,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                void this._toggleRecording()
            })

        Main.wm.addKeybinding(
            KEY_PLAYBACK_SHORTCUT,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                void this._togglePlayback()
            })
    }

    async _ensureInputController() {
        await this._inputController.ensureStarted()
        return this._inputController
    }

    async _toggleRecording() {
        if (this._status === STATUS.RECORDING) {
            this._stopRecording()
            return
        }

        this._cancelPlayback()
        await this._startRecording()
    }

    async _togglePlayback() {
        if (this._status === STATUS.PLAYING) {
            this._cancelPlayback()
            return
        }

        if (this._status === STATUS.RECORDING)
            this._stopRecording()

        await this._startPlayback()
    }

    async _startRecording() {
        try {
            if (!GLib.file_test(this._helperPath, GLib.FileTest.IS_EXECUTABLE))
                throw new Error(_('The local input helper is missing. Reinstall the extension with scripts/install-local.sh.'))

            this._stopRecordingSource()
            this._macroEvents = []
            this._lastRecordTimestampUsec = null
            this._lastError = ''
            this._recordedPressedKeys.clear()
            this._recordedPressedButtons.clear()
            this._setRecordedPointerSample(...global.get_pointer())

            this._recordingSource = new EvdevRecordingSource(this._helperPath, {
                onRecordedEvent: event => this._recordEvent(event),
                onError: error => this._stopFromError(error),
            })
            this._recordingSource.start()

            this._status = STATUS.RECORDING
            this._syncUi()
        } catch (error) {
            this._stopFromError(error)
        }
    }

    _stopRecording() {
        const wasRecording = this._status === STATUS.RECORDING

        this._stopRecordingSource()

        if (!wasRecording || this._destroyed)
            return

        this._recordedPressedKeys.clear()
        this._recordedPressedButtons.clear()
        this._resetRecordedPointerSample()
        this._status = STATUS.IDLE
        this._lastError = ''
        this._syncUi()
    }

    _stopRecordingSource() {
        if (!this._recordingSource)
            return

        this._recordingSource.destroy()
        this._recordingSource = null
    }

    _stopPointerPlaybackSink() {
        if (!this._pointerPlaybackSink)
            return

        this._pointerPlaybackSink.destroy()
        this._pointerPlaybackSink = null
    }

    _setRecordedPointerSample(pointerX, pointerY) {
        this._lastObservedPointerX = Number.isFinite(pointerX) ? pointerX : null
        this._lastObservedPointerY = Number.isFinite(pointerY) ? pointerY : null
    }

    _resetRecordedPointerSample() {
        this._lastObservedPointerX = null
        this._lastObservedPointerY = null
    }

    _recordEvent(payload) {
        if (payload.type === 'motion') {
            const hadAbsolutePosition = Number.isFinite(payload.x) && Number.isFinite(payload.y)
            const dx = Number.isFinite(payload.dx) ? payload.dx : 0
            const dy = Number.isFinite(payload.dy) ? payload.dy : 0
            let pointerX = payload.x
            let pointerY = payload.y

            if (!hadAbsolutePosition)
                [pointerX, pointerY] = global.get_pointer()

            const cursorStayedStill =
                this._lastObservedPointerX !== null &&
                this._lastObservedPointerY !== null &&
                Math.round(pointerX) === Math.round(this._lastObservedPointerX) &&
                Math.round(pointerY) === Math.round(this._lastObservedPointerY)
            const capturedPointerMotion = !hadAbsolutePosition && (dx !== 0 || dy !== 0) && cursorStayedStill

            payload = {
                type: 'motion',
                x: capturedPointerMotion ? null : pointerX,
                y: capturedPointerMotion ? null : pointerY,
                dx,
                dy,
                preferRelative: Boolean(
                    payload.preferRelative ||
                    this._recordedPressedButtons.size > 0 ||
                    capturedPointerMotion),
            }

            this._setRecordedPointerSample(pointerX, pointerY)
        }

        if (payload.type === 'key') {
            if (isIgnoredFunctionKey(payload.keycode))
                return

            if (payload.state === KEY_PRESSED) {
                if (this._recordedPressedKeys.has(payload.keycode))
                    return

                this._recordedPressedKeys.add(payload.keycode)
            } else if (!this._recordedPressedKeys.delete(payload.keycode)) {
                return
            }
        } else if (payload.type === 'button') {
            if (payload.state === BUTTON_PRESSED) {
                if (this._recordedPressedButtons.has(payload.buttonCode))
                    return

                this._recordedPressedButtons.add(payload.buttonCode)
            } else if (!this._recordedPressedButtons.delete(payload.buttonCode)) {
                return
            }
        }

        const eventTimestampUsec = GLib.get_monotonic_time()
        const delay = this._lastRecordTimestampUsec === null
            ? 0
            : Math.max(0, Math.round((eventTimestampUsec - this._lastRecordTimestampUsec) / 1000))
        const lastEvent = this._macroEvents[this._macroEvents.length - 1] ?? null

        if (payload.type === 'motion' && delay === 0 && lastEvent?.type === 'motion') {
            lastEvent.x = payload.x
            lastEvent.y = payload.y
            lastEvent.dx = (lastEvent.dx ?? 0) + (payload.dx ?? 0)
            lastEvent.dy = (lastEvent.dy ?? 0) + (payload.dy ?? 0)
            lastEvent.preferRelative = Boolean(lastEvent.preferRelative || payload.preferRelative)
            this._lastRecordTimestampUsec = eventTimestampUsec
            this._syncUi()
            return
        }

        this._macroEvents.push({
            ...payload,
            delay,
        })
        this._lastRecordTimestampUsec = eventTimestampUsec
        this._syncUi()
    }

    _cancelPlayback() {
        if (this._status !== STATUS.PLAYING)
            return

        this._playbackSerial++
        void this._releasePlaybackInputs()
        this._status = STATUS.IDLE
        this._lastError = ''
        this._syncUi()
    }

    _getSanitizedMacroEvents() {
        const sanitized = []
        const pressedKeys = new Set()
        const pressedButtons = new Set()
        let carryDelay = 0

        for (const macroEvent of this._macroEvents) {
            const eventDelay = Math.max(0, macroEvent.delay ?? 0)
            let keepEvent = true

            switch (macroEvent.type) {
            case 'motion':
                keepEvent =
                    (Number.isFinite(macroEvent.x) && Number.isFinite(macroEvent.y)) ||
                    (Number.isFinite(macroEvent.dx) && Number.isFinite(macroEvent.dy))
                break
            case 'button':
                if (macroEvent.state === BUTTON_PRESSED) {
                    if (pressedButtons.has(macroEvent.buttonCode))
                        keepEvent = false
                    else
                        pressedButtons.add(macroEvent.buttonCode)
                } else if (!pressedButtons.delete(macroEvent.buttonCode)) {
                    keepEvent = false
                }
                break
            case 'key':
                if (macroEvent.keycode <= 0 ||
                    isIgnoredFunctionKey(macroEvent.keycode)) {
                    keepEvent = false
                    break
                }

                if (macroEvent.state === KEY_PRESSED) {
                    if (pressedKeys.has(macroEvent.keycode))
                        keepEvent = false
                    else
                        pressedKeys.add(macroEvent.keycode)
                } else if (!pressedKeys.delete(macroEvent.keycode)) {
                    keepEvent = false
                }
                break
            default:
                keepEvent = false
                break
            }

            if (!keepEvent) {
                carryDelay += eventDelay
                continue
            }

            const normalizedEvent = {
                ...macroEvent,
                delay: eventDelay + carryDelay,
            }
            const lastEvent = sanitized[sanitized.length - 1] ?? null

            carryDelay = 0

            if (normalizedEvent.type === 'motion' &&
                normalizedEvent.delay === 0 &&
                lastEvent?.type === 'motion') {
                if (Number.isFinite(normalizedEvent.x) && Number.isFinite(normalizedEvent.y)) {
                    lastEvent.x = normalizedEvent.x
                    lastEvent.y = normalizedEvent.y
                }

                lastEvent.dx = (lastEvent.dx ?? 0) + (normalizedEvent.dx ?? 0)
                lastEvent.dy = (lastEvent.dy ?? 0) + (normalizedEvent.dy ?? 0)
                lastEvent.preferRelative = Boolean(lastEvent.preferRelative || normalizedEvent.preferRelative)
                continue
            }

            sanitized.push(normalizedEvent)
        }

        return sanitized
    }

    async _startPlayback() {
        const macroEvents = this._getSanitizedMacroEvents()
        const needsKeyboard = macroEvents.some(macroEvent => macroEvent.type === 'key')
        const needsPointer = macroEvents.some(macroEvent =>
            macroEvent.type === 'motion' || macroEvent.type === 'button')
        const firstPointerEvent = macroEvents.find(macroEvent =>
            macroEvent.type === 'motion' &&
            Number.isFinite(macroEvent.x) &&
            Number.isFinite(macroEvent.y))

        if (macroEvents.length === 0) {
            Main.notifyError(
                _('No macro recorded'),
                _('Press F4 to record a macro before starting playback.'))
            return
        }

        this._macroEvents = macroEvents
        this._syncUi()

        try {
            this._stopPointerPlaybackSink()

            if (needsKeyboard || needsPointer)
                await this._ensureInputController()
        } catch (error) {
            this._stopPointerPlaybackSink()
            this._stopFromError(error)
            return
        }

        const serial = ++this._playbackSerial
        this._playbackPressedKeys.clear()
        this._playbackPressedButtons.clear()
        this._status = STATUS.PLAYING
        this._lastError = ''
        this._syncUi()

        try {
            while (!this._destroyed && serial === this._playbackSerial) {
                if (firstPointerEvent) {
                    await this._movePointerToRecordedPosition(
                        firstPointerEvent.x,
                        firstPointerEvent.y)
                }

                for (const macroEvent of macroEvents) {
                    if (this._destroyed || serial !== this._playbackSerial)
                        return

                    await waitMs(macroEvent.delay)

                    if (this._destroyed || serial !== this._playbackSerial)
                        return

                    await this._playMacroEvent(macroEvent)
                }

                if (this._destroyed || serial !== this._playbackSerial)
                    return

                if (!this._loopPlaybackEnabled)
                    break

                await this._releasePlaybackInputs(false)
            }

            if (this._destroyed || serial !== this._playbackSerial)
                return

            await this._releasePlaybackInputs()

            this._status = STATUS.IDLE
            this._syncUi()
        } catch (error) {
            if (this._destroyed || serial !== this._playbackSerial)
                return

            this._stopFromError(error)
        }
    }

    async _movePointerToRecordedPosition(targetX, targetY) {
        const inputController = this._inputController
        const maxX = Math.max(0, global.stage.width - 1)
        const maxY = Math.max(0, global.stage.height - 1)
        const clampedTargetX = clamp(Math.round(targetX), 0, maxX)
        const clampedTargetY = clamp(Math.round(targetY), 0, maxY)

        let [currentX, currentY] = global.get_pointer()

        for (let attempt = 0; attempt < POINTER_MAX_CORRECTION_ATTEMPTS; attempt++) {
            const dx = clampedTargetX - currentX
            const dy = clampedTargetY - currentY

            if (Math.abs(dx) <= POINTER_TARGET_TOLERANCE &&
                Math.abs(dy) <= POINTER_TARGET_TOLERANCE)
                return

            await inputController.movePointer(
                clamp(dx, -POINTER_MAX_STEP, POINTER_MAX_STEP),
                clamp(dy, -POINTER_MAX_STEP, POINTER_MAX_STEP))

            ;[currentX, currentY] = await this._waitForPointerSettle(currentX, currentY)
        }
    }

    async _waitForPointerSettle(previousX, previousY) {
        for (let poll = 0; poll < POINTER_SETTLE_POLL_COUNT; poll++) {
            await waitMs(POINTER_SETTLE_DELAY_MS)

            const [currentX, currentY] = global.get_pointer()
            if (Math.round(currentX) !== Math.round(previousX) ||
                Math.round(currentY) !== Math.round(previousY))
                return [currentX, currentY]
        }

        return global.get_pointer()
    }

    async _playMacroEvent(macroEvent) {
        const inputController = this._inputController

        switch (macroEvent.type) {
        case 'motion':
            if (Number.isFinite(macroEvent.dx) &&
                Number.isFinite(macroEvent.dy) &&
                (macroEvent.dx !== 0 || macroEvent.dy !== 0)) {
                await inputController.movePointer(macroEvent.dx, macroEvent.dy)
                return
            }

            if (!Number.isFinite(macroEvent.x) || !Number.isFinite(macroEvent.y)) {
                if (Number.isFinite(macroEvent.dx) && Number.isFinite(macroEvent.dy)) {
                    await inputController.movePointer(macroEvent.dx, macroEvent.dy)
                    return
                }

                throw new Error(_('Recorded pointer event has no usable position or delta.'))
            }

            await this._movePointerToRecordedPosition(macroEvent.x, macroEvent.y)
            return
        case 'button':
            if (macroEvent.state === BUTTON_PRESSED) {
                if (this._playbackPressedButtons.has(macroEvent.buttonCode))
                    return

                this._playbackPressedButtons.add(macroEvent.buttonCode)
            } else if (!this._playbackPressedButtons.delete(macroEvent.buttonCode)) {
                return
            }

            await inputController.notifyPointerButton(macroEvent.buttonCode, macroEvent.state)
            return
        case 'key':
            if (macroEvent.keycode > 0) {
                if (macroEvent.state === KEY_PRESSED) {
                    if (this._playbackPressedKeys.has(macroEvent.keycode))
                        return

                    this._playbackPressedKeys.add(macroEvent.keycode)
                } else if (!this._playbackPressedKeys.delete(macroEvent.keycode)) {
                    return
                }

                await inputController.notifyKeyboardKeycode(macroEvent.keycode, macroEvent.state)
                return
            }

            throw new Error(_('Recorded key event has no usable keycode.'))
        default:
            throw new Error(_('Unknown macro event type.'))
        }
    }

    async _releasePlaybackInputs(stopPointerPlaybackSink = true) {
        const inputController = this._inputController
        const pointerPlaybackSink = this._pointerPlaybackSink

        try {
            if (pointerPlaybackSink) {
                for (const buttonCode of Array.from(this._playbackPressedButtons).reverse())
                    await pointerPlaybackSink.notifyPointerButton(buttonCode, BUTTON_RELEASED)
            }

            for (const keycode of Array.from(this._playbackPressedKeys).reverse())
                await inputController.notifyKeyboardKeycode(keycode, KEY_RELEASED)
        } catch (error) {
            logError(error, `${UUID}: failed to release playback inputs`)
        } finally {
            this._playbackPressedButtons.clear()
            this._playbackPressedKeys.clear()
            if (stopPointerPlaybackSink)
                this._stopPointerPlaybackSink()
        }
    }

    _stopFromError(error) {
        this._playbackSerial++
        this._stopRecordingSource()
        void this._releasePlaybackInputs()
        this._recordedPressedKeys.clear()
        this._recordedPressedButtons.clear()
        this._resetRecordedPointerSample()
        this._status = STATUS.ERROR
        this._lastError = describeError(error)
        this._syncUi()

        Main.notifyError(_('Macro recorder error'), this._lastError)
    }

    _statusText() {
        switch (this._status) {
        case STATUS.RECORDING:
            return `${_('Recording')} - ${formatEventCount(this._macroEvents.length)}`
        case STATUS.PLAYING:
            return `${
                this._loopPlaybackEnabled ? _('Looping playback') : _('Playing back')
            } - ${formatEventCount(this._macroEvents.length)}`
        case STATUS.ERROR:
            return this._lastError
        case STATUS.IDLE:
        default:
            if (this._macroEvents.length === 0)
                return _('Press F4 to record your first macro.')

            if (this._loopPlaybackEnabled)
                return _('Ready to replay the last recorded macro in a loop.')

            return _('Ready to replay the last recorded macro.')
        }
    }

    _syncUi() {
        const recordShortcut = formatShortcut(this._settings, KEY_RECORD_SHORTCUT)
        const playbackShortcut = formatShortcut(this._settings, KEY_PLAYBACK_SHORTCUT)

        this._statusDescription.text = this._statusText()
        this._macroInfoLabel.text = this._macroEvents.length > 0
            ? `${_('Last macro')}: ${formatEventCount(this._macroEvents.length)}`
            : _('Last macro: none recorded yet')
        this._shortcutInfoLabel.text =
            `${recordShortcut} ${_('starts or stops recording')}. ` +
            `${playbackShortcut} ${_('starts or stops playback')}.`
        this._captureInfoLabel.text =
            _('Red dot means recording. Blue dot means playback.')

        this.remove_style_class_name('macro-recording')
        this.remove_style_class_name('macro-playing')

        if (this._status === STATUS.RECORDING)
            this.add_style_class_name('macro-recording')
        else if (this._status === STATUS.PLAYING)
            this.add_style_class_name('macro-playing')
    }

    destroy() {
        this._destroyed = true
        this._playbackSerial++
        this._stopRecordingSource()
        void this._releasePlaybackInputs()
        Main.wm.removeKeybinding(KEY_RECORD_SHORTCUT)
        Main.wm.removeKeybinding(KEY_PLAYBACK_SHORTCUT)
        this._settings.disconnectObject(this)
        this._inputController.destroy()
        super.destroy()
    }
})

export default class WaylandMacroRecorderExtension extends Extension {
    enable() {
        this._indicator = new MacroIndicator(this)
        Main.panel.addToStatusArea('wayland-macro-recorder', this._indicator)
    }

    disable() {
        if (!this._indicator)
            return

        this._indicator.destroy()
        this._indicator = null
    }
}
