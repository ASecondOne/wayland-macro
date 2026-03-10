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

const EVDEV_KEY_F4 = 62
const EVDEV_KEY_F5 = 63

const KEY_RELEASED = 0
const KEY_PRESSED = 1
const BUTTON_RELEASED = 0
const BUTTON_PRESSED = 1

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

class RecordingGrab {
    constructor(inputController, callbacks) {
        this._inputController = inputController
        this._callbacks = callbacks
        this._grab = null
        this._regrabId = 0
        this._lastPointerX = null
        this._lastPointerY = null
        this._stopOnF4Release = false

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

        this._actor.grab_key_focus()

        const [pointerX, pointerY] = global.get_pointer()
        this._lastPointerX = pointerX
        this._lastPointerY = pointerY
    }

    stop() {
        this._stopOnF4Release = false
        this._removePendingRegrab()
        this._dismissGrab()

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
        const keycode = event.get_key_code()
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
        const payload = {
            type: 'button',
            buttonCode: toEvdevButtonCode(event.get_button()),
            state: event.type() === Clutter.EventType.BUTTON_PRESS
                ? BUTTON_PRESSED
                : BUTTON_RELEASED,
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
        const dx = this._lastPointerX === null ? 0 : pointerX - this._lastPointerX
        const dy = this._lastPointerY === null ? 0 : pointerY - this._lastPointerY

        this._lastPointerX = pointerX
        this._lastPointerY = pointerY

        if (dx === 0 && dy === 0)
            return Clutter.EVENT_STOP

        const payload = {
            type: 'motion',
            dx,
            dy,
        }

        if (this._callbacks.onRecordedEvent)
            this._callbacks.onRecordedEvent(payload)

        void this._inputController.movePointer(dx, dy)
            .catch(error => this._callbacks.onError?.(error))
        return Clutter.EVENT_STOP
    }
}

const MacroIndicator = GObject.registerClass(
class MacroIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Wayland Macro Recorder'))

        this._extension = extension
        this._settings = extension.getSettings()
        this._inputController = new MutterRemoteDesktopController(() => {
            if (this._status === STATUS.RECORDING || this._status === STATUS.PLAYING)
                this._stopFromError(new Error(_('GNOME closed the virtual input session.')))
        })
        this._recordingGrab = null

        this._status = STATUS.IDLE
        this._lastError = ''
        this._macroEvents = []
        this._lastRecordTimestampUsec = null
        this._playbackSerial = 0
        this._destroyed = false

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
            this)
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
            const inputController = await this._ensureInputController()

            this._stopRecordingGrab()
            this._macroEvents = []
            this._lastRecordTimestampUsec = null
            this._lastError = ''

            this._recordingGrab = new RecordingGrab(inputController, {
                onRecordedEvent: event => this._recordEvent(event),
                onStopRequested: () => this._stopRecording(),
                onError: error => this._stopFromError(error),
            })
            this._recordingGrab.start()

            this._status = STATUS.RECORDING
            this._syncUi()
        } catch (error) {
            this._stopFromError(error)
        }
    }

    _stopRecording() {
        const wasRecording = this._status === STATUS.RECORDING

        this._stopRecordingGrab()

        if (!wasRecording || this._destroyed)
            return

        this._status = STATUS.IDLE
        this._lastError = ''
        this._syncUi()
    }

    _stopRecordingGrab() {
        if (!this._recordingGrab)
            return

        this._recordingGrab.destroy()
        this._recordingGrab = null
    }

    _recordEvent(payload) {
        const eventTimestampUsec = GLib.get_monotonic_time()
        const delay = this._lastRecordTimestampUsec === null
            ? 0
            : Math.max(0, Math.round((eventTimestampUsec - this._lastRecordTimestampUsec) / 1000))
        const lastEvent = this._macroEvents[this._macroEvents.length - 1] ?? null

        if (payload.type === 'motion' && delay === 0 && lastEvent?.type === 'motion') {
            lastEvent.dx += payload.dx
            lastEvent.dy += payload.dy
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
        this._status = STATUS.IDLE
        this._lastError = ''
        this._syncUi()
    }

    async _startPlayback() {
        if (this._macroEvents.length === 0) {
            Main.notifyError(
                _('No macro recorded'),
                _('Press F4 to record a macro before starting playback.'))
            return
        }

        try {
            await this._ensureInputController()
        } catch (error) {
            this._stopFromError(error)
            return
        }

        const serial = ++this._playbackSerial
        this._status = STATUS.PLAYING
        this._lastError = ''
        this._syncUi()

        try {
            for (const macroEvent of this._macroEvents) {
                if (this._destroyed || serial !== this._playbackSerial)
                    return

                await waitMs(macroEvent.delay)

                if (this._destroyed || serial !== this._playbackSerial)
                    return

                await this._playMacroEvent(macroEvent)
            }

            if (this._destroyed || serial !== this._playbackSerial)
                return

            this._status = STATUS.IDLE
            this._syncUi()
        } catch (error) {
            if (this._destroyed || serial !== this._playbackSerial)
                return

            this._stopFromError(error)
        }
    }

    async _playMacroEvent(macroEvent) {
        const inputController = this._inputController

        switch (macroEvent.type) {
        case 'motion':
            await inputController.movePointer(macroEvent.dx, macroEvent.dy)
            return
        case 'button':
            await inputController.notifyPointerButton(macroEvent.buttonCode, macroEvent.state)
            return
        case 'key':
            if (macroEvent.keycode > 0) {
                await inputController.notifyKeyboardKeycode(macroEvent.keycode, macroEvent.state)
                return
            }

            throw new Error(_('Recorded key event has no usable keycode.'))
        default:
            throw new Error(_('Unknown macro event type.'))
        }
    }

    _stopFromError(error) {
        this._playbackSerial++
        this._stopRecordingGrab()
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
            return `${_('Playing back')} - ${formatEventCount(this._macroEvents.length)}`
        case STATUS.ERROR:
            return this._lastError
        case STATUS.IDLE:
        default:
            if (this._macroEvents.length === 0)
                return _('Press F4 to record your first macro.')

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
        this._stopRecordingGrab()
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
