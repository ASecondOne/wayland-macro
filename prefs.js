import Adw from 'gi://Adw'
import GObject from 'gi://GObject'

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'

const KEY_RECORD_SHORTCUT = 'record-shortcut'
const KEY_PLAYBACK_SHORTCUT = 'playback-shortcut'

function formatShortcut(settings, key) {
    const shortcuts = settings.get_strv(key).filter(Boolean)
    return shortcuts.length > 0 ? shortcuts.join(', ') : _('Disabled')
}

const MacroRecorderPreferencesPage = GObject.registerClass(
class MacroRecorderPreferencesPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: _('Wayland Macro Recorder'),
            icon_name: 'input-keyboard-symbolic',
        })

        this._settings = settings

        const shortcutsGroup = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
        })
        this.add(shortcutsGroup)

        this._recordRow = new Adw.ActionRow({
            title: _('Record macro'),
            subtitle: formatShortcut(this._settings, KEY_RECORD_SHORTCUT),
        })
        shortcutsGroup.add(this._recordRow)

        this._playbackRow = new Adw.ActionRow({
            title: _('Play last macro'),
            subtitle: formatShortcut(this._settings, KEY_PLAYBACK_SHORTCUT),
        })
        shortcutsGroup.add(this._playbackRow)

        const notesGroup = new Adw.PreferencesGroup({
            title: _('Notes'),
        })
        this.add(notesGroup)

        notesGroup.add(new Adw.ActionRow({
            title: _('Recording scope'),
            subtitle: _('The extension records keyboard presses, mouse movement, and mouse button events globally while recording is active.'),
        }))

        notesGroup.add(new Adw.ActionRow({
            title: _('Playback access'),
            subtitle: _('The first recording or playback after enabling the extension may ask GNOME for keyboard and pointer access through the remote desktop portal.'),
        }))

        notesGroup.add(new Adw.ActionRow({
            title: _('Storage'),
            subtitle: _('Recorded macros are kept in memory only and are cleared when GNOME Shell reloads or the extension is disabled.'),
        }))

        notesGroup.add(new Adw.ActionRow({
            title: _('Recording backend'),
            subtitle: _('Recording uses a small local evdev helper, so apps keep receiving your real input while the macro is captured.'),
        }))

        this._settings.connectObject(
            `changed::${KEY_RECORD_SHORTCUT}`,
            () => this._syncShortcuts(),
            `changed::${KEY_PLAYBACK_SHORTCUT}`,
            () => this._syncShortcuts(),
            this)
    }

    _syncShortcuts() {
        this._recordRow.subtitle = formatShortcut(this._settings, KEY_RECORD_SHORTCUT)
        this._playbackRow.subtitle = formatShortcut(this._settings, KEY_PLAYBACK_SHORTCUT)
    }
})

export default class WaylandMacroRecorderPreferences extends ExtensionPreferences {
    getPreferencesWidget() {
        return new MacroRecorderPreferencesPage(this.getSettings())
    }
}
