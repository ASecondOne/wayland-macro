#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/input.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define INPUT_DIR "/dev/input"
#define MAX_DEVICES 64
#define MAX_PATH_LENGTH 4096

#define BITS_PER_LONG (sizeof(unsigned long) * 8)
#define NBITS(x) ((((x) + BITS_PER_LONG) / BITS_PER_LONG))
#define TEST_BIT(bit, array) (((array)[(bit) / BITS_PER_LONG] >> ((bit) % BITS_PER_LONG)) & 1UL)

typedef struct {
    int fd;
    bool records_keys;
    bool records_relative_pointer;
    bool records_absolute_pointer;
    int rel_dx;
    int rel_dy;
    int abs_x;
    int abs_y;
    int last_abs_x;
    int last_abs_y;
    bool abs_dirty;
    bool abs_has_last;
    char parent_path[MAX_PATH_LENGTH];
} Device;

typedef struct {
    int fd;
    bool records_keys;
    bool records_relative_pointer;
    bool records_absolute_pointer;
    bool has_pointer_buttons;
    char parent_path[MAX_PATH_LENGTH];
} DeviceCandidate;

static bool
has_event_type(int fd, unsigned int type) {
    unsigned long bits[NBITS(EV_MAX)] = {0};

    if (ioctl(fd, EVIOCGBIT(0, sizeof(bits)), bits) < 0)
        return false;

    return type < EV_MAX && TEST_BIT(type, bits);
}

static bool
has_code_bit(int fd, unsigned int type, unsigned int code, size_t max_code) {
    unsigned long bits[NBITS(KEY_MAX)] = {0};
    size_t nbits = NBITS(max_code);
    size_t nbytes = nbits * sizeof(unsigned long);

    if (nbytes > sizeof(bits))
        return false;

    if (ioctl(fd, EVIOCGBIT(type, nbytes), bits) < 0)
        return false;

    return code < max_code && TEST_BIT(code, bits);
}

static bool
is_keyboard_device(int fd) {
    if (!has_event_type(fd, EV_KEY))
        return false;

    return has_code_bit(fd, EV_KEY, KEY_A, KEY_MAX) ||
        has_code_bit(fd, EV_KEY, KEY_ENTER, KEY_MAX) ||
        has_code_bit(fd, EV_KEY, KEY_SPACE, KEY_MAX);
}

static bool
has_relative_pointer_motion(int fd) {
    if (!has_event_type(fd, EV_REL))
        return false;

    return has_code_bit(fd, EV_REL, REL_X, REL_MAX) ||
        has_code_bit(fd, EV_REL, REL_Y, REL_MAX);
}

static bool
has_absolute_pointer_motion(int fd) {
    if (!has_event_type(fd, EV_ABS))
        return false;

    return has_code_bit(fd, EV_ABS, ABS_X, ABS_MAX) &&
        has_code_bit(fd, EV_ABS, ABS_Y, ABS_MAX);
}

static bool
has_pointer_buttons(int fd) {
    if (!has_event_type(fd, EV_KEY))
        return false;

    return has_code_bit(fd, EV_KEY, BTN_LEFT, KEY_MAX) ||
        has_code_bit(fd, EV_KEY, BTN_RIGHT, KEY_MAX) ||
        has_code_bit(fd, EV_KEY, BTN_MIDDLE, KEY_MAX) ||
        has_code_bit(fd, EV_KEY, BTN_TOUCH, KEY_MAX);
}

static bool
is_pointer_button_code(unsigned int code) {
    switch (code) {
    case BTN_LEFT:
    case BTN_RIGHT:
    case BTN_MIDDLE:
    case BTN_SIDE:
    case BTN_EXTRA:
    case BTN_FORWARD:
    case BTN_BACK:
    case BTN_TASK:
        return true;
    default:
        return false;
    }
}

static bool
is_function_key(unsigned int code) {
    return code >= KEY_F1 && code <= KEY_F12;
}

static void
emit_key_event(unsigned int keycode, unsigned int state) {
    printf("{\"type\":\"key\",\"keycode\":%u,\"state\":%u}\n", keycode, state);
}

static void
emit_button_event(unsigned int button_code, unsigned int state) {
    printf("{\"type\":\"button\",\"buttonCode\":%u,\"state\":%u}\n", button_code, state);
}

static void
emit_motion_event(int dx, int dy) {
    printf("{\"type\":\"motion\",\"dx\":%d,\"dy\":%d}\n", dx, dy);
}

static void
flush_motion(Device *device) {
    if (device->records_relative_pointer && (device->rel_dx != 0 || device->rel_dy != 0)) {
        emit_motion_event(device->rel_dx, device->rel_dy);
        device->rel_dx = 0;
        device->rel_dy = 0;
    }

    if (device->records_absolute_pointer && device->abs_dirty) {
        if (device->abs_has_last) {
            int dx = device->abs_x - device->last_abs_x;
            int dy = device->abs_y - device->last_abs_y;

            if (dx != 0 || dy != 0)
                emit_motion_event(dx, dy);
        }

        device->last_abs_x = device->abs_x;
        device->last_abs_y = device->abs_y;
        device->abs_has_last = true;
        device->abs_dirty = false;
    }
}

static int
open_device(const char *path) {
    int fd = open(path, O_RDONLY | O_NONBLOCK);

    if (fd >= 0)
        fcntl(fd, F_SETFD, FD_CLOEXEC);

    return fd;
}

static void
read_parent_path(const char *event_name, char *buffer, size_t size) {
    char sysfs_path[MAX_PATH_LENGTH];
    ssize_t path_length;

    if (size == 0)
        return;

    snprintf(sysfs_path, sizeof(sysfs_path), "/sys/class/input/%s/device/device", event_name);
    path_length = readlink(sysfs_path, buffer, size - 1);
    if (path_length < 0) {
        buffer[0] = '\0';
        return;
    }

    buffer[path_length] = '\0';
}

static bool
parent_has_absolute_pointer_device(const DeviceCandidate *candidates,
                                   size_t                 candidate_count,
                                   const char            *parent_path) {
    if (parent_path[0] == '\0')
        return false;

    for (size_t i = 0; i < candidate_count; i++) {
        if (candidates[i].records_absolute_pointer &&
            strcmp(candidates[i].parent_path, parent_path) == 0)
            return true;
    }

    return false;
}

static size_t
load_devices(Device *devices, struct pollfd *pollfds) {
    DIR *dir;
    struct dirent *entry;
    DeviceCandidate candidates[MAX_DEVICES] = {0};
    size_t candidate_count = 0;
    size_t count = 0;

    dir = opendir(INPUT_DIR);
    if (!dir) {
        fprintf(stderr, "failed to open %s: %s\n", INPUT_DIR, strerror(errno));
        return 0;
    }

    while ((entry = readdir(dir)) != NULL) {
        char path[MAX_PATH_LENGTH];
        int fd;
        bool records_keys;
        bool records_relative_pointer;
        bool records_absolute_pointer;
        bool pointer_buttons;

        if (strncmp(entry->d_name, "event", 5) != 0)
            continue;

        if (candidate_count >= MAX_DEVICES)
            break;

        snprintf(path, sizeof(path), "%s/%s", INPUT_DIR, entry->d_name);
        fd = open_device(path);
        if (fd < 0)
            continue;

        records_keys = is_keyboard_device(fd);
        records_relative_pointer = has_relative_pointer_motion(fd);
        pointer_buttons = has_pointer_buttons(fd);
        records_absolute_pointer = has_absolute_pointer_motion(fd) && pointer_buttons;

        if (!records_keys && !records_relative_pointer && !records_absolute_pointer && !pointer_buttons) {
            close(fd);
            continue;
        }

        candidates[candidate_count] = (DeviceCandidate) {
            .fd = fd,
            .records_keys = records_keys,
            .records_relative_pointer = records_relative_pointer,
            .records_absolute_pointer = records_absolute_pointer,
            .has_pointer_buttons = pointer_buttons,
        };
        read_parent_path(entry->d_name,
                         candidates[candidate_count].parent_path,
                         sizeof(candidates[candidate_count].parent_path));
        candidate_count++;
    }

    for (size_t i = 0; i < candidate_count; i++) {
        bool skip_relative_duplicate =
            candidates[i].records_relative_pointer &&
            candidates[i].has_pointer_buttons &&
            !candidates[i].records_absolute_pointer &&
            parent_has_absolute_pointer_device(candidates,
                                               candidate_count,
                                               candidates[i].parent_path);

        if (skip_relative_duplicate) {
            close(candidates[i].fd);
            continue;
        }

        devices[count] = (Device) {
            .fd = candidates[i].fd,
            .records_keys = candidates[i].records_keys,
            .records_relative_pointer = candidates[i].records_relative_pointer,
            .records_absolute_pointer = candidates[i].records_absolute_pointer,
            .parent_path = {0},
        };
        strncpy(devices[count].parent_path,
                candidates[i].parent_path,
                sizeof(devices[count].parent_path) - 1);
        pollfds[count] = (struct pollfd) {
            .fd = candidates[i].fd,
            .events = POLLIN,
        };
        count++;
    }

    closedir(dir);
    return count;
}

static void
handle_event(Device *device, const struct input_event *event) {
    switch (event->type) {
    case EV_KEY:
        if (device->records_keys &&
            event->code < BTN_MISC &&
            (event->value == 0 || event->value == 1)) {
            emit_key_event(event->code, (unsigned int) event->value);
            return;
        }

        if ((device->records_relative_pointer || device->records_absolute_pointer) &&
            is_pointer_button_code(event->code) &&
            (event->value == 0 || event->value == 1)) {
            emit_button_event(event->code, (unsigned int) event->value);
            return;
        }
        break;
    case EV_REL:
        if (!device->records_relative_pointer)
            return;

        if (event->code == REL_X)
            device->rel_dx += event->value;
        else if (event->code == REL_Y)
            device->rel_dy += event->value;
        break;
    case EV_ABS:
        if (!device->records_absolute_pointer)
            return;

        if (event->code == ABS_X) {
            device->abs_x = event->value;
            device->abs_dirty = true;
        } else if (event->code == ABS_Y) {
            device->abs_y = event->value;
            device->abs_dirty = true;
        }
        break;
    case EV_SYN:
        if (event->code == SYN_REPORT)
            flush_motion(device);
        break;
    default:
        break;
    }
}

int
main(void) {
    Device devices[MAX_DEVICES] = {0};
    struct pollfd pollfds[MAX_DEVICES] = {0};
    size_t device_count;
    char active_keyboard_parent[MAX_PATH_LENGTH] = {0};
    char active_pointer_parent[MAX_PATH_LENGTH] = {0};

    setvbuf(stdout, NULL, _IOLBF, 0);

    device_count = load_devices(devices, pollfds);
    if (device_count == 0) {
        fprintf(stderr, "no readable keyboard or pointer devices found\n");
        return 1;
    }

    while (true) {
        int ready = poll(pollfds, device_count, -1);

        if (ready < 0) {
            if (errno == EINTR)
                continue;

            fprintf(stderr, "poll failed: %s\n", strerror(errno));
            return 1;
        }

        for (size_t i = 0; i < device_count; i++) {
            struct input_event events[32];
            ssize_t bytes_read;

            if ((pollfds[i].revents & POLLIN) == 0)
                continue;

            while ((bytes_read = read(devices[i].fd, events, sizeof(events))) > 0) {
                size_t count = (size_t) bytes_read / sizeof(struct input_event);

                for (size_t j = 0; j < count; j++) {
                    struct input_event *event = &events[j];
                    bool is_keyboard_event =
                        event->type == EV_KEY &&
                        devices[i].records_keys &&
                        event->code < BTN_MISC;
                    bool is_pointer_button_event =
                        event->type == EV_KEY &&
                        (devices[i].records_relative_pointer || devices[i].records_absolute_pointer) &&
                        is_pointer_button_code(event->code);
                    bool is_pointer_motion_event =
                        (event->type == EV_REL && devices[i].records_relative_pointer) ||
                        (event->type == EV_ABS && devices[i].records_absolute_pointer) ||
                        event->type == EV_SYN;

                    if (is_keyboard_event) {
                        if (is_function_key(event->code))
                            continue;

                        if (active_keyboard_parent[0] == '\0')
                            strncpy(active_keyboard_parent,
                                    devices[i].parent_path,
                                    sizeof(active_keyboard_parent) - 1);

                        if (strcmp(active_keyboard_parent, devices[i].parent_path) != 0)
                            continue;
                    }

                    if (is_pointer_button_event || is_pointer_motion_event) {
                        if (active_pointer_parent[0] == '\0')
                            strncpy(active_pointer_parent,
                                    devices[i].parent_path,
                                    sizeof(active_pointer_parent) - 1);

                        if (strcmp(active_pointer_parent, devices[i].parent_path) != 0)
                            continue;
                    }

                    handle_event(&devices[i], event);
                }
            }

            if (bytes_read < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
                fprintf(stderr, "read failed on fd %d: %s\n", devices[i].fd, strerror(errno));
                return 1;
            }
        }
    }
}
