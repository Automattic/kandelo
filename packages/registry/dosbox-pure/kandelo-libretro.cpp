// Minimal libretro frontend for running DOSBox Pure as a Kandelo process.
// Video, audio, keyboard, mouse, storage, and timing all use Kandelo's normal
// POSIX/device path; no browser-specific emulator code is involved.

#include "libretro-common/include/libretro.h"

#include <algorithm>
#include <cerrno>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/kd.h>
#include <linux/input.h>
#include <map>
#include <string>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <vector>

extern "C" {
void retro_set_environment(retro_environment_t);
void retro_set_video_refresh(retro_video_refresh_t);
void retro_set_audio_sample(retro_audio_sample_t);
void retro_set_audio_sample_batch(retro_audio_sample_batch_t);
void retro_set_input_poll(retro_input_poll_t);
void retro_set_input_state(retro_input_state_t);
void retro_init(void);
void retro_deinit(void);
bool retro_load_game(const retro_game_info *);
void retro_unload_game(void);
void retro_get_system_av_info(retro_system_av_info *);
void retro_get_system_info(retro_system_info *);
void retro_run(void);
}

namespace {
constexpr unsigned kFbWidth = 640;
constexpr unsigned kFbHeight = 400;
constexpr unsigned long kDspReset = 0x00005000u;
constexpr unsigned long kDspSpeed = 0xc0045002u;
constexpr unsigned long kDspStereo = 0xc0045003u;
constexpr unsigned long kDspSetFormat = 0xc0045005u;
constexpr unsigned long kDspSetFragment = 0xc004500au;
constexpr int kAudioS16Le = 0x10;
constexpr unsigned kAudioLeadMs = 64;

int fb_fd = -1;
uint32_t *fb_pixels = nullptr;
size_t fb_bytes = 0;
int dsp_fd = -1;
int audio_sample_rate = 48000;
bool audio_primed = false;
void close_audio() {
  if (dsp_fd < 0) return;
  // Quit cancels queued sound. A normal OSS close drains it, which cannot
  // finish while the browser's audio clock is suspended.
  if (ioctl(dsp_fd, kDspReset, 0) < 0)
    perror("dosbox-pure: reset audio");
  close(dsp_fd);
  dsp_fd = -1;
}
int mouse_fd = -1;
int mouse_dx = 0;
int mouse_dy = 0;
unsigned mouse_buttons = 0;
volatile sig_atomic_t shutdown_requested = 0;
void request_shutdown(int) { shutdown_requested = 1; }
int keyboard_fd = STDIN_FILENO;
bool keyboard_evdev = false;
termios saved_stdin_termios{};
termios raw_stdin_termios{};
bool have_saved_stdin_termios = false;
int saved_stdin_flags = -1;
double target_fps = 60.0;
double display_aspect = 4.0 / 3.0;
bool keypad_arrows = false;
retro_keyboard_event_t keyboard_event = nullptr;
bool keyboard_down[RETROK_LAST]{};
bool quit_chord = false;
std::map<std::string, std::string> options;
std::string system_dir;
std::string save_dir;
const char *content_dir = "/";

void log_message(enum retro_log_level level, const char *format, ...) {
  FILE *stream =
      level == RETRO_LOG_ERROR || level == RETRO_LOG_WARN ? stderr : stdout;
  va_list ap;
  va_start(ap, format);
  vfprintf(stream, format, ap);
  va_end(ap);
}

void remember_v2_options(const retro_core_options_v2 *core_options) {
  if (!core_options || !core_options->definitions)
    return;
  for (const retro_core_option_v2_definition *def = core_options->definitions;
       def->key; ++def) {
    if (def->default_value)
      options[def->key] = def->default_value;
  }
}

bool environment(unsigned command, void *data) {
  switch (command) {
  case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
  case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
  case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
  case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
  case RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS:
  case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
  case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
  case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK:
  case RETRO_ENVIRONMENT_SET_MINIMUM_AUDIO_LATENCY:
  case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    return true;
  case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
    return data && *static_cast<retro_pixel_format *>(data) ==
                       RETRO_PIXEL_FORMAT_XRGB8888;
  case RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK:
    keyboard_event = static_cast<retro_keyboard_callback *>(data)->callback;
    return true;
  case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
    remember_v2_options(static_cast<const retro_core_options_v2 *>(data));
    return true;
  case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL: {
    const auto *intl = static_cast<const retro_core_options_v2_intl *>(data);
    remember_v2_options(intl ? intl->us : nullptr);
    return true;
  }
  case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
    *static_cast<unsigned *>(data) = 2;
    return true;
  case RETRO_ENVIRONMENT_GET_VARIABLE: {
    auto *var = static_cast<retro_variable *>(data);
    const auto found = options.find(var->key ? var->key : "");
    var->value = found == options.end() ? nullptr : found->second.c_str();
    return var->value != nullptr;
  }
  case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
    *static_cast<bool *>(data) = false;
    return true;
  case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
    *static_cast<const char **>(data) = system_dir.c_str();
    return true;
  case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
    *static_cast<const char **>(data) = save_dir.c_str();
    return true;
  case RETRO_ENVIRONMENT_GET_CONTENT_DIRECTORY:
    *static_cast<const char **>(data) = content_dir;
    return true;
  case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
    static_cast<retro_log_callback *>(data)->log = log_message;
    return true;
  case RETRO_ENVIRONMENT_GET_LANGUAGE:
    *static_cast<unsigned *>(data) = RETRO_LANGUAGE_ENGLISH;
    return true;
  case RETRO_ENVIRONMENT_GET_CAN_DUPE:
    *static_cast<bool *>(data) = true;
    return true;
  case RETRO_ENVIRONMENT_GET_INPUT_DEVICE_CAPABILITIES:
    *static_cast<uint64_t *>(data) = (UINT64_C(1) << RETRO_DEVICE_KEYBOARD) |
                                     (UINT64_C(1) << RETRO_DEVICE_MOUSE);
    return true;
  case RETRO_ENVIRONMENT_GET_INPUT_MAX_USERS:
    *static_cast<unsigned *>(data) = 1;
    return true;
  case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE:
    *static_cast<int *>(data) = 3;
    return true;
  case RETRO_ENVIRONMENT_GET_FASTFORWARDING:
    *static_cast<bool *>(data) = false;
    return true;
  case RETRO_ENVIRONMENT_GET_THROTTLE_STATE: {
    auto *state = static_cast<retro_throttle_state *>(data);
    state->mode = RETRO_THROTTLE_VSYNC;
    state->rate = static_cast<float>(target_fps);
    return true;
  }
  case RETRO_ENVIRONMENT_GET_JIT_CAPABLE:
    *static_cast<bool *>(data) = false;
    return true;
  case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
    const auto *av = static_cast<const retro_system_av_info *>(data);
    if (av && av->timing.fps > 1.0)
      target_fps = av->timing.fps;
    if (av && av->geometry.aspect_ratio > 0)
      display_aspect = av->geometry.aspect_ratio;
    return true;
  }
  case RETRO_ENVIRONMENT_SET_GEOMETRY: {
    const auto *geometry = static_cast<const retro_game_geometry *>(data);
    if (geometry && geometry->aspect_ratio > 0)
      display_aspect = geometry->aspect_ratio;
    return true;
  }
  case RETRO_ENVIRONMENT_SHUTDOWN:
    shutdown_requested = 1;
    return true;
  default:
    return false;
  }
}

void video_refresh(const void *data, unsigned width, unsigned height,
                   size_t pitch) {
  if (!data || !fb_pixels || !width || !height)
    return;
  const auto *source = static_cast<const uint8_t *>(data);
  // Compose away from the shared framebuffer. The browser scans the mapped
  // region independently; clearing and scaling in place exposes partial black
  // frames and row-by-row updates as visible flicker.
  static std::vector<uint32_t> composed(kFbWidth * kFbHeight);
  std::fill(composed.begin(), composed.end(), UINT32_C(0xff000000));

  const unsigned out_width = std::clamp(
      static_cast<unsigned>(kFbHeight * display_aspect), 1u, kFbWidth);
  const unsigned out_height = std::clamp(
      static_cast<unsigned>(out_width / display_aspect), 1u, kFbHeight);
  const unsigned x_offset = (kFbWidth - out_width) / 2;
  const unsigned y_offset = (kFbHeight - out_height) / 2;

  for (unsigned y = 0; y < out_height; ++y) {
    const unsigned source_y =
        static_cast<unsigned>((static_cast<uint64_t>(y) * height) / out_height);
    const auto *row =
        reinterpret_cast<const uint32_t *>(source + source_y * pitch);
    auto *dest = composed.data() + (y + y_offset) * kFbWidth + x_offset;
    for (unsigned x = 0; x < out_width; ++x) {
      const unsigned source_x =
          static_cast<unsigned>((static_cast<uint64_t>(x) * width) / out_width);
      dest[x] = row[source_x] | UINT32_C(0xff000000);
    }
  }
  memcpy(fb_pixels, composed.data(), composed.size() * sizeof(composed[0]));
}

size_t write_audio(const int16_t *data, size_t frames) {
  if (dsp_fd < 0 || !data)
    return frames;
  // Nonblocking output must not stall the emulator while audio is suspended.
  // If a write ends inside a stereo frame, finish that frame before sending
  // new samples; otherwise every following sample would change channels.
  static uint8_t carry[4];
  static size_t carry_offset = 0, carry_size = 0;
  while (carry_offset < carry_size) {
    const ssize_t n = write(dsp_fd, carry + carry_offset, carry_size - carry_offset);
    if (n > 0) carry_offset += static_cast<size_t>(n);
    else if (n < 0 && errno == EINTR) continue;
    else return frames;
  }
  carry_offset = carry_size = 0;
  const uint8_t *cursor = reinterpret_cast<const uint8_t *>(data);
  size_t remaining = frames * 2 * sizeof(int16_t);
  while (remaining) {
    const ssize_t written = write(dsp_fd, cursor, remaining);
    if (written > 0) {
      cursor += written;
      remaining -= static_cast<size_t>(written);
    } else if (written < 0 && errno == EINTR) {
      continue;
    } else {
      const size_t sent = frames * 4 - remaining;
      if (sent % 4) {
        carry_size = 4 - sent % 4;
        memcpy(carry, cursor, carry_size);
      }
      if (written < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
        perror("dosbox-pure: audio write");
        close_audio();
      }
      break;
    }
  }
  return frames;
}

size_t audio_batch(const int16_t *data, size_t frames) {
  if (dsp_fd >= 0 && data && frames && !audio_primed) {
    // A frame-paced producer needs a short lead over the independent audio
    // clock. Starting from an empty ring makes ordinary scheduling jitter
    // splice silence into even a continuous PC-speaker tone.
    audio_primed = true;
    const size_t lead_frames = static_cast<size_t>(audio_sample_rate) * kAudioLeadMs / 1000;
    const std::vector<int16_t> silence(lead_frames * 2, 0);
    write_audio(silence.data(), lead_frames);
  }
  return write_audio(data, frames);
}

constexpr unsigned kLinuxKeyToRetro[128] = {
      0,
      RETROK_ESCAPE,
      RETROK_1,
      RETROK_2,
      RETROK_3,
      RETROK_4,
      RETROK_5,
      RETROK_6,
      RETROK_7,
      RETROK_8,
      RETROK_9,
      RETROK_0,
      RETROK_MINUS,
      RETROK_EQUALS,
      RETROK_BACKSPACE,
      RETROK_TAB,
      RETROK_q,
      RETROK_w,
      RETROK_e,
      RETROK_r,
      RETROK_t,
      RETROK_y,
      RETROK_u,
      RETROK_i,
      RETROK_o,
      RETROK_p,
      RETROK_LEFTBRACKET,
      RETROK_RIGHTBRACKET,
      RETROK_RETURN,
      RETROK_LCTRL,
      RETROK_a,
      RETROK_s,
      RETROK_d,
      RETROK_f,
      RETROK_g,
      RETROK_h,
      RETROK_j,
      RETROK_k,
      RETROK_l,
      RETROK_SEMICOLON,
      RETROK_QUOTE,
      RETROK_BACKQUOTE,
      RETROK_LSHIFT,
      RETROK_BACKSLASH,
      RETROK_z,
      RETROK_x,
      RETROK_c,
      RETROK_v,
      RETROK_b,
      RETROK_n,
      RETROK_m,
      RETROK_COMMA,
      RETROK_PERIOD,
      RETROK_SLASH,
      RETROK_RSHIFT,
      RETROK_KP_MULTIPLY,
      RETROK_LALT,
      RETROK_SPACE,
      RETROK_CAPSLOCK,
      RETROK_F1,
      RETROK_F2,
      RETROK_F3,
      RETROK_F4,
      RETROK_F5,
      RETROK_F6,
      RETROK_F7,
      RETROK_F8,
      RETROK_F9,
      RETROK_F10,
      RETROK_NUMLOCK,
      RETROK_SCROLLOCK,
      RETROK_KP7,
      RETROK_KP8,
      RETROK_KP9,
      RETROK_KP_MINUS,
      RETROK_KP4,
      RETROK_KP5,
      RETROK_KP6,
      RETROK_KP_PLUS,
      RETROK_KP1,
      RETROK_KP2,
      RETROK_KP3,
      RETROK_KP0,
      RETROK_KP_PERIOD,
      0,
      0,
      RETROK_OEM_102,
      RETROK_F11,
      RETROK_F12,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // KEY_KPJPCOMMA (95) is reserved in the browser key map
      RETROK_KP_ENTER,
      RETROK_RCTRL,
      RETROK_KP_DIVIDE,
      RETROK_PRINT,
      RETROK_RALT,
      0,
      RETROK_HOME,
      RETROK_UP,
      RETROK_PAGEUP,
      RETROK_LEFT,
      RETROK_RIGHT,
      RETROK_END,
      RETROK_DOWN,
      RETROK_PAGEDOWN,
      RETROK_INSERT,
      RETROK_DELETE,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      RETROK_PAUSE,
};

static_assert(kLinuxKeyToRetro[28] == RETROK_RETURN);
static_assert(kLinuxKeyToRetro[29] == RETROK_LCTRL);
static_assert(kLinuxKeyToRetro[96] == RETROK_KP_ENTER);
static_assert(kLinuxKeyToRetro[103] == RETROK_UP);
static_assert(kLinuxKeyToRetro[105] == RETROK_LEFT);
static_assert(kLinuxKeyToRetro[106] == RETROK_RIGHT);
static_assert(kLinuxKeyToRetro[108] == RETROK_DOWN);

unsigned linux_key_to_retro(unsigned key) {
  // Optional compatibility setting for games that expect keypad scan codes.
  constexpr unsigned keypad[] = {RETROK_KP7, RETROK_KP8, RETROK_KP9,
      RETROK_KP4, RETROK_KP6, RETROK_KP1, RETROK_KP2, RETROK_KP3,
      RETROK_KP0, RETROK_KP_PERIOD};
  if (keypad_arrows && key >= 102 && key <= 111)
    return keypad[key - 102];
  return key < 128 ? kLinuxKeyToRetro[key] : 0;
}

void key_event(unsigned key, bool down) {
  const unsigned retro_key = linux_key_to_retro(key);
  if (!retro_key || !keyboard_event) return;
  keyboard_down[retro_key] = down;
  if (down && retro_key == RETROK_F12 &&
      (keyboard_down[RETROK_LCTRL] || keyboard_down[RETROK_RCTRL]) &&
      (keyboard_down[RETROK_LSHIFT] || keyboard_down[RETROK_RSHIFT])) {
    // Keep consuming the shortcut's releases before handing the PTY back to
    // the shell. Otherwise MEDIUMRAW key-up bytes become terminal input.
    quit_chord = true;
    return;
  }
  if (quit_chord) {
    if (!keyboard_down[RETROK_F12] &&
        !keyboard_down[RETROK_LCTRL] && !keyboard_down[RETROK_RCTRL] &&
        !keyboard_down[RETROK_LSHIFT] && !keyboard_down[RETROK_RSHIFT])
      shutdown_requested = 1;
    return;
  }
  keyboard_event(down, retro_key, 0, 0);
}

void input_poll() {
  mouse_dx = mouse_dy = 0;
  if (mouse_fd >= 0) {
    uint8_t packet[3];
    while (read(mouse_fd, packet, sizeof packet) == sizeof packet) {
      mouse_buttons = packet[0] & 7;
      mouse_dx += static_cast<int8_t>(packet[1]);
      mouse_dy -= static_cast<int8_t>(packet[2]);
    }
  }
  if (keyboard_evdev) {
    input_event events[16];
    ssize_t count;
    while ((count = read(keyboard_fd, events, sizeof events)) > 0) {
      for (size_t i = 0; i < static_cast<size_t>(count) / sizeof(input_event); ++i)
        if (events[i].type == EV_KEY && events[i].value != 2)
          key_event(events[i].code, events[i].value != 0);
    }
  } else {
    uint8_t byte;
    while (read(keyboard_fd, &byte, 1) == 1)
      key_event(byte & 0x7f, !(byte & 0x80));
  }
}

int16_t input_state(unsigned port, unsigned device, unsigned index,
                    unsigned id) {
  if (port != 0)
    return 0;
  if (device == RETRO_DEVICE_KEYBOARD)
    return id < RETROK_LAST && keyboard_down[id] ? 1 : 0;
  if (device != RETRO_DEVICE_MOUSE)
    return 0;
  switch (id) {
  case RETRO_DEVICE_ID_MOUSE_X:
    return static_cast<int16_t>(std::clamp(mouse_dx, -32768, 32767));
  case RETRO_DEVICE_ID_MOUSE_Y:
    return static_cast<int16_t>(std::clamp(mouse_dy, -32768, 32767));
  case RETRO_DEVICE_ID_MOUSE_LEFT:
    return mouse_buttons & 1;
  case RETRO_DEVICE_ID_MOUSE_RIGHT:
    return mouse_buttons & 2;
  case RETRO_DEVICE_ID_MOUSE_MIDDLE:
    return mouse_buttons & 4;
  default:
    return 0;
  }
}

bool open_devices() {
  fb_fd = open("/dev/fb0", O_RDWR);
  if (fb_fd < 0) {
    perror("dosbox-pure: open /dev/fb0");
    return false;
  }
  fb_fix_screeninfo fix{};
  fb_var_screeninfo var{};
  if (ioctl(fb_fd, FBIOGET_FSCREENINFO, &fix) < 0 ||
      ioctl(fb_fd, FBIOGET_VSCREENINFO, &var) < 0) {
    perror("dosbox-pure: framebuffer info");
    return false;
  }
  if (var.xres != kFbWidth || var.yres != kFbHeight ||
      var.bits_per_pixel != 32) {
    fprintf(stderr, "dosbox-pure: unsupported framebuffer %ux%u@%u\n", var.xres,
            var.yres, var.bits_per_pixel);
    return false;
  }
  fb_bytes = fix.smem_len;
  fb_pixels = static_cast<uint32_t *>(
      mmap(nullptr, fb_bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fb_fd, 0));
  if (fb_pixels == MAP_FAILED) {
    fb_pixels = nullptr;
    perror("dosbox-pure: mmap /dev/fb0");
    return false;
  }

  // Browsers can suspend AudioContext until a user gesture. Do not let a full
  // audio ring stall video and input while the host is waiting for that
  // gesture.
  dsp_fd = open("/dev/dsp", O_WRONLY | O_NONBLOCK);
  if (dsp_fd >= 0) {
    int rate = 48000;
    int stereo = 1;
    int format = kAudioS16Le;
    // The default OSS ring is only 21 ms at 48 kHz stereo. Reserve enough
    // space for the startup lead and catch-up batches without truncating PCM.
    int fragments = (8 << 16) | 12; // eight 4 KiB fragments, about 171 ms
    if (ioctl(dsp_fd, kDspSpeed, &rate) < 0 ||
        ioctl(dsp_fd, kDspStereo, &stereo) < 0 ||
        ioctl(dsp_fd, kDspSetFormat, &format) < 0 ||
        ioctl(dsp_fd, kDspSetFragment, &fragments) < 0) {
      perror("dosbox-pure: configure /dev/dsp");
      close_audio();
    }
  } else {
    fprintf(stderr,
            "dosbox-pure: /dev/dsp unavailable; continuing without audio\n");
  }

  mouse_fd = open("/dev/input/mice", O_RDONLY | O_NONBLOCK);
  if (mouse_fd < 0)
    fprintf(
        stderr,
        "dosbox-pure: /dev/input/mice unavailable; continuing without mouse\n");

  if (isatty(STDIN_FILENO)) {
    if (tcgetattr(STDIN_FILENO, &saved_stdin_termios) < 0) return false;
    raw_stdin_termios = saved_stdin_termios;
    cfmakeraw(&raw_stdin_termios);
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw_stdin_termios) < 0) return false;
    have_saved_stdin_termios = true;
    if (ioctl(STDIN_FILENO, KDSKBMODE, K_MEDIUMRAW) < 0) return false;
    saved_stdin_flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (saved_stdin_flags < 0 ||
        fcntl(STDIN_FILENO, F_SETFL, saved_stdin_flags | O_NONBLOCK) < 0)
      return false;
  } else {
    keyboard_fd = open("/dev/input/event0", O_RDONLY | O_NONBLOCK);
    if (keyboard_fd < 0) {
      perror("dosbox-pure: keyboard");
      return false;
    }
    keyboard_evdev = true;
  }
  return true;
}

void close_devices() {
  if (have_saved_stdin_termios)
    (void)ioctl(STDIN_FILENO, KDSKBMODE, K_XLATE);
  if (keyboard_evdev && keyboard_fd >= 0) close(keyboard_fd);
  if (saved_stdin_flags >= 0)
    (void)fcntl(STDIN_FILENO, F_SETFL, saved_stdin_flags);
  if (have_saved_stdin_termios)
    (void)tcsetattr(STDIN_FILENO, TCSAFLUSH, &saved_stdin_termios);
  if (mouse_fd >= 0)
    close(mouse_fd);
  close_audio();
  if (fb_pixels)
    munmap(fb_pixels, fb_bytes);
  if (fb_fd >= 0)
    close(fb_fd);
}

bool ensure_directory(const std::string &path) {
  if (path.empty() || path[0] != '/') return false;
  for (size_t pos = 1; pos <= path.size(); ++pos) {
    if (pos < path.size() && path[pos] != '/') continue;
    const std::string part = path.substr(0, pos);
    if (mkdir(part.c_str(), 0700) < 0 && errno != EEXIST) {
      perror(part.c_str());
      return false;
    }
    struct stat info{};
    if (stat(part.c_str(), &info) < 0 || !S_ISDIR(info.st_mode)) return false;
  }
  return true;
}
// Pure selects programs by DOS suffix. Content-based imports can have a valid
// MZ header under any host filename. A temporary 8.3 hard link lets the core
// execute those bytes in their original directory, with all companion data.
struct ExecutableAlias {
  std::string path;
  ~ExecutableAlias() {
    if (!path.empty() && unlink(path.c_str()) < 0 && errno != ENOENT)
      perror("dosbox-pure: remove executable alias");
  }
  bool prepare(std::string &content) {
    struct stat info{};
    if (stat(content.c_str(), &info) < 0) return false;
    if (!S_ISREG(info.st_mode)) return true;
    const size_t dot = content.rfind('.');
    std::string suffix = dot == std::string::npos ? "" : content.substr(dot);
    for (char &c : suffix) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
    if (suffix == ".exe" || suffix == ".com") return true;
    const int fd = open(content.c_str(), O_RDONLY);
    if (fd < 0) return false;
    unsigned char magic[2]{};
    const ssize_t size = read(fd, magic, sizeof magic);
    close(fd);
    if (size != 2 || magic[0] != 'M' || magic[1] != 'Z') return true;
    const std::string parent = content.substr(0, content.rfind('/') + 1);
    for (unsigned attempt = 0; attempt < 1024; ++attempt) {
      char name[13];
      snprintf(name, sizeof name, "K%07X.EXE",
               (static_cast<unsigned>(getpid()) * 1024 + attempt) & 0x0fffffff);
      const std::string candidate = parent + name;
      if (link(content.c_str(), candidate.c_str()) == 0) {
        path = candidate;
        content = path;
        return true;
      }
      if (errno != EEXIST) return false;
    }
    errno = EEXIST;
    return false;
  }
};
} // namespace

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--info") == 0) {
    retro_system_info info{};
    retro_get_system_info(&info);
    printf("%s %s\nCPU: x86 interpreter (native dynarec disabled)\n",
           info.library_name, info.library_version);
    return 0;
  }
  uint64_t frame_limit = 0;
  const char *content = nullptr;
  for (int i = 1; i < argc; ++i) {
    if (strcmp(argv[i], "--keypad-arrows") == 0) keypad_arrows = true;
    else if (strcmp(argv[i], "--frames") == 0 && i + 1 < argc) {
      char *end = nullptr;
      const char *value = argv[++i];
      errno = 0;
      frame_limit = strtoull(value, &end, 10);
      if (errno || !*value || *value == '-' || *end || !frame_limit) return 2;
    } else if (argv[i][0] == '-' || content) {
      content = nullptr;
      break;
    } else content = argv[i];
  }
  if (!content) {
    fprintf(stderr, "usage: dosbox-pure <game.zip|program.exe|disk.img|dosbox.conf|directory> "
                    "[--keypad-arrows] [--frames N]\n       dosbox-pure --info\n");
    return 2;
  }
  const char *xdg = getenv("XDG_DATA_HOME");
  const char *home = getenv("HOME");
  std::string state;
  if (xdg && xdg[0] == '/') state = std::string(xdg) + "/dosbox-pure";
  else if (home && home[0] == '/') state = std::string(home) + "/.local/share/dosbox-pure";
  else {
    fprintf(stderr, "dosbox-pure: set an absolute HOME or XDG_DATA_HOME for game saves\n");
    return 1;
  }
  system_dir = state + "/system";
  save_dir = state + "/saves";
  if (!ensure_directory(system_dir) || !ensure_directory(save_dir)) return 1;
  char *resolved = realpath(content, nullptr);
  if (!resolved) { perror(content); return 1; }
  std::string content_path = resolved;
  free(resolved);
  ExecutableAlias executable_alias;
  if (!executable_alias.prepare(content_path)) {
    perror("dosbox-pure: prepare executable name");
    return 1;
  }
  const size_t slash = content_path.rfind('/');
  std::string content_parent =
      slash == std::string::npos ? "." : content_path.substr(0, slash);
  content_dir = content_parent.c_str();

  if (!open_devices()) {
    close_devices();
    return 1;
  }

  struct sigaction action{};
  action.sa_handler = request_shutdown;
  sigemptyset(&action.sa_mask);
  for (int signal : {SIGINT, SIGTERM, SIGHUP})
    if (sigaction(signal, &action, nullptr) < 0) { perror("sigaction"); close_devices(); return 1; }

  retro_set_environment(environment);
  retro_set_video_refresh(video_refresh);
  retro_set_audio_sample(nullptr);
  retro_set_audio_sample_batch(audio_batch);
  retro_set_input_poll(input_poll);
  retro_set_input_state(input_state);
  retro_init();

  retro_game_info game{};
  game.path = content_path.c_str();
  if (!retro_load_game(&game)) {
    fprintf(stderr, "dosbox-pure: could not load %s\n", game.path);
    retro_deinit();
    close_devices();
    return 1;
  }

  retro_system_av_info av{};
  retro_get_system_av_info(&av);
  if (av.timing.fps > 1.0)
    target_fps = av.timing.fps;
  if (av.geometry.aspect_ratio > 0) display_aspect = av.geometry.aspect_ratio;
  int sample_rate = static_cast<int>(av.timing.sample_rate);
  if (dsp_fd >= 0 && ioctl(dsp_fd, kDspSpeed, &sample_rate) < 0) {
    perror("dosbox-pure: audio rate"); close_audio();
  }
  audio_sample_rate = sample_rate;
  fprintf(stderr, "dosbox-pure: running x86 interpreter; Ctrl+Shift+F12 quits\n");
  uint64_t next_frame_ns = 0, frames = 0;
  while (!shutdown_requested && (!frame_limit || frames < frame_limit)) {
    timespec now{};
    clock_gettime(CLOCK_MONOTONIC, &now);
    const uint64_t now_ns =
        static_cast<uint64_t>(now.tv_sec) * 1000000000ULL + now.tv_nsec;
    if (!next_frame_ns)
      next_frame_ns = now_ns;
    retro_run();
    ++frames;
    next_frame_ns +=
        static_cast<uint64_t>(1000000000.0 / std::max(10.0, target_fps));
    clock_gettime(CLOCK_MONOTONIC, &now);
    const uint64_t after_ns =
        static_cast<uint64_t>(now.tv_sec) * 1000000000ULL + now.tv_nsec;
    if (next_frame_ns > after_ns) {
      const uint64_t delay = next_frame_ns - after_ns;
      timespec sleep_time{static_cast<time_t>(delay / 1000000000ULL),
                          static_cast<long>(delay % 1000000000ULL)};
      while (nanosleep(&sleep_time, &sleep_time) < 0 && errno == EINTR) {
      }
    } else if (after_ns - next_frame_ns > 1000000000ULL) {
      next_frame_ns = after_ns;
    }
  }

  retro_unload_game();
  retro_deinit();
  close_devices();
  fprintf(stderr, "dosbox-pure: stopped after %llu frames\n", static_cast<unsigned long long>(frames));
  return 0;
}
