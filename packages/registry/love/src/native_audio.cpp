// Guest-side LÖVE audio: decode Vorbis, mix voices, and let SDL's ordinary
// OSS driver deliver PCM through /dev/dsp on both browser and Node hosts.
#include "native_audio.h"
#include <SDL.h>
#define STB_VORBIS_HEADER_ONLY
#include "stb_vorbis.c"

extern "C" {
#include <lua.h>
#include <lauxlib.h>
}
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr const char *sourceType = "kandelo.audio.Source";
constexpr int outputRate = 48000;
constexpr size_t streamFrames = 2048;
constexpr size_t maxVoices = 256;

struct VorbisCloser { void operator()(stb_vorbis *v) const { if (v) stb_vorbis_close(v); } };
using Decoder = std::unique_ptr<stb_vorbis, VorbisCloser>;
struct Clip {
  int rate = 0, channels = 0;
  unsigned frames = 0;
  // Match LÖVE's usual 16-bit decoded static data; long soundtracks must
  // not consume twice that allocation just for the mixer's float format.
  std::vector<int16_t> pcm;
};
enum class State { Stopped, Playing, Paused };
struct Source {
  std::string path;
  std::shared_ptr<Clip> clip;
  Decoder decoder;
  int rate = 0, channels = 0;
  unsigned frames = 0;
  bool streaming = false, looping = false;
  State state = State::Stopped;
  double cursor = 0, volume = 1, pitch = 1;
  std::array<float, streamFrames * 2> buffer{};
  unsigned bufferStart = 0, buffered = 0;
  unsigned decoderNext = 0;
  std::array<float, 2> firstSample{};
  bool failed = false;
};
using Voice = std::shared_ptr<Source>;
struct Audio {
  std::string root;
  SDL_AudioDeviceID device = 0;
  bool initialized = false;
  double volume = 1;
  // Playing sources own their data even if Lua collects their userdata.
  // Paused voices remain here so global stop/play and GC are coherent.
  std::vector<Voice> voices;
} audio;

// SDL calls the mixer under this same device lock. Never call Lua, acquire
// a second lock, or retain pointers into Lua storage in the audio callback.
struct Lock {
  SDL_AudioDeviceID device = audio.device;
  Lock() { if (device) SDL_LockAudioDevice(device); }
  ~Lock() { if (device) SDL_UnlockAudioDevice(device); }
};

Decoder openVorbis(const std::string &path) {
  int error = 0;
  Decoder decoder(stb_vorbis_open_filename(path.c_str(), &error, nullptr));
  if (!decoder) throw std::runtime_error("cannot decode Ogg Vorbis file: " + path +
                                         " (decoder error " + std::to_string(error) + ")");
  return decoder;
}

Voice loadSource(const std::string &path, bool streaming) {
  auto source = std::make_shared<Source>();
  source->path = path;
  source->streaming = streaming;
  unsigned char magic[4]{};
  FILE *file = fopen(path.c_str(), "rb");
  if (!file) throw std::runtime_error("cannot open audio file: " + path);
  size_t count = fread(magic, 1, sizeof(magic), file);
  fclose(file);
  if (count == 4 && std::memcmp(magic, "OggS", 4) == 0) {
    source->decoder = openVorbis(path);
    auto info = stb_vorbis_get_info(source->decoder.get());
    source->rate = int(info.sample_rate);
    source->channels = info.channels;
    source->frames = stb_vorbis_stream_length_in_samples(source->decoder.get());
    if (source->channels < 1 || source->channels > 2 || source->rate <= 0 || !source->frames)
      throw std::runtime_error("audio requires nonempty mono/stereo Vorbis: " + path);
    if (streaming) {
      if (!stb_vorbis_seek_start(source->decoder.get()) ||
          stb_vorbis_get_samples_float_interleaved(source->decoder.get(), source->channels,
              source->firstSample.data(), source->channels) != 1 ||
          !stb_vorbis_seek_start(source->decoder.get()))
        throw std::runtime_error("cannot read Vorbis stream: " + path);
      if (source->channels == 1) source->firstSample[1] = source->firstSample[0];
    } else {
      auto clip = std::make_shared<Clip>();
      clip->rate = source->rate;
      clip->channels = source->channels;
      clip->frames = source->frames;
      if (clip->frames > clip->pcm.max_size() / size_t(clip->channels))
        throw std::runtime_error("static audio is too large: " + path);
      clip->pcm.resize(size_t(clip->frames) * clip->channels);
      unsigned offset = 0;
      while (offset < clip->frames) {
        unsigned request = std::min(clip->frames - offset, unsigned(streamFrames));
        int got = stb_vorbis_get_samples_short_interleaved(source->decoder.get(), clip->channels,
            clip->pcm.data() + size_t(offset) * clip->channels, int(request) * clip->channels);
        if (got <= 0) throw std::runtime_error("truncated Vorbis audio: " + path);
        offset += unsigned(got);
      }
      source->clip = std::move(clip);
      source->decoder.reset();
    }
  } else {
    if (streaming) throw std::runtime_error("stream sources require Ogg Vorbis: " + path);
    SDL_AudioSpec spec{};
    Uint8 *bytes = nullptr;
    Uint32 length = 0;
    if (!SDL_LoadWAV(path.c_str(), &spec, &bytes, &length))
      throw std::runtime_error("cannot decode WAV audio: " + path + ": " + SDL_GetError());
    std::unique_ptr<Uint8, decltype(&SDL_FreeWAV)> input(bytes, SDL_FreeWAV);
    if (spec.channels < 1 || spec.channels > 2 || spec.freq <= 0 ||
        length > unsigned(std::numeric_limits<int>::max()))
      throw std::runtime_error("audio requires mono/stereo WAV: " + path);
    SDL_AudioCVT cvt{};
    if (SDL_BuildAudioCVT(&cvt, spec.format, spec.channels, spec.freq,
                         AUDIO_S16SYS, spec.channels, spec.freq) < 0)
      throw std::runtime_error(SDL_GetError());
    int multiplier = std::max(1, cvt.len_mult);
    if (!length || length > unsigned(std::numeric_limits<int>::max() / multiplier))
      throw std::runtime_error("empty or oversized WAV audio: " + path);
    size_t capacity = size_t(length) * size_t(multiplier);
    std::vector<Uint8> converted(capacity);
    std::memcpy(converted.data(), bytes, length);
    cvt.buf = converted.data();
    cvt.len = int(length);
    if (SDL_ConvertAudio(&cvt) < 0) throw std::runtime_error(SDL_GetError());
    auto clip = std::make_shared<Clip>();
    clip->rate = spec.freq;
    clip->channels = spec.channels;
    clip->frames = unsigned(cvt.len_cvt / (int(sizeof(int16_t)) * clip->channels));
    if (!clip->frames) throw std::runtime_error("empty WAV audio: " + path);
    clip->pcm.resize(size_t(clip->frames) * clip->channels);
    std::memcpy(clip->pcm.data(), cvt.buf, clip->pcm.size() * sizeof(int16_t));
    source->rate = clip->rate;
    source->channels = clip->channels;
    source->frames = clip->frames;
    source->clip = std::move(clip);
  }
  return source;
}

bool sample(Source &s, unsigned frame, float *out) {
  if (s.clip) {
    const int16_t *p = s.clip->pcm.data() + size_t(frame) * s.channels;
    out[0] = p[0] / 32768.0f; out[1] = p[s.channels - 1] / 32768.0f;
    return true;
  }
  if (frame == 0) {
    out[0] = s.firstSample[0]; out[1] = s.firstSample[1];
    return true;
  }
  if (frame < s.bufferStart || frame - s.bufferStart >= s.buffered) {
    // Preserve the last frame during a sequential refill. Interpolation
    // may ask for it again at a fractional pitch; dropping it would cause
    // a backwards file seek on every boundary.
    unsigned keep = s.buffered && frame == s.decoderNext ? 1 : 0;
    if (keep) {
      for (int c = 0; c < s.channels; ++c)
        s.buffer[c] = s.buffer[(s.buffered - 1) * s.channels + c];
    }
    if (frame != s.decoderNext && !stb_vorbis_seek(s.decoder.get(), frame)) return false;
    s.bufferStart = frame - keep;
    int got = stb_vorbis_get_samples_float_interleaved(s.decoder.get(), s.channels,
        s.buffer.data() + keep * s.channels, int(streamFrames - keep) * s.channels);
    if (got <= 0) return false;
    s.buffered = keep + unsigned(got);
    s.decoderNext = s.bufferStart + s.buffered;
  }
  const float *p = s.buffer.data() + size_t(frame - s.bufferStart) * s.channels;
  out[0] = p[0]; out[1] = p[s.channels - 1];
  return true;
}

void mix(void *, Uint8 *bytes, int length) {
  // Fixed callback format; accumulators stay float until the final clamp.
  auto *output = reinterpret_cast<float *>(bytes);
  int frames = length / (2 * int(sizeof(float)));
  std::memset(bytes, 0, size_t(length));
  for (auto &voice : audio.voices) {
    Source &s = *voice;
    if (s.state != State::Playing) continue;
    double step = s.pitch * s.rate / outputRate;
    for (int i = 0; i < frames; ++i) {
      if (s.cursor >= s.frames) {
        if (s.looping) s.cursor = std::fmod(s.cursor, double(s.frames));
        else { s.state = State::Stopped; s.cursor = 0; break; }
      }
      unsigned frame = unsigned(s.cursor);
      unsigned next = frame + 1 < s.frames ? frame + 1 : (s.looping ? 0 : frame);
      float a[2], b[2];
      if (!sample(s, frame, a) || !sample(s, next, b)) {
        s.failed = true; s.state = State::Stopped; s.cursor = 0; break;
      }
      float fraction = float(s.cursor - frame);
      float gain = float(s.volume * audio.volume);
      for (int channel = 0; channel < 2; ++channel)
        output[i * 2 + channel] += (a[channel] + (b[channel] - a[channel]) * fraction) * gain;
      s.cursor += step;
    }
    // Finish on the last sample, so state queries need not wait an extra
    // callback when a clip ends exactly at the callback boundary.
    if (s.state == State::Playing && s.cursor >= s.frames) {
      if (s.looping) s.cursor = std::fmod(s.cursor, double(s.frames));
      else { s.state = State::Stopped; s.cursor = 0; }
    }
  }
  for (int i = 0; i < frames * 2; ++i)
    output[i] = std::clamp(output[i], -1.0f, 1.0f);
  audio.voices.erase(std::remove_if(audio.voices.begin(), audio.voices.end(),
      [](const Voice &s) { return s->state == State::Stopped; }), audio.voices.end());
}

void openDevice() {
  if (audio.device) {
    if (SDL_GetAudioDeviceStatus(audio.device) == SDL_AUDIO_STOPPED)
      throw std::runtime_error("SDL audio device stopped unexpectedly");
    return;
  }
  if (!audio.initialized) {
    if (SDL_InitSubSystem(SDL_INIT_AUDIO) != 0) throw std::runtime_error(SDL_GetError());
    audio.initialized = true;
  }
  SDL_AudioSpec desired{};
  desired.freq = outputRate;
  desired.format = AUDIO_F32SYS;
  desired.channels = 2;
  desired.samples = 512;
  desired.callback = mix;
  audio.voices.reserve(maxVoices);
  audio.device = SDL_OpenAudioDevice(nullptr, 0, &desired, nullptr, 0);
  if (!audio.device) throw std::runtime_error("cannot open SDL audio output: " + std::string(SDL_GetError()));
  SDL_PauseAudioDevice(audio.device, 0);
  fprintf(stderr, "love: audio output via SDL2/%s on /dev/dsp\n", SDL_GetCurrentAudioDriver());
}

Voice &check(lua_State *L, int index = 1) {
  auto &voice = *static_cast<Voice *>(luaL_checkudata(L, index, sourceType));
  if (!voice) luaL_error(L, "attempt to use a released audio Source");
  return voice;
}
void checkFailure(const Source &s) {
  if (audio.device && SDL_GetAudioDeviceStatus(audio.device) == SDL_AUDIO_STOPPED)
    throw std::runtime_error("SDL audio device stopped unexpectedly");
  if (s.failed) throw std::runtime_error("audio stream decode failed: " + s.path);
}
bool play(const Voice &voice) {
  checkFailure(*voice);
  audio.voices.erase(std::remove_if(audio.voices.begin(), audio.voices.end(),
      [](const Voice &s) { return s->state == State::Stopped; }), audio.voices.end());
  if (std::find(audio.voices.begin(), audio.voices.end(), voice) == audio.voices.end()) {
    if (audio.voices.size() == maxVoices) return false;
    audio.voices.push_back(voice);
  }
  voice->state = State::Playing;
  return true;
}
void push(lua_State *L, Voice voice) {
  new (lua_newuserdata(L, sizeof(Voice))) Voice(std::move(voice));
  luaL_getmetatable(L, sourceType);
  lua_setmetatable(L, -2);
}
// Keep C++ resource unwinding outside luaL_error's non-local jump.
// Registered entry points use this trampoline for decoder/device failures.
template<int (*Function)(lua_State *)> int guarded(lua_State *L) {
  char message[1024]{};
  try { return Function(L); }
  catch (const std::exception &e) { std::snprintf(message, sizeof(message), "%s", e.what()); }
  return luaL_error(L, "%s", message);
}
int newSource(lua_State *L) {
  const char *name = luaL_checkstring(L, 1);
  const char *type = luaL_optstring(L, 2, "stream");
  if (std::strcmp(type, "static") && std::strcmp(type, "stream"))
    return luaL_error(L, "Source type must be static or stream");
  std::string path = name;
  if (path.empty() || path[0] != '/') path = audio.root + "/" + path;
  push(L, loadSource(path, std::strcmp(type, "stream") == 0));
  return 1;
}
int clone(lua_State *L) {
  auto &original = check(L);
  // Open a separate decoder before taking the device lock; clones share
  // immutable static PCM but never share a stream cursor.
  Voice copy = original->streaming ? loadSource(original->path, true) : std::make_shared<Source>();
  {
    Lock lock;
    copy->path = original->path; copy->clip = original->clip;
    copy->rate = original->rate; copy->channels = original->channels; copy->frames = original->frames;
    copy->volume = original->volume; copy->pitch = original->pitch; copy->looping = original->looping;
  }
  push(L, std::move(copy));
  return 1;
}
int gc(lua_State *L) {
  static_cast<Voice *>(luaL_checkudata(L, 1, sourceType))->~Voice();
  return 0;
}
int release(lua_State *L) {
  auto &voice = check(L);
  Lock lock;
  voice->state = State::Stopped;
  voice.reset();
  return 0;
}
int sourcePlay(lua_State *L) {
  auto &s = check(L);
  openDevice();
  bool ok;
  { Lock lock; ok = play(s); }
  lua_pushboolean(L, ok);
  return 1;
}
int sourcePause(lua_State *L) {
  auto &s = check(L);
  Lock lock;
  if (s->state == State::Playing) s->state = State::Paused;
  return 0;
}
int sourceStop(lua_State *L) {
  auto &s = check(L);
  Lock lock;
  s->state = State::Stopped; s->cursor = 0;
  return 0;
}
int isPlaying(lua_State *L) {
  auto &s = check(L); bool result;
  { Lock lock; checkFailure(*s); result = s->state == State::Playing; }
  lua_pushboolean(L, result); return 1;
}
int isStopped(lua_State *L) {
  auto &s = check(L); bool result;
  { Lock lock; checkFailure(*s); result = s->state == State::Stopped; }
  lua_pushboolean(L, result); return 1;
}
int setVolume(lua_State *L) {
  auto &s = check(L); double value = luaL_checknumber(L, 2);
  if (!std::isfinite(value) || value < 0 || value > std::numeric_limits<float>::max())
    return luaL_error(L, "source volume must be a finite nonnegative float");
  Lock lock; s->volume = value; return 0;
}
int getVolume(lua_State *L) {
  auto &s = check(L); double value;
  { Lock lock; value = s->volume; }
  lua_pushnumber(L, value); return 1;
}
int setPitch(lua_State *L) {
  auto &s = check(L); double value = luaL_checknumber(L, 2);
  if (!std::isfinite(value) || value < std::numeric_limits<float>::denorm_min() ||
      value > std::numeric_limits<float>::max())
    return luaL_error(L, "pitch must be a finite positive float");
  Lock lock; s->pitch = value; return 0;
}
int getPitch(lua_State *L) {
  auto &s = check(L); double value;
  { Lock lock; value = s->pitch; }
  lua_pushnumber(L, value); return 1;
}
int setLooping(lua_State *L) {
  auto &s = check(L); bool value = lua_toboolean(L, 2);
  Lock lock; s->looping = value; return 0;
}
int isLooping(lua_State *L) {
  auto &s = check(L); bool value;
  { Lock lock; value = s->looping; }
  lua_pushboolean(L, value); return 1;
}
bool samplesUnit(lua_State *L, int index) {
  const char *unit = luaL_optstring(L, index, "seconds");
  if (std::strcmp(unit, "seconds") && std::strcmp(unit, "samples"))
    luaL_error(L, "time unit must be seconds or samples");
  return std::strcmp(unit, "samples") == 0;
}
int duration(lua_State *L) {
  auto &s = check(L); bool samples = samplesUnit(L, 2);
  lua_pushnumber(L, samples ? double(s->frames) : double(s->frames) / s->rate); return 1;
}
int channels(lua_State *L) { lua_pushinteger(L, check(L)->channels); return 1; }
int getType(lua_State *L) { lua_pushstring(L, check(L)->streaming ? "stream" : "static"); return 1; }
int seek(lua_State *L) {
  auto &s = check(L); double value = luaL_checknumber(L, 2);
  bool samples = samplesUnit(L, 3);
  if (!samples) value *= s->rate;
  if (!std::isfinite(value) || value < 0 || value > s->frames) return luaL_error(L, "seek is outside the audio source");
  Lock lock; s->cursor = value; return 0;
}
int tell(lua_State *L) {
  auto &s = check(L); bool samples = samplesUnit(L, 2); double value;
  { Lock lock; checkFailure(*s); value = s->cursor; }
  lua_pushnumber(L, samples ? value : value / s->rate); return 1;
}
int setEffect(lua_State *L) { lua_pushboolean(L, false); return 1; }
int effectsSupported(lua_State *L) { lua_pushboolean(L, false); return 1; }
int unsupportedSpatial(lua_State *L) { return luaL_error(L, "spatial audio is not implemented by the Kandelo LÖVE backend"); }
int masterSetVolume(lua_State *L) {
  double value = luaL_checknumber(L, 1);
  if (!std::isfinite(value) || value < 0 || value > 1) return luaL_error(L, "volume must be between 0 and 1");
  Lock lock; audio.volume = value; return 0;
}
int masterGetVolume(lua_State *L) {
  double value; { Lock lock; value = audio.volume; }
  lua_pushnumber(L, value); return 1;
}
int activeCount(lua_State *L) {
  int count = 0;
  { Lock lock; for (auto &s : audio.voices) if (s->state == State::Playing) ++count; }
  lua_pushinteger(L, count); return 1;
}
// Accept the LÖVE forms audio.play(source, ...) and audio.play({sources}).
// Validate arguments before locking, since a Lua error must not skip unlock.
std::vector<Voice> arguments(lua_State *L) {
  bool table = lua_istable(L, 1);
  size_t count = table ? lua_rawlen(L, 1) : size_t(lua_gettop(L));
  for (size_t i = 1; i <= count; ++i) {
    if (table) lua_rawgeti(L, 1, int(i));
    check(L, table ? -1 : int(i));
    if (table) lua_pop(L, 1);
  }
  std::vector<Voice> result;
  result.reserve(count);
  for (size_t i = 1; i <= count; ++i) {
    if (table) lua_rawgeti(L, 1, int(i));
    result.push_back(*static_cast<Voice *>(lua_touserdata(L, table ? -1 : int(i))));
    if (table) lua_pop(L, 1);
  }
  return result;
}
int masterPlay(lua_State *L) {
  if (!lua_gettop(L)) return luaL_error(L, "audio.play requires at least one Source");
  auto sources = arguments(L);
  if (sources.empty()) { lua_pushboolean(L, true); return 1; }
  openDevice();
  bool ok;
  { Lock lock;
    size_t active = 0, needed = 0;
    for (auto &s : audio.voices) if (s->state != State::Stopped) ++active;
    for (size_t i = 0; i < sources.size(); ++i) {
      checkFailure(*sources[i]);
      bool duplicate = std::find(sources.begin(), sources.begin() + i, sources[i]) != sources.begin() + i;
      bool assigned = sources[i]->state != State::Stopped &&
          std::find(audio.voices.begin(), audio.voices.end(), sources[i]) != audio.voices.end();
      if (!duplicate && !assigned) ++needed;
    }
    // A failed multi-source play must not start only part of the group.
    ok = needed <= maxVoices - active;
    if (ok) for (auto &s : sources) play(s);
  }
  lua_pushboolean(L, ok); return 1;
}
int masterStop(lua_State *L) {
  auto sources = arguments(L);
  Lock lock;
  auto &targets = lua_gettop(L) ? sources : audio.voices;
  for (auto &s : targets) { s->state = State::Stopped; s->cursor = 0; }
  return 0;
}
int masterPause(lua_State *L) {
  auto sources = arguments(L);
  bool all = !lua_gettop(L);
  // Lua owns table construction; keep it outside the callback's device lock.
  { Lock lock;
    if (all) sources = audio.voices;
    sources.erase(std::remove_if(sources.begin(), sources.end(), [](const Voice &s) {
      return s->state != State::Playing;
    }), sources.end());
    for (auto &s : sources) s->state = State::Paused;
  }
  lua_newtable(L);
  for (size_t i = 0; i < sources.size(); ++i) { push(L, sources[i]); lua_rawseti(L, -2, int(i + 1)); }
  return 1;
}
} // namespace

void kandelo_love_register_audio(lua_State *L, const char *root) {
  audio.root = root;
  const luaL_Reg methods[] = {
    {"clone", guarded<clone>}, {"play", guarded<sourcePlay>}, {"pause", sourcePause}, {"stop", sourceStop},
    {"isPlaying", guarded<isPlaying>}, {"isStopped", guarded<isStopped>},
    {"setVolume", setVolume}, {"getVolume", getVolume}, {"setPitch", setPitch}, {"getPitch", getPitch},
    {"setLooping", setLooping}, {"isLooping", isLooping}, {"seek", seek}, {"tell", guarded<tell>},
    {"getDuration", duration}, {"getChannelCount", channels}, {"getType", getType}, {"release", release},
    {"setEffect", setEffect}, {"setPosition", unsupportedSpatial}, {"getPosition", unsupportedSpatial},
    {"setOrientation", unsupportedSpatial}, {"getOrientation", unsupportedSpatial},
    {"setRelative", unsupportedSpatial}, {"isRelative", unsupportedSpatial},
    {"setAttenuationDistances", unsupportedSpatial}, {nullptr, nullptr}
  };
  luaL_newmetatable(L, sourceType);
  lua_pushvalue(L, -1); lua_setfield(L, -2, "__index");
  lua_pushcfunction(L, gc); lua_setfield(L, -2, "__gc");
  luaL_setfuncs(L, methods, 0);
  lua_pop(L, 1);
  const luaL_Reg functions[] = {
    {"newSource", guarded<newSource>}, {"play", guarded<masterPlay>}, {"stop", guarded<masterStop>}, {"pause", guarded<masterPause>},
    {"setVolume", masterSetVolume}, {"getVolume", masterGetVolume}, {"getActiveSourceCount", activeCount},
    {"setEffect", setEffect}, {"isEffectsSupported", effectsSupported},
    {"setPosition", unsupportedSpatial}, {"getPosition", unsupportedSpatial},
    {"setOrientation", unsupportedSpatial}, {"getOrientation", unsupportedSpatial},
    {"setDistanceModel", unsupportedSpatial}, {nullptr, nullptr}
  };
  lua_getglobal(L, "love");
  lua_newtable(L); luaL_setfuncs(L, functions, 0); lua_setfield(L, -2, "audio");
  lua_pop(L, 1);
}

void kandelo_love_shutdown_audio() {
  // Close joins the callback before the sources/decoders disappear. Do this
  // before lua_close and SDL_Quit, including startup and Lua-error paths.
  if (audio.device) SDL_CloseAudioDevice(audio.device);
  audio.device = 0;
  audio.voices.clear();
  if (audio.initialized) SDL_QuitSubSystem(SDL_INIT_AUDIO);
  audio.initialized = false;
}
