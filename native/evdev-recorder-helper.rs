use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::mem::{size_of, size_of_val};
use std::os::fd::{AsRawFd, RawFd};
use std::os::raw::{c_int, c_long, c_short, c_ulong};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::slice;

const INPUT_DIR: &str = "/dev/input";
const MAX_DEVICES: usize = 64;

const O_NONBLOCK: i32 = 0o0004000;
const O_CLOEXEC: i32 = 0o2000000;

const POLLIN: c_short = 0x0001;

const EV_SYN: u16 = 0x00;
const EV_KEY: u16 = 0x01;
const EV_REL: u16 = 0x02;
const EV_ABS: u16 = 0x03;
const EV_MAX: u16 = 0x1f;

const SYN_REPORT: u16 = 0;

const KEY_A: u16 = 30;
const KEY_ENTER: u16 = 28;
const KEY_SPACE: u16 = 57;
const KEY_F1: u16 = 59;
const KEY_F12: u16 = 88;
const KEY_MAX: usize = 0x2ff;

const BTN_MISC: u16 = 0x100;
const BTN_LEFT: u16 = 0x110;
const BTN_RIGHT: u16 = 0x111;
const BTN_MIDDLE: u16 = 0x112;
const BTN_SIDE: u16 = 0x113;
const BTN_EXTRA: u16 = 0x114;
const BTN_FORWARD: u16 = 0x115;
const BTN_BACK: u16 = 0x116;
const BTN_TASK: u16 = 0x117;
const BTN_TOUCH: u16 = 0x14a;

const REL_X: u16 = 0x00;
const REL_Y: u16 = 0x01;
const REL_MAX: usize = 0x0f;

const ABS_X: u16 = 0x00;
const ABS_Y: u16 = 0x01;
const ABS_MAX: usize = 0x3f;

const IOC_NRBITS: c_ulong = 8;
const IOC_TYPEBITS: c_ulong = 8;
const IOC_SIZEBITS: c_ulong = 14;
const IOC_NRSHIFT: c_ulong = 0;
const IOC_TYPESHIFT: c_ulong = IOC_NRSHIFT + IOC_NRBITS;
const IOC_SIZESHIFT: c_ulong = IOC_TYPESHIFT + IOC_TYPEBITS;
const IOC_DIRSHIFT: c_ulong = IOC_SIZESHIFT + IOC_SIZEBITS;
const IOC_READ: c_ulong = 2;

const BITS_PER_LONG: usize = size_of::<c_ulong>() * 8;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct TimeVal {
    tv_sec: c_long,
    tv_usec: c_long,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct InputEvent {
    time: TimeVal,
    type_: u16,
    code: u16,
    value: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PollFd {
    fd: c_int,
    events: c_short,
    revents: c_short,
}

struct Device {
    file: File,
    records_keys: bool,
    records_relative_pointer: bool,
    records_absolute_pointer: bool,
    rel_dx: i32,
    rel_dy: i32,
    abs_x: i32,
    abs_y: i32,
    last_abs_x: i32,
    last_abs_y: i32,
    abs_dirty: bool,
    abs_has_last: bool,
    parent_path: PathBuf,
}

struct DeviceCandidate {
    file: File,
    records_keys: bool,
    records_relative_pointer: bool,
    records_absolute_pointer: bool,
    has_pointer_buttons: bool,
    parent_path: PathBuf,
}

unsafe extern "C" {
    fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
    fn poll(fds: *mut PollFd, nfds: c_ulong, timeout: c_int) -> c_int;
}

const fn nbits(x: usize) -> usize {
    (x + BITS_PER_LONG) / BITS_PER_LONG
}

const fn ioc(dir: c_ulong, ty: c_ulong, nr: c_ulong, size: c_ulong) -> c_ulong {
    (dir << IOC_DIRSHIFT) | (ty << IOC_TYPESHIFT) | (nr << IOC_NRSHIFT) | (size << IOC_SIZESHIFT)
}

const fn eviocgbit(ev: c_ulong, len: usize) -> c_ulong {
    ioc(IOC_READ, b'E' as c_ulong, 0x20 + ev, len as c_ulong)
}

fn test_bit(bit: usize, array: &[c_ulong]) -> bool {
    ((array[bit / BITS_PER_LONG] >> (bit % BITS_PER_LONG)) & 1) != 0
}

fn ioctl_get_bits(fd: RawFd, event_type: u16, bits: &mut [c_ulong], nbytes: usize) -> bool {
    let request = eviocgbit(event_type as c_ulong, nbytes);
    let result = unsafe { ioctl(fd, request, bits.as_mut_ptr() as *mut c_void) };
    result >= 0
}

fn has_event_type(fd: RawFd, event_type: u16) -> bool {
    let mut bits = vec![0 as c_ulong; nbits(EV_MAX as usize)];
    let nbytes = bits.len() * size_of::<c_ulong>();

    if !ioctl_get_bits(fd, 0, &mut bits, nbytes) {
        return false;
    }

    event_type < EV_MAX && test_bit(event_type as usize, &bits)
}

fn has_code_bit(fd: RawFd, event_type: u16, code: u16, max_code: usize) -> bool {
    let mut bits = vec![0 as c_ulong; nbits(KEY_MAX)];
    let nbytes = nbits(max_code) * size_of::<c_ulong>();

    if nbytes > bits.len() * size_of::<c_ulong>() {
        return false;
    }

    if !ioctl_get_bits(fd, event_type, &mut bits, nbytes) {
        return false;
    }

    (code as usize) < max_code && test_bit(code as usize, &bits)
}

fn is_keyboard_device(fd: RawFd) -> bool {
    if !has_event_type(fd, EV_KEY) {
        return false;
    }

    has_code_bit(fd, EV_KEY, KEY_A, KEY_MAX)
        || has_code_bit(fd, EV_KEY, KEY_ENTER, KEY_MAX)
        || has_code_bit(fd, EV_KEY, KEY_SPACE, KEY_MAX)
}

fn has_relative_pointer_motion(fd: RawFd) -> bool {
    if !has_event_type(fd, EV_REL) {
        return false;
    }

    has_code_bit(fd, EV_REL, REL_X, REL_MAX) || has_code_bit(fd, EV_REL, REL_Y, REL_MAX)
}

fn has_absolute_pointer_motion(fd: RawFd) -> bool {
    if !has_event_type(fd, EV_ABS) {
        return false;
    }

    has_code_bit(fd, EV_ABS, ABS_X, ABS_MAX) && has_code_bit(fd, EV_ABS, ABS_Y, ABS_MAX)
}

fn has_pointer_buttons(fd: RawFd) -> bool {
    if !has_event_type(fd, EV_KEY) {
        return false;
    }

    has_code_bit(fd, EV_KEY, BTN_LEFT, KEY_MAX)
        || has_code_bit(fd, EV_KEY, BTN_RIGHT, KEY_MAX)
        || has_code_bit(fd, EV_KEY, BTN_MIDDLE, KEY_MAX)
        || has_code_bit(fd, EV_KEY, BTN_TOUCH, KEY_MAX)
}

fn is_pointer_button_code(code: u16) -> bool {
    matches!(
        code,
        BTN_LEFT
            | BTN_RIGHT
            | BTN_MIDDLE
            | BTN_SIDE
            | BTN_EXTRA
            | BTN_FORWARD
            | BTN_BACK
            | BTN_TASK
    )
}

fn is_function_key(code: u16) -> bool {
    (KEY_F1..=KEY_F12).contains(&code)
}

fn emit_key_event(output: &mut impl Write, keycode: u16, state: u32) -> io::Result<()> {
    writeln!(
        output,
        "{{\"type\":\"key\",\"keycode\":{keycode},\"state\":{state}}}"
    )?;
    output.flush()
}

fn emit_button_event(output: &mut impl Write, button_code: u16, state: u32) -> io::Result<()> {
    writeln!(
        output,
        "{{\"type\":\"button\",\"buttonCode\":{button_code},\"state\":{state}}}"
    )?;
    output.flush()
}

fn emit_motion_event(output: &mut impl Write, dx: i32, dy: i32) -> io::Result<()> {
    writeln!(output, "{{\"type\":\"motion\",\"dx\":{dx},\"dy\":{dy}}}")?;
    output.flush()
}

fn flush_motion(device: &mut Device, output: &mut impl Write) -> io::Result<()> {
    if device.records_relative_pointer && (device.rel_dx != 0 || device.rel_dy != 0) {
        emit_motion_event(output, device.rel_dx, device.rel_dy)?;
        device.rel_dx = 0;
        device.rel_dy = 0;
    }

    if device.records_absolute_pointer && device.abs_dirty {
        if device.abs_has_last {
            let dx = device.abs_x - device.last_abs_x;
            let dy = device.abs_y - device.last_abs_y;

            if dx != 0 || dy != 0 {
                emit_motion_event(output, dx, dy)?;
            }
        }

        device.last_abs_x = device.abs_x;
        device.last_abs_y = device.abs_y;
        device.abs_has_last = true;
        device.abs_dirty = false;
    }

    Ok(())
}

fn open_device(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(O_NONBLOCK | O_CLOEXEC)
        .open(path)
}

fn read_parent_path(event_name: &str) -> PathBuf {
    let sysfs_path = Path::new("/sys/class/input")
        .join(event_name)
        .join("device/device");
    fs::read_link(sysfs_path).unwrap_or_else(|_| PathBuf::new())
}

fn parent_has_absolute_pointer_device(candidates: &[DeviceCandidate], parent_path: &Path) -> bool {
    if parent_path.as_os_str().is_empty() {
        return false;
    }

    candidates
        .iter()
        .any(|candidate| candidate.records_absolute_pointer && candidate.parent_path == parent_path)
}

fn load_devices() -> io::Result<(Vec<Device>, Vec<PollFd>)> {
    let mut candidates = Vec::with_capacity(MAX_DEVICES);

    for entry in fs::read_dir(INPUT_DIR)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        let event_name = entry.file_name();
        let event_name = event_name.to_string_lossy();
        if !event_name.starts_with("event") {
            continue;
        }

        if candidates.len() >= MAX_DEVICES {
            break;
        }

        let path = entry.path();
        let file = match open_device(&path) {
            Ok(file) => file,
            Err(_) => continue,
        };

        let fd = file.as_raw_fd();
        let records_keys = is_keyboard_device(fd);
        let records_relative_pointer = has_relative_pointer_motion(fd);
        let has_buttons = has_pointer_buttons(fd);
        let records_absolute_pointer = has_absolute_pointer_motion(fd) && has_buttons;

        if !records_keys && !records_relative_pointer && !records_absolute_pointer && !has_buttons {
            continue;
        }

        candidates.push(DeviceCandidate {
            file,
            records_keys,
            records_relative_pointer,
            records_absolute_pointer,
            has_pointer_buttons: has_buttons,
            parent_path: read_parent_path(&event_name),
        });
    }

    let mut devices = Vec::with_capacity(candidates.len());
    let mut pollfds = Vec::with_capacity(candidates.len());
    let skip_relative_duplicates: Vec<bool> = candidates
        .iter()
        .map(|candidate| {
            candidate.records_relative_pointer
                && candidate.has_pointer_buttons
                && !candidate.records_absolute_pointer
                && parent_has_absolute_pointer_device(&candidates, &candidate.parent_path)
        })
        .collect();

    for (candidate, skip_relative_duplicate) in candidates
        .into_iter()
        .zip(skip_relative_duplicates.into_iter())
    {
        if skip_relative_duplicate {
            continue;
        }

        let fd = candidate.file.as_raw_fd();
        pollfds.push(PollFd {
            fd,
            events: POLLIN,
            revents: 0,
        });
        devices.push(Device {
            file: candidate.file,
            records_keys: candidate.records_keys,
            records_relative_pointer: candidate.records_relative_pointer,
            records_absolute_pointer: candidate.records_absolute_pointer,
            rel_dx: 0,
            rel_dy: 0,
            abs_x: 0,
            abs_y: 0,
            last_abs_x: 0,
            last_abs_y: 0,
            abs_dirty: false,
            abs_has_last: false,
            parent_path: candidate.parent_path,
        });
    }

    Ok((devices, pollfds))
}

fn handle_event(
    device: &mut Device,
    event: &InputEvent,
    output: &mut impl Write,
) -> io::Result<()> {
    match event.type_ {
        EV_KEY => {
            if device.records_keys && event.code < BTN_MISC && matches!(event.value, 0 | 1) {
                emit_key_event(output, event.code, event.value as u32)?;
                return Ok(());
            }

            if (device.records_relative_pointer || device.records_absolute_pointer)
                && is_pointer_button_code(event.code)
                && matches!(event.value, 0 | 1)
            {
                emit_button_event(output, event.code, event.value as u32)?;
                return Ok(());
            }
        }
        EV_REL => {
            if !device.records_relative_pointer {
                return Ok(());
            }

            if event.code == REL_X {
                device.rel_dx += event.value;
            } else if event.code == REL_Y {
                device.rel_dy += event.value;
            }
        }
        EV_ABS => {
            if !device.records_absolute_pointer {
                return Ok(());
            }

            if event.code == ABS_X {
                device.abs_x = event.value;
                device.abs_dirty = true;
            } else if event.code == ABS_Y {
                device.abs_y = event.value;
                device.abs_dirty = true;
            }
        }
        EV_SYN => {
            if event.code == SYN_REPORT {
                flush_motion(device, output)?;
            }
        }
        _ => {}
    }

    Ok(())
}

fn is_would_block(error: &io::Error) -> bool {
    error.kind() == ErrorKind::WouldBlock
}

fn run() -> Result<(), String> {
    let stdout = io::stdout();
    let mut output = stdout.lock();

    let (mut devices, mut pollfds) =
        load_devices().map_err(|error| format!("failed to open {INPUT_DIR}: {error}"))?;

    if devices.is_empty() {
        return Err(String::from(
            "no readable keyboard or pointer devices found",
        ));
    }

    let mut active_keyboard_parent: Option<PathBuf> = None;
    let mut active_pointer_parent: Option<PathBuf> = None;

    loop {
        let ready = unsafe { poll(pollfds.as_mut_ptr(), pollfds.len() as c_ulong, -1) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == ErrorKind::Interrupted {
                continue;
            }

            return Err(format!("poll failed: {error}"));
        }

        for index in 0..devices.len() {
            if (pollfds[index].revents & POLLIN) == 0 {
                continue;
            }

            let mut events = [InputEvent::default(); 32];
            let mut last_error = None;

            loop {
                let bytes_read = {
                    let device = &mut devices[index];
                    let buffer = unsafe {
                        slice::from_raw_parts_mut(
                            events.as_mut_ptr().cast::<u8>(),
                            size_of_val(&events),
                        )
                    };

                    match device.file.read(buffer) {
                        Ok(bytes_read) => bytes_read,
                        Err(error) if is_would_block(&error) => break,
                        Err(error) => {
                            last_error = Some(format!(
                                "read failed on fd {}: {error}",
                                device.file.as_raw_fd()
                            ));
                            break;
                        }
                    }
                };

                if bytes_read == 0 {
                    break;
                }

                let count = bytes_read / size_of::<InputEvent>();

                for event in &events[..count] {
                    let is_keyboard_event = event.type_ == EV_KEY
                        && devices[index].records_keys
                        && event.code < BTN_MISC;
                    let is_pointer_button_event = event.type_ == EV_KEY
                        && (devices[index].records_relative_pointer
                            || devices[index].records_absolute_pointer)
                        && is_pointer_button_code(event.code);
                    let is_pointer_motion_event = (event.type_ == EV_REL
                        && devices[index].records_relative_pointer)
                        || (event.type_ == EV_ABS && devices[index].records_absolute_pointer)
                        || (event.type_ == EV_SYN
                            && (devices[index].records_relative_pointer
                                || devices[index].records_absolute_pointer));

                    if is_keyboard_event {
                        if is_function_key(event.code) {
                            continue;
                        }

                        if active_keyboard_parent.is_none() {
                            active_keyboard_parent = Some(devices[index].parent_path.clone());
                        }

                        if active_keyboard_parent.as_deref()
                            != Some(devices[index].parent_path.as_path())
                        {
                            continue;
                        }
                    }

                    if is_pointer_button_event || is_pointer_motion_event {
                        if active_pointer_parent.is_none() {
                            active_pointer_parent = Some(devices[index].parent_path.clone());
                        }

                        if active_pointer_parent.as_deref()
                            != Some(devices[index].parent_path.as_path())
                        {
                            continue;
                        }
                    }

                    handle_event(&mut devices[index], event, &mut output)
                        .map_err(|error| format!("failed to write recorder output: {error}"))?;
                }
            }

            if let Some(error) = last_error {
                return Err(error);
            }
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
