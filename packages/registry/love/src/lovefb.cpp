// Kandelo native runtime for LÖVE-style Lua demos.
//
// This is a native POSIX/Wasm executable. It does not use Emscripten or a
// browser canvas API directly: rendering prefers /dev/dri/card0 with
// KMS/EGL/GLES page flips, keyboard input is Linux MEDIUMRAW on stdin, and
// mouse input is /dev/input/mice PS/2 packets.
//
// The upstream LÖVE 11.x graphics path is OpenGL/SDL-oriented. For Kandelo's
// native surface this file provides a compact Lua compatibility layer and
// presents the game frame through the kernel's direct-rendering stack.

#include <algorithm>
#include <array>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <EGL/egl.h>
#include <fcntl.h>
#include <gbm.h>
#include <GLES2/gl2.h>
#include <drm/drm.h>
#include <drm/drm_fourcc.h>
#include <linux/fb.h>
#include <map>
#include <set>
#include <signal.h>
#include <sstream>
#include <string>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <termios.h>
#include <unistd.h>
#include <utility>
#include <vector>
#include <xf86drm.h>
#include <xf86drmMode.h>

extern "C" {
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
}

#include "lodepng.h"

namespace {

constexpr int kLogicalWidth = 960;
constexpr int kLogicalHeight = 540;
constexpr int kScanoutWidth = 1920;
constexpr int kScanoutHeight = 1080;
constexpr int kKmsBoCount = 2;
constexpr double kPi = 3.14159265358979323846;

enum class Presenter {
  None,
  Framebuffer,
  KmsGl,
};

struct Color {
  uint8_t r = 255;
  uint8_t g = 255;
  uint8_t b = 255;
  uint8_t a = 255;
};

struct Surface {
  int w = 0;
  int h = 0;
  std::vector<uint32_t> bgra;
};

struct Font {
  int size = 11;
};

struct Text {
  Font *font = nullptr;
  std::string text;
};

struct ImageData {
  int w = 0;
  int h = 0;
  std::vector<uint8_t> rgba;
};

struct Image {
  int w = 0;
  int h = 0;
  std::vector<uint8_t> rgba;
};

struct Quad {
  int x = 0;
  int y = 0;
  int w = 0;
  int h = 0;
  int sw = 0;
  int sh = 0;
};

struct Video {
  int w = 320;
  int h = 180;
  double t = 0.0;
  bool playing = false;
};

struct Mesh {
  std::vector<double> points;
};

struct Source {
  double volume = 1.0;
  double pitch = 1.0;
  bool looping = false;
  bool playing = false;
  double cursor = 0.0;
};

struct FileHandle {
  std::string path;
  FILE *fp = nullptr;
};

struct Shape {
  enum Kind { Circle, Polygon, Edge } kind = Polygon;
  std::vector<double> points;
  double radius = 0.0;
};

struct Body;

struct World {
  double gx = 0.0;
  double gy = 0.0;
  std::vector<Body *> bodies;
};

struct Body {
  World *world = nullptr;
  double x = 0.0;
  double y = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double angle = 0.0;
  bool dynamic = false;
  bool fixedRotation = false;
  double angularVelocity = 0.0;
};

struct Fixture {
  Body *body = nullptr;
  Shape *shape = nullptr;
  int userDataRef = LUA_NOREF;
  bool sensor = false;
  double friction = 0.0;
  double restitution = 0.0;
};

struct KeyEvent {
  std::string key;
  bool pressed = false;
};

struct MouseButtonEvent {
  int button = 0;
  bool pressed = false;
};

struct LoveEvent {
  std::string name;
  std::vector<std::string> args;
};

struct Transform {
  double a = 1.0;
  double b = 0.0;
  double c = 0.0;
  double d = 1.0;
  double e = 0.0;
  double f = 0.0;
};

struct Runtime {
  std::string root;
  Presenter presenter = Presenter::None;
  int fbFd = -1;
  int miceFd = -1;
  int fbW = kLogicalWidth;
  int fbH = kLogicalHeight;
  size_t fbLen = 0;
  uint32_t *fb = nullptr;

  int drmFd = -1;
  gbm_device *gbm = nullptr;
  gbm_bo *kmsBos[kKmsBoCount]{};
  uint32_t kmsFbIds[kKmsBoCount]{};
  uint32_t kmsCrtcId = 0;
  uint32_t kmsConnId = 0;
  drmModeModeInfo kmsMode{};
  int kmsCurrentFb = 0;
  EGLDisplay eglDisplay = EGL_NO_DISPLAY;
  EGLContext eglContext = EGL_NO_CONTEXT;
  EGLSurface eglSurface = EGL_NO_SURFACE;
  GLuint glProgram = 0;
  GLuint glTexture = 0;
  GLuint glBuffer = 0;
  GLint glPositionLoc = -1;
  GLint glTexcoordLoc = -1;
  GLint glSamplerLoc = -1;

  Surface screen;
  Surface *target = nullptr;
  Color color;
  Color background{0, 0, 0, 255};
  Font defaultFont{11};
  Font *font = &defaultFont;
  int lineWidth = 1;
  Transform transform;
  std::vector<Transform> transformStack;
  bool scissor = false;
  int sx = 0;
  int sy = 0;
  int sw = kLogicalWidth;
  int sh = kLogicalHeight;

  std::set<std::string> keys;
  std::vector<KeyEvent> keyEvents;
  std::vector<LoveEvent> queuedEvents;
  int mouseX = kLogicalWidth / 2;
  int mouseY = kLogicalHeight / 2;
  int mouseButtons = 0;
  int mouseDx = 0;
  int mouseDy = 0;
  double mouseRemainderX = 0.0;
  double mouseRemainderY = 0.0;
  std::vector<MouseButtonEvent> mouseEvents;
  bool mouseVisible = false;

  double start = 0.0;
  double last = 0.0;
  double dt = 1.0 / 60.0;
  double fpsT0 = 0.0;
  int fpsFrames = 0;
  int fps = 60;
  std::string lastError;
  termios savedTermios{};
  bool haveSavedTermios = false;
  int savedStdinFlags = -1;
};

Runtime G;
volatile sig_atomic_t gRunning = 1;

const char *MT_IMAGE = "lovefb.Image";
const char *MT_IMAGEDATA = "lovefb.ImageData";
const char *MT_CANVAS = "lovefb.Canvas";
const char *MT_QUAD = "lovefb.Quad";
const char *MT_FONT = "lovefb.Font";
const char *MT_TEXT = "lovefb.Text";
const char *MT_FILE = "lovefb.File";
const char *MT_VIDEO = "lovefb.Video";
const char *MT_MESH = "lovefb.Mesh";
const char *MT_SOURCE = "lovefb.Source";
const char *MT_SHADER = "lovefb.Shader";
const char *MT_WORLD = "lovefb.World";
const char *MT_BODY = "lovefb.Body";
const char *MT_SHAPE = "lovefb.Shape";
const char *MT_FIXTURE = "lovefb.Fixture";

double nowSeconds() {
  timeval tv{};
  gettimeofday(&tv, nullptr);
  return double(tv.tv_sec) + double(tv.tv_usec) / 1000000.0;
}

int clampInt(int v, int lo, int hi) {
  return std::max(lo, std::min(hi, v));
}

uint8_t toByte(double v) {
  if (v <= 1.0) v *= 255.0;
  return uint8_t(clampInt(int(std::lround(v)), 0, 255));
}

uint32_t packBgra(Color c) {
  return (uint32_t(c.a) << 24) | (uint32_t(c.r) << 16) |
         (uint32_t(c.g) << 8) | uint32_t(c.b);
}

Color unpackBgra(uint32_t p) {
  return Color{
    uint8_t((p >> 16) & 0xff),
    uint8_t((p >> 8) & 0xff),
    uint8_t(p & 0xff),
    uint8_t((p >> 24) & 0xff),
  };
}

Color readColor(lua_State *L, int idx) {
  if (lua_istable(L, idx)) {
    Color c;
    lua_rawgeti(L, idx, 1); c.r = toByte(luaL_optnumber(L, -1, 1.0)); lua_pop(L, 1);
    lua_rawgeti(L, idx, 2); c.g = toByte(luaL_optnumber(L, -1, 1.0)); lua_pop(L, 1);
    lua_rawgeti(L, idx, 3); c.b = toByte(luaL_optnumber(L, -1, 1.0)); lua_pop(L, 1);
    lua_rawgeti(L, idx, 4); c.a = toByte(luaL_optnumber(L, -1, 1.0)); lua_pop(L, 1);
    return c;
  }
  Color c;
  c.r = toByte(luaL_optnumber(L, idx, 1.0));
  c.g = toByte(luaL_optnumber(L, idx + 1, 1.0));
  c.b = toByte(luaL_optnumber(L, idx + 2, 1.0));
  c.a = toByte(luaL_optnumber(L, idx + 3, 1.0));
  return c;
}

template <typename T>
T *checkObj(lua_State *L, int idx, const char *mt) {
  void *ud = luaL_checkudata(L, idx, mt);
  return *static_cast<T **>(ud);
}

template <typename T>
T *toObj(lua_State *L, int idx, const char *mt) {
  void *ud = lua_touserdata(L, idx);
  if (!ud || !lua_getmetatable(L, idx)) return nullptr;
  luaL_getmetatable(L, mt);
  bool same = lua_rawequal(L, -1, -2);
  lua_pop(L, 2);
  return same ? *static_cast<T **>(ud) : nullptr;
}

template <typename T>
void pushObj(lua_State *L, T *obj, const char *mt) {
  T **ud = static_cast<T **>(lua_newuserdata(L, sizeof(T *)));
  *ud = obj;
  luaL_getmetatable(L, mt);
  lua_setmetatable(L, -2);
}

bool hasMeta(lua_State *L, int idx, const char *mt) {
  if (!lua_getmetatable(L, idx)) return false;
  luaL_getmetatable(L, mt);
  bool same = lua_rawequal(L, -1, -2);
  lua_pop(L, 2);
  return same;
}

void addFunc(lua_State *L, const char *name, lua_CFunction fn) {
  lua_pushcfunction(L, fn);
  lua_setfield(L, -2, name);
}

void createMeta(lua_State *L, const char *name, const luaL_Reg *methods,
                lua_CFunction gc = nullptr) {
  luaL_newmetatable(L, name);
  for (const luaL_Reg *r = methods; r && r->name; ++r) addFunc(L, r->name, r->func);
  lua_pushvalue(L, -1);
  lua_setfield(L, -2, "__index");
  if (gc) {
    lua_pushcfunction(L, gc);
    lua_setfield(L, -2, "__gc");
  }
  lua_pop(L, 1);
}

Transform multiply(const Transform &m, const Transform &n) {
  return Transform{
    m.a * n.a + m.c * n.b,
    m.b * n.a + m.d * n.b,
    m.a * n.c + m.c * n.d,
    m.b * n.c + m.d * n.d,
    m.a * n.e + m.c * n.f + m.e,
    m.b * n.e + m.d * n.f + m.f,
  };
}

void appendTransform(const Transform &t) {
  G.transform = multiply(G.transform, t);
}

void transformPoint(double x, double y, int &outX, int &outY) {
  outX = int(std::lround(G.transform.a * x + G.transform.c * y + G.transform.e));
  outY = int(std::lround(G.transform.b * x + G.transform.d * y + G.transform.f));
}

std::vector<double> collectNumbers(lua_State *L, int start) {
  std::vector<double> out;
  for (int i = start; i <= lua_gettop(L); ++i) {
    if (lua_istable(L, i)) {
      int n = int(lua_objlen(L, i));
      for (int j = 1; j <= n; ++j) {
        lua_rawgeti(L, i, j);
        if (lua_isnumber(L, -1)) out.push_back(lua_tonumber(L, -1));
        lua_pop(L, 1);
      }
    } else {
      out.push_back(luaL_checknumber(L, i));
    }
  }
  return out;
}

std::string luaToString(lua_State *L, int idx) {
  if (lua_isnil(L, idx)) return "nil";
  if (lua_isboolean(L, idx)) return lua_toboolean(L, idx) ? "true" : "false";
  if (lua_isstring(L, idx)) {
    size_t n = 0;
    const char *s = lua_tolstring(L, idx, &n);
    return std::string(s ? s : "", n);
  }
  return lua_typename(L, lua_type(L, idx));
}

std::string printableText(lua_State *L, int idx) {
  if (!lua_istable(L, idx)) return luaToString(L, idx);
  std::string out;
  int n = int(lua_objlen(L, idx));
  for (int i = 1; i <= n; ++i) {
    lua_rawgeti(L, idx, i);
    if (!lua_istable(L, -1)) out += luaToString(L, -1);
    lua_pop(L, 1);
  }
  return out;
}

std::string normalizePath(const std::string &path) {
  if (!path.empty() && path[0] == '/') return path;
  std::string out = G.root;
  if (!out.empty() && out.back() != '/') out += '/';
  out += path;
  return out;
}

bool readFile(const std::string &path, std::vector<uint8_t> &out) {
  FILE *f = fopen(normalizePath(path).c_str(), "rb");
  if (!f) return false;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (len < 0) {
    fclose(f);
    return false;
  }
  out.resize(size_t(len));
  if (len > 0) fread(out.data(), 1, size_t(len), f);
  fclose(f);
  return true;
}

bool loadPng(const std::string &path, ImageData &img) {
  std::vector<uint8_t> bytes;
  if (!readFile(path, bytes)) return false;
  unsigned w = 0, h = 0;
  std::vector<unsigned char> rgba;
  unsigned err = lodepng::decode(rgba, w, h, bytes);
  if (err != 0) return false;
  img.w = int(w);
  img.h = int(h);
  img.rgba.assign(rgba.begin(), rgba.end());
  return true;
}

void blendPixel(Surface &s, int x, int y, Color c) {
  transformPoint(x, y, x, y);
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return;
  if (G.scissor &&
      (x < G.sx || y < G.sy || x >= G.sx + G.sw || y >= G.sy + G.sh)) {
    return;
  }
  uint32_t &dstP = s.bgra[size_t(y) * s.w + x];
  if (c.a == 255) {
    dstP = packBgra(c);
    return;
  }
  Color d = unpackBgra(dstP);
  int a = c.a;
  int ia = 255 - a;
  Color o;
  o.r = uint8_t((int(c.r) * a + int(d.r) * ia) / 255);
  o.g = uint8_t((int(c.g) * a + int(d.g) * ia) / 255);
  o.b = uint8_t((int(c.b) * a + int(d.b) * ia) / 255);
  o.a = 255;
  dstP = packBgra(o);
}

void rawPixel(Surface &s, int x, int y, Color c) {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return;
  s.bgra[size_t(y) * s.w + x] = packBgra(c);
}

void clearSurface(Surface &s, Color c) {
  std::fill(s.bgra.begin(), s.bgra.end(), packBgra(c));
}

void drawLine(Surface &s, int x0, int y0, int x1, int y1, Color c) {
  int dx = std::abs(x1 - x0);
  int sx = x0 < x1 ? 1 : -1;
  int dy = -std::abs(y1 - y0);
  int sy = y0 < y1 ? 1 : -1;
  int err = dx + dy;
  for (;;) {
    for (int oy = -G.lineWidth / 2; oy <= G.lineWidth / 2; ++oy)
      for (int ox = -G.lineWidth / 2; ox <= G.lineWidth / 2; ++ox)
        blendPixel(s, x0 + ox, y0 + oy, c);
    if (x0 == x1 && y0 == y1) break;
    int e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

std::array<uint8_t, 7> glyph(char ch) {
  if (ch >= 'a' && ch <= 'z') ch = char(ch - 'a' + 'A');
  switch (ch) {
    case 'A': return {14,17,17,31,17,17,17};
    case 'B': return {30,17,17,30,17,17,30};
    case 'C': return {14,17,16,16,16,17,14};
    case 'D': return {30,17,17,17,17,17,30};
    case 'E': return {31,16,16,30,16,16,31};
    case 'F': return {31,16,16,30,16,16,16};
    case 'G': return {14,17,16,23,17,17,14};
    case 'H': return {17,17,17,31,17,17,17};
    case 'I': return {14,4,4,4,4,4,14};
    case 'J': return {7,2,2,2,18,18,12};
    case 'K': return {17,18,20,24,20,18,17};
    case 'L': return {16,16,16,16,16,16,31};
    case 'M': return {17,27,21,21,17,17,17};
    case 'N': return {17,25,21,19,17,17,17};
    case 'O': return {14,17,17,17,17,17,14};
    case 'P': return {30,17,17,30,16,16,16};
    case 'Q': return {14,17,17,17,21,18,13};
    case 'R': return {30,17,17,30,20,18,17};
    case 'S': return {15,16,16,14,1,1,30};
    case 'T': return {31,4,4,4,4,4,4};
    case 'U': return {17,17,17,17,17,17,14};
    case 'V': return {17,17,17,17,17,10,4};
    case 'W': return {17,17,17,21,21,21,10};
    case 'X': return {17,17,10,4,10,17,17};
    case 'Y': return {17,17,10,4,4,4,4};
    case 'Z': return {31,1,2,4,8,16,31};
    case '0': return {14,17,19,21,25,17,14};
    case '1': return {4,12,4,4,4,4,14};
    case '2': return {14,17,1,2,4,8,31};
    case '3': return {30,1,1,14,1,1,30};
    case '4': return {2,6,10,18,31,2,2};
    case '5': return {31,16,16,30,1,1,30};
    case '6': return {6,8,16,30,17,17,14};
    case '7': return {31,1,2,4,8,8,8};
    case '8': return {14,17,17,14,17,17,14};
    case '9': return {14,17,17,15,1,2,12};
    case '.': return {0,0,0,0,0,12,12};
    case ',': return {0,0,0,0,0,12,8};
    case ':': return {0,12,12,0,12,12,0};
    case ';': return {0,12,12,0,12,4,8};
    case '!': return {4,4,4,4,4,0,4};
    case '?': return {14,17,1,2,4,0,4};
    case '-': return {0,0,0,31,0,0,0};
    case '_': return {0,0,0,0,0,0,31};
    case '+': return {0,4,4,31,4,4,0};
    case '=': return {0,0,31,0,31,0,0};
    case '/': return {1,1,2,4,8,16,16};
    case '\\': return {16,16,8,4,2,1,1};
    case '(': return {2,4,8,8,8,4,2};
    case ')': return {8,4,2,2,2,4,8};
    case '[': return {14,8,8,8,8,8,14};
    case ']': return {14,2,2,2,2,2,14};
    case '<': return {2,4,8,16,8,4,2};
    case '>': return {8,4,2,1,2,4,8};
    case '"': return {10,10,10,0,0,0,0};
    case '\'': return {4,4,4,0,0,0,0};
    case '*': return {0,21,14,31,14,21,0};
    case '@': return {14,17,23,21,23,16,14};
    case '#': return {10,10,31,10,31,10,10};
    case '$': return {4,15,20,14,5,30,4};
    case '%': return {24,25,2,4,8,19,3};
    case '&': return {12,18,20,8,21,18,13};
    default: return {0,0,0,0,0,0,0};
  }
}

void drawChar(Surface &s, char ch, int x, int y, int scale, Color c) {
  auto g = glyph(ch);
  for (int row = 0; row < 7; ++row) {
    for (int col = 0; col < 5; ++col) {
      if ((g[row] & (1 << (4 - col))) == 0) continue;
      for (int yy = 0; yy < scale; ++yy)
        for (int xx = 0; xx < scale; ++xx)
          blendPixel(s, x + col * scale + xx, y + row * scale + yy, c);
    }
  }
}

void drawText(Surface &s, const std::string &text, int x, int y) {
  int scale = std::max(1, G.font->size / 8);
  int cx = x;
  int cy = y;
  for (unsigned char ch : text) {
    if (ch == '\n') {
      cx = x;
      cy += 8 * scale + 2;
      continue;
    }
    if (ch == '\t') {
      cx += 4 * 6 * scale;
      continue;
    }
    drawChar(s, char(ch), cx, cy, scale, G.color);
    cx += 6 * scale;
  }
}

void fillPolygon(Surface &s, const std::vector<int> &pts, Color c) {
  if (pts.size() < 6) return;
  int minY = s.h, maxY = 0;
  for (size_t i = 1; i < pts.size(); i += 2) {
    minY = std::min(minY, pts[i]);
    maxY = std::max(maxY, pts[i]);
  }
  minY = clampInt(minY, 0, s.h - 1);
  maxY = clampInt(maxY, 0, s.h - 1);
  for (int y = minY; y <= maxY; ++y) {
    std::vector<int> xs;
    for (size_t i = 0, j = pts.size() - 2; i < pts.size(); j = i, i += 2) {
      int xi = pts[i], yi = pts[i + 1];
      int xj = pts[j], yj = pts[j + 1];
      if ((yi < y && yj >= y) || (yj < y && yi >= y)) {
        int x = xi + (y - yi) * (xj - xi) / (yj - yi);
        xs.push_back(x);
      }
    }
    std::sort(xs.begin(), xs.end());
    for (size_t i = 0; i + 1 < xs.size(); i += 2)
      for (int x = xs[i]; x <= xs[i + 1]; ++x) blendPixel(s, x, y, c);
  }
}

void drawRgbaToTarget(const uint8_t *rgba, int sw, int sh, int srcX, int srcY,
                      int srcW, int srcH, double x, double y, double rot,
                      double scaleX, double scaleY, double ox, double oy) {
  Surface &dst = *G.target;
  double cs = std::cos(rot);
  double sn = std::sin(rot);
  for (int yy = 0; yy < srcH; ++yy) {
    int sy = srcY + yy;
    if (sy < 0 || sy >= sh) continue;
    for (int xx = 0; xx < srcW; ++xx) {
      int sx = srcX + xx;
      if (sx < 0 || sx >= sw) continue;
      const uint8_t *p = rgba + (size_t(sy) * sw + sx) * 4;
      if (p[3] == 0) continue;
      double lx = (double(xx) - ox) * scaleX;
      double ly = (double(yy) - oy) * scaleY;
      int dx = int(std::lround(x + lx * cs - ly * sn));
      int dy = int(std::lround(y + lx * sn + ly * cs));
      Color c;
      c.r = uint8_t((int(p[0]) * int(G.color.r)) / 255);
      c.g = uint8_t((int(p[1]) * int(G.color.g)) / 255);
      c.b = uint8_t((int(p[2]) * int(G.color.b)) / 255);
      c.a = uint8_t((int(p[3]) * int(G.color.a)) / 255);
      blendPixel(dst, dx, dy, c);
    }
  }
}

void drawSurfaceToTarget(const Surface &src, int srcX, int srcY, int srcW, int srcH,
                         double x, double y, double rot, double scaleX,
                         double scaleY, double ox, double oy) {
  double cs = std::cos(rot);
  double sn = std::sin(rot);
  for (int yy = 0; yy < srcH; ++yy) {
    int sy = srcY + yy;
    if (sy < 0 || sy >= src.h) continue;
    for (int xx = 0; xx < srcW; ++xx) {
      int sx = srcX + xx;
      if (sx < 0 || sx >= src.w) continue;
      Color base = unpackBgra(src.bgra[size_t(sy) * src.w + sx]);
      if (base.a == 0) continue;
      double lx = (double(xx) - ox) * scaleX;
      double ly = (double(yy) - oy) * scaleY;
      int dx = int(std::lround(x + lx * cs - ly * sn));
      int dy = int(std::lround(y + lx * sn + ly * cs));
      Color c;
      c.r = uint8_t((int(base.r) * int(G.color.r)) / 255);
      c.g = uint8_t((int(base.g) * int(G.color.g)) / 255);
      c.b = uint8_t((int(base.b) * int(G.color.b)) / 255);
      c.a = uint8_t((int(base.a) * int(G.color.a)) / 255);
      blendPixel(*G.target, dx, dy, c);
    }
  }
}

void flushFramebuffer() {
  if (!G.fb || !G.target) return;
  const Surface &src = G.screen;
  for (int y = 0; y < G.fbH; ++y) {
    int sy = y * src.h / G.fbH;
    for (int x = 0; x < G.fbW; ++x) {
      int sx = x * src.w / G.fbW;
      G.fb[size_t(y) * G.fbW + x] = src.bgra[size_t(sy) * src.w + sx];
    }
  }
}

void drawSoftwareCursor() {
  if (G.presenter == Presenter::KmsGl) return;
  if (!G.mouseVisible || !G.target) return;
  const int x = G.mouseX;
  const int y = G.mouseY;
  const std::vector<int> pts = {
    x, y,
    x, y + 24,
    x + 7, y + 18,
    x + 11, y + 27,
    x + 16, y + 25,
    x + 12, y + 16,
    x + 20, y + 16,
  };
  auto stroke = [&](Color c) {
    for (size_t i = 0; i + 3 < pts.size(); i += 2)
      drawLine(*G.target, pts[i], pts[i + 1], pts[i + 2], pts[i + 3], c);
    drawLine(*G.target, pts[pts.size() - 2], pts[pts.size() - 1], pts[0], pts[1], c);
  };
  int oldLineWidth = G.lineWidth;
  G.lineWidth = 3;
  stroke(Color{0, 0, 0, 235});
  fillPolygon(*G.target, pts, Color{255, 255, 255, 245});
  G.lineWidth = 1;
  stroke(Color{0, 0, 0, 255});
  G.lineWidth = oldLineWidth;
}

void cleanupKmsGl() {
  if (G.glBuffer) {
    glDeleteBuffers(1, &G.glBuffer);
    G.glBuffer = 0;
  }
  if (G.glTexture) {
    glDeleteTextures(1, &G.glTexture);
    G.glTexture = 0;
  }
  if (G.glProgram) {
    glDeleteProgram(G.glProgram);
    G.glProgram = 0;
  }
  if (G.eglDisplay != EGL_NO_DISPLAY) {
    eglMakeCurrent(G.eglDisplay, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (G.eglSurface != EGL_NO_SURFACE) eglDestroySurface(G.eglDisplay, G.eglSurface);
    if (G.eglContext != EGL_NO_CONTEXT) eglDestroyContext(G.eglDisplay, G.eglContext);
    eglTerminate(G.eglDisplay);
  }
  G.eglDisplay = EGL_NO_DISPLAY;
  G.eglSurface = EGL_NO_SURFACE;
  G.eglContext = EGL_NO_CONTEXT;

  for (int i = 0; i < kKmsBoCount; ++i) {
    if (G.kmsFbIds[i] != 0 && G.drmFd >= 0) {
      drmModeRmFB(G.drmFd, G.kmsFbIds[i]);
      G.kmsFbIds[i] = 0;
    }
    if (G.kmsBos[i]) {
      gbm_bo_destroy(G.kmsBos[i]);
      G.kmsBos[i] = nullptr;
    }
  }
  if (G.gbm) {
    gbm_device_destroy(G.gbm);
    G.gbm = nullptr;
  }
  if (G.drmFd >= 0) {
    close(G.drmFd);
    G.drmFd = -1;
  }
}

bool compileShader(GLenum type, const char *source, GLuint *out) {
  GLuint shader = glCreateShader(type);
  glShaderSource(shader, 1, &source, nullptr);
  glCompileShader(shader);

  GLint ok = GL_FALSE;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (ok != GL_TRUE) {
    char log[512];
    GLsizei len = 0;
    glGetShaderInfoLog(shader, sizeof(log), &len, log);
    fprintf(stderr, "love: GLES shader compile failed: %.*s\n", int(len), log);
    glDeleteShader(shader);
    return false;
  }
  *out = shader;
  return true;
}

bool buildPresenterProgram() {
  static const char *vertexSource =
      "attribute vec2 a_position;\n"
      "attribute vec2 a_texcoord;\n"
      "varying vec2 v_texcoord;\n"
      "void main() {\n"
      "  gl_Position = vec4(a_position, 0.0, 1.0);\n"
      "  v_texcoord = a_texcoord;\n"
      "}\n";
  static const char *fragmentSource =
      "precision mediump float;\n"
      "uniform sampler2D u_frame;\n"
      "varying vec2 v_texcoord;\n"
      "void main() {\n"
      "  vec4 c = texture2D(u_frame, v_texcoord);\n"
      "  gl_FragColor = vec4(c.b, c.g, c.r, c.a);\n"
      "}\n";

  GLuint vs = 0;
  GLuint fs = 0;
  if (!compileShader(GL_VERTEX_SHADER, vertexSource, &vs)) return false;
  if (!compileShader(GL_FRAGMENT_SHADER, fragmentSource, &fs)) {
    glDeleteShader(vs);
    return false;
  }

  G.glProgram = glCreateProgram();
  glAttachShader(G.glProgram, vs);
  glAttachShader(G.glProgram, fs);
  glLinkProgram(G.glProgram);
  glDeleteShader(vs);
  glDeleteShader(fs);

  GLint ok = GL_FALSE;
  glGetProgramiv(G.glProgram, GL_LINK_STATUS, &ok);
  if (ok != GL_TRUE) {
    char log[512];
    GLsizei len = 0;
    glGetProgramInfoLog(G.glProgram, sizeof(log), &len, log);
    fprintf(stderr, "love: GLES program link failed: %.*s\n", int(len), log);
    glDeleteProgram(G.glProgram);
    G.glProgram = 0;
    return false;
  }

  G.glPositionLoc = glGetAttribLocation(G.glProgram, "a_position");
  G.glTexcoordLoc = glGetAttribLocation(G.glProgram, "a_texcoord");
  G.glSamplerLoc = glGetUniformLocation(G.glProgram, "u_frame");
  return G.glPositionLoc >= 0 && G.glTexcoordLoc >= 0 && G.glSamplerLoc >= 0;
}

int setupKmsGl() {
  G.drmFd = open("/dev/dri/card0", O_RDWR | O_NONBLOCK);
  if (G.drmFd < 0) {
    perror("open /dev/dri/card0");
    return 1;
  }
  if (drmSetMaster(G.drmFd) != 0) {
    perror("drmSetMaster");
    cleanupKmsGl();
    return 1;
  }

  drmModeResPtr res = drmModeGetResources(G.drmFd);
  if (!res || res->count_crtcs < 1 || res->count_connectors < 1) {
    fprintf(stderr, "love: drmModeGetResources returned no usable CRTC/connector\n");
    if (res) drmModeFreeResources(res);
    cleanupKmsGl();
    return 1;
  }
  G.kmsCrtcId = res->crtcs[0];
  G.kmsConnId = res->connectors[0];

  drmModeConnectorPtr conn = drmModeGetConnector(G.drmFd, G.kmsConnId);
  if (!conn || conn->connection != DRM_MODE_CONNECTED || conn->count_modes < 1) {
    fprintf(stderr, "love: drmModeGetConnector returned no connected mode\n");
    if (conn) drmModeFreeConnector(conn);
    drmModeFreeResources(res);
    cleanupKmsGl();
    return 1;
  }
  G.kmsMode = conn->modes[0];
  drmModeFreeConnector(conn);
  drmModeFreeResources(res);

  G.gbm = gbm_create_device(G.drmFd);
  if (!G.gbm) {
    perror("gbm_create_device");
    cleanupKmsGl();
    return 1;
  }

  for (int i = 0; i < kKmsBoCount; ++i) {
    G.kmsBos[i] = gbm_bo_create(G.gbm, kScanoutWidth, kScanoutHeight,
                                GBM_FORMAT_XRGB8888, GBM_BO_USE_SCANOUT);
    if (!G.kmsBos[i]) {
      perror("gbm_bo_create");
      cleanupKmsGl();
      return 1;
    }

    uint32_t handle = gbm_bo_get_handle(G.kmsBos[i]).u32;
    uint32_t stride = gbm_bo_get_stride(G.kmsBos[i]);
    uint32_t handles[4] = {handle, 0, 0, 0};
    uint32_t pitches[4] = {stride, 0, 0, 0};
    uint32_t offsets[4] = {0, 0, 0, 0};
    if (drmModeAddFB2(G.drmFd, kScanoutWidth, kScanoutHeight,
                      DRM_FORMAT_XRGB8888, handles, pitches, offsets,
                      &G.kmsFbIds[i], 0) != 0) {
      perror("drmModeAddFB2");
      cleanupKmsGl();
      return 1;
    }
  }

  int primeFd = gbm_bo_get_fd(G.kmsBos[0]);
  if (primeFd >= 0) close(primeFd);

  if (drmModeSetCrtc(G.drmFd, G.kmsCrtcId, G.kmsFbIds[0],
                     0, 0, &G.kmsConnId, 1, &G.kmsMode) != 0) {
    perror("drmModeSetCrtc");
    cleanupKmsGl();
    return 1;
  }

  G.eglDisplay = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  EGLint major = 0;
  EGLint minor = 0;
  if (!eglInitialize(G.eglDisplay, &major, &minor)) {
    fprintf(stderr, "love: eglInitialize failed: 0x%x\n", unsigned(eglGetError()));
    cleanupKmsGl();
    return 1;
  }

  EGLint cfgAttribs[] = {
      EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
      EGL_RED_SIZE, 8,
      EGL_GREEN_SIZE, 8,
      EGL_BLUE_SIZE, 8,
      EGL_ALPHA_SIZE, 8,
      EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
      EGL_NONE,
  };
  EGLConfig cfg = nullptr;
  EGLint numCfg = 0;
  if (!eglChooseConfig(G.eglDisplay, cfgAttribs, &cfg, 1, &numCfg) || numCfg < 1) {
    fprintf(stderr, "love: eglChooseConfig failed: 0x%x\n", unsigned(eglGetError()));
    cleanupKmsGl();
    return 1;
  }
  if (!eglBindAPI(EGL_OPENGL_ES_API)) {
    fprintf(stderr, "love: eglBindAPI failed: 0x%x\n", unsigned(eglGetError()));
    cleanupKmsGl();
    return 1;
  }

  EGLint ctxAttribs[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
  G.eglContext = eglCreateContext(G.eglDisplay, cfg, EGL_NO_CONTEXT, ctxAttribs);
  if (G.eglContext == EGL_NO_CONTEXT) {
    fprintf(stderr, "love: eglCreateContext failed: 0x%x\n", unsigned(eglGetError()));
    cleanupKmsGl();
    return 1;
  }
  G.eglSurface = eglCreateWindowSurface(G.eglDisplay, cfg, 0, nullptr);
  if (G.eglSurface == EGL_NO_SURFACE) {
    fprintf(stderr, "love: eglCreateWindowSurface failed: 0x%x\n", unsigned(eglGetError()));
    cleanupKmsGl();
    return 1;
  }
  if (!eglMakeCurrent(G.eglDisplay, G.eglSurface, G.eglSurface, G.eglContext)) {
    fprintf(stderr, "love: eglMakeCurrent failed: 0x%x\n", unsigned(eglGetError()));
    cleanupKmsGl();
    return 1;
  }

  if (!buildPresenterProgram()) {
    cleanupKmsGl();
    return 1;
  }

  glGenTextures(1, &G.glTexture);
  glBindTexture(GL_TEXTURE_2D, G.glTexture);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, kLogicalWidth, kLogicalHeight, 0,
               GL_RGBA, GL_UNSIGNED_BYTE, G.screen.bgra.data());

  const GLfloat verts[] = {
      -1.0f, -1.0f, 0.0f, 1.0f,
       1.0f, -1.0f, 1.0f, 1.0f,
      -1.0f,  1.0f, 0.0f, 0.0f,
       1.0f,  1.0f, 1.0f, 0.0f,
  };
  glGenBuffers(1, &G.glBuffer);
  glBindBuffer(GL_ARRAY_BUFFER, G.glBuffer);
  glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
  glViewport(0, 0, kScanoutWidth, kScanoutHeight);
  glDisable(GL_DEPTH_TEST);
  glDisable(GL_STENCIL_TEST);
  glDisable(GL_BLEND);
  G.presenter = Presenter::KmsGl;
  fprintf(stderr, "love: using KMS/EGL/GLES presenter on /dev/dri/card0\n");
  return 0;
}

int kmsPageflipWait() {
  int nextFb = G.kmsCurrentFb ^ 1;
  if (drmModePageFlip(G.drmFd, G.kmsCrtcId, G.kmsFbIds[nextFb],
                      DRM_MODE_PAGE_FLIP_EVENT, nullptr) != 0) {
    perror("drmModePageFlip");
    return 1;
  }

  struct drm_event_vblank ev{};
  for (;;) {
    ssize_t n = read(G.drmFd, &ev, sizeof(ev));
    if (n == ssize_t(sizeof(ev))) break;
    if (n < 0 && errno == EAGAIN) {
      usleep(1000);
      continue;
    }
    fprintf(stderr, "love: DRM event read failed: n=%zd errno=%d\n", n, errno);
    return 1;
  }
  G.kmsCurrentFb = nextFb;
  return 0;
}

void flushKmsGl() {
  if (G.presenter != Presenter::KmsGl) return;
  glViewport(0, 0, kScanoutWidth, kScanoutHeight);
  glUseProgram(G.glProgram);
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, G.glTexture);
  glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, kLogicalWidth, kLogicalHeight,
                  GL_RGBA, GL_UNSIGNED_BYTE, G.screen.bgra.data());
  glUniform1i(G.glSamplerLoc, 0);
  glBindBuffer(GL_ARRAY_BUFFER, G.glBuffer);
  glEnableVertexAttribArray(GLuint(G.glPositionLoc));
  glEnableVertexAttribArray(GLuint(G.glTexcoordLoc));
  glVertexAttribPointer(GLuint(G.glPositionLoc), 2, GL_FLOAT, GL_FALSE,
                        4 * sizeof(GLfloat), reinterpret_cast<void *>(0));
  glVertexAttribPointer(GLuint(G.glTexcoordLoc), 2, GL_FLOAT, GL_FALSE,
                        4 * sizeof(GLfloat), reinterpret_cast<void *>(2 * sizeof(GLfloat)));
  glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
  if (!eglSwapBuffers(G.eglDisplay, G.eglSurface)) {
    fprintf(stderr, "love: eglSwapBuffers failed: 0x%x\n", unsigned(eglGetError()));
    gRunning = 0;
    return;
  }
  if (kmsPageflipWait() != 0) gRunning = 0;
}

int openFramebuffer() {
  G.fbFd = open("/dev/fb0", O_RDWR);
  if (G.fbFd < 0) {
    perror("open /dev/fb0");
    return 1;
  }
  fb_var_screeninfo v{};
  fb_fix_screeninfo f{};
  if (ioctl(G.fbFd, FBIOGET_VSCREENINFO, &v) == 0) {
    G.fbW = int(v.xres);
    G.fbH = int(v.yres);
  }
  if (ioctl(G.fbFd, FBIOGET_FSCREENINFO, &f) == 0) {
    G.fbLen = f.smem_len;
  } else {
    G.fbLen = size_t(G.fbW) * G.fbH * 4;
  }
  G.fb = static_cast<uint32_t *>(
    mmap(nullptr, G.fbLen, PROT_READ | PROT_WRITE, MAP_SHARED, G.fbFd, 0));
  if (G.fb == MAP_FAILED) {
    G.fb = nullptr;
    perror("mmap /dev/fb0");
    return 1;
  }
  G.presenter = Presenter::Framebuffer;
  fprintf(stderr, "love: using /dev/fb0 presenter\n");
  return 0;
}

int openPresenter() {
  if (setupKmsGl() == 0) return 0;
  fprintf(stderr, "love: falling back to /dev/fb0 presenter\n");
  return openFramebuffer();
}

void presentFrame() {
  if (G.presenter == Presenter::KmsGl) flushKmsGl();
  else flushFramebuffer();
}

void cleanupPresenter() {
  if (G.presenter == Presenter::KmsGl) cleanupKmsGl();
  if (G.fb) {
    munmap(G.fb, G.fbLen);
    G.fb = nullptr;
  }
  if (G.fbFd >= 0) {
    close(G.fbFd);
    G.fbFd = -1;
  }
  G.presenter = Presenter::None;
}

void configureRawStdin() {
  termios tio{};
  if (tcgetattr(STDIN_FILENO, &tio) != 0) return;
  G.savedTermios = tio;
  G.haveSavedTermios = true;
  tio.c_iflag &= ~(ICRNL | IXON);
  tio.c_lflag &= ~(ICANON | ECHO | ISIG);
  tio.c_cc[VMIN] = 0;
  tio.c_cc[VTIME] = 0;
  tcsetattr(STDIN_FILENO, TCSANOW, &tio);
}

void restoreStdin() {
  if (G.haveSavedTermios) tcsetattr(STDIN_FILENO, TCSANOW, &G.savedTermios);
  if (G.savedStdinFlags >= 0) fcntl(STDIN_FILENO, F_SETFL, G.savedStdinFlags);
}

std::string keyName(int code) {
  static const std::map<int, std::string> names = {
    {1, "escape"}, {14, "backspace"}, {15, "tab"}, {28, "return"},
    {57, "space"}, {103, "up"}, {108, "down"}, {105, "left"},
    {106, "right"}, {102, "home"}, {107, "end"}, {110, "insert"},
    {111, "delete"}, {104, "pageup"}, {109, "pagedown"},
    {2, "1"}, {3, "2"}, {4, "3"}, {5, "4"}, {6, "5"},
    {7, "6"}, {8, "7"}, {9, "8"}, {10, "9"}, {11, "0"},
    {16, "q"}, {17, "w"}, {18, "e"}, {19, "r"}, {20, "t"},
    {21, "y"}, {22, "u"}, {23, "i"}, {24, "o"}, {25, "p"},
    {30, "a"}, {31, "s"}, {32, "d"}, {33, "f"}, {34, "g"},
    {35, "h"}, {36, "j"}, {37, "k"}, {38, "l"},
    {44, "z"}, {45, "x"}, {46, "c"}, {47, "v"}, {48, "b"},
    {49, "n"}, {50, "m"},
  };
  auto it = names.find(code);
  return it == names.end() ? "" : it->second;
}

void pollInput() {
  G.keyEvents.clear();
  G.mouseEvents.clear();
  G.mouseDx = 0;
  G.mouseDy = 0;

  uint8_t buf[128];
  for (;;) {
    ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
    if (n <= 0) break;
    for (ssize_t i = 0; i < n; ++i) {
      bool pressed = (buf[i] & 0x80) == 0;
      int code = buf[i] & 0x7f;
      std::string key = keyName(code);
      if (key.empty()) continue;
      if (pressed) G.keys.insert(key);
      else G.keys.erase(key);
      G.keyEvents.push_back({key, pressed});
    }
  }

  if (G.miceFd < 0) return;
  uint8_t pkt[3];
  int newButtons = G.mouseButtons;
  for (;;) {
    ssize_t n = read(G.miceFd, pkt, 3);
    if (n != 3) break;
    int dx = int(int8_t(pkt[1]));
    int dy = -int(int8_t(pkt[2]));
    if (G.presenter == Presenter::KmsGl) {
      G.mouseRemainderX += double(dx) * double(kLogicalWidth) / double(kScanoutWidth);
      G.mouseRemainderY += double(dy) * double(kLogicalHeight) / double(kScanoutHeight);
      dx = int(std::trunc(G.mouseRemainderX));
      dy = int(std::trunc(G.mouseRemainderY));
      G.mouseRemainderX -= double(dx);
      G.mouseRemainderY -= double(dy);
    }
    G.mouseDx += dx;
    G.mouseDy += dy;
    G.mouseX = clampInt(G.mouseX + dx, 0, kLogicalWidth - 1);
    G.mouseY = clampInt(G.mouseY + dy, 0, kLogicalHeight - 1);
    newButtons = pkt[0] & 0x07;
  }
  int changed = G.mouseButtons ^ newButtons;
  for (int bit = 0; bit < 3; ++bit) {
    if ((changed & (1 << bit)) == 0) continue;
    int button = bit == 0 ? 1 : (bit == 1 ? 2 : 3);
    G.mouseEvents.push_back({button, (newButtons & (1 << bit)) != 0});
  }
  G.mouseButtons = newButtons;
}

void signalHandler(int) {
  gRunning = 0;
}

int gcImage(lua_State *L) { delete checkObj<Image>(L, 1, MT_IMAGE); return 0; }
int gcImageData(lua_State *L) { delete checkObj<ImageData>(L, 1, MT_IMAGEDATA); return 0; }
int gcCanvas(lua_State *L) { delete checkObj<Surface>(L, 1, MT_CANVAS); return 0; }
int gcQuad(lua_State *L) { delete checkObj<Quad>(L, 1, MT_QUAD); return 0; }
int gcText(lua_State *L) { delete checkObj<Text>(L, 1, MT_TEXT); return 0; }
int gcMesh(lua_State *L) { delete checkObj<Mesh>(L, 1, MT_MESH); return 0; }
int gcSource(lua_State *L) { delete checkObj<Source>(L, 1, MT_SOURCE); return 0; }
int gcFile(lua_State *L) {
  FileHandle *f = checkObj<FileHandle>(L, 1, MT_FILE);
  if (f->fp) fclose(f->fp);
  delete f;
  return 0;
}
int gcVideo(lua_State *L) { delete checkObj<Video>(L, 1, MT_VIDEO); return 0; }
int gcShape(lua_State *L) { delete checkObj<Shape>(L, 1, MT_SHAPE); return 0; }
int gcFixture(lua_State *L) {
  Fixture *f = checkObj<Fixture>(L, 1, MT_FIXTURE);
  if (f->userDataRef != LUA_NOREF) luaL_unref(L, LUA_REGISTRYINDEX, f->userDataRef);
  delete f->shape;
  delete f;
  return 0;
}

// ── love.graphics ─────────────────────────────────────────────────────────

int l_g_getWidth(lua_State *L) { lua_pushinteger(L, kLogicalWidth); return 1; }
int l_g_getHeight(lua_State *L) { lua_pushinteger(L, kLogicalHeight); return 1; }
int l_g_getDimensions(lua_State *L) { lua_pushinteger(L, kLogicalWidth); lua_pushinteger(L, kLogicalHeight); return 2; }

int l_g_setColor(lua_State *L) { G.color = readColor(L, 1); return 0; }
int l_g_setBackgroundColor(lua_State *L) { G.background = readColor(L, 1); return 0; }
int l_g_setLineWidth(lua_State *L) { G.lineWidth = std::max(1, int(luaL_checkinteger(L, 1))); return 0; }
int l_g_getLineWidth(lua_State *L) { lua_pushinteger(L, G.lineWidth); return 1; }
int l_g_setLineStyle(lua_State *) { return 0; }
int l_g_setBlendMode(lua_State *) { return 0; }
int l_g_setShader(lua_State *) { return 0; }
int l_g_setDefaultFilter(lua_State *) { return 0; }
int l_g_isActive(lua_State *L) { lua_pushboolean(L, 1); return 1; }
int l_g_present(lua_State *) { return 0; }

int l_g_getColor(lua_State *L) {
  lua_pushinteger(L, G.color.r); lua_pushinteger(L, G.color.g);
  lua_pushinteger(L, G.color.b); lua_pushinteger(L, G.color.a);
  return 4;
}

int l_g_getBackgroundColor(lua_State *L) {
  lua_pushinteger(L, G.background.r); lua_pushinteger(L, G.background.g);
  lua_pushinteger(L, G.background.b); lua_pushinteger(L, G.background.a);
  return 4;
}

int l_g_getScissor(lua_State *L) {
  if (!G.scissor) return 0;
  lua_pushinteger(L, G.sx); lua_pushinteger(L, G.sy);
  lua_pushinteger(L, G.sw); lua_pushinteger(L, G.sh);
  return 4;
}

int l_g_push(lua_State *) {
  G.transformStack.push_back(G.transform);
  return 0;
}

int l_g_pop(lua_State *L) {
  if (G.transformStack.empty()) return luaL_error(L, "graphics transform stack underflow");
  G.transform = G.transformStack.back();
  G.transformStack.pop_back();
  return 0;
}

int l_g_origin(lua_State *) {
  G.transform = Transform{};
  return 0;
}

int l_g_scale(lua_State *L) {
  double sx = luaL_checknumber(L, 1);
  double sy = luaL_optnumber(L, 2, sx);
  appendTransform(Transform{sx, 0, 0, sy, 0, 0});
  return 0;
}

int l_g_rotate(lua_State *L) {
  double r = luaL_checknumber(L, 1);
  double cs = std::cos(r), sn = std::sin(r);
  appendTransform(Transform{cs, sn, -sn, cs, 0, 0});
  return 0;
}

int l_g_clear(lua_State *L) {
  clearSurface(*G.target, lua_gettop(L) > 0 ? readColor(L, 1) : G.background);
  return 0;
}

int l_g_newFont(lua_State *L) {
  int size = 11;
  if (lua_isnumber(L, 1)) size = int(lua_tointeger(L, 1));
  else if (lua_isnumber(L, 2)) size = int(lua_tointeger(L, 2));
  Font *f = new Font{std::max(1, size)};
  pushObj(L, f, MT_FONT);
  return 1;
}

int l_g_setFont(lua_State *L) {
  G.font = checkObj<Font>(L, 1, MT_FONT);
  return 0;
}

int l_g_getFont(lua_State *L) {
  pushObj(L, G.font, MT_FONT);
  return 1;
}

int l_font_getHeight(lua_State *L) {
  Font *f = checkObj<Font>(L, 1, MT_FONT);
  lua_pushinteger(L, std::max(8, f->size));
  return 1;
}

int l_font_getWidth(lua_State *L) {
  Font *f = checkObj<Font>(L, 1, MT_FONT);
  std::string s = printableText(L, 2);
  int scale = std::max(1, f->size / 8);
  lua_pushinteger(L, int(s.size()) * 6 * scale);
  return 1;
}
int l_font_setFilter(lua_State *) { return 0; }

int l_g_print(lua_State *L) {
  std::string s = printableText(L, 1);
  int arg = 2;
  Font *savedFont = G.font;
  if (hasMeta(L, 2, MT_FONT)) {
    G.font = checkObj<Font>(L, 2, MT_FONT);
    arg = 3;
  } else if ((lua_isnil(L, 2) || lua_isboolean(L, 2)) && lua_gettop(L) >= 3) {
    arg = 3;
  }
  double x = luaL_optnumber(L, arg, 0);
  double y = luaL_optnumber(L, arg + 1, 0);
  double r = luaL_optnumber(L, arg + 2, 0);
  double sx = luaL_optnumber(L, arg + 3, 1);
  double sy = luaL_optnumber(L, arg + 4, sx);
  double ox = luaL_optnumber(L, arg + 5, 0);
  double oy = luaL_optnumber(L, arg + 6, 0);
  Transform saved = G.transform;
  appendTransform(Transform{1, 0, 0, 1, x, y});
  if (r != 0) {
    double cs = std::cos(r), sn = std::sin(r);
    appendTransform(Transform{cs, sn, -sn, cs, 0, 0});
  }
  appendTransform(Transform{sx, 0, 0, sy, -ox * sx, -oy * sy});
  drawText(*G.target, s, 0, 0);
  G.transform = saved;
  G.font = savedFont;
  return 0;
}

int l_g_rectangle(lua_State *L) {
  std::string mode = luaL_checkstring(L, 1);
  int x = int(luaL_checknumber(L, 2));
  int y = int(luaL_checknumber(L, 3));
  int w = int(luaL_checknumber(L, 4));
  int h = int(luaL_checknumber(L, 5));
  if (mode == "fill") {
    for (int yy = 0; yy < h; ++yy)
      for (int xx = 0; xx < w; ++xx)
        blendPixel(*G.target, x + xx, y + yy, G.color);
  } else {
    drawLine(*G.target, x, y, x + w, y, G.color);
    drawLine(*G.target, x + w, y, x + w, y + h, G.color);
    drawLine(*G.target, x + w, y + h, x, y + h, G.color);
    drawLine(*G.target, x, y + h, x, y, G.color);
  }
  return 0;
}

int l_g_line(lua_State *L) {
  std::vector<double> nums = collectNumbers(L, 1);
  if (nums.size() < 4) return 0;
  std::vector<int> pts;
  for (double n : nums) pts.push_back(int(n));
  for (size_t i = 0; i + 3 < pts.size(); i += 2)
    drawLine(*G.target, pts[i], pts[i + 1], pts[i + 2], pts[i + 3], G.color);
  return 0;
}

int l_g_circle(lua_State *L) {
  std::string mode = luaL_checkstring(L, 1);
  int cx = int(luaL_checknumber(L, 2));
  int cy = int(luaL_checknumber(L, 3));
  int r = int(luaL_checknumber(L, 4));
  if (mode == "fill") {
    for (int y = -r; y <= r; ++y)
      for (int x = -r; x <= r; ++x)
        if (x * x + y * y <= r * r) blendPixel(*G.target, cx + x, cy + y, G.color);
  } else {
    int seg = std::max(12, int(luaL_optinteger(L, 5, 40)));
    int px = cx + r, py = cy;
    for (int i = 1; i <= seg; ++i) {
      double a = i * 2.0 * kPi / seg;
      int x = cx + int(std::lround(std::cos(a) * r));
      int y = cy + int(std::lround(std::sin(a) * r));
      drawLine(*G.target, px, py, x, y, G.color);
      px = x; py = y;
    }
  }
  return 0;
}

int l_g_arc(lua_State *L) {
  std::string mode = luaL_checkstring(L, 1);
  int arg = 2;
  if (lua_isstring(L, 2)) arg = 3;
  int cx = int(luaL_checknumber(L, arg));
  int cy = int(luaL_checknumber(L, arg + 1));
  int r = int(luaL_checknumber(L, arg + 2));
  double a0 = luaL_checknumber(L, arg + 3);
  double a1 = luaL_checknumber(L, arg + 4);
  int seg = std::max(8, int(std::ceil(std::abs(a1 - a0) * 12.0)));
  std::vector<int> pts;
  if (mode == "fill") {
    pts.push_back(cx);
    pts.push_back(cy);
  }
  for (int i = 0; i <= seg; ++i) {
    double t = a0 + (a1 - a0) * double(i) / double(seg);
    pts.push_back(cx + int(std::lround(std::cos(t) * r)));
    pts.push_back(cy + int(std::lround(std::sin(t) * r)));
  }
  if (mode == "fill") fillPolygon(*G.target, pts, G.color);
  else {
    for (size_t i = 0; i + 3 < pts.size(); i += 2)
      drawLine(*G.target, pts[i], pts[i + 1], pts[i + 2], pts[i + 3], G.color);
  }
  return 0;
}

int l_g_ellipse(lua_State *L) {
  std::string mode = luaL_checkstring(L, 1);
  int cx = int(luaL_checknumber(L, 2));
  int cy = int(luaL_checknumber(L, 3));
  int rx = std::max(1, int(luaL_checknumber(L, 4)));
  int ry = std::max(1, int(luaL_checknumber(L, 5)));
  if (mode == "fill") {
    for (int y = -ry; y <= ry; ++y)
      for (int x = -rx; x <= rx; ++x)
        if ((double(x) * x) / (rx * rx) + (double(y) * y) / (ry * ry) <= 1.0)
          blendPixel(*G.target, cx + x, cy + y, G.color);
  } else {
    int seg = 48;
    int px = cx + rx, py = cy;
    for (int i = 1; i <= seg; ++i) {
      double a = i * 2.0 * kPi / seg;
      int x = cx + int(std::lround(std::cos(a) * rx));
      int y = cy + int(std::lround(std::sin(a) * ry));
      drawLine(*G.target, px, py, x, y, G.color);
      px = x; py = y;
    }
  }
  return 0;
}

int l_g_polygon(lua_State *L) {
  std::string mode = luaL_checkstring(L, 1);
  std::vector<double> nums = collectNumbers(L, 2);
  std::vector<int> pts;
  for (double n : nums) pts.push_back(int(n));
  if (mode == "fill") fillPolygon(*G.target, pts, G.color);
  else {
    for (size_t i = 0; i + 3 < pts.size(); i += 2)
      drawLine(*G.target, pts[i], pts[i + 1], pts[i + 2], pts[i + 3], G.color);
    if (pts.size() >= 6)
      drawLine(*G.target, pts[pts.size() - 2], pts[pts.size() - 1], pts[0], pts[1], G.color);
  }
  return 0;
}

int l_g_point(lua_State *L) {
  blendPixel(*G.target, int(luaL_checknumber(L, 1)), int(luaL_checknumber(L, 2)), G.color);
  return 0;
}

int l_g_stencil(lua_State *L) {
  if (lua_isfunction(L, 1)) {
    lua_pushvalue(L, 1);
    lua_call(L, 0, 0);
  }
  return 0;
}
int l_g_setStencilTest(lua_State *) { return 0; }

int l_g_getSystemLimits(lua_State *L) {
  lua_newtable(L);
  lua_pushinteger(L, 1); lua_setfield(L, -2, "anisotropy");
  lua_pushinteger(L, 0); lua_setfield(L, -2, "canvasmsaa");
  return 1;
}
int l_g_getSupported(lua_State *L) { lua_newtable(L); return 1; }
int l_g_getRendererInfo(lua_State *L) {
  lua_pushstring(L, "Kandelo");
  lua_pushstring(L, G.presenter == Presenter::KmsGl ? "love-kms-gles" : "lovefb");
  lua_pushstring(L, G.presenter == Presenter::KmsGl ? "GLES2" : "software");
  lua_pushstring(L, "1.0");
  return 4;
}
int l_g_getImageFormats(lua_State *L) {
  lua_newtable(L);
  lua_pushboolean(L, 1); lua_setfield(L, -2, "png");
  return 1;
}
int l_g_getCanvasFormats(lua_State *L) {
  lua_newtable(L);
  lua_pushboolean(L, 1); lua_setfield(L, -2, "normal");
  return 1;
}
int l_g_getStats(lua_State *L) { lua_newtable(L); return 1; }

int l_g_setScissor(lua_State *L) {
  if (lua_gettop(L) == 0 || lua_isnil(L, 1)) {
    G.scissor = false;
    return 0;
  }
  G.scissor = true;
  G.sx = int(luaL_checknumber(L, 1));
  G.sy = int(luaL_checknumber(L, 2));
  G.sw = int(luaL_checknumber(L, 3));
  G.sh = int(luaL_checknumber(L, 4));
  return 0;
}

int l_g_translate(lua_State *L) {
  appendTransform(Transform{1, 0, 0, 1, luaL_checknumber(L, 1), luaL_checknumber(L, 2)});
  return 0;
}

int l_g_newImage(lua_State *L) {
  ImageData data;
  if (lua_type(L, 1) == LUA_TSTRING) {
    if (!loadPng(lua_tostring(L, 1), data)) return luaL_error(L, "could not load image");
  } else {
    ImageData *src = checkObj<ImageData>(L, 1, MT_IMAGEDATA);
    data = *src;
  }
  Image *img = new Image;
  img->w = data.w;
  img->h = data.h;
  img->rgba = data.rgba;
  pushObj(L, img, MT_IMAGE);
  return 1;
}

int l_img_getWidth(lua_State *L) { lua_pushinteger(L, checkObj<Image>(L, 1, MT_IMAGE)->w); return 1; }
int l_img_getHeight(lua_State *L) { lua_pushinteger(L, checkObj<Image>(L, 1, MT_IMAGE)->h); return 1; }
int l_img_getDimensions(lua_State *L) {
  Image *img = checkObj<Image>(L, 1, MT_IMAGE);
  lua_pushinteger(L, img->w); lua_pushinteger(L, img->h); return 2;
}

int l_g_newCanvas(lua_State *L) {
  int w = int(luaL_optinteger(L, 1, kLogicalWidth));
  int h = int(luaL_optinteger(L, 2, kLogicalHeight));
  Surface *s = new Surface{w, h, std::vector<uint32_t>(size_t(w) * h, 0)};
  pushObj(L, s, MT_CANVAS);
  return 1;
}

int l_canvas_getWidth(lua_State *L) { lua_pushinteger(L, checkObj<Surface>(L, 1, MT_CANVAS)->w); return 1; }
int l_canvas_getHeight(lua_State *L) { lua_pushinteger(L, checkObj<Surface>(L, 1, MT_CANVAS)->h); return 1; }

int l_g_setCanvas(lua_State *L) {
  if (lua_gettop(L) == 0 || lua_isnil(L, 1)) G.target = &G.screen;
  else if (lua_istable(L, 1)) {
    lua_rawgeti(L, 1, 1);
    G.target = checkObj<Surface>(L, -1, MT_CANVAS);
    lua_pop(L, 1);
  } else G.target = checkObj<Surface>(L, 1, MT_CANVAS);
  return 0;
}

int l_g_newQuad(lua_State *L) {
  Quad *q = new Quad;
  q->x = int(luaL_checknumber(L, 1));
  q->y = int(luaL_checknumber(L, 2));
  q->w = int(luaL_checknumber(L, 3));
  q->h = int(luaL_checknumber(L, 4));
  q->sw = int(luaL_optnumber(L, 5, q->w));
  q->sh = int(luaL_optnumber(L, 6, q->h));
  pushObj(L, q, MT_QUAD);
  return 1;
}

int l_quad_getWidth(lua_State *L) { lua_pushinteger(L, checkObj<Quad>(L, 1, MT_QUAD)->w); return 1; }
int l_quad_getHeight(lua_State *L) { lua_pushinteger(L, checkObj<Quad>(L, 1, MT_QUAD)->h); return 1; }

int l_g_newText(lua_State *L) {
  Text *t = new Text;
  t->font = checkObj<Font>(L, 1, MT_FONT);
  if (lua_gettop(L) >= 2) t->text = printableText(L, 2);
  pushObj(L, t, MT_TEXT);
  return 1;
}

int l_text_getWidth(lua_State *L) {
  Text *t = checkObj<Text>(L, 1, MT_TEXT);
  int scale = std::max(1, (t->font ? t->font->size : G.font->size) / 8);
  lua_pushinteger(L, int(t->text.size()) * 6 * scale);
  return 1;
}

int l_text_getHeight(lua_State *L) {
  Text *t = checkObj<Text>(L, 1, MT_TEXT);
  lua_pushinteger(L, std::max(8, t->font ? t->font->size : G.font->size));
  return 1;
}

int l_g_newMesh(lua_State *L) {
  Mesh *m = new Mesh;
  if (lua_istable(L, 1)) {
    int n = int(lua_objlen(L, 1));
    for (int i = 1; i <= n; ++i) {
      lua_rawgeti(L, 1, i);
      if (lua_istable(L, -1)) {
        lua_rawgeti(L, -1, 1);
        lua_rawgeti(L, -2, 2);
        m->points.push_back(luaL_optnumber(L, -2, 0));
        m->points.push_back(luaL_optnumber(L, -1, 0));
        lua_pop(L, 2);
      }
      lua_pop(L, 1);
    }
  }
  pushObj(L, m, MT_MESH);
  return 1;
}

int l_g_draw(lua_State *L) {
  int arg = 2;
  Quad *q = nullptr;
  int srcX = 0, srcY = 0, srcW = 0, srcH = 0, srcFullW = 0, srcFullH = 0;
  const uint8_t *rgba = nullptr;
  Surface *surface = nullptr;

  if (Image *img = toObj<Image>(L, 1, MT_IMAGE)) {
    rgba = img->rgba.data(); srcFullW = srcW = img->w; srcFullH = srcH = img->h;
  } else if (Surface *can = toObj<Surface>(L, 1, MT_CANVAS)) {
    surface = can; srcFullW = srcW = can->w; srcFullH = srcH = can->h;
  } else if (Text *text = toObj<Text>(L, 1, MT_TEXT)) {
    Font *savedFont = G.font;
    Transform savedTransform = G.transform;
    if (text->font) G.font = text->font;
    double x = luaL_optnumber(L, 2, 0);
    double y = luaL_optnumber(L, 3, 0);
    double r = luaL_optnumber(L, 4, 0);
    double sx = luaL_optnumber(L, 5, 1);
    double sy = luaL_optnumber(L, 6, sx);
    double ox = luaL_optnumber(L, 7, 0);
    double oy = luaL_optnumber(L, 8, 0);
    appendTransform(Transform{1, 0, 0, 1, x, y});
    if (r != 0) {
      double cs = std::cos(r), sn = std::sin(r);
      appendTransform(Transform{cs, sn, -sn, cs, 0, 0});
    }
    appendTransform(Transform{sx, 0, 0, sy, -ox * sx, -oy * sy});
    drawText(*G.target, text->text, 0, 0);
    G.transform = savedTransform;
    G.font = savedFont;
    return 0;
  } else if (Mesh *mesh = toObj<Mesh>(L, 1, MT_MESH)) {
    std::vector<int> pts;
    double x = luaL_optnumber(L, 2, 0);
    double y = luaL_optnumber(L, 3, 0);
    for (size_t i = 0; i + 1 < mesh->points.size(); i += 2) {
      pts.push_back(int(std::lround(mesh->points[i] + x)));
      pts.push_back(int(std::lround(mesh->points[i + 1] + y)));
    }
    fillPolygon(*G.target, pts, G.color);
    return 0;
  } else if (toObj<Video>(L, 1, MT_VIDEO)) {
    int x = int(luaL_optnumber(L, 2, 0));
    int y = int(luaL_optnumber(L, 3, 0));
    for (int yy = 0; yy < 180; ++yy)
      for (int xx = 0; xx < 320; ++xx)
        blendPixel(*G.target, x + xx, y + yy, Color{25, 25, 25, 255});
    for (int yy = 0; yy < 180; ++yy)
      for (int xx = 0; xx < 320; ++xx)
        if ((xx + yy) % 19 == 0) blendPixel(*G.target, x + xx, y + yy, Color{180, 180, 180, 255});
    return 0;
  } else {
    return 0;
  }

  if (hasMeta(L, 2, MT_QUAD)) {
    q = checkObj<Quad>(L, 2, MT_QUAD);
    srcX = q->x; srcY = q->y; srcW = q->w; srcH = q->h;
    arg = 3;
  }
  double x = luaL_optnumber(L, arg, 0);
  double y = luaL_optnumber(L, arg + 1, 0);
  double r = luaL_optnumber(L, arg + 2, 0);
  double sx = luaL_optnumber(L, arg + 3, 1);
  double sy = luaL_optnumber(L, arg + 4, sx);
  double ox = luaL_optnumber(L, arg + 5, 0);
  double oy = luaL_optnumber(L, arg + 6, 0);
  if (surface) drawSurfaceToTarget(*surface, srcX, srcY, srcW, srcH, x, y, r, sx, sy, ox, oy);
  else drawRgbaToTarget(rgba, srcFullW, srcFullH, srcX, srcY, srcW, srcH, x, y, r, sx, sy, ox, oy);
  return 0;
}

int l_g_newShader(lua_State *L) {
  lua_newuserdata(L, 1);
  luaL_getmetatable(L, MT_SHADER);
  lua_setmetatable(L, -2);
  return 1;
}
int l_shader_send(lua_State *) { return 0; }

int l_g_newVideo(lua_State *L) {
  (void)L;
  pushObj(L, new Video, MT_VIDEO);
  return 1;
}
int l_video_getWidth(lua_State *L) { lua_pushinteger(L, checkObj<Video>(L, 1, MT_VIDEO)->w); return 1; }
int l_video_getHeight(lua_State *L) { lua_pushinteger(L, checkObj<Video>(L, 1, MT_VIDEO)->h); return 1; }
int l_video_play(lua_State *L) { checkObj<Video>(L, 1, MT_VIDEO)->playing = true; return 0; }
int l_video_pause(lua_State *L) { checkObj<Video>(L, 1, MT_VIDEO)->playing = false; return 0; }
int l_video_isPlaying(lua_State *L) { lua_pushboolean(L, checkObj<Video>(L, 1, MT_VIDEO)->playing); return 1; }
int l_video_seek(lua_State *L) { checkObj<Video>(L, 1, MT_VIDEO)->t = luaL_optnumber(L, 2, 0); return 0; }
int l_video_tell(lua_State *L) { lua_pushnumber(L, checkObj<Video>(L, 1, MT_VIDEO)->t); return 1; }
int l_video_source_setVolume(lua_State *) { return 0; }
int l_video_getSource(lua_State *L) {
  lua_newtable(L);
  addFunc(L, "setVolume", l_video_source_setVolume);
  return 1;
}

// ── love.image ────────────────────────────────────────────────────────────

int l_image_newImageData(lua_State *L) {
  ImageData *img = new ImageData;
  if (lua_type(L, 1) == LUA_TSTRING) {
    if (!loadPng(lua_tostring(L, 1), *img)) {
      delete img;
      return luaL_error(L, "could not load image data");
    }
  } else {
    img->w = int(luaL_checkinteger(L, 1));
    img->h = int(luaL_checkinteger(L, 2));
    img->rgba.assign(size_t(img->w) * img->h * 4, 0);
  }
  pushObj(L, img, MT_IMAGEDATA);
  return 1;
}

int l_id_getWidth(lua_State *L) { lua_pushinteger(L, checkObj<ImageData>(L, 1, MT_IMAGEDATA)->w); return 1; }
int l_id_getHeight(lua_State *L) { lua_pushinteger(L, checkObj<ImageData>(L, 1, MT_IMAGEDATA)->h); return 1; }
int l_id_paste(lua_State *L) {
  ImageData *dst = checkObj<ImageData>(L, 1, MT_IMAGEDATA);
  ImageData *src = checkObj<ImageData>(L, 2, MT_IMAGEDATA);
  int ox = int(luaL_optnumber(L, 3, 0));
  int oy = int(luaL_optnumber(L, 4, 0));
  for (int y = 0; y < src->h; ++y) {
    for (int x = 0; x < src->w; ++x) {
      int dx = ox + x, dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= dst->w || dy >= dst->h) continue;
      std::memcpy(dst->rgba.data() + (size_t(dy) * dst->w + dx) * 4,
                  src->rgba.data() + (size_t(y) * src->w + x) * 4, 4);
    }
  }
  return 0;
}

// ── love.filesystem ───────────────────────────────────────────────────────

int l_fs_getDirectoryItems(lua_State *L) {
  std::string dir = normalizePath(luaL_optstring(L, 1, "."));
  DIR *d = opendir(dir.c_str());
  lua_newtable(L);
  if (!d) return 1;
  std::vector<std::string> names;
  while (dirent *e = readdir(d)) {
    if (std::strcmp(e->d_name, ".") && std::strcmp(e->d_name, "..")) names.emplace_back(e->d_name);
  }
  closedir(d);
  std::sort(names.begin(), names.end());
  int i = 1;
  for (const auto &name : names) {
    lua_pushstring(L, name.c_str());
    lua_rawseti(L, -2, i++);
  }
  return 1;
}

int l_fs_getInfo(lua_State *L) {
  struct stat st{};
  if (stat(normalizePath(luaL_checkstring(L, 1)).c_str(), &st) != 0) {
    lua_pushnil(L);
    return 1;
  }
  lua_newtable(L);
  lua_pushstring(L, S_ISDIR(st.st_mode) ? "directory" : "file");
  lua_setfield(L, -2, "type");
  lua_pushinteger(L, st.st_size);
  lua_setfield(L, -2, "size");
  return 1;
}

int l_fs_exists(lua_State *L) {
  struct stat st{};
  lua_pushboolean(L, stat(normalizePath(luaL_checkstring(L, 1)).c_str(), &st) == 0);
  return 1;
}

int l_fs_isFile(lua_State *L) {
  struct stat st{};
  lua_pushboolean(L, stat(normalizePath(luaL_checkstring(L, 1)).c_str(), &st) == 0 && S_ISREG(st.st_mode));
  return 1;
}

int l_fs_isDirectory(lua_State *L) {
  struct stat st{};
  lua_pushboolean(L, stat(normalizePath(luaL_checkstring(L, 1)).c_str(), &st) == 0 && S_ISDIR(st.st_mode));
  return 1;
}

int l_fs_setIdentity(lua_State *) { return 0; }
int l_fs_createDirectory(lua_State *L) {
  std::string path = normalizePath(luaL_optstring(L, 1, "."));
  lua_pushboolean(L, mkdir(path.c_str(), 0777) == 0 || errno == EEXIST);
  return 1;
}
int l_fs_getSaveDirectory(lua_State *L) { lua_pushstring(L, G.root.c_str()); return 1; }
int l_fs_getSource(lua_State *L) { lua_pushstring(L, G.root.c_str()); return 1; }
int l_fs_remove(lua_State *L) {
  lua_pushboolean(L, unlink(normalizePath(luaL_checkstring(L, 1)).c_str()) == 0);
  return 1;
}

int l_fs_write(lua_State *L) {
  std::string path = normalizePath(luaL_checkstring(L, 1));
  size_t n = 0;
  const char *data = luaL_checklstring(L, 2, &n);
  FILE *f = fopen(path.c_str(), "wb");
  if (!f) { lua_pushboolean(L, 0); return 1; }
  size_t wrote = fwrite(data, 1, n, f);
  fclose(f);
  lua_pushboolean(L, wrote == n);
  return 1;
}

int l_fs_newFileData(lua_State *L) {
  std::vector<uint8_t> bytes;
  if (!readFile(luaL_checkstring(L, 1), bytes)) {
    lua_pushnil(L);
    return 1;
  }
  lua_pushlstring(L, reinterpret_cast<const char *>(bytes.data()), bytes.size());
  return 1;
}

int l_fs_read(lua_State *L) {
  std::vector<uint8_t> bytes;
  if (!readFile(luaL_checkstring(L, 1), bytes)) {
    lua_pushnil(L);
    lua_pushstring(L, "read failed");
    return 2;
  }
  lua_pushlstring(L, reinterpret_cast<const char *>(bytes.data()), bytes.size());
  return 1;
}

int l_fs_load(lua_State *L) {
  std::string path = luaL_checkstring(L, 1);
  std::vector<uint8_t> bytes;
  if (!readFile(path, bytes)) return luaL_error(L, "could not read %s", path.c_str());
  std::string chunk = "@" + path;
  if (luaL_loadbuffer(L, reinterpret_cast<const char *>(bytes.data()), bytes.size(), chunk.c_str()) != 0) {
    return lua_error(L);
  }
  return 1;
}

int l_fs_newFile(lua_State *L) {
  FileHandle *f = new FileHandle;
  f->path = normalizePath(luaL_checkstring(L, 1));
  pushObj(L, f, MT_FILE);
  return 1;
}

int l_file_open(lua_State *L) {
  FileHandle *f = checkObj<FileHandle>(L, 1, MT_FILE);
  const char *mode = luaL_optstring(L, 2, "r");
  if (f->fp) fclose(f->fp);
  f->fp = fopen(f->path.c_str(), mode);
  lua_pushboolean(L, f->fp != nullptr);
  return 1;
}

int l_file_read(lua_State *L) {
  FileHandle *f = checkObj<FileHandle>(L, 1, MT_FILE);
  if (!f->fp) {
    lua_pushnil(L);
    return 1;
  }
  int n = int(luaL_optinteger(L, 2, -1));
  std::string out;
  if (n >= 0) {
    out.resize(size_t(n));
    size_t got = n > 0 ? fread(&out[0], 1, size_t(n), f->fp) : 0;
    out.resize(got);
  } else {
    char buf[1024];
    while (size_t got = fread(buf, 1, sizeof(buf), f->fp)) out.append(buf, got);
  }
  lua_pushlstring(L, out.data(), out.size());
  return 1;
}

int l_file_close(lua_State *L) {
  FileHandle *f = checkObj<FileHandle>(L, 1, MT_FILE);
  if (f->fp) {
    fclose(f->fp);
    f->fp = nullptr;
  }
  return 0;
}

int l_lines_iter(lua_State *L) {
  lua_Integer idx = lua_tointeger(L, lua_upvalueindex(2));
  lua_rawgeti(L, lua_upvalueindex(1), idx);
  if (lua_isnil(L, -1)) return 1;
  lua_pushinteger(L, idx + 1);
  lua_replace(L, lua_upvalueindex(2));
  return 1;
}

int l_fs_lines(lua_State *L) {
  std::vector<uint8_t> bytes;
  if (!readFile(luaL_checkstring(L, 1), bytes)) return luaL_error(L, "lines failed");
  std::string text(reinterpret_cast<const char *>(bytes.data()), bytes.size());
  lua_newtable(L);
  int idx = 1;
  size_t pos = 0;
  while (pos <= text.size()) {
    size_t next = text.find('\n', pos);
    std::string line = next == std::string::npos ? text.substr(pos) : text.substr(pos, next - pos);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    lua_pushlstring(L, line.data(), line.size());
    lua_rawseti(L, -2, idx++);
    if (next == std::string::npos) break;
    pos = next + 1;
  }
  lua_pushinteger(L, 1);
  lua_pushcclosure(L, l_lines_iter, 2);
  return 1;
}

// ── input, timer, window ─────────────────────────────────────────────────

int l_key_isDown(lua_State *L) {
  for (int i = 1; i <= lua_gettop(L); ++i)
    if (G.keys.count(luaL_checkstring(L, i))) { lua_pushboolean(L, 1); return 1; }
  lua_pushboolean(L, 0);
  return 1;
}
int l_key_setKeyRepeat(lua_State *) { return 0; }

int l_mouse_getPosition(lua_State *L) { lua_pushinteger(L, G.mouseX); lua_pushinteger(L, G.mouseY); return 2; }
int l_mouse_getX(lua_State *L) { lua_pushinteger(L, G.mouseX); return 1; }
int l_mouse_getY(lua_State *L) { lua_pushinteger(L, G.mouseY); return 1; }
int l_mouse_setPosition(lua_State *L) {
  G.mouseX = clampInt(int(luaL_checknumber(L, 1)), 0, kLogicalWidth - 1);
  G.mouseY = clampInt(int(luaL_checknumber(L, 2)), 0, kLogicalHeight - 1);
  return 0;
}
int l_mouse_isDown(lua_State *L) {
  int b = int(luaL_checkinteger(L, 1));
  int bit = b == 1 ? 0 : (b == 2 ? 1 : 2);
  lua_pushboolean(L, (G.mouseButtons & (1 << bit)) != 0);
  return 1;
}
int l_mouse_setVisible(lua_State *L) { G.mouseVisible = lua_toboolean(L, 1); return 0; }
int l_mouse_isVisible(lua_State *L) { lua_pushboolean(L, G.mouseVisible); return 1; }
int l_mouse_newCursor(lua_State *L) { lua_newtable(L); return 1; }
int l_mouse_setCursor(lua_State *) { return 0; }
int l_mouse_setGrabbed(lua_State *) { return 0; }
int l_mouse_getSystemCursor(lua_State *L) { lua_newtable(L); return 1; }

int l_timer_getTime(lua_State *L) { lua_pushnumber(L, nowSeconds() - G.start); return 1; }
int l_timer_getDelta(lua_State *L) { lua_pushnumber(L, G.dt); return 1; }
int l_timer_getFPS(lua_State *L) { lua_pushinteger(L, G.fps); return 1; }
int l_timer_sleep(lua_State *L) { usleep(useconds_t(luaL_checknumber(L, 1) * 1000000.0)); return 0; }
int l_timer_step(lua_State *L) {
  double t = nowSeconds();
  if (G.last == 0.0) G.last = t;
  G.dt = std::min(0.1, std::max(0.0, t - G.last));
  G.last = t;
  lua_pushnumber(L, G.dt);
  return 1;
}

int l_window_setTitle(lua_State *L) {
  fprintf(stderr, "lovefb: %s\n", luaL_optstring(L, 1, "LOVE"));
  return 0;
}

int l_window_getFullscreenModes(lua_State *L) {
  lua_newtable(L);
  int modes[2][2] = {{kLogicalWidth, kLogicalHeight}, {G.fbW, G.fbH}};
  for (int i = 0; i < 2; ++i) {
    lua_newtable(L);
    lua_pushinteger(L, modes[i][0]); lua_setfield(L, -2, "width");
    lua_pushinteger(L, modes[i][1]); lua_setfield(L, -2, "height");
    lua_rawseti(L, -2, i + 1);
  }
  return 1;
}

int l_window_setMode(lua_State *) { return 0; }
int l_window_getMode(lua_State *L) {
  lua_pushinteger(L, kLogicalWidth);
  lua_pushinteger(L, kLogicalHeight);
  lua_newtable(L);
  lua_pushinteger(L, 1); lua_setfield(L, -2, "display");
  lua_pushinteger(L, 60); lua_setfield(L, -2, "refreshrate");
  lua_pushboolean(L, 0); lua_setfield(L, -2, "fullscreen");
  return 3;
}
int l_window_setIcon(lua_State *) { return 0; }
int l_window_getDesktopDimensions(lua_State *L) {
  lua_pushinteger(L, kLogicalWidth);
  lua_pushinteger(L, kLogicalHeight);
  return 2;
}
int l_window_getDisplayCount(lua_State *L) { lua_pushinteger(L, 1); return 1; }

// ── audio, math, event, system compatibility ─────────────────────────────

int l_audio_newSource(lua_State *L) {
  Source *s = new Source;
  pushObj(L, s, MT_SOURCE);
  return 1;
}
int l_source_clone(lua_State *L) {
  Source *src = checkObj<Source>(L, 1, MT_SOURCE);
  pushObj(L, new Source(*src), MT_SOURCE);
  return 1;
}
int l_source_setVolume(lua_State *L) { checkObj<Source>(L, 1, MT_SOURCE)->volume = luaL_optnumber(L, 2, 1); return 0; }
int l_source_getVolume(lua_State *L) { lua_pushnumber(L, checkObj<Source>(L, 1, MT_SOURCE)->volume); return 1; }
int l_source_setPitch(lua_State *L) { checkObj<Source>(L, 1, MT_SOURCE)->pitch = luaL_optnumber(L, 2, 1); return 0; }
int l_source_getPitch(lua_State *L) { lua_pushnumber(L, checkObj<Source>(L, 1, MT_SOURCE)->pitch); return 1; }
int l_source_setLooping(lua_State *L) { checkObj<Source>(L, 1, MT_SOURCE)->looping = lua_toboolean(L, 2); return 0; }
int l_source_isLooping(lua_State *L) { lua_pushboolean(L, checkObj<Source>(L, 1, MT_SOURCE)->looping); return 1; }
int l_source_play(lua_State *L) { checkObj<Source>(L, 1, MT_SOURCE)->playing = true; return 0; }
int l_source_pause(lua_State *L) { checkObj<Source>(L, 1, MT_SOURCE)->playing = false; return 0; }
int l_source_stop(lua_State *L) { checkObj<Source>(L, 1, MT_SOURCE)->playing = false; return 0; }
int l_source_isPlaying(lua_State *L) { lua_pushboolean(L, checkObj<Source>(L, 1, MT_SOURCE)->playing); return 1; }
int l_source_isStopped(lua_State *L) { lua_pushboolean(L, !checkObj<Source>(L, 1, MT_SOURCE)->playing); return 1; }
int l_source_seek(lua_State *L) { checkObj<Source>(L, 1, MT_SOURCE)->cursor = luaL_optnumber(L, 2, 0); return 0; }
int l_source_setEffect(lua_State *) { return 0; }
int l_audio_setEffect(lua_State *) { return 0; }

int l_math_random(lua_State *L) {
  int top = lua_gettop(L);
  int start = lua_istable(L, 1) ? 2 : 1;
  int n = std::max(0, top - start + 1);
  lua_getglobal(L, "math");
  lua_getfield(L, -1, "random");
  lua_remove(L, -2);
  for (int i = start; i <= top; ++i) lua_pushvalue(L, i);
  lua_call(L, n, 1);
  return 1;
}
int l_math_setRandomSeed(lua_State *L) {
  lua_getglobal(L, "math");
  lua_getfield(L, -1, "randomseed");
  lua_remove(L, -2);
  lua_pushinteger(L, luaL_checkinteger(L, 1));
  lua_call(L, 1, 0);
  return 0;
}
int l_math_isConvex(lua_State *L) { lua_pushboolean(L, 1); return 1; }
int l_math_triangulate(lua_State *L) {
  std::vector<double> nums;
  if (!lua_istable(L, 1)) nums = collectNumbers(L, 1);
  lua_newtable(L);
  if (lua_istable(L, 1)) lua_pushvalue(L, 1);
  else {
    lua_newtable(L);
    for (size_t i = 0; i < nums.size(); ++i) {
      lua_pushnumber(L, nums[i]);
      lua_rawseti(L, -2, int(i + 1));
    }
  }
  lua_rawseti(L, -2, 1);
  return 1;
}
int l_math_newRandomGenerator(lua_State *L) {
  lua_newtable(L);
  addFunc(L, "random", l_math_random);
  return 1;
}

int l_event_quit(lua_State *) { gRunning = 0; return 0; }
int l_event_push(lua_State *L) {
  int top = lua_gettop(L);
  if (top <= 0) return 0;
  LoveEvent ev;
  ev.name = luaL_checkstring(L, 1);
  for (int i = 2; i <= top; ++i) {
    size_t len = 0;
    const char *s = lua_tolstring(L, i, &len);
    if (s) ev.args.emplace_back(s, len);
    else if (lua_isboolean(L, i)) ev.args.emplace_back(lua_toboolean(L, i) ? "true" : "false");
    else ev.args.emplace_back("");
  }
  G.queuedEvents.push_back(std::move(ev));
  return 0;
}
int l_event_pump(lua_State *) { return 0; }

int l_event_poll_iter(lua_State *L) {
  lua_Integer idx = lua_tointeger(L, lua_upvalueindex(2));
  lua_rawgeti(L, lua_upvalueindex(1), idx);
  if (lua_isnil(L, -1)) return 0;
  lua_pushinteger(L, idx + 1);
  lua_replace(L, lua_upvalueindex(2));

  int n = int(lua_objlen(L, -1));
  for (int i = 1; i <= n; ++i) lua_rawgeti(L, -1, i);
  lua_remove(L, -n - 1);
  return n;
}

int l_event_poll(lua_State *L) {
  lua_newtable(L);
  for (size_t i = 0; i < G.queuedEvents.size(); ++i) {
    lua_newtable(L);
    lua_pushstring(L, G.queuedEvents[i].name.c_str());
    lua_rawseti(L, -2, 1);
    for (size_t j = 0; j < G.queuedEvents[i].args.size(); ++j) {
      lua_pushstring(L, G.queuedEvents[i].args[j].c_str());
      lua_rawseti(L, -2, int(j + 2));
    }
    lua_rawseti(L, -2, int(i + 1));
  }
  G.queuedEvents.clear();
  lua_pushinteger(L, 1);
  lua_pushcclosure(L, l_event_poll_iter, 2);
  return 1;
}

int l_system_openURL(lua_State *) { return 0; }
int l_joystick_getJoysticks(lua_State *L) { lua_newtable(L); return 1; }

// ── love.physics lightweight compatibility ───────────────────────────────

int l_phys_setMeter(lua_State *) { return 0; }
int l_phys_newWorld(lua_State *L) {
  World *w = new World;
  w->gx = luaL_optnumber(L, 1, 0);
  w->gy = luaL_optnumber(L, 2, 0);
  pushObj(L, w, MT_WORLD);
  return 1;
}
int l_world_update(lua_State *L) {
  World *w = checkObj<World>(L, 1, MT_WORLD);
  double dt = luaL_checknumber(L, 2);
  for (Body *b : w->bodies) {
    if (!b->dynamic) continue;
    b->vx += w->gx * dt;
    b->vy += w->gy * dt;
    b->x += b->vx * dt;
    b->y += b->vy * dt;
    if (!b->fixedRotation) b->angle += b->angularVelocity * dt;
    if (b->y > 568) { b->y = 568; b->vy *= -0.55; }
    if (b->y < 16) { b->y = 16; b->vy *= -0.55; }
    if (b->x < 16) { b->x = 16; b->vx *= -0.55; }
    if (b->x > 784) { b->x = 784; b->vx *= -0.55; }
  }
  return 0;
}
int l_world_setGravity(lua_State *L) {
  World *w = checkObj<World>(L, 1, MT_WORLD);
  w->gx = luaL_checknumber(L, 2);
  w->gy = luaL_checknumber(L, 3);
  return 0;
}
int l_world_setCallbacks(lua_State *) { return 0; }
int l_world_getBodies(lua_State *L) {
  World *w = checkObj<World>(L, 1, MT_WORLD);
  lua_newtable(L);
  int i = 1;
  for (Body *b : w->bodies) {
    pushObj(L, b, MT_BODY);
    lua_rawseti(L, -2, i++);
  }
  return 1;
}
int l_world_destroy(lua_State *L) {
  World *w = checkObj<World>(L, 1, MT_WORLD);
  w->bodies.clear();
  return 0;
}
int l_world_rayCast(lua_State *) { return 0; }
int l_phys_newBody(lua_State *L) {
  World *w = checkObj<World>(L, 1, MT_WORLD);
  Body *b = new Body;
  b->world = w;
  b->x = luaL_optnumber(L, 2, 0);
  b->y = luaL_optnumber(L, 3, 0);
  std::string kind = luaL_optstring(L, 4, "static");
  b->dynamic = kind == "dynamic" || kind == "kinematic";
  w->bodies.push_back(b);
  pushObj(L, b, MT_BODY);
  return 1;
}
int l_body_getX(lua_State *L) { lua_pushnumber(L, checkObj<Body>(L, 1, MT_BODY)->x); return 1; }
int l_body_getY(lua_State *L) { lua_pushnumber(L, checkObj<Body>(L, 1, MT_BODY)->y); return 1; }
int l_body_getAngle(lua_State *L) { lua_pushnumber(L, checkObj<Body>(L, 1, MT_BODY)->angle); return 1; }
int l_body_getPosition(lua_State *L) {
  Body *b = checkObj<Body>(L, 1, MT_BODY);
  lua_pushnumber(L, b->x); lua_pushnumber(L, b->y); return 2;
}
int l_body_getWorldPoints(lua_State *L) {
  Body *b = checkObj<Body>(L, 1, MT_BODY);
  int out = 0;
  int top = lua_gettop(L);
  for (int i = 2; i <= top; i += 2) {
    lua_pushnumber(L, b->x + luaL_checknumber(L, i)); ++out;
    if (i + 1 <= top) { lua_pushnumber(L, b->y + luaL_checknumber(L, i + 1)); ++out; }
  }
  return out;
}
int l_body_applyLinearImpulse(lua_State *L) {
  Body *b = checkObj<Body>(L, 1, MT_BODY);
  b->vx += luaL_optnumber(L, 2, 0) * 0.25;
  b->vy += luaL_optnumber(L, 3, 0) * 0.25;
  return 0;
}
int l_body_setPosition(lua_State *L) {
  Body *b = checkObj<Body>(L, 1, MT_BODY);
  b->x = luaL_checknumber(L, 2);
  b->y = luaL_checknumber(L, 3);
  return 0;
}
int l_body_setBullet(lua_State *) { return 0; }
int l_body_setFixedRotation(lua_State *L) { checkObj<Body>(L, 1, MT_BODY)->fixedRotation = lua_toboolean(L, 2); return 0; }
int l_body_setLinearVelocity(lua_State *L) {
  Body *b = checkObj<Body>(L, 1, MT_BODY);
  b->vx = luaL_optnumber(L, 2, 0);
  b->vy = luaL_optnumber(L, 3, 0);
  return 0;
}
int l_body_getLinearVelocity(lua_State *L) {
  Body *b = checkObj<Body>(L, 1, MT_BODY);
  lua_pushnumber(L, b->vx);
  lua_pushnumber(L, b->vy);
  return 2;
}
int l_body_setLinearDamping(lua_State *) { return 0; }
int l_body_setAngularVelocity(lua_State *L) { checkObj<Body>(L, 1, MT_BODY)->angularVelocity = luaL_optnumber(L, 2, 0); return 0; }
int l_body_setAngularDamping(lua_State *) { return 0; }
int l_body_setAngle(lua_State *L) { checkObj<Body>(L, 1, MT_BODY)->angle = luaL_optnumber(L, 2, 0); return 0; }
int l_body_applyAngularImpulse(lua_State *L) { checkObj<Body>(L, 1, MT_BODY)->angularVelocity += luaL_optnumber(L, 2, 0); return 0; }
int l_body_applyForce(lua_State *L) {
  Body *b = checkObj<Body>(L, 1, MT_BODY);
  b->vx += luaL_optnumber(L, 2, 0) * 0.01;
  b->vy += luaL_optnumber(L, 3, 0) * 0.01;
  return 0;
}
int l_body_applyTorque(lua_State *L) { checkObj<Body>(L, 1, MT_BODY)->angularVelocity += luaL_optnumber(L, 2, 0) * 0.01; return 0; }
int l_body_setMass(lua_State *) { return 0; }
int l_body_setGravityScale(lua_State *) { return 0; }
int l_body_setMassData(lua_State *) { return 0; }
int l_body_setAwake(lua_State *) { return 0; }
int l_body_destroy(lua_State *) { return 0; }
int l_phys_newRectangleShape(lua_State *L) {
  double cx = 0, cy = 0, w = 0, h = 0;
  if (lua_gettop(L) >= 4) {
    cx = luaL_optnumber(L, 1, 0);
    cy = luaL_optnumber(L, 2, 0);
    w = luaL_checknumber(L, 3);
    h = luaL_checknumber(L, 4);
  } else {
    w = luaL_checknumber(L, 1);
    h = luaL_checknumber(L, 2);
  }
  Shape *s = new Shape;
  s->kind = Shape::Polygon;
  s->points = {cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2,
               cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2};
  pushObj(L, s, MT_SHAPE);
  return 1;
}
int l_phys_newEdgeShape(lua_State *L) {
  Shape *s = new Shape;
  s->kind = Shape::Edge;
  s->points = {luaL_checknumber(L, 1), luaL_checknumber(L, 2),
               luaL_checknumber(L, 3), luaL_checknumber(L, 4)};
  pushObj(L, s, MT_SHAPE);
  return 1;
}
int l_phys_newCircleShape(lua_State *L) {
  Shape *s = new Shape;
  s->kind = Shape::Circle;
  if (lua_gettop(L) >= 3) {
    s->points = {luaL_optnumber(L, 1, 0), luaL_optnumber(L, 2, 0)};
    s->radius = luaL_checknumber(L, 3);
  } else {
    s->points = {0, 0};
    s->radius = luaL_checknumber(L, 1);
  }
  pushObj(L, s, MT_SHAPE);
  return 1;
}
int l_phys_newPolygonShape(lua_State *L) {
  Shape *s = new Shape;
  s->kind = Shape::Polygon;
  s->points = collectNumbers(L, 1);
  pushObj(L, s, MT_SHAPE);
  return 1;
}
int l_phys_newChainShape(lua_State *L) {
  Shape *s = new Shape;
  s->kind = Shape::Edge;
  s->points = collectNumbers(L, 2);
  pushObj(L, s, MT_SHAPE);
  return 1;
}
int l_phys_newRevoluteJoint(lua_State *L) {
  lua_newtable(L);
  lua_pushcfunction(L, [](lua_State *) -> int { return 0; });
  lua_setfield(L, -2, "destroy");
  return 1;
}
int l_shape_getPoints(lua_State *L) {
  Shape *s = checkObj<Shape>(L, 1, MT_SHAPE);
  for (double v : s->points) lua_pushnumber(L, v);
  return int(s->points.size());
}
int l_shape_getRadius(lua_State *L) { lua_pushnumber(L, checkObj<Shape>(L, 1, MT_SHAPE)->radius); return 1; }
int l_shape_computeMass(lua_State *L) {
  lua_newtable(L);
  lua_pushnumber(L, luaL_optnumber(L, 2, 1)); lua_setfield(L, -2, "mass");
  return 1;
}
int l_phys_newFixture(lua_State *L) {
  Fixture *f = new Fixture;
  f->body = checkObj<Body>(L, 1, MT_BODY);
  f->shape = new Shape(*checkObj<Shape>(L, 2, MT_SHAPE));
  pushObj(L, f, MT_FIXTURE);
  return 1;
}
int l_fixture_setUserData(lua_State *L) {
  Fixture *f = checkObj<Fixture>(L, 1, MT_FIXTURE);
  if (f->userDataRef != LUA_NOREF) luaL_unref(L, LUA_REGISTRYINDEX, f->userDataRef);
  lua_pushvalue(L, 2);
  f->userDataRef = luaL_ref(L, LUA_REGISTRYINDEX);
  return 0;
}
int l_fixture_getUserData(lua_State *L) {
  Fixture *f = checkObj<Fixture>(L, 1, MT_FIXTURE);
  if (f->userDataRef == LUA_NOREF) lua_pushnil(L);
  else lua_rawgeti(L, LUA_REGISTRYINDEX, f->userDataRef);
  return 1;
}
int l_fixture_getShape(lua_State *L) {
  Fixture *f = checkObj<Fixture>(L, 1, MT_FIXTURE);
  pushObj(L, new Shape(*f->shape), MT_SHAPE);
  return 1;
}
int l_fixture_setCategory(lua_State *) { return 0; }
int l_fixture_setMask(lua_State *) { return 0; }
int l_fixture_setSensor(lua_State *L) { checkObj<Fixture>(L, 1, MT_FIXTURE)->sensor = lua_toboolean(L, 2); return 0; }
int l_fixture_isSensor(lua_State *L) { lua_pushboolean(L, checkObj<Fixture>(L, 1, MT_FIXTURE)->sensor); return 1; }
int l_fixture_setFriction(lua_State *L) { checkObj<Fixture>(L, 1, MT_FIXTURE)->friction = luaL_optnumber(L, 2, 0); return 0; }
int l_fixture_setRestitution(lua_State *L) { checkObj<Fixture>(L, 1, MT_FIXTURE)->restitution = luaL_optnumber(L, 2, 0); return 0; }
int l_fixture_destroy(lua_State *) { return 0; }
int l_fixture_number0(lua_State *L) { lua_pushnumber(L, 0); return 1; }
int l_fixture_positions(lua_State *L) { lua_pushnumber(L, 0); lua_pushnumber(L, 0); lua_pushnumber(L, 0); lua_pushnumber(L, 0); return 4; }
int l_fixture_normal(lua_State *L) { lua_pushnumber(L, 0); lua_pushnumber(L, -1); return 2; }

int l_love_quit(lua_State *) { gRunning = 0; return 0; }

void setModule(lua_State *L, const char *name, const luaL_Reg *funcs) {
  lua_getglobal(L, "love");
  lua_newtable(L);
  for (const luaL_Reg *r = funcs; r && r->name; ++r) addFunc(L, r->name, r->func);
  lua_setfield(L, -2, name);
  lua_pop(L, 1);
}

void registerLove(lua_State *L) {
  lua_newtable(L);
  lua_pushstring(L, "11.5-kandelo-fb");
  lua_setfield(L, -2, "_version");
  addFunc(L, "quit", l_love_quit);
  lua_pushstring(L, "r");
  lua_setfield(L, -2, "file_read");
  lua_setglobal(L, "love");
  lua_pushboolean(L, 1);
  lua_setglobal(L, "Animations_legacy_support");

  const luaL_Reg font[] = {{"getHeight", l_font_getHeight}, {"getWidth", l_font_getWidth}, {"setFilter", l_font_setFilter}, {nullptr, nullptr}};
  const luaL_Reg image[] = {{"getWidth", l_img_getWidth}, {"getHeight", l_img_getHeight}, {"getDimensions", l_img_getDimensions}, {nullptr, nullptr}};
  const luaL_Reg imageData[] = {{"getWidth", l_id_getWidth}, {"getHeight", l_id_getHeight}, {"paste", l_id_paste}, {nullptr, nullptr}};
  const luaL_Reg canvas[] = {{"getWidth", l_canvas_getWidth}, {"getHeight", l_canvas_getHeight}, {nullptr, nullptr}};
  const luaL_Reg quad[] = {{"getWidth", l_quad_getWidth}, {"getHeight", l_quad_getHeight}, {nullptr, nullptr}};
  const luaL_Reg text[] = {{"getWidth", l_text_getWidth}, {"getHeight", l_text_getHeight}, {nullptr, nullptr}};
  const luaL_Reg file[] = {{"open", l_file_open}, {"read", l_file_read}, {"close", l_file_close}, {nullptr, nullptr}};
  const luaL_Reg video[] = {{"getWidth", l_video_getWidth}, {"getHeight", l_video_getHeight}, {"play", l_video_play}, {"pause", l_video_pause}, {"isPlaying", l_video_isPlaying}, {"seek", l_video_seek}, {"tell", l_video_tell}, {"getSource", l_video_getSource}, {nullptr, nullptr}};
  const luaL_Reg source[] = {{"clone", l_source_clone}, {"setVolume", l_source_setVolume}, {"getVolume", l_source_getVolume}, {"setPitch", l_source_setPitch}, {"getPitch", l_source_getPitch}, {"setLooping", l_source_setLooping}, {"isLooping", l_source_isLooping}, {"play", l_source_play}, {"pause", l_source_pause}, {"stop", l_source_stop}, {"isPlaying", l_source_isPlaying}, {"isStopped", l_source_isStopped}, {"seek", l_source_seek}, {"setEffect", l_source_setEffect}, {nullptr, nullptr}};
  const luaL_Reg shader[] = {{"send", l_shader_send}, {nullptr, nullptr}};
  const luaL_Reg world[] = {{"update", l_world_update}, {"setGravity", l_world_setGravity}, {"setCallbacks", l_world_setCallbacks}, {"getBodies", l_world_getBodies}, {"destroy", l_world_destroy}, {"rayCast", l_world_rayCast}, {nullptr, nullptr}};
  const luaL_Reg body[] = {{"getX", l_body_getX}, {"getY", l_body_getY}, {"getAngle", l_body_getAngle}, {"getPosition", l_body_getPosition}, {"setPosition", l_body_setPosition}, {"getWorldPoints", l_body_getWorldPoints}, {"applyLinearImpulse", l_body_applyLinearImpulse}, {"setLinearVelocity", l_body_setLinearVelocity}, {"getLinearVelocity", l_body_getLinearVelocity}, {"setLinearDamping", l_body_setLinearDamping}, {"setAngularVelocity", l_body_setAngularVelocity}, {"setAngularDamping", l_body_setAngularDamping}, {"setAngle", l_body_setAngle}, {"applyAngularImpulse", l_body_applyAngularImpulse}, {"applyForce", l_body_applyForce}, {"applyTorque", l_body_applyTorque}, {"setMass", l_body_setMass}, {"setGravityScale", l_body_setGravityScale}, {"setMassData", l_body_setMassData}, {"setAwake", l_body_setAwake}, {"setBullet", l_body_setBullet}, {"setFixedRotation", l_body_setFixedRotation}, {"destroy", l_body_destroy}, {nullptr, nullptr}};
  const luaL_Reg shape[] = {{"getPoints", l_shape_getPoints}, {"getRadius", l_shape_getRadius}, {"computeMass", l_shape_computeMass}, {nullptr, nullptr}};
  const luaL_Reg fixture[] = {{"setUserData", l_fixture_setUserData}, {"getUserData", l_fixture_getUserData}, {"getShape", l_fixture_getShape}, {"setCategory", l_fixture_setCategory}, {"setMask", l_fixture_setMask}, {"setSensor", l_fixture_setSensor}, {"isSensor", l_fixture_isSensor}, {"setFriction", l_fixture_setFriction}, {"setRestitution", l_fixture_setRestitution}, {"destroy", l_fixture_destroy}, {"getFriction", l_fixture_number0}, {"getRestitution", l_fixture_number0}, {"getSeparation", l_fixture_number0}, {"getPositions", l_fixture_positions}, {"getNormal", l_fixture_normal}, {"getVelocity", l_fixture_normal}, {nullptr, nullptr}};

  createMeta(L, MT_FONT, font);
  createMeta(L, MT_IMAGE, image, gcImage);
  createMeta(L, MT_IMAGEDATA, imageData, gcImageData);
  createMeta(L, MT_CANVAS, canvas, gcCanvas);
  createMeta(L, MT_QUAD, quad, gcQuad);
  createMeta(L, MT_TEXT, text, gcText);
  createMeta(L, MT_FILE, file, gcFile);
  createMeta(L, MT_VIDEO, video, gcVideo);
  createMeta(L, MT_MESH, nullptr, gcMesh);
  createMeta(L, MT_SOURCE, source, gcSource);
  createMeta(L, MT_SHADER, shader);
  createMeta(L, MT_WORLD, world);
  createMeta(L, MT_BODY, body);
  createMeta(L, MT_SHAPE, shape, gcShape);
  createMeta(L, MT_FIXTURE, fixture, gcFixture);

  const luaL_Reg graphics[] = {
    {"getWidth", l_g_getWidth}, {"getHeight", l_g_getHeight}, {"getDimensions", l_g_getDimensions},
    {"setColor", l_g_setColor}, {"getColor", l_g_getColor},
    {"setBackgroundColor", l_g_setBackgroundColor}, {"getBackgroundColor", l_g_getBackgroundColor},
    {"setLineWidth", l_g_setLineWidth}, {"getLineWidth", l_g_getLineWidth}, {"setLineStyle", l_g_setLineStyle},
    {"setBlendMode", l_g_setBlendMode}, {"setDefaultFilter", l_g_setDefaultFilter},
    {"clear", l_g_clear}, {"isActive", l_g_isActive}, {"present", l_g_present},
    {"newFont", l_g_newFont}, {"setFont", l_g_setFont}, {"getFont", l_g_getFont},
    {"print", l_g_print}, {"rectangle", l_g_rectangle}, {"line", l_g_line},
    {"circle", l_g_circle}, {"arc", l_g_arc}, {"ellipse", l_g_ellipse},
    {"polygon", l_g_polygon}, {"point", l_g_point},
    {"stencil", l_g_stencil}, {"setStencilTest", l_g_setStencilTest},
    {"getSystemLimits", l_g_getSystemLimits}, {"getSupported", l_g_getSupported},
    {"getRendererInfo", l_g_getRendererInfo}, {"getImageFormats", l_g_getImageFormats},
    {"getCanvasFormats", l_g_getCanvasFormats}, {"getStats", l_g_getStats},
    {"setScissor", l_g_setScissor}, {"getScissor", l_g_getScissor},
    {"push", l_g_push}, {"pop", l_g_pop}, {"origin", l_g_origin},
    {"translate", l_g_translate}, {"scale", l_g_scale}, {"rotate", l_g_rotate},
    {"newImage", l_g_newImage}, {"draw", l_g_draw},
    {"newCanvas", l_g_newCanvas}, {"setCanvas", l_g_setCanvas}, {"newQuad", l_g_newQuad},
    {"newShader", l_g_newShader}, {"setShader", l_g_setShader}, {"newVideo", l_g_newVideo},
    {"newText", l_g_newText}, {"newMesh", l_g_newMesh},
    {nullptr, nullptr},
  };
  const luaL_Reg fs[] = {
    {"getDirectoryItems", l_fs_getDirectoryItems}, {"getInfo", l_fs_getInfo},
    {"exists", l_fs_exists}, {"read", l_fs_read}, {"load", l_fs_load},
    {"isFile", l_fs_isFile}, {"isDirectory", l_fs_isDirectory},
    {"setIdentity", l_fs_setIdentity}, {"createDirectory", l_fs_createDirectory},
    {"getSaveDirectory", l_fs_getSaveDirectory}, {"getSource", l_fs_getSource},
    {"remove", l_fs_remove}, {"write", l_fs_write},
    {"newFileData", l_fs_newFileData}, {"newFile", l_fs_newFile}, {"lines", l_fs_lines}, {nullptr, nullptr},
  };
  const luaL_Reg imageMod[] = {{"newImageData", l_image_newImageData}, {nullptr, nullptr}};
  const luaL_Reg keyboard[] = {{"isDown", l_key_isDown}, {"setKeyRepeat", l_key_setKeyRepeat}, {nullptr, nullptr}};
  const luaL_Reg mouse[] = {
    {"getPosition", l_mouse_getPosition}, {"getX", l_mouse_getX}, {"getY", l_mouse_getY},
    {"setPosition", l_mouse_setPosition}, {"isDown", l_mouse_isDown},
    {"setVisible", l_mouse_setVisible}, {"isVisible", l_mouse_isVisible},
    {"newCursor", l_mouse_newCursor}, {"setCursor", l_mouse_setCursor},
    {"setGrabbed", l_mouse_setGrabbed}, {"getSystemCursor", l_mouse_getSystemCursor}, {nullptr, nullptr},
  };
  const luaL_Reg timer[] = {{"getTime", l_timer_getTime}, {"getDelta", l_timer_getDelta}, {"getFPS", l_timer_getFPS}, {"sleep", l_timer_sleep}, {"step", l_timer_step}, {nullptr, nullptr}};
  const luaL_Reg window[] = {{"setTitle", l_window_setTitle}, {"setMode", l_window_setMode}, {"getMode", l_window_getMode}, {"setIcon", l_window_setIcon}, {"getFullscreenModes", l_window_getFullscreenModes}, {"getDesktopDimensions", l_window_getDesktopDimensions}, {"getDisplayCount", l_window_getDisplayCount}, {nullptr, nullptr}};
  const luaL_Reg physics[] = {{"setMeter", l_phys_setMeter}, {"newWorld", l_phys_newWorld}, {"newBody", l_phys_newBody}, {"newRectangleShape", l_phys_newRectangleShape}, {"newEdgeShape", l_phys_newEdgeShape}, {"newCircleShape", l_phys_newCircleShape}, {"newPolygonShape", l_phys_newPolygonShape}, {"newChainShape", l_phys_newChainShape}, {"newRevoluteJoint", l_phys_newRevoluteJoint}, {"newFixture", l_phys_newFixture}, {nullptr, nullptr}};
  const luaL_Reg audio[] = {{"newSource", l_audio_newSource}, {"setEffect", l_audio_setEffect}, {nullptr, nullptr}};
  const luaL_Reg mathMod[] = {{"random", l_math_random}, {"setRandomSeed", l_math_setRandomSeed}, {"isConvex", l_math_isConvex}, {"triangulate", l_math_triangulate}, {"newRandomGenerator", l_math_newRandomGenerator}, {nullptr, nullptr}};
  const luaL_Reg event[] = {{"quit", l_event_quit}, {"push", l_event_push}, {"pump", l_event_pump}, {"poll", l_event_poll}, {nullptr, nullptr}};
  const luaL_Reg system[] = {{"openURL", l_system_openURL}, {nullptr, nullptr}};
  const luaL_Reg joystick[] = {{"getJoysticks", l_joystick_getJoysticks}, {"loadGamepadMappings", l_event_pump}, {nullptr, nullptr}};

  setModule(L, "graphics", graphics);
  setModule(L, "filesystem", fs);
  setModule(L, "image", imageMod);
  setModule(L, "keyboard", keyboard);
  setModule(L, "mouse", mouse);
  setModule(L, "timer", timer);
  setModule(L, "window", window);
  setModule(L, "physics", physics);
  setModule(L, "audio", audio);
  setModule(L, "math", mathMod);
  setModule(L, "event", event);
  setModule(L, "system", system);
  setModule(L, "joystick", joystick);
}

bool callLove(lua_State *L, const char *name, int nargs = 0) {
  lua_getglobal(L, "love");
  lua_getfield(L, -1, name);
  lua_remove(L, -2);
  if (!lua_isfunction(L, -1)) {
    lua_pop(L, 1 + nargs);
    return true;
  }
  if (nargs > 0) lua_insert(L, -1 - nargs);
  if (lua_pcall(L, nargs, 0, 0) != 0) {
    const char *msg = lua_tostring(L, -1);
    G.lastError = std::string(name) + " error: " + (msg ? msg : "unknown");
    fprintf(stderr, "lovefb: %s\n", G.lastError.c_str());
    lua_pop(L, 1);
    return false;
  }
  if (std::string(name) != "draw") G.lastError.clear();
  return true;
}

void dispatchQueuedEvents(lua_State *L) {
  std::vector<LoveEvent> events;
  events.swap(G.queuedEvents);
  for (const LoveEvent &e : events) {
    if (e.name == "quit") {
      gRunning = 0;
      continue;
    }
    for (const std::string &arg : e.args) lua_pushstring(L, arg.c_str());
    callLove(L, e.name.c_str(), int(e.args.size()));
  }
}

void dispatchInput(lua_State *L) {
  for (const KeyEvent &e : G.keyEvents) {
    lua_pushstring(L, e.key.c_str());
    callLove(L, e.pressed ? "keypressed" : "keyreleased", 1);
  }
  if (G.mouseDx || G.mouseDy) {
    lua_pushinteger(L, G.mouseX);
    lua_pushinteger(L, G.mouseY);
    lua_pushinteger(L, G.mouseDx);
    lua_pushinteger(L, G.mouseDy);
    callLove(L, "mousemoved", 4);
  }
  for (const MouseButtonEvent &e : G.mouseEvents) {
    lua_pushinteger(L, G.mouseX);
    lua_pushinteger(L, G.mouseY);
    lua_pushinteger(L, e.button);
    lua_pushboolean(L, 0);
    callLove(L, e.pressed ? "mousepressed" : "mousereleased", 4);
  }
  dispatchQueuedEvents(L);
}

void configureLuaPath(lua_State *L) {
  lua_getglobal(L, "package");
  std::string path = G.root + "/?.lua;" + G.root + "/?/init.lua;" +
                     G.root + "/examples/?.lua;";
  lua_getfield(L, -1, "path");
  path += lua_tostring(L, -1);
  lua_pop(L, 1);
  lua_pushstring(L, path.c_str());
  lua_setfield(L, -2, "path");
  lua_pop(L, 1);
}

void maybeRunConf(lua_State *L) {
  std::string conf = G.root + "/conf.lua";
  if (access(conf.c_str(), R_OK) != 0) return;
  if (luaL_dofile(L, conf.c_str()) != 0) {
    fprintf(stderr, "lovefb: conf.lua: %s\n", lua_tostring(L, -1));
    lua_pop(L, 1);
    return;
  }
  lua_getglobal(L, "love");
  lua_getfield(L, -1, "conf");
  lua_remove(L, -2);
  if (!lua_isfunction(L, -1)) {
    lua_pop(L, 1);
    return;
  }
  lua_newtable(L);
  lua_newtable(L);
  lua_setfield(L, -2, "window");
  if (lua_pcall(L, 1, 0, 0) != 0) {
    fprintf(stderr, "lovefb: love.conf: %s\n", lua_tostring(L, -1));
    lua_pop(L, 1);
  }
}

int runLove(lua_State *L) {
  registerLove(L);
  configureLuaPath(L);
  maybeRunConf(L);

  std::string mainLua = G.root + "/main.lua";
  if (luaL_dofile(L, mainLua.c_str()) != 0) {
    fprintf(stderr, "lovefb: main.lua: %s\n", lua_tostring(L, -1));
    return 1;
  }
  callLove(L, "load", 0);

  G.start = G.last = G.fpsT0 = nowSeconds();
  while (gRunning) {
    double t = nowSeconds();
    G.dt = std::min(0.1, std::max(0.0, t - G.last));
    G.last = t;
    G.fpsFrames++;
    if (t - G.fpsT0 >= 1.0) {
      G.fps = int(std::lround(G.fpsFrames / (t - G.fpsT0)));
      G.fpsFrames = 0;
      G.fpsT0 = t;
    }

    pollInput();
    dispatchInput(L);

    lua_pushnumber(L, G.dt);
    callLove(L, "update", 1);

    G.target = &G.screen;
    G.transform = Transform{};
    G.transformStack.clear();
    G.scissor = false;
    clearSurface(G.screen, G.background);
    callLove(L, "draw", 0);
    if (!G.lastError.empty()) {
      Font *savedFont = G.font;
      Color savedColor = G.color;
      Transform savedTransform = G.transform;
      G.font = &G.defaultFont;
      G.color = Color{255, 80, 80, 255};
      G.transform = Transform{};
      drawText(G.screen, G.lastError, 12, 12);
      G.transform = savedTransform;
      G.color = savedColor;
      G.font = savedFont;
    }
    drawSoftwareCursor();
    presentFrame();

    double frame = nowSeconds() - t;
    if (frame < 1.0 / 60.0) usleep(useconds_t((1.0 / 60.0 - frame) * 1000000.0));
  }
  return 0;
}

}  // namespace

int main(int argc, char **argv) {
  G.root = argc > 1 ? argv[1] : ".";
  G.screen = Surface{kLogicalWidth, kLogicalHeight,
                     std::vector<uint32_t>(size_t(kLogicalWidth) * kLogicalHeight, 0)};
  G.target = &G.screen;

  signal(SIGTERM, signalHandler);
  signal(SIGINT, signalHandler);
  if (openPresenter() != 0) return 1;
  configureRawStdin();
  G.savedStdinFlags = fcntl(STDIN_FILENO, F_GETFL, 0);
  if (G.savedStdinFlags >= 0) fcntl(STDIN_FILENO, F_SETFL, G.savedStdinFlags | O_NONBLOCK);
  G.miceFd = open("/dev/input/mice", O_RDONLY | O_NONBLOCK);

  clearSurface(G.screen, Color{14, 18, 24, 255});
  drawText(G.screen, G.presenter == Presenter::KmsGl ? "LOVE KMS/EGL/GLES runtime" : "LOVE framebuffer runtime", 20, 20);
  presentFrame();

  lua_State *L = luaL_newstate();
  luaL_openlibs(L);
  int rc = runLove(L);
  lua_close(L);
  restoreStdin();
  cleanupPresenter();
  if (G.miceFd >= 0) close(G.miceFd);
  return rc;
}
